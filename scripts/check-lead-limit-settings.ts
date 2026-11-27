/**
 * check:lead-limit-settings — setting lead limits, telling the managers about overflow, and the backstop's switch
 * (owner, 12 Nov 2026 — Phase 4 lead limits, audit H.6.5; src/actions/lead-limits.ts, src/lib/leads/overflow-notify.ts,
 * src/actions/lead-assignment.ts).
 *
 *   1. A role's limits: who may set them (as the daily unmask limit — permissions.manage or the super admin; Admin's only
 *      by the super admin; support's read-only role never), what a number may be, all blank taking the row away, each
 *      change in the permission history and an unchanged save not.
 *   2. A person's: their own over the role's, "no limit for them", back to the role's; a reason, an end date (and none
 *      already past); nobody changes their own; the super admin has none to set; who may read it, with their usage.
 *   3. Telling the managers: whoever holds leads.assign or accounts.reassign, nobody else, nobody switched off; one
 *      notification for a burst, counted up while unread; ten at the same moment on separate connections still one;
 *      read, and the next is new; somebody who muted it batched too; createLead's overflow tells them.
 *   4. A rule's overflow mode: saved, listed, SKIP by default, nothing else accepted; Test a lead says what would happen.
 *   5. The backstop's switch: the super admin's alone, audited, and its latest warnings listed with the path that wrote
 *      them; "enforce" then refuses such a write.
 *   6. The new action file is registered as core.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:lead-limit-settings
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { directClient } from "../src/lib/tenancy/direct-client";

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

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("../src/lib/session"), session],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

async function main() {
  section("6. The action file is registered");
  const { ACTION_MODULES } = load("../src/lib/module-actions") as typeof import("../src/lib/module-actions");
  ok("src/actions/lead-limits.ts is core, as access-levels.ts is", ACTION_MODULES["lead-limits.ts"] === "core" && ACTION_MODULES["access-levels.ts"] === "core", ACTION_MODULES["lead-limits.ts"]);

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_leadlimitsettings`;
  const scratchUrl = withDatabase(url, scratch);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";
    // Real concurrency: each transaction on a connection of its own.
    process.env.TENANCY_CONNECTION_LIMIT = "40";
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const settings = require("../src/actions/lead-limits") as typeof import("../src/actions/lead-limits");
    const assignment = require("../src/actions/lead-assignment") as typeof import("../src/actions/lead-assignment");
    const leadActions = require("../src/actions/lead") as typeof import("../src/actions/lead");
    const limits = require("../src/lib/leads/limits") as typeof import("../src/lib/leads/limits");
    const overflow = require("../src/lib/leads/overflow-notify") as typeof import("../src/lib/leads/overflow-notify");
    const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
    const { formatLeadId } = require("../src/lib/order-id") as typeof import("../src/lib/order-id");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const person = (name: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-limitset.in`, passwordHash: "!", role: "SALES", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const as = (u: { id: string; name: string; email: string | null; role: string }) => {
      actor = { id: u.id, name: u.name, email: u.email!, role: u.role };
    };
    const boss = await person("Zz Boss", { role: "ADMIN", isSuperAdmin: true });
    const anu = await person("Anu Admin", { role: "ADMIN" });
    const mona = await person("Mona Manager", { role: "MANAGEMENT" });
    const cal = await person("Cal Caller", { role: "CALLING" });
    const sam = await person("Sam Sales");
    const tara = await person("Tara Sales");
    const gone = await person("Gone Manager", { role: "MANAGEMENT", active: false });
    const history = (permission: string) => db.permissionChange.findMany({ where: { permission }, orderBy: { createdAt: "asc" } });

    section("1. A role's lead limits");
    ok("the people in this check hold what the screens assume", (await can(anu.id, "permissions.manage")) && !(await can(sam.id, "permissions.manage")) && (await can(mona.id, "permissions.view")) && !(await can(mona.id, "permissions.manage")), {
      anu: await can(anu.id, "permissions.manage"),
      sam: await can(sam.id, "permissions.manage"),
      mona: await can(mona.id, "permissions.view"),
    });
    as(sam);
    const bySales = await settings.setRoleLeadLimit("SALES", { maxOpen: "5" });
    ok("somebody without permissions.manage can't set a role's", !bySales.ok && /can't change role permissions/.test(bySales.error), bySales);
    ok("  and can't read it", (await settings.roleLeadLimit("SALES")) === null);
    as(mona);
    const reviewer = await settings.roleLeadLimit("SALES");
    ok("a reviewer (permissions.view) reads it, locked", reviewer !== null && !reviewer.editable && reviewer.stored === null, reviewer);
    ok("  and can't set it", !(await settings.setRoleLeadLimit("SALES", { maxOpen: 5 })).ok);
    as(anu);
    const set = await settings.setRoleLeadLimit("SALES", { maxOpen: "5", maxPerDay: "", maxPerMonth: 100 });
    const stored = await db.roleLeadLimit.findUnique({ where: { role: "SALES" } });
    ok("an admin with permissions.manage sets it; blank is no limit on that count", set.ok && stored?.maxOpen === 5 && stored.maxPerDay === null && stored.maxPerMonth === 100 && stored.updatedById === anu.id, set.ok ? stored : set.error);
    ok("  the engine reads it for the role's people", (await limits.leadLimitFor(sam.id)).maxOpen === 5 && (await limits.leadLimitFor(sam.id)).source.via === "roleLimit");
    let rows = await history("lead:limits");
    ok("  in the permission history, with before and after", rows.length === 1 && rows[0]!.subjectType === "ROLE" && rows[0]!.subjectRole === "SALES" && rows[0]!.actorUserId === anu.id && rows[0]!.changeKind === "GRANT" && /no limit → 5 open, 100 a month/.test(rows[0]!.detail ?? ""), rows.map((r) => r.detail));
    await settings.setRoleLeadLimit("SALES", { maxOpen: 5, maxPerMonth: "100" });
    ok("  the same again changes nothing and isn't recorded", (await history("lead:limits")).length === 1);
    for (const [bad, why] of [[{ maxOpen: "-1" }, /whole number/], [{ maxPerDay: "2.5" }, /whole number/], [{ maxPerMonth: 100_001 }, /at most 1,00,000/], ["lots", /aren't lead limits/]] as const) {
      const r = await settings.setRoleLeadLimit("SALES", bad);
      ok(`  ${JSON.stringify(bad)} is refused`, !r.ok && why.test(r.error), r);
    }
    ok("  zero is allowed — how somebody is paused", (await settings.setRoleLeadLimit("CALLING", { maxOpen: 0 })).ok && (await db.roleLeadLimit.findUnique({ where: { role: "CALLING" } }))?.maxOpen === 0);
    await db.roleLeadLimit.deleteMany({ where: { role: "CALLING" } });
    const onAdmin = await settings.setRoleLeadLimit("ADMIN", { maxOpen: 3 });
    ok("only a super admin changes Admin's", !onAdmin.ok && /Only a super admin/.test(onAdmin.error), onAdmin);
    ok("  platform support's read-only role is fixed", !(await settings.setRoleLeadLimit("SUPPORT_READONLY", { maxOpen: 3 })).ok);
    ok("  a role that isn't there", !(await settings.setRoleLeadLimit("NO_SUCH_ROLE", { maxOpen: 3 })).ok);
    as(boss);
    ok("  the super admin may set Admin's", (await settings.setRoleLeadLimit("ADMIN", { maxPerDay: 40 })).ok);
    await settings.setRoleLeadLimit("ADMIN", null);
    as(anu);
    const cleared = await settings.setRoleLeadLimit("SALES", { maxOpen: "", maxPerDay: "", maxPerMonth: "" });
    rows = await history("lead:limits");
    ok("all blank takes the row away: no limit again, recorded as a reset", cleared.ok && (await db.roleLeadLimit.count({ where: { role: "SALES" } })) === 0 && rows.at(-1)?.changeKind === "RESET_TO_DEFAULT" && /→ no limit/.test(rows.at(-1)?.detail ?? ""), rows.at(-1));
    await settings.setRoleLeadLimit("SALES", { maxOpen: 10, maxPerDay: 4 });

    section("2. One person's");
    as(sam);
    ok("somebody without permissions.manage can't set a person's", !(await settings.setPersonLeadLimit(tara.id, { limited: true, maxOpen: 1 })).ok);
    const ownView = await settings.personLeadLimit(sam.id);
    ok("anybody reads their own, locked", ownView !== null && !ownView.editable && ownView.effective.maxOpen === 10, ownView?.effective);
    ok("  but not somebody else's without permissions.view", (await settings.personLeadLimit(tara.id)) === null);
    as(anu);
    const self = await settings.setPersonLeadLimit(anu.id, { limited: false });
    ok("nobody changes their own", !self.ok && /your own lead limits/.test(self.error), self);
    ok("  the super admin has none to set", !(await settings.setPersonLeadLimit(boss.id, { limited: true, maxOpen: 1 })).ok);
    ok("  their own needs at least one number", !(await settings.setPersonLeadLimit(tara.id, { limited: true })).ok);
    ok("  an end date already past is refused", !(await settings.setPersonLeadLimit(tara.id, { limited: true, maxOpen: 2 }, { expiresAt: "2020-01-01" })).ok);
    const until = new Date(Date.now() + 10 * 86_400_000).toISOString().slice(0, 10);
    const mine = await settings.setPersonLeadLimit(tara.id, { limited: true, maxOpen: "2", maxPerMonth: "30" }, { reason: "Zz new joiner", expiresAt: until });
    const taraRow = await db.userLeadLimit.findUnique({ where: { userId: tara.id } });
    ok("their own: stored with the reason, who set it and the end of the day chosen", mine.ok && taraRow?.limited === true && taraRow.maxOpen === 2 && taraRow.maxPerDay === null && taraRow.maxPerMonth === 30 && taraRow.reason === "Zz new joiner" && taraRow.grantedById === anu.id && !!taraRow.expiresAt, mine.ok ? taraRow : mine.error);
    const taraLimit = await limits.leadLimitFor(tara.id);
    ok("  over the role's — a blank one is no limit, not the role's 4 a day", taraLimit.maxOpen === 2 && taraLimit.maxPerDay === null && taraLimit.source.via === "userLimit", taraLimit);
    rows = await history("lead:limits");
    ok("  in the permission history, with the reason and the end", rows.at(-1)?.subjectType === "USER" && rows.at(-1)?.subjectUserId === tara.id && /Tara Sales: 2 open, 30 a month, until .* — Zz new joiner/.test(rows.at(-1)?.detail ?? ""), rows.at(-1)?.detail);
    await settings.setPersonLeadLimit(tara.id, { limited: false });
    ok("\"no limit for them\" lifts the role's", (await limits.leadLimitFor(tara.id)).maxOpen === null && (await db.userLeadLimit.findUnique({ where: { userId: tara.id } }))?.limited === false);
    await settings.setPersonLeadLimit(tara.id, null);
    rows = await history("lead:limits");
    ok("back to the role's: the row goes, recorded as a reset", (await db.userLeadLimit.count({ where: { userId: tara.id } })) === 0 && (await limits.leadLimitFor(tara.id)).maxOpen === 10 && rows.at(-1)?.changeKind === "RESET_TO_DEFAULT" && /back to their role \(10 open, 4 a day\)/.test(rows.at(-1)?.detail ?? ""), rows.at(-1)?.detail);
    as(boss);
    const co = await db.company.create({ data: { name: "Zz Limit Settings Ltd", normalizedName: "zz limit settings ltd", relationshipType: "CLIENT", createdById: boss.id }, select: { id: true } });
    const made = await leadActions.createLead({ companyId: co.id, title: "Zz for Tara", ownerUserId: tara.id });
    as(mona);
    const taraView = await settings.personLeadLimit(tara.id);
    const usage = await limits.leadUsageFor(tara.id);
    ok("a reviewer reads a person's, with their usage from leadUsageFor", made.ok && taraView !== null && !taraView.editable && taraView.usage.open === 1 && taraView.usage.today === 1 && JSON.stringify(taraView.usage) === JSON.stringify(usage) && taraView.role?.maxOpen === 10, { taraView: taraView?.usage, usage });
    as(anu);
    const forAdmin = await settings.personLeadLimit(tara.id);
    ok("  an admin's is editable, and says where it comes from", forAdmin?.editable === true && /From their role/.test(forAdmin.why), forAdmin?.why);

    section("3. Telling the managers");
    await db.roleLeadLimit.deleteMany({});
    await db.userLeadLimit.deleteMany({});
    const managers = await overflow.overflowManagers();
    ok("whoever holds leads.assign or accounts.reassign — and not Sales, nor anybody switched off", [boss.id, anu.id, mona.id, cal.id].every((id) => managers.includes(id)) && !managers.includes(sam.id) && !managers.includes(tara.id) && !managers.includes(gone.id), managers.length);
    const overflowRows = (userId?: string) => db.notification.findMany({ where: { ...(userId ? { userId } : {}), dedupeKey: { startsWith: overflow.LEAD_OVERFLOW_KEY } }, orderBy: { createdAt: "asc" } });
    const someLeads = async (n: number) => {
      const out: string[] = [];
      for (let i = 0; i < n; i++) out.push((await db.lead.create({ data: { companyId: co.id, title: `Zz overflow ${i}`, createdByUserId: boss.id }, select: { id: true } })).id);
      return out;
    };
    const three = await someLeads(3);
    const told = await overflow.notifyLeadOverflow(three, "Everybody on the Zz rule is at their limit.");
    let monaRows = await overflowRows(mona.id);
    ok("three leads at once: one notification each, saying three", told === managers.length && monaRows.length === 1 && /^3 new leads have nobody free/.test(monaRows[0]!.title) && monaRows[0]!.link === "/leads?owner=unassigned", monaRows.map((r) => r.title));
    ok("  nobody who isn't a manager is told", (await overflowRows(sam.id)).length === 0 && (await overflowRows(gone.id)).length === 0);
    await overflow.notifyLeadOverflow(await someLeads(1), "Zz second reason.");
    monaRows = await overflowRows(mona.id);
    ok("another while it's unread: counted up, not a second one, with the latest reason", monaRows.length === 1 && /^4 new leads have/.test(monaRows[0]!.title) && /Zz second reason/.test(monaRows[0]!.message ?? ""), monaRows.map((r) => `${r.title} / ${r.message}`));
    ok("  everybody told has exactly one", (await overflowRows()).length === managers.length);
    await db.notification.updateMany({ where: { dedupeKey: { startsWith: overflow.LEAD_OVERFLOW_KEY } }, data: { read: true, readAt: new Date() } });
    const one = await someLeads(1);
    await overflow.notifyLeadOverflow(one, "Zz after reading.");
    monaRows = await overflowRows(mona.id);
    const lead1 = await db.lead.findUnique({ where: { id: one[0]! }, select: { leadSeq: true } });
    ok("once read, the next is a new one — for one lead, linking to it", monaRows.length === 2 && /^1 new lead has nobody free to take it/.test(monaRows[1]!.title) && monaRows[1]!.link === `/leads/${formatLeadId(lead1!.leadSeq)}`, monaRows.map((r) => `${r.title} ${r.link}`));
    ok("  except: not told", (await overflow.notifyLeadOverflow(await someLeads(1), "Zz", { except: [mona.id] })) === managers.length - 1);
    ok("  nothing to tell: nobody told", (await overflow.notifyLeadOverflow([], "Zz")) === 0);

    // A burst at the same moment, on separate connections.
    await db.notification.updateMany({ where: { dedupeKey: { startsWith: overflow.LEAD_OVERFLOW_KEY } }, data: { read: true, readAt: new Date() } });
    const burst = await someLeads(10);
    await Promise.all(burst.map((id) => overflow.notifyLeadOverflow([id], "Zz burst.")));
    const unread = await db.notification.findMany({ where: { dedupeKey: { startsWith: overflow.LEAD_OVERFLOW_KEY }, read: false } });
    const perManager = managers.map((id) => unread.filter((n) => n.userId === id));
    ok("ten overflows at the same moment: still one unread notification each, saying ten", perManager.every((list) => list.length === 1 && /^10 new leads have/.test(list[0]!.title)), perManager.map((list) => list.map((n) => n.title)));

    // Somebody who muted "a lead is assigned to me" in their bell.
    await db.notificationPreference.create({ data: { userId: cal.id, type: "LEAD_ASSIGNED", inApp: false, email: false } });
    await db.notification.deleteMany({ where: { userId: cal.id } });
    await overflow.notifyLeadOverflow(await someLeads(1), "Zz muted.");
    await overflow.notifyLeadOverflow(await someLeads(2), "Zz muted again.");
    const calRows = await overflowRows(cal.id);
    ok("somebody who muted it: nothing in their bell, one archived record batching their email for the hour", calRows.length === 1 && calRows[0]!.archivedAt !== null && calRows[0]!.read && /^3 new leads/.test(calRows[0]!.title), calRows.map((r) => r.title));

    // createLead's overflow: a rule whose only person is full, SKIP.
    await db.notification.updateMany({ where: { dedupeKey: { startsWith: overflow.LEAD_OVERFLOW_KEY } }, data: { read: true, readAt: new Date() } });
    await db.userLeadLimit.create({ data: { userId: sam.id, limited: true, maxOpen: 0 } });
    await db.leadAssignmentRule.create({ data: { name: "Zz Sam only", priority: 10, strategy: "SPECIFIC_USER", userIds: [sam.id], skipOnLeave: false, brandIds: [], itemTypes: [], designations: [], sources: [], states: [] } });
    as(boss);
    const spilled = await leadActions.createLead({ companyId: co.id, title: "Zz spilled", ownerUserId: "" });
    const spilledLead = spilled.ok ? await db.lead.findUnique({ where: { id: spilled.data.id }, select: { ownerUserId: true, leadSeq: true } }) : null;
    monaRows = (await overflowRows(mona.id)).filter((r) => !r.read);
    ok("createLead with everybody full: unassigned, flagged", spilled.ok && spilled.data.overflow === true && spilledLead?.ownerUserId === null, spilled);
    ok("  and the managers are told, with the lead and the rule", monaRows.length === 1 && /^1 new lead has/.test(monaRows[0]!.title) && /Zz spilled/.test(monaRows[0]!.message ?? "") && /Zz Sam only/.test(monaRows[0]!.message ?? ""), monaRows.map((r) => r.message));

    section("4. A rule's overflow mode");
    // Named: the workspace client leaves the newer columns out of a read that doesn't (src/lib/tenancy/clients.ts).
    const overflowOf = async (id: string) => (await db.leadAssignmentRule.findUnique({ where: { id }, select: { overflow: true } }))?.overflow;
    const base = { name: "Zz refuse rule", strategy: "SPECIFIC_USER", userIds: [sam.id], skipOnLeave: false };
    const saved = await assignment.saveAssignmentRule({ ...base, overflow: "REFUSE" });
    ok("REFUSE is saved", saved.ok && (await overflowOf(saved.data.id)) === "REFUSE", saved);
    const listed = await assignment.listAssignmentRules();
    ok("  and listed for the screen", listed?.rules.find((r) => saved.ok && r.id === saved.data.id)?.overflow === "REFUSE");
    const plain = await assignment.saveAssignmentRule({ ...base, name: "Zz default rule" });
    ok("  nothing chosen is SKIP", plain.ok && (await overflowOf(plain.data.id)) === "SKIP");
    if (saved.ok) {
      const back = await assignment.saveAssignmentRule({ ...base, id: saved.data.id, overflow: "SKIP" });
      ok("  changed back to SKIP on an edit", back.ok && (await overflowOf(saved.data.id)) === "SKIP");
    }
    const odd = await assignment.saveAssignmentRule({ ...base, overflow: "MAYBE" });
    ok("  anything else is refused", !odd.ok, odd);
    await db.leadAssignmentRule.deleteMany({});
    await db.leadAssignmentRule.create({ data: { name: "Zz Sam refuses", priority: 10, strategy: "SPECIFIC_USER", userIds: [sam.id], skipOnLeave: false, overflow: "REFUSE", brandIds: [], itemTypes: [], designations: [], sources: [], states: [] } });
    const refusedPreview = await assignment.previewAssignment({ source: "WEBSITE" });
    ok("Test a lead says a full REFUSE rule would refuse", refusedPreview.ok && !!refusedPreview.data.refused && /Zz Sam refuses/.test(refusedPreview.data.refused), refusedPreview);
    await db.leadAssignmentRule.updateMany({ data: { overflow: "SKIP" } });
    const fullPreview = await assignment.previewAssignment({ source: "WEBSITE" });
    ok("  and a full SKIP rule would leave it unassigned", fullPreview.ok && !!fullPreview.data.full && fullPreview.data.person === null, fullPreview);
    await db.leadAssignmentRule.deleteMany({});

    section("5. The backstop's switch");
    as(anu);
    ok("anybody but the super admin: no switch, no warnings", (await settings.leadLimitTriggerState()) === null);
    const notSa = await settings.setLeadLimitTrigger("enforce");
    ok("  and can't change it", !notSa.ok && /Only a super admin/.test(notSa.error) && (await limits.leadLimitTrigger()).mode === "warn", notSa);
    as(boss);
    // An import-style write past Sam's limit of 0 open, naming its path.
    const victim = await db.lead.create({ data: { companyId: co.id, title: "Zz direct", createdByUserId: boss.id }, select: { id: true, leadSeq: true } });
    await db.$transaction(async (tx) => {
      await limits.markLeadWrite(tx, "zz-script");
      await tx.lead.update({ where: { id: victim.id }, data: { ownerUserId: sam.id } });
    });
    const state = await settings.leadLimitTriggerState();
    ok("the super admin sees \"warn\" and the write it let through: when, the lead, whom, the limit and the path", state?.mode === "warn" && state.lastMonth >= 1 && state.warnings[0]?.person === "Sam Sales" && state.warnings[0]?.path === "zz-script" && state.warnings[0]?.limit === "open leads" && state.warnings[0]?.maxAllowed === 0 && /Zz direct/.test(state.warnings[0]?.lead?.label ?? ""), state?.warnings[0]);
    ok("  an unknown mode is refused", !(await settings.setLeadLimitTrigger("sometimes")).ok);
    const on = await settings.setLeadLimitTrigger("enforce");
    const audit = await db.auditLog.findMany({ where: { entityType: "LeadLimitSettings" } });
    ok("the super admin switches it to enforce, in the audit log", on.ok && (await limits.leadLimitTrigger()).mode === "enforce" && audit.length === 1 && audit[0]!.userId === boss.id && /every write path/.test(audit[0]!.entityLabel), audit.map((a) => a.entityLabel));
    const second = await db.lead.create({ data: { companyId: co.id, title: "Zz direct 2", createdByUserId: boss.id }, select: { id: true } });
    let refused: unknown = null;
    try {
      await db.lead.update({ where: { id: second.id }, data: { ownerUserId: sam.id } });
    } catch (err) {
      refused = err;
    }
    ok("  then the same write is refused by the database, read back as the limit", limits.leadCapacityError(refused)?.limit === "open", String(refused).slice(0, 160));
    ok("  the state says so, with who changed it", (await settings.leadLimitTriggerState())?.changedBy === "Zz Boss");
    await settings.setLeadLimitTrigger("warn");
    ok("  and back to warn", (await limits.leadLimitTrigger()).mode === "warn" && (await db.auditLog.count({ where: { entityType: "LeadLimitSettings" } })) === 2);

    section("7. Other paths that change an owner, and Reset to role defaults (lead's follow-ups)");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const personAccess = require("../src/actions/person-access") as typeof import("../src/actions/person-access");
    const { areaByKey } = require("../src/lib/handover/areas") as typeof import("../src/lib/handover/areas");
    /* eslint-enable @typescript-eslint/no-require-imports */
    as(anu);
    const own = await settings.setPersonLeadLimit(tara.id, { limited: true, maxOpen: 3 }, { reason: "zz follow-up" });
    const hadRow = (await db.userLeadLimit.count({ where: { userId: tara.id } })) === 1;
    const reset = await personAccess.resetPersonToRole(tara.id);
    ok("Reset to role defaults takes a person's own lead limit away too", own.ok && hadRow && reset.ok && (await db.userLeadLimit.count({ where: { userId: tara.id } })) === 0, { own, reset });
    // A handover's open leads given to somebody at their limit (Sam: none open allowed): refused, nothing moved.
    const handed = await db.lead.create({ data: { companyId: co.id, title: "Zz handed", createdByUserId: boss.id }, select: { id: true } });
    const leadsArea = areaByKey.get("leads")!;
    let handoverRefusal: unknown = null;
    try {
      await db.$transaction((tx) => leadsArea.give(tx, [handed.id], sam.id, { actorId: anu.id, fromUserId: tara.id }));
    } catch (err) {
      handoverRefusal = err;
    }
    ok("a handover's open leads to somebody at their limit: refused, read as the limit, the lead not moved", limits.leadCapacityError(handoverRefusal)?.userId === sam.id && (await db.lead.findUniqueOrThrow({ where: { id: handed.id }, select: { ownerUserId: true } })).ownerUserId === null, String(handoverRefusal).slice(0, 160));
  } finally {
    actor = null;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} lead limit settings checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
