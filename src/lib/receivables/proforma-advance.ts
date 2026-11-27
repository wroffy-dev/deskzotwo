import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { recordAudit } from "@/lib/audit";
import { formatMoney } from "@/lib/currency";
import { takenFromPayment } from "@/lib/ledger/posting";
import { postExchangeDifferenceToLedger } from "@/lib/ledger/journal";
import { firstOpenDate } from "@/lib/ledger/period";
import { lockSettlement } from "@/lib/finance/settlement-lock";
import { settlementOf, syncInvoiceStatus } from "@/lib/receivables/sync";
import { writeOffsFor } from "@/lib/receivables/write-off";
import { bookOnFirstPayment } from "@/lib/orders/handoff";
import { settlePromisesFor } from "@/lib/collections/promises";

/**
 * Advances against a proforma invoice (owner, 17 Nov 2026: "PI ka advance payment bhi order invoice par lag jaye").
 *
 * The money is an ordinary payment on the customer's account — booked as an advance, unapplied, as any payment taken
 * before its invoice is (security audit SEC-67: a payment never predates the invoice it is recorded against). A
 * `ProformaAdvance` row says which proforma it was for. When a tax invoice converted from that proforma is issued — the
 * proforma converted whole, or the orders punched from it invoiced (src/lib/orders/invoice-draft.ts makes that invoice
 * converted from the proforma) — what is still unapplied of those payments is applied to it, oldest first, up to what
 * the invoice is owed. What is left over stays on account, still the proforma's, for its next invoice.
 *
 * Only in the invoice's own currency: an advance in rupees against a dollar invoice needs the rate on the day, which
 * somebody applies by hand (`applyPaymentToInvoice`). Server only.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** One advance received against a proforma, as its page lists it. */
export type ProformaAdvanceRow = {
  paymentId: string;
  paymentSeq: number;
  amount: number;
  currency: string;
  paidOn: Date;
  method: string;
  reference: string | null;
  /** Where it has gone so far: the invoices it settles, and how much of each. */
  applied: { documentId: string; docNumber: string | null; amount: number }[];
  /** Still on account, waiting for the proforma's invoice — in the payment's currency. */
  unapplied: number;
};

/** The payments recorded as advances against this proforma, oldest first. A deleted payment is gone from it too. */
export async function proformaAdvances(proformaId: string): Promise<ProformaAdvanceRow[]> {
  const links = await db.proformaAdvance.findMany({ where: { proformaId }, select: { paymentId: true } }).catch((err) => {
    if (notMigratedYet(err)) return [];
    throw err;
  });
  if (!links.length) return [];
  const payments = await db.payment.findMany({
    where: { id: { in: links.map((l) => l.paymentId) } },
    orderBy: [{ paidOn: "asc" }, { paymentSeq: "asc" }],
    select: {
      id: true,
      paymentSeq: true,
      amount: true,
      currency: true,
      paidOn: true,
      method: true,
      reference: true,
      allocations: { select: { amount: true, paymentAmount: true, documentId: true, companyProductId: true, document: { select: { docNumber: true } } } },
    },
  });
  return payments.map((p) => ({
    paymentId: p.id,
    paymentSeq: p.paymentSeq,
    amount: Number(p.amount),
    currency: p.currency,
    paidOn: p.paidOn,
    method: p.method,
    reference: p.reference,
    applied: p.allocations.filter((a) => a.documentId).map((a) => ({ documentId: a.documentId!, docNumber: a.document?.docNumber ?? null, amount: Number(a.amount) })),
    unapplied: round2(Number(p.amount) - p.allocations.reduce((t, a) => t + takenFromPayment(a), 0)),
  }));
}

/** What has been received against this proforma in all, in its currency — for "Advance received ₹X of ₹Y". */
export const advanceTotal = (rows: ProformaAdvanceRow[], currency: string) => round2(rows.filter((r) => r.currency === currency).reduce((t, r) => t + r.amount, 0));

/**
 * Applies the proforma's unapplied advances to this tax invoice, when it was converted from a proforma that has any —
 * called once the invoice is issued. Nothing to do (no proforma, no advance, nothing owed) is not a failure; neither is
 * an advance in another currency, which is left for somebody to apply at the day's rate. Never throws for a refusal:
 * issuing the invoice has already happened, and the advance can always be applied by hand.
 */
export async function applyProformaAdvances(invoiceId: string, userId: string): Promise<{ applied: number }> {
  const invoice = await db.tradeDocument.findUnique({
    where: { id: invoiceId },
    select: { id: true, docType: true, status: true, companyId: true, currency: true, issueDate: true, docNumber: true, sourceDocument: { select: { id: true, docType: true, docNumber: true } } },
  });
  if (!invoice || invoice.docType !== "INVOICE" || invoice.status === "DRAFT" || invoice.status === "CANCELLED") return { applied: 0 };
  if (invoice.sourceDocument?.docType !== "PROFORMA") return { applied: 0 };
  const advances = (await proformaAdvances(invoice.sourceDocument.id)).filter((a) => a.unapplied >= 0.01 && a.currency === invoice.currency);
  if (!advances.length) return { applied: 0 };
  const writtenOff = (await writeOffsFor([invoiceId])).get(invoiceId) ?? 0;

  const made = await db.$transaction(async (tx) => {
    // As every settlement is (security audit SEC-12): the invoice and the payments locked, and both balances read again.
    await lockSettlement(tx, { documents: [invoiceId], payments: advances.map((a) => a.paymentId) });
    const now = await tx.tradeDocument.findUnique({
      where: { id: invoiceId },
      select: { total: true, status: true, paidBefore: true, payments: { select: { amount: true } }, creditsReceived: { select: { amount: true } } },
    });
    if (!now || now.status === "CANCELLED") return [];
    let owed = round2(settlementOf({ ...now, writtenOff }).balance);
    const lock = await tx.ledgerLock.findUnique({ where: { id: "global" }, select: { lockedUntil: true } });
    const rows: { paymentId: string; amount: number }[] = [];
    for (const advance of advances) {
      if (owed < 0.01) break;
      const payment = await tx.payment.findUnique({
        where: { id: advance.paymentId },
        select: { amount: true, paidOn: true, companyId: true, direction: true, allocations: { select: { amount: true, paymentAmount: true } } },
      });
      if (!payment || payment.companyId !== invoice.companyId || payment.direction !== "RECEIVED") continue;
      const left = round2(Number(payment.amount) - payment.allocations.reduce((t, a) => t + takenFromPayment(a), 0));
      const amount = round2(Math.min(left, owed));
      if (amount < 0.01) continue;
      await tx.paymentAllocation.create({ data: { paymentId: advance.paymentId, documentId: invoiceId, amount: new Prisma.Decimal(amount), allocatedByUserId: userId } });
      // An invoice raised for an in-hand order: the order counts as booked from its first payment (O-D2).
      await bookOnFirstPayment(tx, { documentLines: { some: { documentId: invoiceId } } }, new Date());
      // Same currency, so a difference only where the payment's rate and the invoice's differ — as applyPaymentToInvoice.
      const settledOn = payment.paidOn.getTime() > invoice.issueDate.getTime() ? payment.paidOn : invoice.issueDate;
      await postExchangeDifferenceToLedger(tx, { paymentId: advance.paymentId, documentId: invoiceId, allocatedAmount: amount, paymentAmount: null, date: firstOpenDate(settledOn, lock?.lockedUntil), userId });
      rows.push({ paymentId: advance.paymentId, amount });
      owed = round2(owed - amount);
    }
    return rows;
  });

  if (!made.length) return { applied: 0 };
  await syncInvoiceStatus(invoiceId);
  await settlePromisesFor({ documentIds: [invoiceId] });
  const total = round2(made.reduce((t, r) => t + r.amount, 0));
  await recordAudit({
    userId,
    action: "UPDATE",
    entityType: "TradeDocument",
    entityId: invoiceId,
    entityLabel: `${formatMoney(total, invoice.currency)} advance from proforma ${invoice.sourceDocument.docNumber ?? ""} applied to ${invoice.docNumber ?? "the invoice"}`,
  });
  return { applied: total };
}
