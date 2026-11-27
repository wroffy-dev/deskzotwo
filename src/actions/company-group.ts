"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { mayAccessAccount } from "@/lib/authz/access";
import { recordAudit } from "@/lib/audit";
import { groupOf, leaveGroup, linkIntoGroup } from "@/lib/companies/groups";
import { partyStatement } from "@/lib/receivables/statement";
import { viewerHas } from "@/actions/permission";
import type { ActionResult } from "@/actions/company";

/**
 * A company's customer group (owner, 17 Nov 2026 — src/lib/companies/groups.ts): legal entities that are one customer,
 * any of which may pay the others' invoices. Linked and unlinked by whoever may edit both accounts.
 */

const ACCOUNT_SELECT = { id: true, name: true, ownerUserId: true, relationshipType: true } as const;

export async function linkCompanyGroup(companyId: string, otherId: string): Promise<ActionResult<{ groupId: string }>> {
  const user = await requireUser();
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  if (!companyId || !otherId || companyId === otherId) return { ok: false, error: "Pick another company to link." };
  const [company, other] = await Promise.all([
    db.company.findUnique({ where: { id: companyId }, select: ACCOUNT_SELECT }),
    db.company.findUnique({ where: { id: otherId }, select: ACCOUNT_SELECT }),
  ]);
  if (!company || !(await mayAccessAccount(user.id, "edit", company))) return { ok: false, error: "Company not found." };
  if (!other || !(await mayAccessAccount(user.id, "edit", other))) return { ok: false, error: "That company isn't one you can change." };
  const groupId = await linkIntoGroup(companyId, otherId, user.id);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: companyId, entityLabel: `${company.name} linked with ${other.name} as one customer group` });
  revalidatePath(`/companies/${companyId}`);
  revalidatePath(`/companies/${otherId}`);
  return { ok: true, data: { groupId } };
}

export async function leaveCompanyGroup(companyId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  const company = await db.company.findUnique({ where: { id: companyId }, select: ACCOUNT_SELECT });
  if (!company || !(await mayAccessAccount(user.id, "edit", company))) return { ok: false, error: "Company not found." };
  const group = await groupOf(companyId);
  if (!group) return { ok: true, data: null };
  await leaveGroup(companyId);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Company", entityId: companyId, entityLabel: `${company.name} taken out of its customer group` });
  for (const c of group.companies) revalidatePath(`/companies/${c.id}`);
  return { ok: true, data: null };
}

export type GroupMoneyRow = { id: string; name: string; companySeq: number; outstanding: number; overdue: number; onAccount: number; balance: number } | { id: string; name: string; companySeq: number; hidden: true };

/**
 * The group, and each company's money in it — what it owes on invoices, how much of that is overdue, and what it has
 * on account — for the company page. Each figure is that company's own statement (src/lib/receivables/statement.ts);
 * a company in the group the viewer may not see is named without its figures.
 */
/** Whether this person may open the account (src/lib/authz/access.ts) — a made-up id answers no. */
async function maySee(userId: string, companyId: string) {
  const company = await db.company.findUnique({ where: { id: companyId }, select: ACCOUNT_SELECT });
  return !!company && (await mayAccessAccount(userId, "view", company));
}

export async function companyGroupSummary(companyId: string) {
  const user = await requireUser();
  if (!(await maySee(user.id, companyId))) return null;
  const group = await groupOf(companyId);
  if (!group) return { group: null, rows: [] as GroupMoneyRow[], money: false };
  const money = await viewerHas("payments.view");
  const rows: GroupMoneyRow[] = [];
  for (const c of group.companies) {
    if (!money || !(await maySee(user.id, c.id))) {
      rows.push({ ...c, hidden: true });
      continue;
    }
    const s = await partyStatement("AR", c.id);
    const overdue = Math.round((s.aging.d1_30 + s.aging.d31_60 + s.aging.d61_90 + s.aging.d90_plus) * 100) / 100;
    rows.push({ ...c, outstanding: s.outstanding, overdue, onAccount: s.unappliedPayments, balance: s.balance });
  }
  return { group: { id: group.id, name: group.name }, rows, money };
}
