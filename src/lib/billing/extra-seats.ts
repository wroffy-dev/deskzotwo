import { randomBytes } from "node:crypto";
import type { Prisma } from "@deskzo/control-client";
import { fromUnix } from "@/lib/billing/gateway";
import { EXTRA_SEATS_MAX, daysLeftIn, extraSeatPrice, type SeatInterval } from "@/lib/billing/extra-seat-price";
import { platformGstIn, PLATFORM_GST_PERCENT } from "@/lib/billing/platform-gst";
import { bankTransferOpen, mailProforma, PROFORMA_VALID_DAYS, PROFORMAS_PER_DAY } from "@/lib/billing/proforma";
import { createRazorpayPaymentLink, getRazorpayPaymentLink, noteOf, type RazorpayPayment, type RazorpayPaymentLink } from "@/lib/billing/razorpay";
import { bankProblem, completeSeller, documentUrl, issueTaxInvoice, readBank, splitGst, takeNumber, tenantBuyer, type BankDetails, type TaxDocument } from "@/lib/billing/tax-invoice";
import { amountInWords, GST_STATE_CODES } from "@/lib/gst-engine";
import { controlDb } from "@/lib/platform/control-db";
import { refreshEntitlements } from "@/lib/platform/entitlements";
import { getSecret } from "@/lib/platform/settings";
import { clockFor } from "@/lib/time/zone";

/**
 * More people part-way through a paid period (owner, 7 Nov 2026: "what if a customer wants to increase user mid year").
 * Razorpay can't change a running UPI or mandate subscription, and a bank transfer pays for a whole period, so a workspace
 * paying either way could only write in and have staff raise its limit, unbilled.
 *
 *   · Bought on their own, not by changing the subscription: a row here, on top of the plans in `computeEntitlements`, so
 *     the next read from Razorpay can't overwrite them, and last year's order stays as it was sold.
 *   · Priced at what the customer already pays for a person, for the days left (extra-seat-price.ts), plus GST.
 *   · Razorpay: one payment link, as a credit pack is (src/lib/ai/packs.ts), counted when Razorpay says it's paid.
 *     Bank transfer: a proforma, counted when staff record the transfer against it (`recordOfflinePayment`).
 *   · They end when the period they were bought in ends. To keep them, the renewal has to be for the higher number: the
 *     billing page starts its renewal forms there, but on Razorpay the customer must authorise that themselves.
 *   · Stripe customers change people in Stripe's portal, which isn't this. A plan with no limit, a free trial, a plan given
 *     by hand and a limit staff set aren't sold more: there's nothing here to add to.
 */

export class ExtraSeatsRefused extends Error {}

const INDIA = "Asia/Kolkata";
const DAY = 86_400_000;
const dayOf = (at: Date) => clockFor(INDIA).dateKey(at);
const startOfDay = (at: Date) => new Date(`${dayOf(at)}T00:00:00+05:30`);

export type ExtraSeatPlan = { subscriptionId: string; planKey: string; name: string; unitPrice: number; interval: SeatInterval; endsAt: Date; daysLeft: number; quantity: number };
export type ExtraSeatOffer = { open: boolean; reason: string | null; gateway: "RAZORPAY" | "OFFLINE" | null; plans: ExtraSeatPlan[] };

const closed = (reason: string | null): ExtraSeatOffer => ({ open: false, reason, gateway: null, plans: [] });

/** Whether more people can be bought here now, and at what. `reason` null: nothing to say, so nothing is shown. */
export async function extraSeatOffer(tenantId: string, now = new Date()): Promise<ExtraSeatOffer> {
  const control = controlDb();
  const tenant = await control.tenant.findUnique({ where: { id: tenantId }, select: { country: true, status: true, seatOverride: true } });
  if (!tenant || tenant.country !== "IN" || tenant.status !== "ACTIVE") return closed(null);
  const subs = await control.subscription.findMany({
    where: { tenantId, gateway: { in: ["RAZORPAY", "OFFLINE"] }, status: "ACTIVE", currentPeriodEnd: { gt: now }, OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
    orderBy: { createdAt: "asc" },
    select: { id: true, gateway: true, currentPeriodEnd: true, interval: true, items: { select: { quantity: true, plan: { select: { key: true, name: true, kind: true } }, price: { select: { amount: true, perSeat: true, interval: true } } } } },
  });
  if (subs.length === 0) return closed(null);
  if (tenant.seatOverride !== null) return closed("Your limit on people is set by Deskzo. Write to us to change it.");
  const today = startOfDay(now);
  const plans = subs.flatMap((s) =>
    s.items.flatMap((i) =>
      i.price?.perSeat && i.plan.kind !== "ADDON"
        ? [{ subscriptionId: s.id, planKey: i.plan.key, name: i.plan.name, unitPrice: i.price.amount, interval: i.price.interval as SeatInterval, endsAt: s.currentPeriodEnd!, daysLeft: daysLeftIn(today, s.currentPeriodEnd!), quantity: i.quantity }]
        : [],
    ),
  );
  if (plans.length === 0) return closed(null);
  const gateway = subs[0]!.gateway as "RAZORPAY" | "OFFLINE";
  if (gateway === "RAZORPAY") {
    const [keyId, keySecret] = await Promise.all([getSecret("razorpay.keyId"), getSecret("razorpay.keySecret")]);
    if (!keyId || !keySecret) return closed("Buying more people online isn't open yet. Write to us and we'll set it up.");
  } else if (!(await bankTransferOpen())) {
    return closed("Paying by bank transfer isn't open yet. Write to us and we'll set it up.");
  }
  return { open: true, reason: null, gateway, plans };
}

export type ExtraSeatStart = { kind: "pay"; url: string } | { kind: "proforma"; number: string; url: string; total: number };

export type ExtraSeatRequest = { tenantId: string; planKey: string; quantity: number; requestedBy: { name: string; email: string }; returnUrl: string };

/** Starts buying more people: a Razorpay page, or a proforma mailed. Nothing is counted until it's paid. */
export async function buyExtraSeats(input: ExtraSeatRequest, now = new Date()): Promise<ExtraSeatStart> {
  const quantity = Number(input.quantity);
  if (!Number.isInteger(quantity) || quantity < 1 || quantity > EXTRA_SEATS_MAX) throw new ExtraSeatsRefused(`Enter how many people, from 1 to ${EXTRA_SEATS_MAX}.`);
  const offer = await extraSeatOffer(input.tenantId, now);
  if (!offer.open) throw new ExtraSeatsRefused(offer.reason ?? "More people can't be bought here. Write to us.");
  const plan = offer.plans.find((p) => p.planKey === input.planKey);
  if (!plan) throw new ExtraSeatsRefused("That plan isn't one this workspace pays for.");
  if (plan.daysLeft < 1) throw new ExtraSeatsRefused("This period ends today. Renew for the people you need instead.");
  const price = extraSeatPrice({ unitPrice: plan.unitPrice, interval: plan.interval, daysLeft: plan.daysLeft, quantity });
  const requestedBy = `${String(input.requestedBy.name ?? "").trim().slice(0, 120)} <${String(input.requestedBy.email ?? "").trim().slice(0, 200)}>`;
  const base = {
    tenantId: input.tenantId,
    subscriptionId: plan.subscriptionId,
    planKey: plan.planKey,
    quantity,
    startsAt: startOfDay(now),
    endsAt: plan.endsAt,
    subtotal: price.subtotal,
    total: price.total,
    gateway: offer.gateway!,
    requestedBy,
  };
  const words = describe(plan.name, quantity, plan.endsAt);
  return offer.gateway === "RAZORPAY" ? payByLink(base, words, input.returnUrl, now) : payByProforma(base, plan, price, words, input.requestedBy.email, requestedBy, now);
}

const describe = (planName: string, quantity: number, endsAt: Date) => `${planName}: ${quantity} more ${quantity === 1 ? "person" : "people"} until ${dayOf(new Date(endsAt.getTime() - DAY))}`;

type Base = { tenantId: string; subscriptionId: string; planKey: string; quantity: number; startsAt: Date; endsAt: Date; subtotal: number; total: number; gateway: "RAZORPAY" | "OFFLINE"; requestedBy: string };

async function payByLink(base: Base, words: string, returnUrl: string, now: Date): Promise<ExtraSeatStart> {
  const control = controlDb();
  const tenant = await control.tenant.findUniqueOrThrow({ where: { id: base.tenantId }, select: { name: true, billingName: true, billingEmail: true, ownerEmail: true } });
  // An earlier page left unpaid isn't what they want now; if it's paid after all, it still counts (`applyRazorpayExtraSeatsPaid`).
  await control.extraSeatPurchase.updateMany({ where: { tenantId: base.tenantId, gateway: "RAZORPAY", status: "WAITING" }, data: { status: "CANCELLED" } });
  const row = await control.extraSeatPurchase.create({ data: base, select: { id: true } });
  const link = await createRazorpayPaymentLink({
    amount: base.total,
    description: words.slice(0, 200),
    reference: `xsp_${randomBytes(12).toString("hex")}`,
    customer: { name: tenant.billingName ?? tenant.name, email: tenant.billingEmail ?? tenant.ownerEmail },
    // Ours, set here: what the webhook counts comes from our row, never from what the payer sends.
    notes: { tenantId: base.tenantId, extraSeats: row.id },
    callbackUrl: returnUrl,
    expiresAt: new Date(now.getTime() + 2 * 3_600_000),
  });
  if (!link.short_url) throw new ExtraSeatsRefused("Razorpay didn't give a page to pay on. Try again in a minute.");
  await control.extraSeatPurchase.update({ where: { id: row.id }, data: { externalId: link.id } });
  return { kind: "pay", url: link.short_url };
}

async function payByProforma(base: Base, plan: ExtraSeatPlan, price: ReturnType<typeof extraSeatPrice>, words: string, askedBy: string, requestedBy: string, now: Date): Promise<ExtraSeatStart> {
  const control = controlDb();
  const [seller, bank] = await Promise.all([completeSeller(), readBank()]);
  if (!seller || bankProblem(bank)) throw new ExtraSeatsRefused("Paying by bank transfer isn't open yet. Write to us and we'll set it up.");
  const asked = await control.platformProforma.count({ where: { tenantId: base.tenantId, createdAt: { gte: new Date(now.getTime() - DAY) } } });
  if (asked >= PROFORMAS_PER_DAY) throw new ExtraSeatsRefused("Several proformas were asked for today. Use the latest one, or write to us.");
  const tenant = await control.tenant.findUniqueOrThrow({
    where: { id: base.tenantId },
    select: { name: true, slug: true, billingName: true, billingAddress: true, billingState: true, taxId: true, billingEmail: true, ownerEmail: true },
  });
  const validUntil = new Date(Math.min(now.getTime() + PROFORMA_VALID_DAYS * DAY, plan.endsAt.getTime()));
  const buyer = tenantBuyer(tenant, seller);
  const supply = buyer.state === seller.state ? "intra" : "inter";
  const made = await control.$transaction(async (tx) => {
    // Replaces its own kind only: a proforma for the next period is another thing, and stays.
    const open = await tx.extraSeatPurchase.findMany({ where: { tenantId: base.tenantId, gateway: "OFFLINE", status: "WAITING" }, select: { id: true, proformaId: true } });
    await tx.extraSeatPurchase.updateMany({ where: { id: { in: open.map((o) => o.id) } }, data: { status: "CANCELLED" } });
    await tx.platformProforma.updateMany({ where: { id: { in: open.flatMap((o) => (o.proformaId ? [o.proformaId] : [])) }, status: "OPEN" }, data: { status: "CANCELLED", closedAt: now } });
    const number = await takeNumber(tx, "PF", now, seller.prefix);
    const details: TaxDocument = {
      kind: "proforma",
      number,
      issuedAt: now.toISOString(),
      seller: { name: seller.name, address: seller.address, state: seller.state, stateName: GST_STATE_CODES[seller.state] ?? seller.state, gstin: seller.gstin, email: null, pan: seller.pan },
      buyer,
      endUser: null,
      placeOfSupply: { code: buyer.state, name: buyer.stateName },
      supply,
      sac: seller.sac,
      ratePercent: PLATFORM_GST_PERCENT,
      lines: [{ description: words, quantity: base.quantity, unitPrice: price.perPerson, taxable: price.subtotal }],
      taxable: price.subtotal,
      ...splitGst(price.gst, supply),
      total: price.total,
      currency: "INR",
      amountInWords: amountInWords(price.total / 100, "INR"),
      period: { from: dayOf(base.startsAt), to: dayOf(new Date(base.endsAt.getTime() - DAY)) },
      paid: null,
      against: null,
      reason: null,
      bank: bank as BankDetails,
      validUntil: validUntil.toISOString(),
    };
    const proforma = await tx.platformProforma.create({
      data: {
        tenantId: base.tenantId,
        number,
        items: [{ planKey: base.planKey, quantity: base.quantity }] as unknown as Prisma.InputJsonValue,
        interval: plan.interval,
        periods: 1,
        total: price.total,
        details: details as unknown as Prisma.InputJsonValue,
        validUntil,
        requestedBy,
      },
      select: { id: true, number: true },
    });
    await tx.extraSeatPurchase.create({ data: { ...base, proformaId: proforma.id } });
    await tx.platformAuditLog.create({ data: { actorKind: "SYSTEM", actor: requestedBy, action: "billing.extra_seats.proforma", tenantId: base.tenantId, detail: { proforma: proforma.id, number, quantity: base.quantity, total: price.total } } });
    return { id: proforma.id, number: proforma.number, details };
  });
  const url = documentUrl("p", made.id);
  await mailProforma(made.details, url, [buyer.email, askedBy], { slug: tenant.slug, workspace: tenant.name, requestedBy });
  return { kind: "proforma", number: made.number, url, total: price.total };
}

/**
 * `payment_link.paid` for more people: the link read back from Razorpay, paid in full for what our row says. Counted once,
 * however often the webhook comes. A link paid after a newer one replaced it still counts, because the money came in.
 */
export async function applyRazorpayExtraSeatsPaid(sent: RazorpayPaymentLink, payment: RazorpayPayment | null, now = new Date()): Promise<string | null> {
  const link = await getRazorpayPaymentLink(sent.id);
  const id = noteOf(link.notes, "extraSeats");
  if (!id) return null;
  const control = controlDb();
  const row = await control.extraSeatPurchase.findUnique({ where: { id }, include: { subscription: { select: { items: { select: { plan: { select: { key: true, name: true } } } } } } } });
  if (!row || row.tenantId !== noteOf(link.notes, "tenantId") || row.externalId !== link.id) return null;
  // Counted once: and one refunded or voided since has an invoice, so a replayed event doesn't bring it back.
  if (row.invoiceId || row.status === "PAID" || row.status === "EXPIRED") return row.tenantId;
  const paid = link.amount_paid ?? 0;
  if (link.status !== "paid" || paid < row.total) throw new Error(`Payment link ${link.id} is ${link.status}, ${paid} of ${row.total} paid — not counting it yet`);

  const tax = platformGstIn(paid);
  const externalId = payment?.id ?? link.id;
  const paidAt = fromUnix(payment?.created_at) ?? now;
  const name = row.subscription.items.find((i) => i.plan.key === row.planKey)?.plan.name ?? row.planKey;
  await control.$transaction(async (tx) => {
    const invoice = await tx.invoice.upsert({
      where: { gateway_externalId: { gateway: "RAZORPAY", externalId } },
      create: {
        tenantId: row.tenantId,
        gateway: "RAZORPAY",
        externalId,
        status: "PAID",
        currency: link.currency.toUpperCase(),
        subtotal: paid - tax,
        tax,
        total: paid,
        amountPaid: paid,
        periodStart: row.startsAt,
        periodEnd: row.endsAt,
        issuedAt: paidAt,
        paidAt,
        subscriptionId: row.subscriptionId,
        // In its own words on the tax invoice, and to commission a line of this plan.
        planLines: [{ planKey: row.planKey, amount: paid - tax, description: describe(name, row.quantity, row.endsAt), quantity: row.quantity }],
      },
      update: {},
      select: { id: true },
    });
    await tx.extraSeatPurchase.update({ where: { id: row.id }, data: { status: "PAID", paidAt, invoiceId: invoice.id } });
  });
  await refreshEntitlements(row.tenantId);
  const done = await control.extraSeatPurchase.findUniqueOrThrow({ where: { id: row.id }, select: { invoiceId: true } });
  if (done.invoiceId) await issueTaxInvoice(done.invoiceId);
  return row.tenantId;
}

/** A refund in full on more people's invoice takes them back; a part refund is a goodwill matter and leaves them. */
export async function revokeRefundedExtraSeats(invoiceId: string): Promise<void> {
  const control = controlDb();
  const invoice = await control.invoice.findUnique({ where: { id: invoiceId }, select: { total: true, amountRefunded: true, tenantId: true } });
  if (!invoice || invoice.amountRefunded < invoice.total) return;
  const taken = await control.extraSeatPurchase.updateMany({ where: { invoiceId, status: "PAID" }, data: { status: "CANCELLED" } });
  if (taken.count) await refreshEntitlements(invoice.tenantId);
}

/** More people whose period has ended, off the workspace's limit. On the daily run. */
export async function expireExtraSeats(now = new Date()): Promise<number> {
  const control = controlDb();
  const due = await control.extraSeatPurchase.findMany({ where: { status: "PAID", endsAt: { lte: now } }, select: { id: true, tenantId: true } });
  if (due.length === 0) return 0;
  await control.extraSeatPurchase.updateMany({ where: { id: { in: due.map((d) => d.id) } }, data: { status: "EXPIRED" } });
  for (const tenantId of new Set(due.map((d) => d.tenantId))) await refreshEntitlements(tenantId);
  return due.length;
}

/** What's bought and running now, for the billing page. */
export async function runningExtraSeats(tenantId: string, now = new Date()): Promise<{ planKey: string; quantity: number; endsAt: Date }[]> {
  return controlDb().extraSeatPurchase.findMany({ where: { tenantId, status: "PAID", endsAt: { gt: now } }, orderBy: { endsAt: "asc" }, select: { planKey: true, quantity: true, endsAt: true } });
}
