/**
 * GSTR-2B reconciliation (owner, 29 Oct 2026): the statement of input credit the GST portal makes each month from what
 * vendors filed, matched against the bills in Deskzo — so credit claimed on a bill a vendor never reported, and a
 * vendor's invoice nobody entered, both show before GSTR-3B is filed.
 *
 * The file is the portal's GSTR-2B JSON download (Returns › GSTR-2B › Download › JSON). Its B2B invoices are matched
 * to bills by the vendor's GSTIN and the vendor's invoice number — the bill's reference, else its own number — read
 * the way people write them differently ("INV/26-27/007" is "INV-26-27-7"); amounts agree within a rupee. Its credit
 * and debit notes are listed as they are. Nothing is stored: the same file gives the same answer.
 *
 * Pure: the action and check:gstr2b read the same rules.
 */

export type TwoBRow = {
  kind: "INVOICE" | "CREDIT_NOTE" | "DEBIT_NOTE";
  supplierGstin: string;
  supplierName: string;
  number: string;
  /** "2026-10-07". */
  date: string;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
  total: number;
  /** The portal's "ITC available": N for credit the law holds back (a time limit, place of supply). */
  itcAvailable: boolean;
  reverseCharge: boolean;
};

export type TwoBFile = { gstin: string; period: string; rows: TwoBRow[] };

const num = (v: unknown) => {
  const n = Number(v);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
};
/** "07-10-2026" → "2026-10-07"; anything else as it came. */
const isoDay = (v: unknown) => {
  const m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(String(v ?? "").trim());
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(v ?? "");
};

/** Reads the portal's GSTR-2B JSON. Throws a sentence a person can act on when it isn't one. */
export function parseGstr2b(text: string): TwoBFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
  } catch {
    throw new Error("That file isn't JSON. Download GSTR-2B from the portal as JSON (not Excel) and upload that.");
  }
  const root = raw as { data?: Record<string, unknown> } & Record<string, unknown>;
  const data = (root.data ?? root) as { gstin?: string; rtnprd?: string; docdata?: Record<string, unknown> };
  if (!data.docdata || typeof data.docdata !== "object") throw new Error("That JSON isn't a GSTR-2B — it has no documents (docdata) in it.");
  const rows: TwoBRow[] = [];
  const heads = (o: Record<string, unknown>) => ({ taxableValue: num(o.txval), igst: num(o.igst), cgst: num(o.cgst), sgst: num(o.sgst), total: num(o.val) });
  for (const s of (data.docdata.b2b as Record<string, unknown>[] | undefined) ?? []) {
    for (const inv of (s.inv as Record<string, unknown>[] | undefined) ?? []) {
      rows.push({ kind: "INVOICE", supplierGstin: String(s.ctin ?? "").toUpperCase(), supplierName: String(s.trdnm ?? ""), number: String(inv.inum ?? ""), date: isoDay(inv.dt), ...heads(inv), itcAvailable: inv.itcavl !== "N", reverseCharge: inv.rev === "Y" });
    }
  }
  for (const s of (data.docdata.cdnr as Record<string, unknown>[] | undefined) ?? []) {
    for (const nt of (s.nt as Record<string, unknown>[] | undefined) ?? []) {
      rows.push({ kind: nt.typ === "D" ? "DEBIT_NOTE" : "CREDIT_NOTE", supplierGstin: String(s.ctin ?? "").toUpperCase(), supplierName: String(s.trdnm ?? ""), number: String(nt.ntnum ?? ""), date: isoDay(nt.dt), ...heads(nt), itcAvailable: nt.itcavl !== "N", reverseCharge: nt.rev === "Y" });
    }
  }
  return { gstin: String(data.gstin ?? "").toUpperCase(), period: String(data.rtnprd ?? ""), rows };
}

/**
 * An invoice number as people mean it: letters and numbers only, upper case, each run of digits without its leading
 * zeros — "inv/26-27/007", "INV-26-27-7" and "INV 26/27/0007" are one number.
 */
export function sameNumberKey(n: string): string {
  return n
    .toUpperCase()
    .split(/[^A-Z0-9]+/)
    .filter(Boolean)
    .map((t) => t.replace(/\d+/g, (d) => String(Number(d))))
    .join("");
}

/** A bill in Deskzo, as matching needs it. */
export type BookBill = {
  id: string;
  docNumber: string;
  /** The vendor's own invoice number, as typed on the bill. */
  reference: string | null;
  vendorGstin: string | null;
  vendorName: string;
  date: string;
  taxableValue: number;
  igst: number;
  cgst: number;
  sgst: number;
};

export type MatchStatus = "MATCHED" | "AMOUNT_DIFFERS" | "GSTIN_DIFFERS" | "NOT_IN_DESKZO" | "NOT_IN_2B";

export type MatchRow = { status: MatchStatus; twoB: TwoBRow | null; bill: BookBill | null; note: string | null };

/** Within a rupee: what rounding on two systems can leave. */
const TOLERANCE = 1;
const tax = (x: { igst: number; cgst: number; sgst: number }) => x.igst + x.cgst + x.sgst;
const agree = (a: TwoBRow, b: BookBill) => Math.abs(a.taxableValue - b.taxableValue) <= TOLERANCE && Math.abs(tax(a) - tax(b)) <= TOLERANCE;
const keysOf = (b: BookBill) => [...new Set([b.reference, b.docNumber].filter((x): x is string => !!x).map(sameNumberKey))];
const money = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/**
 * Each 2B invoice against the bills: matched, amounts differing, or under another GSTIN; what's left on either side is
 * missing from the other. `inPeriod` says which bills were the 2B month's — only those can be "not in 2B"; older ones
 * are there to match a vendor's late filing.
 */
export function reconcileGstr2b(rows: TwoBRow[], bills: BookBill[], inPeriod: (b: BookBill) => boolean): MatchRow[] {
  const out: MatchRow[] = [];
  const used = new Set<string>();
  const byKey = new Map<string, BookBill[]>();
  for (const b of bills) for (const k of keysOf(b)) byKey.set(k, [...(byKey.get(k) ?? []), b]);
  const invoices = rows.filter((r) => r.kind === "INVOICE");
  const pending: TwoBRow[] = [];

  // Same GSTIN, same number: matched, or the amounts differ.
  for (const r of invoices) {
    const candidates = (byKey.get(sameNumberKey(r.number)) ?? []).filter((b) => !used.has(b.id) && (b.vendorGstin ?? "").toUpperCase() === r.supplierGstin);
    const bill = candidates.find((b) => agree(r, b)) ?? candidates[0];
    if (!bill) {
      pending.push(r);
      continue;
    }
    used.add(bill.id);
    if (agree(r, bill)) {
      out.push({ status: "MATCHED", twoB: r, bill, note: r.date !== bill.date ? `Dated ${r.date} in 2B, ${bill.date} on the bill.` : null });
    } else {
      out.push({ status: "AMOUNT_DIFFERS", twoB: r, bill, note: `2B: taxable ${money(r.taxableValue)}, tax ${money(tax(r))}. Bill: taxable ${money(bill.taxableValue)}, tax ${money(tax(bill))}.` });
    }
  }

  // Same number and amounts under another GSTIN — a bill entered against the vendor's other registration, or none.
  for (const r of pending) {
    const bill = (byKey.get(sameNumberKey(r.number)) ?? []).find((b) => !used.has(b.id) && agree(r, b));
    if (bill) {
      used.add(bill.id);
      out.push({ status: "GSTIN_DIFFERS", twoB: r, bill, note: `The vendor filed it under ${r.supplierGstin}; the bill has ${bill.vendorGstin || "no GSTIN"}.` });
    } else {
      out.push({ status: "NOT_IN_DESKZO", twoB: r, bill: null, note: r.itcAvailable ? null : "2B says this credit isn't available." });
    }
  }

  for (const b of bills) if (!used.has(b.id) && inPeriod(b) && tax(b) > 0) out.push({ status: "NOT_IN_2B", twoB: null, bill: b, note: "The vendor hasn't reported it — the credit on it isn't in 2B yet." });
  return out;
}

export const MATCH_LABELS: Record<MatchStatus, string> = {
  MATCHED: "Matched",
  AMOUNT_DIFFERS: "Amounts differ",
  GSTIN_DIFFERS: "GSTIN differs",
  NOT_IN_DESKZO: "Missing in Deskzo",
  NOT_IN_2B: "Missing in 2B",
};
