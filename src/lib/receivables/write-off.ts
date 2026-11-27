import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Writing off an invoice the customer will never pay (owner, 15 Nov 2026). What is left on it is posted to Bad Debts
 * against the customer (src/lib/ledger/journal.ts postInvoiceWriteOffToLedger) and counted as settled wherever a
 * balance is worked out — every reader adds `writeOffsFor` to what was credited, as it does credit notes.
 *
 * India: GST already paid on the invoice isn't given back for a bad debt, so it all goes to Bad Debts.
 * UAE (Federal Decree-Law 8 of 2017, Art. 64): the VAT on what's written off may be claimed back as bad-debt relief
 * when the supply was made and its VAT declared, more than six months have passed since the supply, it's written off
 * in the books, and the customer has been told how much was written off. The relief reduces output VAT on the return
 * of the period it's written off in (src/lib/vat/return.ts); paid later, it's owed back — undoing the write-off reverses it.
 *
 * Readers ask in a separate query, never as a relation, and take a workspace not migrated yet as nothing written off.
 */

/** What's been written off each invoice, in its own currency. */
export async function writeOffsFor(invoiceIds: readonly string[], client: Pick<typeof db, "invoiceWriteOff"> = db): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (invoiceIds.length === 0) return out;
  try {
    const rows = await client.invoiceWriteOff.findMany({ where: { invoiceId: { in: [...new Set(invoiceIds)] } }, select: { invoiceId: true, amount: true } });
    for (const r of rows) out.set(r.invoiceId, (out.get(r.invoiceId) ?? 0) + Number(r.amount));
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  return out;
}

/** The same, with the day each was written off — for the readers that work balances out as of a day. */
export async function writeOffRowsFor(invoiceIds: readonly string[]): Promise<Map<string, { amount: number; on: Date; at: Date }>> {
  const out = new Map<string, { amount: number; on: Date; at: Date }>();
  if (invoiceIds.length === 0) return out;
  try {
    const rows = await db.invoiceWriteOff.findMany({ where: { invoiceId: { in: [...new Set(invoiceIds)] } }, select: { invoiceId: true, amount: true, writtenOffOn: true, createdAt: true } });
    for (const r of rows) out.set(r.invoiceId, { amount: Number(r.amount), on: r.writtenOffOn, at: r.createdAt });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  return out;
}

/** Whole months from one day to another, as the six months of the UAE's rule count them. */
export function monthsBetween(from: Date, to: Date): number {
  let months = (to.getUTCFullYear() - from.getUTCFullYear()) * 12 + (to.getUTCMonth() - from.getUTCMonth());
  if (to.getUTCDate() < from.getUTCDate()) months -= 1;
  return months;
}

export type ReliefInput = {
  uae: boolean;
  issueDate: Date;
  writtenOffOn: Date;
  /** The invoice's total and the VAT in it, in its currency. */
  total: number;
  vat: number;
  /** What's being written off, in its currency. */
  amount: number;
  customerNotifiedOn: Date | null;
};

/** The VAT that may be claimed back on a write-off, and why not when it can't — in the invoice's currency. */
export function badDebtRelief(input: ReliefInput): { vat: number; why: string | null } {
  if (!input.uae) return { vat: 0, why: null };
  if (input.vat <= 0 || input.total <= 0) return { vat: 0, why: "The invoice has no VAT on it." };
  if (monthsBetween(input.issueDate, input.writtenOffOn) < 6) return { vat: 0, why: "Six months haven't passed since the invoice — VAT relief can be claimed once they have." };
  if (!input.customerNotifiedOn) return { vat: 0, why: "Tell the customer how much is written off first — VAT relief needs it." };
  return { vat: Math.round(((input.vat * Math.min(input.amount, input.total)) / input.total) * 100) / 100, why: null };
}

export type WriteOffView = { id: string; amount: number; currency: string; reliefVat: number; writtenOffOn: string; reason: string; customerNotifiedOn: string | null };

/** An invoice's write-off, for its page — or null. */
export async function writeOffOfInvoice(invoiceId: string): Promise<WriteOffView | null> {
  try {
    const r = await db.invoiceWriteOff.findUnique({ where: { invoiceId } });
    if (!r) return null;
    return { id: r.id, amount: Number(r.amount), currency: r.currency, reliefVat: Number(r.reliefVat), writtenOffOn: r.writtenOffOn.toISOString().slice(0, 10), reason: r.reason, customerNotifiedOn: r.customerNotifiedOn ? r.customerNotifiedOn.toISOString().slice(0, 10) : null };
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}
