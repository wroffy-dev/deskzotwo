import type { TradeDocumentType } from "@prisma/client";
import { stateCodeFromGstin } from "@/lib/gst-engine";

/**
 * Which documents goods actually travel on.
 *
 * Lives here rather than beside the actions because a `"use server"` module may only export async
 * functions — every export there is a public endpoint, and a constant isn't callable. Pages and
 * client components read it from here; `src/actions/eway.ts` imports the same list, so there is
 * still only one.
 *
 * A proposal or a proforma is a price, not a movement. A purchase document covers goods coming in,
 * where the supplier raises the bill, not us.
 */
export const EWAY_DOC_TYPES: TradeDocumentType[] = ["INVOICE", "CREDIT_NOTE", "DELIVERY_CHALLAN"];

/**
 * True when this document could need an e-way bill at all — a draft has moved nothing.
 *
 * Security audit round three, 14 Nov 2026 (R3-07): nor has a cancelled, rejected or expired one — and the actions that
 * raise, save and record bills now ask this too (they asked nothing, so a bill could be raised on a draft, a cancelled
 * invoice or a vendor's bill by its id).
 */
export function carriesGoods(docType: TradeDocumentType, status: string) {
  return EWAY_DOC_TYPES.includes(docType) && status !== "DRAFT" && status !== "CANCELLED" && status !== "REJECTED" && status !== "EXPIRED";
}

/**
 * Whether a line's code is goods: an HSN code — 4, 6 or 8 digits, not a SAC (every SAC starts 99). A line with no code
 * isn't counted as goods (owner, 16 Nov 2026: "eway bill only if hsn is hardware code - goods"): it was, so a document
 * of uncoded lines was offered an e-way bill its lines could never fill.
 */
export function isGoodsCode(code: string | null | undefined): boolean {
  const c = (code ?? "").replace(/\s/g, "");
  return /^\d{4,8}$/.test(c) && !c.startsWith("99");
}

/** Whether any line is goods (`isGoodsCode`). A document of services alone moves nothing an e-way bill covers. */
export function hasGoodsLines(lines: { hsnCode: string | null }[]) {
  return lines.some((l) => isGoodsCode(l.hsnCode));
}

/** The same, as a database filter on a document's lines: a goods HSN code (not blank, not a SAC). */
export const GOODS_LINE_WHERE = { AND: [{ hsnCode: { not: null } }, { NOT: { hsnCode: "" } }, { NOT: { hsnCode: { startsWith: "99" } } }] };

/** Why no e-way bill can be raised on this document, or null when one can (R3-07). */
export function ewayRefusal(doc: { docType: TradeDocumentType; status: string; lines: { hsnCode: string | null }[] }): string | null {
  if (!EWAY_DOC_TYPES.includes(doc.docType)) return "E-way bills are raised on our own invoices, credit notes and delivery challans — a vendor's bill or a quote carries none.";
  if (doc.status === "DRAFT") return "Issue the document before raising its e-way bill.";
  if (!carriesGoods(doc.docType, doc.status)) return "This document is cancelled, rejected or expired — no goods move on it.";
  if (!hasGoodsLines(doc.lines)) return "An e-way bill is for goods, and no line on this document has a goods HSN code — services (SAC 99…) and lines without a code don't move under one.";
  return null;
}

/**
 * The GST state code the goods are going to.
 *
 * Four places can answer this and they are not interchangeable, so they are tried in the order of
 * how directly each one states the delivery:
 *
 *   1. `shippingStateCode` — written on the document as the place of delivery;
 *   2. `placeOfSupplyCode` — the state the tax was worked out against, which is the delivery state
 *      for goods and is set on every invoice this app issues;
 *   3. the buyer's own GSTIN, whose first two digits are their state;
 *   4. `billingStateCode`, last because a bill-to address is frequently a head office that the
 *      goods will never see.
 *
 * Missing the place of supply is what made a perfectly ordinary invoice — "Place of supply: 29 —
 * Karnataka", printed on the same screen — report that it had no delivery state.
 */
export function deliveryStateCode(doc: {
  shippingStateCode?: string | null;
  placeOfSupplyCode?: string | null;
  buyerGstin?: string | null;
  billingStateCode?: string | null;
}): string | null {
  return (
    doc.shippingStateCode ||
    doc.placeOfSupplyCode ||
    stateCodeFromGstin(doc.buyerGstin) ||
    doc.billingStateCode ||
    null
  );
}
