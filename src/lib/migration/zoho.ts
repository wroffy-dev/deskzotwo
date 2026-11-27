import { readDay } from "./dates";
import { stateCodeFromName } from "@/lib/documents/create-draft";
import { GST_STATE_CODES } from "@/lib/gst-engine";
import { stateName } from "@/lib/legacy-import/formats";
import { DOCUMENT_COLUMNS, DOCUMENT_EXTRA_COLUMNS } from "@/lib/portability/documents";
import { HISTORY_COLUMNS } from "./documents";
import { EXPENSE_COLUMNS } from "./expenses";
import { JOURNAL_COLUMNS } from "./journals";
import { BILL_COLUMNS, VENDOR_CREDIT_COLUMNS } from "./purchases";
import { RECEIPT_COLUMNS, VENDOR_PAYMENT_COLUMNS } from "./receipts";
import type { StepKey } from "./steps";

/**
 * Zoho Books' own export files, read as the switch's columns (phase 2 of the Zoho plan, owner 26 Oct 2026).
 *
 * The switch reads any system's file by guessing at its headings (`headerAliases`); a Zoho file has up to 198
 * of them, and the guesses collide on it — "Place of Supply" beside "Place of Supply(With State Code)", "Item
 * Tax" (the tax's name) beside "Item Tax %". A file that is Zoho's — known by the id column only Zoho writes —
 * is read here instead, heading by exact heading, and comes out as the switch's own columns and nothing else:
 *
 *   · **Zoho's ids ride along** (`DOCUMENT_EXTRA_COLUMNS`): the customer's, the vendor's and the item's, so a
 *     document finds the company and item the master lists brought in, before any name.
 *   · **What Zoho keeps as an amount stays one**: a line's discount (and a document-level discount, spread
 *     over its lines as Zoho spreads it before tax), freight and its tax, the adjustment, the currency.
 *   · **Prices that included tax** are taken back to the price before it, which is how a Deskzo line is kept.
 *   · **A state** — "HR", "06-Haryana" — becomes its two-digit GST code.
 *   · **What was applied** of a credit note or a vendor credit is its total less what Zoho still shows left.
 *   · A cancelled e-way bill or e-invoice isn't carried.
 *
 * Built against the headings of a real Zoho Books backup (Wroffy's, 26 Oct 2026) with no customer rows read;
 * the suite (scripts/check-zoho-files.ts) runs on made-up rows under those headings.
 */

const C = DOCUMENT_COLUMNS;
const X = DOCUMENT_EXTRA_COLUMNS;
const H = HISTORY_COLUMNS;

type Row = Record<string, string>;

/**
 * The columns only Zoho's own export of each step has together — its id, and one more of its exact headings — so a
 * file written to the switch's aliases with an id column of the same name isn't taken for one.
 */
const MARKS: Record<StepKey, readonly [string, string]> = {
  invoices: ["Invoice ID", "Item Price"],
  "credit-notes": ["CreditNotes ID", "Credit Note Number"],
  receipts: ["CustomerPayment ID", "Amount Applied to Invoice"],
  bills: ["Bill ID", "Bill Status"],
  "vendor-credits": ["Vendor Credit ID", "Vendor Credit Number"],
  "vendor-payments": ["VendorPayment ID", "Bill Amount"],
  expenses: ["Expense Reference ID", "Paid Through Account Code"],
  journals: ["Journal ID", "Journal Number"],
  quotes: ["Quote ID", "Quote Number"],
  "sales-orders": ["SalesOrder ID", "SalesOrder Number"],
  "purchase-orders": ["Purchase Order ID", "Purchase Order Number"],
};

export function isZohoFile(step: StepKey, rows: Row[]): boolean {
  const first = rows[0];
  return first !== undefined && MARKS[step].every((h) => h in first);
}

const text = (row: Row, ...headings: string[]) => {
  for (const h of headings) {
    const v = (row[h] ?? "").trim();
    if (v) return v;
  }
  return "";
};
const num = (v: string) => {
  const n = Number(v.replace(/,/g, ""));
  return v.trim() && Number.isFinite(n) ? n : 0;
};
const round = (n: number, places = 2) => {
  const f = 10 ** places;
  return Math.round((n + Number.EPSILON) * f) / f;
};
const yes = (v: string) => /^(true|yes|1)$/i.test(v.trim());
/** "2026-07-13 10:22:00" → "2026-07-13": the switch takes days. */
/** A day as the switch reads it ("yyyy-mm-dd"), whatever format the organisation's Zoho writes; else as written, for the step to refuse with it. */
const dayOf = (v: string) => readDay(v) ?? v.trim().split(/[ T]/)[0] ?? "";
const amount = (n: number) => (n ? String(round(n)) : "");

/** "HR", "Keralam", "06-Haryana" → "06"; blank when it isn't one. */
export function zohoStateCode(value: string): string {
  const t = value.trim();
  if (!t) return "";
  const code = /^\d{2}\b/.exec(t)?.[0];
  if (code && code in GST_STATE_CODES) return code;
  const name = stateName(t.replace(/^\d{2}\s*[-–]\s*/, ""), "IN") ?? t;
  return stateCodeFromName(name) ?? stateCodeFromName(name.replace(/\band\b/g, "&")) ?? "";
}

/** Rows sharing a Zoho id are one document, in file order. */
/**
 * Which document a row is part of: Zoho's id for it — or, where a spreadsheet has rounded that to "8.80908E+17" and
 * every document's id reads the same, its number and its party, so two documents aren't taken for one.
 */
export function documentKey(row: Row, idColumn: string, numberColumn: string): string {
  const id = (row[idColumn] ?? "").trim();
  if (id && !/^\d(\.\d+)?E\+\d+$/i.test(id)) return id;
  const number = (row[numberColumn] ?? "").trim();
  return number ? `n:${(row["Vendor Name"] ?? row["Customer Name"] ?? "").trim().toLowerCase()}|${number}` : "";
}

function byId(rows: Row[], idColumn: string, numberColumn: string): Row[][] {
  const groups = new Map<string, Row[]>();
  const order: Row[][] = [];
  let last = "";
  rows.forEach((row, i) => {
    const id = documentKey(row, idColumn, numberColumn) || `#${i}`;
    let group = groups.get(id);
    // A document's lines come together. The same one again further on is a second copy — read twice by a pull, or
    // handed over again — and the later stands (owner, 23 Nov 2026: WT/26-27/QT/3131 with every line twice).
    if (group && id !== last) group.length = 0;
    if (!group) {
      group = [];
      groups.set(id, group);
      order.push(group);
    }
    group.push(row);
    last = id;
  });
  return order.map(oneCopy);
}

/**
 * A document's lines once. Zoho's line ids, where the rows have them, say which are the same line; without them, lines
 * that repeat in the same order as a whole are taken as one copy only where that brings them to the document's own
 * subtotal and the repeats don't — two lines rightly alike are never folded.
 */
function oneCopy(group: Row[]): Row[] {
  if (group.length < 2) return group;
  const ids = group.map((r) => text(r, "Line Item ID"));
  if (ids.every(Boolean)) {
    const lastOf = new Map(ids.map((id, i) => [id, i]));
    return group.filter((_, i) => lastOf.get(ids[i]!) === i);
  }
  const subtotal = num(text(group[0]!, "SubTotal", "Sub Total"));
  if (!subtotal) return group;
  const sum = (rows: Row[]) => rows.reduce((t, r) => t + num(text(r, "Item Total")), 0);
  if (Math.abs(sum(group) - subtotal) <= 1) return group;
  const sig = group.map((r) => JSON.stringify(r));
  for (let p = 1; p <= group.length / 2; p++) {
    if (group.length % p !== 0) continue;
    if (!sig.every((s, i) => s === sig[i % p])) continue;
    const once = group.slice(0, p);
    if (Math.abs(sum(once) - subtotal) <= 1) return once;
  }
  return group;
}

/** A line's quantity: blank is one (a backup that leaves it out), a written 0 is none. */
const quantityOf = (row: Row, ...headings: string[]) => {
  const raw = text(row, ...headings);
  return raw ? num(raw) : 1;
};

/**
 * A document's lines as the switch keeps them: the price before tax, the discount as an amount — the line's
 * own plus its share of one given on the whole document — and the tax rate.
 */
function linesOf(rows: Row[], o: { rate: string[]; tax: string[] }) {
  const all = rows.map((row) => {
    const quantity = quantityOf(row, "Quantity");
    const rate = num(text(row, ...o.rate));
    return { row, quantity, rate, gross: quantity * rate, tax: num(text(row, ...o.tax)), own: num(text(row, "Discount Amount")) };
  });
  // A line of none (owner, 23 Nov 2026: WT/26-27/QT/1266's "Content writing", 0 at ₹3 a word) adds nothing and isn't
  // one of its own — it was read as one, ₹3.54 on the total. Left out, unless it is all there is.
  const prices = all.some((p) => p.quantity !== 0) ? all.filter((p) => p.quantity !== 0) : all;
  const head = rows[0]!;
  // A discount on the whole document — not the lines' own added up again (Zoho's item-level discount_total).
  const owned = prices.reduce((t, p) => t + p.own, 0);
  const given = num(text(head, "Entity Discount Amount"));
  const whole = /item/i.test(text(head, "Discount Type")) || (owned > 0 && Math.abs(given - owned) < 0.01) ? 0 : given;
  const pool = prices.reduce((t, p) => t + p.gross, 0);
  const inclusive = yes(text(head, "Is Inclusive Tax"));
  return prices.map((p) => {
    const share = whole && pool ? (whole * p.gross) / pool : 0;
    const out = inclusive ? 1 + p.tax / 100 : 1;
    return { row: p.row, quantity: p.quantity, rate: round(p.rate / out, 4), discount: round((p.own + share) / out), tax: p.tax };
  });
}

/** An invoice's or a credit note's rows. */
function salesDocument(rows: Row[], type: "INVOICE" | "CREDIT_NOTE"): Row[] {
  const invoice = type === "INVOICE";
  return byId(rows, invoice ? "Invoice ID" : "CreditNotes ID", invoice ? "Invoice Number" : "Credit Note Number").flatMap((group) => {
    const head = group[0]!;
    const einvoiceLive = !/cancel/i.test(text(head, "e-Invoice Status"));
    const ewayLive = !/cancel/i.test(text(head, "E-WayBill Status"));
    const applied = invoice ? 0 : round(num(text(head, "Total")) - num(text(head, "Balance")));
    return linesOf(group, { rate: ["Item Price"], tax: ["Item Tax %"] }).map(({ row, quantity, rate, discount, tax }) => ({
      [C.number]: text(head, invoice ? "Invoice Number" : "Credit Note Number"),
      [C.date]: dayOf(text(head, invoice ? "Invoice Date" : "Credit Note Date")),
      [C.party]: text(head, "Customer Name"),
      [X.partyId]: text(head, "Customer ID"),
      [C.status]: text(head, invoice ? "Invoice Status" : "Credit Note Status"),
      [C.due]: invoice ? dayOf(text(head, "Due Date")) : "",
      ...(invoice ? {} : { [C.against]: text(head, "Associated Invoice Number", "Applied Invoice Number", "CF.Original Invoice #") }),
      [C.placeOfSupply]: zohoStateCode(text(head, "Place of Supply(With State Code)", "Place of Supply")),
      [C.gstin]: text(head, "GST Identification Number (GSTIN)"),
      [C.reference]: text(head, invoice ? "PurchaseOrder" : "Reference#"),
      [C.salesperson]: text(head, "Sales person"),
      [C.notes]: text(head, "Notes"),
      [C.terms]: text(head, "Terms & Conditions"),
      [C.item]: text(row, "Item Name", "SKU"),
      [X.itemId]: text(row, "Product ID"),
      [C.description]: text(row, "Item Desc"),
      [C.hsn]: text(row, "HSN/SAC"),
      [C.quantity]: String(quantity),
      [C.unit]: text(row, "Usage unit"),
      [C.rate]: String(rate),
      [C.tax]: String(tax),
      [X.discountAmount]: amount(discount),
      [C.total]: text(head, "Total"),
      [X.shipping]: amount(num(text(head, "Shipping Charge"))),
      [X.shippingTax]: text(head, "Shipping Charge Tax %"),
      [X.adjustment]: amount(num(text(head, "Adjustment"))),
      [X.currency]: text(head, "Currency Code"),
      [X.exchangeRate]: text(head, "Exchange Rate"),
      [X.tdsRate]: invoice && num(text(head, "TDS Percentage")) ? text(head, "TDS Percentage") : "",
      [X.tdsAmount]: invoice ? amount(num(text(head, "TDS Amount"))) : "",
      [X.tdsSection]: invoice ? text(head, "TDS Section Code", "TDS Section", "TDS Name") : "",
      [H.irn]: einvoiceLive ? text(head, "e-Invoice Reference Number") : "",
      [H.ackNo]: einvoiceLive ? text(head, "e-Invoice Ack Number") : "",
      [H.ackDate]: einvoiceLive ? dayOf(text(head, "e-Invoice Ack Date")) : "",
      [H.signedQr]: einvoiceLive ? text(head, "e-Invoice QR Raw Data") : "",
      ...(invoice
        ? {
            [H.ewayNumber]: ewayLive ? text(head, "E-WayBill Number") : "",
            [H.ewayDate]: ewayLive ? dayOf(text(head, "E-WayBill Generated Time")) : "",
            [H.ewayValidUntil]: ewayLive ? dayOf(text(head, "E-WayBill Expired Time")) : "",
          }
        : { [H.applied]: applied > 0 ? String(applied) : "0" }),
    }));
  });
}

function bills(rows: Row[]): Row[] {
  const P = BILL_COLUMNS;
  return byId(rows, "Bill ID", "Bill Number").flatMap((group) => {
    const head = group[0]!;
    return linesOf(group, { rate: ["Rate"], tax: ["Tax Percentage"] }).map(({ row, quantity, rate, discount, tax }) => ({
      [C.number]: text(head, "Bill Number"),
      [C.date]: dayOf(text(head, "Bill Date")),
      [C.party]: text(head, "Vendor Name"),
      [C.status]: text(head, "Bill Status"),
      [C.due]: dayOf(text(head, "Due Date")),
      [C.placeOfSupply]: zohoStateCode(text(head, "Destination of Supply")),
      [C.gstin]: text(head, "GST Identification Number (GSTIN)"),
      [C.reference]: text(head, "PurchaseOrder", "Purchase Order Number"),
      [C.notes]: text(head, "Vendor Notes"),
      [C.terms]: text(head, "Terms & Conditions"),
      [C.item]: text(row, "Item Name", "SKU"),
      [X.itemId]: text(row, "Product ID"),
      [C.description]: text(row, "Description"),
      [C.hsn]: text(row, "HSN/SAC"),
      [C.quantity]: String(quantity),
      [C.unit]: text(row, "Usage unit"),
      [C.rate]: String(rate),
      [C.tax]: String(tax),
      [X.discountAmount]: amount(discount),
      [C.total]: text(head, "Total"),
      [X.adjustment]: amount(num(text(head, "Adjustment"))),
      [X.currency]: text(head, "Currency Code"),
      [X.exchangeRate]: text(head, "Exchange Rate"),
      [P.accountCode]: text(row, "Account Code"),
      [P.account]: text(row, "Account"),
      [P.tdsRate]: num(text(head, "TDS Percentage")) ? text(head, "TDS Percentage") : "",
      [P.tdsSection]: text(head, "TDS Section Code", "TDS Section", "TDS Name"),
      [P.tdsAmount]: amount(num(text(head, "TDS Amount"))),
    }));
  });
}

function vendorCredits(rows: Row[]): Row[] {
  const V = VENDOR_CREDIT_COLUMNS;
  return byId(rows, "Vendor Credit ID", "Vendor Credit Number").flatMap((group) => {
    const head = group[0]!;
    const applied = round(num(text(head, "Total")) - num(text(head, "Balance")));
    return group.map((row) => ({
      [V.number]: text(head, "Vendor Credit Number"),
      [V.date]: dayOf(text(head, "Vendor Credit Date")),
      [V.party]: text(head, "Vendor Name"),
      [X.partyId]: text(head, "Vendor ID"),
      [V.status]: text(head, "Vendor Credit Status"),
      [V.accountCode]: text(row, "Account Code"),
      [V.account]: text(row, "Account"),
      [V.description]: text(row, "Item Desc", "Item Name"),
      [V.quantity]: text(row, "Quantity"),
      [V.rate]: text(row, "Item Price"),
      [V.amount]: text(row, "Item Total"),
      [V.tax]: text(row, "Item Tax %"),
      [V.supply]: zohoStateCode(text(head, "Source of Supply")),
      [V.bill]: text(head, "Associated Bill Number"),
      [V.applied]: text(head, "Associated Bill Number") && applied > 0 ? String(applied) : "",
      [V.total]: text(head, "Total"),
      [V.notes]: text(head, "Notes"),
    }));
  });
}

/** A payment's rows: one a document it paid, the payment's own figures repeated on each. */
function payments(rows: Row[], side: "RECEIVED" | "PAID"): Row[] {
  const R = side === "RECEIVED" ? RECEIPT_COLUMNS : VENDOR_PAYMENT_COLUMNS;
  const received = side === "RECEIVED";
  return rows.map((row) => ({
    [R.number]: text(row, "Payment Number"),
    [R.date]: dayOf(text(row, "Date")),
    [R.party]: text(row, received ? "Customer Name" : "Vendor Name"),
    [X.partyId]: received ? text(row, "CustomerID") : "",
    [R.amount]: text(row, "Amount"),
    [R.mode]: text(row, "Mode"),
    [R.reference]: text(row, "Reference Number"),
    [R.depositTo]: text(row, received ? "Deposit To" : "Paid Through"),
    [R.invoice]: text(row, received ? "Invoice Number" : "Bill Number"),
    [R.applied]: text(row, received ? "Amount Applied to Invoice" : "Bill Amount"),
    [R.notes]: text(row, "Description"),
    [X.withheld]: amount(num(text(row, received ? "Withholding Tax Amount" : "TDSAmount"))),
    [X.bankCharges]: received ? amount(num(text(row, "Bank Charges"))) : "",
  }));
}

function expenses(rows: Row[]): Row[] {
  const E = EXPENSE_COLUMNS;
  return rows.map((row) => ({
    [E.id]: text(row, "Expense Reference ID", "Entry Number"),
    [E.date]: dayOf(text(row, "Expense Date")),
    [E.accountCode]: text(row, "Expense Account Code"),
    [E.account]: text(row, "Expense Account"),
    [E.paidThrough]: text(row, "Paid Through"),
    [E.vendor]: text(row, "Vendor"),
    [E.amount]: text(row, "Expense Amount"),
    [E.inclusive]: yes(text(row, "Is Inclusive Tax")) ? "Yes" : "No",
    [E.tax]: text(row, "Tax Percentage"),
    [E.taxAmount]: text(row, "Tax Amount"),
    [E.supply]: zohoStateCode(text(row, "Source of Supply")),
    [E.total]: text(row, "Total"),
    [E.reference]: text(row, "Reference#"),
    [E.description]: text(row, "Expense Description"),
  }));
}

function journals(rows: Row[]): Row[] {
  const J = JOURNAL_COLUMNS;
  return rows.map((row) => ({
    [J.number]: text(row, "Journal Number"),
    [J.date]: dayOf(text(row, "Journal Date")),
    [J.reference]: text(row, "Reference Number"),
    [J.notes]: text(row, "Notes"),
    [J.status]: text(row, "Status"),
    [J.accountCode]: text(row, "Account Code"),
    [J.account]: text(row, "Account"),
    [J.description]: text(row, "Description"),
    [J.contact]: text(row, "Contact Name"),
    [J.debit]: text(row, "Debit"),
    [J.credit]: text(row, "Credit"),
  }));
}

/**
 * Money Zoho moved without an invoice, bill or journal — Transfer_Fund (bank to bank, drawings) and Deposit (other
 * income paid in) — and the refunds it paid against credit notes (Refund). No other file brings them, and the
 * month-end check would be off on every account they touch; so they come in with the manual journals, each as a
 * journal of two lines, numbered by its file and row so the same file again brings nothing twice.
 */
const TRANSFER_HEADINGS = ["Transaction Date", "Transaction Type", "From Account", "To Account", "Total"] as const;
const REFUND_HEADINGS = ["Credit Note Number", "Refund From Account", "Amount", "Mode of Refund"] as const;

export const isZohoMovement = (rows: Row[]) => rows[0] !== undefined && (TRANSFER_HEADINGS.every((h) => h in rows[0]!) || REFUND_HEADINGS.every((h) => h in rows[0]!));

/** A Transfer_Fund, Deposit or Refund file's rows as Zoho's own journal rows, for the journals step. */
export function movementsAsJournals(file: string, rows: Row[]): Row[] {
  const base = (file.split(/[\\/]/).pop() ?? file).replace(/\.csv$/i, "");
  const refunds = REFUND_HEADINGS.every((h) => h in (rows[0] ?? {}));
  return rows.flatMap((row, i) => {
    const total = round(num(text(row, refunds ? "Amount" : "Total")));
    if (!total) return [];
    const extra = refunds ? 0 : num(text(row, "Tax Amount")) + num(text(row, "Bank Charges"));
    const notes = [
      refunds ? `Refund against credit note ${text(row, "Credit Note Number")}` : text(row, "Transaction Type"),
      text(row, "Description"),
      extra ? `Zoho's tax and bank charges on it (${round(extra)}) aren't brought — add them by hand` : "",
    ]
      .filter(Boolean)
      .join(" · ");
    const head = {
      "Journal ID": `${base}-${i + 1}`,
      "Journal Number": `${base} ${i + 1}`,
      "Journal Date": dayOf(text(row, refunds ? "Date" : "Transaction Date")),
      "Reference Number": text(row, refunds ? "Reference Number" : "Reference"),
      Notes: notes,
      Status: "published",
      Description: "",
    };
    // A refund pays the customer back: their receivable up by it, the money out of the account it came from.
    const debit = refunds ? { Account: "Accounts Receivable", "Contact Name": text(row, "Customer Name") } : { Account: text(row, "To Account"), "Contact Name": "" };
    const credit = refunds ? { Account: text(row, "Refund From Account Code", "Refund From Account"), "Contact Name": "" } : { Account: text(row, "From Account"), "Contact Name": "" };
    return [
      { ...head, ...debit, "Account Code": "", Debit: String(total), Credit: "" },
      { ...head, ...credit, "Account Code": "", Debit: "", Credit: String(total) },
    ];
  });
}

/** Zoho's Creditnotes_Invoice file: what each credit note was set against, by its number. */
export const isZohoCreditApplications = (rows: Row[]) => rows[0] !== undefined && ["Credit Note Number", "Invoice Number", "Applied Invoice Date", "Amount"].every((h) => h in rows[0]!);
export type CreditApplications = Map<string, { invoice: string; amount: number }[]>;
export function creditApplications(rows: Row[]): CreditApplications {
  const map: CreditApplications = new Map();
  for (const row of rows) {
    const note = text(row, "Credit Note Number");
    const amount = num(text(row, "Amount"));
    if (!note || !amount) continue;
    map.set(note, [...(map.get(note) ?? []), { invoice: text(row, "Invoice Number"), amount: round(amount) }]);
  }
  return map;
}

/**
 * What a credit note was set against, from Zoho's applications file when there is one — it leaves out what was
 * refunded, which the note's total less its balance doesn't. A note set against more than one invoice is set
 * against the first, and the rest ride along in "Also applied to" for the step to set against theirs.
 */
function withApplications(rows: Row[], applications: CreditApplications): Row[] {
  return rows.map((row) => {
    const apps = applications.get(row[C.number] ?? "");
    if (!apps?.length) return { ...row, [H.applied]: applications.size ? "0" : row[H.applied]! };
    return {
      ...row,
      [C.against]: apps[0]!.invoice,
      [H.applied]: String(apps[0]!.amount),
      [X.alsoApplied]: apps
        .slice(1)
        .map((a) => `${a.invoice}=${a.amount}`)
        .join("|"),
    };
  });
}

/**
 * What was still open on the day of the switch, as live Deskzo documents (owner, 26 Oct 2026: a Zoho sales order is
 * a Deskzo proforma): quotes as proposals, sales orders as proformas, purchase orders as vendor POs. What Zoho shows
 * finished — invoiced, billed, declined, expired, closed, void — stays behind; a line only part invoiced or billed
 * comes for what is left of it, and then the document's total can't be Zoho's, so it isn't checked against it.
 */
type OpenSpec = {
  id: string;
  number: string;
  date: string;
  status: string;
  party: string;
  partyId?: string;
  /** The quantity a line still has open, from Zoho's ordered, invoiced (or billed) and cancelled figures. */
  quantity: (row: Row) => number;
  finished: RegExp;
  validUntil?: string;
  due?: string;
};
const OPEN: Record<"quotes" | "sales-orders" | "purchase-orders", OpenSpec> = {
  quotes: { id: "Quote ID", number: "Quote Number", date: "Quote Date", status: "Quote Status", party: "Customer Name", partyId: "Customer ID", quantity: (r) => quantityOf(r, "Quantity"), finished: /^(invoiced|declined|expired|void|rejected)$/i, validUntil: "Expiry Date" },
  "sales-orders": {
    id: "SalesOrder ID",
    number: "SalesOrder Number",
    date: "Order Date",
    status: "Status",
    party: "Customer Name",
    partyId: "Customer ID",
    quantity: (r) => num(text(r, "QuantityOrdered")) - num(text(r, "QuantityInvoiced")) - num(text(r, "QuantityCancelled")),
    finished: /^(invoiced|closed|void|cancelled|declined|fulfilled)$/i,
    due: "Expected Shipment Date",
  },
  "purchase-orders": {
    id: "Purchase Order ID",
    number: "Purchase Order Number",
    date: "Purchase Order Date",
    status: "Purchase Order Status",
    party: "Vendor Name",
    quantity: (r) => num(text(r, "QuantityOrdered")) - num(text(r, "QuantityBilled")) - num(text(r, "QuantityCancelled")),
    finished: /^(billed|closed|cancelled|void)$/i,
    due: "Expected Arrival Date",
  },
};

function openDocuments(rows: Row[], spec: OpenSpec): Row[] {
  return byId(rows, spec.id, spec.number).flatMap((group) => {
    const head = group[0]!;
    const status = text(head, spec.status).replace(/\s+/g, "_");
    if (spec.finished.test(status)) return [];
    const open = group.map((row) => ({ row, left: round(spec.quantity(row), 4) })).filter((l) => l.left > 0);
    if (open.length === 0) return [];
    // Part invoiced or billed: Zoho's total isn't this one's. A line of none ordered was never open, so doesn't make it so.
    const ordered = (row: Row) => quantityOf(row, "QuantityOrdered", "Quantity");
    const partial = open.length < group.filter((row) => ordered(row) > 0).length || open.some((l) => l.left !== ordered(l.row));
    const priced = linesOf(
      open.map((l) => ({ ...l.row, Quantity: String(l.left) })),
      { rate: ["Item Price", "Rate"], tax: ["Item Tax %", "Tax Percentage"] },
    );
    return priced.map(({ row, quantity, rate, discount, tax }) => ({
      [C.number]: text(head, spec.number),
      [C.date]: dayOf(text(head, spec.date)),
      [C.party]: text(head, spec.party),
      [X.partyId]: spec.partyId ? text(head, spec.partyId) : "",
      // Deskzo's words for where it stands: a draft stays one, an accepted quote is accepted, the rest are issued.
      [C.status]: /draft/i.test(status) ? "Draft" : /accept/i.test(status) ? "Accepted" : "Sent",
      ...(spec.validUntil ? { [C.validUntil]: dayOf(text(head, spec.validUntil)) } : {}),
      [C.due]: spec.due ? dayOf(text(head, spec.due)) : "",
      [C.placeOfSupply]: zohoStateCode(text(head, "Place of Supply(With State Code)", "Place of Supply", "Destination of Supply")),
      [C.gstin]: text(head, "GST Identification Number (GSTIN)"),
      [C.reference]: text(head, "Reference#", "PurchaseOrder", "Reference No"),
      [C.salesperson]: text(head, "Sales person"),
      [C.notes]: text(head, "Notes", "Delivery Instructions"),
      [C.terms]: text(head, "Terms & Conditions"),
      [C.item]: text(row, "Item Name", "SKU"),
      [X.itemId]: text(row, "Product ID"),
      [C.description]: text(row, "Item Desc"),
      [C.hsn]: text(row, "HSN/SAC"),
      [C.quantity]: String(quantity),
      [C.unit]: text(row, "Usage unit"),
      [C.rate]: String(rate),
      [C.tax]: String(tax),
      [X.discountAmount]: amount(discount),
      [C.total]: partial ? "" : text(head, "Total"),
      [X.shipping]: partial ? "" : amount(num(text(head, "Shipping Charge"))),
      [X.shippingTax]: partial ? "" : text(head, "Shipping Charge Tax %"),
      [X.adjustment]: partial ? "" : amount(num(text(head, "Adjustment"))),
      [X.currency]: text(head, "Currency Code"),
      [X.exchangeRate]: text(head, "Exchange Rate"),
    }));
  });
}

/** A Zoho file's rows as the step's own columns. */
export function fromZoho(step: StepKey, rows: Row[], applications: CreditApplications = new Map()): Row[] {
  switch (step) {
    case "invoices":
      return salesDocument(rows, "INVOICE");
    case "credit-notes":
      return withApplications(salesDocument(rows, "CREDIT_NOTE"), applications);
    case "receipts":
      return payments(rows, "RECEIVED");
    case "vendor-payments":
      return payments(rows, "PAID");
    case "bills":
      return bills(rows);
    case "vendor-credits":
      return vendorCredits(rows);
    case "expenses":
      return expenses(rows);
    case "journals":
      return journals(rows);
    case "quotes":
    case "sales-orders":
    case "purchase-orders":
      return openDocuments(rows, OPEN[step]);
  }
}
