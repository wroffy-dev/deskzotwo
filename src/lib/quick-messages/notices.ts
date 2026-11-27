import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * A customer whose account manager changed and who hasn't been told (owner, 11 Nov 2026). Kept apart from the sending
 * (src/lib/quick-messages/server.ts) so whatever changes an account manager can note it without the mail and
 * WhatsApp stack behind it. Telling them is always by hand.
 */

/**
 * A customer's account manager moved: kept until the customer is told or somebody says there's no need. One row a
 * customer — a second change before the first was told replaces it, keeping who they last heard of (`fromUserId`).
 * Never stops the change it follows.
 */
export async function recordManagerChange(changes: { companyId: string; fromUserId: string | null }[], toUserId: string | null, changedById: string | null): Promise<void> {
  try {
    for (const c of changes) {
      if (c.fromUserId === toUserId) continue;
      // Nobody to introduce: nothing to tell.
      if (!toUserId) {
        await db.accountManagerNotice.deleteMany({ where: { companyId: c.companyId, toldAt: null } });
        continue;
      }
      const open = await db.accountManagerNotice.findUnique({ where: { companyId: c.companyId }, select: { toldAt: true, dismissedAt: true, fromUserId: true } });
      const waiting = open && !open.toldAt && !open.dismissedAt;
      const from = waiting ? open.fromUserId : c.fromUserId;
      // Back to who the customer last heard of: nothing changed for them.
      if (waiting && from === toUserId) {
        await db.accountManagerNotice.delete({ where: { companyId: c.companyId } });
        continue;
      }
      await db.accountManagerNotice.upsert({
        where: { companyId: c.companyId },
        create: { companyId: c.companyId, fromUserId: from, toUserId, changedById },
        update: { fromUserId: from, toUserId, changedById, changedAt: new Date(), toldAt: null, toldById: null, dismissedAt: null, dismissedById: null },
      });
    }
  } catch (err) {
    if (!notMigratedYet(err)) console.error("[quick-messages] couldn't note the account manager change", err);
  }
}

export type PendingNotice = { companyId: string; fromName: string | null; toUserId: string; toName: string; changedAt: Date };

/** The customer's change still to be told, or null — also null once its new manager has left or moved on again. */
export async function pendingNotice(companyId: string): Promise<PendingNotice | null> {
  try {
    const n = await db.accountManagerNotice.findUnique({ where: { companyId } });
    if (!n || n.toldAt || n.dismissedAt) return null;
    const company = await db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true } });
    if (company?.ownerUserId !== n.toUserId) return null;
    const people = await db.user.findMany({ where: { id: { in: [n.toUserId, ...(n.fromUserId ? [n.fromUserId] : [])] } }, select: { id: true, name: true, active: true } });
    const to = people.find((p) => p.id === n.toUserId);
    if (!to?.active) return null;
    return { companyId, fromName: people.find((p) => p.id === n.fromUserId)?.name ?? null, toUserId: n.toUserId, toName: to.name, changedAt: n.changedAt };
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

export async function dismissNotice(userId: string, companyId: string): Promise<void> {
  await db.accountManagerNotice.updateMany({ where: { companyId, toldAt: null, dismissedAt: null }, data: { dismissedAt: new Date(), dismissedById: userId } });
}
