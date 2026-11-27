import { db } from "@/lib/db";
import { mayAccess } from "@/lib/authz/access";
import { notMigratedYet } from "@/lib/not-migrated";
import { recordAudit } from "@/lib/audit";
import { formatOrderId } from "@/lib/order-id";

/**
 * A sales order from a quote (owner, 6 Nov 2026 — "Convert" as Zoho has it). An order is one product, so a quote makes
 * one order a line: the Punch order form opens filled from a line, a person checks it — PO, terms, hand-off — and saves,
 * and the next line follows. Each order is tied to its line (QuoteOrderLink), so no line is ordered twice. A line's
 * own `companyProductId` isn't that: it names the subscription a renewal quote renews.
 */

export type QuoteLineForOrder = {
  id: string;
  name: string;
  itemId: string | null;
  quantity: number;
  /** A unit's price before GST, after the line's discount. */
  unitPrice: number | null;
  startDate: string | null;
  endDate: string | null;
  /** The order made from this line, e.g. ORD-000123. */
  ordered: string | null;
};

export type QuoteForOrder = {
  id: string;
  docNumber: string | null;
  /** What it is, as the order form names it: a quote, or a proforma invoice (owner, 16 Nov 2026). */
  kind: "quote" | "proforma";
  companyId: string;
  locationId: string | null;
  lines: QuoteLineForOrder[];
  next: QuoteLineForOrder | null;
};

const SENT_OR_ACCEPTED = ["ISSUED", "ACCEPTED"];
/**
 * An issued proforma invoice orders as a quote does (owner, 16 Nov 2026: "order punching option from issued proforma
 * invoice"): issued, or paid against already — a proforma is often paid before the order is punched. Not a draft, a
 * cancelled one or one that ran out.
 */
const PROFORMA_ISSUED = ["ISSUED", "ACCEPTED", "PARTIALLY_PAID", "PAID"];

/** A sent or accepted quote this person may see, with each line and whether it has its order yet. */
export async function quoteForOrder(quoteId: string, userId: string): Promise<QuoteForOrder | null> {
  const quote = await db.tradeDocument.findUnique({
    where: { id: String(quoteId ?? "") },
    select: {
      id: true,
      docNumber: true,
      docType: true,
      status: true,
      companyId: true,
      locationId: true,
      lines: { orderBy: { sortOrder: "asc" }, select: { id: true, name: true, itemId: true, quantity: true, taxableValue: true, servicePeriodFrom: true, servicePeriodTo: true } },
    },
  });
  if (!quote) return null;
  const orderable = quote.docType === "PROPOSAL" ? SENT_OR_ACCEPTED.includes(quote.status) : quote.docType === "PROFORMA" ? PROFORMA_ISSUED.includes(quote.status) : false;
  if (!orderable) return null;
  if (!(await mayAccess(userId, "documents", "view", quote.id))) return null;
  const links = await db.quoteOrderLink.findMany({ where: { quoteId: quote.id }, select: { lineId: true, orderId: true } }).catch((err) => {
    if (notMigratedYet(err)) return [];
    throw err;
  });
  const orders = links.length ? await db.companyProduct.findMany({ where: { id: { in: links.map((l) => l.orderId) } }, select: { id: true, orderSeq: true, orderStatus: true } }) : [];
  // A cancelled or refused order frees its line for another go.
  const live = new Map(orders.filter((o) => o.orderStatus !== "CANCELLED" && o.orderStatus !== "REJECTED").map((o) => [o.id, o.orderSeq]));
  const orderOf = new Map(links.flatMap((l) => (live.has(l.orderId) ? [[l.lineId, formatOrderId(live.get(l.orderId)!)] as const] : [])));
  const lines = quote.lines.map((l) => {
    const qty = Number(l.quantity);
    const taxable = Number(l.taxableValue);
    return {
      id: l.id,
      name: l.name,
      itemId: l.itemId,
      // An order counts whole units.
      quantity: Math.max(1, Math.round(qty)),
      unitPrice: qty > 0 && taxable > 0 ? Math.round((taxable / qty) * 100) / 100 : null,
      startDate: l.servicePeriodFrom?.toISOString().slice(0, 10) ?? null,
      endDate: l.servicePeriodTo?.toISOString().slice(0, 10) ?? null,
      ordered: orderOf.get(l.id) ?? null,
    };
  });
  return { id: quote.id, docNumber: quote.docNumber, kind: quote.docType === "PROFORMA" ? "proforma" : "quote", companyId: quote.companyId, locationId: quote.locationId, lines, next: lines.find((l) => !l.ordered) ?? null };
}

/** Why an order can't be made from this line for this customer, or null. */
export async function quoteLineRefusal(lineId: string, companyId: string, userId: string): Promise<string | null> {
  const line = await db.tradeDocumentLine.findUnique({ where: { id: lineId }, select: { documentId: true, document: { select: { companyId: true } } } });
  if (!line || line.document.companyId !== companyId) return "That quote line isn't this customer's.";
  const quote = await quoteForOrder(line.documentId, userId);
  if (!quote) return "That quote or proforma can't be ordered from — a quote has to be sent or accepted, a proforma issued.";
  const ordered = quote.lines.find((l) => l.id === lineId)?.ordered;
  return ordered ? `That ${quote.kind === "proforma" ? "proforma" : "quote"} line has its order already, ${ordered}.` : null;
}

/** The quote or proforma an order was punched from, as its page links it. */
export type OrderSource = { id: string; docNumber: string | null; kind: "quote" | "proforma" };

/**
 * The quote or proforma this order was punched from, or null — and null too for somebody who may not see that document
 * (owner, 17 Nov 2026: "PI se punch order sync rahe" — the order names its PI, the PI lists its orders).
 */
export async function sourceOfOrder(orderId: string, userId: string): Promise<OrderSource | null> {
  const link = await db.quoteOrderLink.findFirst({ where: { orderId }, select: { quoteId: true } }).catch((err) => {
    if (notMigratedYet(err)) return null;
    throw err;
  });
  if (!link) return null;
  const doc = await db.tradeDocument.findUnique({ where: { id: link.quoteId }, select: { id: true, docNumber: true, docType: true } });
  if (!doc || !(await mayAccess(userId, "documents", "view", doc.id))) return null;
  return { id: doc.id, docNumber: doc.docNumber, kind: doc.docType === "PROFORMA" ? "proforma" : "quote" };
}

/** An order punched from a quote's or proforma's line, as the document lists it. */
export type OrderFromQuote = { orderSeq: number; status: string; line: string };

/** The orders punched from this quote's or proforma's lines, in its lines' order — a cancelled or refused one too, marked so. */
export async function ordersOfQuote(quoteId: string): Promise<OrderFromQuote[]> {
  const links = await db.quoteOrderLink.findMany({ where: { quoteId }, select: { lineId: true, orderId: true } }).catch((err) => {
    if (notMigratedYet(err)) return [];
    throw err;
  });
  if (!links.length) return [];
  const [orders, lines] = await Promise.all([
    db.companyProduct.findMany({ where: { id: { in: links.map((l) => l.orderId) } }, select: { id: true, orderSeq: true, orderStatus: true } }),
    db.tradeDocumentLine.findMany({ where: { id: { in: links.map((l) => l.lineId) } }, select: { id: true, name: true, sortOrder: true } }),
  ]);
  const orderOf = new Map(orders.map((o) => [o.id, o]));
  const lineOf = new Map(lines.map((l) => [l.id, l]));
  return links
    .flatMap((l) => {
      const order = orderOf.get(l.orderId);
      const line = lineOf.get(l.lineId);
      return order && line ? [{ orderSeq: order.orderSeq, status: order.orderStatus as string, line: line.name, sort: line.sortOrder }] : [];
    })
    .sort((a, b) => a.sort - b.sort)
    .map(({ orderSeq, status, line }) => ({ orderSeq, status, line }));
}

/** Whether an order still stands — a cancelled or refused one frees its line, and isn't billed. */
export const liveOrder = (o: { status: string }) => o.status !== "CANCELLED" && o.status !== "REJECTED";

/**
 * Why this proforma can't be made a tax invoice whole, or null: orders were punched from it, so the journey is theirs and
 * the invoice is raised from them (owner, 17 Nov 2026) — converting it as well would bill the same lines twice.
 */
export async function proformaInvoiceRefusal(proformaId: string): Promise<string | null> {
  const live = (await ordersOfQuote(proformaId)).filter(liveOrder);
  if (!live.length) return null;
  const refs = live.map((o) => formatOrderId(o.orderSeq)).join(", ");
  return `Orders were punched from this proforma (${refs}) — raise the tax invoice from ${live.length === 1 ? "that order" : "those orders"}, so nothing is billed twice.`;
}

/**
 * The quote or proforma every one of these orders came from, when they share one — what a tax invoice raised from them
 * is converted from, so the proforma's journey carries on to its invoice (owner, 17 Nov 2026). Null when any order has
 * none, or they came from different ones.
 */
export async function sharedSourceOf(orderIds: string[]): Promise<string | null> {
  if (!orderIds.length) return null;
  const links = await db.quoteOrderLink.findMany({ where: { orderId: { in: orderIds } }, select: { orderId: true, quoteId: true } }).catch((err) => {
    if (notMigratedYet(err)) return [];
    throw err;
  });
  const quotes = new Set(links.map((l) => l.quoteId));
  return quotes.size === 1 && orderIds.every((id) => links.some((l) => l.orderId === id)) ? [...quotes][0]! : null;
}

/** Ties the order to its line, and a quote that's been ordered from is accepted. */
export async function linkOrderToQuoteLine(lineId: string, orderId: string, userId: string): Promise<void> {
  const line = await db.tradeDocumentLine.findUnique({ where: { id: lineId }, select: { documentId: true } });
  if (!line) return;
  // A line freed by a cancelled order takes the new one.
  await db.quoteOrderLink.upsert({ where: { lineId }, create: { lineId, quoteId: line.documentId, orderId }, update: { orderId } });
  await acceptQuote(line.documentId, userId, "an order was made from it");
}

/**
 * A sent quote that's gone further — converted, invoiced or ordered from — is accepted: the customer has agreed, and
 * nobody should have to mark it as well (owner, 6 Nov 2026). Only from sent: rejected, cancelled and draft stay as they are.
 */
export async function acceptQuote(quoteId: string, userId: string, because: string): Promise<void> {
  const quote = await db.tradeDocument.findUnique({ where: { id: quoteId }, select: { docNumber: true, docType: true } });
  if (quote?.docType !== "PROPOSAL") return;
  const moved = await db.tradeDocument.updateMany({ where: { id: quoteId, docType: "PROPOSAL", status: "ISSUED" }, data: { status: "ACCEPTED" } });
  if (moved.count) await recordAudit({ userId, action: "UPDATE", entityType: "TradeDocument", entityId: quoteId, entityLabel: `${quote.docNumber} → accepted: ${because}` });
}
