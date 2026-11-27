/**
 * check:renewal-watch — renewals nobody misses (owner, 30 Oct 2026 — src/lib/renewal-watch-rules.ts).
 *
 *   1. The ladder: the step a renewal is on, and its key — the 30-day one keeps the old single reminder's.
 *   2. Reminded: the account manager; the customer's renewal manager instead where there is one, and the account manager
 *      again once that one has left; nothing renewed, Lost, cancelled or past the furthest step.
 *   3. Nobody still here: every admin, saying so.
 *   4. Not started: the renewal manager's manager told with 15 days left, the admins with 7; not once a call is logged.
 *   5. Monday's list.
 *   6. The renewal task raised ahead: for the renewal manager, due a week before the end, once a term.
 *   7. Renewals › At risk — not started.
 *   8. Settings › Renewals: the days kept; reminders and escalations off.
 *   9. A workspace not migrated yet: the defaults.
 *  10. Owner, 11 Nov 2026 — where a renewal could still slip: a renewal order cancelled or refused frees its
 *      subscription; lapsed goes to the renewal manager; started then gone quiet is escalated; a subscription with no
 *      end date is counted and listed; renewal reminders are emailed unless an admin switches them off.
 *  11. Owner, 11 Nov 2026 — yearly services: an AMC entered as a plain service is found, by its orders' terms or by
 *      its name, and answered once — watched like any subscription from then, or marked sold once.
 *  12. Owner, 23 Nov 2026 — the team's reminder emails copied: Settings › Renewals' addresses (the company's own only),
 *      on each step of the ladder's email, once however many it goes to; not on the escalations.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:renewal-watch
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { directClient } from "../src/lib/tenancy/direct-client";
import { ladderStep, reminderKey } from "../src/lib/renewal-watch-rules";

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
// A page rendered here has no app router around it: the buttons on it only need one to exist.
const navigation = { ...(load("next/navigation") as Record<string, unknown>), useRouter: () => ({ refresh: () => {}, push: () => {}, replace: () => {} }) };
const byName = new Map<string, unknown>([
  ["next/navigation", navigation],
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
  section("1. The ladder");
  const steps = [60, 30, 15, 7, 1];
  ok("12 days left: the 15-day step, late rather than lost", ladderStep(12, steps) === 15);
  ok("  30 left: the 30; 61 left: none yet; 0 left: the 1; ended: none", ladderStep(30, steps) === 30 && ladderStep(61, steps) === null && ladderStep(0, steps) === 1 && ladderStep(-1, steps) === null);
  ok("  the 30-day step keeps the old reminder's key; the others their own", reminderKey("o1", 30) === "renewal-expiring:o1" && reminderKey("o1", 15) === "renewal-remind:o1:15");

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_renewwatch`;
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
    const watch = require("../src/lib/renewal-watch") as typeof import("../src/lib/renewal-watch");
    const lapse = require("../src/lib/renewal-lapse") as typeof import("../src/lib/renewal-lapse");
    const settings = require("../src/actions/renewal-settings") as typeof import("../src/actions/renewal-settings");
    const renewals = require("../src/actions/renewal") as typeof import("../src/actions/renewal");
    const { syncSystemNotifications } = require("../src/lib/notify") as typeof import("../src/lib/notify");
    const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const person = (name: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-watch.in`, passwordHash: "!", role: "SALES", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const boss = await person("Zz Boss", { role: "ADMIN", isSuperAdmin: true });
    const head = await person("Zz Head", { role: "SALES_MANAGER" });
    const rep = await person("Zz Rep", { managerId: head.id });
    const keeper = await person("Zz Keeper", { managerId: head.id });
    const gone = await person("Zz Gone", { active: false });
    actor = { id: boss.id, name: boss.name, email: boss.email!, role: boss.role };

    const clock = await workspaceClock();
    const today = clock.calendarDate(new Date());
    const books = await db.item.create({ data: { name: "Zz Books", sku: "ZZ-BOOKS", type: "SUBSCRIPTION", billingCycle: "ANNUAL", sellingPrice: 12000, createdById: boss.id } });
    const customer = async (name: string, extra: Record<string, unknown> = {}) => {
      const company = await db.company.create({ data: { name, normalizedName: name.toLowerCase(), relationshipType: "CLIENT", stage: "CUSTOMER", createdById: boss.id, ownerUserId: rep.id, ...extra }, select: { id: true } });
      const site = await db.companyLocation.create({ data: { companyId: company.id, label: "HO", isPrimary: true, city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" } });
      return { ...company, siteId: site.id };
    };
    const ending = (c: { id: string; siteId: string }, daysLeft: number, extra: Record<string, unknown> = {}) =>
      db.companyProduct.create({
        data: {
          companyId: c.id,
          locationId: c.siteId,
          itemId: books.id,
          addedByUserId: rep.id,
          quantity: 1,
          unitPrice: 12000,
          fullTermUnitPrice: 12000,
          startDate: new Date(today.getTime() - (365 - daysLeft) * DAY),
          endDate: new Date(today.getTime() + daysLeft * DAY),
          orderStatus: "FULFILLED",
          ...extra,
        },
        select: { id: true },
      });
    const keysFor = async (userId: string) => (await syncSystemNotifications(userId)).map((n) => n.dedupeKey);

    section("2. Reminded");
    const acme = await customer("Zz Acme");
    const in12 = await ending(acme, 12);
    const in30 = await ending(acme, 30);
    const in90 = await ending(acme, 90);
    const lost = await ending(acme, 10, { renewalStage: "LOST" });
    const cancelled = await ending(acme, 10, { orderStatus: "CANCELLED" });
    const renewed = await ending(acme, 10);
    await ending(acme, 375, { renewedFromId: renewed.id, businessType: "RENEWAL" });
    const repKeys = await keysFor(rep.id);
    ok("the account manager: 12 days left is the 15-day reminder, 30 the 30-day one", repKeys.includes(reminderKey(in12.id, 15)) && repKeys.includes(reminderKey(in30.id, 30)), repKeys.filter((k) => k.startsWith("renewal-")));
    ok("  nothing past the furthest step, Lost, cancelled or renewed", ![in90.id, lost.id, cancelled.id, renewed.id].some((id) => repKeys.some((k) => k.includes(id))));
    await syncSystemNotifications(rep.id);
    ok("  once", (await db.notification.count({ where: { userId: rep.id, dedupeKey: reminderKey(in12.id, 15) } })) === 1);

    const kept = await customer("Zz Kept", { renewalManagerId: keeper.id });
    const keptSub = await ending(kept, 6);
    ok("the customer's renewal manager instead of its account manager", (await keysFor(keeper.id)).includes(reminderKey(keptSub.id, 7)) && !(await keysFor(rep.id)).some((k) => k.includes(keptSub.id)));
    const left = await customer("Zz Left", { renewalManagerId: gone.id });
    const leftSub = await ending(left, 6);
    ok("  a renewal manager who has left: the account manager again", (await keysFor(rep.id)).includes(reminderKey(leftSub.id, 7)));

    section("3. Nobody still here");
    const orphan = await customer("Zz Orphan", { ownerUserId: null });
    const orphanSub = await ending(orphan, 25);
    const bossKeys = await keysFor(boss.id);
    ok("every admin is told it has nobody", bossKeys.includes(`renewal-nobody:${orphanSub.id}:30`), bossKeys.filter((k) => k.startsWith("renewal-")));
    const nobody = (await db.notification.findFirst({ where: { userId: boss.id, dedupeKey: `renewal-nobody:${orphanSub.id}:30` }, select: { title: true } }))?.title ?? "";
    ok("  saying so", nobody.includes("nobody looks after it"), nobody);
    // Owner, 30 Oct 2026: the admin chooses who hears about them instead.
    const refusedGone = await settings.saveRenewalSettings({ lapseLostAfterDays: 15, nobodyRecipientIds: [gone.id] });
    ok("Choosing somebody who has left is refused", !refusedGone.ok);
    const chose = await settings.saveRenewalSettings({ lapseLostAfterDays: 15, nobodyRecipientIds: [head.id] });
    ok("Settings › Renewals takes the people chosen", chose.ok && (await lapse.renewalConfig()).nobodyRecipientIds.join() === head.id, chose);
    const orphan2 = await customer("Zz Orphan Two", { ownerUserId: null });
    const orphan2Sub = await ending(orphan2, 13);
    ok("  a renewal nobody looks after goes to them", (await keysFor(head.id)).includes(`renewal-nobody:${orphan2Sub.id}:15`));
    ok("  and not to the admins", !(await keysFor(boss.id)).includes(`renewal-nobody:${orphan2Sub.id}:15`));
    const cleared = await settings.saveRenewalSettings({ lapseLostAfterDays: 15, nobodyRecipientIds: [] });
    ok("None chosen: every admin again", cleared.ok && (await lapse.renewalConfig()).nobodyRecipientIds.length === 0);

    section("4. Not started");
    const headKeys = await keysFor(head.id);
    ok("15 days left, nobody's called or quoted: the renewal manager's manager is told", headKeys.includes(`renewal-escalate:${in12.id}`) && headKeys.includes(`renewal-escalate:${keptSub.id}`), headKeys.filter((k) => k.startsWith("renewal-")));
    ok("  not past 15 days", !headKeys.includes(`renewal-escalate:${in30.id}`));
    const named = (await db.notification.findFirst({ where: { userId: head.id, dedupeKey: `renewal-escalate:${keptSub.id}` }, select: { message: true } }))?.message ?? "";
    ok("  naming whose it is", named.includes("Zz Keeper"), named);
    ok("7 days left: the admins too", bossKeys.includes(`renewal-escalate-admin:${keptSub.id}`) && !bossKeys.includes(`renewal-escalate-admin:${in12.id}`));
    const called = await ending(acme, 9);
    await db.callLog.create({ data: { companyId: acme.id, companyProductId: called.id, phoneNumber: "+919800000000", outcome: "CONNECTED", startedAt: new Date(), userId: rep.id } });
    ok("  not once a call is logged against it", !(await keysFor(head.id)).includes(`renewal-escalate:${called.id}`));

    section("5. Monday's list");
    let monday = new Date();
    while (clock.parts(monday).weekday !== 1) monday = new Date(monday.getTime() + DAY);
    const mondayDay = clock.calendarDate(monday).toISOString().slice(0, 10);
    const onMonday = await syncSystemNotifications(rep.id, { now: monday });
    const week = onMonday.find((n) => n.dedupeKey === `renewal-week:${mondayDay}`);
    ok("the renewal manager gets the week's list on a Monday", Boolean(week), onMonday.map((n) => n.dedupeKey).filter((k) => k.startsWith("renewal-week")));
    const headWeek = (await syncSystemNotifications(head.id, { now: monday })).find((n) => n.dedupeKey === `renewal-week:${mondayDay}`);
    ok("  their manager gets the team's", Boolean(headWeek?.message?.includes("your team")), headWeek?.message);
    const notMonday = new Date(monday.getTime() + DAY);
    ok("  not on a Tuesday", !(await syncSystemNotifications(rep.id, { now: notMonday })).some((n) => n.dedupeKey.startsWith("renewal-week:")));

    section("6. The renewal task raised ahead");
    const run = await watch.runRenewalTasks(new Date());
    const task = await db.task.findFirst({ where: { companyId: kept.id, title: "Renew Zz Books — Zz Kept" }, select: { assignedToUserId: true, dueDate: true } });
    ok("raised for the renewal manager", run.raised > 0 && task?.assignedToUserId === keeper.id, run);
    ok("  due a week before the end, or today where that's past", task?.dueDate?.getTime() === today.getTime());
    ok("  one per customer and product, however many of its orders come up", (await db.task.count({ where: { companyId: acme.id, title: "Renew Zz Books — Zz Acme" } })) === 1);
    ok("  run again: nothing more", (await watch.runRenewalTasks(new Date())).raised === 0);
    await db.task.updateMany({ where: { companyId: kept.id }, data: { done: true } });
    ok("  closed this term: not raised again", (await watch.runRenewalTasks(new Date())).raised === 0);
    ok("  the list reads Task raised for it", ((await renewals.listRenewalsPaged({ window: "30", page: 1, pageSize: 50 })).rows.find((r) => r.id === in12.id)?.stage.key ?? "") === "TASK_RAISED");

    section("7. Renewals › At risk — not started");
    const atRisk = (await renewals.listRenewalsPaged({ window: "atrisk", page: 1, pageSize: 50 })).rows.map((r) => r.id);
    ok("within 30 days and not started: listed", atRisk.includes(in12.id) && atRisk.includes(keptSub.id), atRisk.length);
    ok("  not one called, Lost, cancelled, renewed or 90 days out", ![called.id, lost.id, cancelled.id, renewed.id, in90.id].some((id) => atRisk.includes(id)));

    section("10. A renewal order cancelled or refused frees its subscription");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const orders = require("../src/actions/order") as typeof import("../src/actions/order");
    const renewalOrder = require("../src/actions/renewal-order") as typeof import("../src/actions/renewal-order");
    const undated = require("../src/lib/renewals-undated") as typeof import("../src/lib/renewals-undated");
    const emailSettings = require("../src/lib/notifications/email-settings") as typeof import("../src/lib/notifications/email-settings");
    const fs = require("node:fs") as typeof import("node:fs");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const zed = await customer("Zz Zed");
    const backedOut = await ending(zed, 20);
    await db.recurringBilling.create({ data: { companyProductId: backedOut.id, mode: "AUTO_RENEW", setById: boss.id } });
    const itsRenewal = await ending(zed, 385, { renewedFromId: backedOut.id, businessType: "RENEWAL", orderStatus: "APPROVED" });
    ok("renewed: no reminder", !(await keysFor(rep.id)).some((k) => k.includes(backedOut.id)));
    const cancelledIt = await orders.cancelOrder(itsRenewal.id, "The customer backed out");
    ok("the renewal order is cancelled", cancelledIt.ok, cancelledIt);
    ok("  it no longer renews anything", (await db.companyProduct.findUnique({ where: { id: itsRenewal.id }, select: { renewedFromId: true } }))?.renewedFromId === null);
    ok("  the subscription is reminded about again", (await keysFor(rep.id)).includes(reminderKey(backedOut.id, 30)));
    ok("  auto-renew is off on it, so the next billing run doesn't raise the same renewal", (await db.recurringBilling.count({ where: { companyProductId: backedOut.id } })) === 0);
    ok("  the audit trail says it's open again", (await db.auditLog.count({ where: { entityId: backedOut.id, entityLabel: { contains: "open to renew again" } } })) === 1);
    const again = await renewalOrder.renewalDraft(backedOut.id);
    ok("  Renew is offered again", !!again && !again.alreadyRenewed, again?.alreadyRenewed);

    const refusedSub = await ending(zed, 18);
    const refusedRenewal = await ending(zed, 383, { renewedFromId: refusedSub.id, businessType: "RENEWAL", orderStatus: "PENDING_APPROVAL" });
    const refusal = await orders.approveOrder({ orderId: refusedRenewal.id, approved: false, notes: "Wrong price" });
    ok("refused at approval: freed the same way", refusal.ok && (await db.companyProduct.findUnique({ where: { id: refusedRenewal.id }, select: { renewedFromId: true } }))?.renewedFromId === null, refusal);
    const approvedSub = await ending(zed, 17);
    const approvedRenewal = await ending(zed, 382, { renewedFromId: approvedSub.id, businessType: "RENEWAL", orderStatus: "PENDING_APPROVAL" });
    const approval = await orders.approveOrder({ orderId: approvedRenewal.id, approved: true });
    ok("  approved: still its renewal", approval.ok && (await db.companyProduct.findUnique({ where: { id: approvedRenewal.id }, select: { renewedFromId: true } }))?.renewedFromId === approvedSub.id, approval);

    // The ones already there: the migration's own statements, run again over a link left the old way.
    const oldSub = await ending(zed, 16);
    await db.recurringBilling.create({ data: { companyProductId: oldSub.id, mode: "AUTO_RENEW", setById: boss.id } });
    const oldDead = await ending(zed, 381, { renewedFromId: oldSub.id, businessType: "RENEWAL", orderStatus: "CANCELLED" });
    const sql = fs.readFileSync("prisma/migrations/20261211120000_release_dead_renewals/migration.sql", "utf8");
    for (const statement of sql.split(";").map((part) => part.replace(/^\s*--.*$/gm, "").trim()).filter(Boolean)) await db.$executeRawUnsafe(statement);
    ok(
      "a link left by an order cancelled before this: the migration frees it, and stops its auto-renew",
      (await db.companyProduct.findUnique({ where: { id: oldDead.id }, select: { renewedFromId: true } }))?.renewedFromId === null && (await db.recurringBilling.count({ where: { companyProductId: oldSub.id } })) === 0,
    );
    ok("  a live renewal is left alone", (await db.companyProduct.findUnique({ where: { id: approvedRenewal.id }, select: { renewedFromId: true } }))?.renewedFromId === approvedSub.id);

    section("10. Lapsed: told to whoever its renewals land with");
    const lapsedKept = await ending(kept, -3);
    ok("the customer's renewal manager is told it lapsed", (await keysFor(keeper.id)).includes(`renewal-lapsed:${lapsedKept.id}`));
    ok("  not its account manager, whose it isn't", !(await keysFor(rep.id)).includes(`renewal-lapsed:${lapsedKept.id}`));
    const lapsedLeft = await ending(left, -3);
    ok("  a renewal manager who has left: the account manager", (await keysFor(rep.id)).includes(`renewal-lapsed:${lapsedLeft.id}`));
    const longLapsed = await ending(kept, -20);
    const lapseRun = await lapse.runRenewalLapses(new Date());
    const toldLost = async (userId: string) => (await db.notification.count({ where: { userId, title: "A subscription lapsed", message: { contains: "Zz Kept" } } })) > 0;
    ok("called Lost after the days: its renewal manager and their manager hear", lapseRun.marked >= 1 && (await db.companyProduct.findUnique({ where: { id: longLapsed.id }, select: { renewalStage: true } }))?.renewalStage === "LOST" && (await toldLost(keeper.id)) && (await toldLost(head.id)), lapseRun);
    ok("  not the account manager", !(await toldLost(rep.id)));

    section("10. Started, then gone quiet");
    const longAgo = new Date(Date.now() - 10 * DAY);
    const quietSub = await ending(acme, 11);
    await db.callLog.create({ data: { companyId: acme.id, companyProductId: quietSub.id, phoneNumber: "+919800000000", outcome: "CONNECTED", startedAt: longAgo, userId: rep.id } });
    const quietSoon = await ending(acme, 4);
    await db.callLog.create({ data: { companyId: acme.id, companyProductId: quietSoon.id, phoneNumber: "+919800000000", outcome: "CONNECTED", startedAt: longAgo, userId: rep.id } });
    const moving = await ending(acme, 11, { renewalStage: "NEGOTIATING", renewalStageAt: new Date(Date.now() - DAY) });
    await db.callLog.create({ data: { companyId: acme.id, companyProductId: moving.id, phoneNumber: "+919800000000", outcome: "CONNECTED", startedAt: longAgo, userId: rep.id } });
    const headQuiet = await keysFor(head.id);
    ok("called ten days ago and nothing since, 11 days left: the manager is told", headQuiet.includes(`renewal-quiet:${quietSub.id}`), headQuiet.filter((k) => k.startsWith("renewal-quiet")));
    ok("  it is no longer 'not started'", !headQuiet.includes(`renewal-escalate:${quietSub.id}`));
    ok("  not one called today, nor one whose stage changed yesterday", !headQuiet.includes(`renewal-quiet:${called.id}`) && !headQuiet.includes(`renewal-quiet:${moving.id}`));
    const bossQuiet = await keysFor(boss.id);
    ok("4 days left: the admins too, and not the one with 11", bossQuiet.includes(`renewal-quiet-admin:${quietSoon.id}`) && !bossQuiet.includes(`renewal-quiet-admin:${quietSub.id}`));
    const said = (await db.notification.findFirst({ where: { userId: head.id, dedupeKey: `renewal-quiet:${quietSub.id}` }, select: { title: true, message: true } })) ?? { title: "", message: "" };
    ok("  saying who started it and how long it's been", said.title.startsWith("Renewal gone quiet") && !!said.message?.includes("Zz Rep") && !!said.message?.includes("7 days"), said);
    const atRiskNow = (await renewals.listRenewalsPaged({ window: "atrisk", page: 1, pageSize: 100 })).rows.map((r) => r.id);
    ok("Renewals › At risk lists it too, and still not the one called today", atRiskNow.includes(quietSub.id) && atRiskNow.includes(in12.id) && !atRiskNow.includes(called.id) && !atRiskNow.includes(moving.id));

    section("10. No end date");
    const openEnded = await ending(acme, 40, { endDate: null });
    const openEndedLost = await ending(acme, 40, { endDate: null, renewalStage: "LOST" });
    ok("nothing reminds anybody about it", !(await keysFor(rep.id)).some((k) => k.includes(openEnded.id)));
    const listed = await undated.listUndated();
    ok("Renewals › No end date lists it, with whose it is", listed.rows.some((r) => r.id === openEnded.id && r.lookedAfterBy === "Zz Rep") && !listed.rows.some((r) => r.id === openEndedLost.id), listed.total);
    ok("  and counts it for the link on Renewals", (await undated.undatedCount()) === listed.total && listed.total >= 1);
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
    const { default: NoEndDatePage } = require("../src/app/(dashboard)/renewals/no-end-date/page") as typeof import("../src/app/(dashboard)/renewals/no-end-date/page");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const pageHtml = renderToStaticMarkup(await NoEndDatePage());
    ok("  the page shows it, opening its order to enter the date", pageHtml.includes("Zz Acme") && pageHtml.includes("Open the order") && pageHtml.includes("Zz Rep") && pageHtml.includes('href="/orders/ORD-'), pageHtml.length);
    const repMonday = (await syncSystemNotifications(rep.id, { now: new Date(monday.getTime() + 7 * DAY) })).find((n) => n.dedupeKey.startsWith("renewal-week:"));
    ok("Monday's list counts it for its renewal manager", !!repMonday?.message?.includes("1 with no end date"), repMonday?.message);
    const bossMonday = (await syncSystemNotifications(boss.id, { now: new Date(monday.getTime() + 7 * DAY) })).find((n) => n.dedupeKey.startsWith("renewal-undated:"));
    ok("  and the admins are told how many there are in all", !!bossMonday && bossMonday.link === "/renewals/no-end-date" && bossMonday.title.includes("no end date"), bossMonday?.title);
    await db.companyProduct.update({ where: { id: openEnded.id }, data: { endDate: new Date(today.getTime() + 25 * DAY) } });
    ok("given its end date: off that list, and reminded about", !(await undated.listUndated()).rows.some((r) => r.id === openEnded.id) && (await keysFor(rep.id)).includes(reminderKey(openEnded.id, 30)));

    section("10. Renewal reminders are emailed unless an admin says no");
    ok("nobody has chosen: emailed, and the scheduled sweep looks for them", (await emailSettings.isEmailed("RENEWAL_EXPIRING")) && (await emailSettings.sweptReminderKinds()).has("RENEWAL_EXPIRING") && (await emailSettings.emailedTypes()).has("RENEWAL_EXPIRING"));
    ok("  the other reminders stay as they were", !(await emailSettings.sweptReminderKinds()).has("TASK_DUE"));
    await emailSettings.setEmailed("RENEWAL_EXPIRING", false, boss.id);
    ok("an admin switches it off: not emailed, not swept", !(await emailSettings.isEmailed("RENEWAL_EXPIRING")) && !(await emailSettings.sweptReminderKinds()).has("RENEWAL_EXPIRING"));
    const onAt = new Date();
    await emailSettings.setEmailed("RENEWAL_EXPIRING", true, boss.id, onAt);
    ok("  and on again: from then", (await emailSettings.sweptReminderKinds()).get("RENEWAL_EXPIRING")?.getTime() === onAt.getTime());

    section("11. Yearly services, an AMC say");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const unwatched = require("../src/lib/renewals-unwatched") as typeof import("../src/lib/renewals-unwatched");
    const itemActions = require("../src/actions/item") as typeof import("../src/actions/item");
    const { default: NotWatchedPage } = require("../src/app/(dashboard)/items/renewing-services/page") as typeof import("../src/app/(dashboard)/items/renewing-services/page");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const service = (name: string, extra: Record<string, unknown> = {}) => db.item.create({ data: { name, sku: name.toUpperCase().replace(/\W+/g, "-"), type: "SERVICE", sellingPrice: 30000, createdById: boss.id, ...extra }, select: { id: true } });
    const amc = await service("Zz Server AMC");
    const amcOrder = await ending(acme, 20, { itemId: amc.id });
    await ending(acme, -40, { itemId: amc.id });
    const namedPlan = await service("Zz Annual support plan");
    await ending(acme, 0, { itemId: namedPlan.id, endDate: null });
    const install = await service("Zz Installation");
    await ending(acme, 0, { itemId: install.id, endDate: null });
    const camcorder = await service("Zz Camcorder repair, annually");
    await ending(acme, 0, { itemId: camcorder.id, endDate: null });
    const perpetual = await service("Zz Perpetual licence", { category: "Perpetual licence" });
    await ending(acme, 20, { itemId: perpetual.id });
    const retired = await service("Zz Old AMC", { active: false });
    await ending(acme, 20, { itemId: retired.id });
    const goods = await db.item.create({ data: { name: "Zz Annual planner", sku: "ZZ-PLANNER", type: "GOOD", sellingPrice: 500, createdById: boss.id }, select: { id: true } });
    await ending(acme, 20, { itemId: goods.id });

    ok("an AMC entered as a plain service: nothing reminds anybody", !(await keysFor(rep.id)).some((k) => k.includes(amcOrder.id)));
    const found = await unwatched.listUnwatchedServices();
    const foundAmc = found.find((f) => f.id === amc.id);
    ok("Items › Services that renew finds it by its orders' terms: one running, one ended this year", !!foundAmc && foundAmc.running === 1 && foundAmc.ended === 1 && !foundAmc.byName && foundAmc.nextEnd?.getTime() === today.getTime() + 20 * DAY, foundAmc);
    ok("  and one sold lately whose name says so, though no order has a term", found.find((f) => f.id === namedPlan.id)?.byName === true);
    ok("  the ones with running terms first", found[0]?.id === amc.id, found.map((f) => f.name));
    ok(
      "  not a one-off job, a name that only contains the letters, a perpetual licence, an item no longer sold, or goods",
      ![install.id, camcorder.id, perpetual.id, retired.id, goods.id, books.id].some((id) => found.some((f) => f.id === id)),
      found.map((f) => f.name),
    );
    ok("  counted for the link on Renewals", (await unwatched.unwatchedServiceCount()) === found.length && found.length === 2, found.length);
    const laterMonday = new Date(monday.getTime() + 14 * DAY);
    const bossTold = (await syncSystemNotifications(boss.id, { now: laterMonday })).find((n) => n.dedupeKey.startsWith("renewal-unwatched:"));
    ok("on Monday the admins are told how many", !!bossTold && bossTold.link === "/items/renewing-services" && bossTold.title.startsWith("2 services look"), bossTold?.title);
    ok("  not a rep", !(await syncSystemNotifications(rep.id, { now: laterMonday })).some((n) => n.dedupeKey.startsWith("renewal-unwatched:")));
    const notWatchedHtml = renderToStaticMarkup(await NotWatchedPage());
    ok("the page lists them, each with its two answers", notWatchedHtml.includes("Zz Server AMC") && notWatchedHtml.includes("Zz Annual support plan") && notWatchedHtml.includes("Watch for renewal") && notWatchedHtml.includes("1 order has a term running now"), notWatchedHtml.length);

    const watched = await itemActions.setServiceRenews(amc.id, true);
    ok("Watch for renewal: it's managed as a subscription", watched.ok && (await db.item.findUnique({ where: { id: amc.id }, select: { type: true } }))?.type === "SUBSCRIPTION", watched);
    ok("  its order is reminded about like any other", (await keysFor(rep.id)).includes(reminderKey(amcOrder.id, 30)));
    ok("  and it's on Renewals", (await renewals.listRenewalsPaged({ window: "30", page: 1, pageSize: 100 })).rows.some((r) => r.id === amcOrder.id));
    const again2 = await itemActions.setServiceRenews(amc.id, true);
    ok("  asked again: already one", !again2.ok && again2.error.includes("already"), again2);
    const once = await itemActions.setServiceRenews(namedPlan.id, false);
    ok("It doesn't renew: sold once, still a service", once.ok && JSON.stringify(await db.item.findUnique({ where: { id: namedPlan.id }, select: { type: true, billingCycle: true } })) === JSON.stringify({ type: "SERVICE", billingCycle: "ONE_TIME" }), once);
    ok("  neither is asked about again", (await unwatched.listUnwatchedServices()).length === 0);
    ok("  both answers are in the audit trail", (await db.auditLog.count({ where: { entityId: { in: [amc.id, namedPlan.id] }, entityLabel: { contains: "renew" } } })) === 2);
    ok("  goods can't be watched", !(await itemActions.setServiceRenews(goods.id, true)).ok);

    section("8. Settings › Renewals");
    const view = await settings.renewalSettingsView();
    ok("the defaults read back", view.ok && view.data.watchMigrated && view.data.watch.reminderDays.join(",") === "60,30,15,7,1" && view.data.watch.escalateManagerDays === 15);
    const repActor = { id: rep.id, name: rep.name, email: rep.email!, role: rep.role };
    actor = repActor;
    ok("a rep can't change them", !(await settings.saveRenewalSettings({ lapseLostAfterDays: 15, reminderDays: [3] })).ok);
    actor = { id: boss.id, name: boss.name, email: boss.email!, role: boss.role };
    const saved = await settings.saveRenewalSettings({ lapseLostAfterDays: 15, reminderDays: [10, 45, 10], escalateManagerDays: null, escalateAdminDays: 3, taskLeadDays: null, weeklyList: false });
    const back = await lapse.renewalConfig();
    ok("kept, the days without repeats, furthest first", saved.ok && back.watch.reminderDays.join(",") === "45,10" && back.watch.escalateManagerDays === null && back.watch.taskLeadDays === null && !back.watch.weeklyList, back.watch);
    const fresh = await customer("Zz Fresh", { ownerUserId: keeper.id });
    const freshSub = await ending(fresh, 5);
    const keeperKeys = await keysFor(keeper.id);
    ok("  the new ladder: 5 days left is the 10-day step", keeperKeys.includes(`renewal-remind:${freshSub.id}:10`), keeperKeys.filter((k) => k.includes(freshSub.id)));
    ok("  the manager no longer told", !(await keysFor(head.id)).includes(`renewal-escalate:${freshSub.id}`));
    ok("  no renewal task", (await watch.runRenewalTasks(new Date())).reason === "off");
    ok("  a reminder day out of range is refused", !(await settings.saveRenewalSettings({ lapseLostAfterDays: 15, reminderDays: [400] })).ok);
    ok("  the lapse days alone still save (the older form)", (await settings.saveRenewalSettings({ lapseLostAfterDays: 20 })).ok && (await lapse.renewalConfig()).watch.reminderDays.join(",") === "45,10");

    section("The customer reminded by itself (owner, 30 Oct 2026)");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const customerMail = require("../src/lib/renewal-customer-reminders") as typeof import("../src/lib/renewal-customer-reminders");
    ok("Off until days are set", (await customerMail.runCustomerRenewalReminders(new Date())).reason === "off");
    const buyer = await customer("Zz Buyer");
    const contactAt = (name: string, extra: Record<string, unknown>) =>
      db.contact.create({ data: { companyId: buyer.id, name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-buyer.in`, createdByUserId: boss.id, ...extra }, select: { id: true } });
    const primary = await contactAt("Zz Primary", { isPrimary: true });
    const purchase = await contactAt("Zz Purchase", { designation: "PURCHASE_MANAGER" });
    const engineer = await contactAt("Zz Engineer", { designation: "IT_MANAGER" });
    const buyerSub = await ending(buyer, 25);
    const savedDays = await settings.saveRenewalSettings({ lapseLostAfterDays: 20, customerReminderDays: [7, 30, 30], customerReminderCc: ["Copies@Zz-Watch.in"], customerReminderCcManager: true });
    ok("Settings › Renewals takes the customer days, sorted, once each", savedDays.ok && (await lapse.renewalConfig()).customerReminderDays.join(",") === "30,7", savedDays);
    await customerMail.runCustomerRenewalReminders(new Date(), { only: [buyerSub.id] });
    const mailed = await db.marketingMessage.findMany({ where: { companyProductId: buyerSub.id, noticeKind: "RENEWAL" }, select: { contactId: true, sentByUserId: true, ccEmails: true } });
    const to = new Set(mailed.map((m) => m.contactId));
    ok("25 days left is the 30-day step: the primary and the purchase manager get it", to.has(primary.id) && to.has(purchase.id), mailed);
    ok("  not the IT manager", !to.has(engineer.id));
    ok("  sent by nobody, as it went by itself", mailed.every((m) => m.sentByUserId === null));
    {
      // Copied (owner, 13 Nov 2026): Settings › Renewals' addresses and the renewal's manager — the account manager here —
      // on one email of the reminder, so each copy arrives once.
      const copied = mailed.filter((m) => m.ccEmails.length > 0);
      const cc = copied[0]?.ccEmails ?? [];
      ok("  copied to the address set and the account manager, on one email only", copied.length === 1 && cc.includes("copies@zz-watch.in") && cc.includes(rep.email!.toLowerCase()), mailed);
      ok("  Settings › Renewals keeps the copies", (await lapse.renewalConfig()).customerCopies.manager && (await lapse.renewalConfig()).customerCopies.emails.join() === "copies@zz-watch.in");
      ok("  an address that isn't one is refused", !(await settings.saveRenewalSettings({ lapseLostAfterDays: 20, customerReminderCc: ["not an email"] })).ok);
    }
    await customerMail.runCustomerRenewalReminders(new Date(), { only: [buyerSub.id] });
    ok("  once: run again, nothing more", (await db.marketingMessage.count({ where: { companyProductId: buyerSub.id, noticeKind: "RENEWAL" } })) === mailed.length);
    {
      // The step's day starts at the workspace's midnight, not UTC's (13 Nov 2026: one customer got the same reminder
      // every five minutes from midnight to 5.30 am IST). Sent a minute into the step's day, it still counts.
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
      const clock = await workspaceClock();
      const end = (await db.companyProduct.findUniqueOrThrow({ where: { id: buyerSub.id }, select: { endDate: true } })).endDate!;
      const stepDay = new Date(end.getTime() - 30 * 86_400_000).toISOString().slice(0, 10);
      const stepStart = clock.startOfDay(stepDay)!;
      await db.marketingMessage.updateMany({ where: { companyProductId: buyerSub.id, noticeKind: "RENEWAL" }, data: { createdAt: new Date(stepStart.getTime() + 60_000) } });
      await customerMail.runCustomerRenewalReminders(new Date(stepStart.getTime() + 60 * 60_000), { only: [buyerSub.id] });
      ok(
        `  sent a minute after the step's day began here (${clock.zone}), an hour later it isn't sent again`,
        (await db.marketingMessage.count({ where: { companyProductId: buyerSub.id, noticeKind: "RENEWAL" } })) === mailed.length,
      );
    }
    const handSent = await ending(buyer, 6);
    await db.marketingMessage.create({ data: { token: "zz-hand-sent", companyId: buyer.id, contactId: primary.id, channel: "EMAIL", messageClass: "TRANSACTIONAL", subject: "s", body: "b", toEmail: "zz.primary@zz-buyer.in", companyProductId: handSent.id, noticeKind: "RENEWAL", status: "SENT", scheduledFor: new Date(), sentByUserId: rep.id } });
    await customerMail.runCustomerRenewalReminders(new Date(), { only: [handSent.id] });
    ok("An account manager's own reminder since the step counts: not sent again", (await db.marketingMessage.count({ where: { companyProductId: handSent.id } })) === 1);
    const lostSub = await ending(buyer, 5, { renewalStage: "LOST" });
    await customerMail.runCustomerRenewalReminders(new Date(), { only: [lostSub.id] });
    ok("A renewal marked Lost: no reminder", (await db.marketingMessage.count({ where: { companyProductId: lostSub.id } })) === 0);
    await settings.saveRenewalSettings({ lapseLostAfterDays: 20, customerReminderDays: [], customerReminderCc: [], customerReminderCcManager: false });

    section("The team's reminder emails copied (owner, 23 Nov 2026)");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { createElement } = require("react") as typeof import("react");
    const { RenewalSettings: RenewalSettingsForm } = require("../src/components/settings/renewal-settings") as typeof import("../src/components/settings/renewal-settings");
    /* eslint-enable @typescript-eslint/no-require-imports */
    {
      /* eslint-disable @typescript-eslint/no-require-imports */
      const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
      const { emailReminders } = require("../src/lib/notifications/reminder-emails") as typeof import("../src/lib/notifications/reminder-emails");
      /* eslint-enable @typescript-eslint/no-require-imports */
      ok("an address outside the company is refused", !(await settings.saveRenewalSettings({ lapseLostAfterDays: 20, teamReminderCc: ["someone@gmail.com"] })).ok);
      const savedTeam = await settings.saveRenewalSettings({ lapseLostAfterDays: 20, teamReminderCc: ["Renewals@Zz-Watch.in", "renewals@zz-watch.in"] });
      ok("Settings › Renewals keeps the team's copies, once each", savedTeam.ok && (await lapse.renewalConfig()).teamCopies.emails.join() === "renewals@zz-watch.in", savedTeam);
      const settingsHtml = renderToStaticMarkup(createElement(RenewalSettingsForm, { config: await lapse.renewalConfig(), people: [] }));
      ok("  the page shows the box, with them in it", settingsHtml.includes("Copy (CC) the reminder emails to") && settingsHtml.includes("value=\"renewals@zz-watch.in\""), settingsHtml.length);
      await person("Zz Admin Two", { role: "ADMIN" });
      // Due tomorrow, swept then: section 10 switched renewal emails on again a moment ago, so what fell due today isn't emailed.
      const tomorrow = new Date(clock.startOfDay(new Date(today.getTime() + DAY).toISOString().slice(0, 10))!.getTime() + 3_600_000);
      const copiedSub = await ending(await customer("Zz Copied", { ownerUserId: keeper.id }), 11);
      await ending(await customer("Zz Copied Orphan", { ownerUserId: null }), 11);
      const ladder = (await syncSystemNotifications(keeper.id, { now: tomorrow })).find((n) => n.dedupeKey === reminderKey(copiedSub.id, 10));
      ok("  the ladder's reminder carries them", ladder?.cc?.join() === "renewals@zz-watch.in", ladder);
      const mailed: import("../src/lib/platform/mailer").PlatformMail[] = [];
      mailer.setTestPlatformMailer(async (m) => void mailed.push(m));
      try {
        await emailReminders({ now: tomorrow });
        const about = (name: string) => mailed.filter((m) => m.text.includes(`${name} — Zz Books`));
        const own = about("Zz Copied");
        ok("the renewal manager's reminder email is copied", own.length === 1 && own[0]!.to === keeper.email && own[0]!.cc?.join() === "renewals@zz-watch.in", own.map((m) => ({ to: m.to, cc: m.cc })));
        const orphaned = about("Zz Copied Orphan");
        ok("  one nobody looks after goes to both admins, copied on one email only", orphaned.length === 2 && orphaned.filter((m) => m.cc?.length).length === 1, orphaned.map((m) => ({ to: m.to, cc: m.cc })));
        const copied = mailed.filter((m) => m.cc?.length);
        ok("  only the ladder's reminders are copied", copied.length > 0 && copied.every((m) => m.subject.startsWith("Subscription ends")), mailed.map((m) => ({ subject: m.subject, cc: m.cc })));
        const sentBefore = mailed.length;
        await emailReminders({ now: new Date(tomorrow.getTime() + 5 * 60_000) });
        ok("  swept again: nothing more", mailed.length === sentBefore, mailed.length - sentBefore);
      } finally {
        mailer.setTestPlatformMailer(null);
      }
    }

    section("9. A workspace not migrated yet");
    await db.$executeRawUnsafe('ALTER TABLE "renewal_settings" DROP COLUMN "teamReminderCc"');
    const noTeam = await lapse.renewalConfig();
    ok("before the team's copies: nobody copied, and the page knows", noTeam.watchMigrated && !noTeam.teamCopies.migrated && noTeam.teamCopies.emails.length === 0, noTeam.teamCopies);
    ok("  the bell still reminds, uncopied", (await syncSystemNotifications(keeper.id)).some((n) => n.dedupeKey === reminderKey(freshSub.id, 10) && !n.cc));
    ok("  saving leaves them alone", (await settings.saveRenewalSettings({ lapseLostAfterDays: 20, teamReminderCc: ["renewals@zz-watch.in"] })).ok);
    ok("  the page doesn't offer the box", !renderToStaticMarkup(createElement(RenewalSettingsForm, { config: noTeam, people: [] })).includes("Copy (CC) the reminder emails to"));
    await db.$executeRawUnsafe('ALTER TABLE "renewal_settings" DROP COLUMN "reminderDays", DROP COLUMN "escalateManagerDays", DROP COLUMN "escalateAdminDays", DROP COLUMN "taskLeadDays", DROP COLUMN "weeklyList"');
    const bare = await lapse.renewalConfig();
    ok("the defaults, and the page knows", bare.migrated && !bare.watchMigrated && bare.watch.reminderDays.join(",") === "60,30,15,7,1" && bare.lapseLostAfterDays === 20, bare);
    ok("  the bell still reminds", (await keysFor(keeper.id)).includes(reminderKey(freshSub.id, 7)));
    ok("  saving keeps to the lapse days", (await settings.saveRenewalSettings({ lapseLostAfterDays: 15, reminderDays: [5] })).ok && (await lapse.renewalConfig()).lapseLostAfterDays === 15);
    await db.renewalSettings.deleteMany({});
    ok("  and makes the row where there's none yet", (await settings.saveRenewalSettings({ lapseLostAfterDays: 9 })).ok && (await lapse.renewalConfig()).lapseLostAfterDays === 9);
  } finally {
    actor = null;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} renewal watch checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
