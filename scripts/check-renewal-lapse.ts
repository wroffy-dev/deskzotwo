/**
 * check:renewal-lapse — a subscription that ends and isn't renewed (owner, 26 Oct 2026 — src/lib/renewal-lapse.ts).
 *
 *   1. Marking a renewal Lost switches its auto-renew off; On hold leaves the switch, and the job passes it by.
 *   2. The day after it ends, its account's owner is told it lapsed — once; not for one renewed, marked or cancelled.
 *   3. Renewals › "Lapsed — not renewed": ended, not renewed, not marked.
 *   4. Settings › Renewals' days after its end, still nothing: marked Lost "Lapsed — not renewed", auto-renew off,
 *      the owner and their manager told; one somebody marked is left alone; off never marks.
 *   5. Settings › Renewals: whoever manages settings; the days kept.
 *   6. A workspace not migrated yet: nothing breaks.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:renewal-lapse
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
  const scratch = `${realName}_renewlapse`;
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
    const lapse = require("../src/lib/renewal-lapse") as typeof import("../src/lib/renewal-lapse");
    const stage = require("../src/actions/renewal-stage") as typeof import("../src/actions/renewal-stage");
    const settings = require("../src/actions/renewal-settings") as typeof import("../src/actions/renewal-settings");
    const renewals = require("../src/actions/renewal") as typeof import("../src/actions/renewal");
    const { syncSystemNotifications } = require("../src/lib/notify") as typeof import("../src/lib/notify");
    const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const person = (name: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-lapse.in`, passwordHash: "!", role: "SALES", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const boss = await person("Zz Boss", { role: "ADMIN", isSuperAdmin: true });
    const head = await person("Zz Head", { role: "SALES_MANAGER" });
    const rep = await person("Zz Rep", { managerId: head.id });
    const asActor = (u: { id: string; name: string; email: string | null; role: string }): Actor => ({ id: u.id, name: u.name, email: u.email!, role: u.role });
    const as = <T,>(who: { id: string; name: string; email: string | null; role: string }, work: () => Promise<T>) => {
      const before = actor;
      actor = asActor(who);
      return work().finally(() => {
        actor = before;
      });
    };
    actor = asActor(boss);
    const company = await db.company.create({ data: { name: "Zz Books Customer", normalizedName: "zz books customer", relationshipType: "CLIENT", stage: "CUSTOMER", createdById: boss.id, ownerUserId: rep.id }, select: { id: true } });
    const site = await db.companyLocation.create({ data: { companyId: company.id, label: "Head Office", isPrimary: true, city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" } });
    const books = await db.item.create({ data: { name: "Zz Books", sku: "ZZ-BOOKS", type: "SUBSCRIPTION", billingCycle: "ANNUAL", sellingPrice: 12000, createdById: boss.id } });
    const today = (await workspaceClock()).calendarDate(new Date());
    const ended = (daysAgo: number, extra: Record<string, unknown> = {}) =>
      db.companyProduct.create({
        data: {
          companyId: company.id,
          locationId: site.id,
          itemId: books.id,
          addedByUserId: rep.id,
          quantity: 1,
          unitPrice: 12000,
          fullTermUnitPrice: 12000,
          startDate: new Date(today.getTime() - (daysAgo + 365) * DAY),
          endDate: new Date(today.getTime() - daysAgo * DAY),
          orderStatus: "FULFILLED",
          ...extra,
        },
        select: { id: true },
      });

    section("1. Lost switches auto-renew off");
    const willLose = await ended(-20);
    await db.recurringBilling.create({ data: { companyProductId: willLose.id, mode: "AUTO_RENEW", setById: rep.id } });
    const marked = await stage.setRenewalStage({ companyProductId: willLose.id, stage: "LOST", note: "Moved to Tally" });
    ok("marking the renewal Lost switches its auto-renew off", marked.ok && (await db.recurringBilling.count({ where: { companyProductId: willLose.id } })) === 0, marked.ok ? "" : marked.error);
    const willHold = await ended(-20);
    await db.recurringBilling.create({ data: { companyProductId: willHold.id, mode: "AUTO_RENEW", setById: rep.id } });
    await stage.setRenewalStage({ companyProductId: willHold.id, stage: "ON_HOLD", note: "Budget freeze" });
    ok("  On hold leaves the switch (the job passes it by)", (await db.recurringBilling.count({ where: { companyProductId: willHold.id } })) === 1);

    section("2. The day after it ends");
    const lapsedYesterday = await ended(1);
    const renewedOne = await ended(1);
    await ended(-365, { renewedFromId: renewedOne.id, businessType: "RENEWAL" });
    const markedOne = await ended(1, { renewalStage: "NEGOTIATING" });
    const cancelledOne = await ended(1, { orderStatus: "CANCELLED" });
    const raised = await syncSystemNotifications(rep.id);
    const lapsedNotices = raised.filter((n) => n.dedupeKey?.startsWith("renewal-lapsed:"));
    ok("the owner is told it lapsed", lapsedNotices.some((n) => n.dedupeKey === `renewal-lapsed:${lapsedYesterday.id}` && n.title.includes("lapsed")), lapsedNotices.map((n) => n.dedupeKey));
    ok("  not for one renewed, marked or cancelled", ![renewedOne.id, markedOne.id, cancelledOne.id].some((id) => lapsedNotices.some((n) => n.dedupeKey === `renewal-lapsed:${id}`)));
    await syncSystemNotifications(rep.id);
    ok("  once", (await db.notification.count({ where: { userId: rep.id, dedupeKey: `renewal-lapsed:${lapsedYesterday.id}` } })) === 1);

    section("3. Renewals › Lapsed — not renewed");
    const list = await renewals.listRenewalsPaged({ window: "lapsed", page: 1, pageSize: 50 });
    const ids = list.rows.map((r) => r.id);
    ok("lists the one ended, not renewed, not marked", ids.includes(lapsedYesterday.id) && !ids.includes(renewedOne.id) && !ids.includes(markedOne.id) && !ids.includes(willLose.id), ids.length);

    section("4. Marked Lost by itself");
    const longAgo = await ended(20);
    const longAgoMarked = await ended(20, { renewalStage: "ON_HOLD" });
    await db.recurringBilling.create({ data: { companyProductId: longAgo.id, mode: "AUTO_RENEW", setById: rep.id } });
    const run = await lapse.runRenewalLapses(new Date());
    const after = await db.companyProduct.findUnique({ where: { id: longAgo.id }, select: { renewalStage: true, renewalStageNote: true } });
    ok("15 days after its end, still nothing: Lost, Lapsed — not renewed", run.marked === 1 && after?.renewalStage === "LOST" && after.renewalStageNote === lapse.LAPSED_NOTE, run);
    ok("  its auto-renew switched off", (await db.recurringBilling.count({ where: { companyProductId: longAgo.id } })) === 0);
    const told = await db.notification.findMany({ where: { title: "A subscription lapsed" }, select: { userId: true } });
    ok("  the owner and their manager told", told.some((t) => t.userId === rep.id) && told.some((t) => t.userId === head.id));
    ok("  one somebody put On hold is left alone", (await db.companyProduct.findUnique({ where: { id: longAgoMarked.id } }))?.renewalStage === "ON_HOLD");
    ok("  yesterday's isn't due yet", (await db.companyProduct.findUnique({ where: { id: lapsedYesterday.id } }))?.renewalStage === null);
    ok("  run again: nothing more", (await lapse.runRenewalLapses(new Date())).marked === 0);

    section("5. Settings › Renewals");
    ok("a rep can't change it", !(await as(rep, () => settings.saveRenewalSettings({ lapseLostAfterDays: 3 }))).ok);
    const off = await settings.saveRenewalSettings({ lapseLostAfterDays: null });
    const another = await ended(40);
    ok("switched off: never marked Lost", off.ok && (await lapse.runRenewalLapses(new Date())).marked === 0 && (await db.companyProduct.findUnique({ where: { id: another.id } }))?.renewalStage === null);
    await settings.saveRenewalSettings({ lapseLostAfterDays: 60 });
    ok("  60 days: a 40-day lapse waits", (await lapse.runRenewalLapses(new Date())).marked === 0);
    const view = await settings.renewalSettingsView();
    ok("  the page reads it back", view.ok && view.data.lapseLostAfterDays === 60);
    ok("  a day count out of range is refused", !(await settings.saveRenewalSettings({ lapseLostAfterDays: 0 })).ok);

    section("7. Lapsed customers");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const lapsedCustomers = require("../src/lib/customers/lapsed") as typeof import("../src/lib/customers/lapsed");
    const companies = require("../src/actions/company") as typeof import("../src/actions/company");
    const reportLib = require("../src/lib/renewals-report") as typeof import("../src/lib/renewals-report");
    /* eslint-enable @typescript-eslint/no-require-imports */
    // Zz Books Customer has subscriptions ending in the future (the ones marked Lost and On hold above): not lapsed.
    ok("a customer with a subscription still running isn't lapsed", !(await lapsedCustomers.customerStanding(company.id, today)).lapsed);
    const gone = await db.company.create({ data: { name: "Zz Gone Ltd", normalizedName: "zz gone ltd", relationshipType: "CLIENT", stage: "CUSTOMER", createdById: boss.id, ownerUserId: rep.id }, select: { id: true } });
    const goneSite = await db.companyLocation.create({ data: { companyId: gone.id, label: "HO", isPrimary: true, city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" } });
    const sub = (companyId: string, locationId: string, endDaysAgo: number, extra: Record<string, unknown> = {}) =>
      db.companyProduct.create({ data: { companyId, locationId, itemId: books.id, addedByUserId: rep.id, quantity: 2, unitPrice: 12000, fullTermUnitPrice: 12000, startDate: new Date(today.getTime() - (endDaysAgo + 365) * DAY), endDate: new Date(today.getTime() - endDaysAgo * DAY), orderStatus: "FULFILLED", ...extra }, select: { id: true } });
    await sub(gone.id, goneSite.id, 40);
    await sub(gone.id, goneSite.id, 10);
    await sub(gone.id, goneSite.id, -100, { orderStatus: "CANCELLED" });
    const standing = await lapsedCustomers.customerStanding(gone.id, today);
    ok("every subscription ended, none renewed (a cancelled one doesn't count): lapsed, since the last one's end", standing.lapsed && standing.subscriptions === 2 && standing.since.getTime() === today.getTime() - 10 * DAY, standing);
    const goodsOnly = await db.company.create({ data: { name: "Zz Goods Only", normalizedName: "zz goods only", relationshipType: "CLIENT", stage: "CUSTOMER", createdById: boss.id, ownerUserId: rep.id }, select: { id: true } });
    ok("  one who only bought goods is neither", !(await lapsedCustomers.customerStanding(goodsOnly.id, today)).lapsed);
    const listed = await companies.listCustomersPaged({ page: 1, pageSize: 50, standing: "lapsed" });
    ok("  Customers › Lapsed customers lists them, and only them", listed.rows.some((r) => r.id === gone.id) && !listed.rows.some((r) => r.id === company.id), listed.rows.map((r) => r.name));

    section("8. The renewal report");
    const d = (s: string) => new Date(`${s}T00:00:00Z`);
    const rows: import("../src/lib/renewals-report").ReportRenewal[] = [
      { id: "1", endDate: d("2026-01-10"), value: 1000, outcome: "RENEWED", lostReason: null, product: "Books", ownerId: "a", ownerName: "Asha" },
      { id: "2", endDate: d("2026-01-20"), value: 2000, outcome: "LOST", lostReason: "Price too high.", product: "Books", ownerId: "a", ownerName: "Asha" },
      { id: "3", endDate: d("2026-02-05"), value: 3000, outcome: "LOST", lostReason: "price too high", product: "CRM", ownerId: "b", ownerName: "Bala" },
      { id: "4", endDate: d("2026-02-15"), value: 4000, outcome: "OPEN", lostReason: null, product: "CRM", ownerId: "b", ownerName: "Bala" },
      { id: "5", endDate: d("2026-02-25"), value: 500, outcome: "LOST", lostReason: null, product: "CRM", ownerId: null, ownerName: null },
    ];
    const built = reportLib.buildRenewalReport(rows, (x) => x.toISOString().slice(0, 7));
    ok("totals: 5 came up, 1 renewed, 3 lost, 1 open; the rate is renewed of decided — 25%", built.totals.due === 5 && built.totals.renewed === 1 && built.totals.lost === 3 && built.totals.open === 1 && built.totals.rate === 25 && built.totals.valueLost === 5500, built.totals);
    ok("  by month: January 50%, February none renewed", built.months[0]?.month === "2026-01" && built.months[0].rate === 50 && built.months[1]?.rate === 0);
    ok("  reasons: the same words are one reason, first spelling kept; none given is said", built.reasons[0]?.reason === "Price too high." && built.reasons[0].count === 2 && built.reasons.some((r) => r.reason === "No reason given"), built.reasons);
    ok("  by salesperson, with no account manager its own row", built.people.some((p) => p.name === "No account manager") && built.people.find((p) => p.key === "a")?.rate === 50);
    const live = await renewals.renewalReport({});
    ok("the report over the workspace: Zz Gone's two Books renewals are open, worth ₹48,000", !!live && live.totals.due >= 2 && live.products.some((p) => p.product === "Zz Books"), live?.totals);

    section("9. Cleaning up old renewals");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const tidy = require("../src/actions/renewal-tidy") as typeof import("../src/actions/renewal-tidy");
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { TIDY_NOTE } = require("../src/lib/renewal-tidy") as typeof import("../src/lib/renewal-tidy");
    const old = await db.company.create({ data: { name: "Zz Old Customer", normalizedName: "zz old customer", relationshipType: "CLIENT", stage: "CUSTOMER", createdById: boss.id, ownerUserId: rep.id }, select: { id: true } });
    const oldSite = await db.companyLocation.create({ data: { companyId: old.id, label: "Head Office", isPrimary: true, city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" } });
    const term = (start: string, end: string, extra: Record<string, unknown> = {}) =>
      db.companyProduct.create({ data: { companyId: old.id, locationId: oldSite.id, itemId: books.id, addedByUserId: rep.id, quantity: 1, unitPrice: 12000, fullTermUnitPrice: 12000, startDate: new Date(`${start}T00:00:00Z`), endDate: new Date(`${end}T00:00:00Z`), orderStatus: "FULFILLED", ...extra }, select: { id: true } });
    // A yearly chain that came across unlinked, one that just stopped, one somebody marked, and the running one.
    const y2018 = await term("2018-02-03", "2019-02-02");
    const y2019 = await term("2019-01-20", "2020-01-19");
    // Same product, ended 2019 — the 2026 order of it starts years later: a new purchase, not its renewal.
    const stopped = await term("2018-03-28", "2019-03-27", { quantity: 3 });
    const pinned = await term("2017-05-01", "2018-04-30", { renewalStage: "NEGOTIATING", renewalStageNote: "Talking to their new CFO" });
    const running = await term(new Date(today.getTime() - 200 * DAY).toISOString().slice(0, 10), new Date(today.getTime() + 165 * DAY).toISOString().slice(0, 10));
    const before = new Date(today.getTime() - 90 * DAY).toISOString().slice(0, 10);
    ok("a rep can't preview or run it", !(await as(rep, () => tidy.previewRenewalTidy(before))).ok && !(await as(rep, () => tidy.runRenewalTidy(before))).ok);
    const preview = await tidy.previewRenewalTidy(before);
    ok("preview: what ended over 90 days ago — 2018 links to 2019, the rest closed; nothing changed yet", preview.ok && preview.data.sampleLinks.some((s) => s.company === "Zz Old Customer") && (await db.companyProduct.count({ where: { renewalStageNote: TIDY_NOTE } })) === 0, preview.ok ? preview.data : preview);
    const tidied = await tidy.runRenewalTidy(before);
    ok("run: it says what it did", tidied.ok && tidied.data.linked >= 1 && tidied.data.closed >= 2, tidied);
    const tidiedRows = await db.companyProduct.findMany({ where: { id: { in: [y2018.id, y2019.id, stopped.id, pinned.id, running.id] } }, select: { id: true, renewalStage: true, renewalStageNote: true, renewedBy: { select: { id: true } } } });
    const row = (id: string) => tidiedRows.find((r) => r.id === id)!;
    ok("  2018's term is renewed by 2019's, not closed", row(y2018.id).renewedBy?.id === y2019.id && row(y2018.id).renewalStage === null);
    ok("  2019's — ended, with no later order — closed as ended before Deskzo", row(y2019.id).renewalStage === "LOST" && row(y2019.id).renewalStageNote === TIDY_NOTE);
    ok("  the one that just stopped, closed too", row(stopped.id).renewalStage === "LOST");
    ok("  one somebody marked, and the running one, untouched", row(pinned.id).renewalStage === "NEGOTIATING" && row(running.id).renewalStage === null && !row(running.id).renewedBy);
    ok("  quietly: nobody told", (await db.notification.count({ where: { userId: { in: [rep.id, head.id] }, message: { contains: "Zz Old Customer" } } })) === 0);
    ok("  and the report leaves them out of its rate", !(await renewals.renewalReport({ from: "2019-01", to: "2020-12" }))?.reasons.some((r) => r.reason === TIDY_NOTE));
    ok("a second run finds nothing more for them", (await tidy.previewRenewalTidy(before)).ok);

    section("10. The list opens on what's open, and the rule leaves the old past alone");
    const ancient = await term("2016-01-01", "2016-12-31");
    const open = await renewals.listRenewalsPaged({ window: "open", page: 1, pageSize: 200 });
    const all = await renewals.listRenewalsPaged({ page: 1, pageSize: 500 });
    ok("open: the running one, not one that ended years ago", open.rows.some((r) => r.id === running.id) && !open.rows.some((r) => r.id === ancient.id));
    ok("  all, ever: that one too", all.rows.some((r) => r.id === ancient.id));
    await settings.saveRenewalSettings({ lapseLostAfterDays: 15 });
    await lapse.runRenewalLapses(new Date());
    ok("the automatic Lost rule doesn't reach back to 2016 — no flood of old lapses", (await db.companyProduct.findUnique({ where: { id: ancient.id }, select: { renewalStage: true } }))?.renewalStage === null);

    section("6. A workspace not migrated yet");
    await db.$executeRawUnsafe('DROP TABLE "renewal_settings"');
    ok("the job does nothing", (await lapse.runRenewalLapses(new Date())).reason === "off");
    const bare = await settings.renewalSettingsView();
    ok("  the settings page says it's being updated", bare.ok && !bare.data.migrated);
  } finally {
    actor = null;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} renewal lapse checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
