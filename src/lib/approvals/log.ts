import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import type { ApprovalDecision, ApprovalKind } from "./kinds";

/**
 * One approval decision, kept for Approvals › History (owner, 30 Oct 2026 — "who approved what, wherever approval is
 * required"). Called by each approval action after its own write, beside its audit line. Never fails the decision it
 * records: a workspace not migrated yet, or a write that fails, is said in the server log and the approval stands.
 */
export async function recordApproval(input: {
  kind: ApprovalKind;
  decision: ApprovalDecision;
  recordId: string;
  label: string;
  href?: string | null;
  note?: string | null;
  requestedById?: string | null;
  decidedById: string;
}): Promise<void> {
  try {
    await db.approvalEvent.create({
      data: {
        kind: input.kind,
        decision: input.decision,
        recordId: input.recordId,
        label: input.label,
        href: input.href ?? null,
        note: input.note?.trim() || null,
        requestedById: input.requestedById ?? null,
        decidedById: input.decidedById,
      },
      select: { id: true },
    });
  } catch (err) {
    if (!notMigratedYet(err)) console.error("an approval could not be kept for its history", err);
  }
}
