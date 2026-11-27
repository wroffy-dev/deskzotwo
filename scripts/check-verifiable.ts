/**
 * check:verifiable — verifiable documents (owner, 7 Nov 2026: src/actions/verifiable.ts, src/app/(public)/v/[token]).
 *
 *   1. The standing: valid, valid all of its last day, expired, withdrawn over everything; what the public may read.
 *   2. Adding: who may, what it needs, a number once, the link random and unchanged by a correction.
 *   3. The public page, rendered: each standing; no customer, reason or staff name; a wrong address is a 404; with the
 *      module off it won't say valid.
 *   4. Withdrawing: who may, with a reason; the page changes at once; putting it back.
 *   5. Who sees what: one linked to a customer only for those who may see that customer.
 *   6. Reminders: expiry reaches "A custom date is coming up", not once withdrawn.
 *   7. The public search: off by default; a whole number whatever its spaces or case, never a part; by name only if turned on, never
 *      a person, a few letters no good, ten at most; out-of-search ones not found; withdrawn ones found; limited.
 *   9. Custom fields: on the form, the list and the file; private unless marked; a marked one on the public page; no person, no
 *      secret or file on a certificate; a date field reaching reminders.
 *  10. The design: its choices checked before they reach a stranger's browser; each template drawn; the colour never the status's.
 *   8. The Excel import: a preview that writes nothing, what it refuses, a second run changing nothing, a correction keeping the link,
 *      a file unable to withdraw, and the export reading back in.
 *
 * Its own rows in the dev workspace, removed in a finally.
 *
 *   npm run check:verifiable
 */
import "dotenv/config";
import Module from "node:module";
import type { ReactElement } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";

class NotFound extends Error {}
type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
let moduleOn = true;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new NotFound("not found");
      },
      useRouter: () => ({ push() {}, refresh() {}, replace() {} }),
      usePathname: () => "/",
      useSearchParams: () => new URLSearchParams(),
      redirect: () => {
        throw new Error("redirect");
      },
    };
  }
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "next/headers") return { headers: async () => new Headers({ "x-forwarded-for": "203.0.113.9" }), cookies: async () => ({ get: () => undefined }) };
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleUser: async () => actor, moduleAvailableForTenant: async () => moduleOn };
  }
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const TAG = "zzverify";
const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function main() {
  const { renderToStaticMarkup } = await import("react-dom/server");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const rules = require("../src/lib/verifiable/rules") as typeof import("../src/lib/verifiable/rules");
  const actions = require("../src/actions/verifiable") as typeof import("../src/actions/verifiable");
  const { customDateRows } = require("../src/lib/automate/custom-dates") as typeof import("../src/lib/automate/custom-dates");
  const Page = (require("../src/app/(public)/v/[token]/page") as { default: (p: { params: Promise<{ token: string }> }) => Promise<ReactElement> }).default;
  const render = async (token: string) => renderToStaticMarkup(await Page({ params: Promise.resolve({ token }) }));

  const users: string[] = [];
  const companies: string[] = [];
  const ids = () => db.verifiableDocument.findMany({ where: { number: { startsWith: "ZZV-" } }, select: { id: true } });
  // The workspace's own setting, put back afterwards: this runs on a real one.
  const settingsBefore = await db.verifiableSettings.findUnique({ where: { id: "global" } });
  try {
    await db.verifiableSettings.deleteMany({ where: { id: "global" } });
    const person = async (name: string, role: string, grants: Record<string, boolean>) => {
      const u = await db.user.create({ data: { name: `Zz ${name}`, email: `${TAG}.${name}@example.invalid`, role, passwordHash: "x".repeat(60), permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) } }, select: { id: true, role: true, name: true, email: true } });
      users.push(u.id);
      return u;
    };
    const issuer = await person("issuer", "ADMIN", {});
    const viewer = await person("viewer", "SALES", { "documents.view": true, "certificates.issue": false, "certificates.withdraw": false, "companies.viewAll": false });
    const company = await db.company.create({ data: { name: "Zz Secret Client Ltd", normalizedName: `${TAG} secret client`, relationshipType: "CLIENT", createdById: issuer.id, ownerUserId: issuer.id }, select: { id: true } });
    companies.push(company.id);

    section("1. The standing");
    const today = new Date(`${day(0)}T00:00:00Z`);
    const at = (offset: number) => new Date(today.getTime() + offset * 86_400_000);
    ok("no end date: valid", rules.standingOf({ expiresOn: null, withdrawnAt: null }, today) === "VALID");
    ok("its last day: valid", rules.standingOf({ expiresOn: at(0), withdrawnAt: null }, today) === "VALID");
    ok("the day after: expired", rules.standingOf({ expiresOn: at(-1), withdrawnAt: null }, today) === "EXPIRED");
    ok("withdrawn wins, even in date", rules.standingOf({ expiresOn: at(30), withdrawnAt: new Date() }, today) === "WITHDRAWN");
    const shown = rules.publicFacts({ docType: "C", number: "N", title: "T", holderName: "H", scope: null, issuedOn: at(0), expiresOn: null, withdrawnAt: null, withdrawnReason: "SECRET", companyId: "x", createdById: "y" } as never, today);
    ok("the public facts name no reason, customer or staff", !JSON.stringify(shown).includes("SECRET") && !("companyId" in shown) && !("createdById" in shown));

    section("2. Adding");
    const blank = { docType: "Certificate", number: "ZZV-001", title: "ISO 9001:2015", holderName: "Acme Works", scope: "Manufacture of widgets", companyId: company.id, issuedOn: day(-10), expiresOn: day(100) };
    actor = viewer;
    ok("without certificates.issue: refused", !(await actions.saveVerifiable(blank)).ok);
    actor = issuer;
    ok("no number: refused", !(await actions.saveVerifiable({ ...blank, number: "" })).ok);
    ok("not a real date: refused", !(await actions.saveVerifiable({ ...blank, issuedOn: "2026-02-31" })).ok);
    ok("expiring before it was issued: refused", !(await actions.saveVerifiable({ ...blank, expiresOn: day(-20) })).ok);
    const made = await actions.saveVerifiable(blank);
    ok("added", made.ok, made.ok ? "" : made.error);
    const id = made.ok ? made.data.id : "";
    const row = await db.verifiableDocument.findUniqueOrThrow({ where: { id } });
    ok("  with a long random link", /^[A-Za-z0-9_-]{24}$/.test(row.token));
    const twice = await actions.saveVerifiable({ ...blank });
    ok("the same number again: refused, saying so", !twice.ok && twice.error.includes("ZZV-001"), twice.ok ? "" : twice.error);
    const fixed = await actions.saveVerifiable({ ...blank, id, holderName: "Acme Works Pvt Ltd" });
    const after = await db.verifiableDocument.findUniqueOrThrow({ where: { id } });
    ok("corrected: the link stays, so a printed QR keeps working", fixed.ok && after.token === row.token && after.holderName === "Acme Works Pvt Ltd");
    const link = await actions.verifiableLink(id);
    ok("a QR code and its address", link.ok && link.data.qr.startsWith("data:image/png") && link.data.url.endsWith(`/v/${row.token}`), link.ok ? link.data.url : link.error);
    const { currentTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const { subdomainHost } = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const permanent = subdomainHost((await currentTenant()).slug);
    ok("  the QR code always opens the permanent Deskzo address, whatever domain it was made on", link.ok && link.data.qrUrl.includes(`://${permanent}/v/${row.token}`), link.ok ? link.data.qrUrl : "");

    section("3. The public page");
    let html = await render(row.token);
    ok("valid, with what it is and who issued it", html.includes("Valid") && html.includes("ISO 9001:2015") && html.includes("Acme Works Pvt Ltd") && html.includes("ZZV-001") && html.includes("issued by"));
    ok("  no customer record on it", !html.includes("Zz Secret Client Ltd"));
    ok("  and nobody who works here", !html.includes("Zz issuer"));
    let missed = false;
    await render("A".repeat(24)).catch((e) => (missed = e instanceof NotFound));
    let bad = false;
    await render("short").catch((e) => (bad = e instanceof NotFound));
    ok("an address that isn't one: a 404", missed && bad);
    moduleOn = false;
    html = await render(row.token);
    ok("the feature gone: says it can't confirm, not valid", html.includes("confirmed") && !html.includes("Valid") && !html.includes("Acme Works"));
    moduleOn = true;
    const old = await actions.saveVerifiable({ ...blank, number: "ZZV-002", companyId: "", issuedOn: day(-400), expiresOn: day(-1) });
    const oldRow = await db.verifiableDocument.findUniqueOrThrow({ where: { id: old.ok ? old.data.id : "" } });
    html = await render(oldRow.token);
    ok("expired: says so, and when", html.includes("Expired") && html.includes("Expired on") && !html.includes(">Valid<"));

    section("4. Withdrawing");
    actor = viewer;
    ok("without certificates.withdraw: refused", !(await actions.setVerifiableWithdrawn(id, true, "No right to")).ok);
    actor = issuer;
    ok("no reason: refused", !(await actions.setVerifiableWithdrawn(id, true, "")).ok);
    ok("withdrawn", (await actions.setVerifiableWithdrawn(id, true, "SECRET-REASON failed audit")).ok);
    html = await render(row.token);
    ok("  the page says so at once", html.includes("Withdrawn") && html.includes("Withdrawn on"));
    ok("  and never why", !html.includes("SECRET-REASON"));
    ok("  though staff see it", (await actions.listVerifiable())!.rows.find((r) => r.id === id)?.withdrawnReason?.includes("SECRET-REASON") === true);
    const whileOut = (await customDateRows(today)).filter((r) => r.recordId.includes("verifiable_expiry") && JSON.stringify(r.payload).includes("ZZV-001"));
    ok("  and no reminders for it", whileOut.length === 0);
    await actions.setVerifiableWithdrawn(id, false);
    ok("put back: valid again", (await render(row.token)).includes("Valid"));

    section("7. The public search");
    const searchLib = require("../src/lib/verifiable/search") as typeof import("../src/lib/verifiable/search");
    const SearchPage = (require("../src/app/(public)/verify/page") as { default: (p: { searchParams: Promise<{ q?: string }> }) => Promise<ReactElement> }).default;
    const searchFor = async (q?: string) => renderToStaticMarkup(await SearchPage({ searchParams: Promise.resolve({ q }) }));
    let refused = false;
    await searchFor().catch((e) => (refused = e instanceof NotFound));
    ok("off until it's turned on: a 404", refused && (await searchLib.verifiableSearchSettings()).searchOn === false);
    actor = viewer;
    ok("turning it on needs settings.manage", !(await actions.saveVerifiableSearch({ searchOn: true, nameSearch: false })).ok);
    actor = issuer;
    ok("  whoever holds it may", (await actions.saveVerifiableSearch({ searchOn: true, nameSearch: false })).ok);
    const add = (number: string, extra: Partial<typeof blank> & { holderIsPerson?: boolean; inSearch?: boolean } = {}) => actions.saveVerifiable({ ...blank, number, companyId: "", ...extra });
    await add("ZZV-ABC-123", { holderName: "Zzprobe Foods Ltd" });
    await add("ZZV-PERSON", { holderName: "Zzprobe Asha Rao", holderIsPerson: true });
    await add("ZZV-HIDDEN", { holderName: "Zzprobe Hidden Ltd", inSearch: false });
    const on = { searchOn: true, nameSearch: false };
    const today2 = new Date(`${day(0)}T00:00:00Z`);
    const found = async (q: string, s = on) => (await searchLib.searchVerifiable(q, s, today2)).map((h) => h.number);
    ok("the whole number finds it", (await found("ZZV-ABC-123")).join() === "ZZV-ABC-123");
    ok("  whatever its spaces, dashes and case", (await found(" zzv abc 123 ")).join() === "ZZV-ABC-123");
    ok("  part of one doesn't", (await found("ZZV-ABC")).length === 0);
    ok("  nor a name, while that's off", (await found("Zzprobe Foods")).length === 0);
    ok("  nor one kept out of search, though its QR still works", (await found("ZZV-HIDDEN")).length === 0);
    const byName = { searchOn: true, nameSearch: true };
    ok("by name, once on", (await found("Zzprobe Foods", byName)).join() === "ZZV-ABC-123");
    ok("  three letters: no", (await found("Zzp", byName)).length === 0);
    ok("  never a person", !(await found("Zzprobe", byName)).includes("ZZV-PERSON") && (await found("ZZV-PERSON", byName)).join() === "ZZV-PERSON");
    ok("  nor one kept out of search", !(await found("Zzprobe", byName)).includes("ZZV-HIDDEN"));
    for (let i = 0; i < 12; i += 1) await add(`ZZV-BULK-${i}`, { holderName: `Zzbulk Works ${i}` });
    ok("  ten at most", (await found("Zzbulk", byName)).length === searchLib.NAME_SEARCH_MAX);
    const hit = (await searchLib.searchVerifiable("ZZV-ABC-123", on, today2))[0]!;
    ok("  a result names no customer or reason", !JSON.stringify(hit).includes("companyId") && !JSON.stringify(hit).includes("Reason"));
    await actions.setVerifiableWithdrawn((await db.verifiableDocument.findUniqueOrThrow({ where: { number: "ZZV-ABC-123" } })).id, true, "Testing");
    ok("withdrawn ones are found, saying so", (await searchLib.searchVerifiable("ZZV-ABC-123", on, today2))[0]?.standing === "WITHDRAWN");
    let page = await searchFor("ZZV-ABC-123");
    ok("the page shows it", page.includes("Withdrawn") && page.includes("Zzprobe Foods Ltd") && page.includes("/v/"));
    page = await searchFor("nothing-like-this-99");
    ok("  and says nothing found isn't proof", page.includes("No record found") && page.includes("fake"));
    page = await searchFor("ZZV-LIMIT");
    let limited = false;
    for (let i = 0; i < 120 && !limited; i += 1) limited = (await searchFor("ZZV-LIMIT")).includes("Too many searches");
    ok("  and limits how often one address may search", limited);

    section("8. The Excel import");
    const { verifiableImporter: imp } = require("../src/lib/portability/importers/verifiable") as typeof import("../src/lib/portability/importers/verifiable");
    const { verifiableExporter } = require("../src/lib/portability/exporters/verifiable") as typeof import("../src/lib/portability/exporters/verifiable");
    const ctx = { actorUserId: issuer.id, area: "verifiable-documents", pendingKeys: new Set<string>() };
    const sheet = { Number: "ZZV-IMP-1", Type: "Certificate", For: "ISO 14001", "Issued to": "Zzimport Ltd", "Issued on": "2026-01-15", "Valid until": "2029-01-14", Scope: "Valves" };
    const before = await db.verifiableDocument.count({ where: { number: "ZZV-IMP-1" } });
    const preview = await imp.plan(sheet, 2, ctx);
    ok("the preview says create, and writes nothing", preview.action === "create" && before === 0 && (await db.verifiableDocument.count({ where: { number: "ZZV-IMP-1" } })) === 0, preview.action);
    ok("no number: refused", (await imp.plan({ ...sheet, Number: "" }, 2, ctx)).action === "error");
    ok("a new one without a type, title, holder or date: refused", (await imp.plan({ Number: "ZZV-IMP-X" }, 2, ctx)).action === "error");
    ok("an unreadable date: refused", (await imp.plan({ ...sheet, "Issued on": "someday" }, 2, ctx)).action === "error");
    ok("expiring before it was issued: refused", (await imp.plan({ ...sheet, "Valid until": "2020-01-01" }, 2, ctx)).action === "error");
    ok("a customer who doesn't exist: refused, saying so", (await imp.plan({ ...sheet, Customer: "Zz Nobody At All" }, 2, ctx)).error?.includes("No customer") === true);
    ok("yes or no means that", (await imp.plan({ ...sheet, "In search": "maybe" }, 2, ctx)).action === "error");
    const noRight = await person("noissue", "SALES", { "certificates.issue": false });
    ok("without certificates.issue: refused", (await imp.plan(sheet, 2, { ...ctx, actorUserId: noRight.id })).error?.includes("issue") === true);
    await imp.apply(sheet, ctx);
    const imported = await db.verifiableDocument.findUniqueOrThrow({ where: { number: "ZZV-IMP-1" } });
    ok("applied, with its own link and search key", imported.title === "ISO 14001" && imported.token.length === 24 && imported.numberKey === "ZZVIMP1" && imported.inSearch && imported.expiresOn?.toISOString().slice(0, 10) === "2029-01-14");
    ok("the same file again changes nothing", (await imp.plan(sheet, 2, ctx)).action === "skip", (await imp.plan(sheet, 2, ctx)).changes);
    const corrected = await imp.plan({ ...sheet, "Issued to": "Zzimport Pvt Ltd" }, 2, ctx);
    ok("a correction is shown as one", corrected.action === "update" && corrected.changes.length === 1 && corrected.changes[0]!.field === "Issued to", corrected.changes);
    await imp.apply({ ...sheet, "Issued to": "Zzimport Pvt Ltd" }, ctx);
    const correctedRow = await db.verifiableDocument.findUniqueOrThrow({ where: { number: "ZZV-IMP-1" } });
    ok("  and keeps the link", correctedRow.token === imported.token && correctedRow.holderName === "Zzimport Pvt Ltd");
    ok("empty cells change nothing", (await imp.plan({ Number: "ZZV-IMP-1" }, 2, ctx)).action === "skip");
    await actions.setVerifiableWithdrawn(imported.id, true, "Testing import");
    await imp.apply({ ...sheet, "Issued to": "Zzimport Pvt Ltd", Withdrawn: "No" }, ctx);
    ok("a file can't bring back one withdrawn", !!(await db.verifiableDocument.findUniqueOrThrow({ where: { number: "ZZV-IMP-1" } })).withdrawnAt);
    const pending = await imp.plan({ ...sheet, Number: "ZZV-IMP-2" }, 3, { ...ctx, pendingKeys: new Set(["ZZV-IMP-2"]) });
    ok("the same new number twice in a file: refused", pending.action === "error" && pending.error!.includes("twice"));
    const out = await verifiableExporter({ userId: issuer.id, ownerUserIds: null });
    const line = out.find((r) => r.Number === "ZZV-IMP-1") as Record<string, string> | undefined;
    ok("exported, with the template's headings", !!line && imp.templateColumns.every((c) => c in line), line);
    ok("  no public link in the file", !JSON.stringify(line).includes(imported.token));
    ok("  and reading it back changes nothing", !!line && (await imp.plan(line, 2, ctx)).action === "skip", line ? (await imp.plan(line, 2, ctx)).changes : "");
    ok("a certificate's own headings are understood", imp.headerAliases!.Number!.includes("Certificate number") && imp.headerAliases!["Valid until"]!.includes("Expiry date"));

    section("9. Custom fields");
    const server = require("../src/lib/custom-fields/server") as typeof import("../src/lib/custom-fields/server");
    const rulesCf = require("../src/lib/custom-fields/rules") as typeof import("../src/lib/custom-fields/rules");
    const cfActions = require("../src/actions/custom-fields") as typeof import("../src/actions/custom-fields");
    ok("a certificate's fields don't take a secret or a file", !rulesCf.typesFor("VERIFIABLE").includes("SECRET") && !rulesCf.typesFor("VERIFIABLE").includes("FILE"), rulesCf.typesFor("VERIFIABLE"));
    const fieldOf = (key: string, label: string, type: string, extra: object = {}) => db.customFieldDefinition.create({ data: { entity: "VERIFIABLE", key, label, type: type as never, ...extra } });
    const defs = [await fieldOf("zz_iaf", "IAF code", "TEXT", { showInPortal: true, showInList: true }), await fieldOf("zz_fee", "Audit fee", "MONEY"), await fieldOf("zz_surveillance", "Surveillance due", "DATE"), await fieldOf("zz_secret_note", "Restricted note", "TEXT", { showInPortal: true, restricted: true }), await fieldOf("zz_auditor", "Auditor", "USER", { showInPortal: true })];
    const made2 = await actions.saveVerifiable({ ...blank, number: "ZZV-CF-1", companyId: "", customFields: { zz_iaf: "IAF 17", zz_fee: "90000", zz_surveillance: day(45), zz_secret_note: "HIDDEN-NOTE", zz_auditor: issuer.id } });
    ok("saved from the form", made2.ok, made2.ok ? "" : made2.error);
    const cfRow = await db.verifiableDocument.findUniqueOrThrow({ where: { number: "ZZV-CF-1" } });
    const cfPage = await render(cfRow.token);
    ok("a marked field shows on the public page", cfPage.includes("IAF code") && cfPage.includes("IAF 17"));
    ok("  an unmarked one doesn't", !cfPage.includes("Audit fee") && !cfPage.includes("90,000") && !cfPage.includes("90000"));
    ok("  nor a restricted one, even marked", !cfPage.includes("HIDDEN-NOTE"));
    ok("  nor a person's name, even marked", !cfPage.includes("Zz issuer") && !cfPage.includes("Auditor"));
    const fixedCf = await actions.saveVerifiable({ ...blank, id: cfRow.id, number: "ZZV-CF-1", companyId: "", customFields: { zz_iaf: "IAF 19" } });
    ok("edited from the form", fixedCf.ok && (await render(cfRow.token)).includes("IAF 19"));
    const marked = await cfActions.saveCustomFieldDefinition({ entity: "VERIFIABLE", label: "Zz Owner Name", type: "USER", options: [], required: false, helpText: "", group: "", restricted: false, showInList: false, showInPortal: true });
    const markedRow = marked.ok ? await db.customFieldDefinition.findUnique({ where: { id: marked.data.id } }) : null;
    ok("the settings refuse to mark a person for the public", marked.ok && markedRow?.showInPortal === false, marked.ok ? markedRow?.showInPortal : marked.error);
    if (marked.ok) defs.push(markedRow as never);
    const listed = await server.listColumns("VERIFIABLE", issuer.id, [cfRow.id], { listedOnly: true });
    ok("a column in the list", listed.columns.some((c) => c.key === "zz_iaf") && listed.texts[cfRow.id]?.zz_iaf === "IAF 19");
    const filtered = await actions.listVerifiable({ customFilters: { zz_iaf: { value: "IAF 19" } } });
    ok("a filter on the list", filtered?.rows.some((r) => r.number === "ZZV-CF-1") === true && filtered.rows.every((r) => r.number === "ZZV-CF-1"), filtered?.rows.length);
    ok("  and the list's search finds it", (await actions.listVerifiable({ q: "IAF 19" }))?.rows.some((r) => r.number === "ZZV-CF-1") === true);
    const { customSheetFor } = require("../src/lib/custom-fields/sheets") as typeof import("../src/lib/custom-fields/sheets");
    const { verifiableImporter: imp2 } = require("../src/lib/portability/importers/verifiable") as typeof import("../src/lib/portability/importers/verifiable");
    const sheetCustom = await customSheetFor("VERIFIABLE", issuer.id, imp2.templateColumns);
    const ctx2 = { actorUserId: issuer.id, area: "verifiable-documents", pendingKeys: new Set<string>(), custom: sheetCustom };
    const fileRow = { Number: "ZZV-CF-2", Type: "Certificate", For: "ISO 27001", "Issued to": "Zzfile Ltd", "Issued on": "2026-02-01", "IAF code": "IAF 33" };
    ok("in the import", (await imp2.plan(fileRow, 2, ctx2)).action === "create");
    await imp2.apply(fileRow, ctx2);
    const fileDoc = await db.verifiableDocument.findUniqueOrThrow({ where: { number: "ZZV-CF-2" } });
    ok("  written", (fileDoc.customFields as Record<string, unknown>).zz_iaf === "IAF 33");
    ok("  the file again changes nothing", (await imp2.plan(fileRow, 2, ctx2)).action === "skip");
    const { verifiableExporter: exp2 } = require("../src/lib/portability/exporters/verifiable") as typeof import("../src/lib/portability/exporters/verifiable");
    const outRow = (await exp2({ userId: issuer.id, ownerUserIds: null })).find((r) => r.Number === "ZZV-CF-2") as Record<string, string>;
    ok("  and in the export, reading back unchanged", outRow["IAF code"] === "IAF 33" && (await imp2.plan(outRow, 2, ctx2)).action === "skip", outRow);
    const dateEvent = (await customDateRows(new Date(`${day(0)}T00:00:00Z`))).map((r) => r.payload as { field: { key: string }; daysLeft: number; record: { ref: string } }).find((p) => p.field.key === "zz_surveillance");
    ok("a date field reaches the reminders", dateEvent?.daysLeft === 45 && dateEvent.record.ref === "ZZV-CF-1", dateEvent ?? "");

    section("10. The design");
    const design = require("../src/lib/verifiable/design") as typeof import("../src/lib/verifiable/design");
    actor = viewer;
    const save = (over: object = {}) => actions.saveVerifiableDesign({ template: "PORTAL", heading: "Zz Verify", intro: "Zz intro", accent: "#123456", contactEmail: "help@zz.example", contactPhone: "+91 98100 00000", accreditations: [{ name: "IAF", logo: null }], ...over } as never);
    ok("changing it needs settings.manage", !(await save()).ok);
    actor = issuer;
    ok("saved by whoever holds it", (await save()).ok);
    ok("a colour that isn't one: refused", !(await save({ accent: "red;background:url(x)" })).ok);
    ok("an address that isn't one: refused", !(await save({ contactEmail: "a b@zz" })).ok);
    ok("a phone that isn't one: refused", !(await save({ contactPhone: "javascript:alert(1)" })).ok);
    ok("an SVG logo: refused, for it could carry a script", !(await save({ accreditations: [{ name: "X", logo: "data:image/svg+xml;base64,PHN2Zz4=" }] })).ok);
    ok("a template that isn't one reads as the default", design.readTemplate("EVIL") === "TRUST");
    ok("only so many accreditations", design.readAccreditations(Array.from({ length: 9 }, (_, i) => ({ name: `A${i}` }))).length === design.ACCREDITATIONS_MAX);
    const looks: { t: string; html: string }[] = [];
    for (const t of ["TRUST", "SIMPLE", "PORTAL"] as const) {
      await save({ template: t });
      looks.push({ t, html: await render(cfRow.token) });
    }
    for (const { t, html } of looks) ok(`${t}: drawn with its words, contact and accreditation`, html.includes("Zz Verify") && html.includes("Zz intro") && html.includes("help@zz.example") && html.includes("IAF") && html.includes("Report a fake") && html.includes("Valid"));
    ok("  three different pages", new Set(looks.map((l) => l.html)).size === 3);
    const trust = looks.find((l) => l.t === "TRUST")!.html;
    ok("  the accent colours the banner", trust.includes("#123456") || trust.includes("rgb(18, 52, 86)"));
    ok("  and never the status", trust.includes("bg-success"));
    await actions.setVerifiableWithdrawn(cfRow.id, true, "Testing the colour");
    ok("  withdrawn stays red, whatever the colour", (await render(cfRow.token)).includes("bg-danger"));
    await db.customFieldDefinition.deleteMany({ where: { id: { in: defs.map((d) => d.id) } } });

    section("5. Who sees what");
    actor = viewer;
    const theirs = await actions.listVerifiable();
    ok("a customer's document, to somebody who can't see the customer: not listed", !!theirs && !theirs.rows.some((r) => r.id === id));
    ok("  no QR for it", !(await actions.verifiableLink(id)).ok);
    ok("  no withdrawing it", !(await actions.setVerifiableWithdrawn(id, true, "Not mine")).ok);
    ok("one with no customer: listed", !!theirs && theirs.rows.some((r) => r.number === "ZZV-002"));
    actor = await person("none", "SALES", { "documents.view": false });
    ok("without documents.view: nothing, so the page is a 404", (await actions.listVerifiable()) === null);
    actor = issuer;
    const search = await actions.listVerifiable({ q: "zzv-002", standing: "EXPIRED" });
    ok("searched and filtered", search?.rows.length === 1 && search.rows[0]!.number === "ZZV-002" && search.rows[0]!.standing === "EXPIRED");

    section("6. Reminders");
    const events = (await customDateRows(today)).filter((r) => r.recordId.includes("verifiable_expiry"));
    const event = events.map((r) => r.payload as { field: { key: string }; daysLeft: number; record: { ref: string }; company: { id: string } | null }).find((p) => p.record.ref === "ZZV-001");
    ok("expiry reaches the date trigger, with its customer and days", event?.daysLeft === 100 && event.company?.id === company.id, event ?? "");
  } finally {
    actor = null;
    const rows = await ids();
    await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: users } }, { entityId: { in: rows.map((r) => r.id) } }] } }).catch(() => undefined);
    await db.verifiableSettings.deleteMany({ where: { id: "global" } }).catch(() => undefined);
    if (settingsBefore) await db.verifiableSettings.create({ data: settingsBefore as never }).catch(() => undefined);
    await db.verifiableDocument.deleteMany({ where: { number: { startsWith: "ZZV-" } } }).catch((e: unknown) => console.error("cleanup", String(e).slice(0, 200)));
    await db.company.deleteMany({ where: { id: { in: companies } } }).catch((e: unknown) => console.error("cleanup", String(e).slice(0, 200)));
    await db.userPermission.deleteMany({ where: { userId: { in: users } } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: { in: users } } }).catch((e: unknown) => console.error("cleanup", String(e).slice(0, 200)));
  }
  console.log(failures === 0 ? `\nAll ${passes} verifiable document checks passed.\n` : `\n${failures} check(s) failed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
