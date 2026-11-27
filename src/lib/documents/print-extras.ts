import type { TradeDocumentStatus, TradeDocumentType } from "@prisma/client";
import { workspacePack } from "@/lib/country-pack";

/**
 * What the printed document carries besides itself (owner, 29 Oct 2026): the copies Rule 48 asks for, and a UPI
 * scan-to-pay code. Pure, so the print page and check:print-extras read the same rules.
 */

/** The documents Rule 48 (and Rule 49 for a bill of supply) has prepared in copies. */
const IN_COPIES: TradeDocumentType[] = ["INVOICE"];

/**
 * A line is a service when its code is a SAC — they all start 99. A document of goods (any line a good) is in
 * triplicate: original for the recipient, duplicate for the transporter, triplicate for the supplier; one of services
 * alone in duplicate: original for the recipient, duplicate for the supplier (Rule 48(1), (2)).
 */
export function ruleCopies(docType: TradeDocumentType, lines: { hsnCode: string | null }[]): string[] | null {
  if (!IN_COPIES.includes(docType)) return null;
  const goods = lines.some((l) => !(l.hsnCode ?? "").trim().startsWith("99"));
  return goods ? ["Original for recipient", "Duplicate for transporter", "Triplicate for supplier"] : ["Original for recipient", "Duplicate for supplier"];
}

/** The copies to print, by `?copies=`: "all" every one the rule names, anything else the original alone. */
export function copiesToPrint(all: string[] | null, asked: string | undefined): (string | null)[] {
  if (!all) return [null];
  return asked === "all" ? all : [all[0]!];
}

/** The documents a customer pays from, and so may carry a code to pay them by. */
const PAYABLE: TradeDocumentType[] = ["INVOICE", "PROFORMA", "DEBIT_NOTE"];

/** Whether this type can carry a scan-to-pay code at all — what a print template's switch for it applies to. */
export function paysByUpi(docType: TradeDocumentType): boolean {
  return PAYABLE.includes(docType);
}

const UPI_ID = /^[a-zA-Z0-9.\-_]{2,256}@[a-zA-Z][a-zA-Z0-9.\-]{1,64}$/;

/**
 * The UPI link a scan-to-pay QR carries (NPCI's `upi://pay`): to our UPI ID, our name, the amount still owed — left
 * out once part is paid, for the payer to type, as only the books know what is left — in rupees, the document's number
 * as the note. None for a document in another currency, paid, cancelled, or with nothing to pay; none without a UPI ID
 * that is one.
 */
export function upiPayLink(doc: { docType: TradeDocumentType; status: TradeDocumentStatus; currency: string; total: number; docNumber: string }, upiId: string | null | undefined, payee: string): string | null {
  const id = (upiId ?? "").trim();
  if (!PAYABLE.includes(doc.docType) || !UPI_ID.test(id)) return null;
  if (doc.currency !== "INR" || doc.total <= 0 || ["PAID", "CANCELLED", "REJECTED", "EXPIRED"].includes(doc.status)) return null;
  // The UPI ID as it is — its "@" kept, which some apps won't read encoded; it can hold nothing else (UPI_ID).
  const parts = [`pa=${id}`, `pn=${encodeURIComponent(payee.slice(0, 50))}`];
  if (doc.status !== "PARTIALLY_PAID") parts.push(`am=${doc.total.toFixed(2)}`);
  parts.push("cu=INR", `tn=${encodeURIComponent(doc.docNumber.slice(0, 50))}`);
  return `upi://pay?${parts.join("&")}`;
}

/** Supplies taxed at nothing because they leave India, or go to an SEZ: zero-rated, still a tax invoice (under a LUT). */
const ZERO_RATED = ["OVERSEAS", "SEZ", "DEEMED_EXPORT"];

/**
 * What the paper is called. An invoice with no tax on any line, for a supply that isn't zero-rated, is a bill of
 * supply (s.31(3)(c), Rule 49): exempt or nil-rated goods or services carry no tax to invoice. In Deskzo it stays an
 * invoice — its number, its posting, GSTR-1's nil-rated figures — and only the paper says what it is, with the
 * declaration the rule asks for. An invoice with any taxed line stays a tax invoice, the exempt lines on it at 0%.
 */
export function printedTitle(
  doc: { docType: TradeDocumentType; gstTreatment: string; cgstAmount: number; sgstAmount: number; igstAmount: number; lines: { taxRatePercent: number | string }[] },
  label: string,
  /** A UAE invoice the FTA lets be simplified, on a template asking for it (simplifiedAllowed). */
  simplified = false,
): { title: string; declaration: string | null } {
  // Outside India there is no bill of supply: the UAE's paper is a "Tax Invoice" or a "Tax Credit Note", whatever its
  // lines carry (src/lib/vat).
  if (!workspacePack().india) {
    if (doc.docType === "INVOICE") return { title: simplified ? "Simplified Tax Invoice" : "Tax Invoice", declaration: null };
    if (doc.docType === "CREDIT_NOTE") return { title: "Tax Credit Note", declaration: null };
    return { title: label, declaration: null };
  }
  const untaxed = doc.cgstAmount === 0 && doc.sgstAmount === 0 && doc.igstAmount === 0 && doc.lines.length > 0 && doc.lines.every((l) => Number(l.taxRatePercent) === 0);
  if (doc.docType === "INVOICE" && untaxed && !ZERO_RATED.includes(doc.gstTreatment)) {
    return { title: "Bill of supply", declaration: "Supply of exempt or nil-rated goods or services — no GST is charged on this bill of supply (Rule 49 of the CGST Rules)." };
  }
  return { title: label, declaration: null };
}

/**
 * Whether a UAE invoice may go as a simplified tax invoice (owner, 14 Nov 2026): the template asks for one (its "Full
 * tax invoice" switched off), and the FTA allows it — the buyer has no TRN, or the sale is AED 10,000 or less.
 */
export function simplifiedAllowed(doc: { docType: TradeDocumentType; buyerTrn: string | null | undefined; totalInAed: number }, fullTaxInvoice: boolean): boolean {
  if (fullTaxInvoice || doc.docType !== "INVOICE" || workspacePack().country !== "AE") return false;
  return !(doc.buyerTrn ?? "").trim() || doc.totalInAed <= 10_000;
}
