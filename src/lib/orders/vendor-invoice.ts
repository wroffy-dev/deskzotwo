import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * The vendor's invoice on an order (owner, 16 Nov 2026: "option to add vendor invoice number on fulfilled order later
 * which will show on list order page also", then "billed amount also"): its number and what it billed us before GST,
 * typed on the order whenever it comes — usually after fulfilment — and checked against what the order says it costs,
 * quantity × purchase price.
 *
 * Where a vendor bill in Deskzo bills the order (its line carries the order, as a bill made from our PO does), that bill
 * is the answer instead — its number and amount, nothing typed. The typed figures are a record and a check; only a bill
 * reaches the books.
 *
 * Read by name, apart from the order's own query: a workspace not migrated yet has none (NOT_YET_EVERYWHERE).
 */

export const VENDOR_INVOICE_MAX = 60;

export type VendorInvoice = {
  number: string | null;
  /** Before GST. */
  amount: number | null;
  /** A vendor bill in Deskzo for it: where the number and amount came from. */
  fromBill: { id: string; docNumber: string } | null;
  /** Quantity × purchase price, where the order has a purchase price. */
  expected: number | null;
  /** Billed less expected: above 0 is more than it should have cost. Null where either is missing. */
  difference: number | null;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

export async function vendorInvoicesOf(orderIds: readonly string[]): Promise<Map<string, VendorInvoice>> {
  const out = new Map<string, VendorInvoice>();
  const ids = [...new Set(orderIds)];
  if (ids.length === 0) return out;
  const orders = await db.companyProduct.findMany({ where: { id: { in: ids } }, select: { id: true, quantity: true, purchasePrice: true } });
  let typed = new Map<string, { number: string | null; amount: number | null }>();
  try {
    const rows = await db.companyProduct.findMany({ where: { id: { in: ids } }, select: { id: true, vendorInvoiceNumber: true, vendorBilledAmount: true } });
    typed = new Map(rows.map((r) => [r.id, { number: r.vendorInvoiceNumber, amount: r.vendorBilledAmount === null ? null : Number(r.vendorBilledAmount) }]));
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  // Vendor bills billing these orders: their lines that carry the order, before GST.
  const billLines = await db.tradeDocumentLine.findMany({
    where: { companyProductId: { in: ids }, document: { docType: "BILL", status: { notIn: ["DRAFT", "CANCELLED"] } } },
    select: { companyProductId: true, taxableValue: true, document: { select: { id: true, docNumber: true } } },
  });
  const billed = new Map<string, { amount: number; bills: { id: string; docNumber: string }[] }>();
  for (const l of billLines) {
    const at = billed.get(l.companyProductId!) ?? { amount: 0, bills: [] };
    at.amount += Number(l.taxableValue);
    if (!at.bills.some((b) => b.id === l.document.id)) at.bills.push({ id: l.document.id, docNumber: l.document.docNumber });
    billed.set(l.companyProductId!, at);
  }
  for (const o of orders) {
    const bill = billed.get(o.id);
    const own = typed.get(o.id);
    const number = bill ? bill.bills.map((b) => b.docNumber).join(", ") : (own?.number ?? null);
    const amount = bill ? round2(bill.amount) : (own?.amount ?? null);
    const expected = o.purchasePrice === null ? null : round2(Number(o.purchasePrice) * o.quantity);
    if (number === null && amount === null) continue;
    out.set(o.id, { number, amount, fromBill: bill ? bill.bills[0]! : null, expected, difference: amount !== null && expected !== null ? round2(amount - expected) : null });
  }
  return out;
}

/** What may be kept as a number: trimmed, at most VENDOR_INVOICE_MAX characters, the usual separators. Blank is none. */
export function cleanVendorInvoice(raw: unknown): { ok: true; value: string | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, error: "That isn't an invoice number." };
  const value = raw.trim().replace(/\s+/g, " ");
  if (!value) return { ok: true, value: null };
  if (value.length > VENDOR_INVOICE_MAX) return { ok: false, error: `An invoice number is at most ${VENDOR_INVOICE_MAX} characters.` };
  if (!/^[\p{L}\p{N} ./\\#_-]+$/u.test(value)) return { ok: false, error: "Use letters, digits, spaces and / - . # _ only." };
  return { ok: true, value };
}

/** An amount as typed — "1,050.50" — before GST; blank is none. */
export function cleanBilledAmount(raw: unknown): { ok: true; value: number | null } | { ok: false; error: string } {
  if (raw === null || raw === undefined || (typeof raw === "string" && !raw.trim())) return { ok: true, value: null };
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.replace(/[,₹\s]/g, "")) : NaN;
  if (!Number.isFinite(n) || n < 0 || n > 10_000_000_000) return { ok: false, error: "The billed amount is in rupees, 0 or more — before GST." };
  return { ok: true, value: round2(n) };
}
