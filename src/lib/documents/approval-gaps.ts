import type { TradeDocumentType } from "@prisma/client";
import { db } from "@/lib/db";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import { docKey } from "@/lib/documents/permission-keys";
import { peopleHolding } from "@/lib/orders/handoff";

/**
 * Approval rules nobody working here can sign off (owner, 9 Nov 2026). Saving a rule refuses one with no approver,
 * but its people can leave afterwards: switched off, the only named approver leaves every document of that type
 * waiting, with only the super admin able to approve and nothing saying so. A rule the submitter's manager may approve
 * is never stuck this way — the manager is asked of each document.
 */

export type ApprovalGap = { docType: TradeDocumentType; label: string; why: string };

/** Whether a switched-on rule still has somebody who can approve: an active named person, an active holder of a named role, or the submitter's manager. */
export function ruleHasApprover(rule: { managerApproves: boolean; namedActive: number; roleHoldersActive: number }): boolean {
  return rule.managerApproves || rule.namedActive > 0 || rule.roleHoldersActive > 0;
}

export const gapWords = (label: string) =>
  `Nobody working here can approve a ${label.toLowerCase()} now — its approvers have all left. Only the super admin can sign one off until you name somebody in Settings › Document approvals, or tick Approve for it on a role.`;

/** The switched-on rules with nobody left to approve — leaving `withoutUserId` out, to ask "if they went". */
export async function approvalGaps(withoutUserId?: string): Promise<ApprovalGap[]> {
  const rules = await db.documentApprovalPolicy.findMany({
    where: { enabled: true, managerApproves: false },
    select: { docType: true, approverRoles: true, approvers: { select: { id: true, active: true } } },
  });
  const gaps: ApprovalGap[] = [];
  for (const rule of rules) {
    const namedActive = rule.approvers.filter((a) => a.active && a.id !== withoutUserId).length;
    const roleHoldersActive = rule.approverRoles.length
      ? await db.user.count({ where: { role: { in: rule.approverRoles }, active: true, kind: "MEMBER", isSuperAdmin: false, ...(withoutUserId ? { id: { not: withoutUserId } } : {}) } })
      : 0;
    // Or anybody holding Approve for it on the role or person screen (owner, 9 Nov 2026), the super admin aside.
    const holders = roleHoldersActive > 0 || namedActive > 0 ? [] : await peopleHolding(docKey(rule.docType, "approve"), [withoutUserId]);
    const holdersActive = holders.length ? await db.user.count({ where: { id: { in: holders }, isSuperAdmin: false } }) : 0;
    if (!ruleHasApprover({ managerApproves: false, namedActive, roleHoldersActive: roleHoldersActive + holdersActive })) {
      const label = tradeDocumentLabels[rule.docType];
      gaps.push({ docType: rule.docType, label, why: gapWords(label) });
    }
  }
  return gaps;
}

/** The rules switching this person off would leave with nobody: the ones stuck without them that aren't stuck now. */
export async function gapsIfSwitchedOff(userId: string): Promise<ApprovalGap[]> {
  const [now, after] = await Promise.all([approvalGaps(), approvalGaps(userId)]);
  const already = new Set(now.map((g) => g.docType));
  return after.filter((g) => !already.has(g.docType));
}
