/**
 * check:renewal-reminders — a salesperson's own "Remind me" on a renewal (owner, 31 Oct 2026 —
 * src/lib/renewal-reminders.ts, src/actions/renewal-reminder.ts).
 *
 *   1. Set: their task, due the day picked, with their note, and the renewal row finds it.
 *   2. Set again: the same reminder moved, not a second one.
 *   3. The bell rings on the day.
 *   4. "My reminders" lists the renewals they asked about, and nothing else.
 *   5. Done: the task ticked off, the row and the list clear.
 *   6. Only on a renewal they can see.
 *   7. The same on a lead.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:renewal-reminders
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
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_remindme`;
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
    const lib = require("../src/lib/renewal-reminders") as typeof import("../src/lib/renewal-reminders");
    const action = require("../src/actions/renewal-reminder") as typeof import("../src/actions/renewal-reminder");
    const renewal = require("../src/actions/renewal") as typeof import("../src/actions/renewal");
    const { syncSystemNotifications } = require("../src/lib/notify") as typeof import("../src/lib/notify");
    const leadLib = require("../src/lib/lead-reminders") as typeof import("../src/lib/lead-reminders");
    const leadAction = require("../src/actions/lead-reminder") as typeof import("../src/actions/lead-reminder");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const person = (name: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-remind.in`, passwordHash: "!", role: "SALES", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const boss = await person("Zz Boss", { role: "ADMIN", isSuperAdmin: true });
    const outsider = await person("Zz Outsider");
    const as = (u: { id: string; name: string; email: string | null; role: string }) => (actor = { id: u.id, name: u.name, email: u.email!, role: u.role });
    const books = await db.item.create({ data: { name: "Zz Books", sku: "ZZ-REMIND", type: "SUBSCRIPTION", billingCycle: "ANNUAL", sellingPrice: 12000, createdById: boss.id }, select: { id: true } });
    const customer = async (name: string) => {
      const c = await db.company.create({ data: { name, normalizedName: name.toLowerCase(), relationshipType: "CLIENT", stage: "CUSTOMER", createdById: boss.id, ownerUserId: boss.id }, select: { id: true } });
      const site = await db.companyLocation.create({ data: { companyId: c.id, label: "HO", isPrimary: true, city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" }, select: { id: true } });
      return { ...c, siteId: site.id };
    };
    // The workspace's today, as a calendar day is held — not UTC's, which is yesterday in India before 5:30 am.
    const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace"); // eslint-disable-line @typescript-eslint/no-require-imports
    const today = (await workspaceClock()).calendarDate(new Date());
    const ending = async (c: { id: string; siteId: string }, daysLeft: number) =>
      db.companyProduct.create({
        data: { companyId: c.id, locationId: c.siteId, itemId: books.id, addedByUserId: boss.id, quantity: 1, unitPrice: 12000, fullTermUnitPrice: 12000, startDate: new Date(today.getTime() - (365 - daysLeft) * DAY), endDate: new Date(today.getTime() + daysLeft * DAY), orderStatus: "FULFILLED" },
        select: { id: true, orderSeq: true, companyId: true },
      });
    const acme = await customer("Zz Acme");
    const beta = await customer("Zz Beta");
    const acmeBooks = await ending(acme, 40);
    const betaBooks = await ending(beta, 20);
    const inAWeek = new Date(today.getTime() + 7 * DAY).toISOString().slice(0, 10);
    const todayDay = today.toISOString().slice(0, 10);
    as(boss);

    section("1. Set");
    const set = await action.setRenewalReminder({ orderId: acmeBooks.id, remindOn: inAWeek, note: "  Call Ravi after budget  " });
    const mine = await lib.myRemindersFor(boss.id, [acmeBooks, betaBooks]);
    ok("their reminder on Acme, for the day picked, with the note", set.ok && mine.get(acmeBooks.id)?.remindOn === inAWeek && mine.get(acmeBooks.id)?.note === "Call Ravi after budget" && !mine.has(betaBooks.id), Object.fromEntries(mine));
    const task = await db.task.findFirst({ where: { assignedToUserId: boss.id, companyId: acme.id }, select: { title: true, dueDate: true, done: true } });
    ok("  a task of theirs, naming the order", !!task && task.title.startsWith("Renewal reminder — ORD-") && lib.orderSeqOfReminder(task.title) === acmeBooks.orderSeq && !task.done, task?.title);

    section("2. Set again");
    await action.setRenewalReminder({ orderId: acmeBooks.id, remindOn: todayDay, note: "Sooner" });
    const tasks = await db.task.count({ where: { assignedToUserId: boss.id, companyId: acme.id, done: false } });
    ok("the same reminder moved, not a second", tasks === 1 && (await lib.myRemindersFor(boss.id, [acmeBooks])).get(acmeBooks.id)?.remindOn === todayDay);

    section("3. The bell");
    const reminderTask = await db.task.findFirst({ where: { assignedToUserId: boss.id, companyId: acme.id, done: false }, select: { id: true } });
    const bell = await syncSystemNotifications(boss.id);
    ok("on the day, it rings", bell.some((n) => n.dedupeKey === `task-due:${reminderTask!.id}`), bell.map((n) => n.dedupeKey));

    section("4. My reminders");
    const listed = await renewal.listRenewalsPaged({ window: "reminders", page: 1, pageSize: 50 });
    ok("only the renewal they asked about", listed.rows.length === 1 && listed.rows[0]!.id === acmeBooks.id, listed.rows.map((r) => r.id));
    ok("  and the row carries the reminder", (listed.rows[0] as { myReminder?: { remindOn: string } | null }).myReminder?.remindOn === todayDay);
    const everything = await renewal.listRenewalsPaged({ page: 1, pageSize: 50 });
    ok("  the full list still shows both, Beta without one", everything.rows.length === 2 && (everything.rows.find((r) => r.id === betaBooks.id) as { myReminder?: unknown }).myReminder === null);

    section("5. Done");
    const cleared = await action.clearRenewalReminder(acmeBooks.id);
    ok("the task ticked off", cleared.ok && (await db.task.count({ where: { assignedToUserId: boss.id, companyId: acme.id, done: true } })) === 1);
    ok("  the row and the list clear", (await lib.myRemindersFor(boss.id, [acmeBooks])).size === 0 && (await renewal.listRenewalsPaged({ window: "reminders", page: 1, pageSize: 50 })).rows.length === 0);

    section("6. Only on a renewal they can see");
    as(outsider);
    ok("somebody outside the account can't set one", !(await action.setRenewalReminder({ orderId: betaBooks.id, remindOn: inAWeek })).ok);
    as(boss);
    ok("  nor without a day", !(await action.setRenewalReminder({ orderId: betaBooks.id, remindOn: "" })).ok);

    section("7. On a lead");
    const stage = await db.leadStage.findFirst({ where: { status: "NEW" }, select: { id: true, pipelineId: true } });
    const lead = await db.lead.create({ data: { title: "Microsoft 365 — Zz Acme", status: "NEW", stageId: stage!.id, pipelineId: stage!.pipelineId, companyId: acme.id, createdByUserId: boss.id, ownerUserId: boss.id }, select: { id: true } });
    const onLead = await leadAction.setLeadReminder({ leadId: lead.id, remindOn: inAWeek, note: "Follow up on the quote" });
    const leadTask = await db.task.findFirst({ where: { leadId: lead.id, assignedToUserId: boss.id, done: false }, select: { id: true, title: true } });
    ok("their task on the lead, for the day picked, with the note", onLead.ok && !!leadTask && leadTask.title.startsWith("Lead reminder — LEAD-") && (await leadLib.myLeadRemindersFor(boss.id, [lead.id])).get(lead.id)?.note === "Follow up on the quote");
    await leadAction.setLeadReminder({ leadId: lead.id, remindOn: todayDay });
    ok("  set again: moved, not a second", (await db.task.count({ where: { leadId: lead.id, done: false } })) === 1 && (await leadLib.myLeadRemindersFor(boss.id, [lead.id])).get(lead.id)?.remindOn === todayDay);
    ok("  the bell rings on the day", (await syncSystemNotifications(boss.id)).some((n) => n.dedupeKey === `task-due:${leadTask!.id}`));
    ok("  done: cleared", (await leadAction.clearLeadReminder(lead.id)).ok && (await leadLib.myLeadRemindersFor(boss.id, [lead.id])).size === 0);
    as(outsider);
    ok("  somebody who can't see the lead can't set one", !(await leadAction.setLeadReminder({ leadId: lead.id, remindOn: inAWeek })).ok);
    as(boss);
  } finally {
    actor = null;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `
All ${passes} renewal reminder checks passed.
` : `
${failures} check(s) FAILED (${passes} passed).
`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
