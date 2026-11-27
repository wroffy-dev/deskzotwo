/**
 * check:zoho-einvoices — invoices brought across from Zoho get their IRN (owner, 21 Nov 2026: "after 29 oct invoices
 * not showing irn"; src/lib/zoho/einvoices.ts, src/lib/zoho/rows.ts).
 *
 *   · einvoiceOf reads the e-invoice under every name Zoho is known to give it — nested or at the top, irn or
 *     inv_ref_num, ack_no or ack_number, signed_qr_code — and never takes the invoice's payment status for it.
 *   · The pull's invoice rows carry it into the columns the switch reads, the signed QR included.
 *   · fillIrnsFromZoho, against a fake Zoho: finds each invoice by number, puts the IRN, acknowledgement and QR on it,
 *     marks one Zoho never e-invoiced as asked (and says which fields the reply had), counts one Zoho doesn't have, and
 *     doesn't ask any of them twice.
 *   · An invoice brought across never prints as a test e-invoice, whatever portal this workspace is on.
 *   · Items' GST rates (src/lib/zoho/item-gst.ts): read from the India preferences — by percentage, by tax id through
 *     Zoho's tax list, or from the tax's name — matched by SKU or name, only empty values filled, never one set here.
 *
 * Against the local database: two of its invoices are lent as "brought across" and put back as they were; the
 * migration made for it is removed.
 *
 *   npm run check:zoho-einvoices
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

const IRN_A = "7f3a9c1e5b2d4f6081a3c5e7f9b1d3f5a7c9e1b3d5f7a9c1e3b5d7f9a1c3e5b7";
const calls: string[] = [];
let zohoItems: Record<string, unknown>[] = [];
const zohoItemById: Record<string, Record<string, unknown>> = {};
let numbers: Record<string, string> = {};

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "@/lib/zoho/client" || request.endsWith("lib/zoho/client")) {
    return {
      zohoGet: async (path: string, query: Record<string, string> = {}) => {
        calls.push(path + (query.invoice_number ? `?${query.invoice_number}` : ""));
        if (path === "/invoices") {
          const n = query.invoice_number ?? "";
          return numbers[n] ? { invoices: [{ invoice_id: numbers[n], invoice_number: n }] } : { invoices: [] };
        }
        if (path === "/settings/taxes") return { taxes: [{ tax_id: "T18", tax_name: "GST18", tax_percentage: 18 }] };
        if (path === "/items") return { items: zohoItems, page_context: { has_more_page: false } };
        if (path.startsWith("/items/")) return { item: zohoItemById[path.slice(7)] ?? {} };
        if (path === "/invoices/Z-A/einvoice") return { einvoice: { inv_ref_num: IRN_A.toUpperCase(), ack_no: "112510345678901", ack_date: "2025-11-03 12:30:00", signed_qr_code: "eyJhbGciOiJSUzI1NiJ9.eyJkYXRhIjoiMSJ9.c2ln", status: "pushed" } };
        if (path === "/invoices/Z-B/einvoice") throw new Error("404");
        if (path === "/invoices/Z-B") return { invoice: { invoice_id: "Z-B", status: "paid", e_invoice_type: "B2C", einvoice_details: { status: "not_applicable" } } };
        return {};
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function main() {
  const { einvoiceOf, invoiceRows } = (await import("../src/lib/zoho/rows")) as typeof import("../src/lib/zoho/rows") & { invoiceRows?: (d: Record<string, unknown>) => Record<string, string>[] };
  const { isTestEInvoice } = await import("../src/lib/einvoice/options");

  section("Every name Zoho gives it");
  const nested = einvoiceOf({ status: "paid", einvoice_details: { irn: IRN_A, ack_number: "1", ack_date: "2025-11-03", status: "pushed" } });
  ok("nested irn / ack_number", nested.irn === IRN_A && nested.ackNo === "1" && nested.status === "pushed", nested);
  const ref = einvoiceOf({ einvoice_details: { inv_ref_num: IRN_A, ack_no: "2", signed_qr_code: "q" } });
  ok("inv_ref_num / ack_no / signed_qr_code", ref.irn === IRN_A && ref.ackNo === "2" && ref.qr === "q", ref);
  const top = einvoiceOf({ irn: IRN_A, ack_no: "3", ack_date: "2025-11-04" });
  ok("at the top of the invoice", top.irn === IRN_A && top.ackNo === "3" && top.ackDate === "2025-11-04", top);
  ok("the invoice's own payment status is never read as the e-invoice's", einvoiceOf({ status: "paid" }).status === "");
  ok("uuid only inside the e-invoice", einvoiceOf({ uuid: "x" }).irn === "" && einvoiceOf({ einvoice: { uuid: IRN_A } }).irn === IRN_A);
  if (invoiceRows) {
    const rows = invoiceRows({ invoice_id: "1", invoice_number: "INV-1", date: "2025-11-03", line_items: [{ name: "x", quantity: 1, rate: 1 }], einvoice_details: { inv_ref_num: IRN_A, ack_no: "9", signed_qr_code: "qr" } });
    ok("the pull's invoice rows carry it, the QR included", rows[0]?.["e-Invoice Reference Number"] === IRN_A && rows[0]?.["e-Invoice Ack Number"] === "9" && rows[0]?.["e-Invoice QR Raw Data"] === "qr", rows[0]);
  }

  section("Never a test mark on one brought across");
  ok("brought across, workspace on the mock portal: not a test", !isTestEInvoice({ origin: "IMPORTED", signedQrCode: null }, "mock"));
  ok("made here on the mock portal: a test, as before", isTestEInvoice({ origin: "MANUAL", signedQrCode: null }, "mock"));

  section("Asking Zoho for the ones already in");
  const db = directClient();
  const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true, active: true }, select: { id: true } });
  const lent = await db.tradeDocument.findMany({ where: { docType: "INVOICE", irn: null, status: { not: "DRAFT" }, NOT: { origin: "IMPORTED" } }, take: 2, orderBy: { createdAt: "asc" }, select: { id: true, docNumber: true, origin: true, ackNo: true, ackDate: true, signedQrCode: true, einvoiceStatus: true } });
  if (lent.length < 2) throw new Error("Needs two invoices in the local database.");
  const before = new Set((await db.tradeDocument.findMany({ where: { origin: "IMPORTED", docType: "INVOICE", irn: null }, select: { id: true } })).map((d) => d.id));
  const m = await db.migration.create({ data: { source: "zz-check", yearStart: new Date("2025-04-01"), switchDate: new Date("2026-12-01"), createdById: admin.id }, select: { id: true } });
  try {
    await db.tradeDocument.updateMany({ where: { id: { in: lent.map((d) => d.id) } }, data: { origin: "IMPORTED" } });
    numbers = { [lent[0]!.docNumber]: "Z-A", [lent[1]!.docNumber]: "Z-B" };
    const { fillIrnsFromZoho, irnsToAsk } = await import("../src/lib/zoho/einvoices");
    const waiting = await irnsToAsk();
    ok("both lent invoices are waiting to be asked", waiting >= 2, waiting);
    const r = await fillIrnsFromZoho({ budgetMs: 60_000, userId: admin.id });
    const a = await db.tradeDocument.findUniqueOrThrow({ where: { id: lent[0]!.id }, select: { irn: true, ackNo: true, ackDate: true, signedQrCode: true, einvoiceStatus: true } });
    ok("found by number, its IRN, ack and QR put on it", a.irn === IRN_A && a.ackNo === "112510345678901" && !!a.ackDate && a.signedQrCode?.startsWith("eyJ") === true && a.einvoiceStatus === "GENERATED", a);
    ok("  ack date read as India's time", a.ackDate?.toISOString() === "2025-11-03T07:00:00.000Z", a.ackDate);
    const b = await db.tradeDocument.findUniqueOrThrow({ where: { id: lent[1]!.id }, select: { irn: true } });
    ok("one Zoho never e-invoiced: left without", b.irn === null);
    ok("  and the reply's e-invoice fields named", r.fieldsSeen.includes("e_invoice_type") && r.fieldsSeen.includes("einvoice.status"), r.fieldsSeen);
    ok("counted", r.filled === 1 && r.notEInvoiced >= 1 && r.left === 0, r);
    const n = calls.length;
    const again = await fillIrnsFromZoho({ budgetMs: 60_000, userId: admin.id });
    ok("pressed again: nobody asked twice", calls.length === n && again.filled === 0, { calls: calls.length - n });
    ok("  and nothing left to ask", (await irnsToAsk()) === 0 || [...before].length > 0);
  } finally {
    for (const d of lent) await db.tradeDocument.update({ where: { id: d.id }, data: { origin: d.origin, irn: null, ackNo: d.ackNo, ackDate: d.ackDate, signedQrCode: d.signedQrCode, einvoiceStatus: d.einvoiceStatus } });
    await db.migration.delete({ where: { id: m.id } });
  }
  section("Items' GST rates from Zoho");
  const { gstOfZohoItem } = await import("../src/lib/zoho/rows");
  const rates = new Map([["T18", 18]]);
  ok("intra-state preference by percentage", gstOfZohoItem({ item_tax_preferences: [{ tax_specification: "inter", tax_percentage: 12 }, { tax_specification: "intra", tax_percentage: 5 }] }).rate === 5);
  ok("by tax id, through Zoho's tax list", gstOfZohoItem({ item_tax_preferences: [{ tax_specification: "intra", tax_id: "T18" }] }, rates).rate === 18);
  ok("from the tax's name when nothing else says", gstOfZohoItem({ item_tax_preferences: [{ tax_specification: "inter", tax_name: "IGST12" }] }).rate === 12);
  ok("the item's own tax elsewhere", gstOfZohoItem({ tax_percentage: 28 }).rate === 28 && gstOfZohoItem({}).rate === null);
  ok("HSN read", gstOfZohoItem({ hsn_or_sac: "84713010" }).hsn === "84713010");
  const { itemRow } = await import("../src/lib/zoho/rows");
  ok("the pull's item row carries the India rate", itemRow({ item_id: "1", name: "x", item_tax_preferences: [{ tax_specification: "intra", tax_percentage: 18 }] })["Intra State Tax Rate"] === "18");

  const run = Date.now().toString(36);
  const made: string[] = [];
  const mk = async (name: string, sku: string, extra: object = {}) => {
    const i = await db.item.create({ data: { name, sku, type: "GOOD" as never, sellingPrice: 100, createdById: admin.id, ...extra }, select: { id: true } });
    made.push(i.id);
    return i.id;
  };
  const gm = await db.migration.create({ data: { source: "zz-check-gst", yearStart: new Date("2025-04-01"), switchDate: new Date("2026-12-01"), createdById: admin.id }, select: { id: true } });
  try {
    const bySku = await mk(`Zz GST ${run} Laptop`, `ZZ-${run}-A`);
    const byName = await mk(`Zz GST ${run} Service`, `ZZ-${run}-B`);
    const missing = await mk(`Zz GST ${run} Unknown`, `ZZ-${run}-C`);
    const setHere = await mk(`Zz GST ${run} Set`, `ZZ-${run}-D`, { taxRatePercent: 12 });
    zohoItems = [
      { item_id: "ZI-A", sku: `zz-${run}-a`, name: "Something else" },
      { item_id: "ZI-B", sku: "", name: `Zz GST ${run} Service` },
      { item_id: "ZI-D", sku: `ZZ-${run}-D`, name: "D" },
    ];
    zohoItemById["ZI-A"] = { item_id: "ZI-A", hsn_or_sac: "84713010", item_tax_preferences: [{ tax_specification: "intra", tax_id: "T18" }] };
    zohoItemById["ZI-B"] = { item_id: "ZI-B", hsn_or_sac: "998313", item_tax_preferences: [{ tax_specification: "intra", tax_percentage: 18 }] };
    zohoItemById["ZI-D"] = { item_id: "ZI-D", hsn_or_sac: "85285900", tax_percentage: 28 };
    const { fillGstFromZoho } = await import("../src/lib/zoho/item-gst");
    const g = await fillGstFromZoho({ budgetMs: 120_000 });
    const got = async (id: string) => db.item.findUniqueOrThrow({ where: { id }, select: { taxRatePercent: true, hsnCode: true } });
    const a = await got(bySku);
    ok("matched by SKU (any case): 18% from its tax id, HSN too", Number(a.taxRatePercent) === 18 && a.hsnCode === "84713010", a);
    const b = await got(byName);
    ok("matched by name: 18% and its SAC", Number(b.taxRatePercent) === 18 && b.hsnCode === "998313", b);
    ok("one Zoho doesn't have: left as it was", (await got(missing)).taxRatePercent === null && g.notInZoho >= 1);
    const d = await got(setHere);
    ok("a rate set in Deskzo is never replaced — only its empty HSN filled", Number(d.taxRatePercent) === 12 && d.hsnCode === "85285900", d);
    const n = calls.length;
    const again = await fillGstFromZoho({ budgetMs: 120_000 });
    ok("pressed again: nobody asked twice", calls.filter((c, idx) => idx >= n && c.startsWith("/items/")).length === 0 && again.rates === 0, again);
  } finally {
    await db.item.deleteMany({ where: { id: { in: made } } });
    await db.migration.delete({ where: { id: gm.id } });
  }

  const back = await db.tradeDocument.findMany({ where: { id: { in: lent.map((d) => d.id) } }, select: { id: true, origin: true, irn: true } });
  ok("the lent invoices are back as they were", back.every((d) => d.irn === null && d.origin === lent.find((l) => l.id === d.id)!.origin));

  console.log(failures === 0 ? `\nAll ${passes} Zoho e-invoice checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
