/**
 * check:gstn-json — GSTR-1 and GSTR-3B as the GST portal's JSON (owner, 29 Oct 2026; src/lib/ledger/gstn-json.ts):
 * each supply in its table (B2B, B2CL, B2CS, exports, notes), the HSN tabs, Table 13's series with the cancelled
 * counted, and 3B's heads. Pure — no database.
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the portal's JSON, read as loosely as the portal writes it */
import { buildGstr3b, type ReturnDocument } from "../src/lib/ledger/gst-returns";
import { B2CL_LIMIT, gstr1Json, gstr3bJson, returnPeriod } from "../src/lib/ledger/gstn-json";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

const ours = { gstin: "27ZZZZZ0000Z1Z5", stateCode: "27" };
// Noon IST, so the day is the same in both clocks; one at 00:30 IST checks the portal's day is India's.
const on = (d: number, h = 6, m = 30) => new Date(Date.UTC(2026, 9, d, h, m));

/** A document of one line at `rate`, intra-state (CGST+SGST) unless `inter`. */
function doc(p: Partial<ReturnDocument> & { docNumber: string; value: number; rate?: number; inter?: boolean; hsn?: string }): ReturnDocument {
  const rate = p.rate ?? 18;
  const tax = Math.round(p.value * rate) / 100;
  const igst = p.inter ? tax : 0;
  const half = p.inter ? 0 : tax / 2;
  return {
    docType: "INVOICE",
    issueDate: on(10),
    status: "ISSUED",
    partyName: "Zz party",
    partyGstin: null,
    placeOfSupplyCode: p.inter ? "29" : "27",
    taxableValue: p.value,
    cgstAmount: half,
    sgstAmount: half,
    igstAmount: igst,
    total: p.value + tax,
    lines: [{ hsnCode: p.hsn ?? "8471", name: "Zz item", unit: "NOS", quantity: 1, taxableValue: p.value, taxRatePercent: rate, cgstAmount: half, sgstAmount: half, igstAmount: igst }],
    ...p,
  } as ReturnDocument;
}

section("Return period and day");
ok("October 2026 is 102026", returnPeriod(10, 2026) === "102026");

const docs: ReturnDocument[] = [
  doc({ docNumber: "INV/26-27/0001", value: 1000, partyGstin: "29AAAAA0000A1Z5", inter: true, issueDate: on(1, 19, 0) /* 00:30 IST on the 2nd */ }),
  doc({ docNumber: "INV/26-27/0002", value: 500, partyGstin: "29AAAAA0000A1Z5", inter: true, reverseCharge: true }),
  doc({ docNumber: "INV/26-27/0003", value: 200_000, inter: true }), // unregistered, inter-state, over ₹1 lakh → B2CL
  doc({ docNumber: "INV/26-27/0004", value: 300 }), // unregistered intra → B2CS
  doc({ docNumber: "INV/26-27/0005", value: 700, rate: 0, gstTreatment: "OVERSEAS", placeOfSupplyCode: "96" }), // export without tax
  doc({ docNumber: "INV/26-27/0006", value: 400, gstTreatment: "SEZ", partyGstin: "27BBBBB0000B1Z5", inter: true }),
  doc({ docNumber: "INV/26-27/0007", value: 999, status: "CANCELLED" }),
  doc({ docNumber: "INV/26-27/0008", value: 50, status: "DRAFT" }),
  doc({ docNumber: "CN/26-27/0001", docType: "CREDIT_NOTE", value: 100, partyGstin: "29AAAAA0000A1Z5", inter: true }),
  doc({ docNumber: "CN/26-27/0002", docType: "CREDIT_NOTE", value: 100 }), // unregistered small → nets in B2CS
];
const file = gstr1Json(docs, ours, 10, 2026) as Record<string, any>;

section("GSTR-1 tables");
ok("gstin and fp", file.gstin === ours.gstin && file.fp === "102026");
const b2bA = file.b2b?.find((x: any) => x.ctin === "29AAAAA0000A1Z5");
ok("B2B groups by buyer", b2bA?.inv?.length === 2, b2bA);
ok("the portal's day is India's (00:30 IST on 2 Oct)", b2bA?.inv?.[0]?.idt === "02-10-2026", b2bA?.inv?.[0]?.idt);
ok("reverse charge flagged Y", b2bA?.inv?.[1]?.rchrg === "Y" && b2bA?.inv?.[0]?.rchrg === "N");
ok("items by rate, num = rate×100+1, IGST", JSON.stringify(b2bA?.inv?.[0]?.itms) === JSON.stringify([{ num: 1801, itm_det: { txval: 1000, rt: 18, iamt: 180, camt: 0, samt: 0, csamt: 0 } }]), b2bA?.inv?.[0]?.itms);
ok("place of supply two digits", b2bA?.inv?.[0]?.pos === "29");
const sez = file.b2b?.find((x: any) => x.ctin === "27BBBBB0000B1Z5");
ok("SEZ with tax is SEWP", sez?.inv?.[0]?.inv_typ === "SEWP", sez);
ok("B2CL: the big inter-state unregistered invoice, by state", file.b2cl?.length === 1 && file.b2cl[0].pos === "29" && file.b2cl[0].inv[0].inum === "INV/26-27/0003", file.b2cl);
ok("B2CL only over ₹1,00,000", B2CL_LIMIT === 100_000);
const b2cs = file.b2cs ?? [];
ok("B2CS: intra 18% with the small credit note netted (300 − 100)", b2cs.length === 1 && b2cs[0].txval === 200 && b2cs[0].sply_ty === "INTRA" && b2cs[0].typ === "OE" && b2cs[0].camt === 18, b2cs);
ok("export without tax is WOPAY", file.exp?.[0]?.exp_typ === "WOPAY" && file.exp[0].inv[0].inum === "INV/26-27/0005", file.exp);
ok("credit note to a registered buyer in CDNR, ntty C", file.cdnr?.[0]?.ctin === "29AAAAA0000A1Z5" && file.cdnr[0].nt[0].ntty === "C" && file.cdnr[0].nt[0].nt_num === "CN/26-27/0001", file.cdnr);
ok("no CDNUR when no note qualifies", file.cdnur === undefined);
const allInums = JSON.stringify(file);
ok("cancelled and draft documents left out of the tables", !/"inum":"INV\/26-27\/000[78]"/.test(allInums));
ok("HSN tabs present", Array.isArray(file.hsn?.hsn_b2b) && Array.isArray(file.hsn?.hsn_b2c) && file.hsn.hsn_b2b.length > 0, file.hsn);

section("Table 13");
const invSeries = file.doc_issue?.doc_det?.find((x: any) => x.doc_num === 1)?.docs?.[0];
ok("invoices 0001–0007, 7 issued, 1 cancelled, draft not counted", invSeries?.from === "INV/26-27/0001" && invSeries?.to === "INV/26-27/0007" && invSeries?.totnum === 7 && invSeries?.cancel === 1 && invSeries?.net_issue === 6, invSeries);
const cnSeries = file.doc_issue?.doc_det?.find((x: any) => x.doc_num === 5)?.docs?.[0];
ok("credit notes are doc type 5", cnSeries?.totnum === 2, cnSeries);

section("GSTR-3B");
const bill = doc({ docNumber: "B-1", docType: "BILL", value: 1000, partyGstin: "27CCCCC0000C1Z5" });
const rcmBill = doc({ docNumber: "B-2", docType: "BILL", value: 200, reverseCharge: true, partyGstin: "27DDDDD0000D1Z5" });
const outward = docs;
const inward = [bill, rcmBill];
const g = buildGstr3b({ outwardDocs: outward, inwardDocs: inward });
const three = gstr3bJson(g, outward, inward, ours, 10, 2026) as Record<string, any>;
ok("ret_period", three.ret_period === "102026" && three.gstin === ours.gstin);
// Taxed domestic: 1000 + 500 + 200000 + 300 − 100 (CN to B2B) − 100 (CN small) = 201600; SEZ and export are zero-rated.
ok("3.1(a) taxable outward excludes zero-rated, nets credit notes", three.sup_details.osup_det.txval === 201600, three.sup_details.osup_det);
ok("3.1(b) zero-rated: export 700 + SEZ 400", three.sup_details.osup_zero.txval === 1100 && three.sup_details.osup_zero.iamt === 72, three.sup_details.osup_zero);
ok("3.1(d) inward on reverse charge", three.sup_details.isup_rev.txval === 200, three.sup_details.isup_rev);
ok("3.2 inter-state to unregistered by state", JSON.stringify(three.inter_sup.unreg_details) === JSON.stringify([{ pos: "29", txval: 200000, iamt: 36000 }]), three.inter_sup.unreg_details);
const oth = three.itc_elg.itc_avl.find((x: any) => x.ty === "OTH");
// Security audit round three (R3-10): reverse-charge credit is its own row (ISRC); ISRC + OTH is the return's input credit.
const isrc = three.itc_elg.itc_avl.find((x: any) => x.ty === "ISRC");
ok("4(A)(3) reverse-charge credit under ISRC", isrc.camt === g.reverseCharge.cgst && isrc.samt === g.reverseCharge.sgst && isrc.camt > 0, { isrc, rc: g.reverseCharge });
ok("4(A)(5) all other ITC is the rest of the return's input credit", oth.camt + isrc.camt === g.inward.cgst && oth.samt + isrc.samt === g.inward.sgst && JSON.stringify(three.itc_elg.itc_net) === JSON.stringify({ iamt: g.inward.igst, camt: g.inward.cgst, samt: g.inward.sgst, csamt: 0 }), { oth, inward: g.inward });

console.log(failures ? `\n${failures} failing` : "\nall passing");
process.exit(failures ? 1 : 0);
