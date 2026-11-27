/**
 * check:field-rules — what an admin makes compulsory or holds to a format on a company, contact or lead (owner,
 * 12 Nov 2026 — src/lib/field-rules).
 *
 *   1. The rules themselves, without a database: empty, conditions, every format, lengths, ranges, the words said,
 *      a new record against every rule and an edit only on what it sends, new-only, switched off.
 *   2. Saving a rule: what is refused (a bad pattern, a range upside down, a rule on its own condition).
 *   3. The saves that ask them: a company made and changed, a contact added and changed (no two the same email), a
 *      lead made and changed (a range; a date only when the value is large), one of the workspace's own fields.
 *   4. Imports read a row the same way.
 *   5. Only whoever may change settings may change the rules.
 *
 * Rules, companies and a custom field of its own (ZZPROBE_FR), removed in a finally; while it runs, the rules hold for
 * every save in this local database.
 *
 *   npm run check:field-rules
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";
import { checkRecord, compilePattern, conditionHolds, isEmpty, matchesPattern, ruleRefusal, ruleWords } from "../src/lib/field-rules/check";
import { BUILT_IN_FIELDS, type FieldRule } from "../src/lib/field-rules/catalogue";

let actor: { id: string; role: string; name: string; email: string } | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_FR";
const FIELD_KEY = "zzfr_po";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (s: string) => console.log(`\n— ${s} —\n`);
const rule = (over: Partial<FieldRule>): FieldRule => ({ id: "r", entity: "COMPANY", field: "website", kind: "REQUIRED", active: true, ...over });

async function cleanup(ruleIds: string[]) {
  await db.fieldRule.deleteMany({ where: { OR: [{ id: { in: ruleIds } }, { message: { startsWith: TAG } }] } });
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  await db.lead.deleteMany({ where: { companyId: { in: companies } } });
  await db.contact.deleteMany({ where: { companyId: { in: companies } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companies } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.customFieldDefinition.deleteMany({ where: { key: FIELD_KEY } });
}

async function main() {
  section("1. The rules, without a database");
  ok("empty: null, blank text, an empty list, an unticked box", isEmpty(null) && isEmpty("  ") && isEmpty([]) && isEmpty(false) && !isEmpty(0) && !isEmpty("x"));
  ok("a condition: is, is not, filled, empty", conditionHolds({ field: "source", op: "EQUALS", value: "referral" }, { source: "REFERRAL" }) && conditionHolds({ field: "source", op: "NOT_EQUALS", value: "OTHER" }, { source: "REFERRAL" }) && conditionHolds({ field: "x", op: "FILLED" }, { x: "a" }) && conditionHolds({ field: "x", op: "EMPTY" }, {}));
  ok("  more than and less than read numbers, commas and ₹ too", conditionHolds({ field: "v", op: "GREATER", value: "100000" }, { v: "₹2,00,000" }) && conditionHolds({ field: "v", op: "LESS", value: "10" }, { v: 5 }) && !conditionHolds({ field: "v", op: "GREATER", value: "10" }, { v: "" }));
  ok("formats: digits, letters, letters and digits, capitals", matchesPattern({ pattern: "DIGITS" }, "12345") && !matchesPattern({ pattern: "DIGITS" }, "12a") && matchesPattern({ pattern: "LETTERS" }, "Rajesh Kumar") && !matchesPattern({ pattern: "LETTERS" }, "R2") && matchesPattern({ pattern: "LETTERS_DIGITS" }, "ABC123") && !matchesPattern({ pattern: "LETTERS_DIGITS" }, "AB-1") && matchesPattern({ pattern: "UPPERCASE" }, "PO-12") && !matchesPattern({ pattern: "UPPERCASE" }, "po-12"));
  ok("  starts with and ends with, regardless of capitals", matchesPattern({ pattern: "STARTS_WITH", patternValue: "PO-" }, "po-77") && !matchesPattern({ pattern: "STARTS_WITH", patternValue: "PO-" }, "77") && matchesPattern({ pattern: "ENDS_WITH", patternValue: ".in" }, "acme.IN"));
  ok("  a pattern of their own matches the whole value", matchesPattern({ pattern: "CUSTOM", patternValue: "[A-Z]{3}-\\d{4}" }, "ABC-1234") && !matchesPattern({ pattern: "CUSTOM", patternValue: "[A-Z]{3}-\\d{4}" }, "xABC-1234"));
  ok("  a bad or over-long pattern is refused, never thrown", typeof compilePattern("(") === "string" && typeof compilePattern("a".repeat(201)) === "string" && compilePattern("\\d+") instanceof RegExp);
  ok("the words said, and an admin's own instead", ruleWords(rule({}), "Website") === "Website is required." && ruleWords(rule({ kind: "LENGTH", min: 15, max: 15 }), "GSTIN") === "GSTIN must be exactly 15 characters." && ruleWords(rule({ message: "Add the website, please" }), "Website") === "Add the website, please");
  const fields = BUILT_IN_FIELDS.COMPANY;
  const rules = [
    rule({ id: "a", field: "website" }),
    rule({ id: "b", field: "industryId", when: { field: "source", op: "EQUALS", value: "REFERRAL" } }),
    rule({ id: "c", field: "dunsNumber", kind: "LENGTH", min: 9, max: 9 }),
    rule({ id: "d", field: "linkedinUrl", newOnly: true }),
    rule({ id: "e", field: "tags", active: false }),
    rule({ id: "f", field: "cf.gone" }),
  ];
  const all = checkRecord({ rules, fields, record: { name: "X", source: "REFERRAL", dunsNumber: "123" }, isNew: true, touched: null }).problems.map((p) => p.rule.id).sort().join();
  ok("a new record against every rule: missing, too short, new-only — not one switched off, nor one on a removed field", all === "a,b,c,d", all);
  ok("  a condition that doesn't hold asks nothing", !checkRecord({ rules, fields, record: { source: "OTHER" }, isNew: true, touched: null }).problems.some((p) => p.rule.id === "b"));
  const edit = checkRecord({ rules, fields, record: { source: "REFERRAL" }, isNew: false, touched: new Set(["dunsNumber"]) }).problems.map((p) => p.rule.id).join();
  ok("an edit only on what it sends — and never a new-only rule", edit === "", edit);
  ok("  an empty value is the required rule's business, not the length's", !checkRecord({ rules: [rules[2]!], fields, record: { dunsNumber: "" }, isNew: true, touched: null }).problems.length);
  ok("no two the same is left for the database to answer", checkRecord({ rules: [rule({ field: "name", kind: "UNIQUE" })], fields, record: { name: "Acme" }, isNew: true, touched: null }).toCheckUnique.length === 1);

  section("2. Saving a rule");
  const refusal = (over: Partial<FieldRule>) => ruleRefusal({ entity: "COMPANY", field: "website", kind: "REQUIRED", ...over }, fields);
  ok("a field that always has a value can't be made compulsory", refusal({ field: "relationshipType" }) !== null);
  ok("  a rule its field can't take is refused", refusal({ field: "tags", kind: "PATTERN", pattern: "DIGITS" }) !== null);
  ok("  a length with no bounds, or upside down", refusal({ field: "website", kind: "LENGTH" }) !== null && refusal({ field: "website", kind: "LENGTH", min: 9, max: 3 }) !== null);
  ok("  a pattern that isn't one", refusal({ kind: "PATTERN", pattern: "CUSTOM", patternValue: "(" }) !== null);
  ok("  a rule that depends on its own field", refusal({ when: { field: "website", op: "FILLED" } }) !== null);
  ok("  a condition missing its value", refusal({ field: "industryId", when: { field: "source", op: "EQUALS", value: "" } }) !== null);
  ok("a sound one is fine", refusal({ field: "industryId", when: { field: "source", op: "EQUALS", value: "REFERRAL" } }) === null);

  /* eslint-disable @typescript-eslint/no-require-imports */
  const server = require("../src/lib/field-rules/server") as typeof import("../src/lib/field-rules/server");
  const companies = require("../src/actions/company") as typeof import("../src/actions/company");
  const leads = require("../src/actions/lead") as typeof import("../src/actions/lead");
  const settings = require("../src/actions/field-rules") as typeof import("../src/actions/field-rules");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const made: string[] = [];
  await cleanup(made);
  try {
    const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true, active: true }, select: { id: true, role: true, name: true, email: true } });
    const seller = await db.user.findFirstOrThrow({ where: { active: true, isSuperAdmin: false, role: "SALES" }, select: { id: true, role: true, name: true, email: true } });
    actor = admin;
    const add = async (input: Parameters<typeof server.saveFieldRule>[1]) => {
      const r = await server.saveFieldRule(admin.id, { message: null, ...input });
      if (!r.ok) throw new Error(`rule refused: ${r.error}`);
      made.push(r.id);
      return r.id;
    };
    ok("a rule refused on saving says why", !(await server.saveFieldRule(admin.id, { entity: "COMPANY", field: "website", kind: "PATTERN", pattern: "CUSTOM", patternValue: "(" })).ok);

    section("3a. A company");
    await add({ entity: "COMPANY", field: "industryId", kind: "REQUIRED", when: { field: "source", op: "EQUALS", value: "REFERRAL" }, message: `${TAG}: a referral needs its industry.` });
    await add({ entity: "COMPANY", field: "dunsNumber", kind: "PATTERN", pattern: "DIGITS" });
    await add({ entity: "COMPANY", field: "website", kind: "REQUIRED", newOnly: true, when: { field: "dunsNumber", op: "FILLED" } });
    const referral = await companies.createCompany({ name: `${TAG} Referral Co`, source: "REFERRAL" });
    ok("made without the industry its referral needs: refused, in the admin's words", !referral.ok && referral.error.includes("a referral needs its industry"), referral.ok ? "made" : referral.error);
    const other = await companies.createCompany({ name: `${TAG} Plain Co`, source: "OTHER" });
    ok("  any other source: made", other.ok, other.ok ? "" : other.error);
    const duns = await companies.createCompany({ name: `${TAG} Duns Co`, source: "OTHER", dunsNumber: "12AB" });
    ok("a DUNS number with letters in it: refused", !duns.ok && /DUNS number/.test(duns.ok ? "" : duns.error), duns.ok ? "made" : duns.error);
    const dunsNoSite = await companies.createCompany({ name: `${TAG} Duns Co`, source: "OTHER", dunsNumber: "123456789" });
    ok("  digits, but a website is needed when there's a DUNS number (new records only)", !dunsNoSite.ok && /Website is required/.test(dunsNoSite.ok ? "" : dunsNoSite.error), dunsNoSite.ok ? "made" : dunsNoSite.error);
    const good = await companies.createCompany({ name: `${TAG} Duns Co`, source: "OTHER", dunsNumber: "123456789", website: "https://duns.example.com" });
    ok("  with the website: made", good.ok, good.ok ? "" : good.error);
    if (good.ok) {
      const changed = await companies.updateCompany({ id: good.data.id, name: `${TAG} Duns Co`, source: "OTHER", dunsNumber: "987654321", website: "" });
      ok("changed later without the website: allowed — that rule is for new records only", changed.ok, changed.ok ? "" : changed.error);
      const badEdit = await companies.updateCompany({ id: good.data.id, name: `${TAG} Duns Co`, source: "OTHER", dunsNumber: "98-76" });
      ok("  but the DUNS number is held to digits on every save", !badEdit.ok, badEdit.ok ? "saved" : badEdit.error);
    }

    section("3b. A contact");
    await add({ entity: "CONTACT", field: "email", kind: "UNIQUE" });
    await add({ entity: "CONTACT", field: "phone", kind: "REQUIRED" });
    const home = other.ok ? other.data.id : "";
    const noPhone = await companies.addContact(home, { name: "Zz Rajesh", email: `rajesh@zzprobe-fr.test` });
    ok("a contact with no phone: refused", !noPhone.ok && /Phone is required/.test(noPhone.ok ? "" : noPhone.error), noPhone.ok ? "added" : noPhone.error);
    const first = await companies.addContact(home, { name: "Zz Rajesh", email: `rajesh@zzprobe-fr.test`, phone: "+91 98100 11111" });
    ok("  with one: added", first.ok, first.ok ? "" : first.error);
    const twin = await companies.addContact(home, { name: "Zz Other", email: `RAJESH@zzprobe-fr.test`, phone: "+91 98100 22222" });
    ok("the same email again, in other capitals: refused", !twin.ok && /already used/.test(twin.ok ? "" : twin.error), twin.ok ? "added" : twin.error);
    if (first.ok) {
      const same = await companies.updateContact({ id: first.data.id, name: "Zz Rajesh Kumar", email: `rajesh@zzprobe-fr.test`, phone: "+91 98100 11111" });
      ok("  a contact keeping their own email is not their own twin", same.ok, same.ok ? "" : same.error);
    }
    const withCompany = await companies.createCompany({ name: `${TAG} With People`, source: "OTHER", contacts: [{ name: "Zz Nophone", email: `np@zzprobe-fr.test` }] });
    ok("a contact made with its company is held to the rules too, by name", !withCompany.ok && /Zz Nophone: Phone is required/.test(withCompany.ok ? "" : withCompany.error), withCompany.ok ? "made" : withCompany.error);

    section("3c. A lead");
    await add({ entity: "LEAD", field: "estimatedValue", kind: "RANGE", min: 1000 });
    await add({ entity: "LEAD", field: "expectedCloseDate", kind: "REQUIRED", when: { field: "estimatedValue", op: "GREATER", value: "100000" } });
    const small = await leads.createLead({ companyId: home, title: `${TAG} small`, estimatedValue: 500 });
    ok("a value under the smallest: refused", !small.ok && /at least 1000/.test(small.ok ? "" : small.error), small.ok ? "made" : small.error);
    const large = await leads.createLead({ companyId: home, title: `${TAG} large`, estimatedValue: 200000 });
    ok("  a large one with no close date: refused", !large.ok && /Expected close date is required/.test(large.ok ? "" : large.error), large.ok ? "made" : large.error);
    const dated = await leads.createLead({ companyId: home, title: `${TAG} large`, estimatedValue: 200000, expectedCloseDate: "2027-03-31" });
    ok("  with one: made", dated.ok, dated.ok ? "" : dated.error);
    if (dated.ok) {
      const lead = await db.lead.findFirstOrThrow({ where: { companyId: home, title: `${TAG} large` }, select: { id: true } });
      const cleared = await leads.updateLeadDetails({ leadId: lead.id, title: `${TAG} large`, estimatedValue: 200000, expectedCloseDate: "" });
      ok("changing it to drop the date: refused", !cleared.ok, cleared.ok ? "saved" : cleared.error);
      const lowered = await leads.updateLeadDetails({ leadId: lead.id, title: `${TAG} large`, estimatedValue: 50000, expectedCloseDate: "" });
      ok("  lowered under the line, the date isn't asked", lowered.ok, lowered.ok ? "" : lowered.error);
    }

    section("3d. One of the workspace's own fields");
    await db.customFieldDefinition.create({ data: { entity: "LEAD", key: FIELD_KEY, label: "Their PO", type: "TEXT", createdById: admin.id } });
    const fields2 = await server.ruleFields("LEAD");
    ok("it is offered to rules, by its label", fields2.some((f) => f.key === `cf.${FIELD_KEY}` && f.label === "Their PO" && f.kind === "text"));
    await add({ entity: "LEAD", field: `cf.${FIELD_KEY}`, kind: "PATTERN", pattern: "STARTS_WITH", patternValue: "PO-" });
    const badPo = await leads.createLead({ companyId: home, title: `${TAG} po`, estimatedValue: 5000, customFields: { [FIELD_KEY]: "77" } });
    ok("a value in the wrong form: refused", !badPo.ok && /Their PO must start with "PO-"/.test(badPo.ok ? "" : badPo.error), badPo.ok ? "made" : badPo.error);
    const goodPo = await leads.createLead({ companyId: home, title: `${TAG} po`, estimatedValue: 5000, customFields: { [FIELD_KEY]: "PO-77" } });
    ok("  in the right one: made", goodPo.ok, goodPo.ok ? "" : goodPo.error);
    if (goodPo.ok) {
      const lead = await db.lead.findFirstOrThrow({ where: { companyId: home, title: `${TAG} po` }, select: { id: true } });
      const fieldsOnly = await leads.updateLeadCustomFields(lead.id, { [FIELD_KEY]: "88" });
      ok("  and on its own, from the record's own fields card", !fieldsOnly.ok, fieldsOnly.ok ? "saved" : fieldsOnly.error);
    }

    section("4. Imports");
    const row = await server.importRuleRefusal("COMPANY", null, { name: `${TAG} Imported`, source: "REFERRAL" });
    ok("a new row is held to every rule", !!row && row.includes("a referral needs its industry"), row);
    const okRow = await server.importRuleRefusal("COMPANY", null, { name: `${TAG} Imported`, source: "REFERRAL", industryId: "Retail" });
    ok("  a row that names the industry passes", okRow === null, okRow);
    if (good.ok) {
      const untouched = await server.importRuleRefusal("COMPANY", good.data.id, { name: `${TAG} Duns Co` });
      ok("a row for a company already here is checked on the cells it fills", untouched === null, untouched);
    }

    section("4b. Switched off");
    await db.fieldRule.updateMany({ where: { id: { in: made } }, data: { active: false } });
    const offAgain = await companies.createCompany({ name: `${TAG} Referral Co`, source: "REFERRAL" });
    ok("every rule switched off: the referral is made", offAgain.ok, offAgain.ok ? "" : offAgain.error);

    section("5. Who may change the rules");
    actor = seller;
    ok("somebody without settings can't list, add or remove a rule", !(await settings.listFieldRules()).ok && !(await settings.saveFieldRuleAction({ entity: "COMPANY", field: "website", kind: "REQUIRED" })).ok);
    actor = admin;
    const listed = await settings.listFieldRules();
    ok("an admin sees each record type's fields and rules", listed.ok && listed.data.COMPANY.rules.some((r) => made.includes(r.id)) && listed.data.LEAD.fields.some((f) => f.key === `cf.${FIELD_KEY}`));
  } finally {
    await cleanup(made);
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
