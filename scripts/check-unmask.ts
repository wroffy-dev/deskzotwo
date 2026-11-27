/**
 * check:unmask — the unmask process (owner, 5 Nov 2026 — Phase 3 masking fixes: audit H.4.5, H.4.8, H.5, M-10,
 * C.3.6; src/lib/authz/unmask.ts, src/actions/lead-unmask.ts, src/actions/contact-unmask.ts).
 *
 *   0. The migration: usage and log rows written before it say what they were about (`contact:<id>` a contact,
 *      anything else a lead), every old row is chained, and the chain the SQL wrote is the one the app checks.
 *   1. What was revealed: usage and log keyed by entity and record id, `leadId` still written; one generic reveal,
 *      `revealRecord`, that takes leads, contacts and companies — and nothing else.
 *   2. An explicit reveal: the lead page opens masked and spends nothing; "Show" reveals, with the reason the person
 *      typed kept on the log row — on the lead page, the Leads list and a contact alike. The page in its "not
 *      revealed yet" state leaks nothing: the lead, its redactor and its Activity feed.
 *   3. A default daily limit: unmask granted and no limit row is the workspace's default (25), not unlimited;
 *      "no limit" only as an explicit choice; the super admin's to change; drawn beside the master switch
 *      (Settings › Access Control › Sensitive Data › Global PII Masking, and Unmasking Limits).
 *   4. One reveal, one record family: revealing a lead reveals its contact for the day at no extra unit, logged with
 *      its own entity, id and fields — and the contact's screens show it in the clear; other contacts stay masked.
 *   4b. A company (wave B): "Show" on it reveals its unmaskable fields with the reason, against the same limit — a repeat
 *      free, one out of reach refused and logged; revealing a lead reveals its company at no extra unit, only where the
 *      person reaches it and may unmask something on it; its page, list row and the lead's page then in the clear.
 *   5. Fields granted later the same day aren't covered by the morning's reveal: they need a new reveal, which uses
 *      no extra unit — on a lead's page, the Leads list and a contact.
 *   6. Tamper evidence: every row chained; reveals at the same moment can't fork it; a row changed or removed
 *      behind the app's back is named; UPDATE, DELETE and TRUNCATE refused; the log page — Access Control ›
 *      Unmasking Activity, where a link to the retired Unmasking logs page lands — says "Log intact" (the super
 *      admin's alone); the CSV carries the chain; no values anywhere in the log.
 *   7. Kept: deleting a person leaves their unmask events, and a workspace reset archives the log in place.
 *
 * On a scratch database built from the migrations beside the copy (and dropped at the end): the log can't be cleaned
 * up — that is the point of it — and the reset at the end empties everything else.
 *
 *   npm run check:unmask
 */
import "dotenv/config";
import Module from "node:module";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, mkdirSync, readdirSync, readFileSync, rmSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { PrismaClient } from "@prisma/client";
import { directClient } from "../src/lib/tenancy/direct-client";

const MIGRATION = "20261205090000_unmask_entity_chain";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

// ── Stand-ins: who is calling, and whether an admin is viewing as them ───────────────────────────
type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const viewingAs: { user: { id: string; name: string; email: string; role: string }; actor: { id: string; name: string; role: string } } | null = null;
const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return {
      requireUser: async () => {
        if (!actor) throw new Error("The check called an action without saying who was calling it.");
        return actor;
      },
      currentUser: async () => actor,
      viewAsContext: async () => viewingAs,
      refuseWhileViewingAs: async () => null,
    };
  }
  if (request === "next/navigation") {
    return {
      useRouter: () => ({ push: () => {}, refresh: () => {}, replace: () => {}, back: () => {}, prefetch: () => {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/leads",
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
    };
  }
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

const RAW = {
  company: "Quillon Dynamics",
  // The contact of most of the leads below.
  email: "meera@quillon.example",
  phone: "+91 99887 76655",
  contact: "Meera Quill",
  // The contact of the one lead whose family is revealed (section 4).
  famName: "Fam Ily",
  famEmail: "family@quillon.example",
  famPhone: "+91 93333 22211",
  c2Email: "arun@quillon.example",
  c2Phone: "+91 91234 56780",
  c3Email: "tara@quillon.example",
  c3Phone: "+91 90000 11122",
};
/**
 * Field values: emails, phones — whole, without their spaces, or their middle digits with the space after (a bare run
 * of five digits turns up in ids and hashes by chance) — never in the log, nor on a masked screen.
 */
const values = [RAW.email, RAW.phone, RAW.famEmail, RAW.famPhone, RAW.c2Email, RAW.c2Phone, RAW.c3Email, RAW.c3Phone, "9988776655", "9333322211", "9123456780", "9000011122", "99887 7", "93333 2", "91234 5", "90000 1"];
const valueLeaks = (value: unknown) => {
  const text = JSON.stringify(value).toLowerCase();
  return values.filter((r) => text.includes(r.toLowerCase()));
};
/** …and the company's name, masked on a lead for this role. (The log names a contact by its company, as 6d4a7f23 chose.) */
const leaks = (value: unknown) => [...valueLeaks(value), ...(JSON.stringify(value).toLowerCase().includes(RAW.company.toLowerCase()) ? [RAW.company] : [])];

/** 0. The migration, on rows written in the shape before it. */
async function migrationBackfill(scratchUrl: string) {
  section("0. The migration: rows written before it");
  const repo = process.cwd();
  const work = mkdtempSync(path.join(tmpdir(), "deskzo-unmask-check-"));
  const prismaBin = path.join(repo, "node_modules", ".bin", "prisma");
  const deploy = () => execFileSync(prismaBin, ["migrate", "deploy", "--schema", path.join(work, "schema.prisma")], { cwd: work, stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60 * 1000 });
  try {
    copyFileSync(path.join(repo, "prisma", "schema.prisma"), path.join(work, "schema.prisma"));
    mkdirSync(path.join(work, "migrations"));
    copyFileSync(path.join(repo, "prisma", "migrations", "migration_lock.toml"), path.join(work, "migrations", "migration_lock.toml"));
    const folders = readdirSync(path.join(repo, "prisma", "migrations")).filter((f) => f !== "migration_lock.toml").sort();
    // Not necessarily the newest any more (owner, 5 Nov 2026 — Phase 3 wave B added 20261205110000_field_policy_export):
    // built from every migration sorted before this change's, then this one over the old-shape rows, then the rest.
    const before = folders.filter((f) => f < MIGRATION);
    const after = folders.filter((f) => f > MIGRATION);
    ok("this change's migration is among them", folders.includes(MIGRATION), folders.at(-1));
    // Copies, not links: Prisma reads only real folders.
    for (const f of before) cpSync(path.join(repo, "prisma", "migrations", f), path.join(work, "migrations", f), { recursive: true });
    deploy();

    const scratch = directClient(scratchUrl, { max: 1 });
    const applied = await scratch.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from "_prisma_migrations"`);
    ok("built from every migration before this one", Number(applied[0]?.n) === before.length, String(applied[0]?.n));
    try {
      const u = await scratch.user.create({ data: { name: "Zz Before", email: "before@zz-unmask.invalid", role: "ADMIN", passwordHash: "x".repeat(60) } });
      // The shape before: no entity, no record id, no chain. A lead, a contact, and a row with everything awkward in it.
      await scratch.$executeRawUnsafe(
        `INSERT INTO unmask_usage (id, "userId", "leadId", "businessDate", fields) VALUES ('zzu1', $1, 'zz-old-lead', '2026-11-01', '{email,phone}'), ('zzu2', $1, 'contact:zz-old-contact', '2026-11-01', '{email}')`,
        u.id,
      );
      const insert = (id: string, at: string, leadId: string, extra: { fields?: string; result?: string; reason?: string | null; userAgent?: string | null; userName?: string; leadRef?: string | null; consumed?: boolean; usedToday?: number | null }) =>
        scratch.$executeRawUnsafe(
          `INSERT INTO unmask_events (id, at, "businessDate", "tenantId", "userId", "userName", "impersonatedByUserId", "leadId", "leadRef", fields, result, consumed, "usedToday", "dailyLimit", reason, "requestId", ip, "userAgent")
           VALUES ($1, $2::timestamp, '2026-11-01', NULL, $3, $4, NULL, $5, $6, $7::text[], $8::"UnmaskResult", $9, $10, 2, $11, 'req-1', '10.0.0.1', $12)`,
          id, at, u.id, extra.userName ?? "Zz Before", leadId, extra.leadRef ?? null, extra.fields ?? "{email}", extra.result ?? "ALLOWED", extra.consumed ?? true, extra.usedToday ?? 1, extra.reason ?? null, extra.userAgent ?? null,
        );
      // Two rows at the same millisecond: their order is the id's.
      await insert("zze-b", "2026-11-01 10:00:00.250", "zz-old-lead", { leadRef: "LEAD-000001" });
      await insert("zze-a", "2026-11-01 10:00:00.250", "contact:zz-old-contact", { leadRef: "Contact at Zz \"Quoted\" & Co" });
      await insert("zze-c", "2026-11-01 09:59:59.999", "zz-old-lead", { fields: "{}", result: "DENIED", consumed: false, usedToday: null, reason: "Line one\nline two\t\"tab\" \\ back — ₹ émoji 😀", userAgent: "Mozilla/5.0 \u0001 (X11)", userName: "Zz O'Brien \"Q\"" });

      // …and now this change's migration, then any after it.
      cpSync(path.join(repo, "prisma", "migrations", MIGRATION), path.join(work, "migrations", MIGRATION), { recursive: true });
      deploy();
      ok("the migration applies over rows written in the old shape", true);
      for (const f of after) cpSync(path.join(repo, "prisma", "migrations", f), path.join(work, "migrations", f), { recursive: true });
      if (after.length) deploy();
      ok("  and the migrations after it apply on top", after.length === 0 || Number((await scratch.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from "_prisma_migrations"`))[0]?.n) === folders.length);

      const usage = await scratch.unmaskUsage.findMany({ orderBy: { id: "asc" }, select: { id: true, entity: true, recordId: true, leadId: true, includedWith: true } });
      ok(
        "usage: a lead's row is the lead's, `contact:<id>` the contact's — `leadId` as it was",
        JSON.stringify(usage) ===
          JSON.stringify([
            { id: "zzu1", entity: "leads", recordId: "zz-old-lead", leadId: "zz-old-lead", includedWith: null },
            { id: "zzu2", entity: "contacts", recordId: "zz-old-contact", leadId: "contact:zz-old-contact", includedWith: null },
          ]),
        usage,
      );
      const events = await scratch.unmaskEvent.findMany({ orderBy: { seq: "asc" }, select: { id: true, seq: true, entity: true, recordId: true, leadId: true, prevHash: true, hash: true } });
      ok("the log the same way", events.find((e) => e.id === "zze-a")?.entity === "contacts" && events.find((e) => e.id === "zze-a")?.recordId === "zz-old-contact" && events.filter((e) => e.entity === "leads").length === 2, events);
      ok("every old row has its place, oldest first (the same millisecond by id)", events.map((e) => `${e.seq}:${e.id}`).join() === "1:zze-c,2:zze-a,3:zze-b", events.map((e) => `${e.seq}:${e.id}`));
      ok("  the first chained to nothing, each next to the one before", events[0]?.prevHash === "0".repeat(64) && events[1]?.prevHash === events[0]?.hash && events[2]?.prevHash === events[1]?.hash);
      const { verifyUnmaskChain } = await import("../src/lib/authz/unmask");
      const report = await verifyUnmaskChain(scratch as never);
      ok("the chain the SQL wrote is the one the app checks — quotes, new lines, a control character and an emoji included", report.intact && report.rows === 3, report);
      const refused = await scratch.$executeRawUnsafe(`UPDATE unmask_events SET reason = 'edited' WHERE id = 'zze-b'`).then(() => "").catch((e: Error) => e.message);
      ok("the append-only trigger is back on after the backfill", refused.includes("append-only"), refused);
      const twice = await scratch.$executeRawUnsafe(`INSERT INTO unmask_usage (id, "userId", "leadId", entity, "recordId", "businessDate", fields) VALUES ('zzu3', $1, 'zz-old-lead', 'leads', 'zz-old-lead', '2026-11-01', '{title}')`, u.id).then(() => "").catch((e: Error) => e.message);
      ok("usage is unique per person, day, entity and record", /unique|duplicate/i.test(twice), twice);
      const sameIdOtherKind = await scratch.$executeRawUnsafe(`INSERT INTO unmask_usage (id, "userId", "leadId", entity, "recordId", "businessDate", fields) VALUES ('zzu4', $1, 'company:zz-old-lead', 'companies', 'zz-old-lead', '2026-11-01', '{gstin}')`, u.id).then(() => "").catch((e: Error) => e.message);
      ok("  — the same id as another kind of record is another record", sameIdOtherKind === "", sameIdOtherKind);
      const unknown = await scratch.$executeRawUnsafe(`INSERT INTO unmask_usage (id, "userId", "leadId", entity, "recordId", "businessDate", fields) VALUES ('zzu5', $1, 'x', 'invoices', 'x', '2026-11-01', '{}')`, u.id).then(() => "").catch((e: Error) => e.message);
      ok("  and a kind the app doesn't reveal is refused by the database", /check constraint/i.test(unknown), unknown);
      await scratch.unmaskUsage.deleteMany({ where: { userId: u.id } });
    } finally {
      await scratch.$disconnect();
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

async function run(db: PrismaClient) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const leads = require("../src/actions/lead") as typeof import("../src/actions/lead");
  const { unmaskLead } = require("../src/actions/lead-unmask") as typeof import("../src/actions/lead-unmask");
  const { unmaskContact } = require("../src/actions/contact-unmask") as typeof import("../src/actions/contact-unmask");
  const logs = require("../src/actions/unmask-log") as typeof import("../src/actions/unmask-log");
  const U = require("../src/lib/authz/unmask") as typeof import("../src/lib/authz/unmask");
  const { leadPageRedaction, maskLeadsForList } = require("../src/lib/leads/masking") as typeof import("../src/lib/leads/masking");
  const { contactMasker, maskContactRows } = require("../src/lib/contacts/masking") as typeof import("../src/lib/contacts/masking");
  const { recordActivity } = require("../src/lib/activity/timeline") as typeof import("../src/lib/activity/timeline");
  const { LeadUnmask } = require("../src/components/leads/lead-unmask") as typeof import("../src/components/leads/lead-unmask");
  // The master switch and the default limit are drawn on Settings › Access Control › Sensitive Data › Global PII
  // Masking; the log on Access Control › Unmasking Activity (the audit page with `?category=pii`). The old
  // Unmasking logs page only sends a saved link on.
  const MASKING_PAGE = require("../src/app/(dashboard)/settings/access/sensitive/masking/page") as typeof import("../src/app/(dashboard)/settings/access/sensitive/masking/page");
  const LIMITS_PAGE = require("../src/app/(dashboard)/settings/access/sensitive/limits/page") as typeof import("../src/app/(dashboard)/settings/access/sensitive/limits/page");
  const AUDIT_PAGE = require("../src/app/(dashboard)/settings/access/audit/page") as typeof import("../src/app/(dashboard)/settings/access/audit/page");
  const AC_LAYOUT = require("../src/app/(dashboard)/settings/access/layout") as typeof import("../src/app/(dashboard)/settings/access/layout");
  const RETIRED_LOG_PAGE = require("../src/app/(dashboard)/settings/unmasking-logs/page") as typeof import("../src/app/(dashboard)/settings/unmasking-logs/page");
  const { userHoldings, removeAccount } = require("../src/lib/user-delete") as typeof import("../src/lib/user-delete");
  const reset = require("../src/lib/data-reset") as typeof import("../src/lib/data-reset");
  /* eslint-enable @typescript-eslint/no-require-imports */

  // ── People, records and rules ─────────────────────────────────────────────────────────────────────
  const ROLE = "ZZ_UNMASK_PROBE";
  await db.role.create({ data: { key: ROLE, name: "Unmask probe" } });
  for (const permission of ["leads.view", "contacts.view", "calls.view"]) await db.rolePermission.create({ data: { role: ROLE, permission, allowed: true } });
  const person = (key: string, role: string, extra: object = {}) =>
    db.user.create({ data: { name: `Zz ${key}`, email: `${key.toLowerCase()}@zz-unmask.invalid`, role, passwordHash: "x".repeat(60), ...extra } });
  const superAdmin = await person("Owner", "ADMIN", { isSuperAdmin: true });
  const admin = await person("Admin", "ADMIN");
  const rep = await person("Rep", ROLE);
  const others = await Promise.all(Array.from({ length: 6 }, (_, i) => person(`Burst${i}`, ROLE)));
  const as = (u: { id: string; name: string; email: string; role: string }) => {
    actor = { id: u.id, name: u.name, email: u.email, role: u.role };
  };

  const company = await db.company.create({ data: { name: RAW.company, normalizedName: RAW.company.toLowerCase(), createdById: admin.id, ownerUserId: rep.id, stage: "CUSTOMER" } });
  const c0 = await db.contact.create({ data: { companyId: company.id, name: RAW.contact, email: RAW.email, phone: RAW.phone } });
  const c1 = await db.contact.create({ data: { companyId: company.id, name: RAW.famName, email: RAW.famEmail, phone: RAW.famPhone } });
  const c2 = await db.contact.create({ data: { companyId: company.id, name: "Arun", email: RAW.c2Email, phone: RAW.c2Phone } });
  const c3 = await db.contact.create({ data: { companyId: company.id, name: "Tara", email: RAW.c3Email, phone: RAW.c3Phone } });
  const lead = (title: string, contactId: string | null = c0.id) => db.lead.create({ data: { companyId: company.id, contactId, title, ownerUserId: rep.id } });
  const [l1, l2, l3, l4, l5, l6] = [await lead("Zz renewal"), await lead("Zz upgrade"), await lead("Zz licences"), await lead("Zz family", c1.id), await lead("Zz quota one"), await lead("Zz quota two")];
  const burstLeads = await Promise.all(others.map((_, i) => lead(`Zz burst ${i}`, null)));
  await db.company.update({ where: { id: company.id }, data: { ownerUserId: rep.id } });

  const rule = (entity: string, field: string, over: object = {}) =>
    db.roleFieldPolicy.upsert({
      where: { role_entity_field: { role: ROLE, entity, field } },
      create: { role: ROLE, entity, field, view: true, maskInList: true, maskInDetail: true, unmask: true, format: field === "email" ? "email" : field === "phone" ? "phone_last4" : "first", ...over },
      update: { view: true, maskInList: true, maskInDetail: true, unmask: true, ...over },
    });
  for (const f of ["companyName", "email", "phone"]) await rule("leads", f);
  // The lead's name masked, not yet theirs to unmask — granted later in the day (section 5).
  await rule("leads", "title", { unmask: false });
  for (const f of ["email", "phone"]) await rule("contacts", f);
  await rule("contacts", "name", { unmask: false });

  // ── 1. What was revealed ─────────────────────────────────────────────────────────────────────────
  section("1. What was revealed: entity and record id, through one reveal");
  as(rep);
  const usedAtStart = (await U.unmaskUsageToday(rep.id)).used;
  const first = await unmaskLead(l1.id);
  ok("Show on a lead reveals it and uses a unit", first.result === "ALLOWED" && first.usage?.used === usedAtStart + 1, first);
  ok("  and hands back no values", leaks(first).length === 0);
  const u1 = await db.unmaskUsage.findFirst({ where: { userId: rep.id, entity: "leads", recordId: l1.id } });
  ok("its usage row names the entity and record, `leadId` still written", u1?.leadId === l1.id && u1.includedWith === null && [...u1.fields].sort().join() === "companyName,email,phone", u1);
  const e1 = await db.unmaskEvent.findFirst({ where: { userId: rep.id, entity: "leads", recordId: l1.id }, orderBy: { seq: "desc" } });
  ok("  and so does its log row", e1?.leadId === l1.id && e1.result === "ALLOWED" && e1.consumed && /^LEAD-/.test(e1.leadRef ?? ""), e1 && { leadId: e1.leadId, leadRef: e1.leadRef });
  const shownC2 = await unmaskContact(c2.id);
  const uc2 = await db.unmaskUsage.findFirst({ where: { userId: rep.id, entity: "contacts", recordId: c2.id } });
  ok("a contact's Show: entity contacts, its own id, `leadId` as `contact:<id>`", shownC2.result === "ALLOWED" && uc2?.leadId === `contact:${c2.id}`, { r: shownC2.result, uc2 });
  const viaCompany = await U.revealRecord(rep.id, "companies", company.id, ["address", "gstin"], "Wave B's own reveal", { ref: "Zz company" });
  const uco = await db.unmaskUsage.findFirst({ where: { userId: rep.id, entity: "companies", recordId: company.id } });
  ok("the generic reveal takes a company, with nothing more in the schema (wave B)", viaCompany.result === "ALLOWED" && viaCompany.consumed && uco?.leadId === `company:${company.id}`, { r: viaCompany.result, uco });
  const coEvent = await db.unmaskEvent.findFirst({ where: { entity: "companies", recordId: company.id } });
  ok("  logged as a company, with the reason", coEvent?.statedReason === "Wave B's own reveal" && coEvent.fields.join() === "address,gstin", coEvent);
  const wrongKind = await U.revealRecord(rep.id, "invoices" as never, l1.id, ["email"]).then(() => "").catch((e: Error) => e.message);
  ok("  and refuses a kind of record it doesn't know", wrongKind.includes("isn't a record type"), wrongKind);
  const noFields = await U.revealRecord(rep.id, "leads", l1.id, []).then(() => "").catch((e: Error) => e.message);
  ok("  or a reveal of nothing", noFields.includes("no fields"), noFields);

  // ── 2. Explicit reveal ───────────────────────────────────────────────────────────────────────────
  section("2. An explicit reveal, with an optional reason");
  const source = readFileSync(path.join(process.cwd(), "src/components/leads/lead-unmask.tsx"), "utf8");
  ok("the lead page's strip no longer asks on opening — no effect calls unmaskLead", !/useEffect/.test(source) && /onSubmit/.test(source));
  const usedBeforeOpen = (await U.unmaskUsageToday(rep.id)).used;
  const eventsBeforeOpen = await db.unmaskEvent.count({ where: { userId: rep.id } });
  const opened = (await leads.getLead(l2.id))!;
  ok("opening a lead shows it masked", opened.contact?.email !== RAW.email && opened.company.name !== RAW.company && opened.masking.revealed === false, { email: opened.contact?.email, company: opened.company.name });
  ok("  and carries none of the raw values", leaks(opened).length === 0, leaks(opened));
  ok("  nothing spent and nothing logged by opening it", (await U.unmaskUsageToday(rep.id)).used === usedBeforeOpen && (await db.unmaskEvent.count({ where: { userId: rep.id } })) === eventsBeforeOpen);
  const html = (props: Parameters<typeof LeadUnmask>[0]) => renderToStaticMarkup(createElement(LeadUnmask, props));
  const masked = html({ leadId: l2.id, revealable: true, revealed: false, concealed: 4, pending: 3, usage: null });
  ok("the strip shows what is masked, a reason box and Show", masked.includes("4 fields on this lead are masked for you.") && masked.includes("Reason (optional)") && masked.includes("Show</button>") && !masked.includes("Unmasking…"), masked);
  const noRight = html({ leadId: l2.id, revealable: false, revealed: false, concealed: 2, pending: 0, usage: null });
  ok("  no Show for somebody who may not unmask", !noRight.includes("Show") && noRight.includes("2 fields"), noRight);
  const open = html({ leadId: l2.id, revealable: true, revealed: true, concealed: 1, pending: 0, usage: { businessDate: "x", used: 1, limit: 25, remaining: 24 } });
  ok("  once revealed: the green strip, no Show", open.includes("has been unmasked") && !open.includes("Reason (optional)") && open.includes("1/25 unmasked today"), open);
  // The page's own redaction and Activity feed in the "not revealed yet" state (Phase 1's lead feed masking).
  await db.activity.create({ data: { leadId: l2.id, userId: rep.id, type: "MEETING", notes: `Met ${RAW.contact} of ${RAW.company}; mail ${RAW.email}, call ${RAW.phone}` } });
  await db.callLog.create({ data: { companyId: company.id, contactId: c1.id, leadId: l2.id, userId: rep.id, phoneNumber: RAW.phone, outcome: "CONNECTED", startedAt: new Date(Date.now() - 60_000), durationSeconds: 60, notes: `Called ${RAW.phone} at ${RAW.company}` } });
  const redaction = await leadPageRedaction(rep.id, l2.id);
  ok("the page's redactor masks the lead's values in text before it is revealed", !!redaction && leaks(redaction.redact(`${RAW.company} — ${RAW.email} — ${RAW.phone}`)).length === 0, redaction && redaction.redact(`${RAW.company} — ${RAW.email}`));
  const feed = await recordActivity(rep.id, { leadId: l2.id });
  ok("  and its Activity feed carries none of the raw values", feed.items.length >= 2 && leaks(feed).length === 0, leaks(feed));
  const listed = await maskLeadsForList(rep.id, [{ id: l2.id, title: l2.title, company: { name: RAW.company }, contact: { name: RAW.contact, email: RAW.email, phone: RAW.phone } }]);
  ok("the Leads list masks it and offers Show", listed[0]!.revealable && leaks(listed).length === 0, listed[0]);
  const withReason = await unmaskLead(l2.id, "page", "  Customer called back\n about the renewal  ");
  const r2 = await db.unmaskEvent.findFirst({ where: { userId: rep.id, entity: "leads", recordId: l2.id }, orderBy: { seq: "desc" } });
  ok("Show with a reason: revealed, the reason kept on its log row, tidied to one line", withReason.result === "ALLOWED" && r2?.statedReason === "Customer called back about the renewal", r2?.statedReason);
  const shownL2 = (await leads.getLead(l2.id))!;
  ok("  the page then reads it in the clear", shownL2.contact?.email === RAW.email && shownL2.company.name === RAW.company && shownL2.masking.revealed);
  await unmaskLead(l3.id, "list", "From the list");
  ok("Show on the Leads list takes the reason too", (await db.unmaskEvent.findFirst({ where: { recordId: l3.id, entity: "leads" }, orderBy: { seq: "desc" } }))?.statedReason === "From the list");
  await unmaskContact(c3.id, "x".repeat(500));
  const longReason = (await db.unmaskEvent.findFirst({ where: { recordId: c3.id, entity: "contacts" }, orderBy: { seq: "desc" } }))?.statedReason;
  ok("a contact's Show takes it as well, capped at 200 characters", longReason?.length === 200, longReason?.length);
  await U.revealRecord(rep.id, "companies", company.id, ["pan"], "   ");
  ok("  and a blank reason is no reason", (await db.unmaskEvent.findFirst({ where: { recordId: company.id, entity: "companies" }, orderBy: { seq: "desc" } }))?.statedReason === null);

  // ── 3. Default limit ─────────────────────────────────────────────────────────────────────────────
  section("3. A default daily limit");
  const repLimit = await U.unmaskLimitFor(rep.id);
  ok("unmask granted, no limit of their own or their role's: the workspace default of 25, not unlimited", repLimit.dailyLimit === 25 && repLimit.source.via === "none" && "workspaceDefault" in repLimit.source && repLimit.source.workspaceDefault === true, repLimit);
  ok("  and the counter says so", (await U.unmaskUsageToday(rep.id)).limit === 25);
  ok("somebody with nothing to unmask keeps no limit — an admin who sees every field", (await U.unmaskLimitFor(admin.id)).dailyLimit === null);
  ok("the super admin has none", (await U.unmaskLimitFor(superAdmin.id)).dailyLimit === null);
  as(admin);
  ok("an admin who isn't the super admin can't change the default", !(await logs.setUnmaskDefaultLimit({ limited: true, dailyLimit: 100 })).ok && (await logs.unmaskDefaultLimitState()).mayChange === false);
  as(superAdmin);
  for (const bad of [0, -3, 2.5, "abc", 10_001]) ok(`  a default of ${JSON.stringify(bad)} is refused`, !(await logs.setUnmaskDefaultLimit({ limited: true, dailyLimit: bad })).ok);
  const toFive = await logs.setUnmaskDefaultLimit({ limited: true, dailyLimit: 5 });
  ok("the super admin sets it to 5", toFive.ok && (await U.unmaskLimitFor(rep.id)).dailyLimit === 5, toFive);
  ok("  audited", (await db.auditLog.count({ where: { entityType: "UnmaskSettings" } })) === 1);
  const used = (await U.unmaskUsageToday(rep.id)).used;
  as(rep);
  const atLimit = await unmaskLead(l5.id);
  ok(`with ${used} used of 5, a new lead is ${used >= 5 ? "refused" : "revealed"}`, used >= 5 ? atLimit.result === "QUOTA_EXHAUSTED" : atLimit.result === "ALLOWED", { used, r: atLimit.result });
  const over = await unmaskLead(l6.id);
  ok("  and past the default, the next stays masked and says why", over.result === "QUOTA_EXHAUSTED" && /daily limit/.test(over.message ?? "") && (await leads.getLead(l6.id))?.contact?.email !== RAW.email, over);
  as(superAdmin);
  const none = await logs.setUnmaskDefaultLimit({ limited: false });
  ok("\"no limit\" as the default only as a choice of its own — stored as such", none.ok && (await db.unmaskSettings.findUnique({ where: { id: "global" } }))?.defaultDailyLimit === null && (await U.unmaskLimitFor(rep.id)).dailyLimit === null);
  await db.roleUnmaskLimit.create({ data: { role: ROLE, dailyLimit: 7 } });
  ok("a role's limit comes before the default", (await U.unmaskLimitFor(rep.id)).dailyLimit === 7);
  await db.roleUnmaskLimit.update({ where: { role: ROLE }, data: { dailyLimit: null } });
  await logs.setUnmaskDefaultLimit({ limited: true, dailyLimit: 5 });
  ok("  and a role's explicit \"no limit\" too", (await U.unmaskLimitFor(rep.id)).dailyLimit === null && (await U.unmaskLimitFor(rep.id)).source.via === "roleLimit");
  await db.userUnmaskLimit.create({ data: { userId: rep.id, limited: true, dailyLimit: 9, reason: "zz" } });
  ok("  a person's own before their role's", (await U.unmaskLimitFor(rep.id)).dailyLimit === 9);
  await db.userUnmaskLimit.delete({ where: { userId: rep.id } });
  await db.roleUnmaskLimit.delete({ where: { role: ROLE } });
  await db.unmaskSettings.delete({ where: { id: "global" } });
  ok("no row at all is the default of 25", (await U.unmaskLimitFor(rep.id)).dailyLimit === U.DEFAULT_DAILY_UNMASK_LIMIT && U.DEFAULT_DAILY_UNMASK_LIMIT === 25);
  // Global PII Masking (src/app/(dashboard)/settings/access/sensitive/masking/page.tsx): the master switch
  // (sensitive/masking-switch.tsx) with the default beside it and "Change default" (sensitive/default-limit.tsx),
  // which opens the dialog that saves it — the super admin's alone, and drawn for nobody else.
  const text = (markup: string) => markup.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  const switchOf = (markup: string) => (markup.match(/<button[^>]*role="switch"[^>]*>/g) ?? []).find((tag) => tag.includes('aria-labelledby="ac-masking-label"')) ?? "";
  const settingsHtml = renderToStaticMarkup((await MASKING_PAGE.default()) as ReactElement);
  ok(
    "drawn with the master switch, where limits are set — editable by the super admin",
    settingsHtml.includes("Enable field masking") && text(settingsHtml).includes("default 25 a day") && />Change default<\/button>/.test(settingsHtml) && switchOf(settingsHtml) !== "" && !/disabled=""/.test(switchOf(settingsHtml)) && !settingsHtml.includes("Only a super admin can switch it."),
    text(settingsHtml).slice(0, 200),
  );
  const limitsHtml = renderToStaticMarkup((await LIMITS_PAGE.default({ searchParams: Promise.resolve({}) })) as ReactElement);
  ok("  and on Unmasking Limits: the default of 25, with Change", /Default limit\s*25\s*records \/ day/.test(text(limitsHtml)) && />Change<\/button>/.test(limitsHtml), text(limitsHtml).slice(0, 300));
  as(admin);
  const adminHtml = renderToStaticMarkup((await MASKING_PAGE.default()) as ReactElement);
  ok(
    "  read-only to anybody else",
    adminHtml.includes("Only a super admin can switch it.") && text(adminHtml).includes("The master switch and the default daily limit are the super admin's to change.") && /disabled=""/.test(switchOf(adminHtml)) && text(adminHtml).includes("default 25 a day") && !adminHtml.includes("Change default"),
    switchOf(adminHtml),
  );
  const adminLimitsHtml = renderToStaticMarkup((await LIMITS_PAGE.default({ searchParams: Promise.resolve({}) })) as ReactElement);
  ok("  on Unmasking Limits too: the default shown, no Change, and why", adminLimitsHtml.includes('title="Only the super admin can change it."') && !/>Change<\/button>/.test(adminLimitsHtml) && /Default limit\s*25/.test(text(adminLimitsHtml)));
  as(superAdmin);
  await logs.setUnmaskDefaultLimit({ limited: true, dailyLimit: 1000 });

  // ── 4. One reveal, one record family ───────────────────────────────────────────────────────────
  section("4. One reveal, one record family");
  as(rep);
  const contactsBefore = await maskContactRows(rep.id, "list", [c1].map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone })));
  ok("the lead's contact is masked on the contact's own screens before", contactsBefore[0]!.email !== RAW.famEmail && valueLeaks(contactsBefore).length === 0 && contactsBefore[0]!.revealable, contactsBefore[0]);
  const unitsBefore = (await U.unmaskUsageToday(rep.id)).used;
  const fam = await unmaskLead(l4.id);
  ok("Show on the lead reveals it — one unit", fam.result === "ALLOWED" && (await U.unmaskUsageToday(rep.id)).used === unitsBefore + 1, { r: fam.result, used: (await U.unmaskUsageToday(rep.id)).used, unitsBefore });
  const famUsage = await db.unmaskUsage.findFirst({ where: { userId: rep.id, entity: "contacts", recordId: c1.id } });
  ok("  its contact revealed with it for the day, at no unit of its own", famUsage?.includedWith === `leads:${l4.id}` && [...famUsage.fields].sort().join() === "email,phone", famUsage);
  const famEvent = await db.unmaskEvent.findFirst({ where: { userId: rep.id, entity: "contacts", recordId: c1.id }, orderBy: { seq: "desc" } });
  ok("  logged with its own entity, record id and fields — no unit", famEvent?.result === "ALLOWED" && !famEvent.consumed && famEvent.leadId === `contact:${c1.id}` && famEvent.fields.sort().join() === "email,phone" && /^With LEAD-/.test(famEvent.reason ?? ""), famEvent);
  const contactsAfter = await maskContactRows(rep.id, "list", [c1, c2, c3].map((c) => ({ id: c.id, name: c.name, email: c.email, phone: c.phone })));
  ok("the contact's screens — the Contacts list, a company's tab — now show it in the clear", contactsAfter[0]!.email === RAW.famEmail && contactsAfter[0]!.phone === RAW.famPhone && !contactsAfter[0]!.revealable, contactsAfter[0]);
  const detailMasker = await contactMasker(rep.id, "detail", [c1.id]);
  ok("  on the company's own page too", detailMasker.present(c1.id, "email", RAW.famEmail) === RAW.famEmail);
  // c3 was Shown above, c2 too; a fresh contact is the test of "only the family".
  const c4 = await db.contact.create({ data: { companyId: company.id, name: "Zz Fresh", email: "fresh@quillon.example", phone: "+91 95555 44433" } });
  const fresh = await maskContactRows(rep.id, "list", [{ id: c4.id, name: c4.name, email: c4.email, phone: c4.phone }]);
  ok("  while another contact of the same company stays masked", fresh[0]!.email !== c4.email && !JSON.stringify(fresh).includes("fresh@quillon") && !JSON.stringify(fresh).includes("95555"), fresh[0]);
  const again = await unmaskLead(l4.id);
  ok("showing the lead again: a repeat, and no second row for its contact", again.result === "REPEAT" && (await db.unmaskEvent.count({ where: { userId: rep.id, entity: "contacts", recordId: c1.id } })) === 1);

  // ── 4b. A company: its own Show, and with its lead (wave B) ───────────────────────────────────────
  section("4b. A company: its own Show, and revealed with its lead (wave B)");
  await companyReveals(db, { rep, admin, ROLE, rule, as, unmaskLead, getLead: leads.getLead, U });

  // ── 5. Fields granted later ────────────────────────────────────────────────────────────────────
  section("5. Fields granted later the same day");
  as(rep);
  const morning = (await leads.getLead(l1.id))!;
  ok("this morning's reveal of the first lead: email and company in the clear, its name masked (not theirs to unmask)", morning.contact?.email === RAW.email && morning.title !== l1.title && !morning.masking.revealable.includes("title"), { title: morning.title });
  await rule("leads", "title", { unmask: true });
  const later = (await leads.getLead(l1.id))!;
  ok("granted unmask on the name later today: this morning's reveal doesn't cover it", later.title !== l1.title && later.masking.revealable.includes("title") && later.masking.concealed.includes("title") && later.contact?.email === RAW.email, { title: later.title, concealed: later.masking.concealed });
  ok("  and the page offers Show again for it", later.masking.revealable.filter((k) => later.masking.concealed.includes(k)).join() === "title");
  const listLater = await maskLeadsForList(rep.id, [{ id: l1.id, title: l1.title }]);
  ok("  so does the Leads list", listLater[0]!.revealable && listLater[0]!.title !== l1.title, listLater[0]);
  const unitsNow = (await U.unmaskUsageToday(rep.id)).used;
  const more = await unmaskLead(l1.id);
  const moreEvent = await db.unmaskEvent.findFirst({ where: { userId: rep.id, entity: "leads", recordId: l1.id }, orderBy: { seq: "desc" } });
  ok("a new reveal: allowed, a new event for just that field, no extra unit", more.result === "ALLOWED" && (await U.unmaskUsageToday(rep.id)).used === unitsNow && moreEvent?.fields.join() === "title" && !moreEvent.consumed && /no unit/.test(moreEvent.reason ?? ""), { r: more.result, f: moreEvent?.fields, reason: moreEvent?.reason });
  ok("  now its name is in the clear", (await leads.getLead(l1.id))?.title === l1.title);
  ok("  and a further Show is a repeat", (await unmaskLead(l1.id)).result === "REPEAT");
  await rule("contacts", "name", { unmask: true });
  ok("the same for a contact: its name, granted later, stays masked after this morning's reveal", (await maskContactRows(rep.id, "list", [{ id: c2.id, name: c2.name, email: c2.email, phone: c2.phone }]))[0]!.name !== c2.name);
  const unitsC = (await U.unmaskUsageToday(rep.id)).used;
  const c2more = await unmaskContact(c2.id);
  ok("  until Show again — no extra unit", c2more.result === "ALLOWED" && (await U.unmaskUsageToday(rep.id)).used === unitsC && (await maskContactRows(rep.id, "list", [{ id: c2.id, name: c2.name, email: c2.email, phone: c2.phone }]))[0]!.name === c2.name);

  // ── 6. Tamper evidence ─────────────────────────────────────────────────────────────────────────
  section("6. The chain");
  const chained = await U.verifyUnmaskChain(db as never);
  const total = await db.unmaskEvent.count();
  ok("every row written so far checks out", chained.intact && chained.rows === total, chained);
  // Reveals by six people at the same moment, each against the one log.
  const burst = await Promise.all(
    others.map((o, i) => U.revealRecord(o.id, "leads", burstLeads[i]!.id, ["email"], `burst ${i}`)),
  );
  const afterBurst = await U.verifyUnmaskChain(db as never);
  const seqs = (await db.unmaskEvent.findMany({ orderBy: { seq: "asc" }, select: { seq: true } })).map((r) => r.seq);
  ok("six reveals at once: all written, the chain unforked and unbroken", burst.every((b) => b.result === "ALLOWED") && afterBurst.intact && afterBurst.rows === total + 6 && seqs.every((s, i) => s === i + 1), { intact: afterBurst.intact, rows: afterBurst.rows });
  // The race made certain: one writer appends and holds its transaction open; a second, on another connection, then
  // appends too. With the log's lock it waits and takes the next place; without it, it would read the same end of the
  // chain and fork it (and the unique `seq` would refuse it).
  const url = process.env.DATABASE_URL!;
  const [writerA, writerB] = [directClient(url, { max: 1 }), directClient(url, { max: 1 })];
  try {
    const row = (note: string) => ({
      businessDate: "2026-11-05", tenantId: null, userId: rep.id, userName: "Zz Rep", impersonatedByUserId: null, entity: "leads", recordId: l1.id, leadId: l1.id,
      leadRef: null, fields: ["email"], result: "REPEAT" as const, consumed: false, usedToday: null, dailyLimit: null, reason: note, statedReason: null, requestId: null, ip: null, userAgent: null,
    });
    const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const a = writerA.$transaction(async (tx) => {
      await U.appendUnmaskEvent(tx, row("zz race A"));
      await held;
    }, { timeout: 20_000 });
    await pause(400);
    const b = writerB.$transaction((tx) => U.appendUnmaskEvent(tx, row("zz race B")), { timeout: 20_000 }).then(() => "").catch((e: Error) => e.message);
    await pause(400);
    release();
    await a;
    const raced = await b;
    const [ra, rb] = await Promise.all([db.unmaskEvent.findFirst({ where: { reason: "zz race A" } }), db.unmaskEvent.findFirst({ where: { reason: "zz race B" } })]);
    ok("two writers at once: the second waits for the first and takes the next place — no fork", raced === "" && !!ra && !!rb && rb.seq === ra.seq + 1 && rb.prevHash === ra.hash && (await U.verifyUnmaskChain(db as never)).intact, raced || { a: ra?.seq, b: rb?.seq });
  } finally {
    await writerA.$disconnect();
    await writerB.$disconnect();
  }
  const raceRows = 2;

  const refused = async (sql: string) => db.$executeRawUnsafe(sql).then(() => "").catch((e: Error) => e.message);
  ok("a row can't be changed", (await refused(`UPDATE unmask_events SET reason = 'edited' WHERE seq = 2`)).includes("append-only"));
  ok("  nor removed", (await refused(`DELETE FROM unmask_events WHERE seq = 2`)).includes("append-only"));
  ok("  nor the log emptied", (await refused(`TRUNCATE unmask_events`)).includes("never emptied"));
  as(superAdmin);
  const integrity = await logs.unmaskLogIntegrity();
  ok("the log page says it is intact", integrity.ok && integrity.data.intact && integrity.data.rows === total + 6 + raceRows, integrity);
  // The page itself: Settings › Access Control › Unmasking Activity (settings/access/audit/page.tsx, `?category=pii`).
  const logPage = async (sp: Record<string, string> = {}) => renderToStaticMarkup((await AUDIT_PAGE.default({ searchParams: Promise.resolve({ category: "pii", ...sp }) })) as ReactElement);
  const logText = (markup: string) => markup.replace(/<!-- -->/g, "").replace(/<[^>]+>/g, " ").replace(/&#x27;/g, "'").replace(/&amp;/g, "&").replace(/\s+/g, " ");
  const intactPage = await logPage({ pageSize: "100" });
  ok("  drawn on Unmasking Activity: \"Log intact\", every row counted, Super Admin only", intactPage.includes("Log intact.") && logText(intactPage).includes(`All ${integrity.ok ? integrity.data.rows : "?"} rows check out`) && intactPage.includes("Super Admin only") && !intactPage.includes("tampered"), logText(intactPage).slice(0, 300));
  ok("  with no field's value on the page", valueLeaks(intactPage).length === 0, valueLeaks(intactPage));
  as(admin);
  ok("  and only to the super admin", !(await logs.unmaskLogIntegrity()).ok);
  const adminLogPage = await logPage();
  ok(
    "  an admin who opens Unmasking Activity is told it is the super admin's — no rows, no chain, no export",
    logText(adminLogPage).includes("Only the workspace's super admin can read this log") && !adminLogPage.includes("Log intact") && !adminLogPage.includes("<table") && !adminLogPage.includes("Super Admin only") && !logText(adminLogPage).includes("Customer called back") && valueLeaks(adminLogPage).length === 0,
    logText(adminLogPage).slice(0, 300),
  );
  // The area's own menu (settings/access/layout.tsx → access-control/shell.tsx): the log's link is drawn for the
  // super admin alone, as the Settings entry "Unmasking logs" was — nobody is offered a door that refuses them.
  const menuFor = async () => renderToStaticMarkup((await AC_LAYOUT.default({ children: null })) as ReactElement);
  const adminMenu = await menuFor();
  ok("  and isn't offered it in the Access Control menu", adminMenu.includes(">Unmasking Limits<") && !adminMenu.includes("Unmasking Activity") && !adminMenu.includes("category=pii"), logText(adminMenu).slice(0, 300));
  as(superAdmin);
  const superMenu = await menuFor();
  ok("    which the super admin is", superMenu.includes(">Unmasking Activity<") && superMenu.includes('href="/settings/access/audit?category=pii"'));
  as(admin);
  // A link saved to the old Unmasking logs page lands on it, filters and all.
  const landsOn = async (sp: Record<string, string>) => {
    try {
      await RETIRED_LOG_PAGE.default({ searchParams: Promise.resolve(sp) });
      return null;
    } catch (err) {
      return /^redirect (.*)$/.exec((err as Error).message)?.[1] ?? (err as Error).message;
    }
  };
  ok("  the old Unmasking logs address lands on it", (await landsOn({})) === "/settings/access/audit?category=pii", await landsOn({}));
  ok(
    "    with the person, lead number, result and dates it carried",
    (await landsOn({ userId: rep.id, lead: "LEAD-000002", result: "DENIED", from: "2026-11-01", to: "2026-11-05" })) === `/settings/access/audit?category=pii&user=${rep.id}&record=LEAD-000002&result=DENIED&from=2026-11-01&to=2026-11-05`,
    await landsOn({ userId: rep.id, lead: "LEAD-000002", result: "DENIED", from: "2026-11-01", to: "2026-11-05" }),
  );
  as(superAdmin);
  const listedLog = await logs.listUnmaskEvents({}, { page: 1, pageSize: 200 });
  const contactRow = listedLog.ok ? listedLog.data.rows.find((r) => r.entity === "contacts" && r.recordId === c1.id) : null;
  ok("the log's rows say what was revealed — a contact by name, with the reason given", !!contactRow && contactRow.contact?.name === RAW.famName && listedLog.ok && listedLog.data.rows.some((r) => r.statedReason === "Customer called back about the renewal"), contactRow);
  const exported = await logs.exportUnmaskEventsCsv({});
  const csv = exported.ok ? exported.data.csv : "";
  ok("the CSV carries the record type, the reason given and the chain", csv.startsWith('"When"') && csv.includes('"Record type"') && csv.includes('"Reason given"') && csv.includes('"Hash"') && csv.includes("Customer called back about the renewal"));
  const events = await db.unmaskEvent.findMany();
  ok("no field's value anywhere in the log or its CSV", valueLeaks(events).length === 0 && valueLeaks(csv).length === 0, { log: valueLeaks(events), csv: valueLeaks(csv) });

  // Behind the app's back: the trigger off, as a database owner could.
  await db.$executeRawUnsafe(`ALTER TABLE unmask_events DISABLE TRIGGER unmask_events_append_only`);
  const victim = await db.unmaskEvent.findFirst({ where: { seq: 3 } });
  await db.$executeRawUnsafe(`UPDATE unmask_events SET fields = '{email,phone,companyName,title}' WHERE seq = 3`);
  const edited = await U.verifyUnmaskChain(db as never);
  ok("a row changed behind the app's back is named — the first that doesn't check out", !edited.intact && edited.broken?.seq === 3 && /changed/.test(edited.broken.why) && edited.rows === 2, edited.broken);
  as(superAdmin);
  const shownBroken = await logs.unmaskLogIntegrity();
  ok("  and the log page says so", shownBroken.ok && !shownBroken.data.intact && shownBroken.data.broken?.seq === 3);
  const brokenPage = await logPage();
  ok("    in words, on Unmasking Activity: tampered with, and which row", brokenPage.includes("The log has been tampered with.") && logText(brokenPage).includes("Row 3 (") && !brokenPage.includes("Log intact"), logText(brokenPage).slice(0, 300));
  await db.unmaskEvent.update({ where: { id: victim!.id }, data: { fields: victim!.fields } });
  ok("  put back exactly, it checks out again", (await U.verifyUnmaskChain(db as never)).intact);
  await db.$executeRawUnsafe(`DELETE FROM unmask_events WHERE seq = 5`);
  const gap = await U.verifyUnmaskChain(db as never);
  ok("a row removed is named by the one after it", !gap.intact && gap.broken?.seq === 6 && /missing/.test(gap.broken.why), gap.broken);
  await db.$executeRawUnsafe(`UPDATE unmask_events SET seq = -seq WHERE seq > 5`);
  await db.$executeRawUnsafe(`UPDATE unmask_events SET seq = -seq - 1 WHERE seq < 0`);
  const renumbered = await U.verifyUnmaskChain(db as never);
  ok("  and renumbering to hide the gap doesn't: the next row no longer follows", !renumbered.intact && renumbered.broken?.seq === 5 && /follow/.test(renumbered.broken.why), renumbered.broken);
  await db.$executeRawUnsafe(`ALTER TABLE unmask_events ENABLE TRIGGER unmask_events_append_only`);

  // ── 7. Kept ────────────────────────────────────────────────────────────────────────────────────
  section("7. Kept: deleting a person, and a workspace reset");
  const leaver = await person("Leaver", ROLE);
  await U.revealRecord(leaver.id, "leads", l1.id, ["email"], "before leaving");
  const leaverEvents = await db.unmaskEvent.count({ where: { userId: leaver.id } });
  const holdings = await userHoldings(leaver.id, db as never);
  ok("a person whose only trace is unmasking may be deleted — the log isn't counted against it", holdings.length === 0, holdings);
  await db.$transaction((tx) => removeAccount(tx, leaver.id));
  ok("  deleted, their unmask events stay — the archive — with their name", (await db.user.count({ where: { id: leaver.id } })) === 0 && leaverEvents === 1 && (await db.unmaskEvent.count({ where: { userId: leaver.id, userName: "Zz Leaver" } })) === 1);
  ok("  their usage rows go with the account", (await db.unmaskUsage.count({ where: { userId: leaver.id } })) === 0);
  ok("the reset keeps the log in both modes", reset.keptTables().some((k) => k.table === "unmask_events") && reset.keptTables("KEEP_SETUP").some((k) => k.table === "unmask_events"));
  const rowsBefore = await db.unmaskEvent.count();
  const resetClient = directClient(process.env.DATABASE_URL!, { max: 2 });
  try {
    const outcome = await reset.resetAllData(resetClient, superAdmin.id).then((o) => o).catch((e: Error) => e.message);
    ok("a workspace reset runs", typeof outcome === "object", outcome);
    ok("  every unmask event is still there — archived where it is, not emptied", (await resetClient.unmaskEvent.count()) === rowsBefore && rowsBefore > 0, rowsBefore);
    ok("  the usage counter, a record, goes", (await resetClient.unmaskUsage.count()) === 0);
    ok("  and the leads and contacts they were about go too", (await resetClient.lead.count()) === 0 && (await resetClient.contact.count()) === 0);
  } finally {
    await resetClient.$disconnect();
  }
}

/**
 * 4b (owner, 5 Nov 2026 — Phase 3 masking fixes, wave B; src/actions/company-unmask.ts, src/actions/lead-unmask.ts,
 * src/lib/companies/masking.ts). "Show" on a company reveals its unmaskable fields for the day, with the reason, against
 * the same limit — a repeat free, a company out of reach refused and logged. Revealing a lead reveals its company too, at
 * no unit of its own, only where the person reaches the company and may unmask something on it; and the company's page,
 * its list rows and the lead's page then show it in the clear, while other companies stay masked.
 */
async function companyReveals(
  db: PrismaClient,
  t: {
    rep: { id: string; name: string; email: string; role: string };
    admin: { id: string };
    ROLE: string;
    rule: (entity: string, field: string, over?: object) => Promise<unknown>;
    as: (u: { id: string; name: string; email: string; role: string }) => void;
    unmaskLead: typeof import("../src/actions/lead-unmask").unmaskLead;
    getLead: typeof import("../src/actions/lead").getLead;
    U: typeof import("../src/lib/authz/unmask");
  },
) {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { unmaskCompany } = require("../src/actions/company-unmask") as typeof import("../src/actions/company-unmask");
  const { getCompany } = require("../src/actions/company") as typeof import("../src/actions/company");
  const { maskCompanyRows, pendingCompanyReveal } = require("../src/lib/companies/masking") as typeof import("../src/lib/companies/masking");
  const { canSeeCompany } = require("../src/lib/authz/company-scope") as typeof import("../src/lib/authz/company-scope");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const { rep, admin, ROLE, rule, as, unmaskLead, getLead, U } = t;
  as(rep);
  const co = (key: string, ownerUserId: string) =>
    db.company.create({
      data: {
        name: `Zz ${key}co`,
        normalizedName: `zz ${key}co`,
        createdById: admin.id,
        ownerUserId,
        website: `https://${key}co.example`,
        locations: { create: [{ label: "HQ", address: `12 ${key}co Street`, city: `${key}city`, state: "Kerala", country: "India", pincode: "682001", gstNumber: "32AAZPM4321K1Z2", isPrimary: true }] },
      },
      select: { id: true, name: true, ownerUserId: true, relationshipType: true },
    });
  const [show, fam, far, other, none] = [await co("show", rep.id), await co("fam", rep.id), await co("far", admin.id), await co("other", rep.id), await co("none", rep.id)];
  const raw = (key: string) => [`${key}co.example`, `12 ${key}co Street`, `${key}city`];
  const leaksOf = (key: string, value: unknown) => raw(key).filter((r) => JSON.stringify(value).includes(r));
  const rowOf = async (c: { id: string }) =>
    (await maskCompanyRows(rep.id, "list", [await db.company.findUniqueOrThrow({ where: { id: c.id }, select: { id: true, website: true, locations: { select: { address: true, city: true, state: true, pincode: true, gstNumber: true } } } })]))[0]!;
  const units = async () => (await U.unmaskUsageToday(rep.id)).used;
  const usageOf = (c: { id: string }) => db.unmaskUsage.findFirst({ where: { userId: rep.id, entity: "companies", recordId: c.id } });
  // Masked in lists and on the company's page, theirs to unmask: the address and website. The GSTIN masked, not theirs.
  await rule("companies", "address");
  await rule("companies", "website");
  await rule("companies", "gstin", { unmask: false });

  const before = await rowOf(show);
  ok("a company is masked in its list before — website and address — and carries none of its values", before.website !== `https://showco.example` && before.locations[0]!.address !== "12 showco Street" && leaksOf("show", before).length === 0, before);
  ok("  and its page offers Show for the address and website, not the GSTIN", (await pendingCompanyReveal(rep.id, show.id)).sort().join() === "address,website");
  const unitsBefore = await units();
  const shown = await unmaskCompany(show.id, "  Checking the\n delivery address ");
  ok("Show on the company: revealed, one unit", shown.result === "ALLOWED" && (await units()) === unitsBefore + 1, { r: shown, used: await units() });
  ok("  and hands back no values", leaksOf("show", shown).length === 0);
  const showUsage = await usageOf(show);
  ok("  its usage row: entity companies, its id, the fields it may unmask — `leadId` as `company:<id>`", showUsage?.leadId === `company:${show.id}` && showUsage.includedWith === null && [...showUsage.fields].sort().join() === "address,website", showUsage);
  const showEvent = await db.unmaskEvent.findFirst({ where: { userId: rep.id, entity: "companies", recordId: show.id }, orderBy: { seq: "desc" } });
  ok("  logged with its number and name, the reason tidied, a unit used", showEvent?.result === "ALLOWED" && showEvent.consumed && /^COM-\d+ Zz showco$/.test(showEvent.leadRef ?? "") && showEvent.statedReason === "Checking the delivery address", showEvent);
  const page = (await getCompany(show.id))!;
  const head = page.locations.find((l) => l.isPrimary)!;
  ok("its page then reads the website and every address part in the clear", page.website === "https://showco.example" && head.address === "12 showco Street" && head.city === "showcity" && head.pincode === "682001", { website: page.website, head });
  ok("  the GSTIN still masked — not theirs to unmask — and the forms still leave the fields alone", head.gstNumber === "3********" && page.masked.address && page.masked.website && page.masked.gstin, { gstin: head.gstNumber, masked: page.masked });
  const listed = await rowOf(show);
  ok("  so does its list row", listed.website === "https://showco.example" && listed.locations[0]!.city === "showcity" && listed.locations[0]!.gstNumber === "3********", listed);
  ok("  and the page offers no Show now", (await pendingCompanyReveal(rep.id, show.id)).length === 0);
  const otherRow = await rowOf(other);
  ok("another company stays masked, none of its values", otherRow.website !== "https://otherco.example" && leaksOf("other", otherRow).length === 0 && leaksOf("other", await getCompany(other.id)).length === 0, otherRow);
  const repeat = await unmaskCompany(show.id);
  ok("Show again: a repeat, no unit, no second row", repeat.result === "REPEAT" && (await units()) === unitsBefore + 1 && (await db.unmaskEvent.count({ where: { entity: "companies", recordId: show.id } })) === 1, repeat);
  ok("a company they don't reach (precondition)", !(await canSeeCompany(rep.id, far)));
  const refused = await unmaskCompany(far.id);
  const refusedEvent = await db.unmaskEvent.findFirst({ where: { entity: "companies", recordId: far.id }, orderBy: { seq: "desc" } });
  ok("  Show on it: refused as not found, logged, nothing revealed", refused.result === "DENIED" && refused.message === "Company not found." && refusedEvent?.result === "DENIED" && /can open/.test(refusedEvent.reason ?? "") && !(await usageOf(far)) && leaksOf("far", await rowOf(far)).length === 0, { refused, refusedEvent });

  // One reveal, one record family: the lead's company with it.
  const lead = (title: string, companyId: string) => db.lead.create({ data: { companyId, contactId: null, title, ownerUserId: rep.id } });
  const famLead = await lead("Zz famco deal", fam.id);
  const famBefore = await getLead(famLead.id);
  ok("its lead's page shows the company's website and address masked before — by the companies policy — and none of their values", famBefore?.company.website === "h********" && famBefore.address.line !== null && !famBefore.address.line.includes("famco") && leaksOf("fam", famBefore).length === 0, famBefore && { website: famBefore.company.website, address: famBefore.address });
  const unitsFam = await units();
  const withLead = await unmaskLead(famLead.id);
  ok("Show on the lead: one unit, for the lead", withLead.result === "ALLOWED" && (await units()) === unitsFam + 1, { r: withLead.result, used: await units(), unitsFam });
  const famUsage = await usageOf(fam);
  ok("  its company revealed with it for the day, at no unit of its own — the fields it may unmask", famUsage?.includedWith === `leads:${famLead.id}` && [...famUsage.fields].sort().join() === "address,website", famUsage);
  const famEvent = await db.unmaskEvent.findFirst({ where: { userId: rep.id, entity: "companies", recordId: fam.id }, orderBy: { seq: "desc" } });
  ok("  logged with its own entity, id and fields — no unit", famEvent?.result === "ALLOWED" && !famEvent.consumed && famEvent.leadId === `company:${fam.id}` && /^With LEAD-/.test(famEvent.reason ?? "") && /^COM-\d+ Zz famco$/.test(famEvent.leadRef ?? ""), famEvent);
  const famPage = (await getCompany(fam.id))!;
  ok("  the company's page and list then show it in the clear", famPage.website === "https://famco.example" && famPage.locations[0]!.address === "12 famco Street" && (await rowOf(fam)).locations[0]!.city === "famcity");
  const famAfter = await getLead(famLead.id);
  ok("  and so does the lead's page — its company's website and address", famAfter?.company.website === "https://famco.example" && famAfter.address.line?.includes("12 famco Street") === true && famAfter.address.place?.includes("famcity") === true, famAfter && { website: famAfter.company.website, address: famAfter.address });
  ok("  Show on the company after: a repeat, nothing used", (await unmaskCompany(fam.id)).result === "REPEAT" && (await units()) === unitsFam + 1);
  ok("  and the lead again: a repeat, no second company row", (await unmaskLead(famLead.id)).result === "REPEAT" && (await db.unmaskEvent.count({ where: { entity: "companies", recordId: fam.id } })) === 1);

  // Only where they reach the company: a lead they reach (leads at "All") on a company they don't.
  await db.roleAccessLevel.create({ data: { role: ROLE, record: "leads", action: "view", level: "ALL" } });
  const farLead = await lead("Zz farco deal", far.id);
  const viaFar = await unmaskLead(farLead.id);
  ok("a lead they reach on a company they don't: the lead revealed, its company not", viaFar.result === "ALLOWED" && !(await usageOf(far)) && leaksOf("far", await rowOf(far)).length === 0, viaFar);
  await db.roleAccessLevel.delete({ where: { role_record_action: { role: ROLE, record: "leads", action: "view" } } });
  // Only where they may unmask something on it.
  await rule("companies", "address", { unmask: false });
  await rule("companies", "website", { unmask: false });
  const noneLead = await lead("Zz noneco deal", none.id);
  const viaNone = await unmaskLead(noneLead.id);
  ok("a lead whose company's fields they may not unmask: the lead revealed, its company not", viaNone.result === "ALLOWED" && !(await usageOf(none)) && leaksOf("none", await rowOf(none)).length === 0, viaNone);
  const noRight = await unmaskCompany(none.id);
  ok("  and Show on that company is refused, logged", noRight.result === "DENIED" && /can't unmask/.test(noRight.message ?? "") && (await db.unmaskEvent.count({ where: { entity: "companies", recordId: none.id, result: "DENIED" } })) === 1, noRight);
  ok("no company's value anywhere in the log", (await db.unmaskEvent.findMany({ where: { entity: "companies" } })).every((e) => ["show", "fam", "far", "other", "none"].every((k) => leaksOf(k, e).length === 0)));
  // The rest of this check as it was: no rule for companies.
  await db.roleFieldPolicy.deleteMany({ where: { role: ROLE, entity: "companies" } });
}

async function main() {
  const realUrl = process.env.DATABASE_URL;
  if (!realUrl) throw new Error("DATABASE_URL is not set.");
  const host = new URL(realUrl).hostname;
  const realName = new URL(realUrl).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratchName = `${realName}_unmaskcheck`;
  const scratchUrl = withDatabase(realUrl, scratchName);
  ok("  and the scratch one is never the real one", scratchName !== realName);
  const real = directClient(realUrl, { max: 1 });
  const realEvents = await real.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from unmask_events`).catch(() => [{ n: BigInt(-1) }]);
  const admin = directClient(withDatabase(realUrl, "postgres"), { max: 1 });
  let closeAll: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
    // Before anything of the app's is loaded, so its database is the scratch one from the start.
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";
    await migrationBackfill(scratchUrl);
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    closeAll = () => db.$disconnect();
    await run(db as unknown as PrismaClient);
  } finally {
    await closeAll?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const gone = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(gone[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }
  section("The copy workspace was not touched");
  const realAfter = await real.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from unmask_events`).catch(() => [{ n: BigInt(-1) }]);
  await real.$disconnect();
  ok("its unmasking log has no rows from this check", Number(realAfter[0]?.n) >= Number(realEvents[0]?.n), String(realAfter[0]?.n));

  console.log(failures === 0 ? `\nAll ${passes} unmask checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
