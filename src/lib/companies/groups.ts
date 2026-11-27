import { db } from "@/lib/db";

/**
 * Customer groups (owner, 17 Nov 2026: "Auctus Advisors and YCP India … both are different identities belong to same
 * customer … they pay from one company and get licence on other company's name! how do i manage that").
 *
 * Each legal entity stays its own company — its own GSTIN, PAN, invoices and account — and a group links them as one
 * customer. What the link allows: a payment from any company in the group can settle any other's invoice. The payment
 * stays the payer's (it came from their bank, under their TAN), the invoice its own customer's, and a GROUP_TRANSFER
 * entry moves the amount between their two receivables (src/lib/ledger/journal.ts `postGroupTransferToLedger`), so
 * each one's account and statement read as its documents and payments do.
 *
 * Rupees only: a foreign payment or invoice across two companies is refused, since its exchange difference would land
 * on one of them.
 *
 * Read so a database not migrated yet answers "no group" rather than failing (the tables are newer than some).
 */

export type GroupCompany = { id: string; name: string; companySeq: number };

/** The group a company is in, with every company in it (itself too); null when it is in none. */
export async function groupOf(companyId: string): Promise<{ id: string; name: string; companies: GroupCompany[] } | null> {
  try {
    const member = await db.companyGroupMember.findUnique({
      where: { companyId },
      select: { group: { select: { id: true, name: true, members: { select: { company: { select: { id: true, name: true, companySeq: true } } }, orderBy: { addedAt: "asc" } } } } },
    });
    if (!member) return null;
    return { id: member.group.id, name: member.group.name, companies: member.group.members.map((m) => m.company) };
  } catch {
    return null;
  }
}

/** The other companies in a company's group — none when it is in no group. */
export async function groupCompaniesOf(companyId: string): Promise<GroupCompany[]> {
  return ((await groupOf(companyId))?.companies ?? []).filter((c) => c.id !== companyId);
}

/** Whether two companies are one customer: the same company, or both in one group. */
export async function sameCustomerGroup(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  try {
    const rows = await db.companyGroupMember.findMany({ where: { companyId: { in: [a, b] } }, select: { groupId: true } });
    return rows.length === 2 && rows[0]!.groupId === rows[1]!.groupId;
  } catch {
    return false;
  }
}

/**
 * Links `otherId` into `companyId`'s group: a new group named after the first when neither is in one, the other joining
 * when one is, and the two groups folded into one when both are in different groups (the group that stays is the first
 * company's). Returns the group's id.
 */
export async function linkIntoGroup(companyId: string, otherId: string, userId: string): Promise<string> {
  return db.$transaction(async (tx) => {
    const [mine, theirs, first] = await Promise.all([
      tx.companyGroupMember.findUnique({ where: { companyId }, select: { groupId: true } }),
      tx.companyGroupMember.findUnique({ where: { companyId: otherId }, select: { groupId: true } }),
      tx.company.findUniqueOrThrow({ where: { id: companyId }, select: { name: true } }),
    ]);
    if (mine && theirs) {
      if (mine.groupId !== theirs.groupId) {
        await tx.companyGroupMember.updateMany({ where: { groupId: theirs.groupId }, data: { groupId: mine.groupId } });
        await tx.companyGroup.delete({ where: { id: theirs.groupId } });
      }
      return mine.groupId;
    }
    if (mine) {
      await tx.companyGroupMember.create({ data: { companyId: otherId, groupId: mine.groupId, addedById: userId } });
      return mine.groupId;
    }
    if (theirs) {
      await tx.companyGroupMember.create({ data: { companyId, groupId: theirs.groupId, addedById: userId } });
      return theirs.groupId;
    }
    const group = await tx.companyGroup.create({ data: { name: first.name, createdById: userId }, select: { id: true } });
    await tx.companyGroupMember.createMany({ data: [companyId, otherId].map((id) => ({ companyId: id, groupId: group.id, addedById: userId })) });
    return group.id;
  });
}

/**
 * Takes a company out of its group. What its payments already settled stays settled — the transfers stand, as a payment
 * does. A group left with one company is removed.
 */
export async function leaveGroup(companyId: string): Promise<void> {
  await db.$transaction(async (tx) => {
    const member = await tx.companyGroupMember.findUnique({ where: { companyId }, select: { groupId: true } });
    if (!member) return;
    await tx.companyGroupMember.delete({ where: { companyId } });
    const left = await tx.companyGroupMember.count({ where: { groupId: member.groupId } });
    if (left < 2) await tx.companyGroup.delete({ where: { id: member.groupId } });
  });
}
