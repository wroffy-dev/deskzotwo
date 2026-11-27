import type { Prisma } from "@deskzo/control-client";
import { revokeRefundedExtraSeats } from "@/lib/billing/extra-seats";
import { cancelRazorpaySubscription, createRazorpayRefund, getRazorpayInvoice, type RazorpayPayment } from "@/lib/billing/razorpay";
import { applyRazorpayRefund } from "@/lib/billing/sync";
import { creditRefunds } from "@/lib/billing/tax-invoice";
import { controlDb } from "@/lib/platform/control-db";
import { refreshEntitlements } from "@/lib/platform/entitlements";

/**
 * Refunds (owner, 7 Nov 2026 — the policy is deskzo.com/refunds, in src/components/site/defaults.ts): the first yearly payment
 * back in full within 30 days; nothing otherwise, unless staff decide to, or it's Deskzo that couldn't deliver.
 *
 *   · Staff decide, from the console. The policy is shown beside each invoice, as advice: a refund outside it needs only the
 *     reason every refund needs, because goodwill is theirs to give.
 *   · Razorpay: the money goes back through Razorpay. Bank transfer: staff send it themselves, and this records that they have.
 *     Stripe: refunded in Stripe's dashboard, which reaches here by its webhook (src/lib/billing/sync.ts).
 *   · Either way a credit note for what went back, the invoice's refunded figure raised (which reverses partner commission),
 *     and a refund in full takes back the extra people it bought (extra-seats.ts). Credit packs follow in `applyRazorpayRefund`.
 *   · Refunding doesn't end a plan by itself: a goodwill part refund shouldn't. `endPlan` does, at once.
 */

export class RefundRefused extends Error {}

export const REFUND_WINDOW_DAYS = 30;
const DAY = 86_400_000;

export type RefundPolicy = "within" | "outside";

/** Whether this invoice is the workspace's first yearly payment, and paid in the last thirty days. */
export function refundPolicyFor(input: { paidAt: Date | null; isFirstYearly: boolean; now: Date }): RefundPolicy {
  if (!input.isFirstYearly || !input.paidAt) return "outside";
  return input.now.getTime() - input.paidAt.getTime() <= REFUND_WINDOW_DAYS * DAY ? "within" : "outside";
}

/** The workspace's first yearly plan payment; a pack or extra people aren't one, and one voided doesn't count. */
const yearlyPayment = (tenantId: string): Prisma.InvoiceWhereInput => ({ tenantId, status: "PAID", subscription: { interval: "YEAR" }, extraSeatPurchase: null });

export type RefundFacts = { refundable: number; policy: RefundPolicy; canRefundHere: boolean };

/** For the console's invoice rows: what's left to refund on each, and what the policy says. */
export async function refundFacts(tenantId: string, invoices: { id: string; gateway: string; status: string; amountPaid: number; amountRefunded: number; paidAt: Date | null }[], now = new Date()): Promise<Map<string, RefundFacts>> {
  const first = await controlDb().invoice.findFirst({ where: yearlyPayment(tenantId), orderBy: { paidAt: "asc" }, select: { id: true } });
  return new Map(
    invoices.map((i) => [
      i.id,
      {
        refundable: i.status === "PAID" ? Math.max(0, i.amountPaid - i.amountRefunded) : 0,
        policy: refundPolicyFor({ paidAt: i.paidAt, isFirstYearly: first?.id === i.id, now }),
        canRefundHere: i.gateway === "RAZORPAY" || i.gateway === "OFFLINE",
      },
    ]),
  );
}

export type RefundRequest = { invoiceId: string; amount: number; reason: string; endPlan: boolean; staffId: string };
export type RefundDone = { tenantId: string; refunded: number; creditNote: string | null; endedPlan: boolean };

/** Sends or records a refund. Claimed first, so two clicks can't send the money back twice. */
export async function refundInvoice(input: RefundRequest, now = new Date()): Promise<RefundDone> {
  const control = controlDb();
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 3 || reason.length > 500) throw new RefundRefused("Say why it's refunded.");
  const amount = Math.round(Number(input.amount));
  if (!Number.isInteger(amount) || amount < 1) throw new RefundRefused("Enter the amount to refund.");
  const invoice = await control.invoice.findUnique({
    where: { id: input.invoiceId },
    select: { id: true, tenantId: true, gateway: true, externalId: true, status: true, amountPaid: true, amountRefunded: true, paidAt: true, subscriptionId: true },
  });
  if (!invoice) throw new RefundRefused("That invoice no longer exists.");
  if (invoice.gateway === "STRIPE") throw new RefundRefused("Refund this one in Stripe's dashboard. It reaches here by itself, with its credit note.");
  if (invoice.gateway !== "RAZORPAY" && invoice.gateway !== "OFFLINE") throw new RefundRefused("Nobody paid this one, so there's nothing to refund.");
  if (invoice.status !== "PAID") throw new RefundRefused("Only a paid invoice can be refunded.");
  const left = invoice.amountPaid - invoice.amountRefunded;
  if (left < 1) throw new RefundRefused("It has been refunded in full already.");
  if (amount > left) throw new RefundRefused("That's more than is left to refund on it.");

  // One refund from this state of the invoice: a second click, or a colleague's, finds it taken.
  const claim = { tenantId: invoice.tenantId, key: `refund:${invoice.id}:${invoice.amountRefunded}` };
  try {
    await control.billingNotice.create({ data: claim });
  } catch {
    throw new RefundRefused("Somebody has just refunded this invoice. Reload to see it.");
  }
  const newTotal = invoice.amountRefunded + amount;
  try {
    if (invoice.gateway === "RAZORPAY") {
      const paymentId = invoice.externalId.startsWith("pay_") ? invoice.externalId : (await getRazorpayInvoice(invoice.externalId)).payment_id;
      if (!paymentId) throw new RefundRefused("Razorpay has no payment for this invoice. Check it in Razorpay's dashboard.");
      await createRazorpayRefund(paymentId, amount, { invoice: invoice.id, reason: reason.slice(0, 200) });
      // Not waiting for the webhook, which will find it done. The refunded figure only ever goes up.
      await applyRazorpayRefund({ id: paymentId, ...(invoice.externalId.startsWith("pay_") ? {} : { invoice_id: invoice.externalId }), amount_refunded: newTotal } as RazorpayPayment, now);
    } else {
      await control.invoice.update({ where: { id: invoice.id }, data: { amountRefunded: newTotal, refundedAt: now } });
      await creditRefunds(invoice.id);
    }
  } catch (err) {
    // Nothing went back, so it can be tried again.
    await control.billingNotice.delete({ where: { tenantId_key: claim } }).catch(() => undefined);
    throw err;
  }
  await revokeRefundedExtraSeats(invoice.id);
  const endedPlan = input.endPlan && invoice.subscriptionId ? await endPlan(invoice.subscriptionId, now) : false;
  await control.platformAuditLog.create({
    data: { actorKind: "STAFF", actor: input.staffId, action: "billing.refund", tenantId: invoice.tenantId, detail: { invoice: invoice.id, amount, reason, endedPlan, gateway: invoice.gateway } },
  });
  const note = await control.platformCreditNote.findFirst({ where: { invoiceId: invoice.id }, orderBy: { issuedAt: "desc" }, select: { number: true } });
  return { tenantId: invoice.tenantId, refunded: amount, creditNote: note?.number ?? null, endedPlan };
}

/** The plan ended now, not at the period's end, with what was bought on top of it. */
async function endPlan(subscriptionId: string, now: Date): Promise<boolean> {
  const control = controlDb();
  const sub = await control.subscription.findUnique({ where: { id: subscriptionId }, select: { id: true, tenantId: true, gateway: true, status: true, externalId: true } });
  if (!sub || sub.status === "CANCELLED") return false;
  if (sub.gateway === "RAZORPAY" && sub.externalId) await cancelRazorpaySubscription(sub.externalId, false);
  await control.subscription.update({ where: { id: sub.id }, data: { status: "CANCELLED", cancelledAt: now, currentPeriodEnd: now, cancelAtPeriodEnd: false } });
  await control.extraSeatPurchase.updateMany({ where: { subscriptionId: sub.id, status: { in: ["PAID", "WAITING"] } }, data: { status: "CANCELLED" } });
  await refreshEntitlements(sub.tenantId);
  return true;
}
