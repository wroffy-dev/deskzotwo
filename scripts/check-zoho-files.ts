/**
 * check:zoho-files — Zoho Books' own export files through Switch to Deskzo (src/lib/migration/zoho.ts,
 * accounts.ts, upload.ts; phase 2 of the Zoho plan, owner 26 Oct 2026).
 *
 * Made-up rows under the headings of a real Zoho Books backup — no customer's data is in here. First what needs no
 * database: which files are Zoho's (an id column of the same name in an alias-style file isn't enough), a state as
 * its GST code, a document discount spread over the lines, a price that included tax taken back, a cancelled e-way
 * bill dropped, what was applied of a credit note and a vendor payment. Then on a scratch workspace database of its
 * own (<db>_zoho_files_check, built from the migrations and dropped at the end, pass or fail), as an admin:
 *
 *   · a backup ZIP sorted: an invoice file in two parts put back together, the payments and expenses to their
 *     steps, the chart of accounts to the old chart's map, the contacts named as left out;
 *   · the old chart suggested — Undeposited Funds as the bank, Rent Expense as Rent, the bank by its name, the
 *     receivable as Deskzo's own — one waiting, then made new in Deskzo's chart;
 *   · an invoice whose customer Zoho calls by another name found by Zoho's customer id, its line's item by Zoho's
 *     item id, its discounts, freight and adjustment kept, its total Zoho's to the rupee; a tax-inclusive one too;
 *   · the payment into Undeposited Funds landing where Record payment puts it; the rent expense posted to Rent;
 *   · the migration's Undo taking back the account it made for the old chart;
 *   · the upload route refusing a request from anywhere but the app.
 *
 * The session is a stand-in; no mail is sent; nothing is written to any other database.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import Module from "node:module";
import JSZip from "jszip";
import Papa from "papaparse";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const withDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};
const csv = (rows: Record<string, string>[]) => Papa.unparse({ fields: [...new Set(rows.flatMap((r) => Object.keys(r)))], data: rows });

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: "ADMIN", name: "Zz Zoho", email: `${actorId}@zzzoho.invalid` } : null);
    return {
      requireUser: async () => {
        const u = await user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: user,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const ACME_ZOHO = "880908000000100001";
const WIDGET_ZOHO = "880908000000300001";

/** An invoice line as Zoho Books exports it — the headings the switch reads, among the many it has. */
const invoiceLine = (o: Record<string, string>) => ({
  "Invoice Date": "2026-05-10",
  "Invoice ID": "",
  "Invoice Number": "",
  "Invoice Status": "Closed",
  "Customer ID": "",
  "Customer Name": "",
  "Place of Supply": "MH",
  "Place of Supply(With State Code)": "27-Maharashtra",
  "GST Treatment": "business_gst",
  "Is Inclusive Tax": "FALSE",
  "Due Date": "2026-05-25",
  "Currency Code": "INR",
  "Exchange Rate": "1",
  "Discount Type": "entity_level",
  "Is Discount Before Tax": "TRUE",
  "Entity Discount Amount": "0",
  SubTotal: "",
  Total: "",
  Balance: "0",
  Adjustment: "0",
  "Shipping Charge": "0",
  "Shipping Charge Tax %": "",
  "e-Invoice Status": "",
  "e-Invoice Reference Number": "",
  "e-Invoice Ack Number": "",
  "e-Invoice Ack Date": "",
  "e-Invoice QR Raw Data": "",
  "E-WayBill Number": "",
  "E-WayBill Status": "",
  "E-WayBill Generated Time": "",
  "E-WayBill Expired Time": "",
  "Item Name": "",
  "Item Desc": "",
  Quantity: "1",
  Discount: "0",
  "Discount Amount": "0",
  "Item Total": "",
  "Usage unit": "",
  "Item Price": "",
  "Product ID": "",
  "Item Tax": "IGST",
  "Item Tax %": "18",
  "HSN/SAC": "",
  "Sales person": "",
  PurchaseOrder: "",
  Notes: "",
  "Terms & Conditions": "",
  "GST Identification Number (GSTIN)": "",
  ...o,
});

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is needed.");
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1"].includes(host)) throw new Error("Only against a local database server.");
  const scratchName = `${new URL(url).pathname.slice(1)}_zoho_files_check`;
  const scratchUrl = withDatabase(url, scratchName);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });

  section("A scratch workspace");
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
  try {
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("built from its migrations", true);
    // Off by value, never deleted, so a client re-reading .env can't put them back.
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = " ";
    process.env.DESKZO_TENANCY_FALLBACK = "legacy";
    // The pure checks too: zoho.ts reaches the db module, which must only ever see the scratch database.
    pure();
    await scenario();
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = ${scratchName}`;
    ok("the scratch workspace is dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
  }
  console.log(failures === 0 ? "\nAll Zoho file checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

function pure() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const zoho = require("../src/lib/migration/zoho") as typeof import("../src/lib/migration/zoho");
  /* eslint-enable @typescript-eslint/no-require-imports */
  section("Which files are Zoho's");
  ok("an alias-style expense file with an Expense Reference ID column isn't taken for Zoho's", !zoho.isZohoFile("expenses", [{ "Expense Reference ID": "EXP-9", "Expense Date": "2026-05-02", "Vendor Name": "Zz" }]));
  ok("  Zoho's own is", zoho.isZohoFile("expenses", [{ "Expense Reference ID": "7001", "Paid Through Account Code": "" }]) && zoho.isZohoFile("invoices", [invoiceLine({})]));
  const vendorPaymentHeadings = { "Payment Number": "", "VendorPayment ID": "", "Vendor Name": "", "Bill ID": "", "Bill Amount": "", "Bill Number": "" };
  ok("  a vendor payment file, which has a Bill ID and a Vendor Name too, is a vendor payment — not a bill", zoho.isZohoFile("vendor-payments", [vendorPaymentHeadings]) && !zoho.isZohoFile("bills", [vendorPaymentHeadings]));

  section("Reading Zoho's values");
  ok("a state as its GST code: HR, 06-Haryana, 32-Keralam, UK, OD", ["HR", "06-Haryana", "32-Keralam", "UK", "OD"].map(zoho.zohoStateCode).join() === "06,06,32,05,21", ["HR", "06-Haryana", "32-Keralam", "UK", "OD"].map(zoho.zohoStateCode));
  ok("  and nothing for a place that isn't one", zoho.zohoStateCode("Atlantis") === "");

  // A credit note raised against an invoice keeps it in invoices_credited, not invoices (owner, 17 Nov 2026 — twelve
  // came across with no invoice and were refused).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const zohoRows = require("../src/lib/zoho/rows") as typeof import("../src/lib/zoho/rows");
  const cnLine = { line_items: [{ name: "Zz", quantity: 1, rate: 1000, item_total: 1000, tax_percentage: 18 }], total: 1180, sub_total: 1000, date: "2026-10-27", status: "closed" };
  const raised = zohoRows.creditNoteRows({ ...cnLine, creditnote_id: "CN1", creditnote_number: "CN-00547", invoice_id: "I1", invoice_number: "WT/26-27/1147", invoices: [], invoices_credited: [{ invoice_id: "I1", invoice_number: "WT/26-27/1147", credited_amount: 1180, date: "2026-10-27" }] });
  ok("a credit note raised against an invoice names it, and is set against it in full", raised.rows[0]?.["Associated Invoice Number"] === "WT/26-27/1147" && raised.applications.length === 1 && raised.applications[0]!.Amount === "1180" && raised.applications[0]!["Invoice Number"] === "WT/26-27/1147", { rows: raised.rows[0]?.["Associated Invoice Number"], applications: raised.applications });
  const later = zohoRows.creditNoteRows({ ...cnLine, creditnote_id: "CN2", creditnote_number: "CN-00600", invoices: [{ invoice_id: "I2", invoice_number: "WT/26-27/2000", amount_applied: 500 }] });
  ok("  one applied afterwards still names the invoice it was applied to", later.rows[0]?.["Associated Invoice Number"] === "WT/26-27/2000" && later.applications.length === 1 && later.applications[0]!.Amount === "500");
  const both = zohoRows.creditNoteRows({ ...cnLine, creditnote_id: "CN3", creditnote_number: "CN-00601", invoice_number: "WT/26-27/3000", invoices: [{ invoice_id: "I3", invoice_number: "WT/26-27/3000", amount_applied: 1180 }], invoices_credited: [{ invoice_id: "I3", invoice_number: "WT/26-27/3000", credited_amount: 1180 }] });
  ok("  the same invoice in both lists counts once", both.applications.length === 1, both.applications);
  const lines = zoho.fromZoho("invoices", [
    invoiceLine({ "Invoice ID": "1", "Invoice Number": "INV-1", "Item Name": "A", Quantity: "2", "Item Price": "1000", "Discount Amount": "100", "Entity Discount Amount": "500", "E-WayBill Number": "321098765432", "E-WayBill Status": "Cancelled", "e-Invoice Ack Date": "2026-05-10 11:22:33" }),
    invoiceLine({ "Invoice ID": "1", "Invoice Number": "INV-1", "Item Name": "B", Quantity: "1", "Item Price": "3000", "Entity Discount Amount": "500" }),
    invoiceLine({ "Invoice ID": "2", "Invoice Number": "INV-2", "Item Name": "C", "Item Price": "1180", "Is Inclusive Tax": "TRUE" }),
  ]);
  ok("a document's discount spread over its lines as Zoho spreads it, beside a line's own", lines[0]!["Discount amount"] === "300" && lines[1]!["Discount amount"] === "300", lines.map((l) => l["Discount amount"]));
  ok("  a price that included tax taken back to the price before it", lines[2]!.Rate === "1000" && lines[2]!["Discount amount"] === "", lines[2]);
  ok("  a cancelled e-way bill isn't carried; a time is read as its day; the state as its code", lines[0]!["E-way bill number"] === "" && lines[0]!["Ack date"] === "2026-05-10" && lines[0]!["Place of supply"] === "27");
  const note = zoho.fromZoho("credit-notes", [{ "CreditNotes ID": "9", "Credit Note Number": "CN-1", Total: "1180", Balance: "180", "Associated Invoice Number": "INV-1", "Item Name": "A", "Item Price": "1000", "Item Tax %": "18" }]);
  ok("what a credit note applied: its total less what Zoho still shows left", note[0]!["Amount applied"] === "1000" && note[0]!["Against invoice"] === "INV-1", note[0]);
  const paid = zoho.fromZoho("vendor-payments", [{ "VendorPayment ID": "3", "Payment Number": "VP-1", Date: "2026-05-01", "Vendor Name": "Zz", Amount: "500", "Paid Through": "Petty Cash", "Bill Number": "B-1", "Bill Amount": "400" }]);
  const moved = zoho.movementsAsJournals("backup/Transfer_Fund.csv", [{ "Transaction Date": "2026-05-03", "Transaction Type": "Funds Transfer", "From Account": "Zz HDFC", "To Account": "Petty Cash", Reference: "T1", Description: "", "Currency Code": "INR", "Exchange Rate": "1", Total: "2000.000" }]);
  ok("a fund transfer as a journal of two lines: the money to where it went, from where it came", moved.length === 2 && moved[0]!.Account === "Petty Cash" && moved[0]!.Debit === "2000" && moved[1]!.Account === "Zz HDFC" && moved[1]!.Credit === "2000" && moved[0]!["Journal Number"] === "Transfer_Fund 1", moved);
  const refunded = zoho.movementsAsJournals("Refund.csv", [{ Date: "2026-05-04", "Credit Note Number": "CN-1", "Customer Name": "Zz Acme", "Mode of Refund": "Bank Transfer", "Exchange Rate": "1", "Refund From Account": "Zz HDFC", "Refund From Account Code": "", Amount: "180", Description: "", "Reference Number": "R1" }]);
  ok("  a refund: the customer's receivable up, the money out of the bank", refunded[0]!.Account === "Accounts Receivable" && refunded[0]!["Contact Name"] === "Zz Acme" && refunded[0]!.Debit === "180" && refunded[1]!.Account === "Zz HDFC", refunded);
  const apps = zoho.creditApplications([
    { Date: "2026-05-05", "Credit Note Number": "CN-1", "Invoice Number": "INV-9", "Applied Invoice Date": "2026-05-01", Amount: "800" },
    { Date: "2026-05-05", "Credit Note Number": "CN-2", "Invoice Number": "INV-1", "Applied Invoice Date": "2026-05-01", Amount: "100" },
    { Date: "2026-05-05", "Credit Note Number": "CN-2", "Invoice Number": "INV-2", "Applied Invoice Date": "2026-05-01", Amount: "50" },
  ]);
  const applied = zoho.fromZoho("credit-notes", [{ "CreditNotes ID": "9", "Credit Note Number": "CN-1", Total: "1180", Balance: "0", "Associated Invoice Number": "INV-1", "Item Name": "A", "Item Price": "1000", "Item Tax %": "18" }], apps);
  ok("  Zoho's applications file says what a note was set against — not its total less its balance, which counts a refund", applied[0]!["Against invoice"] === "INV-9" && applied[0]!["Amount applied"] === "800", applied[0]);
  const split = zoho.fromZoho("credit-notes", [{ "CreditNotes ID": "10", "Credit Note Number": "CN-2", Total: "236", Balance: "86", "Item Name": "A", "Item Price": "200", "Item Tax %": "18" }], apps);
  ok("  one set against two invoices: the first as its own, the second along with it", split[0]!["Against invoice"] === "INV-1" && split[0]!["Amount applied"] === "100" && split[0]!["Also applied to"] === "INV-2=50", split[0]);
  const quotes = zoho.fromZoho("quotes", [
    { "Quote ID": "1", "Quote Number": "QT-1", "Quote Date": "2026-06-01", "Quote Status": "sent", "Customer Name": "Zz", "Item Name": "A", Quantity: "1", "Item Price": "100", "Item Tax %": "18", Total: "118" },
    { "Quote ID": "2", "Quote Number": "QT-2", "Quote Date": "2026-06-01", "Quote Status": "invoiced", "Customer Name": "Zz", "Item Name": "A", Quantity: "1", "Item Price": "100", "Item Tax %": "18", Total: "118" },
    { "Quote ID": "3", "Quote Number": "QT-3", "Quote Date": "2026-06-01", "Quote Status": "accepted", "Customer Name": "Zz", "Item Name": "A", Quantity: "1", "Item Price": "100", "Item Tax %": "18", Total: "118" },
  ]);
  ok("open quotes: the sent one issued, the accepted one accepted, the invoiced one left behind", quotes.length === 2 && quotes[0]!.Status === "Sent" && quotes[1]!.Status === "Accepted", quotes.map((q) => [q.Number, q.Status]));

  // The open quotes the check refused on crm.wroffy.com (owner, 23 Nov 2026 — five rows, "Its lines come to …").
  const q = (id: string, extra: Record<string, string>) => ({ "Quote ID": id, "Quote Number": `WT/26-27/QT/${id}`, "Quote Date": "2026-09-11", "Quote Status": "sent", "Customer Name": "Zz", "Item Tax %": "18", ...extra });
  const twice = zoho.fromZoho("quotes", [
    q("3131", { "Item Name": "CorelDRAW", Quantity: "1.00", "Item Price": "19000", "Item Total": "19000", SubTotal: "19000", Total: "22420" }),
    q("3131", { "Item Name": "CorelDRAW", Quantity: "1.00", "Item Price": "19000", "Item Total": "19000", SubTotal: "19000", Total: "22420" }),
  ]);
  ok("QT/3131 read twice, its one line twice over: one line, its subtotal Zoho's", twice.length === 1 && twice[0]!.Rate === "19000", twice);
  const alike = zoho.fromZoho("quotes", [
    q("50", { "Item Name": "Seat", Quantity: "1", "Item Price": "100", "Item Total": "100", SubTotal: "200", Total: "236" }),
    q("50", { "Item Name": "Seat", Quantity: "1", "Item Price": "100", "Item Total": "100", SubTotal: "200", Total: "236" }),
  ]);
  ok("  two lines rightly alike, adding up to the subtotal: both kept", alike.length === 2, alike.length);
  const again = zoho.fromZoho("quotes", [
    q("60", { "Item Name": "Old", Quantity: "1", "Item Price": "100", Total: "118" }),
    q("61", { "Item Name": "Other", Quantity: "1", "Item Price": "50", Total: "59" }),
    q("60", { "Item Name": "New", Quantity: "2", "Item Price": "100", Total: "236" }),
  ]);
  ok("  the same quote again further on: the later copy stands, once", again.filter((r) => r.Number === "WT/26-27/QT/60").length === 1 && again.find((r) => r.Number === "WT/26-27/QT/60")!.Item === "New", again.map((r) => [r.Number, r.Item]));
  const byLineId = zoho.fromZoho("quotes", [
    q("70", { "Line Item ID": "L1", "Item Name": "A", Quantity: "1", "Item Price": "10", Total: "23.6" }),
    q("70", { "Line Item ID": "L2", "Item Name": "A", Quantity: "1", "Item Price": "10", Total: "23.6" }),
    q("70", { "Line Item ID": "L1", "Item Name": "A", Quantity: "1", "Item Price": "10", Total: "23.6" }),
  ]);
  ok("  with Zoho's line ids: a line read twice once, two lines alike both", byLineId.length === 2, byLineId.length);
  const lineOff = zoho.fromZoho("quotes", [
    q("724", { "Discount Type": "item_level", "Entity Discount Amount": "11200", "Item Name": "Fusion", Quantity: "1", "Item Price": "560000", "Discount Amount": "11200", "Item Total": "548800", Total: "647584" }),
    q("724", { "Discount Type": "item_level", "Entity Discount Amount": "11200", "Item Name": "Wroffy Support", Quantity: "1", "Item Price": "0", "Item Total": "0", Total: "647584" }),
  ]);
  ok("QT/724's 2% off its line comes off once, not again as one on the whole quote", lineOff[0]!["Discount amount"] === "11200" && lineOff[1]!["Discount amount"] === "", lineOff.map((l) => l["Discount amount"]));
  const sameSum = zoho.fromZoho("quotes", [
    q("2641", { "Entity Discount Amount": "360000", "Item Name": "Support", Quantity: "36", "Item Price": "100000", "Discount Amount": "360000", Total: "3823200" }),
  ]);
  ok("  QT/2641 with no discount type: a whole discount that is the lines' own isn't taken twice", sameSum[0]!["Discount amount"] === "360000", sameSum[0]);
  const none = zoho.fromZoho("quotes", [
    q("1266", { "Item Name": "Website", Quantity: "1.00", "Item Price": "100000", Total: "132160" }),
    q("1266", { "Item Name": "SSL", Quantity: "3.00", "Item Price": "4000", Total: "132160" }),
    q("1266", { "Item Name": "Content writing", Quantity: "0.00", "Item Price": "3", Total: "132160" }),
  ]);
  ok("QT/1266's line of none at ₹3 a word: left out, not read as one — and the quote still held to Zoho's total", none.length === 2 && none.every((l) => l.Item !== "Content writing") && none[0]!.Total === "132160", none.map((l) => [l.Item, l.Quantity, l.Total]));
  const blankQty = zoho.fromZoho("quotes", [q("80", { "Item Name": "A", "Item Price": "100", Total: "118" })]);
  ok("  a quantity left blank is still one", blankQty[0]!.Quantity === "1", blankQty[0]);
  const pulledQuote = zohoRows.quoteRows({ estimate_id: "E1", estimate_number: "QT-9", status: "sent", discount_type: "item_level", discount_total: 11200, line_items: [{ line_item_id: "LI-1", name: "Fusion", quantity: 1, rate: 560000, discount_amount: 11200, item_total: 548800 }] });
  ok("  pulled from Zoho: an item-level discount isn't the whole quote's, and each line carries Zoho's line id", pulledQuote[0]!["Entity Discount Amount"] === "0" && pulledQuote[0]!["Line Item ID"] === "LI-1", pulledQuote[0]);
  const orders = zoho.fromZoho("sales-orders", [
    { "SalesOrder ID": "5", "SalesOrder Number": "SO-1", "Order Date": "2026-06-02", Status: "approved", "Customer Name": "Zz", "Item Name": "A", QuantityOrdered: "10", QuantityInvoiced: "4", QuantityCancelled: "0", "Item Price": "100", "Item Tax %": "18", Total: "1180" },
    { "SalesOrder ID": "5", "SalesOrder Number": "SO-1", "Order Date": "2026-06-02", Status: "approved", "Customer Name": "Zz", "Item Name": "B", QuantityOrdered: "1", QuantityInvoiced: "1", QuantityCancelled: "0", "Item Price": "50", "Item Tax %": "18", Total: "1180" },
  ]);
  ok("  a sales order part invoiced: what is left of its open line, its total not held to Zoho's", orders.length === 1 && orders[0]!.Quantity === "6" && orders[0]!.Total === "", orders);
  const rounded = zoho.fromZoho("invoices", [
    invoiceLine({ "Invoice ID": "8.80908E+17", "Invoice Number": "R-1", "Item Name": "A", "Item Price": "100", Total: "118" }),
    invoiceLine({ "Invoice ID": "8.80908E+17", "Invoice Number": "R-2", "Item Name": "B", "Item Price": "200", "Entity Discount Amount": "20", Total: "212.4" }),
  ]);
  ok("ids a spreadsheet rounded: two invoices still two, each by its number", rounded.length === 2 && rounded[0]!["Discount amount"] === "" && rounded[1]!["Discount amount"] === "20", rounded.map((r) => [r.Number, r["Discount amount"]]));
  /* eslint-disable @typescript-eslint/no-require-imports */
  const archiveLib = require("../src/lib/migration/archive") as typeof import("../src/lib/migration/archive");
  /* eslint-enable @typescript-eslint/no-require-imports */
  ok(
    "an invoice dated as Zoho may write it — \"06 Aug 2017\", \"Aug 06, 2017\", \"06/08/2017\" — goes to the archive; this year's stays",
    ["06 Aug 2017", "Aug 06, 2017", "06/08/2017", "2017-08-06 10:22:00"].every((d) => archiveLib.belongsInArchive("invoices", { "Invoice Date": d }, "2026-04-01")) && !archiveLib.belongsInArchive("invoices", { "Invoice Date": "13 Jul 2026" }, "2026-04-01"),
  );
  ok(
    "  a quote, order or PO still \"open\" but raised before the year goes to the archive; one open this year stays live",
    archiveLib.belongsInArchive("purchase-orders", { "Purchase Order Date": "12 Mar 2021", "Purchase Order Status": "Issued" }, "2026-04-01") && !archiveLib.belongsInArchive("sales-orders", { "Order Date": "2026-06-02", Status: "approved" }, "2026-04-01"),
  );
  const bad = archiveLib.unreadableDates("invoices", [{ "Invoice Date": "sometime in 2017" }, { "Invoice Date": "2017-08-06" }]);
  ok("  a date that still can't be read is counted, with one as written", bad?.rows === 1 && bad.example === "sometime in 2017", bad);
  ok("  a purchase order Zoho shows billed stays behind", zoho.fromZoho("purchase-orders", [{ "Purchase Order ID": "7", "Purchase Order Number": "PO-1", "Purchase Order Date": "2026-06-03", "Purchase Order Status": "billed", "Vendor Name": "Zz", "Item Name": "A", QuantityOrdered: "1", "Item Price": "10" }]).length === 0);
  ok("  and a vendor payment: Zoho's Bill Amount is what went to that bill", paid[0]!["Amount applied"] === "400" && paid[0]!.Bill === "B-1" && paid[0]!["Paid through"] === "Petty Cash", paid[0]);
}

async function scenario() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const actions = require("../src/actions/migration") as typeof import("../src/actions/migration");
  const state = require("../src/lib/migration/state") as typeof import("../src/lib/migration/state");
  const steps = require("../src/lib/migration/steps") as typeof import("../src/lib/migration/steps");
  const upload = require("../src/lib/migration/upload") as typeof import("../src/lib/migration/upload");
  const accounts = require("../src/lib/migration/accounts") as typeof import("../src/lib/migration/accounts");
  const balances = require("../src/lib/migration/balances") as typeof import("../src/lib/migration/balances");
  const journal = require("../src/lib/ledger/journal") as typeof import("../src/lib/ledger/journal");
  const route = require("../src/app/api/migration/upload/route") as typeof import("../src/app/api/migration/upload/route");
  /* eslint-enable @typescript-eslint/no-require-imports */

  await journal.ensureChartOfAccounts();
  const boss = await db.user.create({ data: { name: "Zz Boss", email: "boss@zzzoho.invalid", role: "ADMIN", passwordHash: "x".repeat(60) } });
  actorId = boss.id;
  const acme = await db.company.create({ data: { name: "Zz Acme Traders", normalizedName: "zz acme traders", relationshipType: "CLIENT", createdById: boss.id } });
  await db.companyLocation.create({ data: { companyId: acme.id, label: "Head office", isPrimary: true, state: "Maharashtra", gstNumber: "27AAACZ1234F1Z5", gstTreatment: "REGISTERED_REGULAR", city: "Pune", address: "1 Road", pincode: "411001", country: "India" } });
  const widget = await db.item.create({ data: { name: "Zz Widget (Deskzo's name)", sku: "ZZ-WIDGET", type: "GOOD", sellingPrice: 1000, createdById: boss.id } });
  const steel = await db.company.create({ data: { name: "Zz Steel Supplies", normalizedName: "zz steel supplies", relationshipType: "VENDOR", createdById: boss.id } });
  await db.companyLocation.create({ data: { companyId: steel.id, label: "Head office", isPrimary: true, state: "Maharashtra", gstNumber: "27AAACS1111A1Z1", gstTreatment: "REGISTERED_REGULAR", city: "Pune", address: "2 Road", pincode: "411001", country: "India" } });
  const hdfcLedger = await db.ledgerAccount.create({ data: { code: "ZZ-HDFC", name: "Zz HDFC Current", type: "ASSET" } });
  await db.bankAccount.create({ data: { name: "Zz HDFC", ledgerAccountId: hdfcLedger.id } });
  // What the old-CRM import's master lists logged: Zoho's ids for the company and the item.
  const run = await db.legacyImport.create({ data: { createdById: boss.id, status: "DONE" } });
  await db.legacyImportRecord.createMany({
    data: [
      { importId: run.id, kind: "zoho_contacts", oldId: ACME_ZOHO, recordId: acme.id, action: "LINKED" },
      { importId: run.id, kind: "zoho_items", oldId: WIDGET_ZOHO, recordId: widget.id, action: "LINKED" },
    ],
  });

  section("A backup, sorted");
  const started = await actions.startMigrationAction({ source: "zoho-books", yearStart: "2026-04-01", switchDate: "2026-07-01" });
  ok("a migration from Zoho Books, April to June", started.ok, started);
  const m = (await state.openMigration())!;
  const zip = new JSZip();
  zip.file(
    "backup/Invoice/Invoice00.csv",
    csv([
      invoiceLine({ "Invoice ID": "1001", "Invoice Number": "ZZZ-INV-1", "Customer ID": ACME_ZOHO, "Customer Name": "Zz Acme (as Zoho calls it)", "Item Name": "Widget", "Product ID": WIDGET_ZOHO, Quantity: "2", "Item Price": "1000", "Discount Amount": "100", "Entity Discount Amount": "500", "Shipping Charge": "500", "Shipping Charge Tax %": "18", Adjustment: "-2", Total: "5780" }),
      invoiceLine({ "Invoice ID": "1001", "Invoice Number": "ZZZ-INV-1", "Customer ID": ACME_ZOHO, "Customer Name": "Zz Acme (as Zoho calls it)", "Item Name": "Zz Setup service", Quantity: "1", "Item Price": "3000", "Entity Discount Amount": "500", "Shipping Charge": "500", "Shipping Charge Tax %": "18", Adjustment: "-2", Total: "5780" }),
    ]),
  );
  zip.file(
    "backup/Invoice/Invoice01.csv",
    csv([
      invoiceLine({ "Invoice ID": "1002", "Invoice Number": "ZZZ-INV-2", "Invoice Date": "2026-05-12", "Customer Name": "Zz Acme Traders", "Item Name": "Zz Cable", "Item Price": "1180", "Is Inclusive Tax": "TRUE", Total: "1180" }),
      // The customer deducts 10% TDS on ₹10,000: ₹11,800 with tax, ₹10,800 to be paid.
      invoiceLine({ "Invoice ID": "1003", "Invoice Number": "ZZZ-INV-3", "Invoice Date": "2026-05-14", "Customer Name": "Zz Acme Traders", "Item Name": "Zz Consulting", "Item Price": "10000", "TDS Percentage": "10", "TDS Amount": "1000", "TDS Section Code": "194J", Total: "10800" }),
    ]),
  );
  zip.file(
    "backup/Customer_Payment.csv",
    csv([
      { "Payment Number": "ZZZ-PAY-1", "CustomerPayment ID": "5001", Mode: "Bank Transfer", CustomerID: ACME_ZOHO, Description: "", Amount: "5780", "Unused Amount": "0", "Reference Number": "UTR1", "Customer Name": "Zz Acme (as Zoho calls it)", Date: "2026-05-20", "Deposit To": "Undeposited Funds", "Invoice Number": "ZZZ-INV-1", "Amount Applied to Invoice": "5780" },
      // ₹980 came in and ₹100 the customer withheld as TDS: ₹1,080 applied to the invoice, what it owed after its credit note.
      { "Payment Number": "ZZZ-PAY-2", "CustomerPayment ID": "5002", Mode: "Bank Transfer", CustomerID: ACME_ZOHO, Description: "", Amount: "980", "Unused Amount": "0", "Reference Number": "UTR2", "Customer Name": "Zz Acme (as Zoho calls it)", Date: "2026-05-21", "Deposit To": "Zz HDFC", "Invoice Number": "ZZZ-INV-2", "Amount Applied to Invoice": "1080", "Withholding Tax Amount": "100" },
      // ₹100 paid on 11 May ahead of ZZZ-INV-3, raised on the 14th — an advance Zoho set against it once raised.
      { "Payment Number": "ZZZ-PAY-4", "CustomerPayment ID": "5004", Mode: "Bank Transfer", CustomerID: ACME_ZOHO, Description: "", Amount: "100", "Unused Amount": "0", "Reference Number": "UTR4", "Customer Name": "Zz Acme (as Zoho calls it)", Date: "2026-05-11", "Deposit To": "Zz HDFC", "Invoice Number": "ZZZ-INV-3", "Amount Applied to Invoice": "100" },
      // ₹200 this year against an earlier invoice, ZZZ-OLD-1: it comes across once that invoice is opened from the archive.
      { "Payment Number": "ZZZ-PAY-3", "CustomerPayment ID": "5003", Mode: "Bank Transfer", CustomerID: ACME_ZOHO, Description: "", Amount: "200", "Unused Amount": "0", "Reference Number": "UTR3", "Customer Name": "Zz Acme (as Zoho calls it)", Date: "2026-06-02", "Deposit To": "Zz HDFC", "Invoice Number": "ZZZ-OLD-1", "Amount Applied to Invoice": "200" },
      { "Payment Number": "", "CustomerPayment ID": "", Mode: "", CustomerID: "", Description: "", Amount: "", "Unused Amount": "", "Reference Number": "", "Customer Name": "", Date: "", "Deposit To": "", "Invoice Number": "", "Amount Applied to Invoice": "" },
    ]),
  );
  zip.file(
    "backup/Expense.csv",
    csv([{ "Expense Date": "2026-05-02", "Expense Description": "May rent", "Expense Account": "Rent Expense", "Expense Account Code": "", "Paid Through": "Zz HDFC", "Paid Through Account Code": "", Vendor: "", "Source of Supply": "", "Is Inclusive Tax": "false", "Tax Name": "", "Tax Percentage": "", "Tax Amount": "0", "Expense Amount": "10000", Total: "10000", "Reference#": "RENT-MAY", "Expense Reference ID": "7001" }]),
  );
  zip.file(
    "backup/Chart_of_Accounts.csv",
    csv(
      [
        ["Cash", "Undeposited Funds"],
        ["Expense", "Rent Expense"],
        ["Expense", "Janitorial Expense"],
        ["Bank", "Zz HDFC"],
        ["Accounts Receivable", "Accounts Receivable"],
      ].map(([type, name]) => ({ "Account ID": "", "Account Name": name!, "Account Code": "", Description: "", "Account Type": type!, "Account Status": "Active", Currency: "INR", "Parent Account": "" })),
    ),
  );
  zip.file(
    "backup/Credit_Note.csv",
    csv([{ "Credit Note Date": "2026-05-16", "CreditNotes ID": "8001", "Credit Note Number": "ZZZ-CN-1", "Credit Note Status": "Closed", "Customer Name": "Zz Acme (as Zoho calls it)", "Customer ID": ACME_ZOHO, Total: "236", Balance: "86", "Associated Invoice Number": "ZZZ-INV-2", "Item Name": "Zz Cable return", Quantity: "1", "Item Price": "200", "Item Tax %": "18", "Place of Supply(With State Code)": "27-Maharashtra" }]),
  );
  zip.file(
    "backup/Creditnotes_Invoice.csv",
    csv([
      { Date: "2026-05-16", "Credit Note Number": "ZZZ-CN-1", "Invoice Number": "ZZZ-INV-2", "Applied Invoice Date": "2026-05-12", Amount: "100" },
      { Date: "2026-05-16", "Credit Note Number": "ZZZ-CN-1", "Invoice Number": "ZZZ-INV-3", "Applied Invoice Date": "2026-05-14", Amount: "50" },
    ]),
  );
  zip.file("backup/Transfer_Fund.csv", csv([{ "Transaction Date": "2026-05-03", "Transaction Type": "Funds Transfer", "From Account": "Zz HDFC", "To Account": "Petty Cash", Reference: "T1", Description: "", "Currency Code": "INR", "Exchange Rate": "1", Total: "2000.000" }]));
  zip.file(
    "backup/Invoice/Invoice02.csv",
    csv([invoiceLine({ "Invoice ID": "900", "Invoice Number": "ZZZ-OLD-1", "Invoice Date": "10-03-2025", "Customer ID": ACME_ZOHO, "Customer Name": "Zz Acme (as Zoho calls it)", "Item Name": "Zz Old work", "Item Price": "1000", Total: "1180", Balance: "500", "Invoice Status": "PartiallyPaid" })]),
  );
  zip.file(
    "backup/Expense_old.csv",
    csv([{ "Expense Date": "2025-01-05", "Expense Description": "Old rent", "Expense Account": "Rent Expense", "Expense Account Code": "", "Paid Through": "Zz HDFC", "Paid Through Account Code": "", Vendor: "", "Source of Supply": "", "Is Inclusive Tax": "false", "Tax Name": "", "Tax Percentage": "", "Tax Amount": "0", "Expense Amount": "9000", Total: "9000", "Reference#": "RENT-JAN", "Expense Reference ID": "6001" }]),
  );
  zip.file(
    "backup/Quote/Quote00.csv",
    csv([
      { "Quote ID": "31", "Quote Number": "ZZZ-QT-1", "Quote Date": "2026-06-01", "Quote Status": "sent", "Customer ID": ACME_ZOHO, "Customer Name": "Zz Acme (as Zoho calls it)", "Expiry Date": "2026-07-31", "Item Name": "Zz Proposal line", Quantity: "1", "Item Price": "1000", "Item Tax %": "18", "Discount Amount": "0", Total: "1180", "Place of Supply(With State Code)": "27-Maharashtra", "HSN/SAC": "8571500" },
      { "Quote ID": "32", "Quote Number": "ZZZ-QT-2", "Quote Date": "2024-06-01", "Quote Status": "invoiced", "Customer ID": ACME_ZOHO, "Customer Name": "Zz Acme (as Zoho calls it)", "Expiry Date": "", "Item Name": "Zz Old proposal", Quantity: "1", "Item Price": "500", "Item Tax %": "18", "Discount Amount": "0", Total: "590", "Place of Supply(With State Code)": "27-Maharashtra" },
    ]),
  );
  zip.file(
    "backup/Sales_Order.csv",
    csv([{ "SalesOrder ID": "41", "SalesOrder Number": "ZZZ-SO-1", "Order Date": "2026-06-02", Status: "approved", "Customer ID": ACME_ZOHO, "Customer Name": "Zz Acme (as Zoho calls it)", "Item Name": "Zz Licences", "Product ID": WIDGET_ZOHO, QuantityOrdered: "10", QuantityInvoiced: "4", QuantityCancelled: "0", "Item Price": "100", "Item Tax %": "18", "Discount Amount": "0", Total: "1180", "Place of Supply(With State Code)": "27-Maharashtra" }]),
  );
  zip.file(
    "backup/Purchase_Order.csv",
    csv([{ "Purchase Order ID": "51", "Purchase Order Number": "ZZZ-PO-1", "Purchase Order Date": "2026-06-03", "Purchase Order Status": "Issued", "Vendor Name": "Zz Steel Supplies", "Item Name": "Zz Steel", QuantityOrdered: "2", QuantityBilled: "0", QuantityCancelled: "0", "Item Price": "500", "Item Tax %": "18", "Discount Amount": "0", Total: "1180", "Destination of Supply": "MH" }]),
  );
  zip.file("backup/Contacts.csv", csv([{ "Contact ID": ACME_ZOHO, "Display Name": "Zz Acme" }]));
  const bytes = await zip.generateAsync({ type: "nodebuffer" });
  const read = await upload.readMigrationUpload([{ name: "zoho-backup.zip", bytes }]);
  const outcome = await upload.storeUpload(m, read, null, boss.id);
  const invoices = outcome.stored.find((s) => s.step === "invoices");
  ok("the invoice file's three parts are one step's file: three invoices of the year, the earlier one apart", invoices?.units === 3 && invoices.files.length === 3 && invoices.zoho, invoices);
  ok("  the payments and the expenses to their steps — a trimmed file's empty rows dropped", outcome.stored.find((s) => s.step === "receipts")?.units === 4 && outcome.stored.find((s) => s.step === "expenses")?.units === 1, outcome.stored);
  ok("  the chart to the old chart's map; the contacts named as left out", outcome.chart?.accounts === 5 && outcome.left.some((n) => n.endsWith("Contacts.csv")), { chart: outcome.chart, left: outcome.left });
  ok("  nothing else unread", outcome.stored.every((s) => s.unknown.length === 0), outcome.stored.map((s) => s.unknown));
  ok("  the earlier years kept apart: the old invoice and the invoiced quote archived, the old expense left to the opening balances", outcome.archived.some((a) => a.kind === "INVOICE" && a.count === 1) && outcome.archived.some((a) => a.kind === "QUOTE" && a.count === 1) && outcome.earlier.some((e) => e.step === "expenses" && e.rows === 1), { archived: outcome.archived, earlier: outcome.earlier });
  ok("  the open quote, sales order and PO to their steps", ["quotes", "sales-orders", "purchase-orders"].every((k) => outcome.stored.find((s) => s.step === k)?.units === 1), outcome.stored.map((s) => [s.step, s.units]));
  ok("  the fund transfer with the manual journals", outcome.stored.find((s) => s.step === "journals")?.units === 1, outcome.stored.find((s) => s.step === "journals"));

  section("The old chart");
  const listed = await actions.migrationAccounts();
  const rows = listed.ok ? listed.data.rows : [];
  const ledger = new Map((await db.ledgerAccount.findMany({ select: { id: true, code: true, systemKey: true, name: true } })).map((a) => [a.id, a]));
  const readAs = (name: string) => ledger.get(rows.find((r) => r.name === name)?.accountId ?? "");
  ok("Undeposited Funds as the bank, Rent Expense as Rent, the bank by its name, the receivable as Deskzo's", readAs("Undeposited Funds")?.systemKey === "BANK" && readAs("Rent Expense")?.name === "Rent" && readAs("Zz HDFC")?.id === hdfcLedger.id && readAs("Accounts Receivable")?.systemKey === "AR", rows.map((r) => [r.name, r.accountId && ledger.get(r.accountId)?.name, r.reason]));
  const janitorial = rows.find((r) => r.name === "Janitorial Expense");
  ok("  one waits for a choice, and can be made new", !!janitorial && janitorial.accountId === null && janitorial.canMake);
  const early = await balances.uploadBalances(m, [{ Month: "Apr 2026", Account: "Janitorial Expense", Debit: "500", Credit: "" }], null);
  ok("  a trial balance naming it before then says to choose it in the old chart", early.failed.length === 1 && /choose one for it in The old chart/.test(early.failed[0]!.error), early.failed);
  const rest = await actions.makeRestOfChartNew();
  const madeId = (await db.migrationAccount.findFirst({ where: { migrationId: m.id, name: "Janitorial Expense" }, select: { accountId: true } }))?.accountId;
  const madeAccount = madeId ? await db.ledgerAccount.findUnique({ where: { id: madeId }, select: { code: true, name: true, type: true, parent: { select: { code: true } } } }) : null;
  ok("Make the rest new: the one waiting made, none left", rest.ok && rest.data.made === 1 && rest.data.left.length === 0, rest);
  ok("  made: under Expenses, with the next code there", madeAccount?.name === "Janitorial Expense" && madeAccount.type === "EXPENSE" && madeAccount.parent?.code === "5000" && madeAccount.code === "5901", madeAccount);
  ok("  nothing left waiting", (await accounts.accountsWaiting(m.id)) === 0);

  // Zoho's trial balance on the day before the year, as exported, for the opening balances (owner, 28 Oct 2026).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const openingLib = require("../src/lib/portability/opening-balances") as typeof import("../src/lib/portability/opening-balances");
  const openingPlan = await openingLib.planOpeningBalances(
    [
      { Account: "Assets", "Account Code": "", "Net Debit": "", "Net Credit": "" },
      { Account: "Undeposited Funds", "Account Code": "", "Net Debit": "5000", "Net Credit": "0" },
      { Account: "Rent Expense", "Account Code": "", "Net Debit": "1000", "Net Credit": "0" },
      { Account: "Accounts Receivable", "Account Code": "", "Net Debit": "2500", "Net Credit": "0" },
      { Account: "Total for Trial Balance", "Account Code": "", "Net Debit": "8500", "Net Credit": "8500" },
    ],
    { openingDate: "2026-04-01" },
  );
  const openRow = (name: string) => openingPlan.rows.find((r) => r.label.endsWith(` · ${name}`));
  ok(
    "the opening balances, from Zoho's trial balance as exported: its names read through the old chart, nothing refused",
    openingPlan.errors === 0 && openingPlan.rows.filter((r) => r.action === "create").length === 1 && !!openRow(ledger.get(readAs("Undeposited Funds")!.id)!.name),
    openingPlan.rows,
  );
  ok(
    "  last year's expense (Rent, on the year's first day) left out with a word — it closed into Retained Earnings",
    openingPlan.rows.some((r) => r.action === "skip" && r.label === "Rent Expense" && /closed into Retained Earnings/.test(r.notice ?? "")),
    openingPlan.rows,
  );
  ok(
    "  the receivables total left out with a word — the open invoices bring it, customer by customer",
    openingPlan.rows.some((r) => r.action === "skip" && /open invoices/.test(r.notice ?? "")),
    openingPlan.rows,
  );

  section("Bringing them across");
  const files = await steps.stepFiles(m);
  const bring = async (step: string) => {
    const f = files.find((x) => x.step === step)!;
    const checked = await actions.checkMigrationPart(f.id, 0);
    const brought = await actions.importMigrationPart(f.id);
    return { checked: checked.ok ? checked.data.outcomes : checked, brought: brought.ok ? brought.data : brought };
  };
  const inv = await bring("invoices");
  ok("the three invoices check and come across", inv.brought && "created" in inv.brought && inv.brought.created === 3, inv);
  const one = await db.tradeDocument.findUnique({ where: { docNumber: "ZZZ-INV-1" }, select: { companyId: true, total: true, shippingCharge: true, adjustment: true, lines: { orderBy: { sortOrder: "asc" }, select: { itemId: true, discountMode: true, discountValue: true } } } });
  ok("ZZZ-INV-1: Acme found by Zoho's customer id though Zoho calls it otherwise; the widget by Zoho's item id", one?.companyId === acme.id && one.lines[0]?.itemId === widget.id, one);
  ok("  its discounts as amounts, its freight and adjustment kept, its total Zoho's", Number(one?.total) === 5780 && Number(one?.shippingCharge) === 500 && Number(one?.adjustment) === -2 && !!one?.lines.every((l) => l.discountMode === "AMOUNT" && Number(l.discountValue) === 300), one);
  const two = await db.tradeDocument.findUnique({ where: { docNumber: "ZZZ-INV-2" }, select: { total: true, lines: { select: { unitPrice: true } } } });
  ok("ZZZ-INV-2, priced with tax: ₹1,000 and its tax, ₹1,180 in all", Number(two?.total) === 1180 && Number(two?.lines[0]?.unitPrice) === 1000, two);
  const three = await db.tradeDocument.findUnique({ where: { docNumber: "ZZZ-INV-3" }, select: { total: true, withholdingAmount: true, withholdingSection: true } });
  const tdsReceivable = [...ledger.values()].find((a) => a.systemKey === "TDS_RECEIVABLE")!;
  const tdsPosted = await db.journalLine.aggregate({ where: { accountId: tdsReceivable.id }, _sum: { debit: true } });
  ok("ZZZ-INV-3: the customer's 10% TDS under 194J, ₹10,800 to collect, ₹1,000 to TDS Receivable", Number(three?.total) === 10800 && Number(three?.withholdingAmount) === -1000 && three?.withholdingSection === "194J" && Number(tdsPosted._sum.debit) === 1000, { three, tds: tdsPosted._sum });
  const note = await bring("credit-notes");
  const noteDoc = await db.tradeDocument.findUnique({ where: { docNumber: "ZZZ-CN-1" }, select: { id: true } });
  const noteApps = noteDoc ? await db.creditNoteApplication.findMany({ where: { creditNoteId: noteDoc.id }, select: { amount: true, invoice: { select: { docNumber: true } } } }) : [];
  ok("a credit note Zoho set against two invoices: ₹100 to ZZZ-INV-2 and ₹50 to ZZZ-INV-3, the rest left as credit", note.brought && "created" in note.brought && note.brought.created === 1 && noteApps.length === 2 && noteApps.some((a) => a.invoice.docNumber === "ZZZ-INV-2" && Number(a.amount) === 100) && noteApps.some((a) => a.invoice.docNumber === "ZZZ-INV-3" && Number(a.amount) === 50), { note, noteApps });
  const pay = await bring("receipts");
  const payment = await db.payment.findFirst({ where: { reference: "UTR1" }, select: { bankAccountId: true, companyId: true, allocations: { select: { amount: true } } } });
  ok("the payment into Undeposited Funds lands where Record payment puts it, applied to its invoice", pay.brought && "created" in pay.brought && pay.brought.created === 3 && payment?.bankAccountId === null && payment.companyId === acme.id && Number(payment.allocations[0]?.amount) === 5780, { pay, payment });
  const inv2 = await db.tradeDocument.findUnique({ where: { docNumber: "ZZZ-INV-2" }, select: { id: true, status: true } });
  const pay2 = await db.payment.findMany({ where: { companyId: acme.id, paidOn: new Date("2026-05-21T00:00:00Z") }, select: { amount: true, method: true, reference: true, bankAccountId: true, allocations: { select: { amount: true, documentId: true } } } });
  const cash2 = pay2.find((p) => p.reference === "UTR2");
  const tds2 = pay2.find((p) => p.reference === "TDS withheld");
  ok(
    "a payment the customer took TDS out of: ₹980 into the bank and ₹100 TDS withheld, both on ZZZ-INV-2, now paid",
    pay.brought && "created" in pay.brought && pay.brought.created === 3 && Number(cash2?.amount) === 980 && Number(cash2?.allocations[0]?.amount) === 980 && Number(tds2?.amount) === 100 && tds2?.method === "OTHER" && tds2.bankAccountId === null && tds2.allocations[0]?.documentId === inv2?.id && Number(tds2.allocations[0]?.amount) === 100 && inv2?.status === "PAID",
    { pay: pay.brought, pay2, inv2 },
  );
  const advance = await db.payment.findFirst({ where: { reference: "UTR4" }, select: { paidOn: true, allocations: { select: { amount: true, document: { select: { docNumber: true } } } } } });
  ok(
    "a payment made ahead of its invoice — an advance — comes on its own date and is set against the invoice raised later",
    advance?.paidOn.toISOString().slice(0, 10) === "2026-05-11" && advance.allocations[0]?.document?.docNumber === "ZZZ-INV-3" && Number(advance.allocations[0]?.amount) === 100 && Array.isArray(pay.checked) && pay.checked.some((o) => /paid ahead of ZZZ-INV-3/.test((o as { detail?: string }).detail ?? "")),
    { advance, checked: pay.checked },
  );
  const tdsLines = await db.journalLine.findMany({ where: { entry: { payment: { reference: "TDS withheld" } } }, select: { debit: true, credit: true, companyId: true, account: { select: { systemKey: true } } } });
  ok(
    "  the TDS posted Dr TDS / TCS Receivable, Cr Acme's receivable — no bank in it",
    tdsLines.length === 2 && tdsLines.some((l) => l.account.systemKey === "TDS_RECEIVABLE" && Number(l.debit) === 100) && tdsLines.some((l) => l.account.systemKey === "AR" && Number(l.credit) === 100 && l.companyId === acme.id),
    tdsLines,
  );
  const exp = await bring("expenses");
  const rent = [...ledger.values()].find((a) => a.name === "Rent")!;
  const rentLines = await db.journalLine.aggregate({ where: { accountId: rent.id }, _sum: { debit: true } });
  const hdfcLines = await db.journalLine.aggregate({ where: { accountId: hdfcLedger.id }, _sum: { credit: true } });
  ok("the rent: Zoho's Rent Expense posted to Rent, out of the HDFC account", exp.brought && "created" in exp.brought && exp.brought.created === 1 && Number(rentLines._sum.debit) === 10000 && Number(hdfcLines._sum.credit) === 10000, { exp, rent: rentLines._sum, hdfc: hdfcLines._sum });

  const moves = await bring("journals");
  const pettyCash = [...ledger.values()].find((a) => a.systemKey === "CASH")!;
  const cashIn = await db.journalLine.aggregate({ where: { accountId: pettyCash.id }, _sum: { debit: true } });
  ok("the fund transfer: ₹2,000 from the HDFC account into petty cash, a contra", moves.brought && "created" in moves.brought && moves.brought.created === 1 && Number(cashIn._sum.debit) === 2000 && (await db.accountVoucher.count({ where: { type: "CONTRA" } })) === 1, { moves, cash: cashIn._sum });

  section("What was still open");
  const qt = await bring("quotes");
  const so = await bring("sales-orders");
  const po = await bring("purchase-orders");
  ok("the open quote, sales order and PO come across", [qt, so, po].every((x) => x.brought && "created" in x.brought && x.brought.created === 1), { qt: qt.brought, so: so.brought, po: po.brought });
  const proposal = await db.tradeDocument.findUnique({ where: { docNumber: "ZZZ-QT-1" }, select: { id: true, docType: true, status: true, companyId: true, validUntil: true, origin: true } });
  const proposalEntries = proposal ? await db.journalEntry.count({ where: { documentId: proposal.id } }) : -1;
  const qtLines = proposal ? await db.tradeDocumentLine.findMany({ where: { documentId: proposal.id }, select: { hsnCode: true } }) : [];
  ok("  its line's HSN/SAC that isn't one (8571500) left off, the quote still brought — set in Deskzo later (owner, 28 Oct 2026)", qtLines.length === 1 && !qtLines[0]!.hsnCode, qtLines);
  ok("  ZZZ-QT-1 a live proposal for Acme, issued, valid to 31 July, posting nothing", proposal?.docType === "PROPOSAL" && proposal.status === "ISSUED" && proposal.companyId === acme.id && proposal.validUntil?.toISOString().slice(0, 10) === "2026-07-31" && proposal.origin === "IMPORTED" && proposalEntries === 0, proposal);
  const proforma = await db.tradeDocument.findUnique({ where: { docNumber: "ZZZ-SO-1" }, select: { docType: true, total: true, lines: { select: { quantity: true, itemId: true } } } });
  ok("  ZZZ-SO-1 a proforma for the 6 licences not yet invoiced", proforma?.docType === "PROFORMA" && Number(proforma.lines[0]?.quantity) === 6 && proforma.lines[0]?.itemId === widget.id && Number(proforma.total) === 708, proforma);
  const vendorPo = await db.tradeDocument.findUnique({ where: { docNumber: "ZZZ-PO-1" }, select: { docType: true, companyId: true } });
  ok("  ZZZ-PO-1 a vendor PO to Zz Steel", vendorPo?.docType === "PURCHASE_ORDER" && vendorPo.companyId === steel.id, vendorPo);

  section("Earlier years");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const archiveLib = require("../src/lib/migration/archive") as typeof import("../src/lib/migration/archive");
  const { ArchivedHistory } = require("../src/components/companies/archived-history") as typeof import("../src/components/companies/archived-history");
  const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const history = await archiveLib.companyArchive(acme.id);
  ok("Acme's earlier years: the old invoice in FY 2024-25 and the invoiced quote, by Zoho's customer id", history.documents.some((d) => d.number === "ZZZ-OLD-1" && d.year === "2024-25" && d.balance === 500) && history.documents.some((d) => d.number === "ZZZ-QT-2" && d.kind === "QUOTE"), history.years);
  const shown = (await renderHtml(ArchivedHistory({ companyId: acme.id }))).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  ok("  its page's Earlier years tab shows them", shown.includes("FY 2024-25") && shown.includes("ZZZ-OLD-1") && shown.includes("500.00 owing"), shown.slice(0, 300));
  const check = await actions.migrationArchive();
  ok("  the per-company check: ZZZ-OLD-1 still owes ₹500 in Zoho, and isn't open in Deskzo", check.ok && check.data.differences.some((d) => d.number === "ZZZ-OLD-1" && d.zoho === 500 && d.deskzo === null), check.ok ? check.data : check);
  const receiptFiles = await db.migrationFile.findMany({ where: { migrationId: m.id, step: "receipts" }, select: { failures: true } });
  const waitingOld = receiptFiles.flatMap((f) => (Array.isArray(f.failures) ? (f.failures as { error?: string }[]) : [])).find((x) => /ZZZ-OLD-1/.test(x.error ?? ""));
  ok("  the receipt waiting for it says where it is: the archive, opened by \"Open the ones still owing\" (owner, 29 Oct 2026)", /isn't in Deskzo\. It's an earlier year's, in the archive: press "Open the ones still owing"/.test(waitingOld?.error ?? ""), waitingOld);
  const opened = await actions.openArchivedDocuments();
  const old1 =await db.tradeDocument.findFirst({ where: { docNumber: "ZZZ-OLD-1", docType: "INVOICE" }, select: { id: true, companyId: true, total: true, paidBefore: true, origin: true } });
  const old1Opening = old1 ? await db.journalLine.findMany({ where: { entry: { documentId: old1.id } }, select: { debit: true, credit: true, entry: { select: { date: true } }, account: { select: { systemKey: true } } } }) : [];
  ok(
    "Open the ones still owing: ZZZ-OLD-1 opened on Acme as it stood on 1 April — ₹500 owing now and ₹200 paid this year, ₹700",
    opened.ok && opened.data.opened === 1 && old1?.companyId === acme.id && old1.origin === "IMPORTED" && Number(old1.total) === 1180 && Number(old1.paidBefore) === 480,
    { opened: opened.ok ? opened.data : opened, old1 },
  );
  ok(
    "  posted on the year's first day: Acme's receivable against Opening Balance Equity, ₹700",
    old1Opening.some((l) => l.account.systemKey === "AR" && Number(l.debit) === 700) && old1Opening.some((l) => l.account.systemKey === "OPENING_BALANCE_EQUITY" && Number(l.credit) === 700) && old1Opening.every((l) => l.entry.date.toISOString().slice(0, 10) === "2026-04-01"),
    old1Opening,
  );
  // "Upload again": the file from the top, what already came passed over.
  await db.migrationFile.updateMany({ where: { migrationId: m.id, step: "receipts" }, data: { done: 0, failures: [] } });
  await bring("receipts");
  const agreed = await actions.migrationArchive();
  ok(
    "  the receipts again: this year's ₹200 comes across onto it, and the per-company check agrees at ₹500",
    agreed.ok && !agreed.data.differences.some((d) => d.number === "ZZZ-OLD-1") && (await db.payment.count({ where: { reference: "UTR3" } })) === 1,
    agreed.ok ? agreed.data.differences : agreed,
  );
  const twice = await actions.openArchivedDocuments();
  ok("  pressing it again opens nothing twice", twice.ok && twice.data.opened === 0 && (await db.tradeDocument.count({ where: { docNumber: "ZZZ-OLD-1" } })) === 1, twice);
  // Its own lines in place of "Brought forward" (owner, 21 Nov 2026 — src/lib/migration/opened-lines.ts): ZZZ-OLD-1's
  // from the archive, Zoho's backup having brought them; its total, what it owes and its opening entry as they were.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const openedLines = require("../src/lib/migration/opened-lines") as typeof import("../src/lib/migration/opened-lines");
  const sums = async (documentId: string) => {
    const lines = await db.journalLine.findMany({ where: { entry: { documentId } }, select: { debit: true, credit: true } });
    return `${lines.reduce((t, l) => t + Number(l.debit), 0)}/${lines.reduce((t, l) => t + Number(l.credit), 0)}/${lines.length}`;
  };
  const old1Before = await db.tradeDocument.findUniqueOrThrow({ where: { id: old1!.id }, select: { paidBefore: true, lines: { select: { name: true } } } });
  const old1Entry = await sums(old1!.id);
  const lined = await openedLines.bringOpenedLines(m, { budgetMs: 30_000, zoho: false });
  const old1Now = await db.tradeDocument.findUniqueOrThrow({
    where: { id: old1!.id },
    select: { total: true, paidBefore: true, cgstAmount: true, sgstAmount: true, igstAmount: true, lines: { orderBy: { sortOrder: "asc" }, select: { name: true, quantity: true, unitPrice: true, taxRatePercent: true, lineTotal: true, description: true } } },
  });
  ok(
    "its own lines on the opened ZZZ-OLD-1, from the archive: the work at ₹1,000 before tax, the GST as billed on a line of its own",
    old1Before.lines.length === 1 && old1Before.lines[0]!.name === "Brought forward" && lined.brought === 1 && old1Now.lines.length === 2 && old1Now.lines[0]!.name === "Zz Old work" && Number(old1Now.lines[0]!.lineTotal) === 1000 && Number(old1Now.lines[0]!.taxRatePercent) === 0 && old1Now.lines[1]!.name === openedLines.CHARGES_LINE && Number(old1Now.lines[1]!.lineTotal) === 180 && /18%/.test(old1Now.lines[1]!.description ?? ""),
    { lined, old1Now },
  );
  ok(
    "  its total, what it owes and its opening entry as they were, and no tax on it",
    Number(old1Now.total) === 1180 && Number(old1Now.paidBefore) === Number(old1Before.paidBefore) && Number(old1Now.cgstAmount) + Number(old1Now.sgstAmount) + Number(old1Now.igstAmount) === 0 && (await sums(old1!.id)) === old1Entry,
    old1Now,
  );
  const linedAgain = await openedLines.bringOpenedLines(m, { budgetMs: 30_000, zoho: false });
  ok("  pressed again: none left on a Brought forward line", linedAgain.brought === 0 && linedAgain.remaining === 0 && (await openedLines.openedWithoutLines(m)) === 0, linedAgain);
  // Void in Zoho, its whole amount still shown as its balance (owner, 8 Nov 2026).
  const voidRow = (number: string, status: string) => ({ migrationId: m.id, kind: "INVOICE", key: `INVOICE:acme:${number}`, number, date: new Date("2025-06-01"), year: "2025-26", partyName: acme.name, companyId: acme.id, status, currency: "INR", total: 1180, balance: 1180 });
  const voidOne = await db.archivedDocument.create({ data: voidRow("ZZZ-VOID-1", "Void") as never });
  // Rejected, or waiting for approval: never issued, its whole amount shown as its balance too (owner, 21 Nov 2026 —
  // WT/25-26/3472, rejected in Zoho, opened here as ₹1,13,280 owing).
  const rejectedOne = await db.archivedDocument.create({ data: voidRow("ZZZ-REJ-1", "Rejected") as never });
  const awaitingOne = await db.archivedDocument.create({ data: voidRow("ZZZ-PA-1", "pending_approval") as never });
  const voidOpens = await actions.openArchivedDocuments();
  ok(
    "void, rejected or awaiting approval in Zoho, whatever its balance: Open the ones still owing leaves it",
    voidOpens.ok && voidOpens.data.opened === 0 && (await db.tradeDocument.count({ where: { docNumber: { in: ["ZZZ-VOID-1", "ZZZ-REJ-1", "ZZZ-PA-1"] } } })) === 0,
    voidOpens,
  );
  const voidChecked = await actions.migrationArchive();
  ok("  and the per-company check doesn't call it owing", voidChecked.ok && !voidChecked.data.differences.some((d) => ["ZZZ-VOID-1", "ZZZ-REJ-1", "ZZZ-PA-1"].includes(d.number)), voidChecked.ok ? voidChecked.data.differences : voidChecked);
  const nothingVoid = await actions.listVoidOpened();
  ok("  nothing to repair yet", nothingVoid.ok && nothingVoid.data.rows.length === 0, nothingVoid);
  // As it was before the fix: opened while it read as owing, and void as Zoho has it.
  const heldOne = await db.archivedDocument.create({ data: voidRow("ZZZ-VOID-2", "Sent") as never });
  await db.archivedDocument.updateMany({ where: { id: { in: [voidOne.id, rejectedOne.id] } }, data: { status: "Sent" } });
  const openedVoid = await actions.openArchivedDocuments();
  await db.archivedDocument.updateMany({ where: { id: { in: [voidOne.id, heldOne.id] } }, data: { status: "Void" } });
  await db.archivedDocument.update({ where: { id: rejectedOne.id }, data: { status: "Rejected" } });
  const voidDoc = await db.tradeDocument.findFirst({ where: { docNumber: "ZZZ-VOID-1", docType: "INVOICE" }, select: { id: true } });
  const heldDoc = await db.tradeDocument.findFirst({ where: { docNumber: "ZZZ-VOID-2", docType: "INVOICE" }, select: { id: true } });
  ok("  (all three opened as they were before the fix, each with an opening entry)", openedVoid.ok && openedVoid.data.opened === 3 && !!voidDoc && !!heldDoc && (await db.journalEntry.count({ where: { documentId: voidDoc.id } })) > 0, openedVoid);
  const held = await db.payment.findFirstOrThrow({ where: { reference: "UTR3" }, select: { id: true } });
  const heldBy = await db.paymentAllocation.create({ data: { paymentId: held.id, documentId: heldDoc!.id, amount: 1, allocatedByUserId: boss.id } });
  const voidList = await actions.listVoidOpened();
  ok(
    "the list: the void one and the rejected one to take back, each with what Zoho calls it, the one a payment touches held, and nothing changed",
    voidList.ok &&
      voidList.data.toTakeBack === 2 &&
      voidList.data.held === 1 &&
      voidList.data.owing === 2360 &&
      voidList.data.rows.find((r) => r.number === "ZZZ-VOID-2")?.held === "A payment is set against it" &&
      voidList.data.rows.find((r) => r.number === "ZZZ-REJ-1")?.zohoStatus === "Rejected" &&
      voidList.data.rows.find((r) => r.number === "ZZZ-VOID-1")?.zohoStatus === "Void" &&
      (await db.tradeDocument.count({ where: { docNumber: { in: ["ZZZ-VOID-1", "ZZZ-REJ-1"] } } })) === 2,
    voidList,
  );
  const receiptsBefore = await db.payment.count();
  const voidGone = await actions.removeVoidOpened();
  ok("  taken back: the invoices and their opening entries go", voidGone.ok && voidGone.data.takenBack === 2 && voidGone.data.more === 0 && (await db.tradeDocument.count({ where: { docNumber: { in: ["ZZZ-VOID-1", "ZZZ-REJ-1"] } } })) === 0 && (await db.journalEntry.count({ where: { documentId: voidDoc!.id } })) === 0, voidGone);
  ok("  the held one stays, with its payment, and no payment goes", (await db.tradeDocument.count({ where: { docNumber: "ZZZ-VOID-2" } })) === 1 && (await db.paymentAllocation.count({ where: { id: heldBy.id } })) === 1 && (await db.payment.count()) === receiptsBefore);
  ok("  and ZZZ-OLD-1, not void, is left alone", (await db.tradeDocument.count({ where: { docNumber: "ZZZ-OLD-1" } })) === 1);
  const voidAgain = await actions.removeVoidOpened();
  ok("  pressing again takes nothing more", voidAgain.ok && voidAgain.data.takenBack === 0);
  const voidNotOpened = await actions.openArchivedDocuments();
  ok("  and Open the ones still owing doesn't bring it back", voidNotOpened.ok && (await db.tradeDocument.count({ where: { docNumber: "ZZZ-VOID-1" } })) === 0, voidNotOpened);
  await db.paymentAllocation.delete({ where: { id: heldBy.id } });
  await db.migrationRecord.deleteMany({ where: { migrationId: m.id, recordId: heldDoc!.id } });
  await db.journalEntry.deleteMany({ where: { documentId: heldDoc!.id } });
  await db.tradeDocument.delete({ where: { id: heldDoc!.id } });
  await db.archivedDocument.deleteMany({ where: { id: { in: [voidOne.id, heldOne.id, rejectedOne.id, awaitingOne.id] } } });
  // In dollars (owner, 17 Nov 2026): shown in dollars, and opened in dollars at the rate for the year's first day.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const rates = require("../src/lib/finance/rates") as typeof import("../src/lib/finance/rates");
  const realLookup = rates.rateLookup.lookup;
  const storedBefore = await db.exchangeRate.findUnique({ where: { day_currency: { day: new Date("2026-04-01"), currency: "USD" } } }).catch(() => null);
  const usdRate = storedBefore ? Number(storedBefore.rate) : 84;
  const usdOne = await db.archivedDocument.create({ data: { ...voidRow("ZZZ-USD-1", "Sent"), currency: "USD", total: 400, balance: 300 } as never });
  const usdChecked = await actions.migrationArchive();
  const usdRow = usdChecked.ok ? usdChecked.data.differences.find((d) => d.number === "ZZZ-USD-1") : undefined;
  ok("a dollar invoice still owing: the check shows it in dollars, $300, not ₹300", usdRow?.currency === "USD" && usdRow.zoho === 300 && usdRow.deskzo === null, usdRow);
  if (!storedBefore) {
    rates.rateLookup.lookup = async () => ({ ok: false, reason: "offline in the check" }) as never;
    const noRate = await actions.openArchivedDocuments();
    ok("  with no dollar rate for 1 April it waits, and says to type one", noRate.ok && noRate.data.left.some((l) => l.number === "ZZZ-USD-1" && /no USD rate for 2026-04-01/.test(l.why)) && (await db.tradeDocument.count({ where: { docNumber: "ZZZ-USD-1" } })) === 0, noRate);
    rates.rateLookup.lookup = async () => ({ ok: true, rate: 84, onDate: "2026-04-01" }) as never;
  }
  const usdOpened = await actions.openArchivedDocuments();
  rates.rateLookup.lookup = realLookup;
  const usdDoc = await db.tradeDocument.findFirst({ where: { docNumber: "ZZZ-USD-1", docType: "INVOICE" }, select: { id: true, currency: true, exchangeRate: true, total: true, paidBefore: true } });
  const usdEntry = usdDoc ? await db.journalLine.aggregate({ where: { entry: { documentId: usdDoc.id } }, _sum: { debit: true } }) : null;
  ok(
    `  Open the ones still owing opens it in USD at ${usdRate}: $400, $100 settled before, $300 owing — ₹${300 * usdRate} on the books`,
    usdOpened.ok && !!usdDoc && usdDoc.currency === "USD" && Number(usdDoc.exchangeRate) === usdRate && Number(usdDoc.total) === 400 && Number(usdDoc.paidBefore) === 100 && Number(usdEntry?._sum.debit ?? 0) === 300 * usdRate,
    { usdOpened, usdDoc, usdEntry },
  );
  const usdAgreed = await actions.migrationArchive();
  ok("  and then the check agrees on it", usdAgreed.ok && !usdAgreed.data.differences.some((d) => d.number === "ZZZ-USD-1"), usdAgreed.ok ? usdAgreed.data.differences : usdAgreed);
  if (usdDoc) {
    await db.migrationRecord.deleteMany({ where: { migrationId: m.id, recordId: usdDoc.id } });
    await db.journalEntry.deleteMany({ where: { documentId: usdDoc.id } });
    await db.tradeDocument.delete({ where: { id: usdDoc.id } });
  }
  await db.archivedDocument.delete({ where: { id: usdOne.id } });
  if (!storedBefore) await db.exchangeRate.deleteMany({ where: { day: new Date("2026-04-01"), currency: "USD", source: "fetched" } }).catch(() => null);
  const again = await upload.storeUpload(m, read, null, boss.id);
  ok("  the backup again: the same archive, not two of each", again.archived.find((a) => a.kind === "INVOICE")?.count === 1 && (await db.archivedDocument.count({ where: { number: "ZZZ-OLD-1" } })) === 1);
  // A document whose company came later: none at first, found by Zoho's id once the master lists log it.
  const later = await db.archivedDocument.create({ data: { migrationId: m.id, kind: "INVOICE", key: "INVOICE:zz later:ZZZ-LATE-1", number: "ZZZ-LATE-1", date: new Date("2024-05-01T00:00:00Z"), year: "2024-25", partyName: "Zz Later Ltd", partyOldId: "880908000000100099", total: 100 } });
  const nobody = await actions.rematchMigrationArchive();
  ok("matching the archive again finds nothing while the company isn't in", nobody.ok && nobody.data.matched === 0 && nobody.data.left === 1, nobody);
  const laterCo = await db.company.create({ data: { name: "Zz Later Trading", normalizedName: "zz later trading", relationshipType: "CLIENT", createdById: boss.id } });
  await db.legacyImportRecord.create({ data: { importId: run.id, kind: "zoho_contacts", oldId: "880908000000100099", recordId: laterCo.id, action: "CREATED" } });
  const found = await actions.rematchMigrationArchive();
  ok("  once it is, by Zoho's id though the names differ — and no call to Zoho", found.ok && found.data.matched === 1 && (await db.archivedDocument.findUnique({ where: { id: later.id }, select: { companyId: true } }))?.companyId === laterCo.id, found);
  // "ABC Pvt. Ltd." in Zoho is "ABC Private Limited" in Deskzo (owner, 29 Oct 2026) — but not when two could be it.
  const formal = await db.company.create({ data: { name: "Zz Ingot Works Private Limited", normalizedName: "zz ingot works private limited", relationshipType: "CLIENT", createdById: boss.id } });
  const pvt = await db.archivedDocument.create({ data: { migrationId: m.id, kind: "INVOICE", key: "INVOICE:zz ingot:ZZZ-PVT-1", number: "ZZZ-PVT-1", date: new Date("2024-06-01T00:00:00Z"), year: "2024-25", partyName: "Zz Ingot Works Pvt. Ltd.", total: 100 } });
  await db.company.create({ data: { name: "Zz Twin Co Pvt Ltd", normalizedName: "zz twin co pvt ltd", relationshipType: "CLIENT", createdById: boss.id } });
  await db.company.create({ data: { name: "Zz Twin Co Private Limited", normalizedName: "zz twin co private limited", relationshipType: "CLIENT", createdById: boss.id } });
  const twin = await db.archivedDocument.create({ data: { migrationId: m.id, kind: "INVOICE", key: "INVOICE:zz twin:ZZZ-TWIN-1", number: "ZZZ-TWIN-1", date: new Date("2024-06-02T00:00:00Z"), year: "2024-25", partyName: "Zz Twin Co (P) Ltd", total: 100 } });
  const legal = await actions.rematchMigrationArchive();
  ok("  by the same name in another legal form: Pvt. Ltd. finds Private Limited", legal.ok && (await db.archivedDocument.findUnique({ where: { id: pvt.id }, select: { companyId: true } }))?.companyId === formal.id, legal);
  ok("  but left alone where two companies have that name", (await db.archivedDocument.findUnique({ where: { id: twin.id }, select: { companyId: true } }))?.companyId === null);
  // As spreadsheets (owner, 29 Oct 2026): the companies to bring in, their documents, every one.
  const companiesCsv = await actions.exportMigrationArchive("companies");
  const twinRow = companiesCsv.ok ? companiesCsv.data.csv.split("\n").find((l) => l.startsWith('"Zz Twin Co (P) Ltd",')) : undefined;
  ok("export: the companies Deskzo doesn't have, one row each, a customer by its invoice", companiesCsv.ok && companiesCsv.data.csv.startsWith('"Company (old system)",') && !!twinRow && twinRow.includes(',"Customer","1","1 Invoice",'), companiesCsv.ok ? twinRow : companiesCsv);
  ok("  and none that Deskzo has", companiesCsv.ok && !companiesCsv.data.csv.includes("Zz Ingot Works"));
  const unmatchedCsv = await actions.exportMigrationArchive("unmatched");
  ok("  their documents: the twin's invoice, not the matched one", unmatchedCsv.ok && unmatchedCsv.data.csv.includes("ZZZ-TWIN-1") && !unmatchedCsv.data.csv.includes("ZZZ-PVT-1"));
  const allCsv = await actions.exportMigrationArchive("all");
  const pvtRow = allCsv.ok ? allCsv.data.csv.split("\n").find((l) => l.includes("ZZZ-PVT-1")) : undefined;
  ok("  every document, with the company Deskzo found for it", allCsv.ok && !!pvtRow && pvtRow.includes("Zz Ingot Works Private Limited") && allCsv.data.csv.includes("ZZZ-TWIN-1"), pvtRow);

  section("Undo, and the route");
  const undone = await actions.undoMigrationAction();
  ok("Undo takes the documents back, the earlier years, and the account made for the old chart", undone.ok && (await db.tradeDocument.count({ where: { origin: { in: ["MIGRATED", "IMPORTED"] } } })) === 0 && (await db.archivedDocument.count()) === 0 && !(await db.ledgerAccount.findFirst({ where: { name: "Janitorial Expense" } })) && !!(await db.ledgerAccount.findUnique({ where: { id: rent.id } })), undone);
  const form = new FormData();
  form.append("files", new Blob([new Uint8Array(bytes)]), "zoho-backup.zip");
  const response = await route.POST(new Request("http://localhost:3000/api/migration/upload", { method: "POST", body: form }));
  ok("the upload route refuses a request that doesn't come from the app", response.status === 403);

  await throughTheApi(boss.id, acme.id);
}

/**
 * The Zoho button against a stand-in Zoho: every call the pull makes is answered here, in Zoho's documented shapes
 * (src/lib/zoho/rows.ts), and counted.
 */
async function throughTheApi(bossId: string, acmeId: string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const migrationActions = require("../src/actions/migration") as typeof import("../src/actions/migration");
  const zohoActions = require("../src/actions/zoho") as typeof import("../src/actions/zoho");
  const client = require("../src/lib/zoho/client") as typeof import("../src/lib/zoho/client");
  const state = require("../src/lib/migration/state") as typeof import("../src/lib/migration/state");
  const pullLib = require("../src/lib/zoho/pull") as typeof import("../src/lib/zoho/pull");
  /* eslint-enable @typescript-eslint/no-require-imports */
  section("Through Zoho's API");
  await db.user.update({ where: { id: bossId }, data: { isSuperAdmin: true } });

  const calls: string[] = [];
  const page = (key: string, rows: unknown[], more = false) => ({ code: 0, [key]: rows, page_context: { has_more_page: more } });
  const line = (o: Record<string, unknown>) => ({ item_id: "", name: "", description: "", quantity: 1, rate: 0, discount_amount: 0, tax_percentage: 18, item_total: 0, hsn_or_sac: "", unit: "", ...o });
  const answers: Record<string, unknown> = {
    "/organizations": { code: 0, organizations: [{ organization_id: "60001", name: "Zz Wroffy Books", plan_name: "Standard" }] },
    "/contacts?contact_type=customer&page=1": page("contacts", [{ contact_id: "API-C1", contact_name: "Zz Acme Traders" }]),
    "/contacts/API-C1": { code: 0, contact: { contact_id: "API-C1", contact_name: "Zz Acme Traders", company_name: "Zz Acme Traders", gst_no: "27AAACZ1234F1Z5", gst_treatment: "business_gst", payment_terms_label: "Net 15", currency_code: "INR", billing_address: { address: "1 Road", city: "Pune", state_code: "MH", country: "India", zip: "411001" }, contact_persons: [{ contact_person_id: "API-P1", first_name: "Asha", last_name: "Rao", email: "asha@acme.invalid", is_primary_contact: true, designation: "IT Manager" }] } },
    "/contacts?contact_type=vendor&page=1": page("contacts", []),
    "/items?page=1": page("items", [{ item_id: "API-I1", name: "Zz Widget", sku: "ZZ-WIDGET", rate: 1000, hsn_or_sac: "8471", tax_percentage: 18, product_type: "goods", status: "active" }]),
    "/chartofaccounts?page=1": page("chartofaccounts", [
      { account_id: "A1", account_name: "Undeposited Funds", account_type: "cash", is_active: true },
      { account_id: "A2", account_name: "Rent Expense", account_type: "expense", is_active: true },
    ]),
    "/invoices?page=1": page("invoices", [{ invoice_id: "API-INV-1", invoice_number: "ZZA-INV-1", date: "2026-05-10", status: "paid", customer_id: "API-C1", customer_name: "Zz Acme Traders", total: 2360, balance: 0 }], true),
    "/invoices?page=2": page("invoices", [{ invoice_id: "API-INV-0", invoice_number: "ZZA-OLD-1", date: "2025-02-01", status: "paid", customer_id: "API-C1", customer_name: "Zz Acme Traders", total: 590, balance: 0 }]),
    "/invoices/API-INV-1": { code: 0, invoice: { invoice_id: "API-INV-1", invoice_number: "ZZA-INV-1", date: "2026-05-10", due_date: "2026-05-25", status: "paid", customer_id: "API-C1", customer_name: "Zz Acme Traders", place_of_supply: "MH", gst_no: "27AAACZ1234F1Z5", is_inclusive_tax: false, currency_code: "INR", exchange_rate: 1, discount_type: "item_level", sub_total: 2000, total: 2360, balance: 0, adjustment: 0, shipping_charge: 0, line_items: [line({ item_id: "API-I1", name: "Zz Widget", quantity: 2, rate: 1000, item_total: 2000 })] } },
    "/customerpayments?page=1": page("customerpayments", [{ payment_id: "API-PAY-1", payment_number: "ZZA-PAY-1", date: "2026-05-20", amount: 2360, customer_name: "Zz Acme Traders" }]),
    "/customerpayments/API-PAY-1": { code: 0, payment: { payment_id: "API-PAY-1", payment_mode: "Bank Transfer", amount: 2360, bank_charges: 0, date: "2026-05-20", reference_number: "UTR-API", customer_id: "API-C1", customer_name: "Zz Acme Traders", account_name: "Undeposited Funds", invoices: [{ invoice_id: "API-INV-1", invoice_number: "ZZA-INV-1", amount_applied: 2360, tax_amount_withheld: 0 }] } },
    "/expenses?page=1": page("expenses", [
      { expense_id: "API-EXP-1", date: "2026-05-02", account_name: "Rent Expense", total: 5000 },
      { expense_id: "API-EXP-0", date: "2025-03-02", account_name: "Rent Expense", total: 4000 },
    ]),
    "/expenses/API-EXP-1": { code: 0, expense: { expense_id: "API-EXP-1", date: "2026-05-02", account_name: "Rent Expense", paid_through_account_name: "Zz HDFC", sub_total: 5000, total: 5000, tax_amount: 0, is_inclusive_tax: false, reference_number: "RENT-API", description: "May rent (API)" } },
    "/estimates?page=1": page("estimates", [{ estimate_id: "API-EST-1", estimate_number: "ZZA-QT-1", date: "2026-06-05", status: "sent", customer_id: "API-C1", customer_name: "Zz Acme Traders", total: 1180 }]),
    "/estimates/API-EST-1": { code: 0, estimate: { estimate_id: "API-EST-1", estimate_number: "ZZA-QT-1", date: "2026-06-05", status: "sent", customer_id: "API-C1", customer_name: "Zz Acme Traders", expiry_date: "2026-07-05", place_of_supply: "MH", total: 1180, line_items: [line({ name: "Zz Quote line", rate: 1000, item_total: 1000 })] } },
    // A fund transfer, listed once a side, and a payment the banking list also shows — which the pull leaves to its own module.
    "/banktransactions?page=1": page("banktransactions", [
      { transaction_id: "API-T1", date: "2026-05-03", amount: 3000, transaction_type: "transfer_fund", account_name: "Petty Cash", offset_account_name: "Zz HDFC", debit_or_credit: "debit", reference_number: "T-API" },
      { transaction_id: "API-T1", date: "2026-05-03", amount: 3000, transaction_type: "transfer_fund", account_name: "Zz HDFC", offset_account_name: "Petty Cash", debit_or_credit: "credit", reference_number: "T-API" },
      { transaction_id: "API-T2", date: "2026-05-20", amount: 2360, transaction_type: "customer_payment", account_name: "Zz HDFC", debit_or_credit: "debit" },
    ]),
  };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    if (url.hostname.startsWith("accounts.zoho.")) {
      calls.push("token");
      return new Response(JSON.stringify({ access_token: "zz-access", refresh_token: "zz-refresh", expires_in: 3600 }), { status: 200 });
    }
    if (!url.hostname.startsWith("www.zohoapis.")) return realFetch(input as RequestInfo, init);
    const path = url.pathname.replace(/^\/books\/v3/, "");
    calls.push(`${path}${url.searchParams.get("accept") === "pdf" ? " pdf" : ""}`);
    if (url.searchParams.get("accept") === "pdf") return new Response(new Uint8Array(Buffer.from("%PDF-1.4 zz")), { status: 200, headers: { "content-type": "application/pdf" } });
    // Only the count, as Zoho answers response_option=2: every page of the list, from date_start on when given.
    if (url.searchParams.get("response_option") === "2") {
      // A count Zoho gets wrong, as the owner's invoices' was (21 Nov 2026).
      const short = answers[`count:${path}`];
      if (typeof short === "number") return new Response(JSON.stringify({ code: 0, page_context: { total: short } }), { status: 200, headers: { "content-type": "application/json" } });
      const type = url.searchParams.get("contact_type");
      const listKey = pullLib.MODULES.find((mod) => mod.path === path)?.listKey ?? "items";
      const rows = [1, 2].flatMap((n) => ((answers[`${path}?${type ? `contact_type=${type}&` : ""}page=${n}`] as Record<string, unknown[]> | undefined)?.[listKey] ?? []) as { date?: string }[]);
      const from = url.searchParams.get("date_start");
      const total = rows.filter((r) => !from || (r.date ?? "") >= from).length;
      return new Response(JSON.stringify({ code: 0, page_context: { total } }), { status: 200, headers: { "content-type": "application/json" } });
    }
    const q = ["contact_type", "page"].filter((k) => url.searchParams.has(k)).map((k) => `${k}=${url.searchParams.get(k)}`).join("&");
    const known = answers[q ? `${path}?${q}` : path];
    // Anything else is an empty list, under the key its module's reply uses.
    const empty = { code: 0, page_context: { has_more_page: false }, [pullLib.MODULES.find((mod) => mod.path === path)?.listKey ?? "items"]: [] };
    return new Response(JSON.stringify(known ?? empty), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;

  try {
    ok("Zoho's sign-in asks India's accounts server for read access and a refresh token", /^https:\/\/accounts\.zoho\.in\/oauth\/v2\/auth\?/.test(client.authorizeUrl({ dataCentre: "in", clientId: "1000.ZZ" }, "https://zz.invalid/api/zoho/callback", "st")) && client.authorizeUrl({ dataCentre: "in", clientId: "1000.ZZ" }, "x", "st").includes("access_type=offline") && !client.ZOHO_SCOPES.includes("CREATE"));
    ok("  Canada's sign-in is on zohocloud.ca", client.zohoHosts("ca").accounts === "https://accounts.zohocloud.ca");
    ok(
      "  the data centre Zoho names on the way back is believed — only when it is one of Zoho's own",
      client.dataCentreOfCallback("us", null) === "com" && client.dataCentreOfCallback(null, "https://accounts.zoho.in") === "in" && client.dataCentreOfCallback(null, "https://accounts.zoho.in.evil.invalid") === null,
    );
    const refused = await zohoActions.saveZohoApp({ dataCentre: "in", clientId: "x", clientSecret: "y" });
    ok("a client id that isn't one is refused", !refused.ok);
    const saved = await zohoActions.saveZohoApp({ dataCentre: "in", clientId: "1000.ZZCLIENTID", clientSecret: "zz-secret-value-1234" });
    const row = await db.zohoConnection.findUnique({ where: { id: "default" } });
    ok("the app saved, its secret encrypted", saved.ok && !!row && row.clientSecret !== "zz-secret-value-1234" && row.clientSecret.split(":").length === 3);
    await client.finishSignIn("zz-code", "https://zz.invalid/api/zoho/callback", bossId);
    const orgs = await client.listOrganisations();
    const chose = await zohoActions.chooseZohoOrganisation(orgs[0]!.id);
    const connected = await db.zohoConnection.findUnique({ where: { id: "default" } });
    ok("signed in: the refresh token kept encrypted, the organisation chosen with its plan", chose.ok && !!connected?.refreshToken && connected.refreshToken !== "zz-refresh" && connected.organizationName === "Zz Wroffy Books" && connected.planName === "Standard");

    const started = await migrationActions.startMigrationAction({ source: "zoho-books", yearStart: "2026-04-01", switchDate: "2026-07-01" });
    const m = (await state.openMigration())!;
    ok("a migration to pull into", started.ok && !!m);
    const counted = await zohoActions.countZohoRecords();
    const kind = (key: string) => (counted.ok ? counted.data.kinds.find((k) => k.key === key) : undefined);
    ok(
      "counted before pulling: 1 customer, 2 invoices of which 1 this year, 2 expenses of which 1 this year",
      counted.ok && kind("customers")?.total === 1 && kind("invoices")?.total === 2 && kind("invoices")?.thisYear === 1 && kind("expenses")?.thisYear === 1 && kind("items")?.thisYear === null,
      counted.ok ? counted.data.kinds : counted,
    );
    ok("  and about how many calls and days the pull takes on this plan", counted.ok && counted.data.calls > 0 && counted.data.days === 1 && counted.data.allowance === client.dailyAllowance("Standard"));

    // Zoho's calls a day as the admin types it (owner, 29 Oct 2026): Zoho can raise it past the plan's.
    const raised = await zohoActions.setZohoDailyLimit(7500);
    ok("Zoho's calls a day typed: 7,500, of which Deskzo uses 6,750", raised.ok && raised.data.limit === 7500 && raised.data.allowance === 6750 && raised.data.typed && raised.data.planLimit === 2000, raised);
    const shown = await zohoActions.zohoState();
    ok("  the page shows it", shown.ok && shown.data.organisation?.allowance === 6750 && shown.data.organisation.limit === 7500);
    const recounted = await zohoActions.countZohoRecords();
    ok("  and the count works the days out at it", recounted.ok && recounted.data.allowance === 6750);
    const silly = await zohoActions.setZohoDailyLimit(5);
    ok("  under 100 refused", !silly.ok);
    const back = await zohoActions.setZohoDailyLimit(null);
    ok("  emptied, back to the plan's", back.ok && !back.data.typed && back.data.allowance === client.dailyAllowance("Standard"));
    const begun = await zohoActions.startZohoPull({ customers: 1, invoices: 2, bogus: 5, items: -1 });
    ok("the pull starts, keeping what was counted (only real kinds, only whole numbers) for its \"of\"", begun.ok && begun.data.progress.expected?.customers === 1 && begun.data.progress.expected?.invoices === 2 && Object.keys(begun.data.progress.expected ?? {}).length === 2, begun.ok ? begun.data.progress.expected : begun);
    const pullId = begun.ok ? begun.data.id : "";
    // "Carry on pulling" while one is going (owner, 20 Nov 2026): the same pull, logged as carried on — not started again.
    const carried = await zohoActions.startZohoPull();
    const carriedLog = await db.auditLog.findFirst({ where: { entityType: "ZohoPull", entityId: pullId }, orderBy: { createdAt: "desc" }, select: { entityLabel: true, action: true } });
    ok("pressing it again while it runs: the same pull, logged as carried on", carried.ok && carried.data.id === pullId && carriedLog?.entityLabel === "Carried on the Zoho Books pull" && carriedLog.action === "UPDATE", carriedLog);
    ok("  only once logged as started", (await db.auditLog.count({ where: { entityType: "ZohoPull", entityId: pullId, entityLabel: { startsWith: "Started pulling" } } })) === 1);

    // Today's calls nearly used: the pull waits rather than going over.
    await db.zohoPull.update({ where: { id: pullId }, data: { progress: { module: 0, page: 1, queue: [], buffer: {}, seq: {}, counts: {}, calls: { [new Date().toISOString().slice(0, 10)]: client.dailyAllowance("Standard") }, pdfs: 0 } } });
    const waited = await zohoActions.stepZohoPull(pullId);
    ok("with today's allowance used, it waits for tomorrow and says it carries on by itself", waited.ok && waited.data.status === "WAITING" && /carries on by itself after midnight/.test(waited.data.progress.note ?? ""), waited.ok ? waited.data : waited);
    await db.zohoPull.update({ where: { id: pullId }, data: { status: "FETCHING", progress: { module: 0, page: 1, queue: [], buffer: {}, seq: {}, counts: {}, calls: {}, pdfs: 0 } } });

    let view = waited.ok ? waited.data : null;
    // Partway, the invoices fetched: the master lists are handed on already, the books not yet.
    const invoicesAt = pullLib.MODULES.findIndex((mod) => mod.key === "invoices");
    let partway = await pullLib.pullStep(m, pullId, bossId, 1500);
    for (let i = 0; i < 40 && partway.status === "FETCHING" && partway.progress.module <= invoicesAt; i++) partway = await pullLib.pullStep(m, pullId, bossId, 1500);
    ok("partway: still fetching, past the invoices", partway.status === "FETCHING" && partway.progress.module > invoicesAt, partway);
    const handedDraft = await db.legacyImport.findFirst({ where: { status: "DRAFT" }, orderBy: { createdAt: "desc" }, select: { files: { select: { name: true, rowCount: true, chunks: { select: { rows: true } } } } } });
    const contacts = handedDraft?.files.find((f) => f.name === "Contacts.csv");
    const acmeRow = (contacts?.chunks[0]?.rows as Record<string, string>[] | undefined)?.[0];
    ok(
      "  the customer and the item are in the old-CRM import already, the customer with its GSTIN and city",
      contacts?.rowCount === 1 && acmeRow?.["Display Name"] === "Zz Acme Traders" && acmeRow["GST Identification Number (GSTIN)"] === "27AAACZ1234F1Z5" && acmeRow["Billing City"] === "Pune" && handedDraft!.files.some((f) => f.name === "Item.csv" && f.rowCount === 1),
      handedDraft?.files.map((f) => f.name),
    );
    ok("  and the page is told which lists went", ["customers", "vendors", "items"].every((k) => partway.progress.handed?.includes(k)), partway.progress.handed);
    // Each book module goes to its section the moment it is fetched (owner, 28 Oct 2026), not when the pull ends.
    const midway = await zohoActions.zohoPullPreview(pullId, "Invoice.csv");
    ok(
      "  the invoices went on to their section as soon as they were fetched: the pull holds them, and the customers, no longer",
      midway.ok && !midway.data.files.some((f) => f.file === "Invoice.csv" || f.file === "Contacts.csv"),
      midway.ok ? midway.data : midway,
    );
    const early = await db.migrationFile.findFirst({ where: { migrationId: m.id, step: "invoices" }, select: { units: true } });
    ok(
      "  the year's invoice is in the Invoices section already, the earlier one archived — with the pull still going",
      early?.units === 1 && (await db.archivedDocument.count({ where: { migrationId: m.id, number: "ZZA-OLD-1" } })) === 1 && partway.progress.booksHanded?.some((b) => b.module === "invoices") === true,
      early,
    );
    for (let i = 0; i < 40; i++) {
      const r = await zohoActions.stepZohoPull(pullId);
      if (!r.ok) {
        ok("a step of the pull", false, r.error);
        break;
      }
      view = r.data;
      if (["DONE", "FAILED", "WAITING"].includes(view.status)) break;
    }
    ok("the pull runs to the end", view?.status === "DONE", view);
    ok("  lines read in full only for this year's documents and the open quote", calls.includes("/invoices/API-INV-1") && !calls.includes("/invoices/API-INV-0") && calls.includes("/estimates/API-EST-1") && !calls.includes("/expenses/API-EXP-0"), calls);
    ok("  the earlier invoice's PDF fetched once", calls.filter((c) => c === "/invoices/API-INV-0 pdf").length === 1, calls.filter((c) => c.endsWith("pdf")));

    const stored = await db.migrationFile.findMany({ where: { migrationId: m.id }, select: { step: true, units: true } });
    const units = (step: string) => stored.find((f) => f.step === step)?.units;
    ok("the year's invoice, payment, expense, transfer and open quote to their steps", units("invoices") === 1 && units("receipts") === 1 && units("expenses") === 1 && units("journals") === 1 && units("quotes") === 1, stored);
    const old = await db.archivedDocument.findFirst({ where: { migrationId: m.id, number: "ZZA-OLD-1" }, select: { companyId: true, year: true, file: { select: { size: true, contentType: true } } } });
    ok("  the earlier invoice archived on Acme, with Zoho's PDF beside it", old?.companyId === acmeId && old.year === "2024-25" && old.file?.contentType === "application/pdf" && (old.file?.size ?? 0) > 0, old);
    const chart = await db.migrationAccount.findMany({ where: { migrationId: m.id }, select: { name: true, accountId: true } });
    ok("  Zoho's chart to the old chart's map, read as Deskzo's", chart.length === 2 && chart.every((a) => a.accountId), chart);
    const draft = await db.legacyImport.findFirst({ where: { status: "DRAFT" }, orderBy: { createdAt: "desc" }, select: { files: { select: { name: true, kind: true, rowCount: true } } } });
    ok("  the customers, their people and the items to the old-CRM import's master lists (the super admin pulled)", !!draft && ["zoho_contacts", "zoho_contact_persons", "zoho_items"].every((k) => draft.files.some((f) => f.kind === k && f.rowCount === 1)), draft?.files);
    ok("  the pull's own copy of the rows is gone once handed on", (await db.zohoPullPage.count({ where: { pullId } })) === 0);

    const inv = await db.migrationFile.findFirst({ where: { migrationId: m.id, step: "invoices" }, select: { id: true } });
    const checked = await migrationActions.checkMigrationPart(inv!.id, 0);
    ok("the pulled invoice checks: Acme, the widget, Zoho's total to the rupee", checked.ok && checked.data.outcomes[0]?.kind === "create", checked.ok ? checked.data.outcomes : checked);
    const banking = await db.migrationFile.findFirst({ where: { migrationId: m.id, step: "journals" }, select: { rows: true } });
    const transfer = (banking?.rows as Record<string, string>[] | undefined) ?? [];
    ok("  the transfer listed twice is one journal: into petty cash from the HDFC account", transfer.length === 2 && transfer.some((r) => r.Account === "Petty Cash" && r.Debit === "3000") && transfer.some((r) => r.Account === "Zz HDFC" && r.Credit === "3000"), transfer);

    const again = await zohoActions.startZohoPull();
    ok("pulling again starts afresh", again.ok && again.data.id !== pullId && again.data.status === "FETCHING");
    for (let i = 0; i < 40 && again.ok; i++) {
      const r = await zohoActions.stepZohoPull(again.data.id);
      if (!r.ok || ["DONE", "FAILED", "WAITING"].includes(r.data.status)) break;
    }
    ok("  the archive the same, its PDF kept rather than fetched again", (await db.archivedDocument.count({ where: { migrationId: m.id, number: "ZZA-OLD-1" } })) === 1 && calls.filter((c) => c === "/invoices/API-INV-0 pdf").length === 1);

    // On the server, no page open: the heartbeat's chore works it, a step held by one answers the other busy.
    const third = await zohoActions.startZohoPull();
    const thirdId = third.ok ? third.data.id : "";
    const heldUntil = new Date(Date.now() + 60_000).toISOString();
    await db.$executeRaw`update "zoho_pulls" set "progress" = jsonb_set("progress", '{lease}', to_jsonb(${heldUntil}::text)) where "id" = ${thirdId}`;
    const before = calls.length;
    const held = await zohoActions.stepZohoPull(thirdId);
    ok("a pull another step is working answers busy, and calls Zoho for nothing", held.ok && held.data.busy === true && calls.length === before, held.ok ? held.data.busy : held);
    await db.$executeRaw`update "zoho_pulls" set "progress" = "progress" - 'lease' - 'master' where "id" = ${thirdId}`;
    let chore: Awaited<ReturnType<typeof pullLib.zohoChores>> = null;
    for (let i = 0; i < 40; i++) {
      chore = await pullLib.zohoChores({ budgetMs: 8000 });
      const status = (await db.zohoPull.findUnique({ where: { id: thirdId }, select: { status: true } }))?.status;
      if (status === "DONE" || status === "FAILED") break;
    }
    const finished = await db.zohoPull.findUnique({ where: { id: thirdId }, select: { status: true, progress: true } });
    ok("the server's chore runs a pull to the end with no page open", chore?.worked === 1 && finished?.status === "DONE", finished?.status);
    ok("  a pull from before who started it was recorded: the starter asked of the database — the super admin, so the master lists came too", (finished?.progress as { master?: boolean } | undefined)?.master === true);
    // The backup first, then what changed since: Zoho now has a new customer and a new invoice, the old ones untouched.
    answers["/contacts?contact_type=customer&page=1"] = page("contacts", [
      { contact_id: "API-C1", contact_name: "Zz Acme Traders", last_modified_time: "2026-05-01T10:00:00+0530" },
      { contact_id: "API-C2", contact_name: "Zz Newco Traders", last_modified_time: "2026-10-27T09:00:00+0530" },
    ]);
    answers["/contacts/API-C2"] = { code: 0, contact: { contact_id: "API-C2", contact_name: "Zz Newco Traders", company_name: "Zz Newco Traders", gst_no: "", billing_address: { city: "Delhi" }, contact_persons: [] } };
    answers["/invoices?page=1"] = page("invoices", [
      { invoice_id: "API-INV-1", invoice_number: "ZZA-INV-1", date: "2026-05-10", status: "paid", customer_id: "API-C1", customer_name: "Zz Acme Traders", total: 2360, balance: 0, last_modified_time: "2026-05-20T10:00:00+0530" },
      { invoice_id: "API-INV-3", invoice_number: "ZZA-INV-3", date: "2026-06-15", status: "sent", customer_id: "API-C1", customer_name: "Zz Acme Traders", total: 1180, balance: 1180, last_modified_time: "2026-10-27T11:00:00+0530" },
    ]);
    answers["/invoices?page=2"] = page("invoices", []);
    answers["/invoices/API-INV-3"] = { code: 0, invoice: { invoice_id: "API-INV-3", invoice_number: "ZZA-INV-3", date: "2026-06-15", due_date: "2026-06-30", status: "sent", customer_id: "API-C1", customer_name: "Zz Acme Traders", place_of_supply: "MH", is_inclusive_tax: false, currency_code: "INR", exchange_rate: 1, sub_total: 1000, total: 1180, balance: 1180, line_items: [line({ item_id: "API-I1", name: "Zz Widget", quantity: 1, rate: 1000, item_total: 1000 })] } };
    const invoicesBefore = (await db.migrationFile.findFirst({ where: { migrationId: m.id, step: "invoices" }, select: { units: true } }))?.units ?? 0;
    const callsBefore = calls.length;
    const topup = await zohoActions.startZohoPull({}, { mode: "topup", since: "2026-10-01" });
    ok("a top-up starts from the day the backup was taken", topup.ok && topup.data.progress.mode === "topup" && topup.data.progress.since === "2026-10-01", topup.ok ? topup.data.progress : topup);
    for (let i = 0; i < 40 && topup.ok; i++) {
      const r = await zohoActions.stepZohoPull(topup.data.id);
      if (!r.ok || ["DONE", "FAILED", "WAITING"].includes(r.data.status)) break;
    }
    const toppedCalls = calls.slice(callsBefore);
    ok("  only what changed is read in full: the new customer and the new invoice, not the old ones", toppedCalls.includes("/contacts/API-C2") && toppedCalls.includes("/invoices/API-INV-3") && !toppedCalls.includes("/contacts/API-C1") && !toppedCalls.includes("/invoices/API-INV-1"), toppedCalls);
    const invoicesAfter = await db.migrationFile.findFirst({ where: { migrationId: m.id, step: "invoices" }, select: { units: true, rows: true } });
    ok("  added on top: the invoices kept, the new one with them", invoicesAfter?.units === invoicesBefore + 1 && (invoicesAfter.rows as Record<string, string>[]).some((r) => r.Number === "ZZA-INV-3") && (invoicesAfter.rows as Record<string, string>[]).some((r) => r.Number === "ZZA-INV-1"), { before: invoicesBefore, after: invoicesAfter?.units });
    const contactsFile = await db.legacyImportFile.findFirst({ where: { name: "Contacts.csv", import: { status: "DRAFT" } }, orderBy: { createdAt: "desc" }, select: { rowCount: true } });
    ok("  the new customer joins the master list's file, the backup's customer still in it", contactsFile?.rowCount === 2, contactsFile);
    ok("  the archive and the chart's choices untouched", (await db.archivedDocument.count({ where: { migrationId: m.id, number: "ZZA-OLD-1" } })) === 1 && (await db.migrationAccount.count({ where: { migrationId: m.id, accountId: { not: null } } })) === 2);

    // A whole pull again after one that brought the master lists (owner, 17 Nov 2026 — "it started customers fetching
    // again"): customers unchanged since the last are passed over; pulling the customers by themselves reads them all.
    const masterCallsBefore = calls.length;
    // And the books with them (owner, 23 Nov 2026: "why it is fetching again? this was done before already" … "Stop it,
    // skip repeats"): "Pull again" is a top-up from the day before the last whole pull — nothing unchanged read again.
    const whole = await zohoActions.startZohoPull();
    ok("pulling again after a whole pull: only what Zoho changed since it", whole.ok && whole.data.progress.again === true && whole.data.progress.mode === "topup" && /^\d{4}-\d{2}-\d{2}$/.test(whole.data.progress.since ?? "") && /Pulling again/.test(whole.data.progress.note ?? ""), whole.ok ? whole.data.progress : whole);
    for (let i = 0; i < 40 && whole.ok; i++) {
      const r = await zohoActions.stepZohoPull(whole.data.id);
      if (!r.ok || ["DONE", "FAILED", "WAITING"].includes(r.data.status)) break;
    }
    const wholeCalls = calls.slice(masterCallsBefore);
    ok("  customers and invoices unchanged since are listed but not read one by one", wholeCalls.includes("/contacts") && wholeCalls.includes("/invoices") && !wholeCalls.includes("/contacts/API-C1") && !wholeCalls.includes("/contacts/API-C2") && !wholeCalls.includes("/invoices/API-INV-1") && !wholeCalls.includes("/invoices/API-INV-3"), wholeCalls);
    const invoicesKept = await db.migrationFile.findFirst({ where: { migrationId: m.id, step: "invoices" }, select: { rows: true } });
    ok("  what came before is kept", (invoicesKept?.rows as Record<string, string>[] | undefined)?.some((r) => r.Number === "ZZA-INV-1") === true && (invoicesKept?.rows as Record<string, string>[]).some((r) => r.Number === "ZZA-INV-3"));
    const nextAgain = await zohoActions.startZohoPull();
    ok("  and counts as a whole pull: the next one again starts from it", nextAgain.ok && nextAgain.data.progress.again === true && nextAgain.data.progress.since === whole.data.progress.since, nextAgain.ok ? nextAgain.data.progress : nextAgain);
    if (nextAgain.ok) await zohoActions.stopZohoPull();
    const everyBefore = calls.length;
    const every = await zohoActions.startZohoPull({}, { everything: true });
    ok("\"Read everything again\": a whole pull, the master lists still only from the last", every.ok && (every.data.progress.mode ?? "full") === "full" && !every.data.progress.again && !!every.data.progress.masterSince, every.ok ? every.data.progress : every);
    for (let i = 0; i < 40 && every.ok; i++) {
      const r = await zohoActions.stepZohoPull(every.data.id);
      if (!r.ok || ["DONE", "FAILED", "WAITING"].includes(r.data.status)) break;
    }
    ok("  this year's invoices read in full again", calls.slice(everyBefore).includes("/invoices/API-INV-1"), calls.slice(everyBefore));
    const onlyBefore = calls.length;
    const onlyCustomers = await zohoActions.startZohoPull({}, { only: ["customers"] });
    ok("  pulling the customers by themselves reads every one", onlyCustomers.ok && !onlyCustomers.data.progress.masterSince);
    for (let i = 0; i < 40 && onlyCustomers.ok; i++) {
      const r = await zohoActions.stepZohoPull(onlyCustomers.data.id);
      if (!r.ok || ["DONE", "FAILED", "WAITING"].includes(r.data.status)) break;
    }
    ok("    each of them read in full", calls.slice(onlyBefore).includes("/contacts/API-C1") && calls.slice(onlyBefore).includes("/contacts/API-C2"), calls.slice(onlyBefore));

    // A whole pull with no earlier one finished to count from (owner, 20 Nov 2026 — "this fetching was already done"):
    // a customer already brought across into Deskzo and unchanged since is passed over; one never brought is read.
    const doneBeforeFresh = (await db.zohoPull.findMany({ where: { migrationId: m.id, status: "DONE" }, select: { id: true } })).map((p) => p.id);
    const pullsBeforeFresh = new Set((await db.zohoPull.findMany({ where: { migrationId: m.id }, select: { id: true } })).map((p) => p.id));
    await db.zohoPull.updateMany({ where: { migrationId: m.id, status: "DONE" }, data: { status: "FAILED" } });
    const someImport = await db.legacyImport.findFirst({ orderBy: { createdAt: "desc" }, select: { id: true } });
    await db.legacyImportRecord.deleteMany({ where: { kind: "zoho_contacts", oldId: { in: ["API-C1", "API-C2"] } } });
    await db.legacyImportRecord.create({ data: { importId: someImport!.id, kind: "zoho_contacts", oldId: "API-C1", recordId: "zz-brought", action: "CREATED" } });
    const freshBefore = calls.length;
    const fresh = await zohoActions.startZohoPull();
    ok("a whole pull with none finished before: no day to count from", fresh.ok && !fresh.data.progress.masterSince, fresh.ok ? fresh.data.progress : fresh);
    let freshView = fresh.ok ? fresh.data : null;
    for (let i = 0; i < 40 && fresh.ok; i++) {
      const r = await zohoActions.stepZohoPull(fresh.data.id);
      if (!r.ok) break;
      freshView = r.data;
      if (["DONE", "FAILED", "WAITING"].includes(r.data.status)) break;
    }
    const freshCalls = calls.slice(freshBefore);
    ok(
      "  the customer already in Deskzo and unchanged isn't read again; the one never brought is",
      !freshCalls.includes("/contacts/API-C1") && freshCalls.includes("/contacts/API-C2") && freshView?.progress.alreadyIn?.customers === 1,
      { calls: freshCalls.filter((c) => c.startsWith("/contacts")), alreadyIn: freshView?.progress.alreadyIn },
    );
    await db.legacyImportRecord.updateMany({ where: { kind: "zoho_contacts", oldId: "API-C1" }, data: { createdAt: new Date("2026-04-01T00:00:00Z") } });
    await db.zohoPull.updateMany({ where: { migrationId: m.id, status: "DONE" }, data: { status: "FAILED" } });
    const changedBefore = calls.length;
    const changed = await zohoActions.startZohoPull();
    for (let i = 0; i < 40 && changed.ok; i++) {
      const r = await zohoActions.stepZohoPull(changed.data.id);
      if (!r.ok || ["DONE", "FAILED", "WAITING"].includes(r.data.status)) break;
    }
    ok("  one changed in Zoho after it was brought is read again", calls.slice(changedBefore).includes("/contacts/API-C1"));
    // Put back as it was: these two pulls gone, the earlier finished ones finished again — the night's top-up counts from them.
    const ours = (await db.zohoPull.findMany({ where: { migrationId: m.id }, select: { id: true } })).map((p) => p.id).filter((id) => !pullsBeforeFresh.has(id));
    await db.zohoPullPage.deleteMany({ where: { pullId: { in: ours } } });
    await db.zohoPull.deleteMany({ where: { id: { in: ours } } });
    await db.zohoPull.updateMany({ where: { id: { in: doneBeforeFresh } }, data: { status: "DONE" } });

    // Is everything in? (owner, 20 Nov 2026 — src/lib/zoho/completeness.ts): Zoho's count beside Deskzo's, kind by kind.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const completeness = require("../src/lib/zoho/completeness") as typeof import("../src/lib/zoho/completeness");
    const z = (entries: [string, number | null, number][]) => new Map(entries.map(([k, total, leftOut]) => [k, { total, leftOut }]));
    const sides = completeness.compareSides(
      z([["invoices", 100, 4], ["bills", 50, 0], ["customerpayments", 80, 0], ["journals", 10, 0], ["estimates", 33579, 0], ["salesorders", 50, 0], ["purchaseorders", 30, 0], ["customers", 40, 0], ["vendorcredits", 3, 1]]),
      { imported: { invoices: 90, receipts: 85, journals: 14, quotes: 20, "sales-orders": 10, "purchase-orders": 5, "vendor-credits": 2 }, waiting: { invoices: 3 }, failed: { invoices: 1 }, masters: { customers: 38 }, archived: { estimates: 1095, salesorders: 40, purchaseorders: 20 } },
    );
    const sideRow = (k: string) => sides.find((r) => r.key === k)!;
    ok("is everything in: drafts and voids left out of Zoho's count; 6 short, with its waiting and failed rows", sideRow("invoices").zoho === 96 && sideRow("invoices").state === "behind" && /6 short — 3 waiting/.test(sideRow("invoices").note) && sideRow("invoices").failed === 1, sideRow("invoices"));
    ok("  a section with nothing imported: not in yet, its own pull named", sideRow("bills").state === "missing" && /Pull bills from Zoho/.test(sideRow("bills").note));
    ok("  more payments here, journals with transfers: explained, not flagged", sideRow("customerpayments").state === "ahead" && sideRow("journals").state === "ahead" && /transfers/.test(sideRow("journals").note));
    ok("  quotes: the open ones and Earlier years' together, against Zoho's count of all", sideRow("estimates").state === "behind" && sideRow("estimates").deskzo === 1115 && sideRow("estimates").archived === 1095 && /^32,464 not in Deskzo — 20 open in the books, 1,095 in Earlier years. “Pull the earlier years' quotes/.test(sideRow("estimates").note), sideRow("estimates").note);
    ok("  sales orders all in, books and archive together", sideRow("salesorders").state === "match" && /^All in — 10 open in the books, 40 in Earlier years/.test(sideRow("salesorders").note), sideRow("salesorders").note);
    ok("  purchase orders short: the top-up named", sideRow("purchaseorders").state === "behind" && /^5 not in Deskzo .*Top up since the backup/.test(sideRow("purchaseorders").note), sideRow("purchaseorders").note);
    ok("  customers: by what the old-CRM import brought across", sideRow("customers").state === "behind" && sideRow("customers").deskzo === 38);
    ok("  a match counts what was left behind", sideRow("vendorcredits").state === "match" && /1 in Zoho left behind on purpose/.test(sideRow("vendorcredits").note));
    // Asked of Zoho for real (owner, 21 Nov 2026: 1,998 invoices in Zoho beside Deskzo's 2,393, every one of them in
    // Zoho by number). Zoho's own count says 1; its list has four of the year — one waiting for approval, dated after
    // the switch day, and one rejected, neither of which comes across — and a draft from before the year, not the
    // year's at all. Deskzo's side says a running total of 999 and keeps a record of an invoice since taken back: what
    // is really here counts, not either.
    const invoicePages = { 1: answers["/invoices?page=1"], 2: answers["/invoices?page=2"] };
    const zzInvoice = (number: string, date: string, status: string) => ({ invoice_id: `API-${number}`, invoice_number: number, date, status, customer_id: "API-C1", customer_name: "Zz Acme Traders", total: 590, balance: 590 });
    answers["count:/invoices"] = 1;
    answers["/invoices?page=1"] = { ...(invoicePages[1] as object), page_context: { has_more_page: true } };
    answers["/invoices?page=2"] = page("invoices", [zzInvoice("ZZA-INV-PA", "2026-08-01", "pending_approval"), zzInvoice("ZZA-INV-RJ", "2026-05-01", "rejected"), zzInvoice("ZZA-INV-OLDDRAFT", "2025-12-01", "draft")]);
    const runningTotal = (await db.migration.findUniqueOrThrow({ where: { id: m.id }, select: { counts: true } })).counts as Record<string, number>;
    await db.migration.update({ where: { id: m.id }, data: { counts: { ...runningTotal, invoices: 999 } } });
    await db.migrationRecord.create({ data: { migrationId: m.id, kind: "document", recordId: "zz-taken-back-invoice", key: "INVOICE:ZZA-TAKEN-BACK" } });
    const checkedIn = await zohoActions.checkZohoCompleteness().finally(async () => {
      delete answers["count:/invoices"];
      answers["/invoices?page=1"] = invoicePages[1];
      answers["/invoices?page=2"] = invoicePages[2];
      await db.migration.update({ where: { id: m.id }, data: { counts: runningTotal } });
      await db.migrationRecord.deleteMany({ where: { migrationId: m.id, key: "INVOICE:ZZA-TAKEN-BACK" } });
    });
    ok("  asked of Zoho for real: every kind counted, Deskzo's beside it", checkedIn.ok && checkedIn.data.calls > 0 && checkedIn.data.rows.some((r) => r.key === "invoices" && r.zoho !== null), checkedIn.ok ? checkedIn.data.rows.map((r) => `${r.key}:${r.zoho}/${r.deskzo}`).join(" ") : checkedIn.error);
    const invoiceRow = checkedIn.ok ? checkedIn.data.rows.find((r) => r.key === "invoices") : undefined;
    ok("  Zoho's invoices counted from its list, not its count — to today, less the one awaiting approval and the rejected one: two of four", invoiceRow?.zoho === 2 && invoiceRow.leftOut === 2, invoiceRow);
    const documentIds = (await db.migrationRecord.findMany({ where: { migrationId: m.id, kind: "document", NOT: { key: { startsWith: "OPENED:" } } }, select: { recordId: true } })).map((r) => r.recordId);
    const reallyHere = await db.tradeDocument.count({ where: { id: { in: documentIds }, docType: "INVOICE", status: { notIn: ["DRAFT", "CANCELLED"] } } });
    ok("  Deskzo's invoices are the ones here now — not the running total, not the one taken back", invoiceRow?.deskzo === reallyHere && reallyHere !== 999, { reallyHere, row: invoiceRow });

    // Customers, vendors and items found by what they are (owner, 23 Nov 2026: "Vendors 262 · 0 Not in yet" with 270 in
    // Deskzo's list — "fix the check"): by Zoho's id, else an item's SKU, else the name with the legal form evened out.
    const zzRun = Date.now().toString(36);
    const zzVendor = await db.company.create({ data: { name: `Zz Supply ${zzRun} Private Limited`, normalizedName: `zz supply ${zzRun} private limited`, relationshipType: "VENDOR", createdById: actorId }, select: { id: true } });
    const zzClientOnly = await db.company.create({ data: { name: `Zz Plain ${zzRun} Ltd`, normalizedName: `zz plain ${zzRun} ltd`, createdById: actorId }, select: { id: true } });
    const zzItem = await db.item.create({ data: { name: `Zz Gadget ${zzRun}`, sku: `ZZ-SKU-${zzRun}`, type: "GOOD", sellingPrice: 10, createdById: actorId }, select: { id: true } });
    const keptAnswers = { vendors: answers["/contacts?contact_type=vendor&page=1"], items: answers["/items?page=1"] };
    answers["/contacts?contact_type=vendor&page=1"] = page("contacts", [
      { contact_id: "ZZV-1", contact_name: "Supply", company_name: `Zz Supply ${zzRun} Pvt. Ltd.`, status: "active" },
      { contact_id: "ZZV-2", contact_name: "Plain", company_name: `Zz Plain ${zzRun} Limited`, status: "active" },
      { contact_id: "ZZV-3", contact_name: "Gone", company_name: `Zz Gone ${zzRun} LLP`, status: "inactive" },
    ]);
    answers["/items?page=1"] = page("items", [
      { item_id: "ZZI-1", name: "Renamed in Zoho", sku: `zz-sku-${zzRun}`, status: "active" },
      { item_id: "ZZI-2", name: `Zz Missing ${zzRun}`, sku: "", status: "active" },
    ]);
    const found = await completeness.masterMatches().finally(async () => {
      answers["/contacts?contact_type=vendor&page=1"] = keptAnswers.vendors;
      answers["/items?page=1"] = keptAnswers.items;
      await db.item.deleteMany({ where: { id: zzItem.id } });
      await db.company.deleteMany({ where: { id: { in: [zzVendor.id, zzClientOnly.id] } } });
    });
    const fv = found.byKey.vendors;
    ok("found by what they are: a vendor by its name, \"Pvt. Ltd.\" the same as \"Private Limited\"", fv?.listed === 3 && fv.found === 1, fv);
    ok("  one here by name but not a vendor: said so, not counted", fv?.notVendor === 1 && fv.missing.some((n) => n.includes("not marked a vendor")), fv?.missing);
    ok("  one not here at all, inactive in Zoho: listed as that", fv?.inactiveMissing === 1 && fv.missing.some((n) => n.includes(`Zz Gone ${zzRun}`) && n.includes("inactive in Zoho")), fv?.missing);
    const fi = found.byKey.items;
    ok("  an item by its SKU though Zoho renamed it; one not here listed by name", fi?.found === 1 && fi.missingCount === 1 && fi.missing[0] === `Zz Missing ${zzRun}`, fi);
    const vendorRow = completeness.compareSides(new Map([["vendors", { total: 3, leftOut: 0 }]]), { imported: {}, waiting: {}, failed: {}, masters: { vendors: 0 } }, found.byKey).find((r) => r.key === "vendors");
    ok("  the row: Zoho's list beside what of it is here, and what's missing named", vendorRow?.zoho === 3 && vendorRow.deskzo === 1 && vendorRow.state === "behind" && /2 of Zoho's vendors not found here — 1 of them inactive in Zoho; 1 here by name but not marked a vendor/.test(vendorRow.note) && vendorRow.missing?.length === 2, vendorRow);

    // An earlier year's invoice the pull read from Zoho's list, so the archive has no lines for it (owner, 21 Nov 2026:
    // WT/25-26/3472, AutoCAD LT ×4, shown as "Brought forward"): opened as owing, then its own lines asked of Zoho.
    const apiOld = await db.archivedDocument.create({
      data: { migrationId: m.id, kind: "INVOICE", key: "INVOICE:acme:ZZZ-API-OLD", number: "ZZZ-API-OLD", date: new Date("2026-03-20"), year: "2025-26", partyName: "Zz Acme Traders", companyId: acmeId, status: "Sent", currency: "INR", total: 113280, balance: 113280, oldId: "API-OLD-9" },
    });
    const apiOpened = await migrationActions.openArchivedDocuments();
    const apiDoc = await db.tradeDocument.findFirst({ where: { docNumber: "ZZZ-API-OLD", docType: "INVOICE" }, select: { id: true } });
    answers["/invoices/API-OLD-9"] = {
      code: 0,
      invoice: {
        invoice_id: "API-OLD-9",
        invoice_number: "ZZZ-API-OLD",
        line_items: [{ name: "AutoCAD LT 2026 Commercial New Single-user ELD Annual Subscription", description: "Part No. 057R1-WW3043-L685\nValidity: 19-03-2026 to 18-03-2027\nContract # 110005149247", quantity: 4, rate: 24000, item_total: 96000, hsn_or_sac: "997331", tax_percentage: 18 }],
        taxes: [
          { tax_name: "CGST9", tax_amount: 8640 },
          { tax_name: "SGST9", tax_amount: 8640 },
        ],
        total: 113280,
      },
    };
    const apiCalls = calls.length;
    const apiLined = await zohoActions.bringOpenedLinesFromZoho();
    const apiNow = apiDoc ? await db.tradeDocument.findUniqueOrThrow({ where: { id: apiDoc.id }, select: { total: true, lines: { orderBy: { sortOrder: "asc" }, select: { name: true, description: true, hsnCode: true, quantity: true, unitPrice: true, lineTotal: true } } } }) : null;
    ok(
      "an earlier invoice read from Zoho's list: opened, then its own lines asked of Zoho — AutoCAD LT ×4 at ₹24,000, the CGST and SGST as billed on a line of their own",
      apiOpened.ok && !!apiNow && apiLined.ok && apiLined.data.brought === 1 && calls.slice(apiCalls).filter((c) => c === "/invoices/API-OLD-9").length === 1 &&
        apiNow.lines.length === 2 &&
        apiNow.lines[0]!.name.startsWith("AutoCAD LT 2026") && /Contract # 110005149247/.test(apiNow.lines[0]!.description ?? "") && apiNow.lines[0]!.hsnCode === "997331" && Number(apiNow.lines[0]!.quantity) === 4 && Number(apiNow.lines[0]!.unitPrice) === 24000 && Number(apiNow.lines[0]!.lineTotal) === 96000 &&
        Number(apiNow.lines[1]!.lineTotal) === 17280 && /CGST9 8,640\.00 · SGST9 8,640\.00/.test(apiNow.lines[1]!.description ?? "") && Number(apiNow.total) === 113280,
      { apiLined, apiNow },
    );
    const keptLines = (await db.archivedDocument.findUniqueOrThrow({ where: { id: apiOld.id }, select: { lines: true } })).lines as { item: string }[];
    ok("  kept in the archive too, so it isn't asked twice", keptLines.length === 1 && keptLines[0]!.item.startsWith("AutoCAD LT 2026"), keptLines);
    delete answers["/invoices/API-OLD-9"];
    if (apiDoc) {
      await db.migrationRecord.deleteMany({ where: { migrationId: m.id, recordId: apiDoc.id } });
      await db.journalEntry.deleteMany({ where: { documentId: apiDoc.id } });
      await db.tradeDocument.delete({ where: { id: apiDoc.id } });
    }
    await db.archivedDocument.delete({ where: { id: apiOld.id } });

    // Zoho's PDFs only: nothing listed, nothing stored — the one PDF missing fetched.
    await db.archivedDocumentFile.deleteMany({ where: { document: { migrationId: m.id, number: "ZZA-OLD-1" } } });
    const pdfCallsBefore = calls.length;
    const pdfs = await zohoActions.startZohoPull({}, { mode: "pdfs" });
    for (let i = 0; i < 10 && pdfs.ok; i++) {
      const r = await zohoActions.stepZohoPull(pdfs.data.id);
      if (!r.ok || ["DONE", "FAILED", "WAITING"].includes(r.data.status)) break;
    }
    const pdfCalls = calls.slice(pdfCallsBefore);
    ok("PDFs only: the missing PDF fetched, and no list read", pdfCalls.length === 1 && pdfCalls[0] === "/invoices/API-INV-0 pdf" && !!(await db.archivedDocumentFile.findFirst({ where: { document: { migrationId: m.id, number: "ZZA-OLD-1" } } })), pdfCalls);
    // The night's top-up (src/lib/zoho/nightly.ts): Zoho stays the books; what it changes comes across by itself.
    // eslint-disable-next-line @typescript-eslint/no-require-imports -- loaded after the stubs, as the others are
    const nightlyLib = require("../src/lib/zoho/nightly") as typeof import("../src/lib/zoho/nightly");
    const nightlyOn = await zohoActions.setZohoNightly(true);
    ok("the night's top-up turned on, as whoever turned it on", nightlyOn.ok && (await nightlyLib.nightlySetting()).on && (await nightlyLib.nightlySetting()).byId === actorId, nightlyOn);
    const changedNow = new Date().toISOString().replace("Z", "+0000");
    answers["/invoices?page=1"] = page("invoices", [
      { invoice_id: "API-INV-1", invoice_number: "ZZA-INV-1", date: "2026-05-10", status: "paid", customer_id: "API-C1", customer_name: "Zz Acme Traders", total: 2360, balance: 0, last_modified_time: "2026-05-20T10:00:00+0530" },
      { invoice_id: "API-INV-4", invoice_number: "ZZA-INV-4", date: "2026-06-20", status: "sent", customer_id: "API-C1", customer_name: "Zz Acme Traders", total: 590, balance: 590, last_modified_time: changedNow },
    ]);
    answers["/invoices/API-INV-4"] = { code: 0, invoice: { invoice_id: "API-INV-4", invoice_number: "ZZA-INV-4", date: "2026-06-20", due_date: "2026-07-05", status: "sent", customer_id: "API-C1", customer_name: "Zz Acme Traders", place_of_supply: "MH", is_inclusive_tax: false, currency_code: "INR", exchange_rate: 1, sub_total: 500, total: 590, balance: 590, line_items: [line({ item_id: "API-I1", name: "Zz Widget", quantity: 1, rate: 500, item_total: 500 })] } };
    // Two in the afternoon: not the small hours, nothing starts.
    const pullsBefore = await db.zohoPull.count({ where: { migrationId: m.id } });
    const afternoon = await nightlyLib.nightlyChores({ budgetMs: 8000, now: new Date("2030-01-15T08:30:00Z") });
    ok("  nothing starts in the afternoon", afternoon === null && (await db.zohoPull.count({ where: { migrationId: m.id } })) === pullsBefore, afternoon);
    // A pull of the PDFs alone, or of one section, after it: what changed in the rest before that day would be left out
    // if the night counted from it (25 Nov 2026), so it counts from the last that read everything.
    const pdfsAt = pdfs.ok ? (await db.zohoPull.findUniqueOrThrow({ where: { id: pdfs.data.id }, select: { startedAt: true } })).startedAt : new Date();
    if (pdfs.ok) await db.zohoPull.update({ where: { id: pdfs.data.id }, data: { startedAt: new Date("2029-12-31T06:00:00Z") } });
    const onlySome = await db.zohoPull.create({ data: { migrationId: m.id, startedById: actorId, status: "DONE", startedAt: new Date("2029-12-30T06:00:00Z"), progress: { mode: "full", only: ["estimates"] } }, select: { id: true } });
    // 02:15 in India on a later day: the top-up starts, since the day the last pull of everything started.
    const night = await nightlyLib.nightlyChores({ budgetMs: 8000, now: new Date("2030-01-15T20:45:00Z") });
    await db.zohoPull.delete({ where: { id: onlySome.id } });
    if (pdfs.ok) await db.zohoPull.update({ where: { id: pdfs.data.id }, data: { startedAt: pdfsAt } });
    const everyDone = await db.zohoPull.findMany({ where: { migrationId: m.id, status: "DONE" }, orderBy: { startedAt: "desc" }, select: { startedAt: true, progress: true } });
    const lastDone = everyDone.find((p) => !(p.progress as { only?: string[] }).only?.length && (p.progress as { mode?: string }).mode !== "pdfs");
    ok("  in the small hours it starts a top-up, since the day the last pull of everything started — not a later one of the PDFs or of one section", night?.started === lastDone?.startedAt.toISOString().slice(0, 10) || night?.started === new Date(lastDone!.startedAt.getTime() + 19_800_000).toISOString().slice(0, 10), { night, lastDone });
    const nightPull = await db.zohoPull.findFirst({ where: { migrationId: m.id }, orderBy: { startedAt: "desc" }, select: { id: true, progress: true } });
    ok("  a top-up, marked the night's", (nightPull?.progress as { mode?: string; nightly?: boolean }).mode === "topup" && (nightPull?.progress as { nightly?: boolean }).nightly === true, nightPull?.progress);
    ok("  and a second beat the same night starts nothing more", (await nightlyLib.nightlyChores({ budgetMs: 8000, now: new Date("2030-01-15T21:45:00Z") })) === null && (await db.zohoPull.count({ where: { migrationId: m.id } })) === pullsBefore + 1);
    for (let i = 0; i < 40; i++) {
      await pullLib.zohoChores({ budgetMs: 8000 });
      const status = (await db.zohoPull.findUnique({ where: { id: nightPull!.id }, select: { status: true } }))?.status;
      if (status === "DONE" || status === "FAILED") break;
    }
    let imported: Awaited<ReturnType<typeof nightlyLib.nightlyChores>> = null;
    for (let i = 0; i < 20; i++) {
      imported = await nightlyLib.nightlyChores({ budgetMs: 8000, now: new Date("2030-01-15T22:00:00Z") });
      if (imported?.imported) break;
    }
    const afterNight = await db.zohoPull.findUnique({ where: { id: nightPull!.id }, select: { status: true, progress: true } });
    ok("once the pull is done, what it brought is imported, section by section", afterNight?.status === "DONE" && imported?.imported === true && (afterNight.progress as { imported?: boolean }).imported === true, { status: afterNight?.status, imported });
    const invoicesFile = await db.migrationFile.findFirst({ where: { migrationId: m.id, step: "invoices" }, select: { units: true, done: true, failures: true } });
    const four = await db.tradeDocument.findFirst({ where: { docNumber: "ZZA-INV-4" }, select: { id: true } });
    ok("  the night's new invoice is in Deskzo, the invoices file gone through", !!four && invoicesFile?.done === invoicesFile?.units, { four, invoicesFile });
    // The import comes before the hour is looked at: a beat in the day would import again if it were still to do.
    ok("  and imported once: the next beat does nothing", (await nightlyLib.nightlyChores({ budgetMs: 8000, now: new Date("2030-01-16T08:30:00Z") })) === null);
    await zohoActions.setZohoNightly(false);
    ok("turned off, it says so", !(await nightlyLib.nightlySetting()).on);

    // A pull left open — waiting on Zoho's next day — holds Finish back; stopping it lets the switch finish.
    const left = await db.zohoPull.create({ data: { migrationId: m.id, startedById: actorId, status: "WAITING", progress: {} }, select: { id: true } });
    const stopped = await zohoActions.stopZohoPull();
    const leftNow = await db.zohoPull.findUnique({ where: { id: left.id }, select: { status: true, error: true } });
    ok("stopping a pull left waiting: stopped, saying what was kept", stopped.ok && stopped.data.stopped === 1 && leftNow?.status === "FAILED" && /stays/.test(leftNow.error ?? ""), { stopped, leftNow });
    const stepAfter = await zohoActions.stepZohoPull(left.id);
    ok("  a step afterwards doesn't start it again", stepAfter.ok && stepAfter.data.status === "FAILED" && (await db.zohoPull.findUnique({ where: { id: left.id }, select: { status: true } }))?.status === "FAILED", stepAfter);
    const waiting = await db.zohoPull.create({ data: { migrationId: m.id, startedById: actorId, status: "FETCHING", progress: {} }, select: { id: true } });
    const off = await zohoActions.disconnectZoho();
    ok("disconnecting forgets the app and its tokens; what was pulled stays", off.ok && !(await db.zohoConnection.findUnique({ where: { id: "default" } })) && (await db.archivedDocument.count({ where: { migrationId: m.id } })) > 0);
    ok("  and stops the pull still going, so it can't hold Finish back", (await db.zohoPull.findUnique({ where: { id: waiting.id }, select: { status: true } }))?.status === "FAILED");
  } finally {
    globalThis.fetch = realFetch;
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
