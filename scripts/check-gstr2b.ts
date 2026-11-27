/**
 * check:gstr2b — GSTR-2B against the bills (owner, 29 Oct 2026; src/lib/ledger/gstr2b.ts): the portal's JSON read,
 * invoice numbers matched however they're written, and each kind of difference told apart. Pure — no database.
 */
import { parseGstr2b, reconcileGstr2b, sameNumberKey, type BookBill } from "../src/lib/ledger/gstr2b";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

const A = "27AAAAA0000A1Z5";
const B = "29BBBBB0000B1Z5";
const C = "27CCCCC0000C1Z5";
const inv = (inum: string, dt: string, txval: number, tax: number, extra: Record<string, unknown> = {}) => ({ inum, dt, val: txval + tax, pos: "27", rev: "N", itcavl: "Y", txval, igst: 0, cgst: tax / 2, sgst: tax / 2, cess: 0, ...extra });
const json = JSON.stringify({
  data: {
    gstin: "27ZZZZZ0000Z1Z5",
    rtnprd: "102026",
    docdata: {
      b2b: [
        { ctin: A, trdnm: "Zz Alpha", inv: [inv("INV/26-27/007", "05-10-2026", 1000, 180), inv("A-2", "06-10-2026", 500, 90), inv("A-3", "07-10-2026", 300, 54, { itcavl: "N" })] },
        { ctin: B, trdnm: "Zz Beta", inv: [inv("B100", "08-10-2026", 2000, 360)] },
        { ctin: C, trdnm: "Zz Gamma", inv: [inv("G-9", "28-09-2026", 400, 72)] },
      ],
      cdnr: [{ ctin: A, trdnm: "Zz Alpha", nt: [{ ntnum: "CN-1", dt: "10-10-2026", typ: "C", val: 118, txval: 100, igst: 0, cgst: 9, sgst: 9, itcavl: "Y", rev: "N" }] }],
    },
  },
});

section("Reading the file");
const file = parseGstr2b(String.fromCharCode(0xfeff) + json);
ok("GSTIN and period, a BOM ignored", file.gstin === "27ZZZZZ0000Z1Z5" && file.period === "102026");
ok("five invoices and a credit note", file.rows.filter((r) => r.kind === "INVOICE").length === 5 && file.rows.filter((r) => r.kind === "CREDIT_NOTE").length === 1);
ok("days as 2026-10-05, ITC available N read", file.rows[0]!.date === "2026-10-05" && file.rows[2]!.itcAvailable === false);
let refused = "";
try {
  parseGstr2b("PK not json");
} catch (e) {
  refused = (e as Error).message;
}
ok("an Excel or other file is refused with what to do", /as JSON/.test(refused), refused);
try {
  parseGstr2b(JSON.stringify({ hello: 1 }));
  refused = "";
} catch (e) {
  refused = (e as Error).message;
}
ok("  JSON that isn't a 2B too", /isn't a GSTR-2B/.test(refused), refused);

section("Invoice numbers");
ok("INV/26-27/007 is INV-26-27-7 is inv 26/27/0007", new Set([sameNumberKey("INV/26-27/007"), sameNumberKey("INV-26-27-7"), sameNumberKey("inv 26/27/0007")]).size === 1);
ok("  but INV-17 isn't INV-7", sameNumberKey("INV-17") !== sameNumberKey("INV-7"));

section("Matching");
const bill = (p: Partial<BookBill> & { id: string; reference: string | null; vendorGstin: string | null; taxableValue: number; tax: number; date?: string }): BookBill => ({
  docNumber: `BILL/${p.id}`,
  vendorName: "Zz vendor",
  date: p.date ?? "2026-10-05",
  igst: 0,
  cgst: p.tax / 2,
  sgst: p.tax / 2,
  ...p,
});
const bills = [
  bill({ id: "1", reference: "INV-26-27-7", vendorGstin: A, taxableValue: 1000.4, tax: 180, date: "2026-10-04" }), // matched, within a rupee, date differs
  bill({ id: "2", reference: "A2", vendorGstin: A, taxableValue: 500, tax: 45 }), // amounts differ
  bill({ id: "3", reference: "B-100", vendorGstin: null, taxableValue: 2000, tax: 360 }), // GSTIN missing on the bill
  bill({ id: "4", reference: "X-1", vendorGstin: A, taxableValue: 800, tax: 144 }), // not in 2B
  bill({ id: "5", reference: "OLD-1", vendorGstin: A, taxableValue: 100, tax: 18, date: "2026-08-01" }), // older, unmatched — not reported
  bill({ id: "6", reference: "G9", vendorGstin: C, taxableValue: 400, tax: 72, date: "2026-09-28" }), // September bill, filed late in October's 2B
];
const rows = reconcileGstr2b(file.rows, bills, (b) => b.date >= "2026-10-01");
const of = (id: string) => rows.find((r) => r.bill?.id === id);
ok("same GSTIN and number, amounts within a rupee: matched, the date difference noted", of("1")?.status === "MATCHED" && /2026-10-04/.test(of("1")?.note ?? ""), of("1"));
ok("same number, tax 90 against 45: amounts differ", of("2")?.status === "AMOUNT_DIFFERS", of("2"));
ok("same number and amounts, no GSTIN on the bill: GSTIN differs", of("3")?.status === "GSTIN_DIFFERS", of("3"));
ok("a bill of the month the vendor didn't report: missing in 2B", of("4")?.status === "NOT_IN_2B", of("4"));
ok("  an older unmatched bill isn't listed", !of("5"));
ok("a September bill in October's 2B: matched", of("6")?.status === "MATCHED", of("6"));
const missing = rows.filter((r) => r.status === "NOT_IN_DESKZO");
ok("A-3 is missing in Deskzo, its credit not available", missing.length === 1 && missing[0]!.twoB?.number === "A-3" && /isn't available/.test(missing[0]!.note ?? ""), missing);
ok("notes left out of matching", rows.every((r) => r.twoB?.kind !== "CREDIT_NOTE"));

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
