/**
 * check:tds — TDS on what a company pays its vendors (owner, 25 Oct 2026; src/lib/tds):
 *
 *   · the section list: ten sections of the Income-tax Act, 2025 with their 1961 numbers, a typed old
 *     number read as its section, an ambiguous one ("194J") as none;
 *   · who the vendor is from its PAN, and the rate without one — 20%, or 5% for goods, never twice the rate;
 *   · the advice for a bill: below the limits nothing, a single payment over its limit, the bill that takes
 *     the year past the limit owing the earlier bills' TDS with it, goods taxed only over ₹50 lakh, rent a
 *     month at a time, a lower deduction certificate while it is valid and not used up — and part used;
 *   · the TDS summary's due date: the 7th of the next month, March's on 30 April;
 *   · on a scratch workspace database (<db>_tds_check, built from the migrations and dropped at the end):
 *     a vendor's usual section and certificates set by finance only, refused for anyone else; a bill's
 *     advice from the vendor's year — the bills below the limit counted under the usual section, a typed
 *     "194C" counted too, a draft, a cancelled bill and last year's not; the year's shortfalls for the TDS
 *     page, largest first, a nil certificate owing nothing, and the page itself; and the vendor's card, rendered.
 *
 *   npm run check:tds
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import Module from "node:module";
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
const day = (d: string) => new Date(`${d}T00:00:00Z`);

let actorId = "";
const roles = new Map<string, string>();
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") return { useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {}, prefetch() {} }), usePathname: () => "/companies", useSearchParams: () => new URLSearchParams() };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: roles.get(actorId) ?? "PROFILE", name: "Zz Checker", email: `${actorId}@zztds.invalid` } : null);
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

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const rules = require("../src/lib/tds/rules") as typeof import("../src/lib/tds/rules");
  const sections = require("../src/lib/tds/sections") as typeof import("../src/lib/tds/sections");
  const { buildTdsSummary } = require("../src/lib/ledger/gst-returns") as typeof import("../src/lib/ledger/gst-returns");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const S = (key: string) => sections.sectionByKey(key)!;

  section("The sections");
  const keys = sections.TDS_SECTIONS.map((s) => s.key);
  ok("ten sections, each key once", keys.length === 10 && new Set(keys).size === 10, keys);
  ok("  each with its place in the 2025 Act and a no-PAN floor", sections.TDS_SECTIONS.every((s) => /^s\.393\(1\) Table Sl\. /.test(s.reference) && s.noPanMinimum > 0));
  ok("  and when they were last checked", sections.SECTIONS_AS_OF.length > 0);
  const of = (text: string) => sections.sectionOf(text)?.key ?? null;
  ok("a typed 1961 number is its section: 194C, sec. 194H, 194 J(b)", of("194C") === "CONTRACTOR" && of("Sec. 194H") === "COMMISSION" && of("194 J(b)") === "PROFESSIONAL" && of("194j(a)") === "TECHNICAL", [of("194C"), of("Sec. 194H"), of("194 J(b)"), of("194j(a)")]);
  ok("  a key is itself", of("RENT_LAND") === "RENT_LAND" && of("GOODS") === "GOODS");
  ok("  194J alone could be 2% or 10%, so it is none; 194IA is property, not rent", of("194J") === null && of("194IA") === null, [of("194J"), of("194IA")]);
  ok("  nothing typed is none", of("") === null && sections.sectionOf(null) === null);
  ok("a section's rates and limits in a line", sections.rateText(S("CONTRACTOR")) === "1% for an individual or HUF, 2% otherwise; none until over ₹30,000 a payment or ₹1,00,000 in the tax year", sections.rateText(S("CONTRACTOR")));
  ok("  goods: on what goes over", sections.rateText(S("GOODS")) === "0.1%, on what goes over ₹50,00,000 in the tax year", sections.rateText(S("GOODS")));
  ok("  director's fees: no limit", sections.rateText(S("DIRECTOR")) === "10%");

  section("Who the vendor is");
  ok("P in the fourth place is an individual, H a HUF", rules.deducteeKind("ABCPK1234L") === "INDIVIDUAL_HUF" && rules.deducteeKind("ABCHK1234L") === "INDIVIDUAL_HUF");
  ok("  C, F and the rest are other", rules.deducteeKind("AAACZ1234F") === "OTHER" && rules.deducteeKind("AAAFZ1234F") === "OTHER");
  ok("  no PAN, or not one, is other", rules.deducteeKind(null) === "OTHER" && rules.deducteeKind("ABCPK1234") === "OTHER");
  ok("a PAN in lower case, with spaces, is read", rules.validPan(" abcpk1234l ") === "ABCPK1234L" && rules.validPan("ABCPK12345") === null);
  ok("the tax year runs April to March", rules.taxYearStart("2026-04-01") === "2026-04-01" && rules.taxYearStart("2027-03-31") === "2026-04-01" && rules.taxYearStart("2026-03-31") === "2025-04-01");
  ok("no PAN: 20% — not twice the rate", rules.noPanRate(S("CONTRACTOR"), 1) === 20 && rules.noPanRate(S("PROFESSIONAL"), 10) === 20);
  ok("  5% for purchase of goods", rules.noPanRate(S("GOODS"), 0.1) === 5);

  section("A bill's advice");
  const individual = "ABCPK1234L";
  const company = "AAACZ1234F";
  const advice = (key: string, over: Partial<Parameters<typeof rules.tdsAdvice>[0]> = {}) =>
    rules.tdsAdvice({ section: S(key), pan: company, certificate: null, amount: 0, yearSoFar: 0, deductedSoFar: 0, day: "2026-07-10", ...over });

  const small = advice("CONTRACTOR", { amount: 25_000, pan: individual });
  ok("a contractor's first ₹25,000: nothing yet, and why", !small.due && small.basis === "BELOW_LIMIT" && small.note.includes("₹30,000 a payment") && small.note.includes("₹1,00,000 in the year"), small);
  const single = advice("CONTRACTOR", { amount: 35_000, pan: individual });
  ok("a single ₹35,000: 1% for an individual", single.due && single.rate === 1 && single.basis === "NORMAL" && single.shortfall === 0, single);
  ok("  2% for a company", advice("CONTRACTOR", { amount: 35_000 }).rate === 2);
  const crossing = advice("CONTRACTOR", { amount: 20_000, yearSoFar: 90_000 });
  ok("₹20,000 after ₹90,000 below the limit: due, and the earlier ₹90,000's ₹1,800 owed with it", crossing.due && crossing.rate === 2 && crossing.shortfall === 1800 && crossing.note.includes("₹1,800"), crossing);
  const past = advice("CONTRACTOR", { amount: 20_000, yearSoFar: 1_10_000, deductedSoFar: 2_200 });
  ok("  once past it, a bill owes only its own", past.due && past.shortfall === 0, past);
  const noPan = advice("CONTRACTOR", { amount: 35_000, pan: null });
  ok("no PAN on file: 20%, saying to add it", noPan.due && noPan.rate === 20 && noPan.basis === "NO_PAN" && /Add its PAN/.test(noPan.note), noPan);
  ok("  a PAN that isn't one is the same", advice("CONTRACTOR", { amount: 35_000, pan: "NOTAPAN" }).basis === "NO_PAN");

  const cert = { certificateNo: "ZZCERT1234", ratePercent: 0.5, amountLimit: 5_00_000, usedSoFar: 0, validFrom: "2026-04-01", validTo: "2026-12-31" };
  const withCert = advice("CONTRACTOR", { amount: 40_000, certificate: cert });
  ok("a lower deduction certificate: its rate, and what's left of it", withCert.rate === 0.5 && withCert.basis === "CERTIFICATE" && withCert.note.includes("ZZCERT1234") && withCert.note.includes("₹4,60,000"), withCert);
  ok("  not after it ends", advice("CONTRACTOR", { amount: 40_000, certificate: cert, day: "2027-01-01" }).basis === "NORMAL");
  ok("  nor before it starts", advice("CONTRACTOR", { amount: 40_000, certificate: { ...cert, validFrom: "2026-08-01" } }).basis === "NORMAL");
  ok("  nor once used up", advice("CONTRACTOR", { amount: 40_000, certificate: { ...cert, usedSoFar: 5_00_000 } }).basis === "NORMAL");
  const part = advice("CONTRACTOR", { amount: 40_000, certificate: { ...cert, usedSoFar: 4_90_000 } });
  ok("  with ₹10,000 of it left: 0.5% on that and 2% on the rest — 1.63% over the bill", part.basis === "CERTIFICATE" && part.rate === 1.63 && /covers only ₹10,000 more/.test(part.note), part);
  ok("  a nil certificate is 0%", advice("CONTRACTOR", { amount: 40_000, certificate: { ...cert, ratePercent: 0 } }).rate === 0);
  ok("  but no PAN outranks it", advice("CONTRACTOR", { amount: 40_000, certificate: cert, pan: null }).basis === "NO_PAN");

  const goods = advice("GOODS", { amount: 3_00_000, yearSoFar: 49_00_000 });
  ok("goods: only the ₹2,00,000 over ₹50 lakh, at 0.1%", goods.due && goods.rate === 0.1 && goods.base === 2_00_000 && goods.shortfall === 0 && goods.note.includes("₹2,00,000"), goods);
  ok("  the rate box: 0.07% of the whole bill", rules.effectiveRate(goods, 3_00_000) === 0.07, rules.effectiveRate(goods, 3_00_000));
  ok("  below ₹50 lakh, nothing", !advice("GOODS", { amount: 3_00_000, yearSoFar: 40_00_000 }).due);
  ok("  without a PAN, 5%", advice("GOODS", { amount: 3_00_000, yearSoFar: 49_00_000, pan: null }).rate === 5);
  const whole = advice("GOODS", { amount: 3_00_000, yearSoFar: 60_00_000 });
  ok("  past it already, the whole bill", whole.base === 3_00_000 && rules.effectiveRate(whole, 3_00_000) === 0.1);

  ok("rent of ₹45,000 for a month: nothing", !advice("RENT_LAND", { amount: 45_000, yearSoFar: 4_50_000 }).due);
  ok("  ₹60,000: 10% on a building, 2% on machinery", advice("RENT_LAND", { amount: 60_000 }).rate === 10 && advice("RENT_PLANT", { amount: 60_000 }).rate === 2);
  ok("director's fees: from the first rupee", advice("DIRECTOR", { amount: 5_000 }).due && advice("DIRECTOR", { amount: 5_000 }).rate === 10);
  ok("commission past ₹20,000 in the year", !advice("COMMISSION", { amount: 15_000 }).due && advice("COMMISSION", { amount: 6_000, yearSoFar: 15_000 }).shortfall === 300);
  ok("the rate box for a bill that needn't deduct is 0", rules.effectiveRate(small, 25_000) === 0);

  section("When it is due");
  const due = (month: number, year: number) => buildTdsSummary({ docs: [], withholdings: [], month, year }).dueOn;
  ok("September's TDS by 7 October", due(9, 2026) === "2026-10-07", due(9, 2026));
  ok("  December's by 7 January", due(12, 2026) === "2027-01-07", due(12, 2026));
  ok("  March's by 30 April", due(3, 2027) === "2027-04-30", due(3, 2027));

  challanRules();
  form140Rules();
  await scratch();
}

function challanRules() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const c = require("../src/lib/tds/challan-rules") as typeof import("../src/lib/tds/challan-rules");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("A challan's numbers");
  ok("the head: 0020 for a company's PAN, 0021 for a person's or a firm's, none without one", c.majorHeadFor("AAACZ1234F") === "0020" && c.majorHeadFor("ABCPK1234L") === "0021" && c.majorHeadFor("AAAFZ1234F") === "0021" && c.majorHeadFor(null) === null && c.majorHeadFor("AAACZ") === null);
  ok("a BSR code is seven digits, spaces dropped", c.bsrCodeOf(" 051 0032 ") === "0510032" && c.bsrCodeOf("051003") === null && c.bsrCodeOf("05100AB") === null);
  ok("the serial is written as five digits", c.challanSerialOf("42") === "00042" && c.challanSerialOf("00042") === "00042" && c.challanSerialOf("0") === null && c.challanSerialOf("123456") === null);
  ok("the CIN: BSR code, the day as DDMMYYYY, the serial", c.challanCin({ bsrCode: "0510032", paidOn: "2026-08-07", challanSerial: "00042" }) === "05100320708202600042");
  ok("salary is 192, beside the list's sections", c.challanSectionLabel("SALARY") === "192 — Salary" && c.challanSectionLabel("CONTRACTOR") === "194C — Payment to a contractor" && c.isChallanSection("SALARY") && !c.isChallanSection("194C"));
  ok("due: the 7th of the next month", c.depositDueOn("2026-09-15") === "2026-10-07" && c.depositDueOn("2026-12-31") === "2027-01-07");
  ok("  March's by 30 April", c.depositDueOn("2027-03-10") === "2027-04-30");

  section("Interest for depositing late");
  ok("by the due date, none", c.lateDepositInterest([{ amount: 10_000, deductedOn: "2026-09-15" }], "2026-10-07").interest === 0);
  const day = c.lateDepositInterest([{ amount: 10_000, deductedOn: "2026-09-15" }], "2026-10-08");
  ok("a day late: September and October, two months at 1.5% — ₹300", day.interest === 300 && day.late[0]?.months === 2, day);
  const two = c.lateDepositInterest(
    [
      { amount: 10_000, deductedOn: "2026-09-15" },
      { amount: 5_000, deductedOn: "2026-09-30" },
    ],
    "2026-11-02",
  );
  ok("  paid in November: three months each — ₹450 and ₹225", two.interest === 675 && two.late.every((l) => l.months === 3), two);
  ok("March's on 30 April, none; on 1 May, three months", c.lateDepositInterest([{ amount: 1_000, deductedOn: "2027-03-10" }], "2027-04-30").interest === 0 && c.lateDepositInterest([{ amount: 1_000, deductedOn: "2027-03-10" }], "2027-05-01").interest === 45);
  ok("to the rupee", c.lateDepositInterest([{ amount: 333, deductedOn: "2026-09-15" }], "2026-10-08").interest === 10);

  section("A month's deposits, by section and head");
  const d = (over: Partial<import("../src/lib/tds/challan-rules").TdsDeduction>) => ({ ref: "x", kind: "BILL" as const, sectionKey: "CONTRACTOR", majorHead: "0021" as const, headKnown: true, amount: 100, deductedOn: "2026-07-01", party: "P", docNumber: null, challanId: null, ...over });
  const groups = c.depositGroups([
    d({ ref: "s", kind: "SALARY", sectionKey: "SALARY", amount: 5_000 }),
    d({ ref: "a", amount: 250, challanId: "c1" }),
    d({ ref: "b", amount: 100 }),
    d({ ref: "n", sectionKey: null, amount: 40 }),
    d({ ref: "k", majorHead: "0020", amount: 1_000 }),
    d({ ref: "p", sectionKey: "PROFESSIONAL", amount: 600 }),
  ]);
  const shape = groups.map((g) => `${g.sectionKey}/${g.majorHead} ${g.deducted} ${g.deposited} ${g.left} ${g.open.map((o) => o.ref).join("")}`);
  ok(
    "the list's order, companies first, then a section not from the list, then salary — each with what's deposited and left",
    shape.join(" | ") === "CONTRACTOR/0020 1000 0 1000 k | CONTRACTOR/0021 350 250 100 b | PROFESSIONAL/0021 600 0 600 p | null/0021 40 0 40 n | SALARY/0021 5000 0 5000 s",
    shape,
  );
}

function form140Rules() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const f = require("../src/lib/tds/form140-format") as typeof import("../src/lib/tds/form140-format");
  /* eslint-enable @typescript-eslint/no-require-imports */
  type Statement = import("../src/lib/tds/form140-format").Form140;

  section("Form 140: quarters, codes, text");
  ok("the quarters: April–June … January–March of the next year", JSON.stringify([f.quarterRange(2026, 1), f.quarterRange(2026, 4)]) === JSON.stringify([{ from: "2026-04-01", to: "2026-06-30" }, { from: "2027-01-01", to: "2027-03-31" }]));
  ok("  a day's quarter", JSON.stringify([f.quarterOf("2026-07-01"), f.quarterOf("2027-02-10"), f.quarterOf("2026-06-30")]) === JSON.stringify([{ taxYear: 2026, quarter: 2 }, { taxYear: 2026, quarter: 4 }, { taxYear: 2026, quarter: 1 }]));
  ok("  due 31 July, 31 October, 31 January, 31 May", [1, 2, 3, 4].map((q) => f.statementDueOn(2026, q)).join() === "2026-07-31,2026-10-31,2027-01-31,2027-05-31");
  ok("  named", f.quarterLabel(2026, 2) === "Q2 (July–September 2026), tax year 2026-27", f.quarterLabel(2026, 2));
  ok(
    "section codes (Annexure 2): a contractor 1023 for an individual, 1024 otherwise; 194J(b) 1027; goods 1031; rent of a building 1009",
    f.form140SectionCode("CONTRACTOR", "INDIVIDUAL_HUF") === "1023" && f.form140SectionCode("CONTRACTOR", "OTHER") === "1024" && f.form140SectionCode("PROFESSIONAL", "OTHER") === "1027" && f.form140SectionCode("GOODS", "OTHER") === "1031" && f.form140SectionCode("RENT_LAND", "OTHER") === "1009" && f.form140SectionCode("SALARY", "OTHER") === null,
  );
  ok(
    "state codes are the statement's, not GST's: Maharashtra 19, Delhi 09, J&K 14, Puducherry 25",
    f.form140StateCode({ gstCode: "27" }) === "19" && f.form140StateCode({ name: "Delhi" }) === "09" && f.form140StateCode({ name: "Jammu and Kashmir" }) === "14" && f.form140StateCode({ name: "Puducherry" }) === "25" && f.form140StateCode({ name: "Atlantis" }) === null,
  );
  const fancy = `Caf${String.fromCharCode(0xe9)} M${String.fromCharCode(0xfc)}ller ^ Traders${String.fromCharCode(0x2019)}  Co`;
  ok("names in ASCII: accents dropped, ^ and doubled spaces gone, a curly apostrophe straightened", f.asciiText(fancy) === "Cafe Muller Traders' Co", f.asciiText(fancy));
  const lines = f.addressLines("Unit 1204, Tower B, Raheja Mindspace Business Park, Thane Belapur Road, Airoli");
  ok("an address over 25-character lines, between words", lines.length === 4 && lines.every((l) => l.length <= 25) && lines[0] === "Unit 1204, Tower B,", lines);

  const party = { name: "Zeta Engineering Private Limited", pan: "AAACZ9999K", address: "12 MG Road, Fort", city: "Mumbai", stateCode: "19", pincode: "400001", email: "accounts@zeta.example", phone: "+91 98200 12345" };
  const statement: Statement = {
    taxYear: 2026,
    quarter: 2,
    createdOn: "2026-10-26",
    deductor: { ...party, tan: "MUMZ12345A", deductorType: "K", gstin: "27AAACZ9999K1Z5" },
    responsible: { ...party, name: "Asha Rao", designation: "Finance Manager", pan: "ABCPR1234Q" },
    previousToken: null,
    challans: [
      {
        nil: false, bsrCode: "0510032", challanSerial: "00042", paidOn: "2026-08-07", minorHead: "200", tax: 351, interest: 0, fee: 0, others: 0,
        deductees: [
          { pan: "ABCPK1234L", name: "Builder & Sons", sectionCode: "1023", creditedOn: "2026-07-20", amountPaid: 25_000, taxDeducted: 250, taxDeposited: 250, deductedOn: "2026-07-20", rate: 1, remark: null, certificateNo: null },
          { pan: "PANNOTAVBL", name: "Ravi Electricals", sectionCode: "1023", creditedOn: "2026-07-22", amountPaid: 500, taxDeducted: 100, taxDeposited: 100, deductedOn: "2026-07-22", rate: 20, remark: "C", certificateNo: null },
        ],
      },
      {
        nil: true, bsrCode: null, challanSerial: null, paidOn: null, minorHead: null, tax: 0, interest: 0, fee: 0, others: 0,
        deductees: [{ pan: "AAACZ1234F", name: "Plant Hire", sectionCode: "1024", creditedOn: "2026-08-01", amountPaid: 50_000, taxDeducted: 0, taxDeposited: 0, deductedOn: null, rate: 0, remark: "A", certificateNo: "ZZNIL00001" }],
      },
    ],
  };
  ok("a complete statement has nothing to fix", f.form140Problems(statement).length === 0, f.form140Problems(statement));
  const text = f.form140Text(statement);
  const records = text.split("\r\n");
  ok("every line ends CR LF, the last too", text.endsWith("\r\n") && records.at(-1) === "" && !records.slice(0, -1).some((l) => l.includes("\n")));
  ok("  ASCII only", [...text].every((c) => c.charCodeAt(0) < 128));
  const rows = records.slice(0, -1).map((l) => l.split("^"));
  const count = (type: string) => rows.filter((r) => r[1] === type).map((r) => r.length);
  ok("FH 18 fields, BH 72, CD 30, DD 45 — one fewer ^ each", JSON.stringify([count("FH"), count("BH"), count("CD"), count("DD")]) === JSON.stringify([[18], [72], [30, 30], [45, 45, 45]]), [count("FH"), count("BH"), count("CD"), count("DD")]);
  ok("  lines numbered 1 to 7 in order", rows.map((r) => r[0]).join() === "1,2,3,4,5,6,7");
  const [fh, bh, cd1, dd1, dd2, cd2, dd3] = rows as string[][];
  ok("the file header: NS1, regular, today, the TAN, one batch, the utility", fh!.slice(1, 10).join("^") === "FH^NS1^R^26102026^1^D^MUMZ12345A^1^Deskzo One", fh!.slice(1, 10).join("^"));
  const b = (n: number) => bh![n - 1];
  ok(
    "the batch: 2 challans, form 140, TAN, PAN, AY 202728, tax year 202627, Q2, the name, INDIA, state 19, PIN, 91 and ten digits",
    [b(3), b(4), b(5), b(13), b(15), b(16), b(17), b(18), b(19), b(20), b(26), b(27), b(29), b(30)].join("|") === "1|2|140|MUMZ12345A|AAACZ9999K|202728|202627|Q2|Zeta Engineering Private Limited|INDIA|19|400001|91|9820012345",
    [b(3), b(4), b(5), b(13), b(15), b(16), b(17), b(18), b(19), b(20), b(26), b(27), b(29), b(30)].join("|"),
  );
  ok("  the address in 25-character lines, the city as the district", b(21) === "12 MG Road, Fort" && b(25) === "Mumbai");
  ok("  a company (K), the person responsible and their PAN, the GSTIN", b(32) === "K" && b(33) === "Asha Rao" && b(34) === "Finance Manager" && b(59) === "ABCPR1234Q" && b(69) === "27AAACZ9999K1Z5");
  ok("  the challans' total in whole rupees, and no earlier statement: N, no token", b(47) === "351.00" && b(52) === "N" && b(9) === "");
  const c1 = (n: number) => cd1![n - 1];
  ok(
    "a challan: its number, 2 deductees, not nil, tax 351.00, its total, by challan (C), BSR, serial, date, deposited and deducted 350.00, minor head 200",
    [c1(4), c1(5), c1(6), c1(8), c1(12), c1(13), c1(15), c1(17), c1(19), c1(21), c1(22), c1(23), c1(24), c1(25)].join("|") === "1|2|N|351.00|351.00|C|0510032|00042|07082026|350.00|350.00|200|0.00|0.00",
    [c1(4), c1(5), c1(6), c1(8), c1(12), c1(13), c1(15), c1(17), c1(19), c1(21), c1(22), c1(23), c1(24), c1(25)].join("|"),
  );
  const d = (row: string[], n: number) => row[n - 1];
  ok(
    "a deductee: numbered within its challan, O, PAN, name, section, Y, dates, amount, tax, rate to four places",
    [d(dd1!, 4), d(dd1!, 5), d(dd1!, 6), d(dd1!, 8), d(dd1!, 9), d(dd1!, 15), d(dd1!, 18), d(dd1!, 19), d(dd1!, 20), d(dd1!, 24), d(dd1!, 25), d(dd1!, 27), d(dd1!, 28), d(dd1!, 32)].join("|") === "1|1|O|ABCPK1234L|Builder & Sons|1023|Y|20072026|25000.00|250.00|250.00|20072026|1.0000|",
    dd1,
  );
  ok("  no PAN: PANNOTAVBL and flag C", d(dd2!, 4) === "2" && d(dd2!, 8) === "PANNOTAVBL" && d(dd2!, 28) === "20.0000" && d(dd2!, 32) === "C");
  const c2 = (n: number) => cd2![n - 1];
  ok("a nil challan: Y, no mode, BSR or serial, the quarter's last day, no minor head", c2(4) === "2" && c2(6) === "Y" && c2(12) === "0.00" && c2(13) === "" && c2(15) === "" && c2(17) === "" && c2(19) === "30092026" && c2(23) === "", cd2);
  ok("  its deductee: numbered from 1 again, flag A and the certificate, no tax, no date of deduction, rate 0", d(dd3!, 4) === "1" && d(dd3!, 5) === "2" && d(dd3!, 24) === "0.00" && d(dd3!, 27) === "" && d(dd3!, 28) === "0.0000" && d(dd3!, 32) === "A" && d(dd3!, 33) === "ZZNIL00001", dd3);
  const filed = f.form140Records({ ...statement, previousToken: "123456789012345" })[1]!.split("^");
  ok("after a statement has been filed: Y and its token", filed[51] === "Y" && filed[8] === "123456789012345");

  const problems = (over: Partial<Statement>) => f.form140Problems({ ...statement, ...over });
  ok("a TAN that isn't one", problems({ deductor: { ...statement.deductor, tan: "MUM12345A" } }).some((p) => /TAN/.test(p)));
  ok("  no state the statement knows", problems({ deductor: { ...statement.deductor, stateCode: null } }).some((p) => /company's state/.test(p)));
  ok("  a responsible person with no PAN or phone", problems({ responsible: { ...statement.responsible, pan: "", phone: "123" } }).length === 2);
  ok("  paise on a challan", problems({ challans: [{ ...statement.challans[0]!, tax: 350.5 }] }).some((p) => /whole rupees/.test(p)));
  ok("  a challan that paid less than its deductions", problems({ challans: [{ ...statement.challans[0]!, tax: 300 }] }).some((p) => /paid less/.test(p)));
  ok("  a deduction dated outside the quarter", problems({ challans: [{ ...statement.challans[0]!, deductees: [{ ...statement.challans[0]!.deductees[0]!, creditedOn: "2026-06-30", docNumber: "BILL/9" }] }] }).some((p) => /BILL\/9 is dated outside/.test(p)));
  ok("  flag A with no certificate number", problems({ challans: [statement.challans[1]!].map((c) => ({ ...c, deductees: [{ ...c.deductees[0]!, certificateNo: null }] })) }).some((p) => /certificate/.test(p)));
  ok("  nothing to report", problems({ challans: [] }).some((p) => /Nothing to report/.test(p)));
  ok("  a token that isn't fifteen digits", problems({ previousToken: "1234" }).some((p) => /fifteen/.test(p)));
}

async function scratch() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is needed.");
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname)) throw new Error("Only against a local database server.");
  const scratchName = `${new URL(url).pathname.slice(1)}_tds_check`;
  const scratchUrl = withDatabase(url, scratchName);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });

  section("A scratch workspace");
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
  try {
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("built from its migrations", true);
    // The scratch database is the workspace; no control plane is consulted. Off by value, never deleted.
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = " ";
    process.env.DESKZO_TENANCY_FALLBACK = "legacy";
    await workspace();
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = ${scratchName}`;
    ok("the scratch workspace is dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
  }
}

async function workspace() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const actions = require("../src/actions/tds") as typeof import("../src/actions/tds");
  const vendor = require("../src/lib/tds/vendor") as typeof import("../src/lib/tds/vendor");
  const { renderHtml } = require("./lib/render-html") as typeof import("./lib/render-html");
  const { VendorTdsCard } = require("../src/components/companies/vendor-tds-card") as typeof import("../src/components/companies/vendor-tds-card");
  const { BillTdsHelper } = require("../src/components/documents/bill-tds-helper") as typeof import("../src/components/documents/bill-tds-helper");
  const { default: TdsPage } = require("../src/app/(dashboard)/accounting/tds/page") as typeof import("../src/app/(dashboard)/accounting/tds/page");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const React = await import("react");

  const person = async (key: string, role: string) => {
    const u = await db.user.create({ data: { name: `Zz ${key}`, email: `${key.toLowerCase()}@zztds.invalid`, role: role as never, passwordHash: "x".repeat(60) }, select: { id: true } });
    roles.set(u.id, role);
    return u.id;
  };
  const finance = await person("Accounts", "ACCOUNTS");
  const seller = await person("Sales", "SALES");
  const as = <T,>(who: string, work: () => Promise<T>) => {
    actorId = who;
    return work();
  };
  const vendorOf = async (name: string, pan: string | null) => {
    const id = `zztds${name.toLowerCase()}`;
    await db.$executeRaw`INSERT INTO "companies" ("id", "name", "normalizedName", "relationshipType", "createdById", "ownerUserId", "updatedAt") VALUES (${id}, ${`Zz ${name}`}, ${`zz ${name}`.toLowerCase()}, 'VENDOR'::"CompanyRelationshipType", ${finance}, ${finance}, now())`;
    if (pan) await db.company.update({ where: { id }, data: { panNumber: pan } });
    return id;
  };
  let n = 0;
  const bill = (companyId: string, taxable: number, issued: string, extra: { section?: string; tds?: number; status?: string } = {}) =>
    db.tradeDocument.create({
      data: {
        docType: "BILL",
        direction: "PURCHASE",
        status: (extra.status ?? "ISSUED") as never,
        companyId,
        docNumber: `ZZTDS-${++n}`,
        taxableValue: taxable,
        total: taxable,
        createdById: finance,
        issueDate: day(issued),
        withholdingMode: extra.tds ? "TDS" : "NONE",
        withholdingSection: extra.section ?? null,
        withholdingAmount: extra.tds ? -extra.tds : 0,
        // The rate the bill deducted at, as the bill form stores it.
        withholdingRatePercent: extra.tds ? Math.round((extra.tds / taxable) * 10_000) / 100 : 0,
      },
      select: { id: true },
    });
  const refusal = <T extends { ok: boolean }>(r: T) => (r.ok ? "" : (r as unknown as { error: string }).error);

  const builder = await vendorOf("Builder", "ABCPK1234L");
  const lawyer = await vendorOf("Lawyer", null);
  const plant = await vendorOf("Plant", "AAACZ1234F");
  const agent = await vendorOf("Agent", "AAACY1234F");

  section("A vendor's usual section and certificates");
  ok("a salesperson may not set a vendor's section", /Manage finance records/.test(refusal(await as(seller, () => actions.setVendorTdsSection(builder, "CONTRACTOR")))));
  ok("  finance may", (await as(finance, () => actions.setVendorTdsSection(builder, "CONTRACTOR"))).ok && (await db.vendorTds.findUnique({ where: { companyId: builder } }))?.sectionKey === "CONTRACTOR");
  ok("  a section that isn't one is refused", /Choose one/.test(refusal(await as(finance, () => actions.setVendorTdsSection(builder, "194Z")))));
  ok("  and a company that isn't there", /not found/.test(refusal(await as(finance, () => actions.setVendorTdsSection("zz-none", "CONTRACTOR")))));
  await as(finance, () => actions.setVendorTdsSection(plant, "CONTRACTOR"));
  await as(finance, () => actions.setVendorTdsSection(agent, "COMMISSION"));
  await as(finance, () => actions.setVendorTdsSection(lawyer, "PROFESSIONAL"));
  await as(finance, () => actions.setVendorTdsSection(lawyer, null));
  ok("  cleared is gone", (await db.vendorTds.findUnique({ where: { companyId: lawyer } })) === null);
  ok("  every change audited", (await db.auditLog.count({ where: { userId: finance, entityType: "Company" } })) === 5);

  const certificate = (over: Record<string, unknown> = {}) => ({ companyId: plant, sectionKey: "CONTRACTOR", certificateNo: " zznil00001 ", ratePercent: 0, amountLimit: "", validFrom: "2026-04-01", validTo: "2027-03-31", ...over });
  ok("a certificate: a salesperson may not record one", /Manage finance records/.test(refusal(await as(seller, () => actions.addTdsCertificate(certificate())))));
  ok("  a rate over 100 is refused", /0 to 100/.test(refusal(await as(finance, () => actions.addTdsCertificate(certificate({ ratePercent: 120 }))))));
  ok("  one that ends before it starts", /ends before/.test(refusal(await as(finance, () => actions.addTdsCertificate(certificate({ validTo: "2026-03-31" }))))));
  ok("  one with no number", /number/.test(refusal(await as(finance, () => actions.addTdsCertificate(certificate({ certificateNo: "  " }))))));
  const nil = await as(finance, () => actions.addTdsCertificate(certificate()));
  ok("  a nil certificate for the year is kept, its number in capitals", nil.ok && (await db.tdsCertificate.findFirst({ where: { companyId: plant } }))?.certificateNo === "ZZNIL00001", nil);
  ok("  the same number twice is refused, saying so", /already recorded/.test(refusal(await as(finance, () => actions.addTdsCertificate(certificate())))));
  const spare = await as(finance, () => actions.addTdsCertificate(certificate({ certificateNo: "ZZSPARE001", ratePercent: 1 })));
  ok("  a salesperson may not remove one", spare.ok && /Manage finance records/.test(refusal(await as(seller, () => actions.removeTdsCertificate(spare.ok ? spare.data.id : "")))));
  ok("  finance may", spare.ok && (await as(finance, () => actions.removeTdsCertificate(spare.data.id))).ok && (await db.tdsCertificate.count({ where: { companyId: plant } })) === 1);

  section("A bill's advice, from the vendor's year");
  // The builder (an individual, usually a contractor): three bills under the limit, none deducted.
  await bill(builder, 30_000, "2026-04-15");
  await bill(builder, 30_000, "2026-05-15");
  const june = await bill(builder, 30_000, "2026-06-15");
  await bill(builder, 50_000, "2026-03-20"); // last tax year
  await bill(builder, 80_000, "2026-06-20", { status: "DRAFT" });
  await bill(builder, 80_000, "2026-06-21", { status: "CANCELLED" });
  const july = await as(finance, () => actions.tdsAdviceForBill({ companyId: builder, amount: 20_000, day: "2026-07-10" }));
  ok("₹20,000 in July: the usual section, the year's ₹90,000 so far — last year's, a draft and a cancelled bill not counted", july?.sectionKey === "CONTRACTOR" && july.yearSoFar === 90_000, july);
  ok("  due at 1%, the earlier ₹900 owed with it", july?.advice.due === true && july.advice.rate === 1 && july.advice.shortfall === 900, july?.advice);
  const editing = await as(finance, () => actions.tdsAdviceForBill({ companyId: builder, amount: 20_000, day: "2026-07-10", documentId: june.id }));
  ok("  the bill being edited isn't counted twice", editing?.yearSoFar === 60_000 && editing.advice.due === false, editing);
  await bill(builder, 25_000, "2026-07-20", { section: "194C", tds: 250 });
  const typed = await as(finance, () => actions.tdsAdviceForBill({ companyId: builder, amount: 10_000, day: "2026-08-01" }));
  ok("  a bill whose section was typed as 194C counts under the contractor's section", typed?.yearSoFar === 1_15_000, typed);
  ok("  a salesperson who can't see the vendor gets nothing", (await as(seller, () => actions.tdsAdviceForBill({ companyId: builder, amount: 20_000, day: "2026-07-10" }))) === null);
  const named = await as(finance, () => actions.tdsAdviceForBill({ companyId: builder, sectionKey: "RENT_LAND", amount: 60_000, day: "2026-07-10" }));
  ok("  a section chosen on the bill wins over the usual one", named?.sectionKey === "RENT_LAND" && named.advice.rate === 10 && named.yearSoFar === 0, named);

  await bill(plant, 1_50_000, "2026-05-01");
  await bill(plant, 50_000, "2026-06-01");
  const nilAdvice = await as(finance, () => actions.tdsAdviceForBill({ companyId: plant, amount: 40_000, day: "2026-07-01" }));
  ok("a vendor holding a nil certificate: 0%, the certificate named", nilAdvice?.advice.basis === "CERTIFICATE" && nilAdvice.advice.rate === 0 && nilAdvice.advice.note.includes("ZZNIL00001"), nilAdvice?.advice);

  // The lawyer has no PAN: professional fees deducted at 10%, which should have been 20%.
  await bill(lawyer, 60_000, "2026-06-10", { section: "PROFESSIONAL", tds: 6_000 });
  // The agent's commission is under ₹20,000 for the year.
  await bill(agent, 15_000, "2026-06-10");

  section("The year's shortfalls, for the TDS page");
  const shortfalls = await vendor.taxYearShortfalls("2026-10-01");
  const line = (s: (typeof shortfalls)[number]) => `${s.companyName} ${s.section.key} ${s.taxable} ${s.deducted} ${s.shortfall}`;
  ok(
    "the lawyer's ₹6,000 (20% without a PAN), then the builder's ₹900 (1% on ₹1,15,000, less ₹250 deducted)",
    shortfalls.map(line).join(" | ") === "Zz Lawyer PROFESSIONAL 60000 6000 6000 | Zz Builder CONTRACTOR 115000 250 900",
    shortfalls.map(line),
  );
  ok("  the vendor with a nil certificate owes nothing, the agent under the limit nothing", !shortfalls.some((s) => s.companyId === plant || s.companyId === agent));
  ok("  each with the vendor's number for its link", shortfalls.every((s) => Number.isInteger(s.companySeq) && s.companySeq > 0));
  const lastYear = await vendor.taxYearShortfalls("2026-03-31");
  actorId = finance;
  const page = await renderHtml(TdsPage({ searchParams: Promise.resolve({ month: "7", year: "2026" }) }));
  ok("the TDS page leads with them: ₹6,900, each vendor and its section", page.includes("TDS not deducted this tax year: ₹6,900.00") && page.includes("Zz Lawyer") && page.includes("194J(b): ₹6,000.00 short"), page.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").match(/TDS not deducted[^]{0,400}/)?.[0] ?? "no card");
  ok("  July's bills with a Section column — the builder's typed 194C read as the contractor's", page.includes(">Section<") && page.includes(">194C<"));
  ok("  and the statement named as it is now", page.includes("Form 140 (was 26Q)"));
  ok("  last tax year's are its own: the builder's ₹50,000 in March, over the ₹30,000 a payment, owed ₹500", lastYear.map(line).join(" | ") === "Zz Builder CONTRACTOR 50000 0 500", lastYear.map(line));

  section("The vendor's card");
  const card = await vendor.vendorTdsCardData(builder);
  const row = card?.year.find((r) => r.sectionKey === "CONTRACTOR");
  ok("the builder's card: its PAN read as an individual's, its usual section, this year's row", card?.pan === "ABCPK1234L" && card.kindLabel === "an individual or HUF" && card.usualSectionKey === "CONTRACTOR" && row?.taxable === 1_15_000 && row.overLimit && row.shortfall === 900, card);
  ok("  the ten sections to pick from", card?.sections.length === 10);
  const plantCard = (await vendor.vendorTdsCardData(plant))!;
  ok("  the plant's certificate listed", plantCard.certificates.length === 1 && plantCard.certificates[0]!.certificateNo === "ZZNIL00001" && plantCard.certificates[0]!.validTo === "2027-03-31");
  ok("  none for a company that isn't there", (await vendor.vendorTdsCardData("zz-none")) === null);
  const html = await renderHtml(React.createElement(VendorTdsCard, { companyId: builder, canManage: true, ...card! }));
  ok("rendered: the section, the year, the shortfall", html.includes("194C") && html.includes("1,15,000") && html.includes("₹900"), html.slice(0, 400));
  const plantHtml = await renderHtml(React.createElement(VendorTdsCard, { companyId: plant, canManage: false, ...plantCard }));
  ok("  the certificate, and no buttons for someone who can't change it", plantHtml.includes("ZZNIL00001") && !plantHtml.includes("Add certificate"), plantHtml.slice(0, 400));
  const helper = await renderHtml(
    React.createElement(BillTdsHelper, { companyId: builder, documentId: null, issueDate: "2026-07-10", taxableValue: 20_000, mode: "TDS", section: "194C", rate: "", onMode() {}, onSection() {}, onRate() {} }),
  );
  ok("the bill's TDS: the sections listed, a typed 194C picked as the contractor's", helper.includes("194J(b)") && /<option[^>]*value="CONTRACTOR"[^>]*selected/.test(helper), helper.slice(0, 400));

  await challans({ db, finance, seller, builder, plant, bill, as, TdsPage, renderHtml });
  await statements({ db, finance, seller, lawyer, as, TdsPage, renderHtml });
}

async function challans(t: {
  db: typeof import("../src/lib/db").db;
  finance: string;
  seller: string;
  builder: string;
  plant: string;
  bill: (companyId: string, taxable: number, issued: string, extra?: { section?: string; tds?: number; status?: string }) => Promise<{ id: string }>;
  as: <T>(who: string, work: () => Promise<T>) => Promise<T>;
  TdsPage: typeof import("../src/app/(dashboard)/accounting/tds/page").default;
  renderHtml: typeof import("./lib/render-html").renderHtml;
}) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const actions = require("../src/actions/tds-challans") as typeof import("../src/actions/tds-challans");
  const lib = require("../src/lib/tds/challans") as typeof import("../src/lib/tds/challans");
  const rules = require("../src/lib/tds/challan-rules") as typeof import("../src/lib/tds/challan-rules");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const { db, finance, seller, as } = t;
  const refusal = (r: { ok: boolean }) => (r.ok ? "" : (r as unknown as { error: string }).error);

  // July 2026: the builder's 194C bill (₹250, from before) and one whose typed section isn't one (₹100); the
  // plant's, a company's (₹1,000); and July's payroll, locked, with two people's income tax.
  const unknown = await t.bill(t.builder, 10_000, "2026-07-22", { section: "194X", tds: 100 });
  const plantJuly = await t.bill(t.plant, 50_000, "2026-07-05", { section: "CONTRACTOR", tds: 1_000 });
  const typed194C = await db.tradeDocument.findFirstOrThrow({ where: { companyId: t.builder, withholdingSection: "194C" }, select: { id: true } });
  const slip = (userId: string, incomeTax: number) => ({ userId, monthDays: 31, paidDays: 31, basic: 50_000, grossEarnings: 80_000, incomeTax, totalDeductions: incomeTax, netPay: 80_000 - incomeTax, employerCost: 80_000 });
  const july = await db.payrollRun.create({ data: { month: 7, year: 2026, status: "LOCKED", payslips: { create: [slip(finance, 3_000), slip(seller, 2_000)] } }, select: { id: true } });
  await db.payrollRun.create({ data: { month: 8, year: 2026, status: "DRAFT", payslips: { create: [slip(finance, 3_000)] } } });
  const ledgerAccount = await db.ledgerAccount.create({ data: { code: "1099", name: "Zz Current Account", type: "ASSET" }, select: { id: true } });
  const bank = await db.bankAccount.create({ data: { name: "Zz Current Account", ledgerAccountId: ledgerAccount.id, isDefault: true }, select: { id: true } });

  section("July's deductions, to deposit");
  const july26 = await lib.monthDeductions("2026-07");
  const salary = july26.find((x) => x.kind === "SALARY");
  ok("three bills and one line for payroll — its total, not a person's", july26.length === 4 && salary?.amount === 5_000 && salary.ref === `salary:${july.id}` && salary.party === "Salaries for July 2026 — 2 people" && salary.deductedOn === "2026-07-31", july26.map((x) => `${x.ref} ${x.amount}`));
  const deposits = (await lib.tdsDeposits("2026-07"))!;
  const rows = () => deposits.groups.map((g) => `${g.sectionKey}/${g.majorHead} ${g.left}`).join(" | ");
  ok("by section and head: ₹6,350 to deposit by 7 August", deposits.left === 6_350 && deposits.dueOn === "2026-08-07" && rows() === "CONTRACTOR/0020 1000 | CONTRACTOR/0021 250 | null/0021 100 | SALARY/0021 5000", rows());
  ok("  a draft payroll's tax isn't there yet", !(await lib.monthDeductions("2026-08")).some((x) => x.kind === "SALARY"));

  section("Recording a challan");
  const base = { month: "2026-07", sectionKey: "CONTRACTOR", majorHead: "0021", paidOn: "2026-08-07", bsrCode: "0510032", challanSerial: "42", tax: 350, bankAccountId: bank.id, refs: [`bill:${typed194C.id}`, `bill:${unknown.id}`] };
  ok("a salesperson may not", /Manage finance records/.test(refusal(await as(seller, () => actions.recordTdsChallan(base)))));
  ok("a BSR code that isn't seven digits is refused", /seven digits/.test(refusal(await as(finance, () => actions.recordTdsChallan({ ...base, bsrCode: "05100" })))));
  ok("  so is a day after today", /after today/.test(refusal(await as(finance, () => actions.recordTdsChallan({ ...base, paidOn: "2099-01-01" })))));
  ok("  and one before the month began", /before the month/.test(refusal(await as(finance, () => actions.recordTdsChallan({ ...base, paidOn: "2026-06-30" })))));
  ok("  a company's bill on a 0021 challan", /is a company, so its TDS goes under 0020/.test(refusal(await as(finance, () => actions.recordTdsChallan({ ...base, refs: [`bill:${plantJuly.id}`] })))));
  ok("  a vendor's bill on salary's challan", /pays salary/.test(refusal(await as(finance, () => actions.recordTdsChallan({ ...base, sectionKey: "SALARY" })))));
  ok("  deductions that come to more than its tax", /₹350, more than the challan's tax of ₹300/.test(refusal(await as(finance, () => actions.recordTdsChallan({ ...base, tax: 300 })))));
  ok("  salary under 0020", /0021/.test(refusal(await as(finance, () => actions.recordTdsChallan({ ...base, sectionKey: "SALARY", majorHead: "0020", refs: [] })))));
  ok("  and nothing was kept of any of them", (await db.tdsChallan.count()) === 0 && (await db.journalEntry.count({ where: { postingKey: { startsWith: "tdschallan:" } } })) === 0);

  const first = await as(finance, () => actions.recordTdsChallan(base));
  ok("the contractor's July challan: recorded, with its CIN", first.ok && first.data.cin === "05100320708202600042", first);
  const firstId = first.ok ? first.data.id : "";
  const entry = await db.journalEntry.findUnique({ where: { postingKey: `tdschallan:${firstId}` }, select: { date: true, source: true, lines: { select: { debit: true, credit: true, account: { select: { systemKey: true, id: true } } } } } });
  const line = (key: string | null, side: "debit" | "credit") => entry?.lines.filter((l) => (key ? l.account.systemKey === key : l.account.id === ledgerAccount.id)).reduce((s, l) => s + Number(l[side]), 0);
  ok("  posted on the day paid: Dr TDS Payable ₹350, Cr the bank it was paid from", entry?.date.toISOString().slice(0, 10) === "2026-08-07" && entry.source === "PAYMENT" && line("TDS_PAYABLE", "debit") === 350 && line(null, "credit") === 350 && entry.lines.length === 2, entry);
  ok("  both deductions are on it, the typed section's too", (await db.tdsChallanLink.count({ where: { challanId: firstId } })) === 2);
  ok("the same BSR code, day and serial again is refused", /already recorded/.test(refusal(await as(finance, () => actions.recordTdsChallan({ ...base, refs: [] })))));
  ok("  a deduction on another challan can't go on a second", /on another challan already/.test(refusal(await as(finance, () => actions.recordTdsChallan({ ...base, challanSerial: "43" })))));

  const interest = (await lib.monthDeductions("2026-07")).filter((x) => x.kind === "SALARY");
  const owed = rules.lateDepositInterest(interest, "2026-08-10");
  ok("salary's, paid on 10 August: late, two months' interest — ₹150", owed.interest === 150, owed);
  const late = await as(finance, () => actions.recordTdsChallan({ month: "2026-07", sectionKey: "SALARY", majorHead: "0021", paidOn: "2026-08-10", bsrCode: "0510032", challanSerial: "77", tax: 5_000, interest: owed.interest, bankAccountId: bank.id, refs: [`salary:${july.id}`] }));
  const lateId = late.ok ? late.data.id : "";
  const lateEntry = await db.journalEntry.findUnique({ where: { postingKey: `tdschallan:${lateId}` }, select: { lines: { select: { debit: true, credit: true, account: { select: { systemKey: true } } } } } });
  const lateLine = (key: string | null, side: "debit" | "credit") => lateEntry?.lines.filter((l) => l.account.systemKey === key).reduce((s, l) => s + Number(l[side]), 0);
  ok("  recorded: Dr TDS Payable ₹5,000, Dr Interest & Fees on Taxes ₹150, Cr the bank ₹5,150", late.ok && lateLine("TDS_PAYABLE", "debit") === 5_000 && lateLine("TAX_INTEREST", "debit") === 150 && lateLine(null, "credit") === 5_150, lateEntry);
  ok("  each payslip linked, one challan each", (await db.tdsChallanLink.count({ where: { challanId: lateId, payslipId: { not: null } } })) === 2);
  ok("  the interest account was added to the chart as it was first needed", (await db.ledgerAccount.findFirst({ where: { systemKey: "TAX_INTEREST" }, select: { code: true, name: true } }))?.name === "Interest & Fees on Taxes");

  section("Linking afterwards, and taking off");
  const company = await as(finance, () => actions.recordTdsChallan({ month: "2026-07", sectionKey: "CONTRACTOR", majorHead: "0020", paidOn: "2026-08-06", bsrCode: "6390009", challanSerial: "5", tax: 1_000, refs: [] }));
  const companyId = company.ok ? company.data.id : "";
  ok("a challan with nothing linked yet: its tax matched to none", company.ok && (await lib.tdsDeposits("2026-07"))!.challans.find((x) => x.id === companyId)?.linked === 0);
  ok("  the plant's bill linked to it after", (await as(finance, () => actions.linkTdsDeductions(companyId, [`bill:${plantJuly.id}`]))).ok);
  const after = (await lib.tdsDeposits("2026-07"))!;
  ok("July is all deposited: nothing left, every challan matched", after.left === 0 && after.challans.length === 3 && after.challans.every((x) => x.linked === x.tax), after.challans.map((x) => `${x.cin} ${x.linked}/${x.tax}`));
  ok("  each challan lists the month's deductions on it", after.linked[firstId]?.length === 2 && after.linked[lateId]?.[0]?.kind === "SALARY");
  ok("taking the plant's bill off", (await as(finance, () => actions.unlinkTdsDeduction(companyId, `bill:${plantJuly.id}`))).ok && (await lib.tdsDeposits("2026-07"))!.left === 1_000);
  ok("  and something that isn't on it says so", /isn't on this challan/.test(refusal(await as(finance, () => actions.unlinkTdsDeduction(companyId, `bill:${plantJuly.id}`)))));
  await as(finance, () => actions.linkTdsDeductions(companyId, [`bill:${plantJuly.id}`]));

  section("Deleting one recorded by mistake");
  const deleted = await as(finance, () => actions.deleteTdsChallan(lateId));
  const reversal = await db.journalEntry.findUnique({ where: { postingKey: `tdschallan:${lateId}:reversal` }, select: { reversesId: true, lines: { select: { debit: true, credit: true } } } });
  const original = await db.journalEntry.findUnique({ where: { postingKey: `tdschallan:${lateId}` }, select: { id: true } });
  ok("its entry reversed, the challan gone, salary's ₹5,000 left to deposit again", deleted.ok && reversal?.reversesId === original?.id && reversal?.lines.reduce((s, l) => s + Number(l.credit), 0) === 5_150 && (await db.tdsChallan.findUnique({ where: { id: lateId } })) === null && (await lib.tdsDeposits("2026-07"))!.left === 5_000);
  const again = await as(finance, () => actions.recordTdsChallan({ month: "2026-07", sectionKey: "SALARY", majorHead: "0021", paidOn: "2026-08-10", bsrCode: "0510032", challanSerial: "77", tax: 5_000, interest: 150, refs: [`salary:${july.id}`] }));
  ok("  and it can be recorded again, its numbers free", again.ok, again);

  section("Closed books");
  await db.ledgerLock.upsert({ where: { id: "global" }, create: { id: "global", lockedUntil: new Date("2026-08-31T00:00:00Z") }, update: { lockedUntil: new Date("2026-08-31T00:00:00Z") } });
  const closed = await as(finance, () => actions.recordTdsChallan({ month: "2026-08", sectionKey: "CONTRACTOR", majorHead: "0021", paidOn: "2026-08-20", bsrCode: "0510032", challanSerial: "90", tax: 10, refs: [] }));
  ok("a challan dated into closed books is refused, saying so", /books are closed/.test(refusal(closed)) && (await db.tdsChallan.count({ where: { challanSerial: "00090" } })) === 0, refusal(closed));
  await db.ledgerLock.update({ where: { id: "global" }, data: { lockedUntil: null } });

  section("On the TDS page");
  actorId = finance;
  const page = await t.renderHtml(t.TdsPage({ searchParams: Promise.resolve({ month: "7", year: "2026" }) }));
  const text = page.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  ok("July: all deposited, the deposits by section and head, each challan's CIN", text.includes("All of July") && text.includes("is deposited") && text.includes("Deposits") && text.includes("CIN 0510032 07082026 00042") && text.includes("192 — Salary"), text.match(/All of July[^]{0,200}/)?.[0] ?? text.slice(0, 300));
  const june = (await t.renderHtml(t.TdsPage({ searchParams: Promise.resolve({ month: "6", year: "2026" }) }))).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  ok("June: the lawyer's ₹6,000 still to be deposited, overdue", june.includes("₹6,000.00 was deducted and is still to be deposited") && june.includes("it was due by"), june.match(/[^ ]+ was deducted[^]{0,160}/)?.[0] ?? june.slice(0, 300));
}

async function statements(t: {
  db: typeof import("../src/lib/db").db;
  finance: string;
  seller: string;
  lawyer: string;
  as: <T>(who: string, work: () => Promise<T>) => Promise<T>;
  TdsPage: typeof import("../src/app/(dashboard)/accounting/tds/page").default;
  renderHtml: typeof import("./lib/render-html").renderHtml;
}) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const actions = require("../src/actions/tds-statement") as typeof import("../src/actions/tds-statement");
  const challanActions = require("../src/actions/tds-challans") as typeof import("../src/actions/tds-challans");
  const lib = require("../src/lib/tds/form140") as typeof import("../src/lib/tds/form140");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const { db, finance, seller, as } = t;
  const refusal = (r: { ok: boolean }) => (r.ok ? "" : (r as unknown as { error: string }).error);

  section("Form 140 from the books");
  const before = (await lib.form140Overview(2026, 2))!;
  ok("Q2 before any details: the TAN, the company's PAN and address, the person responsible asked for", ["TAN", "company's PAN", "company's address", "responsible for deducting"].every((w) => before.problems.some((p) => p.includes(w))), before.problems);
  ok("  what it holds: 3 deductions on 2 challans, ₹1,350 — salary's challan not among them", before.summary.deductees === 3 && before.summary.challans === 2 && before.summary.deducted === 1_350, before.summary);

  const details = {
    tan: "mumz12345a", deductorType: "K", responsibleName: "Asha Rao", responsibleDesignation: "Finance Manager", responsiblePan: "abcpr1234q",
    responsibleAddress: "12 MG Road, Fort", responsibleCity: "Mumbai", responsibleState: "Maharashtra", responsiblePincode: "400001", responsibleEmail: "asha@zeta.example", responsiblePhone: "9820012345",
  };
  ok("the details: a salesperson may not save them", /Manage finance records/.test(refusal(await as(seller, () => actions.saveTdsSettings(details)))));
  ok("  a TAN that isn't one is refused", /four letters, five digits/.test(refusal(await as(finance, () => actions.saveTdsSettings({ ...details, tan: "MUM12345" })))));
  ok("  saved by finance, in capitals", (await as(finance, () => actions.saveTdsSettings(details))).ok && (await db.tdsSettings.findUnique({ where: { id: "global" } }))?.tan === "MUMZ12345A");
  await db.organisationSettings.upsert({
    where: { id: "global" },
    create: { id: "global", legalName: "Zeta Engineering Private Limited", pan: "AAACZ9999K", addressLine1: "12 MG Road", addressLine2: "Fort", city: "Mumbai", state: "Maharashtra", stateCode: "27", pincode: "400001", email: "accounts@zeta.example", phone: "+91 22 4000 1234" },
    update: { legalName: "Zeta Engineering Private Limited", pan: "AAACZ9999K", addressLine1: "12 MG Road", addressLine2: "Fort", city: "Mumbai", state: "Maharashtra", stateCode: "27", pincode: "400001", email: "accounts@zeta.example", phone: "+91 22 4000 1234" },
  });

  const ready = (await lib.form140Overview(2026, 2))!;
  ok("with them and the organisation's: nothing stops Q2", ready.problems.length === 0, ready.problems);
  ok("  a salesperson may not download it", /Manage finance records/.test(refusal(await as(seller, () => actions.downloadForm140({ taxYear: 2026, quarter: 2 })))));
  const q2 = await as(finance, () => actions.downloadForm140({ taxYear: 2026, quarter: 2 }));
  const rows = q2.ok ? q2.data.text.split("\r\n").slice(0, -1).map((l) => l.split("^")) : [];
  ok("the file: named for the TAN, year and quarter; FH, BH, two challans with their three deductions", q2.ok && q2.data.fileName === "MUMZ12345A_Form140_2026-27_Q2.txt" && rows.map((r) => r[1]).join() === "FH,BH,CD,DD,CD,DD,DD", q2.ok ? rows.map((r) => r[1]) : q2);
  ok("  the batch: the deductor, Maharashtra as 19, the person responsible, ₹1,350 deposited, no earlier statement", rows[1]?.[12] === "MUMZ12345A" && rows[1]?.[14] === "AAACZ9999K" && rows[1]?.[25] === "19" && rows[1]?.[32] === "Asha Rao" && rows[1]?.[58] === "ABCPR1234Q" && rows[1]?.[46] === "1350.00" && rows[1]?.[51] === "N", rows[1]);
  ok("  challans by the day paid: the plant's (6 Aug) first, then the contractor's (7 Aug)", rows[2]?.[14] === "6390009" && rows[2]?.[16] === "00005" && rows[4]?.[14] === "0510032" && rows[4]?.[16] === "00042");
  ok("  the plant, a company: 1024 at 2% on ₹50,000", JSON.stringify([rows[3]?.[7], rows[3]?.[14], rows[3]?.[19], rows[3]?.[23], rows[3]?.[27]]) === JSON.stringify(["AAACZ1234F", "1024", "50000.00", "1000.00", "2.0000"]), rows[3]);
  ok("  the builder, an individual: 1023, and the bill whose typed section wasn't one takes its challan's", rows[5]?.[14] === "1023" && rows[6]?.[14] === "1023" && rows[6]?.[23] === "100.00", [rows[5], rows[6]]);
  ok("  the making is noted for the quarter", (await db.tdsStatement.findFirst({ where: { taxYear: 2026, quarter: 2 } }))?.generatedAt instanceof Date);

  const q1 = await as(finance, () => actions.downloadForm140({ taxYear: 2026, quarter: 1 }));
  ok("Q1: refused while the lawyer's June deduction is on no challan", !q1.ok && /on no challan/.test(refusal(q1)), refusal(q1));
  await as(finance, () => challanActions.recordTdsChallan({ month: "2026-06", sectionKey: "PROFESSIONAL", majorHead: "0021", paidOn: "2026-07-07", bsrCode: "0510032", challanSerial: "11", tax: 6_000, refs: [] }));
  const lawyerBill = await db.tradeDocument.findFirstOrThrow({ where: { companyId: t.lawyer }, select: { id: true } });
  const june = (await db.tdsChallan.findFirst({ where: { challanSerial: "00011" }, select: { id: true } }))!;
  await as(finance, () => challanActions.linkTdsDeductions(june.id, [`bill:${lawyerBill.id}`]));
  const q1again = (await lib.form140Overview(2026, 1))!;
  ok("  once on one: the file can be made, saying the lawyer was deducted at 10% without a PAN", q1again.problems.length === 0 && q1again.warnings.some((w) => /no PAN, but was deducted at 10%/.test(w)), [q1again.problems, q1again.warnings]);
  const q1file = await as(finance, () => actions.downloadForm140({ taxYear: 2026, quarter: 1 }));
  const q1rows = q1file.ok ? q1file.data.text.split("\r\n").slice(0, -1).map((l) => l.split("^")) : [];
  ok("  the lawyer: PANNOTAVBL, 1027, flag C", q1rows[3]?.[7] === "PANNOTAVBL" && q1rows[3]?.[14] === "1027" && q1rows[3]?.[31] === "C", q1rows[3]);
  ok(
    "  and the plant's untaxed bills under its nil certificate: a nil challan, flag A, the certificate's number, no tax",
    q1rows[4]?.[1] === "CD" && q1rows[4]?.[5] === "Y" && q1rows[4]?.[4] === "2" && q1rows.slice(5).every((r) => r[1] === "DD" && r[31] === "A" && r[32] === "ZZNIL00001" && r[23] === "0.00" && r[26] === "") && q1rows.slice(5).map((r) => r[19]).join() === "150000.00,50000.00",
    q1rows.slice(4),
  );

  section("The token the next quarter quotes");
  ok("a token that isn't fifteen digits is refused", /fifteen digits/.test(refusal(await as(finance, () => actions.saveTdsStatementToken({ taxYear: 2026, quarter: 1, tokenNumber: "1234" })))));
  ok("  Q1's saved", (await as(finance, () => actions.saveTdsStatementToken({ taxYear: 2026, quarter: 1, tokenNumber: "123456789012345", filedOn: "2026-07-30" }))).ok);
  const q2after = await as(finance, () => actions.downloadForm140({ taxYear: 2026, quarter: 2 }));
  const bh = q2after.ok ? q2after.data.text.split("\r\n")[1]!.split("^") : [];
  ok("  Q2's file now says Y and quotes it", bh[51] === "Y" && bh[8] === "123456789012345", [bh[51], bh[8]]);
  const typed = await as(finance, () => actions.downloadForm140({ taxYear: 2026, quarter: 2, previousToken: "999999999999999" }));
  ok("  or one typed, for a statement filed elsewhere", typed.ok && typed.data.text.split("\r\n")[1]!.split("^")[8] === "999999999999999");
  const q3 = (await lib.form140Overview(2026, 3))!;
  ok("Q3, with nothing deducted: nothing to report", q3.problems.some((p) => /Nothing to report/.test(p)) && q3.previous?.token === "123456789012345");

  section("On the TDS page");
  actorId = finance;
  const page = (await t.renderHtml(t.TdsPage({ searchParams: Promise.resolve({ month: "8", year: "2026" }) }))).replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  ok("August shows Q2's statement: its figures, the download, the deductor and TAN", page.includes("Quarterly statement — Form 140 (was 26Q)") && page.includes("3 deduction(s) on 2 challan(s)") && page.includes("Download Form 140 file") && page.includes("TAN MUMZ12345A"), page.match(/Quarterly statement[^]{0,300}/)?.[0] ?? page.slice(0, 300));
  const old = (await t.renderHtml(t.TdsPage({ searchParams: Promise.resolve({ month: "2", year: "2026" }) }))).replace(/<[^>]+>/g, " ");
  ok("  a month before April 2026 has none — those quarters were 26Q's", !old.includes("Quarterly statement"));
}

main()
  .then(() => {
    console.log(failures === 0 ? "\nAll TDS checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
