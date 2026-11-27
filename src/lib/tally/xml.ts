/**
 * Tally XML (owner, 25 Oct 2026 plan; built 23 Nov 2026 — src/lib/tally): the files TallyPrime imports with Alt+O ›
 * Import › Masters, then Transactions. Pure: amounts, dates and names in, text out — src/lib/tally/build.ts decides
 * what goes in them.
 *
 *   · An envelope addressed to the company by its exact name (`SVCURRENTCOMPANY`).
 *   · Masters: a party ledger under Sundry Debtors with its GSTIN, state and address, bill-wise on; a unit; a stock item
 *     with its HSN. Only ones Tally hasn't got — nothing the accountant set up is overwritten (ACTION "Create").
 *   · Vouchers: each Deskzo record as the voucher an accountant would have typed, on its own date with its own number.
 *     Tally's sign: a debit is a negative AMOUNT with ISDEEMEDPOSITIVE Yes; a credit is positive with No.
 */

export type BillRef = { name: string; type: "New Ref" | "Agst Ref" | "On Account" | "Advance"; amount: number };

/** One ledger line: `amount` is Tally's — credit positive, debit negative. */
export type LedgerLine = { ledger: string; amount: number; party?: boolean; bills?: BillRef[] };

/** One item line of an item invoice, and the ledger its value goes to. `amount` signed as the ledger line would be. */
export type InventoryLine = { item: string; unit: string; quantity: number; rate: number; amount: number; ledger: string };

export type Voucher = {
  /** Sales, Credit Note, Debit Note or Receipt. */
  type: string;
  number: string;
  /** YYYY-MM-DD. */
  date: string;
  party: string;
  narration?: string;
  reference?: string;
  /** e-invoice details, kept on the voucher for GSTR-1. */
  irn?: string | null;
  ackNo?: string | null;
  ackDate?: string | null;
  ewayBill?: string | null;
  ledgers: LedgerLine[];
  inventory?: InventoryLine[];
};

export type PartyMaster = { name: string; group: "Sundry Debtors" | "Sundry Creditors"; gstin?: string | null; state?: string | null; address?: string[]; pincode?: string | null; country?: string | null };
export type ItemMaster = { name: string; unit: string; hsn?: string | null };

export const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");

/** Rupees to the paisa, as Tally writes them. */
export const money = (n: number) => (Math.round(n * 100) / 100).toFixed(2);

/** 2026-11-05 → 20261105. */
export const tallyDate = (ymd: string) => ymd.replace(/-/g, "");

const tag = (name: string, value: string | number | null | undefined) => (value === null || value === undefined || value === "" ? "" : `<${name}>${esc(String(value))}</${name}>`);

function envelope(company: string, report: "All Masters" | "Vouchers", messages: string[]): string {
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<ENVELOPE>`,
    `<HEADER><TALLYREQUEST>Import Data</TALLYREQUEST></HEADER>`,
    `<BODY><IMPORTDATA>`,
    `<REQUESTDESC><REPORTNAME>${report}</REPORTNAME><STATICVARIABLES><SVCURRENTCOMPANY>${esc(company)}</SVCURRENTCOMPANY></STATICVARIABLES></REQUESTDESC>`,
    `<REQUESTDATA>`,
    ...messages.map((m) => `<TALLYMESSAGE xmlns:UDF="TallyUDF">${m}</TALLYMESSAGE>`),
    `</REQUESTDATA>`,
    `</IMPORTDATA></BODY>`,
    `</ENVELOPE>`,
    ``,
  ].join("\n");
}

// ─── Masters ──────────────────────────────────────────────────────────────────────────────────────────────────────

export function partyLedger(p: PartyMaster): string {
  const address = (p.address ?? []).filter(Boolean).slice(0, 4);
  return [
    `<LEDGER NAME="${esc(p.name)}" ACTION="Create">`,
    tag("NAME", p.name),
    tag("PARENT", p.group),
    `<ISBILLWISEON>Yes</ISBILLWISEON>`,
    address.length ? `<ADDRESS.LIST TYPE="String">${address.map((a) => tag("ADDRESS", a)).join("")}</ADDRESS.LIST>` : "",
    tag("LEDSTATENAME", p.state),
    tag("STATENAME", p.state),
    tag("PINCODE", p.pincode),
    tag("COUNTRYNAME", p.country || "India"),
    tag("COUNTRYOFRESIDENCE", p.country || "India"),
    p.gstin ? `<GSTREGISTRATIONTYPE>Regular</GSTREGISTRATIONTYPE>${tag("PARTYGSTIN", p.gstin)}` : `<GSTREGISTRATIONTYPE>Unregistered/Consumer</GSTREGISTRATIONTYPE>`,
    `</LEDGER>`,
  ].join("");
}

export const unitMaster = (unit: string) => `<UNIT NAME="${esc(unit)}" ACTION="Create">${tag("NAME", unit)}<ISSIMPLEUNIT>Yes</ISSIMPLEUNIT></UNIT>`;

export function stockItem(i: ItemMaster): string {
  return [
    `<STOCKITEM NAME="${esc(i.name)}" ACTION="Create">`,
    tag("NAME", i.name),
    tag("BASEUNITS", i.unit),
    `<GSTAPPLICABLE>&#4; Applicable</GSTAPPLICABLE>`,
    i.hsn ? `<GSTDETAILS.LIST><APPLICABLEFROM>20170701</APPLICABLEFROM>${tag("HSNCODE", i.hsn)}<TAXABILITY>Taxable</TAXABILITY></GSTDETAILS.LIST>` : "",
    `</STOCKITEM>`,
  ].join("");
}

export function mastersFile(company: string, m: { parties: PartyMaster[]; units: string[]; items: ItemMaster[] }): string {
  return envelope(company, "All Masters", [...m.parties.map(partyLedger), ...m.units.map(unitMaster), ...m.items.map(stockItem)]);
}

// ─── Vouchers ─────────────────────────────────────────────────────────────────────────────────────────────────────

function ledgerEntry(l: LedgerLine, list: "LEDGERENTRIES.LIST" | "ACCOUNTINGALLOCATIONS.LIST" = "LEDGERENTRIES.LIST"): string {
  const debit = l.amount < 0;
  return [
    `<${list}>`,
    tag("LEDGERNAME", l.ledger),
    `<ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
    l.party ? `<ISPARTYLEDGER>Yes</ISPARTYLEDGER>` : "",
    `<AMOUNT>${money(l.amount)}</AMOUNT>`,
    ...(l.bills ?? []).map((b) => `<BILLALLOCATIONS.LIST>${tag("NAME", b.name)}${tag("BILLTYPE", b.type)}<AMOUNT>${money(b.amount)}</AMOUNT></BILLALLOCATIONS.LIST>`),
    `</${list}>`,
  ].join("");
}

function inventoryEntry(i: InventoryLine): string {
  const debit = i.amount < 0;
  const qty = `${Number(i.quantity.toFixed(3))} ${i.unit}`;
  return [
    `<ALLINVENTORYENTRIES.LIST>`,
    tag("STOCKITEMNAME", i.item),
    `<ISDEEMEDPOSITIVE>${debit ? "Yes" : "No"}</ISDEEMEDPOSITIVE>`,
    `<RATE>${money(i.rate)}/${esc(i.unit)}</RATE>`,
    `<AMOUNT>${money(i.amount)}</AMOUNT>`,
    `<ACTUALQTY>${esc(qty)}</ACTUALQTY>`,
    `<BILLEDQTY>${esc(qty)}</BILLEDQTY>`,
    ledgerEntry({ ledger: i.ledger, amount: i.amount }, "ACCOUNTINGALLOCATIONS.LIST"),
    `</ALLINVENTORYENTRIES.LIST>`,
  ].join("");
}

export function voucher(v: Voucher): string {
  const items = v.inventory?.length ? v.inventory : null;
  const view = items ? "Invoice Voucher View" : "Accounting Voucher View";
  return [
    `<VOUCHER VCHTYPE="${esc(v.type)}" ACTION="Create" OBJVIEW="${view}">`,
    tag("DATE", tallyDate(v.date)),
    tag("EFFECTIVEDATE", tallyDate(v.date)),
    tag("VOUCHERTYPENAME", v.type),
    tag("VOUCHERNUMBER", v.number),
    tag("REFERENCE", v.reference),
    tag("PARTYLEDGERNAME", v.party),
    tag("PARTYNAME", v.party),
    tag("NARRATION", v.narration),
    tag("PERSISTEDVIEW", view),
    `<ISINVOICE>${items ? "Yes" : "No"}</ISINVOICE>`,
    tag("IRN", v.irn),
    tag("IRNACKNO", v.ackNo),
    tag("IRNACKDATE", v.ackDate ? tallyDate(v.ackDate) : null),
    tag("EWAYBILLNO", v.ewayBill),
    ...(items ?? []).map(inventoryEntry),
    ...v.ledgers.map((l) => ledgerEntry(l)),
    `</VOUCHER>`,
  ].join("");
}

export function vouchersFile(company: string, vouchers: Voucher[]): string {
  return envelope(company, "Vouchers", vouchers.map(voucher));
}

/** A voucher's lines balance: everything in it, the item lines' ledgers included, comes to nothing. */
export function balances(v: Voucher): boolean {
  const total = v.ledgers.reduce((t, l) => t + l.amount, 0) + (v.inventory ?? []).reduce((t, i) => t + i.amount, 0);
  return Math.abs(total) < 0.005;
}
