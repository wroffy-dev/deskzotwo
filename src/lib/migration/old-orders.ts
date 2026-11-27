import { db } from "@/lib/db";
import { BILLED_STATUSES, INVOICEABLE_ORDER_STATUSES } from "@/lib/orders/billing-rules";
import { formatOrderId } from "@/lib/order-id";
import type { MigrationRow } from "@/lib/migration/state";

/**
 * Old orders and the invoices that billed them (owner, 21 Nov 2026 — "how do I link invoice to orders coming from old
 * crm?"). The old CRM's orders and Zoho's invoices came across separately, so nothing says which invoice billed which
 * order — and the old CRM's "invoice no." turned out to be our PO to the vendor, so no number joins them either.
 *
 * What joins them is what was sold: the same customer, the same product, the same quantity, invoiced around the time
 * the order was booked. A pair is linked only when it is the only one either way — the order has exactly one invoice
 * line that fits, and that line exactly one order. Anything else is listed for a person to choose on the order
 * page ("Link an invoice already raised", which accepts the old system's invoices for an old order). Never guessed.
 *
 * Linking sets the invoice line's order (TradeDocumentLine.companyProductId), as linking by hand does: the invoice's
 * amounts, tax and number are untouched. Only this year's invoices can be linked — earlier years are in the archive,
 * kept to be read, and the orders they billed are counted, not linked.
 */

const DAY = 86_400_000;
/** An invoice from a month before the order (raised on the PO) to two months after (raised on delivery). */
const BEFORE_DAYS = 30;
const AFTER_DAYS = 60;
const BATCH = 500;
/** The list to choose from, in one window (owner, 21 Nov 2026 — "all orders and link invoice button shows"). */
const LIST_MAX = 1000;

const OLD_ORIGINS = ["IMPORTED", "MIGRATED"] as const;

type Order = { id: string; orderSeq: number; companyId: string; itemId: string; quantity: number; at: Date; companyName: string; itemName: string };
type Line = { id: string; companyId: string; itemId: string | null; name: string; itemName?: string | null; quantity: number; amount: number; documentId: string; docNumber: string; issueDate: Date };

export type OldOrderChoice = {
  orderId: string;
  orderLabel: string;
  orderSeq: number;
  company: string;
  item: string;
  quantity: number;
  bookedOn: string;
  candidates: { lineId: string; documentId: string; docNumber: string; issueDate: string; amount: number }[];
};

export type OldOrderLinks = {
  /** Pairs found that are the only fit either way — linked by "Link them". */
  sure: number;
  /** Orders with more than one invoice line that fits, or a line that fits more than one order — the first hundred. */
  toChoose: OldOrderChoice[];
  toChooseCount: number;
  /** This year's old orders no invoice from the old system fits. */
  noMatch: number;
  /** Old orders from before the year — billed in an earlier year, which is archived, not linked. */
  earlierYears: number;
  /** Of those to choose, how many "by nearest date" would link — the rest have no line left for them. */
  nearest: number;
};

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

/** Words a product's name carries that don't make it another product: how it was sold this time, not what it is. */
const FILLER = new Set(["new", "renewal", "renew", "annual", "yearly", "monthly", "subscription", "licence", "license", "plan", "the", "for", "with", "and", "of", "1", "year", "yr", "commitment"]);

/**
 * A product's name as the two systems are compared on (owner, 21 Nov 2026 — the old CRM's product and Zoho's item came
 * in as two items for one product): words in brackets, and the words above, left out. "Microsoft 365 Business Basic
 * (With Teams) – Annual" and "Microsoft 365 Business Basic" are one product; "AutoCAD LT" and "AutoCAD" are not.
 */
export function productKey(name: string | null | undefined): string {
  const words = norm(String(name ?? "").replace(/\([^)]*\)|\[[^\]]*\]/g, " "))
    .split(" ")
    .filter((w) => w && !FILLER.has(w));
  return words.join(" ");
}

/** The same product: the same item, or — the two items being made apart — the same name, by the line's or its item's. */
function sameProduct(order: { itemId: string; itemName: string }, line: { itemId: string | null; name: string; itemName?: string | null }): boolean {
  if (line.itemId && line.itemId === order.itemId) return true;
  const want = productKey(order.itemName);
  if (want.length < 3) return false;
  return productKey(line.name) === want || (!!line.itemName && productKey(line.itemName) === want);
}

/** The old orders still not billed by any invoice: the old CRM's, and any booked before the switch day. */
async function oldOrders(m: MigrationRow): Promise<{ thisYear: Order[]; earlierYears: number }> {
  const yearStart = new Date(`${m.yearStart}T00:00:00Z`);
  const switchDay = new Date(`${m.switchDate}T00:00:00Z`);
  const imported = new Set((await db.legacyImportRecord.findMany({ where: { kind: "customer_product" }, select: { recordId: true } })).map((r) => r.recordId));
  const rows = await db.companyProduct.findMany({
    where: {
      orderStatus: { in: [...INVOICEABLE_ORDER_STATUSES] },
      // Not billed by any invoice yet — one already linked is done.
      documentLines: { none: { document: { docType: "INVOICE", status: { in: [...BILLED_STATUSES] } } } },
    },
    select: { id: true, orderSeq: true, companyId: true, itemId: true, quantity: true, bookedAt: true, startDate: true, createdAt: true, company: { select: { name: true } }, item: { select: { name: true } } },
  });
  const thisYear: Order[] = [];
  let earlierYears = 0;
  for (const r of rows) {
    const at = r.bookedAt ?? r.startDate ?? r.createdAt;
    const old = imported.has(r.id) || at < switchDay;
    if (!old) continue;
    if (at.getTime() < yearStart.getTime() - BEFORE_DAYS * DAY) {
      earlierYears += 1;
      continue;
    }
    thisYear.push({ id: r.id, orderSeq: r.orderSeq, companyId: r.companyId, itemId: r.itemId, quantity: Number(r.quantity), at, companyName: r.company.name, itemName: r.item.name });
  }
  return { thisYear, earlierYears };
}

/** The old system's invoice lines of the year that bill no order, for these customers. */
async function oldInvoiceLines(companyIds: string[]): Promise<Line[]> {
  if (companyIds.length === 0) return [];
  const rows = await db.tradeDocumentLine.findMany({
    where: {
      companyProductId: null,
      document: { companyId: { in: companyIds }, docType: "INVOICE", status: { in: [...BILLED_STATUSES] }, origin: { in: [...OLD_ORIGINS] } },
    },
    select: { id: true, itemId: true, name: true, item: { select: { name: true } }, quantity: true, lineTotal: true, document: { select: { id: true, companyId: true, docNumber: true, issueDate: true } } },
  });
  return rows.map((r) => ({
    id: r.id,
    companyId: r.document.companyId,
    itemId: r.itemId,
    name: r.name,
    itemName: r.item?.name ?? null,
    quantity: Number(r.quantity),
    amount: Number(r.lineTotal),
    documentId: r.document.id,
    docNumber: r.document.docNumber,
    issueDate: r.document.issueDate,
  }));
}

/** Whether a line could have billed this order: the customer, the product (by item, else by name), the quantity, the time. */
export function fits(order: Pick<Order, "companyId" | "itemId" | "itemName" | "quantity" | "at">, line: Pick<Line, "companyId" | "itemId" | "name" | "itemName" | "quantity" | "issueDate">): boolean {
  if (line.companyId !== order.companyId) return false;
  if (!sameProduct(order, line)) return false;
  if (Math.abs(line.quantity - order.quantity) > 1e-6) return false;
  const days = (line.issueDate.getTime() - order.at.getTime()) / DAY;
  return days >= -BEFORE_DAYS && days <= AFTER_DAYS;
}

/** Pairs each way: the sure ones, and the orders left with a choice. Pure. */
export function pairUp<O extends Pick<Order, "id" | "companyId" | "itemId" | "itemName" | "quantity" | "at">, L extends Pick<Line, "id" | "companyId" | "itemId" | "name" | "itemName" | "quantity" | "issueDate">>(orders: O[], lines: L[]): { sure: [O, L][]; choose: [O, L[]][]; none: O[] } {
  const byCompany = new Map<string, L[]>();
  for (const l of lines) byCompany.set(l.companyId, [...(byCompany.get(l.companyId) ?? []), l]);
  const forOrder = new Map<string, L[]>();
  const forLine = new Map<string, number>();
  for (const o of orders) {
    const found = (byCompany.get(o.companyId) ?? []).filter((l) => fits(o, l));
    forOrder.set(o.id, found);
    for (const l of found) forLine.set(l.id, (forLine.get(l.id) ?? 0) + 1);
  }
  const sure: [O, L][] = [];
  const choose: [O, L[]][] = [];
  const none: O[] = [];
  for (const o of orders) {
    const found = forOrder.get(o.id) ?? [];
    if (found.length === 0) none.push(o);
    else if (found.length === 1 && forLine.get(found[0]!.id) === 1) sure.push([o, found[0]!]);
    else choose.push([o, found]);
  }
  return { sure, choose, none };
}

/**
 * The orders left to choose, each given the fitting line nearest its booking (owner, 21 Nov 2026 — "please do" the 482
 * to choose): every fit is ranked by days apart, and taken nearest first while neither its order nor its line is taken —
 * so a line bills one order, an order takes one line, and a line one of the sure pairs takes is never offered. Two
 * identical orders and two identical invoices pair one to one either way round. Pure.
 */
export function nearestPairs<O extends { id: string; at: Date }, L extends { id: string; issueDate: Date }>(choose: [O, L[]][], taken: Set<string> = new Set()): [O, L][] {
  const fits = choose.flatMap(([o, ls]) => ls.filter((l) => !taken.has(l.id)).map((l) => ({ o, l, apart: Math.abs(l.issueDate.getTime() - o.at.getTime()) })));
  fits.sort((a, b) => a.apart - b.apart || a.l.issueDate.getTime() - b.l.issueDate.getTime() || a.o.id.localeCompare(b.o.id) || a.l.id.localeCompare(b.l.id));
  const ordersTaken = new Set<string>();
  const linesTaken = new Set(taken);
  const out: [O, L][] = [];
  for (const f of fits) {
    if (ordersTaken.has(f.o.id) || linesTaken.has(f.l.id)) continue;
    ordersTaken.add(f.o.id);
    linesTaken.add(f.l.id);
    out.push([f.o, f.l]);
  }
  return out;
}

async function plan(m: MigrationRow) {
  const { thisYear, earlierYears } = await oldOrders(m);
  const lines = await oldInvoiceLines([...new Set(thisYear.map((o) => o.companyId))]);
  const p = pairUp(thisYear, lines);
  return { ...p, nearest: nearestPairs(p.choose, new Set(p.sure.map(([, l]) => l.id))), earlierYears };
}

const day = (d: Date) => d.toISOString().slice(0, 10);

/** What linking would do. Changes nothing. */
export async function oldOrderLinks(m: MigrationRow): Promise<OldOrderLinks> {
  const p = await plan(m);
  return {
    sure: p.sure.length,
    toChooseCount: p.choose.length,
    toChoose: p.choose.slice(0, LIST_MAX).map(([o, ls]) => ({
      orderId: o.id,
      orderLabel: formatOrderId(o.orderSeq),
      orderSeq: o.orderSeq,
      company: o.companyName,
      item: o.itemName,
      quantity: o.quantity,
      bookedOn: day(o.at),
      // Nearest the order's date first — the likeliest.
      candidates: [...ls]
        .sort((a, b) => Math.abs(a.issueDate.getTime() - o.at.getTime()) - Math.abs(b.issueDate.getTime() - o.at.getTime()))
        .slice(0, 6)
        .map((l) => ({ lineId: l.id, documentId: l.documentId, docNumber: l.docNumber, issueDate: day(l.issueDate), amount: l.amount })),
    })),
    noMatch: p.none.length,
    earlierYears: p.earlierYears,
    nearest: p.nearest.length,
  };
}

/**
 * Links the sure pairs — or, `nearest`, those left to choose by nearest date — five hundred at a press, worked out again
 * here, never from what the page sent.
 */
export async function linkOldOrders(m: MigrationRow, opts: { nearest?: boolean } = {}): Promise<{ linked: number; more: number }> {
  const p = await plan(m);
  const pairs = opts.nearest ? p.nearest : p.sure;
  const batch = pairs.slice(0, BATCH);
  let linked = 0;
  for (const [o, l] of batch) {
    // Still billing no order — anything that changed since it was read is left alone.
    const done = await db.tradeDocumentLine.updateMany({ where: { id: l.id, companyProductId: null }, data: { companyProductId: o.id } });
    linked += done.count;
  }
  return { linked, more: Math.max(0, pairs.length - batch.length) };
}
