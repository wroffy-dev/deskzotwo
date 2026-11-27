/**
 * check:lead-limits — the lead limits engine (owner, 12 Nov 2026 — Phase 4 lead limits, audit H.6; src/lib/leads/limits.ts).
 *
 *   1. The plan's caps are read from the entitlements, and nothing when absent or unreadable.
 *   2. Whose limit applies: nothing set is none; a role's; a person's over it; `limited` false lifts it; an expired one
 *      is gone; the super admin has none.
 *   3. Each limit, through createLead: open, per day, per month (a lead given yesterday or last month doesn't count),
 *      and the plan's monthly and open caps — refused in words, and nothing counted for a refused lead.
 *   4. The rules: somebody full is passed over; everybody full and SKIP, the next rule, then nobody and a flag; REFUSE
 *      refuses; those who could open the lead are preferred, and with nobody who could the rule chooses as before.
 *   5. Bulk reassign: at most 500; all or nothing against the new owner's limit; closed leads don't count as open; a
 *      lead that changed hands meanwhile stops the whole move (the TOCTOU guard).
 *   6. At the same moment, on separate connections: twenty creates at a limit of five make five; twenty by a
 *      fewest-open-leads rule share out evenly; twenty by a full-capacity rule fill both people and leave the rest unassigned.
 *   7. The database's backstop: an import-style write past a limit is let through with a warning row naming the path;
 *      "enforce" refuses it, and the app reads the refusal back as the limit it is.
 *   8. A workspace not migrated yet: creating and bulk reassigning still work, with no limits.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:lead-limits
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

const DAY = 86_400_000;

async function main() {
  section("1. The plan's caps");
  const { parseEntitlements, UNRESTRICTED } = load("../src/lib/entitlements") as typeof import("../src/lib/entitlements");
  const base = { v: 1, all: true, modules: [], seats: null, copilotTokens: null, customDomains: null, plans: [] };
  ok("no `leads` (every plan worked out before): no cap", parseEntitlements(base).leads === undefined && UNRESTRICTED.leads === undefined);
  ok("  a monthly and an open cap are read", JSON.stringify(parseEntitlements({ ...base, leads: { monthly: 1000, open: 200 } }).leads) === JSON.stringify({ monthly: 1000, open: 200 }));
  ok("  one of them alone; a null one is no cap", JSON.stringify(parseEntitlements({ ...base, leads: { monthly: null, open: 5 } }).leads) === JSON.stringify({ open: 5 }));
  ok("  an unreadable number reads as never worked out (no cap), and the rest of the plan stands", parseEntitlements({ ...base, leads: { monthly: -3, open: 5 } }).leads === undefined && parseEntitlements({ ...base, leads: { monthly: -3 } }).all === true);
  ok("  not an object: no cap", parseEntitlements({ ...base, leads: "lots" }).leads === undefined);

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_leadlimits`;
  const scratchUrl = withDatabase(url, scratch);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  let side: ReturnType<typeof directClient> | null = null;
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
    const leadActions = require("../src/actions/lead") as typeof import("../src/actions/lead");
    const limits = require("../src/lib/leads/limits") as typeof import("../src/lib/leads/limits");
    const tenancy = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    /* eslint-enable @typescript-eslint/no-require-imports */
    side = directClient(scratchUrl, { max: 2 });

    const person = (name: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-limits.in`, passwordHash: "!", role: "SALES", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const asActor = (u: { id: string; name: string; email: string | null; role: string }): Actor => ({ id: u.id, name: u.name, email: u.email!, role: u.role });
    const boss = await person("Zz Boss", { role: "ADMIN", isSuperAdmin: true });
    actor = asActor(boss);
    const company = async (name: string, ownerUserId: string | null = null) =>
      db.company.create({ data: { name, normalizedName: name.toLowerCase(), relationshipType: "CLIENT", createdById: boss.id, ownerUserId }, select: { id: true } });
    const co = await company("Zz Limits Pvt Ltd");
    const create = (ownerUserId: string | null, companyId = co.id, title = "Zz lead") => leadActions.createLead({ companyId, title, ownerUserId: ownerUserId ?? "" });
    const openOf = (userId: string) => db.lead.count({ where: { ownerUserId: userId, status: { notIn: ["WON", "LOST", "DISQUALIFIED"] } } });
    const ruleIds: string[] = [];
    const rule = async (name: string, data: Record<string, unknown>) => {
      const r = await db.leadAssignmentRule.create({ data: { name, priority: 100, skipOnLeave: false, brandIds: [], itemTypes: [], designations: [], sources: [], states: [], ...data }, select: { id: true } });
      ruleIds.push(r.id);
      return r;
    };
    const clearRules = async () => {
      await db.leadAssignmentRule.deleteMany({});
      ruleIds.length = 0;
    };

    section("2. Whose limit applies");
    const ravi = await person("Ravi Zz");
    const none = await limits.leadLimitFor(ravi.id);
    ok("nothing set: no limit", none.maxOpen === null && none.maxPerDay === null && none.maxPerMonth === null && none.source.via === "none", none);
    ok("  and room, whatever the count", await limits.canTakeLeads(ravi.id, { count: 10_000 }));
    await db.roleLeadLimit.create({ data: { role: "SALES", maxOpen: 50, maxPerDay: null, maxPerMonth: 400, updatedById: boss.id } });
    const byRole = await limits.leadLimitFor(ravi.id);
    ok("their role's", byRole.maxOpen === 50 && byRole.maxPerDay === null && byRole.maxPerMonth === 400 && byRole.source.via === "roleLimit", byRole);
    await db.userLeadLimit.create({ data: { userId: ravi.id, limited: true, maxOpen: 3, maxPerDay: 2, reason: "Zz new joiner", grantedById: boss.id } });
    const own = await limits.leadLimitFor(ravi.id);
    ok("  their own, over their role's — a null number on it is no limit, not the role's", own.maxOpen === 3 && own.maxPerDay === 2 && own.maxPerMonth === null && own.source.via === "userLimit", own);
    await db.userLeadLimit.update({ where: { userId: ravi.id }, data: { limited: false } });
    const lifted = await limits.leadLimitFor(ravi.id);
    ok("  `limited` false lifts the role's for them", lifted.maxOpen === null && lifted.maxPerMonth === null && lifted.source.via === "userLimit", lifted);
    await db.userLeadLimit.update({ where: { userId: ravi.id }, data: { limited: true, expiresAt: new Date(Date.now() - 60_000) } });
    const expired = await limits.leadLimitFor(ravi.id);
    ok("  an expired one is gone: the role's again", expired.maxOpen === 50 && expired.source.via === "roleLimit", expired);
    await db.roleLeadLimit.create({ data: { role: "ADMIN", maxOpen: 0, maxPerDay: 0, maxPerMonth: 0 } });
    await db.userLeadLimit.create({ data: { userId: boss.id, limited: true, maxOpen: 0 } });
    const sa = await limits.leadLimitFor(boss.id);
    ok("  the super admin has none, whatever is stored", sa.maxOpen === null && sa.source.via === "superAdmin", sa);
    const saLead = await create(boss.id);
    ok("  …and is given a lead through a limit of 0", saLead.ok, saLead.ok ? "" : saLead.error);
    await db.roleLeadLimit.deleteMany({});
    await db.userLeadLimit.deleteMany({});

    section("3. Each limit, through createLead");
    const asha = await person("Asha Zz");
    await db.userLeadLimit.create({ data: { userId: asha.id, limited: true, maxOpen: 2 } });
    const a1 = await create(asha.id);
    const a2 = await create(asha.id);
    const a3 = await create(asha.id);
    ok("open: two leads at a limit of two", a1.ok && a2.ok);
    ok("  a third is refused, saying whose limit and what to do", !a3.ok && /Asha Zz has reached their limit of 2 leads open/.test(a3.error), a3.ok ? "made" : a3.error);
    ok("  and was not made", (await openOf(asha.id)) === 2);
    ok("  canTakeLeads says so too", !(await limits.canTakeLeads(asha.id)));
    if (a1.ok) await db.lead.update({ where: { id: a1.data.id }, data: { status: "WON" } });
    const a4 = await create(asha.id);
    ok("  one won: room again — a closed lead isn't open", a4.ok, a4.ok ? "" : a4.error);
    const usage = await limits.leadUsageFor(asha.id);
    ok("  leadUsageFor: 2 open, 3 given today and this month (the refused one never was)", usage.open === 2 && usage.today === 3 && usage.thisMonth === 3, usage);

    const bala = await person("Bala Zz");
    await db.userLeadLimit.create({ data: { userId: bala.id, limited: true, maxPerDay: 2 } });
    const b1 = await create(bala.id);
    const b2 = await create(bala.id);
    const b3 = await create(bala.id);
    ok("per day: two given today at a limit of two; a third refused", b1.ok && b2.ok && !b3.ok && /given 2 leads today, their daily limit/.test(b3.error), b3.ok ? "made" : b3.error);
    // A lead given yesterday was given on another business day.
    await db.leadAssignment.updateMany({ where: { userId: bala.id }, data: { assignedAt: new Date(Date.now() - 2 * DAY) } });
    const b4 = await create(bala.id);
    ok("  those two were the day before yesterday: room today", b4.ok, b4.ok ? "" : b4.error);

    const chen = await person("Chen Zz");
    await db.userLeadLimit.create({ data: { userId: chen.id, limited: true, maxPerMonth: 2 } });
    const c1 = await create(chen.id);
    const c2 = await create(chen.id);
    const c3 = await create(chen.id);
    ok("per month: two at a limit of two; a third refused", c1.ok && c2.ok && !c3.ok && /given 2 leads this month, their monthly limit/.test(c3.error), c3.ok ? "made" : c3.error);
    await db.leadAssignment.updateMany({ where: { userId: chen.id }, data: { assignedAt: new Date(Date.now() - 40 * DAY) } });
    const c4 = await create(chen.id);
    ok("  given last month: room this month", c4.ok, c4.ok ? "" : c4.error);

    const workspace = await tenancy.currentTenant();
    const month = (await limits.leadUsageFor(boss.id)).month;
    const usedThisMonth = async () => (await db.leadUsage.findUnique({ where: { month } }))?.created ?? 0;
    const madeSoFar = await db.lead.count();
    ok("every lead made here was counted in this month's lead_usage", (await usedThisMonth()) === madeSoFar, { usage: await usedThisMonth(), leads: madeSoFar });
    const withPlan = <T,>(leads: { monthly?: number; open?: number }, work: () => Promise<T>) => tenancy.runAsTenant({ ...workspace, entitlements: { ...workspace.entitlements, leads } }, work);
    const before = await usedThisMonth();
    const p1 = await withPlan({ monthly: before + 2 }, () => create(null));
    const p2 = await withPlan({ monthly: before + 2 }, () => create(null));
    const p3 = await withPlan({ monthly: before + 2 }, () => create(null));
    ok("the plan's monthly cap: two more, then refused in its own words", p1.ok && p2.ok && !p3.ok && /plan includes .* leads a month, and this month's are used/.test(p3.error), p3.ok ? "made" : p3.error);
    ok("  the refused lead wasn't counted", (await usedThisMonth()) === before + 2);
    const openNow = await db.lead.count({ where: { status: { notIn: ["WON", "LOST", "DISQUALIFIED"] } } });
    const o1 = await withPlan({ open: openNow + 1 }, () => create(null));
    const o2 = await withPlan({ open: openNow + 1 }, () => create(null));
    ok("the plan's open cap: one more, then refused in its own words", o1.ok && !o2.ok && /plan allows .* leads open at once/.test(o2.error), o2.ok ? "made" : o2.error);
    const free = await create(null);
    ok("no cap in the plan: no refusal", free.ok);

    section("4. The rules");
    const dev = await person("Dev Zz");
    const esha = await person("Esha Zz");
    const fara = await person("Fara Zz");
    await db.userLeadLimit.createMany({ data: [dev.id, esha.id].map((userId) => ({ userId, limited: true, maxOpen: 1 })) });
    const rr = await rule("Zz pair", { strategy: "ROUND_ROBIN", userIds: [dev.id, esha.id] });
    const first = await create(null);
    const second = await create(null);
    const owners = await db.lead.findMany({ where: { id: { in: [first, second].flatMap((r) => (r.ok ? [r.data.id] : [])) } }, select: { ownerUserId: true } });
    ok("a round robin of two at one open lead each: one each", owners.length === 2 && new Set(owners.map((o) => o.ownerUserId)).size === 2, owners);
    await db.userLeadLimit.update({ where: { userId: esha.id }, data: { maxOpen: 2 } });
    const third = await create(null);
    const thirdLead = third.ok ? await db.lead.findUnique({ where: { id: third.data.id }, select: { ownerUserId: true } }) : null;
    ok("  Dev is full: Esha's turn or not, it goes to Esha", thirdLead?.ownerUserId === esha.id, thirdLead);
    const fourth = await create(null);
    const fourthLead = fourth.ok ? await db.lead.findUnique({ where: { id: fourth.data.id }, select: { ownerUserId: true, assignmentNote: true } }) : null;
    ok("  both full, SKIP, no other rule: made, with nobody, flagged and saying why", fourth.ok && fourth.data.overflow === true && fourthLead?.ownerUserId === null && /lead limit/.test(fourthLead?.assignmentNote ?? ""), { fourth, fourthLead });
    await rule("Zz fallback", { strategy: "SPECIFIC_USER", userIds: [fara.id], priority: 200 });
    const fifth = await create(null);
    const fifthLead = fifth.ok ? await db.lead.findUnique({ where: { id: fifth.data.id }, select: { ownerUserId: true } }) : null;
    ok("  …SKIP with another rule after it: the next rule's person", fifthLead?.ownerUserId === fara.id && fifth.ok && !fifth.data.overflow, fifthLead);
    await db.leadAssignmentRule.update({ where: { id: rr.id }, data: { overflow: "REFUSE" } });
    const sixth = await create(null);
    ok("  REFUSE: refused, saying the rule refuses — not passed on", !sixth.ok && /“Zz pair”.*refuses a lead/.test(sixth.error), sixth.ok ? "made" : sixth.error);
    await clearRules();

    // M-15: a salesperson sees a lead as far as its company, so on Gita's account only Gita could open one.
    const gita = await person("Gita Zz");
    const hari = await person("Hari Zz");
    const ira = await person("Ira Zz");
    const gitasCo = await company("Zz Gita's Customer", gita.id);
    await rule("Zz reach", { strategy: "ROUND_ROBIN", userIds: [hari.id, gita.id] });
    const reached = [];
    for (let i = 0; i < 4; i += 1) reached.push(await create(null, gitasCo.id));
    const reachOwners = await db.lead.findMany({ where: { id: { in: reached.flatMap((r) => (r.ok ? [r.data.id] : [])) } }, select: { ownerUserId: true } });
    ok("those who could open it are preferred: four on Gita's account, all Gita's (Hari couldn't open them)", reachOwners.length === 4 && reachOwners.every((o) => o.ownerUserId === gita.id), reachOwners);
    await clearRules();
    await rule("Zz nobody sees", { strategy: "ROUND_ROBIN", userIds: [hari.id, ira.id] });
    const blind = [await create(null, gitasCo.id), await create(null, gitasCo.id)];
    const blindOwners = await db.lead.findMany({ where: { id: { in: blind.flatMap((r) => (r.ok ? [r.data.id] : [])) } }, select: { ownerUserId: true } });
    ok("  nobody in the rule could: it chooses as before, not nobody", blindOwners.length === 2 && blindOwners.every((o) => o.ownerUserId === hari.id || o.ownerUserId === ira.id) && new Set(blindOwners.map((o) => o.ownerUserId)).size === 2, blindOwners);
    await clearRules();

    section("5. Bulk reassign");
    const tooMany = await leadActions.bulkUpdateLeads({ leadIds: Array.from({ length: 501 }, (_, i) => `zz-${i}`), ownerUserId: boss.id });
    ok("501 leads at once: refused, before anything is looked up", !tooMany.ok && /at most 500/.test(tooMany.error), tooMany.ok ? "done" : tooMany.error);
    const jai = await person("Jai Zz");
    const kiran = await person("Kiran Zz");
    const theirs = [];
    for (let i = 0; i < 4; i += 1) {
      const made = await create(kiran.id);
      if (made.ok) theirs.push(made.data.id);
    }
    await db.userLeadLimit.create({ data: { userId: jai.id, limited: true, maxOpen: 3 } });
    const jaiFirst = await create(jai.id);
    const three = await leadActions.bulkUpdateLeads({ leadIds: theirs.slice(0, 3), ownerUserId: jai.id });
    ok("three to somebody with one open and a limit of three: refused, in words", !three.ok && /Jai Zz has 1 lead open and a limit of 3, so they can't take these 3/.test(three.error), three.ok ? "done" : three.error);
    ok("  all or nothing: none of the three moved", (await db.lead.count({ where: { id: { in: theirs }, ownerUserId: kiran.id } })) === 4);
    const two = await leadActions.bulkUpdateLeads({ leadIds: theirs.slice(0, 2), ownerUserId: jai.id });
    ok("  two: moved", two.ok && (await openOf(jai.id)) === 3, two.ok ? "" : two.error);
    await db.lead.update({ where: { id: theirs[2]! }, data: { status: "LOST", lostReason: "Zz" } });
    const closedMove = await leadActions.bulkUpdateLeads({ leadIds: [theirs[2]!], ownerUserId: jai.id });
    ok("  a lost lead to somebody at their open limit: moved — it isn't open", closedMove.ok, closedMove.ok ? "" : closedMove.error);
    const audits = await db.auditLog.findMany({ where: { entityType: "Lead", entityId: { in: theirs }, entityLabel: { contains: "owner: Kiran Zz → Jai Zz" } }, select: { entityId: true, leadId: true, companyId: true } });
    ok("  each lead moved has its audit row, on the lead and its company", audits.length === 3 && audits.every((a) => a.leadId === a.entityId && a.companyId === co.id), audits.length);
    void jaiFirst;

    // The TOCTOU guard: a lead changes hands between the check and the move.
    const lena = await person("Lena Zz");
    const mohan = await person("Mohan Zz");
    const nita = await person("Nita Zz");
    const contested: string[] = [];
    for (let i = 0; i < 2; i += 1) {
      const made = await create(lena.id);
      if (made.ok) contested.push(made.data.id);
    }
    let release: () => void = () => {};
    const released = new Promise<void>((r) => (release = r));
    let held: () => void = () => {};
    const isHeld = new Promise<void>((r) => (held = r));
    const blocker = side.$transaction(
      async (tx) => {
        await tx.$queryRawUnsafe(`SELECT 1 FROM "leads" WHERE "id" = $1 FOR UPDATE`, contested[0]);
        held();
        await released;
        await tx.lead.update({ where: { id: contested[0]! }, data: { ownerUserId: nita.id } });
      },
      { timeout: 30_000 },
    );
    await isHeld;
    const moving = leadActions.bulkUpdateLeads({ leadIds: contested, ownerUserId: mohan.id });
    // Until the bulk move waits on the row the other transaction holds.
    const until = Date.now() + 15_000;
    let waiting = false;
    while (!waiting && Date.now() < until) {
      const rows = await admin.$queryRawUnsafe<{ n: bigint }[]>(
        `SELECT count(*)::bigint AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock' AND query ILIKE 'UPDATE%leads%'`,
        scratch,
      );
      waiting = Number(rows[0]?.n ?? 0) > 0;
      if (!waiting) await new Promise((r) => setTimeout(r, 50));
    }
    ok("  (the bulk move is waiting on the lead another transaction is moving)", waiting);
    release();
    await blocker;
    const raced = await moving;
    const afterRace = await db.lead.findMany({ where: { id: { in: contested } }, select: { id: true, ownerUserId: true } });
    ok("a lead that changed hands meanwhile: refused, saying so", !raced.ok && /changed hands/.test(raced.error), raced.ok ? "done" : raced.error);
    ok("  the other's change stands, and the rest of the selection didn't move", afterRace.find((l) => l.id === contested[0])?.ownerUserId === nita.id && afterRace.find((l) => l.id === contested[1])?.ownerUserId === lena.id, afterRace);

    section("6. At the same moment");
    const omar = await person("Omar Zz");
    await db.userLeadLimit.create({ data: { userId: omar.id, limited: true, maxOpen: 5 } });
    const burst = await Promise.all(Array.from({ length: 20 }, (_, i) => create(omar.id, co.id, `Zz burst ${i}`)));
    const made = burst.filter((r) => r.ok).length;
    const refusedRight = burst.filter((r) => !r.ok && /Omar Zz has reached their limit of 5 leads open/.test(r.error)).length;
    ok("twenty creates at once for somebody with a limit of five: exactly five", made === 5 && (await openOf(omar.id)) === 5, { made, open: await openOf(omar.id) });
    ok("  the other fifteen refused for the limit, not for anything else", refusedRight === 15, burst.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.error)).slice(0, 2));

    const pool = await Promise.all(["Pia Zz", "Quin Zz", "Rao Zz", "Sam Zz"].map((n) => person(n)));
    await rule("Zz least", { strategy: "LEAST_LOADED", userIds: pool.map((p) => p.id) });
    const shared = await Promise.all(Array.from({ length: 20 }, (_, i) => create(null, co.id, `Zz least ${i}`)));
    const loads = await Promise.all(pool.map((p) => openOf(p.id)));
    ok("twenty at once by fewest open leads: five each, none piled on one", shared.every((r) => r.ok) && loads.every((l) => l === 5), { loads, refused: shared.filter((r) => !r.ok).map((r) => (r.ok ? "" : r.error)).slice(0, 2) });
    await clearRules();

    const capped = await Promise.all(["Tara Zz", "Uma Zz"].map((n) => person(n)));
    await db.userLeadLimit.createMany({ data: capped.map((p) => ({ userId: p.id, limited: true, maxOpen: 5 })) });
    const cursorRule = await rule("Zz capped", { strategy: "ROUND_ROBIN", userIds: capped.map((p) => p.id) });
    const flood = await Promise.all(Array.from({ length: 20 }, (_, i) => create(null, co.id, `Zz flood ${i}`)));
    const floodLoads = await Promise.all(capped.map((p) => openOf(p.id)));
    const flagged = flood.filter((r) => r.ok && r.data.overflow).length;
    ok("twenty at once by a rule whose two people have five places each: five each, ten kept with nobody and flagged", flood.every((r) => r.ok) && floodLoads.every((l) => l === 5) && flagged === 10, { floodLoads, flagged });
    const cursor = (await db.leadAssignmentRule.findUnique({ where: { id: cursorRule.id }, select: { rrCursor: true } }))?.rrCursor;
    ok("  the round robin moved once for each lead it gave, and not for those it couldn't", cursor === 10, cursor);
    await clearRules();

    section("7. The backstop");
    const vik = await person("Vik Zz");
    await db.userLeadLimit.create({ data: { userId: vik.id, limited: true, maxOpen: 1, maxPerDay: 3 } });
    await db.lead.create({ data: { title: "Zz import 1", companyId: co.id, ownerUserId: vik.id } });
    ok("an import-style write within the limit: no warning", (await db.leadLimitWarning.count({ where: { userId: vik.id } })) === 0);
    const over = await db.$transaction(async (tx) => {
      await limits.markLeadWrite(tx, "import");
      return tx.lead.create({ data: { title: "Zz import 2", companyId: co.id, ownerUserId: vik.id }, select: { id: true } });
    });
    const warned = await db.leadLimitWarning.findMany({ where: { userId: vik.id } });
    ok("one past the open limit: written (warn), with a warning row — lead, person, limit, counts, path", warned.length === 1 && warned[0]!.leadId === over.id && warned[0]!.limitKind === "open" && warned[0]!.counted === 1 && warned[0]!.maxAllowed === 1 && warned[0]!.path === "import", warned);
    const moved = await db.lead.create({ data: { title: "Zz elsewhere", companyId: co.id, ownerUserId: ravi.id, status: "WON" }, select: { id: true } });
    await db.lead.update({ where: { id: moved.id }, data: { ownerUserId: vik.id } });
    await db.lead.update({ where: { id: moved.id }, data: { ownerUserId: ravi.id } });
    await db.lead.update({ where: { id: moved.id }, data: { ownerUserId: vik.id } });
    const dayWarn = await db.leadLimitWarning.findMany({ where: { userId: vik.id, limitKind: "perDay" } });
    ok("  a closed lead given back and forth: not open, but the fourth giving today is past the daily three", dayWarn.length === 1 && dayWarn[0]!.counted === 3 && dayWarn[0]!.maxAllowed === 3, dayWarn);
    await db.lead.update({ where: { id: moved.id }, data: { title: "Zz renamed" } });
    ok("  an edit that doesn't change the owner: nothing", (await db.leadLimitWarning.count({ where: { userId: vik.id } })) === 2);
    await db.lead.create({ data: { title: "Zz free", companyId: co.id, ownerUserId: ravi.id } });
    ok("  somebody with no limit: nothing", (await db.leadLimitWarning.count({ where: { userId: ravi.id } })) === 0);
    ok("  the setting reads \"warn\" until changed", (await limits.leadLimitTrigger()).mode === "warn");

    await limits.saveLeadLimitTrigger("enforce", boss.id);
    ok("\"enforce\" is stored, with the workspace's zone", (await limits.leadLimitTrigger()).mode === "enforce" && (await db.leadLimitSettings.findUnique({ where: { id: "global" } }))?.timeZone === "Asia/Kolkata");
    let thrown: unknown = null;
    try {
      await db.lead.create({ data: { title: "Zz import 3", companyId: co.id, ownerUserId: vik.id } });
    } catch (err) {
      thrown = err;
    }
    const read = limits.leadCapacityError(thrown);
    ok("enforce: an import-style write past the limit is refused", thrown !== null && (await db.lead.count({ where: { title: "Zz import 3" } })) === 0, thrown instanceof Error ? thrown.message.slice(0, 160) : thrown);
    ok("  …and the app reads it back as the limit it is: whose, which, the counts", read instanceof limits.LeadCapacityFull && read.userId === vik.id && read.limit === "open" && read.used === 2 && read.max === 1, read && { userId: read.userId, limit: read.limit, used: read.used, max: read.max });
    ok("  no warning row for it: the refusal is the record", (await db.leadLimitWarning.count({ where: { userId: vik.id } })) === 2);
    const viaApp = await create(vik.id);
    ok("  createLead still refuses first, in its own words", !viaApp.ok && /Vik Zz has reached their limit/.test(viaApp.error), viaApp.ok ? "made" : viaApp.error);
    const fine = await create(ravi.id);
    ok("  and nobody under their limit is touched", fine.ok, fine.ok ? "" : fine.error);
    await limits.saveLeadLimitTrigger("warn", boss.id);
    let badMode = false;
    try {
      await db.leadLimitSettings.update({ where: { id: "global" }, data: { limitTrigger: "sometimes" } });
    } catch {
      badMode = true;
    }
    ok("  the setting is \"warn\" or \"enforce\", nothing else", badMode);
    await tenancy.runAsTenant({ ...workspace, timezone: "Asia/Dubai" }, async () => {
      const made = await create(bala.id);
      ok("  a daily limit counted in another zone writes that zone for the trigger's day", made.ok && (await db.leadLimitSettings.findUnique({ where: { id: "global" } }))?.timeZone === "Asia/Dubai", made.ok ? "" : made.error);
    });

    section("8. A workspace not migrated yet");
    await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "leads_check_limit" ON "leads"`);
    await db.$executeRawUnsafe(`DROP TABLE "user_lead_limits", "role_lead_limits", "lead_usage", "lead_limit_settings", "lead_limit_warnings" CASCADE`);
    await db.$executeRawUnsafe(`ALTER TABLE "lead_assignment_rules" DROP COLUMN "overflow"`);
    await db.leadAssignmentRule.createMany({ data: [{ name: "Zz old", priority: 1, skipOnLeave: false, strategy: "SPECIFIC_USER", userIds: [ira.id], brandIds: [], itemTypes: [], designations: [], sources: [], states: [] }] }).catch(async () => {
      await db.$executeRawUnsafe(`INSERT INTO "lead_assignment_rules" ("id", "name", "priority", "active", "brandIds", "itemTypes", "designations", "sources", "states", "strategy", "userIds", "skipOnLeave", "rrCursor", "updatedAt") VALUES ('zz-old', 'Zz old', 1, true, '{}', '{}', '{}', '{}', '{}', 'SPECIFIC_USER', ARRAY['${ira.id}'], false, 0, now())`);
    });
    const oldNamed = await create(asha.id);
    ok("creating a lead for somebody: made, no limit", oldNamed.ok, oldNamed.ok ? "" : oldNamed.error);
    const oldRules = await create(null);
    const oldLead = oldRules.ok ? await db.lead.findUnique({ where: { id: oldRules.data.id }, select: { ownerUserId: true } }) : null;
    ok("  by the rules: chosen as before", oldLead?.ownerUserId === ira.id, oldRules.ok ? oldLead : oldRules.error);
    const oldBulk = await leadActions.bulkUpdateLeads({ leadIds: oldRules.ok ? [oldRules.data.id] : [], ownerUserId: asha.id });
    ok("  a bulk reassign: done", oldBulk.ok, oldBulk.ok ? "" : oldBulk.error);
    ok("  leadLimitFor: none", (await limits.leadLimitFor(asha.id)).source.via === "none");
  } finally {
    actor = null;
    await side?.$disconnect().catch(() => {});
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} lead limit checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
