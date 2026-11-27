/**
 * check:old-proposals — the proposals made in Excel before Zoho (owner, 25 Nov 2026; src/lib/old-proposals):
 *
 *   · reading: a quotation's reference, customer, date, lines and total; a status sheet's tabs with their own headings;
 *     joined by reference and company, by company and date, or left apart; versions together, the latest first;
 *   · on a scratch workspace database (<db>_old_proposals_check, built from the migrations and dropped at the end): the
 *     preview matches by name only, suggests by address and domain, makes a company only for a won one, says what Zoho
 *     already has, writes nothing, and is the super admin's alone; a file that isn't a prepared one is refused;
 *   · the page and what it shows.
 *
 *   npm run check:old-proposals
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import Module from "node:module";
import { gzipSync } from "node:zlib";
import { createElement } from "react";
import { attachPapers, dateOf, joinProposals, numberOf, pdfQuotation, quotationOf, refKey, rowsOf, sameCompany, sharedStrings, statusRows, wordRows, type OldProposal, type Quotation, type SheetRow, type StatusRow } from "../src/lib/old-proposals/read";
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

let actorId = "";
let backupOk = true;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "@/lib/backup/run" || request.endsWith("lib/backup/run")) return { runBackup: async () => (backupOk ? { ok: true, id: "zz-backup" } : { ok: false, id: null, error: "no pg_dump" }) };
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation")
    return {
      notFound: () => {
        throw new Error("NOT_FOUND");
      },
      useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {}, prefetch() {} }),
      usePathname: () => "/settings/data/old-proposals",
      useSearchParams: () => new URLSearchParams(),
    };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: "ADMIN", name: "Zz Admin", email: `${actorId}@zzold.invalid` } : null);
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

const OWN = /@zzown/i;
const rows = (...r: Record<string, string>[]): SheetRow[] => r.map((cells, i) => ({ row: i + 1, cells }));

function reading() {
  section("Reading a sheet");
  const strings = sharedStrings('<sst><si><t>Item</t></si><si><r><t>Dell &amp; </t></r><r><t xml:space="preserve">Co</t></r></si><si/></sst>');
  ok("shared strings, in runs and with entities", strings[0] === "Item" && strings[1] === "Dell & Co" && strings.length === 3, strings);
  const read = rowsOf('<row r="3"><c r="A3" t="s"><v>1</v></c><c r="B3"><v>42.5</v></c><c r="C3" t="inlineStr"><is><t>x</t></is></c><c r="D3" t="e"><v>#REF!</v></c><c r="E3"/></row><row r="4"/>', strings);
  ok("a row's cells: shared, number, written in place; an error and an empty one left out", read.length === 1 && JSON.stringify(read[0]) === JSON.stringify({ row: 3, cells: { A: "Dell & Co", B: "42.5", C: "x" } }), read);
  ok("dates: Excel's, typed day first, and a mistyped year is none", dateOf("43070") === "2017-12-01" && dateOf("05-04-2019") === "2019-04-05" && dateOf("5th March 20") === "2020-03-05" && dateOf("31-02-2019") === null && dateOf("40457") === null, [dateOf("43070"), dateOf("05-04-2019"), dateOf("5th March 20")]);
  ok("money", numberOf("₹ 1,26,000.00/-") === 126000 && numberOf("Rs. 5,000") === 5000 && numberOf("As per OEM") === null && numberOf("") === null && numberOf("8 11") === null);
  ok("references as they were typed", refKey("WT/17-18/Ref/062") === "2017:62" && refKey("WT/19-2-0/Ref/005") === "2019:5" && refKey("wt/20-21/ref 12") === "2020:12" && refKey("WT/20-21/Ref/") === null, [refKey("WT/19-2-0/Ref/005"), refKey("wt/20-21/ref 12")]);
  ok(
    "one company written two ways; two that only start alike aren't",
    sameCompany("Securition India Pvt Ltd", "Securiton India Private Limited") && sameCompany("Autoneum", "Autoneum India Pvt. Ltd.") && sameCompany("R K Technologies", "RK Technologies") && !sameCompany("Shri Ram Steel", "Shri Krishna Mills") && !sameCompany("Global", "Global Logic") && !sameCompany("Tata Motors", "Tata Steel"),
  );

  section("A quotation");
  const at = { file: "2019/Bison/Proposal_Corel Draw.xlsx", folder: "Bison", saved: "2019-07-30T10:00:00" };
  const q = quotationOf(
    rows(
      { A: "Zz Own Pvt. Ltd." },
      { A: "QUOTATION" },
      { B: "Customer Details", D: "Quote Id", E: "WT/19-20/Ref/448" },
      { A: "Company", B: "Bison Mills", D: "GST No.", E: "06AAAAA0000A1Z0" },
      { A: "Contact Details :", B: "Mr. Deepak / 9667400943", D: "Contact :", E: "Deepika/9560839666" },
      { A: "Email Id", B: "deepak@bison.invalid", D: "Email:", E: "deepika@zzown.com" },
      { A: "Address", B: "Noida", D: "Date:", E: "43676" },
      { B: "Item", C: "Qty", D: "Unit Price", E: "Total(INR)" },
      { B: "Corel Draw" },
      { A: "1", B: "CorelDRAW 2019", C: "2", D: "63000", E: "126000" },
      { B: "Part Code: LCCDGS" },
      { B: "Terms and Conditions", D: "SubTotal", E: "126000" },
      { B: "Taxes", D: "GST (18%)", E: "22680" },
      { B: "Validity", D: "Total", E: "148680" },
    ),
    at,
    OWN,
  );
  ok("who, when, by whom", q?.ref === "WT/19-20/Ref/448" && q.company === "Bison Mills" && q.contact === "Mr. Deepak" && q.email === "deepak@bison.invalid" && q.date === "2019-07-30" && q.madeBy === "deepika@zzown.com", q);
  ok("its line under its heading, the part code with it", q?.lines.length === 1 && q.lines[0]!.item === "Corel Draw — CorelDRAW 2019 · Part Code: LCCDGS" && q.lines[0]!.quantity === 2 && q.lines[0]!.amount === 126000, q?.lines);
  ok("the total with the tax, not the subtotal or a heading", q?.total === 148680, q?.total);
  ok("a total of nothing isn't one", quotationOf(rows({ A: "Company", B: "X" }, { B: "Item", C: "Qty", E: "Total" }, { B: "A", C: "1", E: "5" }, { D: "Total", E: "0" }), at, OWN)?.total === null);
  ok("a company left blank is the folder's, not the next label", quotationOf(rows({ A: "Company", D: "GST No.", E: "06" }, { B: "Item", C: "Qty" }), at, OWN)?.company === "Bison");
  ok("a sheet that isn't one", quotationOf(rows({ A: "Notes" }), at, OWN) === null);


  section("The other layouts");
  const old = quotationOf(
    rows(
      { B: "Customer Details", D: "Quote Id", E: "WT/17-18/Ref/009" },
      { B: "Veda DAV School", D: "Contact :", E: "Deepika/9560839666" },
      { B: "Contact Person : Mr. Pankaj/9582027287/ pankaj@dav.invalid", D: "Email:", E: "deepika@zzown.com" },
      { B: "Address : Delhi", D: "Date:", E: "42986" },
      { A: "1", B: "Item", C: "Qty", D: "Unit Price", E: "Total" },
      { A: "1.a", B: "OfficeStd", C: "200", D: "3070", E: "614000" },
      { D: "Total", E: "724520" },
    ),
    at,
    OWN,
  );
  ok("2017's, the company under Customer Details and their person, not ours", old?.company === "Veda DAV School" && old.contact === "Mr. Pankaj" && old.email === "pankaj@dav.invalid" && old.ref === "WT/17-18/Ref/009" && old.total === 724520 && old.lines.length === 1, old);
  const cell = (t: string) => `<w:tc><w:p><w:r><w:t>${t}</w:t></w:r></w:p></w:tc>`;
  const tr = (...c: string[]) => `<w:tr>${c.map(cell).join("")}</w:tr>`;
  const para = (t: string) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
  const word = wordRows(
    para("Proposal for O365") + tr("Name of the Customer/Domain", "LEX &amp; CARE") + tr("Date", "29/11/2018") + tr("Prepared By", "Urvashi, urvashi@zzown.com") + para("To, Ms. Karthi") + para("Quote Ref No. : WT/18-19/Ref/564") + tr("Item", "Qty", "Unit Price", "Total(INR)") + tr("MS Licenses", "", "", "") + tr("O365 Business", "10", " 1254.00", "12540.00") + tr("", "", "", "") + tr("", "Total", "", "12540.00") + tr("", "Tax@18%", "", "2257.2") + tr("", "Grand Total", "", "14797.2") + para("Features:") + tr("1 TB One Drive", "5", "6", "7"),
  );
  const doc = quotationOf(word, { ...at, word: true }, OWN);
  ok("Word's: who, when, the reference from its text, one line and the total with tax", doc?.company === "LEX & CARE" && doc.date === "2018-11-29" && doc.ref === "WT/18-19/Ref/564" && doc.lines.length === 1 && doc.lines[0]!.item === "MS Licenses — O365 Business" && doc.total === 14797.2 && doc.madeBy === "urvashi@zzown.com", doc);
  const pdf = pdfQuotation("ZZ OWN info@zzown.com Proposal for MS License Customer Name Keihin India Pvt. Ltd. Address Noida Contact Details Mr. Azad/ 9560022795/azad@keihin.invalid Date 13/05/2020 Proposal Title MS Licenses Prepared By saurabh@zzown.com Quote Id : WT/20-21/Ref/151 Item Qty Unit Price Total(INR) MS Licenses Business Basic 15 1,250.00 18,750.00 Migration 15 250 3,750 Total 22,500.00 GST@18% 4,050 Grand Total ₹26,550.00 Taxes as Applicable 5 7 99", at, OWN);
  ok("a PDF's: who, when, the reference, lines that multiply out, the last total", pdf?.company === "Keihin India Pvt. Ltd." && pdf.date === "2020-05-13" && pdf.ref === "WT/20-21/Ref/151" && pdf.lines.length === 2 && pdf.lines[1]!.item === "Migration" && pdf.total === 26550 && pdf.email === "azad@keihin.invalid" && pdf.contact === "Mr. Azad", pdf);
  ok("a PDF that isn't a proposal isn't taken for one", pdfQuotation("Vendor Registration Name of entity: Zz Own", { file: "2019/K/Form.pdf", folder: "K" }, OWN) === null);
  const blank = (key: string, company: string, files: string[], more: Partial<OldProposal> = {}): OldProposal => ({ key, ref: "", year: "2019", date: "2019-05-01", company, alsoNamed: [], contact: "", phone: "", email: "", address: "", madeBy: "", product: "", status: "UNKNOWN", remarks: "", left: false, lines: [], total: null, files, attachments: [], joined: "FILE_ONLY", issues: [], ...more });
  const papers = attachPapers([blank("a", "Bison Mills", ["2019/Bison/P.xlsx"]), blank("b", "Bison Mills", ["2019/Bison/P2.xlsx"], { date: "2019-08-01" }), blank("c", "Orbit Enterprises", [], { status: "LOST" })], ["2019/Bison/EUF -  DELHI.doc", "2019/Orbit/SLA.docx", "2019/Nobody/Spec.pdf", "2019/Nobody/PO.pdf", "2019/stray.pdf"]);
  const paper = (k: string) => papers.proposals.find((p) => p.key === k)!;
  ok("papers go beside the latest proposal in their folder, else their company's", paper("b").attachments.length === 1 && paper("a").attachments.length === 0 && paper("c").attachments.join() === "2019/Orbit/SLA.docx");
  ok("  a folder with none is one of papers only, so nothing is lost; a stray is said", paper("P:2019/Nobody").attachments.length === 2 && paper("P:2019/Nobody").company === "Nobody" && papers.loose.join() === "2019/stray.pdf");
  ok("  an order form beside one not known: probably won, said and not decided", /probably won/.test(paper("b").issues.join()) && paper("b").status === "UNKNOWN" && paper("c").issues.length === 0);

  section("The status sheet");
  const first = statusRows("17-18", rows({ A: "", B: "Ref Code", C: ".", D: "Account Name", E: "Product", F: "Prepared By", G: "Status", I: "Remarks" }, { B: "WT/17-18/Ref/001", C: "42936", D: "Neopack", E: "Quickheal", F: "Deepika", G: "Pending", I: "hold" }, { B: "WT/17-18/Ref/002", D: "" }), OWN);
  ok("a tab whose date column is headed with a dot; a row with no company left out", first.length === 1 && first[0]!.date === "2017-07-20" && first[0]!.status === "PENDING", first);
  const second = statusRows("20-21", rows({ B: "Ref Code", D: "Date", E: "Account Name", F: "Product", H: "City", I: "Name", J: "Contact No.", K: "Email id", L: "Status", N: "Remarks" }, { B: "WT/20-21/Ref/001", D: "43922", E: "AMD", F: "Poly", H: "Delhi", I: "Anil", J: "98711 99319", K: "Anil@amd.invalid; x@zzown.com", L: "WON", N: "he left the job" }), OWN);
  ok("another's columns: contact, phone, their address not ours, won, and that they left", second[0]?.contact === "Anil" && second[0].phone === "9871199319" && second[0].email === "anil@amd.invalid" && second[0].status === "WON" && second[0].left && second[0].address === "Delhi", second);

  section("Joined");
  const s = (ref: string, company: string, date: string | null, row: number): StatusRow => ({ tab: "19-20", row, ref, company, date, product: "", madeBy: "", status: "WON", statusText: "Won", contact: "", phone: "", email: "", address: "", remarks: "", left: false });
  const f = (file: string, ref: string, company: string, date: string, more: Partial<Quotation> = {}): Quotation => ({ file, folder: "", saved: null, ref, company, contact: "", email: "", date, madeBy: "", lines: [], total: 1, ...more });
  const joined = joinProposals(
    [s("WT/19-20/Ref/001", "Bison Mills", "2019-05-01", 2), s("WT/19-20/Ref/002", "Orbit Enterprises", "2019-06-01", 3), s("WT/19-20/Ref/003", "Nobody's", "2019-06-01", 4), s("WT/19-20/Ref/004", "Twice Ltd", "2019-07-01", 5), s("WT/19-20/Ref/005", "Twice Ltd", "2019-07-03", 6)],
    [
      f("a/Proposal_Adobe.xlsx", "WT/19-20/Ref/001", "Bison Mills Pvt Ltd", "2019-05-01"),
      f("a/Revised Proposal_Adobe.xlsx", "WT/19-20/Ref/001", "Bison Mills", "2019-05-03", { total: 2 }),
      f("b/Proposal.xlsx", "WT/19-20/Ref/099", "Orbit Enterprises", "2019-06-05"),
      f("c/Proposal.xlsx", "WT/19-20/Ref/003", "Somebody Else", "2019-06-01"),
      f("d/Proposal.xlsx", "WT/19-20/Ref/", "Twice Limited", "2019-07-02"),
    ],
  );
  const of = (c: string) => joined.filter((p) => p.company === c);
  ok("two versions are one proposal, the later's figures first", of("Bison Mills").length === 1 && of("Bison Mills")[0]!.joined === "REFERENCE" && of("Bison Mills")[0]!.files[0] === "a/Revised Proposal_Adobe.xlsx" && of("Bison Mills")[0]!.total === 2, of("Bison Mills"));
  ok("a wrong reference: joined to its company's one row that fortnight, and said", of("Orbit Enterprises")[0]?.joined === "DATE" && /joined by company and date/.test(of("Orbit Enterprises")[0]!.issues.join()), of("Orbit Enterprises"));
  ok("a reference somebody else's has doesn't join them", of("Nobody's")[0]?.joined === "SHEET_ONLY" && of("Somebody Else")[0]?.joined === "FILE_ONLY" && of("Somebody Else")[0]!.status === "UNKNOWN");
  ok("two rows it could be: joined to neither", of("Twice Ltd").every((p) => p.joined === "SHEET_ONLY") && of("Twice Limited")[0]?.joined === "FILE_ONLY");
  const halfRead = joinProposals([], [f("h/Proposal.xlsx", "WT/19-20/Ref/20", "Half", "2019-05-01", { total: 10, lines: [{ item: "A", quantity: 1, rate: 10, amount: 10 }] }), f("h/Revised Proposal.pdf", "WT/19-20/Ref/20", "Half", "2019-05-03", { total: null }), f("h/PI.docx", "WT/19-20/Ref/20", "Half", "2019-06-03", { total: 4 })]);
  ok("a later PDF that couldn't be read doesn't lose the figures, and a proforma isn't the latest proposal", halfRead.length === 1 && halfRead[0]!.total === 10 && halfRead[0]!.files[0] === "h/Revised Proposal.pdf" && halfRead[0]!.files[2] === "h/PI.docx" && /earlier version's: Proposal\.xlsx/.test(halfRead[0]!.issues.join()), halfRead);
  const mixed = joinProposals([], [f("e/Proposal_MS Licenses.xlsx", "WT/19-20/Ref/9", "Mix", "2019-05-01"), f("e/Proposal O365 revised.xlsx", "WT/19-20/Ref/9", "Mix", "2019-05-02"), f("g/Proposal_Adobe.xlsx", "WT/19-20/Ref/8", "Mixed Two", "2019-05-01"), f("g/Proposal Corel.xlsx", "WT/19-20/Ref/8", "Mixed Two", "2019-05-02")]);
  ok("Adobe and Corel under one reference are said; MS Licenses and O365 aren't", !mixed[0]!.issues.some((i) => /different proposals/.test(i)) && mixed[1]!.issues.some((i) => /different proposals/.test(i)), mixed.map((p) => p.issues));
}

async function preview() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const action = require("../src/actions/old-proposals") as typeof import("../src/actions/old-proposals");
  const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
  const Page = (require("../src/app/(dashboard)/settings/data/old-proposals/page") as { default: () => Promise<unknown> }).default;
  const { Result } = require("../src/components/settings/old-proposals-preview") as typeof import("../src/components/settings/old-proposals-preview");
  /* eslint-enable @typescript-eslint/no-require-imports */
  section("The preview");
  const boss = await db.user.create({ data: { name: "Zz Boss", email: "zz-old-boss@zzold.invalid", role: "ADMIN", isSuperAdmin: true, passwordHash: "x" } });
  const other = await db.user.create({ data: { name: "Zz Other", email: "zz-old-other@zzold.invalid", role: "ADMIN", passwordHash: "x" } });
  const company = async (name: string, more: object = {}) => db.company.create({ data: { name, normalizedName: name.toLowerCase(), createdById: boss.id, ...more } as never });
  const bison = await company("Bison Mills Private Limited");
  await company("Renamed Now Ltd", { formerNames: "Once Called Ltd" });
  const acme = await company("Acme Holdings");
  await company("Twin Traders Pvt Ltd");
  await company("Twin Traders Private Limited");
  await company("Seller Vendor", { relationshipType: "VENDOR" });
  await company("Both Ways", { relationshipType: "VENDOR", alsoCustomer: true });
  await company("Web Works", { website: "https://www.webworks-zz.com/about" });
  await db.contact.create({ data: { companyId: bison.id, name: "Deepak Z", email: "Deepak@bison-zz.com" } as never });
  await db.contact.create({ data: { companyId: acme.id, name: "Asha Z", email: "asha.zz@gmail.com" } as never });
  const m = await db.migration.create({ data: { source: "zoho-books", yearStart: new Date("2026-04-01"), switchDate: new Date("2026-07-01"), createdById: boss.id } as never });
  await db.archivedDocument.create({ data: { migrationId: m.id, kind: "QUOTE", key: "QUOTE:bison:Z1", number: "ZH/19-20/QT/7", date: new Date("2019-07-31"), year: "2019-20", companyId: bison.id, partyName: "Bison Mills", total: 148680 } });

  const p = (key: string, name: string, more: Partial<OldProposal> = {}): OldProposal => ({ key, ref: `WT/19-20/Ref/${key}`, year: "2019", date: "2019-07-30", company: name, alsoNamed: [], contact: "", phone: "", email: "", address: "", madeBy: "", product: "Corel", status: "LOST", remarks: "", left: false, lines: [], total: null, files: [], attachments: [], joined: "SHEET_ONLY", issues: [], ...more });
  const proposals = [
    p("1", "Bison Mills Pvt. Ltd.", { email: "deepak@bison-zz.com", total: 148680, files: ["a", "b"] }),
    p("2", "BISON  mills private limited", { email: "new@bison-zz.com", left: true }),
    p("3", "Once Called Limited"),
    p("4", "Acme Grp", { email: "asha.zz@gmail.com" }),
    p("5", "Bisn", { email: "someone@bison-zz.com" }),
    p("6", "Twin Traders (P) Ltd"),
    p("7", "Seller Vendor", { status: "WON" }),
    p("8", "Both Ways"),
    p("9", "Web Wrks", { email: "info@webworks-zz.com" }),
    p("10", "Nowhere Won", { status: "WON", email: "a@nowhere-zz.com" }),
    p("11", "Nowhere Won Pvt Ltd", { status: "PENDING" }),
    p("12", "Nowhere Lost"),
    p("13", "Stranger", { alsoNamed: ["Acme Holdings"], status: "WON" }),
    p("14", "Nowhere Won", { status: "WON", email: "A@nowhere-zz.com", issues: ["No date that reads"] }),
    p("15", "Gmail Only", { email: "nobody.zz@gmail.com", status: "UNKNOWN" }),
    p("16", "Ac Me Hold Ings"),
  ];
  const pack = (over: object = {}) => gzipSync(Buffer.from(JSON.stringify({ version: 1, made: "2026-11-25T10:00:00Z", proposals, unread: [{ file: "x.pdf", why: "Not an .xlsx — kept as a file, not read" }], otherFiles: 1, ...over }))).toString("base64");

  actorId = other.id;
  const refused = await action.previewOldProposalsFile(pack());
  ok("another admin is refused", !refused.ok);
  ok("  and the page isn't there for them", await Page().then(() => false, (e: Error) => e.message === "NOT_FOUND"));
  actorId = boss.id;
  for (const [what, b] of [["not gzip", Buffer.from("hello").toString("base64")], ["not a prepared file", gzipSync(Buffer.from("{}")).toString("base64")], ["an older one", pack({ version: 0 })], ["a status it doesn't know", pack({ proposals: [{ ...proposals[0], status: "MAYBE" }] })], ["one that unpacks past the limit", gzipSync(Buffer.alloc(41 * 1024 * 1024, 32)).toString("base64")], ["nothing", ""]] as const) {
    const r = await action.previewOldProposalsFile(b);
    ok(`refused: ${what}`, !r.ok, r.ok ? "taken" : "");
  }
  const tables = async () => JSON.stringify(await Promise.all([db.company.count(), db.contact.count(), db.lead.count(), db.archivedDocument.count(), db.tradeDocument.count(), db.auditLog.count()]));
  const before = await tables();
  const r = await action.previewOldProposalsFile(pack());
  if (!r.ok) return ok("the preview", false, r.error);
  const row = (key: string) => r.data.rows.find((x) => x.key === key)!;
  ok("nothing is written", (await tables()) === before);
  ok("the same name in another legal form comes in", row("1").outcome === "BRING" && row("1").to?.seq === bison.companySeq && !row("1").newContact, row("1"));
  ok("  and says the Zoho quote it looks the same as", row("1").zoho === "ZH/19-20/QT/7" && r.data.alreadyZoho === 1);
  ok("a person its company hasn't is a contact to add, marked left", row("2").outcome === "BRING" && row("2").newContact && row("2").left && r.data.contactsLeft === 1);
  ok("a name it went by before", row("3").outcome === "BRING" && row("3").to?.name === "Renamed Now Ltd", row("3"));
  ok("a contact's own address is only a suggestion", row("4").outcome === "LOOK" && row("4").to?.seq === acme.companySeq, row("4"));
  ok("so is a work domain", row("5").outcome === "LOOK" && row("5").to?.seq === bison.companySeq && row("9").outcome === "LOOK" && row("9").to?.name === "Web Works", [row("5"), row("9")]);
  ok("two companies of one name: for somebody to choose", row("6").outcome === "LOOK" && row("6").to === null, row("6"));
  ok("a vendor is looked at; one that also buys comes in", row("7").outcome === "LOOK" && row("8").outcome === "BRING", [row("7"), row("8")]);
  ok("not here, however it ended: its company made, once for all its proposals", ["10", "11", "12", "14", "15"].every((k) => row(k).outcome === "CREATE") && r.data.newCompanies === 3, r.data.newCompanies);
  ok("  with its contact, once", row("10").newContact && r.data.newContacts === 3, r.data.newContacts);
  ok("a name spaced otherwise is only a suggestion", row("16").outcome === "LOOK" && row("16").to?.seq === acme.companySeq, row("16"));
  ok("a company only the folder names, unlike the sheet's: looked at", row("13").outcome === "LOOK" && row("13").to?.seq === acme.companySeq, row("13"));
  ok("the counts add up", r.data.byStatus.reduce((t, s) => t + s.BRING + s.CREATE + s.LOOK + s.HERE, 0) === 16 && r.data.total === 16 && r.data.versions === 1 && r.data.unread.total === 1);

  section("The page");
  const page = (await renderHtml(Page())).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  ok("the super admin's page says it writes nothing", /Old proposals/.test(page) && /nothing is written until you bring them in/.test(page) && /Choose the prepared file/.test(page), page.slice(0, 200));
  const shown = (await renderHtml(createElement(Result, { result: r.data }))).replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/\s+/g, " ");
  ok("what would happen, each with why", /Would come in/.test(shown) && /Not in Deskzo/.test(shown) && /Looks the same as Zoho's ZH\/19-20\/QT\/7/.test(shown) && /marked as left/.test(shown), shown.slice(0, 400));
  await importing(boss.id, other.id, bison.id, acme.id, pack);
}

async function importing(bossId: string, otherId: string, bisonId: string, acmeId: string, pack: (over?: object) => string) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const action = require("../src/actions/old-proposals") as typeof import("../src/actions/old-proposals");
  const runLib = require("../src/lib/old-proposals/run") as typeof import("../src/lib/old-proposals/run");
  const filesLib = require("../src/lib/old-proposals/files") as typeof import("../src/lib/old-proposals/files");
  const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
  const { OldProposals } = require("../src/components/companies/old-proposals") as typeof import("../src/components/companies/old-proposals");
  /* eslint-enable @typescript-eslint/no-require-imports */
  section("Bringing them in");
  actorId = otherId;
  ok("another admin can't", !(await action.startOldProposalsImport(pack(), {}, true)).ok);
  actorId = bossId;
  ok("not without confirming", !(await action.startOldProposalsImport(pack(), {}, false)).ok);
  backupOk = false;
  ok("no backup, no import", !(await action.startOldProposalsImport(pack(), {}, true)).ok && (await db.oldProposalImport.count()) === 0 && (await db.oldProposal.count()) === 0);
  backupOk = true;
  const before = { companies: await db.company.count(), contacts: await db.contact.count(), leads: await db.lead.count(), docs: await db.tradeDocument.count(), notes: await db.notification.count() };
  // Acme's suggested, the domain's its own company, the rest later.
  const started = await action.startOldProposalsImport(pack(), { "4": "SUGGESTED", "9": "NEW", "6": "SUGGESTED" }, true);
  const id = started.ok ? started.data.id : "";
  ok("started, the backup kept with it", started.ok && (await db.oldProposalImport.findUnique({ where: { id }, select: { backupId: true } }))?.backupId === "zz-backup", started);
  ok("  one at a time", !(await action.startOldProposalsImport(pack(), {}, true)).ok);
  await db.$executeRaw`update "old_proposal_imports" set "progress" = jsonb_set("progress", '{lease}', to_jsonb(${new Date(Date.now() + 60_000).toISOString()}::text))`;
  const held = await action.stepOldProposalsImport(id);
  ok("  a step another tab has does nothing", held.ok && held.data.progress.at === 0 && (await db.oldProposal.count()) === 0);
  await db.$executeRaw`update "old_proposal_imports" set "progress" = "progress" - 'lease'`;
  const end = async (run: string) => {
    for (let i = 0; i < 50; i++) {
      const r = await action.stepOldProposalsImport(run);
      if (!r.ok || r.data.status !== "IMPORTING") return r;
    }
    return null;
  };
  // Stopped part way: carried on, nothing twice.
  await runLib.importPart(id, bossId, 1);
  const partway = await db.oldProposal.count();
  const ended = await end(id);
  ok("stopped part way and carried on to the end", ended?.ok === true && ended.data.status === "DONE" && partway < 11, { partway, ended });
  // 16 in all; 5, 6 (two companies), 7, 13, 16 wait.
  ok("each where it should be, those undecided left", (await db.oldProposal.count()) === 11 && (await db.oldProposal.count({ where: { key: { in: ["5", "6", "7", "13", "16"] } } })) === 0, await db.oldProposal.findMany({ select: { key: true } }));
  const at = async (key: string) => db.oldProposal.findUnique({ where: { key }, select: { companyId: true, status: true, total: true, paths: true, year: true, company: { select: { name: true, stage: true, tags: true, ownerUserId: true } } } });
  ok("  the same company in another legal form; its figures", (await at("1"))?.companyId === bisonId && Number((await at("1"))!.total) === 148680 && (await at("1"))!.year === "2019-20", await at("1"));
  ok("  the suggested one, as decided", (await at("4"))?.companyId === acmeId);
  const own = await at("9");
  ok("  its own company, as decided", own?.company.name === "Web Wrks" && own.company.tags.includes("Old proposals") && own.company.stage === "PROSPECT" && own.company.ownerUserId === null, own);
  const won = [await at("10"), await at("11"), await at("14")];
  ok("  three proposals of one company, its name ended otherwise: one company made", new Set(won.map((w) => w?.companyId)).size === 1, won);
  ok("  lost and not here: made too", (await at("12"))?.company.name === "Nowhere Lost" && (await at("15"))?.company.name === "Gmail Only");
  ok("  four companies made and no more", (await db.company.count()) === before.companies + 4, { before: before.companies, now: await db.company.count() });
  const people = await db.contact.findMany({ where: { companyId: bisonId }, select: { email: true, leftAt: true } });
  ok("  a person added where nobody has the address, marked left; one there isn't added again", people.length === 2 && people.some((c) => c.email === "new@bison-zz.com" && c.leftAt), people);
  ok("  no lead, no document, nobody told", (await db.lead.count()) === before.leads && (await db.tradeDocument.count()) === before.docs && (await db.notification.count()) === before.notes);
  const shown = (await renderHtml(OldProposals({ companyId: bisonId, companyName: "Bison Mills Private Limited" }))).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  ok("  on its company: reference, status and total", /WT\/19-20\/Ref\/1 /.test(shown) && /Lost/.test(shown) && /₹1,48,680\.00/.test(shown), shown.slice(0, 300));
  const againPreview = await action.previewOldProposalsFile(pack());
  ok("the same file again: those are here already", againPreview.ok && againPreview.data.rows.filter((r) => r.outcome === "HERE").length === 11);
  const second = await action.startOldProposalsImport(pack(), { "16": "SUGGESTED" }, true);
  await end(second.ok ? second.data.id : "");
  ok("  and a later decision brings only that one", (await db.oldProposal.count()) === 12 && (await at("16"))?.companyId === acmeId);
  ok("  with nothing left to bring, it says so", !(await action.startOldProposalsImport(pack(), {}, true)).ok);

  section("Their files");
  ok("only the latest version's is wanted", JSON.stringify(await filesLib.filesWanted()) === JSON.stringify(["a"]));
  const pdf = Buffer.from("%PDF-1.4 zz");
  await db.oldProposal.update({ where: { key: "1" }, data: { paths: ["2019/Bison/P.xlsx", "2019/Bison/Old.pdf"], attachments: ["2019/Bison/EUF.doc"] } });
  ok("a file no proposal names isn't kept", !(await filesLib.keepOldProposalFile("2019/Bison/Other.pdf", pdf)));
  ok("nor one that isn't what it's called", !(await filesLib.keepOldProposalFile("2019/Bison/P.xlsx", Buffer.from("<html>"))) && !(await filesLib.keepOldProposalFile("2019/Bison/Old.pdf", Buffer.from("PK\x03\x04"))));
  ok("kept once", (await filesLib.keepOldProposalFile("2019/Bison/P.xlsx", Buffer.from("PK\x03\x04zz"))) && !(await filesLib.keepOldProposalFile("2019/Bison/P.xlsx", Buffer.from("PK\x03\x04zz"))) && (await db.oldProposalFile.count()) === 1 && (await filesLib.filesWanted()).join() === "2019/Bison/EUF.doc");
  ok("and a paper beside it", (await filesLib.keepOldProposalFile("2019/Bison/EUF.doc", Buffer.from("\xd0\xcf\x11\xe0zz", "latin1"))) && (await filesLib.filesWanted()).length === 0);
  const fileId = (await db.oldProposalFile.findFirstOrThrow({ where: { name: "P.xlsx" }, select: { id: true } })).id;
  const open = (require("../src/app/api/old-proposals/[id]/route") as typeof import("../src/app/api/old-proposals/[id]/route")).GET; // eslint-disable-line @typescript-eslint/no-require-imports
  const get = () => open(new Request("http://x.invalid"), { params: Promise.resolve({ id: fileId }) });
  const got = await get();
  ok("it opens for who may see the company's documents, as a file to save", got.status === 200 && /^attachment/.test(got.headers.get("content-disposition") ?? "") && got.headers.get("x-content-type-options") === "nosniff", got.status);
  actorId = "";
  ok("  not signed in: not found", (await get()).status === 404);
  const nobody = await db.user.create({ data: { name: "Zz Nobody", email: "zz-old-nobody@zzold.invalid", role: "PROFILE", passwordHash: "x" } });
  actorId = nobody.id;
  ok("  and somebody who can't see them: not found", (await get()).status === 404);
  const files = require("../src/app/api/old-proposals/files/route") as typeof import("../src/app/api/old-proposals/files/route"); // eslint-disable-line @typescript-eslint/no-require-imports
  ok("  the list of files wanted is the super admin's", (await files.GET()).status === 404);
  actorId = bossId;
  ok("  an upload from elsewhere is refused", (await files.POST(new Request("http://zz.invalid/api", { method: "POST", headers: { origin: "http://evil.invalid", host: "zz.invalid" }, body: "x" }))).status === 403);

  section("Moved to another company");
  // "4" came in on Acme by a contact's address; "2" brought new@bison-zz.com to Bison.
  const moving = async (key: string) => (await db.oldProposal.findUniqueOrThrow({ where: { key }, select: { id: true, companyId: true } }));
  const four = await moving("4");
  actorId = otherId;
  ok("another admin can't", !(await action.moveOldProposalTo(four.id, bisonId)).ok && (await moving("4")).companyId === acmeId);
  actorId = bossId;
  ok("nor to where it is, nor to nowhere", !(await action.moveOldProposalTo(four.id, acmeId)).ok && !(await action.moveOldProposalTo(four.id, "zz-none")).ok && !(await action.moveOldProposalTo("zz-none", bisonId)).ok);
  const toBison = await action.moveOldProposalTo(four.id, bisonId);
  ok("moved, and logged", toBison.ok && toBison.data.name === "Bison Mills Private Limited" && (await moving("4")).companyId === bisonId && (await db.auditLog.count({ where: { entityType: "OldProposal", entityLabel: { contains: "from Acme Holdings to Bison Mills" } } })) === 1, toBison);
  ok("  somebody at Acme before the import stays there", (await db.contact.count({ where: { companyId: acmeId, email: "asha.zz@gmail.com" } })) === 1 && toBison.ok && !toBison.data.contact);
  const two = await moving("2");
  const companiesBefore = await db.company.count();
  await db.oldProposal.update({ where: { id: two.id }, data: { madeFor: "Zz Own Name" } });
  const ownCompany = await action.moveOldProposalTo(two.id, null);
  const newHome = (await moving("2")).companyId;
  ok("to its own company, made, with the contact the import added", ownCompany.ok && ownCompany.data.contact && (await db.company.count()) === companiesBefore + 1 && (await db.contact.count({ where: { companyId: newHome, email: "new@bison-zz.com" } })) === 1 && (await db.contact.count({ where: { companyId: bisonId, email: "new@bison-zz.com" } })) === 0, ownCompany);
  ok("  moved to its own again: it's there already", !(await action.moveOldProposalTo(two.id, null)).ok);
  await db.contact.create({ data: { companyId: acmeId, name: "Zz Same", email: "NEW@bison-zz.com" } });
  const toAcme = await action.moveOldProposalTo(two.id, acmeId);
  ok("  to one that has the address: not two of them", toAcme.ok && (await db.contact.count({ where: { email: { equals: "new@bison-zz.com", mode: "insensitive" } } })) === 1, toAcme);
  const ten = await moving("10");
  await action.moveOldProposalTo(ten.id, acmeId);
  ok("  a contact another old proposal there names stays", (await db.contact.count({ where: { companyId: ten.companyId, email: "a@nowhere-zz.com" } })) === 1);
  await action.moveOldProposalTo(ten.id, ten.companyId);
  const { MoveOldProposal } = require("../src/components/companies/old-proposal-move") as typeof import("../src/components/companies/old-proposal-move"); // eslint-disable-line @typescript-eslint/no-require-imports
  const offered = await renderHtml(createElement(MoveOldProposal, { proposalId: "x", companyId: "y", madeFor: "Z", offerOwn: true }));
  const withMove = await renderHtml(OldProposals({ companyId: bisonId, companyName: "Bison", canMove: true }));
  const without = await renderHtml(OldProposals({ companyId: bisonId, companyName: "Bison" }));
  ok("offered to the super admin only", /Wrong company\? Move it/.test(offered) && /Wrong company/.test(withMove) && !/Wrong company/.test(without));
  // As they were, for the undo below.
  await action.moveOldProposalTo(four.id, acmeId);
  await db.contact.deleteMany({ where: { companyId: acmeId, name: "Zz Same" } });

  section("Undone");
  ok("not without typing UNDO", !(await action.undoOldProposalsImport(id, "yes")).ok);
  // Somebody called "Nowhere Lost" since: it is theirs now.
  const lost = (await at("12"))!.companyId;
  await db.lead.count();
  await db.note.create({ data: { companyId: lost, authorId: bossId, body: "Called" } as never }).catch(async () => {
    await db.contact.create({ data: { companyId: lost, name: "Zz typed in by hand" } });
  });
  for (let i = 0; i < 20; i++) {
    const r = await action.undoOldProposalsImport(id, "UNDO");
    if (!r.ok || r.data.done) break;
  }
  ok("the proposals go, the other import's stays", (await db.oldProposal.count()) === 1 && (await at("16")) !== null && (await db.oldProposalFile.count()) === 0);
  ok("companies it made go, but one built on since", (await db.company.count()) === before.companies + 1 && (await db.company.count({ where: { id: lost } })) === 1, await db.company.count());
  ok("contacts it made go; those typed in stay", (await db.contact.count({ where: { companyId: bisonId } })) === 1 && (await db.contact.count({ where: { companyId: acmeId } })) === 1);
  ok("and not twice", !(await action.undoOldProposalsImport(id, "UNDO")).ok);
  const back = await action.startOldProposalsImport(pack(), {}, true);
  const backEnd = await end(back.ok ? back.data.id : "");
  ok("brought in again after", backEnd?.ok === true && backEnd.data.status === "DONE" && (await at("1"))?.companyId === bisonId);
}

async function main() {
  reading();
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is needed.");
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname)) throw new Error("Only against a local database server.");
  const scratchName = `${new URL(url).pathname.slice(1)}_old_proposals_check`;
  const scratchUrl = withDatabase(url, scratchName);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  section("A scratch workspace");
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
  try {
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = " ";
    process.env.DESKZO_TENANCY_FALLBACK = "legacy";
    await preview();
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    await admin.$disconnect();
  }
  console.log(failures === 0 ? "\nAll old proposal checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
