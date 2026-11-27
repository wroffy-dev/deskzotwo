/**
 * check:audit-fixes-e — the security audit of 11 Nov 2026 (docs/reports/security-audit-2026-11-11.md), group E: input
 * bounds. Each fix shown to hold the way it was broken, by calling the server's own code.
 *
 *   SEC-29  a page is 1 to 500 rows whatever a hand-made call asks for
 *   SEC-30  every text field in src/lib/validation has a maximum length, and every list a maximum count
 *   SEC-56  a failed action shows our own refusal, never the database's or a library's words
 *   SEC-57  the CSV downloads that built their own cells pass the formula guard
 *   SEC-69  a refused company link or lead value says why
 *
 * Pure: no database, nothing written. The schemas are walked as zod built them, so a new field without a maximum
 * fails here by name.
 *
 *   npx tsx scripts/check-audit-fixes-e.ts
 */
import "dotenv/config";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { clampPage, MAX_PAGE_SIZE, pageOf, pageSlice, PAGE_SIZES } from "../src/lib/pagination";
import { pageOfRanked } from "../src/lib/tables/sorted-page";
import { isInternalError, plainError } from "../src/lib/plain-error";
import { csvRow, sanitizeCsvCell } from "../src/lib/csv";
import { bankCsv } from "../src/lib/hr/statutory-files";
import { firstFormMessage } from "../src/lib/forms/first-message";
import { tooLong, tooMany, TEXT_MAX } from "../src/lib/validation/text";
import { createCompanySchema, updateCompanySchema, assignCompaniesSchema } from "../src/lib/validation/company";
import { createLeadSchema } from "../src/lib/validation/lead";
import { createExpenseSchema } from "../src/lib/validation/expense";
import { tradeDocumentSchema } from "../src/lib/validation/trade-document";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const root = path.resolve(__dirname, "..");
const read = (file: string) => readFileSync(path.join(root, file), "utf8");
const issues = (r: { success: boolean; error?: { issues: { message: string; path: PropertyKey[] }[] } }) => (r.success ? [] : (r.error?.issues ?? []).map((i) => i.message));

// ─── The walker ─────────────────────────────────────────────────────────────────────────────────────────────────

type Check = { _zod?: { def?: { check?: string } } };
type Node = { _zod?: { def?: Record<string, unknown> & { type?: string; checks?: Check[] } } };
type Finding = { where: string; what: "string" | "array" };

/**
 * Every string and list under a schema that has no maximum. zod 4 keeps a schema's definition on `_zod.def`, its
 * checks among it: `.max(n)` is a `max_length` check and `.length(n)` a `length_equals` one.
 */
function unbounded(schema: unknown, where: string, seen: Set<unknown>, out: Finding[]): void {
  const node = schema as Node;
  const def = node?._zod?.def;
  if (!def || seen.has(schema)) return;
  seen.add(schema);
  const capped = (def.checks ?? []).some((c) => c._zod?.def?.check === "max_length" || c._zod?.def?.check === "length_equals");
  const inner = (key: string, label = ""): void => unbounded(def[key], where + label, seen, out);
  switch (def.type) {
    case "string":
      if (!capped) out.push({ where, what: "string" });
      return;
    case "array":
      if (!capped) out.push({ where, what: "array" });
      return inner("element", "[]");
    case "object":
      for (const [key, value] of Object.entries((def.shape ?? {}) as Record<string, unknown>)) unbounded(value, `${where}.${key}`, seen, out);
      return inner("catchall", ".*");
    case "union":
      for (const [i, option] of ((def.options ?? []) as unknown[]).entries()) unbounded(option, `${where}|${i}`, seen, out);
      return;
    case "intersection":
      inner("left");
      return inner("right");
    case "pipe":
      inner("in");
      return inner("out");
    case "record":
    case "map":
      inner("keyType", "{key}");
      return inner("valueType", "{}");
    case "set":
      return inner("valueType", "{}");
    case "tuple":
      for (const [i, item] of ((def.items ?? []) as unknown[]).entries()) unbounded(item, `${where}[${i}]`, seen, out);
      return inner("rest", "[…]");
    case "lazy":
      return unbounded((def.getter as () => unknown)(), where, seen, out);
    case "optional":
    case "nullable":
    case "default":
    case "prefault":
    case "nonoptional":
    case "readonly":
    case "catch":
    case "promise":
    case "success":
      return inner("innerType");
    default:
      // number, boolean, enum, literal, date, transform, unknown, any, custom…: nothing to bound here.
      return;
  }
}

/**
 * Left without a maximum on purpose, each with its reason. A path is `file:export` and then the field.
 */
const A_REAL_DAY = "happenedOn (src/lib/validation/day.ts) takes only a real YYYY-MM-DD day — ten characters by its own rule";
const EXEMPT = new Map<string, string>([
  ["expense.ts:createExpenseSchema.spentOn", A_REAL_DAY],
  ["expense.ts:updateExpenseSchema.spentOn", A_REAL_DAY],
  ["payment.ts:recordPaymentSchema.paidOn", A_REAL_DAY],
  ["receivable.ts:recordInvoicePaymentSchema.paidOn", A_REAL_DAY],
]);

/** Whether an expense dated so is taken — the exempted day field, tried with something long. */
const createExpenseSchemaDay = (spentOn: string) => createExpenseSchema.safeParse({ category: "TRAVEL", amount: 100, spentOn, description: "Cab" }).success;

async function main() {
  section("SEC-29: a page has a ceiling");
  ok("the list screens' own sizes all fit", PAGE_SIZES.every((s) => pageSlice(1, s).take === s) && MAX_PAGE_SIZE >= Math.max(...PAGE_SIZES), { MAX_PAGE_SIZE });
  ok("a million rows asked for is 500 given", pageSlice(1, 1_000_000).take === MAX_PAGE_SIZE && pageSlice(1, 1_000_000).skip === 0, pageSlice(1, 1_000_000));
  ok("  and page 3 of it follows page 2", pageSlice(3, 1_000_000).skip === 2 * MAX_PAGE_SIZE);
  ok("page 0, a negative page and a negative size are page 1 of the usual size", [pageSlice(0, 50), pageSlice(-4, 50), pageSlice(1, -1), pageSlice(1, 0)].every((s) => s.skip === 0 && s.take === 50), [pageSlice(0, 50), pageSlice(-4, 50), pageSlice(1, -1)]);
  ok("not-a-number and Infinity don't reach the database", [pageSlice(Number.NaN, Number.NaN), pageSlice(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)].every((s) => Number.isFinite(s.skip) && s.skip >= 0 && s.take >= 1 && s.take <= MAX_PAGE_SIZE));
  ok("a fraction is a whole page", pageSlice(2.9, 25.5).skip === 25 && pageSlice(2.9, 25.5).take === 25, pageSlice(2.9, 25.5));
  ok("an ordinary page is untouched", pageSlice(4, 100).skip === 300 && pageSlice(4, 100).take === 100 && clampPage(4, 100).page === 4);
  const many = Array.from({ length: 2000 }, (_, i) => i);
  ok("a list paged in memory has the same ceiling", pageOf(many, 1, 1_000_000).rows.length === MAX_PAGE_SIZE && pageOf(many, 1, 1_000_000).total === 2000 && pageOf(many, -1, 10).rows[0] === 0);
  const ids = many.map(String);
  ok("  and so has a ranked one", pageOfRanked(ids, new Map(ids.map((id) => [id, Number(id)])), "asc", 1, 1_000_000).length === MAX_PAGE_SIZE);
  const handRolled = ["call", "domain", "email-verification", "ledger-reports", "notification", "workspace", "verification"].filter((f) => /skip: \(params\.page - 1\) \* params\.pageSize/.test(read(`src/actions/${f}.ts`)));
  ok("the lists that did their own arithmetic go through it now", handRolled.length === 0, handRolled);

  section("SEC-30: every text field and list has a maximum");
  const dir = path.join(root, "src/lib/validation");
  const found: Finding[] = [];
  let schemas = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith(".ts")).sort()) {
    const mod = (await import(pathToFileURL(path.join(dir, file)).href)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(mod)) {
      if (!(value as Node)?._zod?.def) continue;
      schemas += 1;
      // A fresh `seen` per export: a field shared by two schemas is named under each.
      unbounded(value, `${file}:${name}`, new Set(), found);
    }
  }
  const open = found.filter((f) => !EXEMPT.has(f.where));
  ok(`no text without a maximum length, across ${schemas} schemas`, open.filter((f) => f.what === "string").length === 0, open.filter((f) => f.what === "string").map((f) => f.where).slice(0, 40));
  ok("no list without a maximum count", open.filter((f) => f.what === "array").length === 0, open.filter((f) => f.what === "array").map((f) => f.where));
  const stale = [...EXEMPT.keys()].filter((k) => !found.some((f) => f.where === k));
  ok("every exemption still names something", stale.length === 0, stale);
  ok("  and the days exempted are held to ten characters by their own rule", !createExpenseSchemaDay("2026-11-11" + "1".repeat(5000)));

  const company = (extra: Record<string, unknown>) => ({ name: "Zz Bounds Ltd", location: { label: "Head Office" }, contacts: [], ...extra });
  ok("a company as the form sends it is still taken", createCompanySchema.safeParse(company({})).success, issues(createCompanySchema.safeParse(company({}))));
  const longName = createCompanySchema.safeParse(company({ name: "A".repeat(50_017) }));
  ok("the audit's 50,017-character company name is refused, in plain words", !longName.success && issues(longName).includes(tooLong(TEXT_MAX.name)), issues(longName));
  ok("  a 200-character one is not", createCompanySchema.safeParse(company({ name: "A".repeat(200) })).success);
  ok("  and editing has the same rule", !updateCompanySchema.safeParse({ id: "c1", name: "A".repeat(201) }).success);
  ok("the message reads as a sentence", tooLong(200) === "That's too long — keep it within 200 characters." && tooMany(1000) === "That's too many at once — 1,000 of them at most.", [tooLong(200), tooMany(1000)]);
  const picked = (n: number) => assignCompaniesSchema.safeParse({ companyIds: Array.from({ length: n }, (_, i) => `c${i}`), userId: "u1" });
  ok("1,000 companies ticked at once are taken; 1,001 are not", picked(1000).success && !picked(1001).success && issues(picked(1001)).includes(tooMany(1000)), issues(picked(1001)));
  const doc = (lines: number, extra: Record<string, unknown> = {}) =>
    tradeDocumentSchema.safeParse({
      docType: "INVOICE",
      companyId: "c1",
      currency: "INR",
      exchangeRate: 1,
      gstTreatment: "UNREGISTERED",
      placeOfSupplyCode: "07",
      issueDate: "2026-11-11",
      billing: { line1: "", city: "", state: "", stateCode: "", pincode: "", country: "India" },
      shipping: { line1: "", city: "", state: "", stateCode: "", pincode: "", country: "India" },
      lines: Array.from({ length: lines }, () => ({ name: "Line", quantity: 1, unitPrice: 1000, discountMode: "PERCENT", discountValue: 0, taxRatePercent: 18 })),
      ...extra,
    });
  ok("an invoice of 1,000 lines is taken; 1,001 is not", doc(1000).success && !doc(1001).success, issues(doc(1000)).slice(0, 3));
  ok("  20,000 characters of terms are taken; 20,001 are not", doc(1, { terms: "t".repeat(20_000) }).success && !doc(1, { terms: "t".repeat(20_001) }).success);

  section("SEC-56: a failure in plain words");
  const quiet = console.error;
  const logged: unknown[] = [];
  console.error = (...args: unknown[]) => void logged.push(args);
  try {
    class Refused extends Error {
      constructor(message: string) {
        super(message);
        this.name = "Refused";
      }
    }
    const prisma = Object.assign(new Error('\nInvalid `prisma.journalEntry.create()` invocation:\n\nUnique constraint failed on the fields: (`entryNumber`)'), { name: "PrismaClientKnownRequestError", code: "P2002" });
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "journal_entries_entryNumber_key"'), { code: "23505" });
    const fallback = "Could not post the voucher.";
    ok("a database error becomes the action's own sentence", plainError(prisma, fallback) === fallback && plainError(pg, fallback) === fallback);
    ok("  by its code alone, whatever it says", plainError(Object.assign(new Error("Something happened"), { code: "P2025" }), fallback) === fallback && plainError(Object.assign(new Error("connect failed"), { code: "ECONNREFUSED" }), fallback) === fallback);
    ok("  and is logged for us", logged.length === 4, logged.length);
    ok("a runtime error does too", plainError(new TypeError("Cannot read properties of undefined (reading 'id')"), fallback) === fallback && plainError(new SyntaxError("Unexpected token < in JSON at position 0"), fallback) === fallback);
    ok("something thrown that isn't an error does too", plainError("relation \"users\" does not exist", fallback) === fallback && plainError(undefined, fallback) === fallback);
    ok("a stack of lines, or an empty message, does too", plainError(new Error("first\n    at Object.<anonymous> (C:\\app\\x.js:1:1)"), fallback) === fallback && plainError(new Error(""), fallback) === fallback);
    ok("our own refusal passes through", plainError(new Error("The books are closed to 31 Mar 2026."), fallback) === "The books are closed to 31 Mar 2026." && plainError(new Refused("Row 14 has no amount."), fallback) === "Row 14 has no amount.");
    ok("  with a code of ours, too", !isInternalError(Object.assign(new Refused("Only 3 seats are left."), { code: "SEATS" })));
  } finally {
    console.error = quiet;
  }
  const actionsDir = path.join(root, "src/actions");
  const actionFiles = [...readdirSync(actionsDir).map((f) => f), ...readdirSync(path.join(actionsDir, "platform")).map((f) => `platform/${f}`)].filter((f) => f.endsWith(".ts"));
  // Left as they are: ledger.ts has its own copy of the rule; inventory.ts was being edited elsewhere; the console's
  // `serverRefusal` is staff-only and redacts its line itself; marketing-public's is a console.error, not an answer.
  const LEFT = new Set(["ledger.ts", "inventory.ts", "platform/console-workspace.ts", "marketing-public.ts"]);
  const raw: string[] = [];
  for (const f of actionFiles) {
    if (LEFT.has(f)) continue;
    const lines = read(`src/actions/${f}`).split(/\r?\n/);
    lines.forEach((line, i) => {
      if (/\b(\w+) instanceof Error \? \1\.message\b/.test(line) || /error: \((e|err|error) as Error\)\.message/.test(line) || /error: String\((e|err|error)\)/.test(line)) raw.push(`${f}:${i + 1}`);
    });
  }
  ok(`no action answers with whatever was caught, across ${actionFiles.length} files`, raw.length === 0, raw);

  section("SEC-57: downloads through the formula guard");
  const evil = "=cmd|' /C calc'!A0";
  ok("a cell built by csvRow opens as text, a negative number as a number", csvRow([evil, -1488]) === `"'=cmd|' /C calc'!A0","-1488"`, csvRow([evil, -1488]));
  for (const file of ["src/components/performance/new-customers-download.tsx", "src/components/settings/migration/receipts-check.tsx"]) {
    const source = read(file);
    ok(`${path.basename(file)} builds its cells with it`, /csvRow\(\[v\]\)/.test(source) && !/String\(v\)\.replace\(\/"\/g/.test(source));
  }
  const bank = bankCsv([{ name: evil, accountNumber: "001234567890", ifsc: "HDFC0001234", amount: 25000, bankName: null }, { name: "Asha Rao", accountNumber: "9876543210", ifsc: "ICIC0000001", amount: 1200.5, bankName: null }], "+Salary Nov 2026").split("\r\n");
  ok("the bank file's name and narration are guarded", bank[1]!.startsWith(`"'=cmd`) && bank[1]!.endsWith(`"'+Salary Nov 2026"`), bank[1]);
  ok("  its account number, IFSC and amount are exactly as the bank expects", bank[1]!.includes(`"001234567890","HDFC0001234","25000.00"`) && bank[2] === `"Asha Rao","9876543210","ICIC0000001","1200.50","'+Salary Nov 2026"`, bank[2]);
  ok("  an ordinary name and narration are untouched", bankCsv([{ name: "Asha Rao", accountNumber: "9876543210", ifsc: "ICIC0000001", amount: 10, bankName: null }], "Salary Nov 2026").split("\r\n")[1] === `"Asha Rao","9876543210","ICIC0000001","10.00","Salary Nov 2026"`);
  ok("the guard itself still leaves plain text alone", sanitizeCsvCell("Asha") === "Asha" && sanitizeCsvCell("@asha") === "'@asha");

  section("SEC-69: a refusal that says why");
  const negative = createLeadSchema.safeParse({ companyId: "c1", title: "Renewal", estimatedValue: -5_000_000 });
  ok("a negative lead value is refused in plain words", !negative.success && issues(negative).includes("A value can't be negative"), issues(negative));
  const seats = createLeadSchema.safeParse({ companyId: "c1", title: "Renewal", requirements: [{ itemId: "i1", quantity: -10 }] });
  ok("  and so are negative seats", !seats.success && issues(seats).includes("Quantity must be at least 1"), issues(seats));
  ok("  a lead with no value, or a real one, is still taken", createLeadSchema.safeParse({ companyId: "c1", title: "Renewal", estimatedValue: "" }).success && createLeadSchema.safeParse({ companyId: "c1", title: "Renewal", estimatedValue: "125000.50" }).success);
  for (const field of ["website", "linkedinUrl"]) {
    const refused = createCompanySchema.safeParse(company({ [field]: "javascript:alert(document.cookie)" }));
    ok(`a javascript: ${field} is refused, with a reason`, !refused.success && issues(refused).some((m) => /web address/.test(m)), issues(refused));
  }
  ok("  with spaces or capitals before it, too", !createCompanySchema.safeParse(company({ website: "  JavaScript :alert(1)" })).success && !createCompanySchema.safeParse(company({ website: "data:text/html,<script>1</script>" })).success);
  ok("  an ordinary address is taken, with or without https, or a port", ["acme.com", "https://acme.com/about", "www.acme.co.in", "acme.com:8080", ""].every((website) => createCompanySchema.safeParse(company({ website })).success));
  ok("the first reason is found wherever it sits in a form's errors", firstFormMessage({ contacts: [undefined, { linkedinUrl: { type: "invalid_format", message: "Enter a LinkedIn address, like linkedin.com/in/name", ref: { message: "not this" } } }] }) === "Enter a LinkedIn address, like linkedin.com/in/name" && firstFormMessage({}) === null && firstFormMessage({ estimatedValue: { message: "A value can't be negative" } }) === "A value can't be negative");
  for (const file of ["src/components/companies/new-company-form.tsx", "src/components/companies/edit-company-form.tsx", "src/components/leads/new-lead-form.tsx"]) {
    ok(`${path.basename(file)} shows it when the form is refused`, /handleSubmit\(onSubmit, \(found\) => setServerError\(firstFormMessage\(found\)/.test(read(file)));
  }
  ok("the lead form has a line under its value; the company form under its links", /errors\.estimatedValue &&/.test(read("src/components/leads/new-lead-form.tsx")) && /errors\.website &&/.test(read("src/components/companies/company-fields.tsx")) && /errors\.linkedinUrl &&/.test(read("src/components/companies/company-fields.tsx")));

  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
