import type { ExpenseApprovalFlow, ExpenseApprovalStep, ExpenseCategory } from "@prisma/client";
import { db } from "@/lib/db";
import { rolePermits } from "@/lib/authz/role-permission";
import { PEOPLE_ONLY } from "@/lib/people";
import { notifyUser } from "@/lib/notify";
import { peopleHolding } from "@/lib/orders/handoff";
import { DEFAULT_EXPENSE_APPROVAL_FLOW, firstApprovalStep } from "@/lib/expense-approval";
import { expensePath } from "@/lib/record-links";
import { expenseCategoryLabels } from "@/lib/expenses";
import { basePrefix } from "@/lib/currency";

/**
 * Where a submitted expense claim goes, and who is told (moved from src/actions/expense.ts, owner 31 Oct 2026, so a
 * claim brought in from Kredily is routed exactly as one submitted here — src/actions/kredily-import.ts).
 */

/** The company's rule for who signs claims off (Settings › People › Expense approvals); no row is HR. */
export async function approvalFlowNow(): Promise<ExpenseApprovalFlow> {
  const row = await db.expenseSettings.findUnique({ where: { id: "global" }, select: { approvalFlow: true } });
  return row?.approvalFlow ?? DEFAULT_EXPENSE_APPROVAL_FLOW;
}

/** The claimant's reporting manager, while that manager is still active. */
export async function activeManagerOf(claimantId: string): Promise<string | null> {
  const claimant = await db.user.findUnique({ where: { id: claimantId }, select: { managerId: true } });
  if (!claimant?.managerId) return null;
  const manager = await db.user.findUnique({ where: { id: claimant.managerId }, select: { id: true, active: true } });
  return manager?.active ? manager.id : null;
}

/**
 * Where a claim goes when it is submitted, snapshotted onto it: the rule, the step, and — at the
 * manager's step — which manager. HR's step is a queue rather than a person: anybody holding "Approve
 * expense claims (HR)" may take it.
 */
export async function routeClaim(claimantId: string): Promise<{
  approvalFlow: ExpenseApprovalFlow;
  approvalStep: ExpenseApprovalStep;
  approverUserId: string | null;
}> {
  const approvalFlow = await approvalFlowNow();
  const manager = await activeManagerOf(claimantId);
  const approvalStep = firstApprovalStep(approvalFlow, !!manager);
  const approverUserId = approvalStep === "MANAGER" ? (manager ?? (await fallbackApprover(claimantId))) : null;
  return { approvalFlow, approvalStep, approverUserId };
}

/**
 * Who a manager's-step claim goes to when the claimant has no manager. A claimant with no manager — or
 * one whose manager has been deactivated — would otherwise submit into a void, so those fall through to
 * an active user who holds `expenses.approve`, never the claimant themselves. The answer is snapshotted
 * onto the row at submit time, so a later reporting-line change can't move a claim that's already
 * mid-review.
 *
 * Null is still possible — a one-person deployment has nobody else to ask — and the claim then sits
 * as SUBMITTED until someone with the override permission picks it up, which the UI says plainly
 * rather than pretending a manager is looking at it.
 */
export async function fallbackApprover(claimantId: string): Promise<string | null> {
  const candidates = await db.user.findMany({
    // People only: naming `id` takes this past db's own filter (src/lib/db.ts).
    where: { active: true, id: { not: claimantId }, ...PEOPLE_ONLY },
    orderBy: { createdAt: "asc" },
    select: { id: true, role: true },
  });
  for (const candidate of candidates) {
    if (await rolePermits(candidate.role, "expenses.approve")) return candidate.id;
  }
  return null;
}

/** Tells whoever has the claim now: the manager it went to, or everybody who approves claims for HR. */
export async function tellApprovers(
  claim: { expenseSeq: number; category: ExpenseCategory; amount: number; claimantId: string },
  step: ExpenseApprovalStep,
  approverUserId: string | null,
  title = "An expense claim needs your approval",
) {
  const to = step === "HR" ? await peopleHolding("hr.approveExpenses", [claim.claimantId]) : approverUserId ? [approverUserId] : [];
  await Promise.all(
    to.map((userId) =>
      notifyUser({
        userId,
        type: "EXPENSE_SUBMITTED",
        title,
        message: `${expenseCategoryLabels[claim.category]} — ${basePrefix()}${claim.amount.toFixed(2)}`,
        link: expensePath(claim.expenseSeq),
      }),
    ),
  );
}
