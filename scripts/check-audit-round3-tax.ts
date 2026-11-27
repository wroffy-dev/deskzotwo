/**
 * check:audit-round3-tax — security audit round three, 14 Nov 2026 (docs/reports/security-audit-2026-11-11.md §12), the
 * GST and tax findings, each shown to hold the way it was broken:
 *
 *   R3-02  a USD invoice goes to GSTR-1 and the IRN in rupees, B2CL's ₹1 lakh line read in rupees
 *   R3-05  freight is an item in the return JSON and the IRN, and the IRN's totals add up with TCS
 *   R3-06  cancelling through the IRN takes a credit note's applications off, as cancelling by hand does
 *   R3-07  no IRN on a cancelled document; no e-way bill on a vendor's bill or services; no cancel under a live bill
 *   R3-08  the mock and the sandbox refused on a production server
 *   R3-09  an off-slab rate, a rate unlike its item's without a reason, an over-crediting note — refused
 *   R3-10  an SEZ supply is inter-state in one state; SEZ/export supply types; reverse charge in 3B
 *
 * Pure rules first, then a fixture of its own in the local database, tagged ZZR3T, removed in a finally.
 *
 *   npx tsx scripts/check-audit-round3-tax.ts
 */
/* eslint-disable @typescript-eslint/no-explicit-any -- the portal's JSON, read as loosely as the portal writes it */
import "dotenv/config";
import Module from "node:module";
import { db } from "../src/lib/db";

const TAG = "ZZR3T";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
let actorId = "";
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return { requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  // The IRP login: the mock's, without switching the workspace's e-invoicing on.
  if (request === "@/lib/organisation") {
    const real = original.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, eInvoiceConfigFor: async () => ({ config: { provider: "mock", gstin: "33ZZRTT0000Z1Z5" } }) };
  }
  // E-way bills switched on for this run only.
  if (request === "@/lib/eway/settings") {
    const real = original.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, ewayEnabled: async () => true };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

const env = process.env as Record<string, string | undefined>;

async function cleanup() {
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const docs = (await db.tradeDocument.findMany({ where: { OR: [{ companyId: { in: companies } }, { docNumber: { startsWith: TAG } }] }, select: { id: true } })).map((d) => d.id);
  await db.creditNoteApplication.deleteMany({ where: { OR: [{ invoiceId: { in: docs } }, { creditNoteId: { in: docs } }] } });
  await db.ewayBill.deleteMany({ where: { documentId: { in: docs } } });
  await db.auditLog.deleteMany({ where: { entityId: { in: docs } } });
  const entries = (await db.journalEntry.findMany({ where: { documentId: { in: docs } }, select: { id: true } })).map((e) => e.id);
  if (entries.length) {
    await db.journalEntry.updateMany({ where: { reversesId: { in: entries } }, data: { reversesId: null } });
    await db.journalLine.deleteMany({ where: { entryId: { in: entries } } });
    await db.journalEntry.deleteMany({ where: { id: { in: entries } } });
  }
  await db.tradeDocument.updateMany({ where: { id: { in: docs } }, data: { againstDocumentId: null } });
  await db.tradeDocument.deleteMany({ where: { id: { in: docs } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.gstRegistration.deleteMany({ where: { code: TAG } });
}

async function main() {
  const { returnFigures, buildGstr1, buildGstr3b, FREIGHT_SAC } = await import("../src/lib/ledger/gst-returns");
  const { gstr1Json, gstr3bJson } = await import("../src/lib/ledger/gstn-json");
  const { buildEInvoicePayload, supplyCategory } = await import("../src/lib/einvoice/payload");
  const { supplyTypeFor, resolveSupplyType, computeDocument } = await import("../src/lib/gst-engine");
  const { tradeDocumentSchema } = await import("../src/lib/validation/trade-document");
  const { settleLineTax } = await import("../src/lib/vat/rules");
  const { ewayRefusal } = await import("../src/lib/eway/documents");
  const { documentDeclaredValue } = await import("../src/lib/eway/value");
  const options = await import("../src/lib/einvoice/options");
  const { createEInvoiceProvider } = await import("../src/lib/einvoice/provider");
  const { createEwayProvider } = await import("../src/lib/eway/provider");

  section("R3-02: a USD invoice in rupees");
  const usd = returnFigures(
    {
      docNumber: "U1", docType: "INVOICE" as const, issueDate: new Date(Date.UTC(2026, 9, 10, 6)), status: "ISSUED", partyName: "Zz", partyGstin: null,
      placeOfSupplyCode: "29", gstTreatment: "UNREGISTERED", taxableValue: 2000, cgstAmount: 0, sgstAmount: 0, igstAmount: 360, total: 2360,
      lines: [{ hsnCode: "8471", name: "Laptop", unit: "NOS", quantity: 1, taxableValue: 2000, taxRatePercent: 18, cgstAmount: 0, sgstAmount: 0, igstAmount: 360 }],
    },
    84,
  );
  ok("the document's figures at its own rate: USD 2,360 at 84 is ₹1,98,240", usd.total === 198240 && usd.taxableValue === 168000 && usd.lines[0]!.igstAmount === 30240, usd);
  const file1 = gstr1Json([usd], { gstin: "27ZZZZZ0000Z1Z5", stateCode: "27" }, 10, 2026) as Record<string, any>;
  ok("  so it is a B2CL invoice (over ₹1 lakh inter-state), not B2CS at face value", file1.b2cl?.[0]?.inv?.[0]?.val === 198240 && !file1.b2cs, file1);
  ok("  and the screen's totals are in rupees", buildGstr1([usd]).totals.taxableValue === 168000);
  ok("at rate 1 nothing moves", returnFigures({ ...usd, total: 100, taxableValue: 100, cgstAmount: 0, sgstAmount: 0, igstAmount: 0, lines: [] }, 1).total === 100);

  const usdDoc = {
    docType: "INVOICE" as const, docNumber: "ZZ/2627/0001", issueDate: new Date(Date.UTC(2026, 10, 10, 6)), reverseCharge: false, placeOfSupplyCode: "29",
    seller: { gstin: "27ZZZZZ0000Z1Z5", legalName: "Zz", address1: "A", city: "Pune", pincode: "411001", stateCode: "27" },
    buyer: { gstin: "29AAAAA0000A1Z5", legalName: "Buyer", address1: "B", city: "Bengaluru", pincode: "560001", stateCode: "29" },
    lines: [{ description: "Laptop", isService: false, hsnCode: "8471", quantity: 2, unit: "NOS", unitPrice: 5000, grossAmount: 10000, discountAmount: 0, taxableValue: 10000, taxRatePercent: 18, cgstAmount: 0, sgstAmount: 0, igstAmount: 1800, lineTotal: 11800 }],
    taxableValue: 10100, cgstAmount: 0, sgstAmount: 0, igstAmount: 1818, roundOff: 0, total: 12019,
    currency: "USD", exchangeRate: 84, gstTreatment: "REGISTERED_REGULAR", shippingCharge: 100, shippingTaxRatePercent: 18, withholdingAmount: 101, adjustment: 0,
  };
  const irn = buildEInvoicePayload(usdDoc) as Record<string, any>;
  ok("the IRN payload is in rupees: USD 10,000 assessable is ₹8,40,000", irn.ItemList[0].AssAmt === 840000 && irn.ItemList[0].UnitPrice === 420000, irn.ItemList[0]);
  ok("  with the foreign total beside it", irn.ValDtls.TotInvValFc === 12019 && irn.ValDtls.AssVal === 848400, irn.ValDtls);

  section("R3-05: freight in the return files and the IRN");
  const freighted = returnFigures(
    {
      docNumber: "F1", docType: "INVOICE" as const, issueDate: new Date(Date.UTC(2026, 9, 10, 6)), status: "ISSUED", partyName: "Zz", partyGstin: "29AAAAA0000A1Z5",
      placeOfSupplyCode: "29", taxableValue: 1100, cgstAmount: 0, sgstAmount: 0, igstAmount: 68, total: 1168,
      shippingCharge: 100, shippingTaxRatePercent: 18,
      lines: [{ hsnCode: "4901", name: "Books", unit: "NOS", quantity: 1, taxableValue: 1000, taxRatePercent: 5, cgstAmount: 0, sgstAmount: 0, igstAmount: 50 }],
    },
    1,
  );
  const fileF = gstr1Json([freighted], { gstin: "27ZZZZZ0000Z1Z5", stateCode: "27" }, 10, 2026) as Record<string, any>;
  const items = fileF.b2b?.[0]?.inv?.[0]?.itms ?? [];
  const at18 = items.find((i: any) => i.itm_det.rt === 18)?.itm_det;
  ok("the freight is an item at its own rate in the B2B invoice", at18?.txval === 100 && at18?.iamt === 18, items);
  ok("  and the items add up to the invoice's taxable value", items.reduce((t: number, i: any) => t + i.itm_det.txval, 0) === 1100);
  ok("  and the HSN summary carries it under SAC 996511", fileF.hsn?.hsn_b2b?.some((r: any) => r.hsn_sc === FREIGHT_SAC && r.txval === 100));
  ok("  so the screen no longer reports a lines-versus-document mismatch", !buildGstr1([freighted]).problems.some((p) => /lines add up/.test(p.issue)));
  const irnF = irn.ItemList.find((i: any) => i.HsnCd === FREIGHT_SAC);
  ok("the IRN carries the freight as its own item, in rupees", irnF?.AssAmt === 8400 && irnF?.IgstAmt === 1512 && irnF?.IsServc === "Y", irnF);
  const v = irn.ValDtls;
  ok("  TCS as other charges, and the totals reconcile", v.OthChrg === 8484 && Math.abs(v.AssVal + v.CgstVal + v.SgstVal + v.IgstVal + (v.OthChrg ?? 0) - (v.Discount ?? 0) + v.RndOffAmt - v.TotInvVal) < 0.005, v);
  const inr = buildEInvoicePayload({ ...usdDoc, currency: "INR", exchangeRate: 1, withholdingAmount: -101, adjustment: -1, total: 11817 }) as Record<string, any>;
  ok("  TDS is added back and a negative adjustment is a discount", inr.ValDtls.TotInvVal === 11917 && inr.ValDtls.Discount === 1 && !inr.ValDtls.OthChrg, inr.ValDtls);

  section("R3-10: SEZ and exports, reverse charge");
  ok("an SEZ unit in the seller's own state is inter-state", supplyTypeFor("29", "29", "SEZ") === "INTER_STATE" && resolveSupplyType("29", "29") === "INTRA_STATE");
  ok("  so is an export; a deemed export follows the states", supplyTypeFor("29", "29", "OVERSEAS") === "INTER_STATE" && supplyTypeFor("29", "29", "DEEMED_EXPORT") === "INTRA_STATE");
  const sez = computeDocument([{ quantity: 1, unitPrice: 1000, taxRatePercent: 18 }], supplyTypeFor("29", "29", "SEZ"));
  ok("  the engine then charges IGST, not CGST + SGST", sez.igstAmount === 180 && sez.cgstAmount === 0);
  const buyer = usdDoc.buyer;
  ok("supply types: SEZWP / SEZWOP / EXPWP / EXPWOP / DEXP", [
    supplyCategory({ buyer, gstTreatment: "SEZ", igstAmount: 1 }),
    supplyCategory({ buyer, gstTreatment: "SEZ", igstAmount: 0 }),
    supplyCategory({ buyer, gstTreatment: "OVERSEAS", igstAmount: 1 }),
    supplyCategory({ buyer, gstTreatment: "OVERSEAS", igstAmount: 0 }),
    supplyCategory({ buyer, gstTreatment: "DEEMED_EXPORT", igstAmount: 0 }),
  ].join() === "SEZWP,SEZWOP,EXPWP,EXPWOP,DEXP");
  const exp = buildEInvoicePayload({ ...usdDoc, gstTreatment: "OVERSEAS", igstAmount: 0, lines: usdDoc.lines.map((l) => ({ ...l, igstAmount: 0 })), shippingCharge: 0, withholdingAmount: 0, buyerCountryCode: "us" }) as Record<string, any>;
  ok("  an export goes to URP in 96 with its currency and country", exp.TranDtls.SupTyp === "EXPWOP" && exp.BuyerDtls.Gstin === "URP" && exp.BuyerDtls.Pos === "96" && exp.ExpDtls?.ForCur === "USD" && exp.ExpDtls?.CntCode === "US", { t: exp.TranDtls, b: exp.BuyerDtls, e: exp.ExpDtls });
  const rcmBill = { docNumber: "B1", docType: "BILL" as const, issueDate: new Date(), status: "ISSUED", partyName: "V", partyGstin: null, placeOfSupplyCode: "27", reverseCharge: true, taxableValue: 1000, cgstAmount: 90, sgstAmount: 90, igstAmount: 0, total: 1180, lines: [{ hsnCode: "996511", name: "Freight", unit: null, quantity: 1, taxableValue: 1000, taxRatePercent: 18, cgstAmount: 90, sgstAmount: 90, igstAmount: 0 }] };
  const g = buildGstr3b({ outwardDocs: [], inwardDocs: [rcmBill] });
  ok("reverse charge: its tax is payable (in cash), though the credit is the same", g.reverseCharge.cgst === 90 && g.netPayable.total === 180 && g.inward.cgst === 90, { rc: g.reverseCharge, net: g.netPayable });
  const j = gstr3bJson(g, [], [rcmBill], { gstin: "27ZZZZZ0000Z1Z5", stateCode: "27" }, 10, 2026) as Record<string, any>;
  const isrc = j.itc_elg.itc_avl.find((r: any) => r.ty === "ISRC");
  const oth = j.itc_elg.itc_avl.find((r: any) => r.ty === "OTH");
  ok("  3B's JSON: its credit under ISRC, not OTH; its liability in 3.1(d)", isrc.camt === 90 && oth.camt === 0 && j.sup_details.isup_rev.camt === 90, { isrc, oth });

  section("R3-09: rates");
  const form = (lines: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
    docType: "INVOICE", companyId: "c1", currency: "INR", exchangeRate: 1, gstTreatment: "UNREGISTERED", placeOfSupplyCode: "07", issueDate: "2026-11-14",
    billing: { line1: "", city: "", state: "", stateCode: "", pincode: "", country: "India" },
    shipping: { line1: "", city: "", state: "", stateCode: "", pincode: "", country: "India" },
    lines: lines.map((l) => ({ name: "Line", quantity: 1, unitPrice: 1000, discountMode: "PERCENT", discountValue: 0, taxRatePercent: 18, ...l })),
    ...extra,
  });
  const offSlab = tradeDocumentSchema.safeParse(form([{ taxRatePercent: 17 }]));
  ok("a sale at 17% is refused, naming the line", !offSlab.success && offSlab.error.issues.some((i) => /Line 1: 17% isn't a GST rate/.test(i.message)));
  ok("  18%, 0.25% and 40% are rates", tradeDocumentSchema.safeParse(form([{ taxRatePercent: 18 }, { taxRatePercent: 0.25 }, { taxRatePercent: 40 }])).success);
  ok("  freight at 17% is refused too", !tradeDocumentSchema.safeParse(form([{}], { shippingCharge: 100, shippingTaxRatePercent: 17 })).success);
  ok("  a vendor's bill is entered as the vendor charged it", tradeDocumentSchema.safeParse(form([{ taxRatePercent: 17 }], { docType: "BILL" })).success);
  ok("UAE: a standard-rated line is charged the standard rate, whatever was typed", JSON.stringify(settleLineTax("STANDARD", 3, 5)) === '{"category":"STANDARD","rate":5}');

  section("R3-08: test portals on a production server");
  ok("allowed in development, refused in production, allowed with the flag", options.testProvidersAllowed({ NODE_ENV: "development" }) && !options.testProvidersAllowed({ NODE_ENV: "production" }) && options.testProvidersAllowed({ NODE_ENV: "production", EINVOICE_ALLOW_TEST_PROVIDERS: "1" }));
  const savedEnv = { NODE_ENV: env.NODE_ENV, FLAG: env.EINVOICE_ALLOW_TEST_PROVIDERS };
  try {
    env.NODE_ENV = "production";
    delete env.EINVOICE_ALLOW_TEST_PROVIDERS;
    const made = await createEInvoiceProvider({ provider: "mock", gstin: "27ZZZZZ0000Z1Z5" }).generate(usdDoc);
    ok("the mock IRP is refused on a production server — no IRN made up", !made.ok && /mock portal/.test(made.ok ? "" : made.error), made);
    const sandbox = await createEInvoiceProvider({ provider: "nic_sandbox" }).cancel("x", "1", "x");
    ok("  so is the sandbox", !sandbox.ok);
    const ewb = await createEwayProvider({ provider: "mock" }).fetch("123412341234");
    ok("  and the mock e-way bill portal", !ewb.ok);
    const unknown = await createEInvoiceProvider({ provider: "whatever" }).generate(usdDoc);
    ok("  an unknown provider no longer falls through to the mock", !unknown.ok);
  } finally {
    env.NODE_ENV = savedEnv.NODE_ENV;
    if (savedEnv.FLAG === undefined) delete env.EINVOICE_ALLOW_TEST_PROVIDERS;
    else env.EINVOICE_ALLOW_TEST_PROVIDERS = savedEnv.FLAG;
  }
  ok("a mock IRN prints as a test (its QR isn't the IRP's signed token)", options.isTestEInvoice({ signedQrCode: Buffer.from("{}").toString("base64") }, "nic_production") && options.isTestEInvoice({ signedQrCode: "a.b.c" }, "nic_sandbox") && !options.isTestEInvoice({ signedQrCode: "a.b.c" }, "nic_production"));

  section("R3-07: e-way bills, the rule");
  ok("a vendor's bill carries none", /vendor's bill/.test(ewayRefusal({ docType: "BILL", status: "ISSUED", lines: [{ hsnCode: "8471" }] }) ?? ""));
  ok("  nor a draft, nor a cancelled invoice, nor one of services alone", !!ewayRefusal({ docType: "INVOICE", status: "DRAFT", lines: [] }) && !!ewayRefusal({ docType: "INVOICE", status: "CANCELLED", lines: [] }) && /service/.test(ewayRefusal({ docType: "INVOICE", status: "ISSUED", lines: [{ hsnCode: "998314" }] }) ?? ""));
  ok("  an issued invoice of goods may", ewayRefusal({ docType: "INVOICE", status: "ISSUED", lines: [{ hsnCode: "8471" }, { hsnCode: "998314" }] }) === null);
  // Goods only means a goods HSN code (owner, 16 Nov 2026: "eway bill only if hsn is hardware code - goods").
  ok(
    "  lines with no code, or a code that isn't one, aren't goods",
    /goods HSN/.test(ewayRefusal({ docType: "INVOICE", status: "ISSUED", lines: [{ hsnCode: null }, { hsnCode: "" }, { hsnCode: "84" }] }) ?? "") &&
      /goods HSN/.test(ewayRefusal({ docType: "DELIVERY_CHALLAN", status: "ISSUED", lines: [] }) ?? ""),
  );
  ok("  a goods code written with spaces still is one", ewayRefusal({ docType: "INVOICE", status: "ISSUED", lines: [{ hsnCode: "8471 30" }] }) === null);
  ok("the declared value of a USD invoice is its rupees; a challan's is typed", documentDeclaredValue({ docType: "INVOICE", total: 1000, currency: "USD", exchangeRate: 84 }) === 84000 && documentDeclaredValue({ docType: "DELIVERY_CHALLAN", total: 0, currency: "INR", exchangeRate: 1 }) === null);

  // ─── The database ───────────────────────────────────────────────────────────
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;
  const { cancelEInvoice, generateEInvoice, setTradeDocumentStatus } = await import("../src/actions/trade-document");
  const { generateEwayBill, associateEwayBill } = await import("../src/actions/eway");
  const { gstr1 } = await import("../src/actions/tax-reports");
  const { creditNoteLimitRefusal, rateOverrides } = await import("../src/lib/documents/create-draft");

  await cleanup();
  try {
    const registration = await db.gstRegistration.create({ data: { gstin: "33ZZRTT0000Z1Z5", stateCode: "33", code: TAG, active: false }, select: { id: true } });
    const customer = await db.company.create({ data: { name: `${TAG} Customer`, normalizedName: `${TAG.toLowerCase()} customer`, createdById: admin.id }, select: { id: true } });
    const vendor = await db.company.create({ data: { name: `${TAG} Vendor`, normalizedName: `${TAG.toLowerCase()} vendor`, createdById: admin.id }, select: { id: true } });
    const line = (rate: number, taxable: number, inter = true) => ({
      name: "Zz goods", hsnCode: "8471", quantity: 1, unitPrice: taxable, taxRatePercent: rate, taxableValue: taxable,
      igstAmount: inter ? (taxable * rate) / 100 : 0, cgstAmount: inter ? 0 : (taxable * rate) / 200, sgstAmount: inter ? 0 : (taxable * rate) / 200, lineTotal: taxable * (1 + rate / 100),
    });
    const base = { direction: "SALES" as const, companyId: customer.id, createdById: admin.id, gstRegistrationId: registration.id };

    section("R3-02 on the database: GSTR-1's row for a USD invoice");
    const now = new Date();
    await db.tradeDocument.create({
      data: {
        ...base, docNumber: `${TAG}/INV/USD`, docType: "INVOICE", status: "ISSUED", issueDate: now, placeOfSupplyCode: "29", buyerGstin: "29AAAAA0000A1Z5", gstTreatment: "REGISTERED_REGULAR",
        currency: "USD", exchangeRate: 84, taxableValue: 10000, igstAmount: 1800, total: 11800, lines: { create: [line(18, 10000)] },
      },
    });
    const month = Number(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", month: "numeric" }).format(now));
    const year = Number(new Intl.DateTimeFormat("en-IN", { timeZone: "Asia/Kolkata", year: "numeric" }).format(now));
    const r1 = await gstr1({ month, year, gstRegistrationId: registration.id });
    const row = r1?.b2b.find((b) => b.docNumber === `${TAG}/INV/USD`);
    ok("the invoice's B2B row is in rupees: ₹8,40,000 taxable, ₹1,51,200 IGST", row?.taxableValue === 840000 && row?.igstAmount === 151200, row);

    section("R3-06: cancelling through the IRN does the whole cancel");
    const invoice = await db.tradeDocument.create({ data: { ...base, docNumber: `${TAG}/INV/1`, docType: "INVOICE", status: "PAID", taxableValue: 1000, igstAmount: 180, total: 1180, lines: { create: [line(18, 1000)] } } });
    const note = await db.tradeDocument.create({
      data: {
        ...base, docNumber: `${TAG}/CN/1`, docType: "CREDIT_NOTE", status: "ISSUED", againstDocumentId: invoice.id, taxableValue: 1000, igstAmount: 180, total: 1180,
        einvoiceStatus: "GENERATED", irn: `${TAG}-irn-cn1`, ackDate: new Date(), lines: { create: [line(18, 1000)] },
      },
    });
    await db.creditNoteApplication.create({ data: { creditNoteId: note.id, invoiceId: invoice.id, amount: 1180, appliedByUserId: admin.id } });
    const cancelled = await cancelEInvoice({ id: note.id, reason: "2", remark: `${TAG} test` });
    const afterNote = await db.tradeDocument.findUnique({ where: { id: note.id }, select: { status: true, einvoiceStatus: true } });
    const afterInvoice = await db.tradeDocument.findUnique({ where: { id: invoice.id }, select: { status: true } });
    ok("the credit note and its IRN are cancelled", cancelled.ok && afterNote?.status === "CANCELLED" && afterNote.einvoiceStatus === "CANCELLED", { cancelled, afterNote });
    ok("  its credit is taken off the invoice, which is open again", (await db.creditNoteApplication.count({ where: { creditNoteId: note.id } })) === 0 && afterInvoice?.status === "ISSUED", afterInvoice);

    section("R3-07 on the database");
    const dead = await db.tradeDocument.create({ data: { ...base, docNumber: `${TAG}/INV/2`, docType: "INVOICE", status: "CANCELLED", taxableValue: 1000, igstAmount: 180, total: 1180, lines: { create: [line(18, 1000)] } } });
    const irnOnDead = await generateEInvoice(dead.id);
    ok("no IRN on a cancelled invoice", !irnOnDead.ok && /cancelled/.test(irnOnDead.ok ? "" : irnOnDead.error), irnOnDead);
    const bill = await db.tradeDocument.create({ data: { ...base, direction: "PURCHASE", companyId: vendor.id, docNumber: `${TAG}/BILL/1`, docType: "BILL", status: "ISSUED", taxableValue: 1000, total: 1180, lines: { create: [line(18, 1000)] } } });
    await db.ewayBill.create({ data: { documentId: bill.id, declaredValue: 1180, distanceKm: 10, vehicleNumber: "TN01AB1234" } });
    const onBill = await generateEwayBill(bill.id);
    ok("no e-way bill raised on a vendor's bill", !onBill.ok && /vendor's bill/.test(onBill.ok ? "" : onBill.error), onBill);
    const goods = await db.tradeDocument.create({ data: { ...base, docNumber: `${TAG}/INV/3`, docType: "INVOICE", status: "ISSUED", taxableValue: 60000, igstAmount: 10800, total: 70800, lines: { create: [line(18, 60000)] } } });
    await db.ewayBill.create({ data: { documentId: goods.id, declaredValue: 70800, distanceKm: 10, status: "GENERATED", ewayBillNumber: "999988887777", ewayBillDate: new Date(), validUntil: new Date(Date.now() + 86400000) } });
    const cancelUnderBill = await setTradeDocumentStatus(goods.id, "CANCELLED", `${TAG} test`);
    ok("an invoice isn't cancelled while its e-way bill is live", !cancelUnderBill.ok && /999988887777/.test(cancelUnderBill.ok ? "" : cancelUnderBill.error), cancelUnderBill);
    const overwrite = await associateEwayBill({ documentId: goods.id, ewayBillNumber: "111122223333", ewayBillDate: "2026-11-14", validUntil: "2026-11-15" });
    ok("  and a typed-in bill doesn't overwrite the live one raised from here", !overwrite.ok && /still live/.test(overwrite.ok ? "" : overwrite.error), overwrite);

    section("R3-09 on the database: credit notes and item rates");
    const fivePct = await db.tradeDocument.create({ data: { ...base, docNumber: `${TAG}/INV/4`, docType: "INVOICE", status: "ISSUED", taxableValue: 1000, igstAmount: 50, total: 1050, lines: { create: [line(5, 1000)] } } });
    const noteLine = (rate: number, price: number) => ({ name: "Back", quantity: 1, unitPrice: price, discountMode: "PERCENT" as const, discountValue: 0, taxRatePercent: rate });
    const at28 = await creditNoteLimitRefusal(fivePct.id, { lines: [noteLine(28, 100)], currency: "INR" }, null);
    ok("a credit note at 28% against an invoice that charged 5% is refused", /at 28%/.test(at28 ?? ""), at28);
    ok("  one taking off more than the invoice's 5% value is refused", /left at that rate/.test((await creditNoteLimitRefusal(fivePct.id, { lines: [noteLine(5, 1200)] }, null)) ?? ""));
    ok("  one within it is fine", (await creditNoteLimitRefusal(fivePct.id, { lines: [noteLine(5, 500)] }, null)) === null);
    ok("  one in another currency is refused", /currency/.test((await creditNoteLimitRefusal(fivePct.id, { lines: [noteLine(5, 5)], currency: "USD" }, null)) ?? ""));
    await db.tradeDocument.create({ data: { ...base, docNumber: `${TAG}/CN/2`, docType: "CREDIT_NOTE", status: "ISSUED", againstDocumentId: fivePct.id, taxableValue: 800, igstAmount: 40, total: 840, lines: { create: [line(5, 800)] } } });
    ok("  and the other notes against it count", /after its other credit notes/.test((await creditNoteLimitRefusal(fivePct.id, { lines: [noteLine(5, 500)] }, null)) ?? ""));
    const item = await db.item.create({ data: { name: `${TAG} Router`, sku: `${TAG}-RTR`, type: "GOOD", sellingPrice: 1000, taxRatePercent: 18, createdById: admin.id }, select: { id: true } });
    const formLine = (extra: Record<string, unknown>) => ({ itemId: item.id, name: "Router", quantity: 1, unitPrice: 1000, discountMode: "PERCENT" as const, discountValue: 0, taxRatePercent: 5, ...extra }) as never;
    const noReason = await rateOverrides([formLine({})], "INVOICE");
    ok("a line at 5% whose item is 18% needs a reason", "error" in noReason && /its item is 18%/.test(noReason.error), noReason);
    const reasoned = await rateOverrides([formLine({ description: "Rate: concessional rate, notification 41/2017" })], "INVOICE");
    ok("  given on a \"Rate:\" line, it's taken and kept for the audit log", "overrides" in reasoned && reasoned.overrides[0]?.reason === "concessional rate, notification 41/2017", reasoned);
    ok("  a line at the item's own rate needs none", "overrides" in (await rateOverrides([formLine({ taxRatePercent: 18 })], "INVOICE")));
  } finally {
    await cleanup();
    await db.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} round-three tax checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
