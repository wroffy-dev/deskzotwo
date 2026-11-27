import type { Prisma } from "@prisma/client";

/**
 * A renewal order that will never happen renews nothing (owner, 11 Nov 2026).
 *
 * "Renewed" is a link: the renewal order's `renewedFromId` names the subscription it renews, and everything that asks
 * whether a subscription was renewed asks for that link — the reminders, the escalations, Lapsed, At risk, the Renew
 * button, the reports. The link used to stay when the renewal order was cancelled, or refused at approval. The
 * subscription then read as renewed for good: no reminder, never lapsed, and Renew refused with "Already renewed —
 * cancel that first", which the cancelling hadn't undone. Cancelled and Rejected are both final, so the link goes with
 * them (migration 20261211120000_release_dead_renewals did the same for the ones already there).
 *
 * Auto-renew goes off on the subscription too: left on, the next billing run would raise the same renewal again, the
 * one somebody has just said no to.
 *
 * Inside the transaction that cancels or refuses the order. Gives back the subscription that is open to renew again,
 * for the audit trail; null when the order wasn't a renewal.
 */
export async function releaseRenewal(tx: Prisma.TransactionClient, orderId: string): Promise<{ id: string; orderSeq: number; autoRenewStopped: boolean } | null> {
  const order = await tx.companyProduct.findUnique({ where: { id: orderId }, select: { renewedFrom: { select: { id: true, orderSeq: true } } } });
  if (!order?.renewedFrom) return null;
  await tx.companyProduct.update({ where: { id: orderId }, data: { renewedFromId: null }, select: { id: true } });
  const stopped = await tx.recurringBilling.deleteMany({ where: { companyProductId: order.renewedFrom.id, mode: "AUTO_RENEW" } });
  return { ...order.renewedFrom, autoRenewStopped: stopped.count > 0 };
}

/** What the audit trail says on the subscription that is open again. */
export function releasedRenewalLabel(original: string, renewal: string, how: "cancelled" | "rejected", autoRenewStopped: boolean): string {
  return `${original} is open to renew again — its renewal ${renewal} was ${how}${autoRenewStopped ? "; auto-renew switched off" : ""}`;
}
