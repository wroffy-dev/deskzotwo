/**
 * check:lead-assignment — who a lead goes to, by performance and by rules, and what happens when nobody answers
 * (owner, 26 Oct 2026 — src/lib/leads/assign.ts, performance.ts, response.ts).
 *
 *   1. The rules' conditions: customer category (a sub-category counts for its category), products, and where
 *      the customer is — country, state, city, PIN by its first digits; an old rule matches as it did.
 *   2. The performance score: closing, answering, keeping at it, each against the best; too little history is
 *      the team's average; the share weighted by it, and nobody gets none.
 *   3. Office hours between two moments: the company's hours, Sundays and holidays off.
 *   4. The history: a trigger writes who had a lead, every way an owner changes, and nothing else.
 *   5. Rules by category, city and PIN, read from the company.
 *   6. By performance: the better closer gets more; the other still gets some.
 *   7. Nobody answers: a touched lead is answered; an untouched one past its rule's hours moves on by that rule,
 *      never back; everybody told; nobody left and the manager is told, once.
 *   8. Reassigning from the lead: only whoever the reassign rules allow; who had it, shown.
 *   9. Saving rules: a PIN that isn't digits, response hours on an account-manager rule, refused.
 *  10. A workspace not migrated yet: nothing breaks.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:lead-assignment
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

const HOUR = 3_600_000;

async function main() {
  const assign = load("../src/lib/leads/assign") as typeof import("../src/lib/leads/assign");
  const perf = load("../src/lib/leads/performance") as typeof import("../src/lib/leads/performance");
  const response = load("../src/lib/leads/response") as typeof import("../src/lib/leads/response");
  const { clockFor } = load("../src/lib/time/zone") as typeof import("../src/lib/time/zone");

  section("1. The rules' conditions");
  const rule = (o: Partial<import("../src/lib/leads/assign").RuleShape>): import("../src/lib/leads/assign").RuleShape => ({
    id: "r",
    name: "r",
    brandIds: [],
    itemTypes: [],
    designations: [],
    sources: [],
    states: [],
    strategy: "ROUND_ROBIN",
    userIds: ["u"],
    skipOnLeave: false,
    ...o,
  });
  const lead = (o: Partial<import("../src/lib/leads/assign").AssignmentSignals>): import("../src/lib/leads/assign").AssignmentSignals => ({
    brandIds: [],
    itemTypes: [],
    designation: null,
    source: "WEBSITE",
    state: "Maharashtra",
    companyOwnerId: null,
    country: "India",
    city: "Mumbai",
    pincode: "400 076",
    customerCategoryIds: ["sub", "corporate"],
    itemIds: ["m365"],
    ...o,
  });
  ok("a category matches its sub-categories' customers", assign.ruleMatches(rule({ customerCategoryIds: ["corporate"] }), lead({})) && !assign.ruleMatches(rule({ customerCategoryIds: ["sme"] }), lead({})));
  ok("  products: any of them", assign.ruleMatches(rule({ itemIds: ["dell", "m365"] }), lead({})) && !assign.ruleMatches(rule({ itemIds: ["dell"] }), lead({})));
  ok("  a city, whatever its case and spaces", assign.ruleMatches(rule({ cities: ["  mumbai ", "Thane"] }), lead({})) && !assign.ruleMatches(rule({ cities: ["Pune"] }), lead({})));
  ok("  a PIN by its first digits, the spaces in it ignored", assign.ruleMatches(rule({ pincodes: ["4000"] }), lead({})) && assign.ruleMatches(rule({ pincodes: ["400076"] }), lead({})) && !assign.ruleMatches(rule({ pincodes: ["4110"] }), lead({})));
  ok("  no PIN on the lead doesn't fit a PIN rule", !assign.ruleMatches(rule({ pincodes: ["4000"] }), lead({ pincode: null })));
  ok("  an address with no country is India's", assign.ruleMatches(rule({ countries: ["India"] }), lead({ country: null })) && !assign.ruleMatches(rule({ countries: ["United Arab Emirates"] }), lead({ country: null })));
  ok("  each filled one has to fit — Maharashtra, Mumbai and 4000 together; Pune not", assign.ruleMatches(rule({ states: ["Maharashtra"], cities: ["Mumbai"], pincodes: ["4000"] }), lead({})) && !assign.ruleMatches(rule({ states: ["Maharashtra"], cities: ["Pune"] }), lead({})));
  ok("  a rule saved before any of this matches as it did", assign.ruleMatches({ id: "o", name: "o", brandIds: [], itemTypes: [], designations: [], sources: ["WEBSITE"], states: [], strategy: "ROUND_ROBIN", userIds: ["u"], skipOnLeave: true }, lead({ customerCategoryIds: undefined, itemIds: undefined, city: undefined })));

  section("2. The performance score");
  const fig = (userId: string, o: Partial<import("../src/lib/leads/performance").PersonFigures>) => ({ userId, decided: 0, won: 0, answerMinutes: [], touches: 0, openLeads: 0, givenRecently: 0, ...o });
  const scores = perf.performanceScores([
    fig("star", { decided: 10, won: 6, answerMinutes: [5, 10, 15], touches: 40, openLeads: 10 }),
    fig("slow", { decided: 10, won: 2, answerMinutes: [120, 180, 240], touches: 10, openLeads: 10 }),
    fig("new", { decided: 1, won: 1, answerMinutes: [30], touches: 0, openLeads: 0 }),
  ]);
  const star = scores.get("star")!;
  const slow = scores.get("slow")!;
  const fresh = scores.get("new")!;
  ok("the best at all three scores 1", star.score === 1, star);
  ok("  the slower, weaker closer scores less, but more than nothing", slow.score < star.score && slow.score > 0, slow);
  ok("  a new joiner with too little history: closing and answering are the team's average", fresh.closeRate === null && fresh.answerMinutes === null && fresh.score > slow.score * 0.5 && fresh.score < star.score, fresh);
  ok("  every share has a floor", [...scores.values()].every((s) => s.weight >= perf.SHARE_FLOOR));
  // A hundred leads in turn: each goes to whoever has had the fewest for their weight.
  const given = new Map([...scores.keys()].map((k) => [k, fig(k, {})]));
  const tally: Record<string, number> = { star: 0, slow: 0, new: 0 };
  for (let i = 0; i < 100; i += 1) {
    const who = perf.weightedTurn(["star", "slow", "new"], given, scores);
    tally[who] += 1;
    given.get(who)!.givenRecently += 1;
  }
  ok("  over a hundred leads: the best gets most, the weakest still gets some", tally.star! > tally.new! && tally.new! > tally.slow! && tally.slow! > 0, tally);
  ok("  …in proportion to their weights", Math.abs(tally.star! / tally.slow! - star.weight / slow.weight) < 0.3, { ratio: tally.star! / tally.slow!, weights: star.weight / slow.weight });

  section("3. Office hours");
  const ist = clockFor("Asia/Kolkata");
  const hours = { startMinute: 9 * 60 + 30, endMinute: 18 * 60 + 30, graceMinutes: 0 };
  const at = (s: string) => new Date(`${s}+05:30`);
  ok("within a day: just the minutes between", response.officeMinutesBetween(at("2026-10-26T10:00:00"), at("2026-10-26T12:00:00"), ist, hours, () => false) === 120);
  ok("  overnight: none of the night", response.officeMinutesBetween(at("2026-10-26T18:00:00"), at("2026-10-27T10:00:00"), ist, hours, () => false) === 60);
  ok("  Saturday is worked, Sunday isn't — Sat 6 pm to Mon 10 am is an hour", response.officeMinutesBetween(at("2026-10-31T18:00:00"), at("2026-11-02T10:00:00"), ist, hours, () => false) === 60);
  ok("  a holiday isn't either", response.officeMinutesBetween(at("2026-10-26T18:00:00"), at("2026-10-28T10:00:00"), ist, hours, (d) => d === "2026-10-27") === 60);
  ok("  no office hours set: every minute", response.officeMinutesBetween(at("2026-10-26T18:00:00"), at("2026-10-27T10:00:00"), ist, null, () => false) === 16 * 60);

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_leadassign`;
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, scratch) }, timeout: 10 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.DATABASE_URL = withDatabase(url, scratch);
    process.env.CONTROL_DATABASE_URL = "";
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const ruleActions = require("../src/actions/lead-assignment") as typeof import("../src/actions/lead-assignment");
    const leadActions = require("../src/actions/lead") as typeof import("../src/actions/lead");
    const ownerActions = require("../src/actions/lead-owner") as typeof import("../src/actions/lead-owner");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const person = (name: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-assign.in`, passwordHash: "!", role: "SALES", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const boss = await person("Zz Boss", { role: "ADMIN", isSuperAdmin: true });
    const head = await person("Zz Head", { role: "SALES_MANAGER" });
    const asha = await person("Asha Zz", { managerId: head.id });
    const bala = await person("Bala Zz", { managerId: head.id });
    const chen = await person("Chen Zz", { managerId: head.id });
    const asActor = (u: { id: string; name: string; email: string | null; role: string }): Actor => ({ id: u.id, name: u.name, email: u.email!, role: u.role });
    const as = <T,>(who: { id: string; name: string; email: string | null; role: string }, work: () => Promise<T>) => {
      const before = actor;
      actor = asActor(who);
      return work().finally(() => {
        actor = before;
      });
    };
    actor = asActor(boss);
    const corporate = await db.customerCategory.create({ data: { name: "Zz Corporate" }, select: { id: true } });
    const large = await db.customerCategory.create({ data: { name: "Zz Large", parentId: corporate.id }, select: { id: true } });
    const company = async (name: string, place: { city: string; state: string; pincode: string; country?: string }, categoryId: string | null = null) => {
      const c = await db.company.create({ data: { name, normalizedName: name.toLowerCase(), relationshipType: "CLIENT", createdById: boss.id, customerCategoryId: categoryId }, select: { id: true, name: true } });
      await db.companyLocation.create({ data: { companyId: c.id, label: "Head Office", isPrimary: true, country: place.country ?? "India", ...place } });
      return c;
    };
    const mumbaiCo = await company("Zz Andheri Pvt Ltd", { city: "Mumbai", state: "Maharashtra", pincode: "400069" }, large.id);
    const puneCo = await company("Zz Pune Traders", { city: "Pune", state: "Maharashtra", pincode: "411001" });

    section("4. The history");
    const l1 = await db.lead.create({ data: { title: "Zz trigger", companyId: mumbaiCo.id, ownerUserId: asha.id, status: "NEW" }, select: { id: true } });
    const rows = () => db.leadAssignment.findMany({ where: { leadId: l1.id }, orderBy: { assignedAt: "asc" } });
    ok("a lead made with an owner: one row, theirs", (await rows()).length === 1 && (await rows())[0]!.userId === asha.id);
    await db.lead.update({ where: { id: l1.id }, data: { title: "Zz trigger, renamed" } });
    ok("  an edit to anything else writes nothing", (await rows()).length === 1);
    await db.lead.update({ where: { id: l1.id }, data: { ownerUserId: bala.id } });
    const afterMove = await rows();
    ok("  a new owner: the old row ended, a new one for them", afterMove.length === 2 && !!afterMove[0]!.endedAt && afterMove[1]!.userId === bala.id && !afterMove[1]!.endedAt);
    await db.lead.updateMany({ where: { id: l1.id }, data: { ownerUserId: null } });
    ok("  left with nobody (a bulk update too): a row for nobody", (await rows()).length === 3 && (await rows())[2]!.userId === null);

    section("5. Rules by category, city and PIN");
    const saved = await ruleActions.saveAssignmentRule({ name: "Zz Mumbai corporates", strategy: "SPECIFIC_USER", userIds: [chen.id], customerCategoryIds: [corporate.id], cities: ["Mumbai"], pincodes: ["4000"] });
    ok("a rule on category, city and PIN is saved", saved.ok, saved.ok ? "" : saved.error);
    await ruleActions.saveAssignmentRule({ name: "Zz everyone else", strategy: "SPECIFIC_USER", userIds: [asha.id] });
    const forMumbai = await assign.chooseOwner({ brandIds: [], itemTypes: [], designation: null, source: "WEBSITE", state: null, companyOwnerId: null, companyId: mumbaiCo.id });
    ok("a large corporate in Andheri (400069): Chen, read from the company", forMumbai?.userId === chen.id, forMumbai);
    const forPune = await assign.chooseOwner({ brandIds: [], itemTypes: [], designation: null, source: "WEBSITE", state: null, companyOwnerId: null, companyId: puneCo.id });
    ok("  a Pune trader: the next rule", forPune?.userId === asha.id);
    const preview = await ruleActions.previewAssignment({ source: "WEBSITE", city: "mumbai", pincode: "400001", customerCategoryId: large.id, state: "Maharashtra" });
    ok("  the settings' test box agrees, a sub-category counting for its category", preview.ok && preview.data.person === "Chen Zz", preview);
    for (const r of await db.leadAssignmentRule.findMany({ select: { id: true } })) await ruleActions.deleteAssignmentRule(r.id);

    section("6. By performance");
    // Asha closed 6 of 8 lately, Bala 1 of 8.
    const decided = async (owner: string, won: number, of: number) => {
      for (let i = 0; i < of; i += 1) await db.lead.create({ data: { title: `Zz past ${owner}-${i}`, companyId: puneCo.id, ownerUserId: owner, status: i < won ? "WON" : "LOST", stageChangedAt: new Date(Date.now() - 10 * 86_400_000) } });
    };
    await decided(asha.id, 6, 8);
    await decided(bala.id, 1, 8);
    // Those leads were "given" too, so the share starts level: what's counted from here is the new ones.
    await db.leadAssignment.updateMany({ data: { assignedAt: new Date(Date.now() - 60 * 86_400_000) } });
    const perfRule = await ruleActions.saveAssignmentRule({ name: "Zz performance", strategy: "PERFORMANCE", userIds: [asha.id, bala.id], skipOnLeave: false });
    ok("a performance rule is saved", perfRule.ok, perfRule.ok ? "" : perfRule.error);
    const got: Record<string, number> = { [asha.id]: 0, [bala.id]: 0 };
    for (let i = 0; i < 20; i += 1) {
      const chosen = await assign.chooseOwner({ brandIds: [], itemTypes: [], designation: null, source: "WEBSITE", state: null, companyOwnerId: null });
      got[chosen!.userId] = (got[chosen!.userId] ?? 0) + 1;
      await db.lead.create({ data: { title: `Zz new ${i}`, companyId: puneCo.id, ownerUserId: chosen!.userId, status: "NEW" } });
    }
    ok("twenty new leads: the better closer gets more, the other still gets some", got[asha.id]! > got[bala.id]! && got[bala.id]! >= 3, { asha: got[asha.id], bala: got[bala.id] });
    const scoreRows = await ruleActions.assignmentScores();
    ok("  the settings page shows the scores, Asha first", !!scoreRows && scoreRows[0]?.name === "Asha Zz" && scoreRows.length === 2, scoreRows?.map((s) => [s.name, s.score]));

    section("7. Nobody answers");
    await db.leadAssignmentRule.deleteMany();
    const slaRule = await ruleActions.saveAssignmentRule({ name: "Zz answer within 2h", strategy: "ROUND_ROBIN", userIds: [asha.id, bala.id, chen.id], responseHours: 2, skipOnLeave: false });
    ok("a rule with response hours is saved", slaRule.ok, slaRule.ok ? "" : slaRule.error);
    const sla = await db.lead.create({ data: { title: "Zz waiting", companyId: puneCo.id, ownerUserId: asha.id, status: "NEW" }, select: { id: true } });
    const backdate = async (leadId: string, hoursAgo: number) => {
      const row = await db.leadAssignment.findFirst({ where: { leadId, endedAt: null }, orderBy: { assignedAt: "desc" } });
      await db.leadAssignment.update({ where: { id: row!.id }, data: { assignedAt: new Date(Date.now() - hoursAgo * HOUR) } });
    };
    await backdate(sla.id, 1);
    let sweep = await response.leadResponseChores(new Date());
    ok("an hour in, untouched: it stays", (await db.lead.findUnique({ where: { id: sla.id } }))?.ownerUserId === asha.id, sweep);
    await backdate(sla.id, 3);
    sweep = await response.leadResponseChores(new Date());
    const moved = await db.lead.findUnique({ where: { id: sla.id }, select: { ownerUserId: true, assignmentNote: true } });
    const ashaRow = await db.leadAssignment.findFirst({ where: { leadId: sla.id, userId: asha.id } });
    ok("three hours untouched: moved on by the same rule, and why", moved?.ownerUserId !== asha.id && [bala.id, chen.id].includes(moved!.ownerUserId!) && !!moved?.assignmentNote?.includes("no response in 2 office hours") && !!ashaRow?.timedOutAt, { sweep, moved });
    const told = await db.notification.findMany({ where: { type: "LEAD_ASSIGNED", createdAt: { gte: new Date(Date.now() - 60_000) } }, select: { userId: true, title: true } });
    ok("  the new owner, Asha and her manager are told", told.some((n) => n.userId === moved!.ownerUserId) && told.some((n) => n.userId === asha.id && n.title.includes("moved on")) && told.some((n) => n.userId === head.id));
    // The next person doesn't answer either, nor the one after: never back to Asha; then the manager.
    await backdate(sla.id, 3);
    await response.leadResponseChores(new Date());
    const third = (await db.lead.findUnique({ where: { id: sla.id } }))!.ownerUserId;
    ok("  the second doesn't answer: the third — never back to Asha", third !== asha.id && third !== moved!.ownerUserId, { third });
    await backdate(sla.id, 3);
    sweep = await response.leadResponseChores(new Date());
    const lastRow = await db.leadAssignment.findFirst({ where: { leadId: sla.id, endedAt: null } });
    ok("  nobody left in the rule: it stays, and the manager is told", (await db.lead.findUnique({ where: { id: sla.id } }))!.ownerUserId === third && !!lastRow?.escalatedAt && sweep?.escalated === 1);
    const headNotices = await db.notification.count({ where: { userId: head.id } });
    await response.leadResponseChores(new Date());
    ok("  …once", (await db.notification.count({ where: { userId: head.id } })) === headNotices);

    const touched = await db.lead.create({ data: { title: "Zz answered", companyId: puneCo.id, ownerUserId: bala.id, status: "NEW" }, select: { id: true } });
    await backdate(touched.id, 3);
    await db.activity.create({ data: { leadId: touched.id, userId: bala.id, type: "CALL", notes: "Spoke to them" } });
    sweep = await response.leadResponseChores(new Date());
    const answered = await db.leadAssignment.findFirst({ where: { leadId: touched.id, userId: bala.id } });
    ok("a lead its owner did something with: answered, and stays", !!answered?.respondedAt && (await db.lead.findUnique({ where: { id: touched.id } }))!.ownerUserId === bala.id);

    section("8. Reassigning from the lead");
    const mine = await db.lead.create({ data: { title: "Zz Asha's", companyId: puneCo.id, ownerUserId: asha.id, status: "NEW" }, select: { id: true } });
    await db.company.update({ where: { id: puneCo.id }, data: { ownerUserId: asha.id } });
    const asAsha = await as(asha, () => ownerActions.leadOwnership(mine.id));
    ok("a rep, on her own lead: may hand it to a colleague (Hand off their own), not leave it with nobody", !!asAsha?.mayChange && !asAsha.mayUnassign, asAsha && { mayChange: asAsha.mayChange, mayUnassign: asAsha.mayUnassign });
    const asHead = await as(head, () => ownerActions.leadOwnership(mine.id));
    ok("the sales head: Reassign, and may leave it with nobody", !!asHead?.mayChange && asHead.mayUnassign, asHead && { mayChange: asHead.mayChange, mayUnassign: asHead.mayUnassign });
    const asBoss = await ownerActions.leadOwnership(mine.id);
    ok("the admin: Reassign", !!asBoss?.mayChange);
    const done = await as(head, () => leadActions.bulkUpdateLeads({ leadIds: [mine.id], ownerUserId: chen.id }));
    const history = await ownerActions.leadOwnership(mine.id);
    ok("  reassigned by the head: the lead is Chen's, and Asha shows as before", done.ok && history?.history[0]?.userId === chen.id && history.history.some((h) => h.userId === asha.id && !!h.endedAt), done.ok ? history?.history.map((h) => h.name) : done.error);
    const refused = await as(asha, () => leadActions.bulkUpdateLeads({ leadIds: [mine.id], ownerUserId: asha.id }));
    ok("  the rep can't take it back", !refused.ok);
    const onChens = await as(asha, () => ownerActions.leadOwnership(mine.id));
    ok("  and on somebody else's lead she's offered no Reassign", !!onChens && !onChens.mayChange);

    section("9. Saving rules");
    const badPin = await ruleActions.saveAssignmentRule({ name: "Zz bad pin", strategy: "ROUND_ROBIN", userIds: [asha.id], pincodes: ["40A"] });
    ok("a PIN that isn't digits is refused", !badPin.ok && badPin.error.includes("PIN"));
    const amHours = await ruleActions.saveAssignmentRule({ name: "Zz am", strategy: "ACCOUNT_MANAGER", responseHours: 2 });
    ok("  response hours on an account-manager rule are refused", !amHours.ok && amHours.error.includes("account-manager"));
    const sameCity = await ruleActions.saveAssignmentRule({ name: "Zz cities", strategy: "ROUND_ROBIN", userIds: [asha.id], cities: ["Mumbai", " mumbai", "Thane"] });
    const stored = sameCity.ok ? await db.leadAssignmentRule.findUnique({ where: { id: sameCity.data.id }, select: { cities: true } }) : null;
    ok("  the same city typed twice is one", stored?.cities.length === 2, stored);
    ok("  only an admin manages rules", !(await as(asha, () => ruleActions.saveAssignmentRule({ name: "Zz rep", strategy: "ROUND_ROBIN", userIds: [asha.id] }))).ok);

    section("10. A workspace not migrated yet");
    await db.$executeRawUnsafe('DROP TABLE "lead_assignments" CASCADE');
    await db.$executeRawUnsafe('ALTER TABLE "lead_assignment_rules" DROP COLUMN "countries", DROP COLUMN "cities", DROP COLUMN "pincodes", DROP COLUMN "customerCategoryIds", DROP COLUMN "itemIds", DROP COLUMN "responseHours"');
    const bare = await assign.chooseOwner({ brandIds: [], itemTypes: [], designation: null, source: "WEBSITE", state: null, companyOwnerId: null });
    ok("the rules still choose, without the newer conditions", !!bare);
    ok("  the sweep has nothing to do", (await response.leadResponseChores(new Date())) === null);
    ok("  the settings page lists the rules", ((await ruleActions.listAssignmentRules())?.rules.length ?? 0) > 0);
    const bareOwnership = await ownerActions.leadOwnership(mine.id);
    ok("  the lead page has no history, and still offers Reassign", !!bareOwnership && bareOwnership.history.length === 0 && bareOwnership.mayChange);
  } finally {
    actor = null;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} lead assignment checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
