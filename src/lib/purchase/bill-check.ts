import { db } from "@/lib/db";

/**
 * A vendor's bill checked against our purchase order (owner, 16 Nov 2026: "when the distributor invoice comes how do we
 * check if the distributor has not charged anything wrong or no wrong sku or quantity"). Each line of the bill is set
 * against the PO's line for the same item:
 *
 *   · an item the PO doesn't have — a wrong SKU, or something we never ordered;
 *   · more than the PO still has unbilled — counting what earlier bills against it already billed;
 *   · a unit price (after the line's discount, before GST) above the PO's — and above the deal price the distributor
 *     agreed under a registration, where the order has one;
 *   · a different GST rate.
 *
 * It decides nothing: it says what differs, and by how much in rupees, for purchase or accounts to take up with the
 * vendor. Shown on the bill (src/components/documents/bill-po-check.tsx). `compareBillToPo` is pure; check:bill-check.
 */

export type CheckLine = {
  /** The product, when it's one of ours; lines are matched by it, else by name. */
  itemId: string | null;
  name: string;
  quantity: number;
  /** Before GST, after the line's discount — what one unit costs. */
  unitNet: number;
  taxRate: number;
  /** The customer order a PO line buys for — its deal price is checked too. */
  orderId?: string | null;
};

export type IssueKind = "NOT_ON_PO" | "OVER_QUANTITY" | "ABOVE_PO_PRICE" | "ABOVE_DEAL_PRICE" | "TAX_RATE";
export type CheckIssue = { kind: IssueKind; text: string; /** In rupees, what it costs us over the PO; 0 where it's not money. */ extra: number };

export type CheckRow = {
  name: string;
  billed: { quantity: number; unitNet: number; taxRate: number } | null;
  ordered: { quantity: number; unitNet: number; taxRate: number; alreadyBilled: number; dealPrice: number | null } | null;
  issues: CheckIssue[];
};

export type BillCheck = { rows: CheckRow[]; extra: number; matches: boolean; notBilledYet: string[] };

const round2 = (n: number) => Math.round(n * 100) / 100;
const keyOf = (l: { itemId: string | null; name: string }) => (l.itemId ? `i:${l.itemId}` : `n:${l.name.trim().toLowerCase().replace(/\s+/g, " ")}`);
const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
/** A paisa of rounding is no difference. */
const OVER = 0.01;

export function compareBillToPo(input: {
  bill: CheckLine[];
  po: CheckLine[];
  /** What earlier bills against the PO billed already, by item (keyOf). */
  alreadyBilled: Map<string, number>;
  /** Deal prices by the customer order a PO line buys for. */
  dealPrices: Map<string, number>;
}): BillCheck {
  const po = new Map<string, CheckLine & { quantity: number }>();
  for (const l of input.po) {
    const k = keyOf(l);
    const was = po.get(k);
    // The same item twice on a PO: one line, the quantities added, at the dearer price.
    po.set(k, was ? { ...was, quantity: was.quantity + l.quantity, unitNet: Math.max(was.unitNet, l.unitNet) } : { ...l });
  }
  const billByKey = new Map<string, CheckLine & { quantity: number; total: number }>();
  for (const l of input.bill) {
    const k = keyOf(l);
    const was = billByKey.get(k);
    billByKey.set(k, was ? { ...was, quantity: was.quantity + l.quantity, total: was.total + l.unitNet * l.quantity } : { ...l, total: l.unitNet * l.quantity });
  }

  const rows: CheckRow[] = [];
  let extra = 0;
  for (const [k, b] of billByKey) {
    const unitNet = b.quantity > 0 ? round2(b.total / b.quantity) : b.unitNet;
    const ordered = po.get(k);
    const issues: CheckIssue[] = [];
    if (!ordered) {
      const cost = round2(unitNet * b.quantity);
      issues.push({ kind: "NOT_ON_PO", text: `Not on our PO — a different SKU, or something we didn't order (${rupees(cost)}).`, extra: cost });
      extra += cost;
      rows.push({ name: b.name, billed: { quantity: b.quantity, unitNet, taxRate: b.taxRate }, ordered: null, issues });
      continue;
    }
    const already = input.alreadyBilled.get(k) ?? 0;
    const left = Math.max(0, ordered.quantity - already);
    if (b.quantity > left + 1e-9) {
      const over = round2(b.quantity - left);
      const cost = round2(over * unitNet);
      issues.push({
        kind: "OVER_QUANTITY",
        text: `${over} more than the PO has left to bill — ${ordered.quantity} ordered${already ? `, ${already} billed already` : ""} (${rupees(cost)}).`,
        extra: cost,
      });
      extra += cost;
    }
    const billedWithin = Math.min(b.quantity, left);
    if (unitNet > ordered.unitNet + OVER) {
      const cost = round2((unitNet - ordered.unitNet) * billedWithin);
      issues.push({ kind: "ABOVE_PO_PRICE", text: `${rupees(round2(unitNet - ordered.unitNet))} a unit above our PO's ${rupees(ordered.unitNet)} (${rupees(cost)}).`, extra: cost });
      extra += cost;
    }
    const deal = ordered.orderId ? (input.dealPrices.get(ordered.orderId) ?? null) : null;
    if (deal !== null && unitNet > deal + OVER) {
      // Said even where the PO itself was above the deal: the vendor agreed to bill at it.
      issues.push({ kind: "ABOVE_DEAL_PRICE", text: `Above the deal price of ${rupees(deal)} a unit — the registered price wasn't applied.`, extra: 0 });
    }
    if (Math.abs(b.taxRate - ordered.taxRate) > 0.001) {
      issues.push({ kind: "TAX_RATE", text: `GST at ${b.taxRate}% — our PO has ${ordered.taxRate}%.`, extra: 0 });
    }
    rows.push({ name: b.name, billed: { quantity: b.quantity, unitNet, taxRate: b.taxRate }, ordered: { quantity: ordered.quantity, unitNet: ordered.unitNet, taxRate: ordered.taxRate, alreadyBilled: already, dealPrice: deal }, issues });
  }
  // On the PO, not on this bill — billed later, or not at all; said, never a problem.
  const notBilledYet = [...po.entries()].filter(([k, l]) => !billByKey.has(k) && l.quantity - (input.alreadyBilled.get(k) ?? 0) > 1e-9).map(([, l]) => l.name);
  extra = round2(extra);
  return { rows, extra, matches: rows.every((r) => r.issues.length === 0), notBilledYet };
}

type LoadedLine = { itemId: string | null; name: string; quantity: unknown; taxableValue: unknown; taxRatePercent: unknown; companyProductId: string | null };
const asCheckLine = (l: LoadedLine): CheckLine => {
  const quantity = Number(l.quantity);
  return { itemId: l.itemId, name: l.name, quantity, unitNet: quantity > 0 ? round2(Number(l.taxableValue) / quantity) : 0, taxRate: Number(l.taxRatePercent), orderId: l.companyProductId };
};
const LINE_SELECT = { itemId: true, name: true, quantity: true, taxableValue: true, taxRatePercent: true, companyProductId: true } as const;

export type BillPoCheck = BillCheck & { po: { id: string; docNumber: string | null }; how: "FROM_PO" | "BY_REFERENCE" };

/**
 * A bill's check, read: its PO is the one it was made from, else one of this vendor's whose number the bill gives as
 * its reference. Null for anything that isn't a bill, or a bill with no PO to check against.
 */
export async function billPoCheck(billId: string): Promise<BillPoCheck | null> {
  const bill = await db.tradeDocument.findUnique({
    where: { id: billId },
    select: { id: true, docType: true, companyId: true, reference: true, sourceDocumentId: true, sourceDocument: { select: { id: true, docType: true } }, lines: { select: LINE_SELECT } },
  });
  if (!bill || bill.docType !== "BILL") return null;
  let poId: string | null = bill.sourceDocument?.docType === "PURCHASE_ORDER" ? bill.sourceDocument.id : null;
  let how: BillPoCheck["how"] = "FROM_PO";
  if (!poId && bill.reference?.trim()) {
    const named = await db.tradeDocument.findFirst({ where: { docType: "PURCHASE_ORDER", companyId: bill.companyId, docNumber: bill.reference.trim(), status: { notIn: ["DRAFT", "CANCELLED"] } }, select: { id: true } });
    if (named) {
      poId = named.id;
      how = "BY_REFERENCE";
    }
  }
  if (!poId) return null;
  const po = await db.tradeDocument.findUnique({ where: { id: poId }, select: { id: true, docNumber: true, lines: { select: LINE_SELECT } } });
  if (!po) return null;
  // What the PO's other live bills billed already — those made from it, and those naming it.
  const others = await db.tradeDocument.findMany({
    where: { id: { not: bill.id }, docType: "BILL", status: { notIn: ["DRAFT", "CANCELLED"] }, OR: [{ sourceDocumentId: po.id }, ...(po.docNumber ? [{ companyId: bill.companyId, reference: po.docNumber }] : [])] },
    select: { lines: { select: LINE_SELECT } },
  });
  const alreadyBilled = new Map<string, number>();
  for (const o of others) for (const l of o.lines) alreadyBilled.set(keyOf(l), (alreadyBilled.get(keyOf(l)) ?? 0) + Number(l.quantity));
  const orderIds = [...new Set(po.lines.map((l) => l.companyProductId).filter((v): v is string => !!v))];
  const orders = orderIds.length ? await db.companyProduct.findMany({ where: { id: { in: orderIds } }, select: { id: true, dealPrice: true } }) : [];
  const dealPrices = new Map(orders.filter((o) => o.dealPrice !== null).map((o) => [o.id, Number(o.dealPrice)]));
  const result = compareBillToPo({ bill: bill.lines.map(asCheckLine), po: po.lines.map(asCheckLine), alreadyBilled, dealPrices });
  return { ...result, po: { id: po.id, docNumber: po.docNumber }, how };
}
