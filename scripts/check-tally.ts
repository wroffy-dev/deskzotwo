/**
 * check:tally — the Tally export, phase 1: the sales side (owner, 25 Oct 2026 plan; built 23 Nov 2026 — src/lib/tally).
 *
 *   1. The XML: names escaped, amounts to the paisa, Tally's signs; a voucher that balances; bill-wise for credit notes
 *      and receipts; Tally's masters read back from its own export, UTF-16 or UTF-8.
 *   2. An export, on its own records in March 2031 (so nothing real is touched):
 *      · an account with no Tally ledger stops it, naming the account; matched, it goes;
 *      · the invoice as a Sales voucher — the customer New Ref by its number, its item line with HSN, quantity and rate,
 *        the taxes; the receipt Agst Ref against the invoice, the rest On Account; the e-invoice number on it;
 *      · the customer Tally hasn't got as a new master, then remembered; the file read back balances, voucher by voucher;
 *      · each record once: the next check of the period finds nothing; Zoho's (migrated) invoice is never sent; nothing
 *        before the start date;
 *      · the lock: an exported invoice can't be cancelled, an exported receipt can't be deleted;
 *      · marked imported.
 *   3. "Tally keeps the books": the ledger's pages leave the menu and say "Kept in Tally"; invoices stay.
 *
 *   npm run check:tally
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function main() {
  process.env.DESKZO_TENANCY_FALLBACK ??= "legacy";
  /* eslint-disable @typescript-eslint/no-require-imports */
  const xml = require("../src/lib/tally/xml") as typeof import("../src/lib/tally/xml");
  const masters = require("../src/lib/tally/masters") as typeof import("../src/lib/tally/masters");
  const build = require("../src/lib/tally/build") as typeof import("../src/lib/tally/build");
  const kept = require("../src/lib/tally/kept") as typeof import("../src/lib/tally/kept");
  const { cleanTallyName } = require("../src/lib/tally/names") as typeof import("../src/lib/tally/names");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("1. The XML");
  ok("names escaped, amounts to the paisa, dates as Tally writes them", xml.esc(`A&B "Ltd" <x>`) === "A&amp;B &quot;Ltd&quot; &lt;x&gt;" && xml.money(1180) === "1180.00" && xml.money(0.1 + 0.2) === "0.30" && xml.tallyDate("2031-03-05") === "20310305");
  const v = { type: "Sales", number: "INV-1", date: "2031-03-05", party: "Acme", ledgers: [{ ledger: "Acme", amount: -1180, party: true, bills: [{ name: "INV-1", type: "New Ref" as const, amount: -1180 }] }, { ledger: "Output CGST", amount: 90 }, { ledger: "Output SGST", amount: 90 }], inventory: [{ item: "Laptop", unit: "Nos", quantity: 2, rate: 500, amount: 1000, ledger: "Sales" }] };
  const vx = xml.voucher(v);
  ok("a debit is negative with ISDEEMEDPOSITIVE Yes; a credit positive with No", /<LEDGERNAME>Acme<\/LEDGERNAME><ISDEEMEDPOSITIVE>Yes<\/ISDEEMEDPOSITIVE><ISPARTYLEDGER>Yes<\/ISPARTYLEDGER><AMOUNT>-1180.00<\/AMOUNT>/.test(vx) && /<LEDGERNAME>Output CGST<\/LEDGERNAME><ISDEEMEDPOSITIVE>No<\/ISDEEMEDPOSITIVE><AMOUNT>90.00<\/AMOUNT>/.test(vx));
  ok("  an item invoice: quantity, rate per unit, and its sales ledger inside the item line", vx.includes("<ISINVOICE>Yes</ISINVOICE>") && vx.includes("<RATE>500.00/Nos</RATE>") && vx.includes("<ACTUALQTY>2 Nos</ACTUALQTY>") && /<ACCOUNTINGALLOCATIONS\.LIST><LEDGERNAME>Sales<\/LEDGERNAME>/.test(vx));
  ok("  it balances; one paisa off doesn't", xml.balances(v) && !xml.balances({ ...v, ledgers: [...v.ledgers, { ledger: "Round off", amount: 0.01 }] }));
  ok("a credit note: against the invoices it was applied to, the rest against its invoice or as its own", JSON.stringify(build.creditNoteBills("CN-1", 500, [{ invoice: "INV-1", amount: 300 }], "INV-1")) === JSON.stringify([{ name: "INV-1", type: "Agst Ref", amount: 300 }, { name: "CN-1", type: "New Ref", amount: 200 }]) && build.creditNoteBills("CN-2", 500, [], "INV-9")[0]!.name === "INV-9");
  ok("a receipt: against each invoice it paid, the rest on account", JSON.stringify(build.receiptBills(1500, [{ invoice: "INV-1", amount: 1180 }])) === JSON.stringify([{ name: "INV-1", type: "Agst Ref", amount: 1180 }, { name: "On Account", type: "On Account", amount: 320 }]));
  const tallyFile = `<ENVELOPE><BODY><DATA><TALLYMESSAGE><LEDGER NAME="ACME LTD." RESERVEDNAME=""><PARENT>Sundry Debtors</PARENT><PARTYGSTIN>27AAACA1234A1Z5</PARTYGSTIN></LEDGER><LEDGER NAME="Sales &amp; Services"><PARENT>Sales Accounts</PARENT></LEDGER><STOCKITEM NAME="Laptop"><PARENT/></STOCKITEM></TALLYMESSAGE></DATA></BODY></ENVELOPE>`;
  const utf16 = new Uint8Array([0xff, 0xfe, ...Buffer.from(tallyFile, "utf16le")]);
  const parsed = masters.parseTallyMasters(masters.decodeTallyFile(utf16));
  ok("Tally's masters read back from its own UTF-16 export: ledgers with their group and GSTIN, stock items", parsed.length === 3 && parsed.some((m) => m.name === "ACME LTD." && m.gstin === "27AAACA1234A1Z5" && m.parent === "Sundry Debtors") && parsed.some((m) => m.name === "Sales & Services") && parsed.some((m) => m.kind === "STOCKITEM" && m.name === "Laptop"));
  ok("  and from UTF-8", masters.parseTallyMasters(masters.decodeTallyFile(new TextEncoder().encode(tallyFile))).length === 3);
  ok("a typed Tally name keeps its case and marks, losing only stray spacing", cleanTallyName("  ACME  LTD.\n") === "ACME LTD.");
  ok("the ledger's pages are Tally's; invoices aren't", kept.isKeptInTally("/accounting/trial-balance") && kept.isKeptInTally("/accounting") && kept.isKeptInTally("/accounting/ledger/abc") && !kept.isKeptInTally("/accounting/expense-claims") && !kept.isKeptInTally("/sales/invoices"));

  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const server = require("../src/lib/tally/server") as typeof import("../src/lib/tally/server");
  const { keptInTally } = require("../src/lib/tally/books") as typeof import("../src/lib/tally/books");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const admin = await db.user.findFirst({ where: { active: true, isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin");
  const ar = await db.ledgerAccount.findFirst({ where: { systemKey: "AR" }, select: { id: true } });
  const cgst = await db.ledgerAccount.findFirst({ where: { systemKey: "OUTPUT_CGST" }, select: { id: true, name: true } });
  const sgst = await db.ledgerAccount.findFirst({ where: { systemKey: "OUTPUT_SGST" }, select: { id: true, name: true } });
  const sales = await db.ledgerAccount.findFirst({ where: { type: "INCOME", isGroup: false, active: true }, orderBy: { code: "asc" }, select: { id: true, name: true } });
  const bankLedger = (await db.bankAccount.findFirst({ select: { ledgerAccountId: true } }))?.ledgerAccountId ?? (await db.ledgerAccount.findFirst({ where: { systemKey: "CASH" }, select: { id: true } }))?.id;
  const bank = bankLedger ? await db.ledgerAccount.findUnique({ where: { id: bankLedger }, select: { id: true, name: true } }) : null;
  if (!ar || !cgst || !sgst || !sales || !bank) throw new Error("the chart of accounts is missing an account the suite needs");

  const tag = randomUUID().slice(0, 6).toUpperCase();
  const settingsBefore = await db.tallySettings.findUnique({ where: { id: "global" } });
  const mastersBefore = await db.tallyMaster.findMany();
  const mappingsBefore = await db.tallyMapping.findMany();
  const exportIds: string[] = [];
  const created: { companies: string[]; docs: string[]; payments: string[]; entries: string[] } = { companies: [], docs: [], payments: [], entries: [] };
  const day = (d: string) => new Date(`${d}T06:30:00Z`);
  try {
    const company = await db.company.create({ data: { name: `ZZTALLY ${tag} Traders`, normalizedName: `zztally ${tag} traders`, createdById: admin.id }, select: { id: true, name: true } });
    created.companies.push(company.id);
    const entry = async (data: { source: "INVOICE" | "PAYMENT"; date: Date; documentId?: string; paymentId?: string; lines: { accountId: string; debit?: number; credit?: number; companyId?: string }[] }) => {
      const e = await db.journalEntry.create({ data: { entryNumber: `ZZT-${tag}-${created.entries.length}`, date: data.date, narration: "check:tally", source: data.source, documentId: data.documentId, paymentId: data.paymentId, companyId: company.id, createdById: admin.id, lines: { create: data.lines.map((l, i) => ({ accountId: l.accountId, debit: l.debit ?? 0, credit: l.credit ?? 0, companyId: l.companyId ?? null, sortOrder: i })) } }, select: { id: true } });
      created.entries.push(e.id);
    };
    const invoice = async (number: string, date: string, extra: Record<string, unknown> = {}) => {
      const d = await db.tradeDocument.create({
        data: {
          docNumber: number,
          docType: "INVOICE",
          direction: "SALES",
          status: "ISSUED",
          companyId: company.id,
          createdById: admin.id,
          issueDate: day(date),
          buyerGstin: "27ZZTAL1234A1Z5",
          billingState: "Maharashtra",
          billingLine1: "1 Test Road",
          billingCity: "Pune",
          billingPincode: "411001",
          taxableValue: 1000,
          cgstAmount: 90,
          sgstAmount: 90,
          total: 1180,
          irn: `zz${tag}${number}`.toLowerCase().padEnd(64, "0"),
          ackNo: "112233",
          ...extra,
          lines: { create: [{ name: `ZZTALLY ${tag} Laptop`, hsnCode: "847130", unit: "Nos", quantity: 2, unitPrice: 500, taxRatePercent: 18, taxableValue: 1000, cgstAmount: 90, sgstAmount: 90, lineTotal: 1180 }] },
        },
        select: { id: true },
      });
      created.docs.push(d.id);
      await entry({ source: "INVOICE", date: day(date), documentId: d.id, lines: [{ accountId: ar.id, debit: 1180, companyId: company.id }, { accountId: sales.id, credit: 1000 }, { accountId: cgst.id, credit: 90 }, { accountId: sgst.id, credit: 90 }] });
      return d;
    };
    const inv = await invoice(`ZZT${tag}-1`, "2031-03-05");
    await invoice(`ZZT${tag}-Z`, "2031-03-06", { origin: "MIGRATED" });
    const pay = await db.payment.create({ data: { companyId: company.id, amount: 1500, paidOn: new Date("2031-03-10T00:00:00Z"), method: "BANK_TRANSFER", reference: `UTR${tag}`, recordedByUserId: admin.id, allocations: { create: [{ documentId: inv.id, amount: 1180, allocatedByUserId: admin.id }] } }, select: { id: true, paymentSeq: true } });
    created.payments.push(pay.id);
    await entry({ source: "PAYMENT", date: new Date("2031-03-10T00:00:00Z"), paymentId: pay.id, lines: [{ accountId: bank.id, debit: 1500 }, { accountId: ar.id, credit: 1500, companyId: company.id }] });

    section("2. An export");
    await server.saveTallyConfig({ booksIn: "DESKZO", companyName: `ZZ Tally Co ${tag}`, itemLines: true, startDate: null }, admin.id);
    await db.tallyMaster.deleteMany({});
    await db.tallyMapping.deleteMany({});
    await server.saveTallyMasters("masters.xml", new TextEncoder().encode(`<ENVELOPE><LEDGER NAME="${sales.name}"><PARENT>Sales Accounts</PARENT></LEDGER><LEDGER NAME="${bank.name}"><PARENT>Bank Accounts</PARENT></LEDGER><LEDGER NAME="CGST Output"><PARENT>Duties &amp; Taxes</PARENT></LEDGER></ENVELOPE>`), admin.id);
    await server.setTallyMapping(`ACCOUNT:${cgst.id}`, "CGST Output", admin.id);
    const first = await server.previewExport("2031-03-01", "2031-03-31");
    ok("an account with no Tally ledger stops it, named — the others matched by mapping or the same name", first.unmatched.length === 1 && first.unmatched[0]!.label === sgst.name, first.unmatched);
    let refused = "";
    await server.runExport("2031-03-01", "2031-03-31", admin.id).catch((e: Error) => (refused = e.message));
    ok("  making it is refused, saying which", refused.includes(sgst.name), refused);
    await server.setTallyMapping(`ACCOUNT:${sgst.id}`, "SGST Output", admin.id);
    const made = await server.runExport("2031-03-01", "2031-03-31", admin.id);
    exportIds.push(made.id);
    const row = await db.tallyExport.findUniqueOrThrow({ where: { id: made.id } });
    const vouchers = row.vouchersXml;
    ok("matched, it goes: the invoice and the receipt — not Zoho's migrated invoice", made.vouchers === 2 && vouchers.includes(`ZZT${tag}-1`) && !vouchers.includes(`ZZT${tag}-Z`), made);
    ok("  addressed to the Tally company", vouchers.includes(`<SVCURRENTCOMPANY>ZZ Tally Co ${tag}</SVCURRENTCOMPANY>`));
    ok("  the invoice: a Sales voucher, the customer debited New Ref by its number, the taxes to their Tally ledgers", vouchers.includes(`<VOUCHER VCHTYPE="Sales"`) && vouchers.includes(`<NAME>ZZT${tag}-1</NAME><BILLTYPE>New Ref</BILLTYPE><AMOUNT>-1180.00</AMOUNT>`) && vouchers.includes("<LEDGERNAME>CGST Output</LEDGERNAME>") && vouchers.includes("<LEDGERNAME>SGST Output</LEDGERNAME>"));
    ok("  its item line: the item, 2 Nos at 500, to the sales ledger; the IRN on it", vouchers.includes(`<STOCKITEMNAME>ZZTALLY ${tag} Laptop</STOCKITEMNAME>`) && vouchers.includes("<ACTUALQTY>2 Nos</ACTUALQTY>") && vouchers.includes("<RATE>500.00/Nos</RATE>") && vouchers.includes(`<LEDGERNAME>${xml.esc(sales.name)}</LEDGERNAME>`) && vouchers.includes("<IRNACKNO>112233</IRNACKNO>"));
    ok("  the receipt: bank debited, the customer credited Agst Ref the invoice, the rest On Account", vouchers.includes(`<VOUCHER VCHTYPE="Receipt"`) && vouchers.includes(`<NAME>ZZT${tag}-1</NAME><BILLTYPE>Agst Ref</BILLTYPE><AMOUNT>1180.00</AMOUNT>`) && vouchers.includes("<BILLTYPE>On Account</BILLTYPE><AMOUNT>320.00</AMOUNT>") && vouchers.includes(`<LEDGERNAME>${xml.esc(bank.name)}</LEDGERNAME><ISDEEMEDPOSITIVE>Yes</ISDEEMEDPOSITIVE><AMOUNT>-1500.00</AMOUNT>`));
    const amounts = [...vouchers.matchAll(/<VOUCHER [\s\S]*?<\/VOUCHER>/g)].map((m) => {
      const top = m[0].replace(/<ACCOUNTINGALLOCATIONS\.LIST>[\s\S]*?<\/ACCOUNTINGALLOCATIONS\.LIST>/g, "").replace(/<BILLALLOCATIONS\.LIST>[\s\S]*?<\/BILLALLOCATIONS\.LIST>/g, "");
      return [...top.matchAll(/<AMOUNT>(-?[\d.]+)<\/AMOUNT>/g)].reduce((t, a) => t + Number(a[1]), 0);
    });
    ok("the file read back: every voucher balances", amounts.length === 2 && amounts.every((a) => Math.abs(a) < 0.005), amounts);
    ok("the customer Tally hasn't got goes as a new master — GSTIN, state, bill-wise — and is remembered", row.mastersXml.includes(`<LEDGER NAME="ZZTALLY ${tag} Traders" ACTION="Create">`) && row.mastersXml.includes("<PARTYGSTIN>27ZZTAL1234A1Z5</PARTYGSTIN>") && row.mastersXml.includes("<ISBILLWISEON>Yes</ISBILLWISEON>") && row.mastersXml.includes("<HSNCODE>847130</HSNCODE>") && (await db.tallyMapping.count({ where: { key: `PARTY:${company.id}`, source: "CREATED" } })) === 1);
    const summary = row.summary as { byType: { type: string; count: number; value: number }[]; taxByRate: { rate: number; taxable: number; cgst: number }[] };
    ok("the totals to tie: by voucher type and by GST rate", summary.byType.some((t) => t.type === "Sales" && t.count === 1 && t.value === 1180) && summary.byType.some((t) => t.type === "Receipt" && t.value === 1500) && summary.taxByRate.some((r) => r.rate === 18 && r.taxable === 1000 && r.cgst === 90), summary);
    const again = await server.previewExport("2031-03-01", "2031-03-31");
    ok("each record once: the period checked again finds nothing", again.vouchers.length === 0);
    const second = await invoice(`ZZT${tag}-2`, "2031-03-20");
    await server.saveTallyConfig({ booksIn: "DESKZO", companyName: `ZZ Tally Co ${tag}`, itemLines: true, startDate: "2031-03-25" }, admin.id);
    ok("nothing before the start date goes", (await server.previewExport("2031-03-01", "2031-03-31")).vouchers.length === 0);
    await server.saveTallyConfig({ booksIn: "DESKZO", companyName: `ZZ Tally Co ${tag}`, itemLines: true, startDate: null }, admin.id);
    ok("  from it, the new invoice does — the customer now by the name it went as", (await server.previewExport("2031-03-01", "2031-03-31")).vouchers.length === 1 && (await server.previewExport("2031-03-01", "2031-03-31")).masters.parties.length === 0);
    void second;

    ok("the lock: an exported invoice can't be cancelled — a credit note instead", (await server.tallyLockRefusal("DOCUMENT", [inv.id]))?.includes("credit or debit note") === true);
    ok("  an exported receipt can't be deleted", (await server.tallyLockRefusal("PAYMENT", [pay.id]))?.includes("gone to Tally") === true);
    ok("  one not exported is free", (await server.tallyLockRefusal("DOCUMENT", [second.id])) === null);
    await server.markImported(made.id, admin.id);
    ok("marked imported, once", (await db.tallyExport.findUnique({ where: { id: made.id } }))?.status === "IMPORTED" && (await server.markImported(made.id, admin.id).then(() => false).catch(() => true)));

    section("3. Tally keeps the books");
    ok("in Deskzo: the ledger's pages are there", !(await keptInTally()));
    await server.saveTallyConfig({ booksIn: "TALLY", companyName: `ZZ Tally Co ${tag}`, itemLines: true, startDate: null }, admin.id);
    ok("in Tally: said so", await keptInTally());
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { buildNavigation } = require("../src/lib/navigation") as typeof import("../src/lib/navigation");
    const { PERMISSIONS } = require("../src/lib/permissions") as typeof import("../src/lib/permissions");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const all = PERMISSIONS.map((p) => p.key);
    const hrefs = (booksInTally: boolean) => JSON.stringify(buildNavigation({ openModules: ["accounting", "sales_documents", "expenses"], permissions: all, country: "IN", booksInTally }));
    ok("the menu leaves out the trial balance, journal and GST returns — and keeps expense claims", hrefs(false).includes("/accounting/trial-balance") && !hrefs(true).includes("/accounting/trial-balance") && !hrefs(true).includes("/accounting/journal") && !hrefs(true).includes("/accounting/gst") && hrefs(true).includes("/accounting/expense-claims"));
  } finally {
    await db.tallyExport.deleteMany({ where: { id: { in: exportIds } } });
    await db.journalLine.deleteMany({ where: { entryId: { in: created.entries } } });
    await db.journalEntry.deleteMany({ where: { id: { in: created.entries } } });
    await db.paymentAllocation.deleteMany({ where: { paymentId: { in: created.payments } } });
    await db.payment.deleteMany({ where: { id: { in: created.payments } } });
    await db.tradeDocument.deleteMany({ where: { id: { in: created.docs } } });
    await db.company.deleteMany({ where: { id: { in: created.companies } } });
    await db.tallyMaster.deleteMany({});
    if (mastersBefore.length) await db.tallyMaster.createMany({ data: mastersBefore });
    await db.tallyMapping.deleteMany({});
    if (mappingsBefore.length) await db.tallyMapping.createMany({ data: mappingsBefore });
    await db.tallySettings.deleteMany({ where: { id: "global" } });
    if (settingsBefore) await db.tallySettings.create({ data: settingsBefore });
  }
  console.log(failures ? `\n${failures} failed` : "\nAll Tally checks passed.");
  if (failures) process.exitCode = 1;
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => process.exit());
