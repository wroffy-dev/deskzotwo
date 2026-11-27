/**
 * check:uae-vat — the UAE country pack's VAT (owner, 31 Oct 2026; src/lib/vat, plan doc "Phase 1 build design"):
 *
 *   · the rules: line categories and their rates, the TRN, the emirates, the return's periods;
 *   · a document raised through the real action as a UAE workspace: each line's category kept, zero-rated, exempt
 *     and out-of-scope lines at 0%, the party's TRN checked, a reverse-charge bill's VAT not owed to the vendor;
 *   · the ledger: that bill's entry balances with VAT owed and recovered, a claim's VAT booked whole;
 *   · the VAT 201 from those documents, box by box, by the branch's emirate; the return page and the printed copy;
 *   · the same workspace read as India's: nothing above reaches it — no category written, GST as before.
 *
 * The local workspace read as the UAE's (as check:country-pack does), with its own zz rows, dated in a far quarter so
 * the return holds only them; removed at the end. Nothing is issued: the documents are marked issued in place, so no
 * number series moves and nothing posts.
 */
import "dotenv/config";
import Module from "node:module";
import { renderToStaticMarkup } from "react-dom/server";
import { db } from "../src/lib/db";
import { legacyTenant } from "../src/lib/tenancy/registry";
import { runAsTenant } from "../src/lib/tenancy/resolve";
import type { Tenant } from "../src/lib/tenancy/state";

const TAG = "ZZPROBE_VAT";
const DAY = "2031-02-10";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const originalLoad = internals._load;
let actorId = "";
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return { ...real, requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "next/navigation") {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {} }), usePathname: () => "/", useSearchParams: () => new URLSearchParams() };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;
  const home = await legacyTenant();
  if (!home) throw new Error("no workspace to act as");
  const uae: Tenant = { ...home, country: "AE" };
  const india: Tenant = { ...home, country: "IN" };

  section("The rules");
  const rules = await import("../src/lib/vat/rules");
  const s = (c: unknown, r: number) => JSON.stringify(rules.settleLineTax(c, r, 5));
  ok("standard at its rate, or the pack's when none was given", s("STANDARD", 5) === '{"category":"STANDARD","rate":5}' && s("STANDARD", 0) === '{"category":"STANDARD","rate":5}');
  ok("zero-rated, exempt, out of scope: always 0%", s("ZERO_RATED", 5) === '{"category":"ZERO_RATED","rate":0}' && s("EXEMPT", 5) === '{"category":"EXEMPT","rate":0}' && s("OUT_OF_SCOPE", 5) === '{"category":"OUT_OF_SCOPE","rate":0}');
  ok("no category: from the rate — above 0 standard, else zero-rated", s("", 5) === '{"category":"STANDARD","rate":5}' && s(undefined, 0) === '{"category":"ZERO_RATED","rate":0}');
  const trn = rules.readTrn("100 1234 5670 0003");
  ok("a TRN as typed: its 15 digits", trn.ok && trn.trn === "100123456700003" && !trn.warning, trn);
  const odd = rules.readTrn("200123456700003");
  ok("  one not starting 100: kept, with a warning", odd.ok && !!odd.warning);
  ok("  14 digits or letters: refused", !rules.readTrn("10012345670000").ok && !rules.readTrn("100ABC456700003").ok);
  ok("the emirates read however they're written", rules.emirateOf("dubai") === "Dubai" && rules.emirateOf("Ras al-Khaimah") === "Ras Al Khaimah" && rules.emirateOf("Abu Dhabi Emirate") === "Abu Dhabi" && rules.emirateOf("Maharashtra") === null);
  const ret = await import("../src/lib/vat/return");
  ok("a quarter and a month as calendar days", JSON.stringify(ret.vatPeriod("2031-Q1")) === JSON.stringify({ from: "2031-01-01", to: "2031-03-31", label: "Jan–Mar 2031" }) && ret.vatPeriod("2028-02")?.to === "2028-02-29" && ret.vatPeriod("2031-Q5") === null);

  // Box 6 (owner, 14 Nov 2026): goods bought from abroad on a reverse-charge bill, apart from imported services in box 3.
  const imports = ret.buildVatReturn([
    { id: "g", number: "BILL-G", direction: "PURCHASE", sign: 1, reverseCharge: true, fromAbroad: true, emirate: null, lines: [{ category: "STANDARD", rate: 5, taxable: 2000, vat: 100, goods: true }] },
    { id: "s", number: "BILL-S", direction: "PURCHASE", sign: 1, reverseCharge: true, fromAbroad: true, emirate: null, lines: [{ category: "STANDARD", rate: 5, taxable: 1000, vat: 50, goods: false }] },
    { id: "d", number: "BILL-D", direction: "PURCHASE", sign: 1, reverseCharge: true, fromAbroad: false, emirate: null, lines: [{ category: "STANDARD", rate: 5, taxable: 400, vat: 20, goods: true }] },
  ]);
  ok("box 6: goods from abroad on a reverse-charge bill", imports.box6.amount === 2000 && imports.box6.vat === 100, imports.box6);
  ok("  imported services stay in box 3, and goods bought at home on reverse charge too", imports.box3.amount === 1400 && imports.box3.vat === 70, imports.box3);
  ok("  all of it recovered in box 10, and owed in box 8", imports.box10.vat === 170 && imports.box8.vat === 170 && imports.box14 === 0, { b10: imports.box10, b8: imports.box8 });
  ok("  the CSV has its row", ret.vatReturnRows(imports).some((r) => r[0] === "6" && r[2] === "2000.00" && r[3] === "100.00"));

  // A simplified tax invoice (owner, 14 Nov 2026): only where the template asks and the FTA allows.
  const extras = await import("../src/lib/documents/print-extras");
  await runAsTenant(uae, async () => {
    const may = (buyerTrn: string | null, totalInAed: number, full: boolean) => extras.simplifiedAllowed({ docType: "INVOICE", buyerTrn, totalInAed }, full);
    ok("simplified: a buyer without a TRN, or AED 10,000 or less, when the template asks", may(null, 50_000, false) && may("100123456700003", 10_000, false));
    ok("  not a registered buyer over AED 10,000", !may("100123456700003", 10_000.01, false));
    ok("  never when the template keeps the full tax invoice (the default)", !may(null, 100, true));
    ok("  and it's called a Simplified Tax Invoice", extras.printedTitle({ docType: "INVOICE", gstTreatment: "UNREGISTERED", cgstAmount: 0, sgstAmount: 0, igstAmount: 5, lines: [{ taxRatePercent: 5 }] }, "Invoice", true).title === "Simplified Tax Invoice");
  });
  await runAsTenant(india, async () => {
    ok("  India never has one", !extras.simplifiedAllowed({ docType: "INVOICE", buyerTrn: null, totalInAed: 100 }, false));
  });

  section("Corporate Tax");
  // Owner, 14 Nov 2026 (src/lib/corporate-tax.ts): 0% to AED 375,000, 9% above; Small Business Relief to 2029.
  const ct = await import("../src/lib/corporate-tax");
  const none = ct.NO_ADJUSTMENTS;
  const ctPlain = ct.corporateTaxWorking({ revenue: 5_000_000, accountingProfit: 1_000_000, adjustments: none, periodEnd: "2026-12-31", electRelief: false });
  ok("AED 1,000,000 of profit: 375,000 at 0%, 625,000 at 9% — 56,250", ctPlain.zeroBand === 375_000 && ctPlain.taxedAt9 === 625_000 && ctPlain.tax === 56_250, ctPlain);
  ok("  above AED 3,000,000 of revenue, no relief, and says why", !ctPlain.relief.available && /3,000,000/.test(ctPlain.relief.why ?? ""));
  const adjusted = ct.corporateTaxWorking({ revenue: 5_000_000, accountingProfit: 400_000, adjustments: { ...none, entertainment: 20_000, finesAndPenalties: 5_000, exemptIncome: 15_000 }, periodEnd: "2026-12-31", electRelief: false });
  ok("half of entertainment and all fines added back; exempt income taken off", adjusted.addBacks === 15_000 && adjusted.deductions === 15_000 && adjusted.taxableIncome === 400_000 && adjusted.tax === 2_250, adjusted);
  const small = ct.corporateTaxWorking({ revenue: 2_000_000, accountingProfit: 600_000, adjustments: none, periodEnd: "2026-12-31", electRelief: true });
  ok("small business relief elected: taxable income treated as nil", small.relief.elected && small.tax === 0, small);
  ok("  not for a Qualifying Free Zone Person", !ct.corporateTaxWorking({ revenue: 2_000_000, accountingProfit: 600_000, adjustments: none, periodEnd: "2026-12-31", electRelief: true, excludedFromRelief: true }).relief.elected);
  ok("  nor for a period ending after 2029", !ct.corporateTaxWorking({ revenue: 2_000_000, accountingProfit: 600_000, adjustments: none, periodEnd: "2030-12-31", electRelief: true }).relief.available);
  const loss = ct.corporateTaxWorking({ revenue: 5_000_000, accountingProfit: -80_000, adjustments: none, periodEnd: "2026-12-31", electRelief: false });
  ok("a loss: no tax, carried forward", loss.tax === 0 && loss.loss === 80_000, loss);
  ok("due nine months after the period: 31 Dec 2026 → 30 Sep 2027", ct.corporateTaxDue("2026-12-31") === "2027-09-30", ct.corporateTaxDue("2026-12-31"));

  section("The ledger");
  const posting = await import("../src/lib/ledger/posting");
  const balanced = (d: { lines: { debit: number; credit: number }[] }) => Math.round(d.lines.reduce((t, l) => t + l.debit - l.credit, 0) * 100) === 0;
  const rcBill = posting.postVendorBill({ companyId: "x", docNumber: "B1", taxableValue: 1000, cgstAmount: 0, sgstAmount: 0, igstAmount: 50, shippingCharge: 0, withholdingAmount: 0, adjustment: 0, adjustmentLabel: null, roundOff: 0, total: 1000, taxSelfAssessed: true });
  const line = (key: string) => rcBill.lines.find((l) => l.account === key);
  ok("a reverse-charge bill: the vendor owed the net, VAT owed and recovered, balanced", line("AP")?.credit === 1000 && line("INPUT_IGST")?.debit === 50 && line("OUTPUT_IGST")?.credit === 50 && balanced(rcBill), rcBill.lines);
  const usd = posting.inRupees({ companyId: "x", docNumber: "B2", taxableValue: 100, cgstAmount: 0, sgstAmount: 0, igstAmount: 5, shippingCharge: 0, withholdingAmount: 0, adjustment: 0, adjustmentLabel: null, roundOff: 0, total: 100, taxSelfAssessed: true }, 3.6725);
  ok("  in dollars: converted with no round-off invented from the tax", usd.roundOff === 0 && usd.total === 367.25 && usd.igstAmount === 18.36, usd);
  const plain = posting.postVendorBill({ companyId: "x", docNumber: "B3", taxableValue: 1000, cgstAmount: 0, sgstAmount: 0, igstAmount: 50, shippingCharge: 0, withholdingAmount: 0, adjustment: 0, adjustmentLabel: null, roundOff: 0, total: 1050 });
  ok("an ordinary bill: as it always was", plain.lines.find((l) => l.account === "AP")?.credit === 1050 && !plain.lines.some((l) => l.account === "OUTPUT_IGST") && balanced(plain));
  const claim = (country: Tenant) =>
    runAsTenant(country, async () =>
      posting.postExpenseClaim({ amount: 105, taxAmount: 5, categoryAccount: "TRAVEL" as never, claimant: "Z", description: "Taxi", reference: "C1", companyPaid: false, fromCash: false }),
    );
  const uaeClaim = await claim(uae);
  const indiaClaim = await claim(india);
  ok("a UAE claim's VAT booked whole to Input VAT", uaeClaim.lines.find((l) => l.account === "INPUT_IGST")?.debit === 5 && !uaeClaim.lines.some((l) => l.account === "INPUT_CGST"), uaeClaim.lines);
  ok("  India's still split CGST and SGST", indiaClaim.lines.find((l) => l.account === "INPUT_CGST")?.debit === 2.5 && !indiaClaim.lines.some((l) => l.account === "INPUT_IGST"));

  const { createTradeDocument } = await import("../src/actions/trade-document");
  const created: { documents: string[]; companies: string[]; branches: string[] } = { documents: [], companies: [], branches: [] };
  try {
    const customer = await db.company.create({
      data: { name: `${TAG} Gulf Traders`, normalizedName: `${TAG.toLowerCase()} gulf traders`, createdById: actorId, ownerUserId: actorId, locations: { create: { label: "Head office", address: "Bay Square", city: "Dubai", state: "Dubai", country: "United Arab Emirates", gstNumber: "100987654300003", isPrimary: true } } },
      select: { id: true },
    });
    const vendor = await db.company.create({
      data: { name: `${TAG} Overseas Cloud`, normalizedName: `${TAG.toLowerCase()} overseas cloud`, createdById: actorId, relationshipType: "VENDOR", locations: { create: { label: "Head office", city: "Dublin", country: "Ireland", isPrimary: true } } },
      select: { id: true },
    });
    created.companies.push(customer.id, vendor.id);
    const branch = await db.branch.create({ data: { name: `${TAG} Dubai`, code: "ZZVAT", addressLine1: "Office 12, Bay Square", city: "Dubai", state: "Dubai", country: "United Arab Emirates", active: true }, select: { id: true } });
    const sharjah = await db.branch.create({ data: { name: `${TAG} Sharjah`, code: "ZZVAS", addressLine1: "Unit 4, SAIF Zone", city: "Sharjah", state: "Sharjah", country: "United Arab Emirates", active: true }, select: { id: true } });
    created.branches.push(branch.id, sharjah.id);
    const address = { attention: "", line1: "Bay Square", line2: "", city: "Dubai", state: "Dubai", stateCode: "", pincode: "", country: "United Arab Emirates", phone: "" };
    const doc = (extra: Record<string, unknown>) => ({ docType: "INVOICE", companyId: customer.id, branchId: branch.id, issueDate: DAY, billing: address, shipping: address, shippingSameAsBilling: true, gstTreatment: "UNREGISTERED", placeOfSupplyCode: "", ...extra });
    const line = (name: string, price: number, taxCategory: string, rate = 5) => ({ name: `${TAG} ${name}`, quantity: 1, unitPrice: price, discountValue: 0, taxRatePercent: rate, taxCategory });

    section("Documents, as a UAE workspace");
    await runAsTenant(uae, async () => {
      const bad = await createTradeDocument(doc({ buyerGstin: "12345", lines: [line("Licences", 1000, "STANDARD")] }));
      ok("a TRN that isn't 15 digits: refused", !bad.ok && /15 digits/.test(bad.ok ? "" : bad.error), bad);
      if (bad.ok) created.documents.push(bad.data.id);

      const sale = await createTradeDocument(
        doc({ lines: [line("Licences", 1000, "STANDARD"), line("Export support", 400, "ZERO_RATED", 5), line("Residential rent", 300, "EXEMPT"), line("Government fee", 50, "OUT_OF_SCOPE")] }),
      );
      ok("an invoice with every category is raised", sale.ok, sale);
      if (!sale.ok) return;
      created.documents.push(sale.data.id);
      const lines = await db.tradeDocumentLine.findMany({ where: { documentId: sale.data.id }, orderBy: { sortOrder: "asc" }, select: { taxCategory: true, taxRatePercent: true, igstAmount: true } });
      ok("  each line's category kept, the non-standard ones at 0% whatever was sent", lines.map((l) => `${l.taxCategory}:${Number(l.taxRatePercent)}:${Number(l.igstAmount)}`).join(" ") === "STANDARD:5:50 ZERO_RATED:0:0 EXEMPT:0:0 OUT_OF_SCOPE:0:0", lines);
      const stored = await db.tradeDocument.findUniqueOrThrow({ where: { id: sale.data.id }, select: { total: true, buyerGstin: true, sellerGstin: true } });
      ok("  total 1,800: VAT on the standard line only; the customer's TRN from their address", Number(stored.total) === 1800 && stored.buyerGstin === "100987654300003", stored);

      // A credit note names the invoice it reduces, which has to have been issued.
      await db.tradeDocument.update({ where: { id: sale.data.id }, data: { status: "ISSUED" } });
      const credit = await createTradeDocument(doc({ docType: "CREDIT_NOTE", againstDocumentId: sale.data.id, lines: [line("Licences returned", 200, "STANDARD")] }));
      const shjSale = await createTradeDocument(doc({ branchId: sharjah.id, lines: [line("Licences", 2000, "STANDARD")] }));
      const rcBill = await createTradeDocument(
        doc({ docType: "BILL", companyId: vendor.id, reverseCharge: true, billing: { ...address, city: "Dublin", state: "", country: "Ireland" }, lines: [line("Cloud hosting", 1000, "STANDARD")] }),
      );
      const bill = await createTradeDocument(doc({ docType: "BILL", companyId: vendor.id, billing: { ...address, city: "Dublin", state: "", country: "Ireland" }, lines: [line("Office supplies", 600, "STANDARD")] }));
      for (const r of [credit, shjSale, rcBill, bill]) if (r.ok) created.documents.push(r.data.id);
      ok("a credit note, a Sharjah sale and two bills are raised", credit.ok && shjSale.ok && rcBill.ok && bill.ok, [credit, shjSale, rcBill, bill].filter((r) => !r.ok));
      if (!rcBill.ok) return;
      const rc = await db.tradeDocument.findUniqueOrThrow({ where: { id: rcBill.data.id }, select: { total: true, igstAmount: true } });
      ok("the reverse-charge bill: VAT worked out, the vendor owed the net", Number(rc.igstAmount) === 50 && Number(rc.total) === 1000, rc);

      // Issued in place: no number series moves, nothing posts.
      await db.tradeDocument.updateMany({ where: { id: { in: created.documents } }, data: { status: "ISSUED" } });

      section("The VAT 201");
      const { getVatReturn } = await import("../src/actions/vat-return");
      const got = await getVatReturn("2031-Q1");
      ok("the return for Jan–Mar 2031 is built", got.ok, got);
      if (!got.ok) return;
      const v = got.data.vat;
      const by = (e: string) => v.box1.find((r) => r.emirate === e);
      ok("box 1 by the branch's emirate: Dubai 1,000 less the 200 credit, VAT 40", by("Dubai")?.amount === 800 && by("Dubai")?.vat === 40, v.box1);
      ok("  Sharjah 2,000, VAT 100; every emirate listed, none unassigned", by("Sharjah")?.amount === 2000 && by("Sharjah")?.vat === 100 && v.box1.length === 7 && v.withoutEmirate.length === 0, v.box1);
      ok("box 3: the reverse charge, 1,000 and 50", v.box3.amount === 1000 && v.box3.vat === 50, v.box3);
      ok("boxes 4 and 5: zero-rated 400, exempt 300; out of scope nowhere", v.box4 === 400 && v.box5 === 300, { box4: v.box4, box5: v.box5 });
      ok("box 8: 4,500 and VAT 190", v.box8.amount === 4500 && v.box8.vat === 190, v.box8);
      ok("box 9: the ordinary bill, 600 and 30; box 10 recovers box 3", v.box9.amount === 600 && v.box9.vat === 30 && v.box10.vat === 50, { box9: v.box9, box10: v.box10 });
      ok("boxes 12–14: 190 due, 80 recoverable, 110 payable", v.box12 === 190 && v.box13 === 80 && v.box14 === 110, { box12: v.box12, box13: v.box13, box14: v.box14 });
      ok("the CSV: one row a box", got.data.csv.split("\n")[0] === "Box,Description,Amount (AED),VAT (AED)" && got.data.csv.includes("1b,Standard rated supplies in Dubai,800.00,40.00") && got.data.csv.includes("14,Payable tax for the period,,110.00"), got.data.csv.split("\n").slice(0, 4));

      section("The pages");
      const Page = (await import("../src/app/(dashboard)/accounting/vat-return/page")).default;
      const html = renderToStaticMarkup((await Page({ searchParams: Promise.resolve({ period: "2031-Q1" }) })) as React.ReactElement).replace(/&amp;/g, "&").replace(/&#x27;/g, "'");
      ok("Accounting › VAT Return: the boxes, the due date and the CSV", html.includes("VAT Return") && html.includes("Standard rated supplies in Sharjah") && html.includes("Payable tax for the period") && html.includes("28 Apr 2031") && html.includes("Download CSV"), html.slice(0, 300));
      const Print = (await import("../src/app/(print)/documents/[id]/print/page")).default;
      const paper = renderToStaticMarkup((await Print({ params: Promise.resolve({ id: sale.data.id }), searchParams: Promise.resolve({}) })) as React.ReactElement);
      ok("the printed invoice: \"Tax Invoice\", the customer's TRN, the categories named", paper.includes("Tax Invoice") && paper.includes("TRN: 100987654300003") && paper.includes("Zero-rated") && paper.includes("Exempt") && paper.includes("Out of scope") && !paper.includes("Bill of supply"), paper.match(/TRN[^<]*/g));
      const zeroOnly = await createTradeDocument(doc({ lines: [line("Export support", 400, "ZERO_RATED")] }));
      if (zeroOnly.ok) {
        created.documents.push(zeroOnly.data.id);
        const zeroPaper = renderToStaticMarkup((await Print({ params: Promise.resolve({ id: zeroOnly.data.id }), searchParams: Promise.resolve({}) })) as React.ReactElement);
        ok("an invoice with nothing taxed is still a Tax Invoice — never India's bill of supply", zeroPaper.includes("Tax Invoice") && !zeroPaper.includes("Bill of supply") && !zeroPaper.includes("CGST Rules"));
      }
      const credPaper = credit.ok ? renderToStaticMarkup((await Print({ params: Promise.resolve({ id: credit.data.id }), searchParams: Promise.resolve({}) })) as React.ReactElement) : "";
      ok("a credit note prints as a Tax Credit Note", credPaper.includes("Tax Credit Note"));
    });

    section("The same workspace, as India's");
    await runAsTenant(india, async () => {
      const made = await createTradeDocument(doc({ gstTreatment: "OVERSEAS", placeOfSupplyCode: "96", lines: [line("Licences", 1000, "EXEMPT", 18)] }));
      ok("an invoice is raised as ever", made.ok, made);
      if (!made.ok) return;
      created.documents.push(made.data.id);
      const lines = await db.tradeDocumentLine.findMany({ where: { documentId: made.data.id }, select: { taxCategory: true, taxRatePercent: true } });
      ok("  a category sent is ignored: none written, the GST rate as typed", lines[0]?.taxCategory === null && Number(lines[0]?.taxRatePercent) === 18, lines);
      const { getVatReturn } = await import("../src/actions/vat-return");
      const refused = await getVatReturn("2031-Q1");
      ok("there is no VAT return to read", !refused.ok);
    });
  } finally {
    if (created.documents.length) {
      await db.tradeDocumentLine.deleteMany({ where: { documentId: { in: created.documents } } });
      await db.tradeDocument.deleteMany({ where: { id: { in: created.documents } } });
    }
    if (created.companies.length) {
      await db.companyLocation.deleteMany({ where: { companyId: { in: created.companies } } });
      await db.company.deleteMany({ where: { id: { in: created.companies } } });
    }
    if (created.branches.length) await db.branch.deleteMany({ where: { id: { in: created.branches } } });
    await db.auditLog.deleteMany({ where: { entityLabel: { contains: TAG } } }).catch(() => null);
  }

  console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll UAE VAT checks passed.");
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
