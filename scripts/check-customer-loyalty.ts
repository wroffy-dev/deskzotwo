/**
 * check:customer-loyalty — each customer's history with us and its loyalty tier (owner, 31 Oct 2026 —
 * src/lib/customers/stats.ts, src/lib/customers/loyalty-rules.ts):
 *
 *   1. The rules, by hand: every tier, the order they're asked in, the top-10% bar, the spans the cells say.
 *   2. A fixture of customers with orders, invoices, payments, renewals and Zoho archived years at chosen days, refreshed
 *      alone (`only`): Customer since, lifetime value (own rate, credit notes off, drafts and cancelled out, archive in
 *      base currency only), last 12 / the 12 before, orders and live, renewal rate, pays in, overdue, products — and the
 *      tier each earns. A vendor and a prospect get no row.
 *   3. The Customers list's Loyalty filter, and the cells as drawn.
 *   4. Settings › Customer loyalty: a rule changed moves a customer; out-of-range refused; put back after.
 *
 * Everything is named ZZPROBE_LOY and removed in a finally; the dev database is shared and full, so every assertion is
 * about the fixture's own rows.
 *
 *   npm run check:customer-loyalty
 */
import "dotenv/config";
import Module from "node:module";
import { createElement } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: "ADMIN", name: "Zzprobe Loy", email: `${actorId}${MAIL}` } : null);
    return {
      requireUser: async () => {
        const u = await user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: user,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_LOY";
const MAIL = "@zzprobe-loy.invalid";
const DAY = 86_400_000;
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

async function cleanup() {
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  if (companies.length) {
    const payments = (await db.payment.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((p) => p.id);
    await db.paymentAllocation.deleteMany({ where: { paymentId: { in: payments } } });
    await db.payment.deleteMany({ where: { id: { in: payments } } });
    await db.tradeDocument.deleteMany({ where: { companyId: { in: companies } } });
    // Renewals point at the orders they renew: the newer first.
    await db.companyProduct.deleteMany({ where: { companyId: { in: companies }, renewedFromId: { not: null } } });
    await db.companyProduct.deleteMany({ where: { companyId: { in: companies } } });
    await db.companyLocation.deleteMany({ where: { companyId: { in: companies } } });
    await db.company.deleteMany({ where: { id: { in: companies } } });
  }
  await db.item.deleteMany({ where: { sku: { startsWith: "ZZLOY-" } } });
  const users = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  if (users.length) {
    await db.migration.deleteMany({ where: { createdById: { in: users } } });
    await db.auditLog.deleteMany({ where: { userId: { in: users } } });
    await db.activityLog.deleteMany({ where: { userId: { in: users } } }).catch(() => {});
    await db.user.deleteMany({ where: { id: { in: users } } });
  }
}

async function main() {
  // Required here, after the session stub: a top-of-file import is hoisted above it and loads the real one.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const rules = require("../src/lib/customers/loyalty-rules") as typeof import("../src/lib/customers/loyalty-rules");
  const stats = require("../src/lib/customers/stats") as typeof import("../src/lib/customers/stats");
  const companyActions = require("../src/actions/company") as typeof import("../src/actions/company");
  const settingsActions = require("../src/actions/customer-loyalty") as typeof import("../src/actions/customer-loyalty");
  const cells = require("../src/components/customers/customer-history") as typeof import("../src/components/customers/customer-history");
  const registry = require("../src/lib/tables/registry") as typeof import("../src/lib/tables/registry");
  const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const R = rules.DEFAULT_LOYALTY_RULES;

  section("1. The rules, by hand");

  const now = new Date();
  const ago = (days: number) => new Date(now.getTime() - days * DAY);
  const facts = (over: Partial<import("../src/lib/customers/loyalty-rules").TierFacts>) => ({
    firstOrderAt: ago(500), lastPurchaseAt: ago(30), lifetimeValue: 1000, last12Value: 0, prev12Value: 0, liveSubscriptions: 1,
    renewalsDue: 0, renewalsRenewed: 0, renewalsLostRecently: 0, ...over,
  });
  const tierOf = (over: Parameters<typeof facts>[0], top = 5000, r = R) => rules.loyaltyTier(facts(over), r, now, top);
  ok("NEW: first order within 90 days — even with a big lifetime", tierOf({ firstOrderAt: ago(30), lifetimeValue: 1e9 }) === "NEW");
  ok("CHAMPION: 3+ years, renews 90%+, bought in 6 months, top 10%", tierOf({ firstOrderAt: ago(1200), lastPurchaseAt: ago(60), lifetimeValue: 9000, renewalsDue: 10, renewalsRenewed: 9 }) === "CHAMPION");
  ok("  nothing due for renewal yet still counts", tierOf({ firstOrderAt: ago(1200), lastPurchaseAt: ago(60), lifetimeValue: 9000 }) === "CHAMPION");
  ok("  below the top-10% bar: Loyal instead", tierOf({ firstOrderAt: ago(1200), lastPurchaseAt: ago(60), lifetimeValue: 4000 }) === "LOYAL");
  ok("  renewing 80%: Loyal, not Champion", tierOf({ firstOrderAt: ago(1200), lastPurchaseAt: ago(60), lifetimeValue: 9000, renewalsDue: 10, renewalsRenewed: 8 }) === "LOYAL");
  ok("LOYAL: 2+ years, renews 75%+, bought in 12 months", tierOf({ firstOrderAt: ago(800), lastPurchaseAt: ago(300), renewalsDue: 4, renewalsRenewed: 3 }) === "LOYAL");
  ok("  renewing 50%: not Loyal — At risk once quiet 6 months", tierOf({ firstOrderAt: ago(800), lastPurchaseAt: ago(300), renewalsDue: 4, renewalsRenewed: 2 }) === "AT_RISK");
  ok("GROWING: under 2 years, last 12 beat the 12 before", tierOf({ firstOrderAt: ago(500), last12Value: 3000, prev12Value: 1000 }) === "GROWING");
  ok("  level or down is not growing", tierOf({ firstOrderAt: ago(500), last12Value: 1000, prev12Value: 1000 }) === null);
  ok("AT_RISK: a renewal lost lately, though buying", tierOf({ firstOrderAt: ago(500), lastPurchaseAt: ago(10), renewalsLostRecently: 1 }) === "AT_RISK");
  ok("LAPSED: nothing for 12+ months, nothing running", tierOf({ firstOrderAt: ago(2000), lastPurchaseAt: ago(400), liveSubscriptions: 0, renewalsDue: 2 }) === "LAPSED");
  ok("  a subscription still running: not lapsed — just a customer", tierOf({ firstOrderAt: ago(2000), lastPurchaseAt: ago(400), liveSubscriptions: 1, renewalsDue: 2 }) === null);
  ok("no first order: no tier", tierOf({ firstOrderAt: null, lastPurchaseAt: null }) === null);
  ok("the order: New before At risk", tierOf({ firstOrderAt: ago(20), renewalsLostRecently: 1 }) === "NEW");
  ok("a rule's number moves the line: New within 10 days", tierOf({ firstOrderAt: ago(30) }, 5000, { ...R, newWithinDays: 10 }) === null);
  ok("top 10% of 20 customers is the 2nd highest", rules.topValueThreshold(Array.from({ length: 20 }, (_, i) => (i + 1) * 100), 10) === 1900);
  ok("  of 3, the highest; of none, nobody", rules.topValueThreshold([5, 9, 1], 10) === 9 && rules.topValueThreshold([0, -5], 10) === Infinity);
  ok("spans: 7 yrs 7 mo, 5 mo, 3 weeks, 4 days", [rules.spanSince(ago(2770), now), rules.spanSince(ago(160), now), rules.spanSince(ago(25), now), rules.spanSince(ago(4), now)].join(" | ") === "7 yrs 7 mo | 5 mo | 3 weeks | 4 days", [rules.spanSince(ago(2770), now), rules.spanSince(ago(160), now), rules.spanSince(ago(25), now), rules.spanSince(ago(4), now)].join(" | "));

  section("Registry");
  const shownOf = (key: string) => registry.resolveColumns(key, null);
  ok("Customers: Loyalty and Lifetime value on by default, the rest off", shownOf("customers").includes("loyalty") && shownOf("customers").includes("lifetimeValue") && !shownOf("customers").includes("customerSince") && !shownOf("customers").includes("paysIn"));
  ok("Companies: all off by default, all offered", !shownOf("companies").some((k) => ["loyalty", "lifetimeValue", "customerSince"].includes(k)) && registry.getTableDefinition("companies")!.columns.some((c) => c.key === "renewalRate"));

  const saved = await db.loyaltySettings.findUnique({ where: { id: "default" } });
  await cleanup();
  try {
    const admin = await db.user.create({ data: { name: `${TAG} admin`, email: `admin${MAIL}`, role: "ADMIN", passwordHash: "x".repeat(60) } });
    actorId = admin.id;
    const clock = await workspaceClock();
    const today = clock.calendarDate(now);
    const day = (offset: number) => new Date(today.getTime() + offset * DAY);
    const sub = await db.item.create({ data: { name: `${TAG} Books`, sku: "ZZLOY-SUB", type: "SUBSCRIPTION", billingCycle: "ANNUAL", sellingPrice: 12000, createdById: admin.id } as never, select: { id: true } });
    const good = await db.item.create({ data: { name: `${TAG} Laptop`, sku: "ZZLOY-GOOD", type: "GOOD", sellingPrice: 50000, createdById: admin.id } as never, select: { id: true } });
    const ids: string[] = [];
    // Inserted naming their columns, so the check runs whatever columns other work has added to companies.
    const company = async (name: string, kind: "CLIENT" | "VENDOR" = "CLIENT") => {
      const id = `zzloy_${name.toLowerCase()}_${Date.now()}`;
      await db.$executeRaw`INSERT INTO "companies" ("id", "name", "normalizedName", "relationshipType", "stage", "createdById", "ownerUserId", "updatedAt") VALUES (${id}, ${`${TAG} ${name}`}, ${`${TAG} ${name}`.toLowerCase()}, ${kind}::"CompanyRelationshipType", 'CUSTOMER'::"CompanyStage", ${admin.id}, ${admin.id}, now())`;
      const site = await db.companyLocation.create({ data: { companyId: id, label: "HO", isPrimary: true, city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" }, select: { id: true } });
      ids.push(id);
      return { id, siteId: site.id };
    };
    type C = Awaited<ReturnType<typeof company>>;
    const order = (c: C, createdDaysAgo: number, extra: Record<string, unknown> = {}) =>
      db.companyProduct.create({
        data: { companyId: c.id, locationId: c.siteId, itemId: good.id, addedByUserId: admin.id, quantity: 1, unitPrice: 1000, orderStatus: "FULFILLED", createdAt: ago(createdDaysAgo), ...extra } as never,
        select: { id: true },
      });
    const subscription = (c: C, createdDaysAgo: number, start: number, end: number, extra: Record<string, unknown> = {}) =>
      order(c, createdDaysAgo, { itemId: sub.id, startDate: day(start), endDate: day(end), ...extra });
    let n = 0;
    const doc = (c: C, docType: string, total: number, issuedDaysAgo: number, extra: Record<string, unknown> = {}) =>
      db.tradeDocument.create({
        data: { docType, direction: "SALES", status: "ISSUED", companyId: c.id, docNumber: `ZZLOY-${Date.now()}-${++n}`, taxableValue: total, total, createdById: admin.id, issueDate: day(-issuedDaysAgo), ...extra } as never,
        select: { id: true },
      });
    const pay = async (c: C, documentId: string, amount: number, paidDaysAgo: number) => {
      const p = await db.payment.create({ data: { companyId: c.id, amount, paidOn: day(-paidDaysAgo), method: "BANK_TRANSFER", direction: "RECEIVED", recordedByUserId: admin.id } as never, select: { id: true } });
      await db.paymentAllocation.create({ data: { paymentId: p.id, documentId, amount, allocatedByUserId: admin.id } });
    };

    // New: its first order a month ago.
    const fresh = await company("New");
    await order(fresh, 30);
    // Champion: four years, every renewal renewed, an invoice two months ago, by far the most billed.
    const champ = await company("Champion");
    await order(champ, 1460);
    const champOld = await subscription(champ, 730, -730, -365);
    await subscription(champ, 375, -365, 365, { renewedFromId: champOld.id, businessType: "RENEWAL" });
    await doc(champ, "INVOICE", 100_000_000, 1459);
    await doc(champ, "INVOICE", 50_000, 60);
    // Loyal: two and a half years, renewed, its renewal punched 100 days ago.
    const loyal = await company("Loyal");
    const loyalOld = await subscription(loyal, 912, -900, -90);
    await subscription(loyal, 100, -90, 275, { renewedFromId: loyalOld.id, businessType: "RENEWAL" });
    // Growing: a year and a half; ₹10,000 the year before, ₹30,000 + $100 at 80 − ₹2,000 credited this year.
    const growing = await company("Growing");
    await order(growing, 540);
    const g1 = await doc(growing, "INVOICE", 10_000, 500, { dueDate: day(-470), status: "PAID" });
    await pay(growing, g1.id, 10_000, 480);
    await doc(growing, "INVOICE", 30_000, 100, { dueDate: day(-70) });
    const g3 = await doc(growing, "INVOICE", 100, 50, { currency: "USD", exchangeRate: 80, dueDate: day(-20), status: "PAID" });
    await pay(growing, g3.id, 100, 40);
    await doc(growing, "CREDIT_NOTE", 2_000, 40);
    await doc(growing, "INVOICE", 99_999, 10, { status: "DRAFT" });
    await doc(growing, "INVOICE", 88_888, 10, { status: "CANCELLED" });
    await order(growing, 5, { orderStatus: "CANCELLED", itemId: sub.id });
    // At risk, quiet: three years, nothing for eight months, a renewal not won.
    const quiet = await company("Quiet");
    await subscription(quiet, 1095, -1095, -300);
    await order(quiet, 240);
    // At risk, lost: a year in, buying still, but a renewal marked Lost a month ago.
    const lost = await company("Lost");
    await subscription(lost, 365, -395, -30, { renewalStage: "LOST" });
    await order(lost, 20);
    // Lapsed: five years ago, nothing for two, nothing running.
    const lapsed = await company("Lapsed");
    await order(lapsed, 1825);
    await subscription(lapsed, 1095, -1095, -730);
    await order(lapsed, 730);
    // Just a customer: a year in, bought last month, nothing to say.
    const plain = await company("Plain");
    await order(plain, 365);
    await order(plain, 30);
    // Its older years from Zoho: an invoice, a credit note and a sales order archived; a dollar invoice the archive can't convert.
    const archived = await company("Archived");
    await order(archived, 200);
    const migration = await db.migration.create({ data: { source: "ZOHO_BOOKS", yearStart: day(-200), switchDate: day(-200), status: "UNDONE", createdById: admin.id } as never, select: { id: true } });
    const arch = (kind: string, total: number, daysAgo: number, extra: Record<string, unknown> = {}) =>
      db.archivedDocument.create({
        data: { migrationId: migration.id, kind, key: `${kind}:${TAG}:${daysAgo}:${total}`, number: `Z-${daysAgo}`, date: day(-daysAgo), year: "2019-20", companyId: archived.id, partyName: `${TAG} Archived`, status: "Closed", currency: "INR", total, ...extra } as never,
      });
    await arch("INVOICE", 20_000, 2190);
    await arch("CREDIT_NOTE", 5_000, 2100);
    await arch("SALES_ORDER", 20_000, 2555);
    await arch("INVOICE", 100, 2000, { currency: "USD" });
    await arch("INVOICE", 7_000, 1900, { status: "Void" });
    // Not customers: a vendor that has an order against it, and a prospect with nothing.
    const vendor = await company("Vendor", "VENDOR");
    await order(vendor, 100);
    const prospect = await company("Prospect");

    section("2. The refresh, the fixture alone");

    const run = await stats.refreshCustomerStats({ only: ids, now });
    ok("refreshed the fixture's customers: nine, not the vendor or the prospect", run.customers === 9, run);
    const rows = new Map((await db.customerStats.findMany({ where: { companyId: { in: ids } } })).map((r) => [r.companyId, r]));
    ok("  no row for the vendor or the prospect", !rows.has(vendor.id) && !rows.has(prospect.id));
    const tierOfRow = (c: C) => rows.get(c.id)?.tier ?? null;
    const tiers = { New: tierOfRow(fresh), Champion: tierOfRow(champ), Loyal: tierOfRow(loyal), Growing: tierOfRow(growing), Quiet: tierOfRow(quiet), Lost: tierOfRow(lost), Lapsed: tierOfRow(lapsed), Plain: tierOfRow(plain), Archived: tierOfRow(archived) };
    ok(
      "each earns its tier",
      JSON.stringify(tiers) === JSON.stringify({ New: "NEW", Champion: "CHAMPION", Loyal: "LOYAL", Growing: "GROWING", Quiet: "AT_RISK", Lost: "AT_RISK", Lapsed: "LAPSED", Plain: null, Archived: "LOYAL" }),
      tiers,
    );
    const g = rows.get(growing.id)!;
    ok("lifetime: ₹10,000 + ₹30,000 + $100 at 80 − ₹2,000 — drafts and cancelled out", Number(g.lifetimeValue) === 46_000, Number(g.lifetimeValue));
    ok("  last 12 months ₹36,000, the 12 before ₹10,000", Number(g.last12Value) === 36_000 && Number(g.prev12Value) === 10_000, [Number(g.last12Value), Number(g.prev12Value)]);
    ok("  pays in 15 days — 20 and 10, paid in full", g.avgDaysToPay === 15, g.avgDaysToPay);
    ok("  ₹30,000 overdue — the unpaid invoice past due", Number(g.overdue) === 30_000, Number(g.overdue));
    ok("  one order — the cancelled one isn't counted; customer since its first", g.orders === 1 && g.productCount === 1 && g.firstOrderAt?.getTime() === ago(540).getTime(), [g.orders, g.firstOrderAt]);
    ok("  last purchase: the dollar invoice 50 days ago, not the credit note, the draft or the cancelled order", g.lastPurchaseAt?.getTime() === day(-50).getTime(), g.lastPurchaseAt);
    const c = rows.get(champ.id)!;
    ok("Champion: 3 orders, 2 products, 1 live, renewed 1 of 1", c.orders === 3 && c.productCount === 2 && c.liveSubscriptions === 1 && c.renewalsDue === 1 && c.renewalsRenewed === 1, [c.orders, c.productCount, c.liveSubscriptions, c.renewalsDue, c.renewalsRenewed]);
    ok("  customer since four years ago; no invoices paid, so no Pays in", c.firstOrderAt?.getTime() === ago(1460).getTime() && c.avgDaysToPay === null, [c.firstOrderAt, c.avgDaysToPay]);
    const q = rows.get(quiet.id)!;
    ok("Quiet: renewal rate 0 of 1, nothing live", q.renewalsDue === 1 && q.renewalsRenewed === 0 && q.liveSubscriptions === 0);
    const l = rows.get(lost.id)!;
    ok("Lost: the lost renewal counted, not live", l.renewalsLostRecently === 1 && l.liveSubscriptions === 0, [l.renewalsLostRecently, l.liveSubscriptions]);
    const a = rows.get(archived.id)!;
    ok("Archived: since the archived sales order seven years back", a.firstOrderAt?.getTime() === day(-2555).getTime(), a.firstOrderAt);
    ok("  lifetime ₹15,000 — invoice less credit note; the dollar and the void left out", Number(a.lifetimeValue) === 15_000, Number(a.lifetimeValue));
    ok("  last purchase its order 200 days ago, newer than the archive", a.lastPurchaseAt?.getTime() === ago(200).getTime(), a.lastPurchaseAt);
    const again = await stats.refreshCustomerStats({ only: ids, now });
    ok("refreshing again replaces, never doubles", again.customers === 9 && (await db.customerStats.count({ where: { companyId: { in: ids } } })) === 9);

    section("3. The list and its cells");

    const listed = await companyActions.listCustomersPaged({ page: 1, pageSize: 50, search: TAG, loyalty: "AT_RISK" });
    ok("Customers › Loyalty: At risk lists Quiet and Lost", listed.rows.map((r) => r.name).sort().join() === `${TAG} Lost,${TAG} Quiet`, listed.rows.map((r) => r.name));
    const anyTier = await companyActions.listCustomersPaged({ page: 1, pageSize: 50, search: TAG, loyalty: "nonsense" });
    ok("  a tier that isn't one filters nothing — the nine who bought", anyTier.total === 9, anyTier.total);
    const history = (await stats.historyOfCompanies([champ.id, growing.id, prospect.id]))!;
    ok("the page's figures: plain numbers, ISO days, the currency beside them", history.get(champ.id)?.lifetimeValue === 100_050_000 && typeof history.get(champ.id)?.firstOrderAt === "string" && !!history.get(champ.id)?.currency && !history.has(prospect.id));
    const html = (column: import("../src/lib/customers/history-columns").HistoryColumn, h: unknown) => renderToStaticMarkup(createElement(cells.HistoryValue, { column, history: h as never }));
    ok("Renewal rate cell: 100% (1 of 1)", html("renewalRate", history.get(champ.id)).replace(/<[^>]+>/g, "").includes("100% (1 of 1)"), html("renewalRate", history.get(champ.id)));
    ok("Last 12 months cell: up 260%", html("last12", history.get(growing.id)).includes("▲ 260%"), html("last12", history.get(growing.id)));
    ok("Pays in cell: 15 days and the overdue", /15 days.*overdue/.test(html("paysIn", history.get(growing.id)).replace(/<[^>]+>/g, "")), html("paysIn", history.get(growing.id)));
    ok("Loyalty cell: the badge", html("loyalty", history.get(champ.id)).includes("Champion"));
    ok("no row: a dash", html("lifetimeValue", null).includes("—"));
    ok("the stats table is here", await stats.customerStatsHere());

    section("4. Settings › Customer loyalty");

    const view = await settingsActions.loyaltySettingsView();
    ok("the view reads the rules", view.ok && view.data.migrated && typeof view.data.rules.newWithinDays === "number", view.ok ? view.data.rules : view.error);
    const refused = await settingsActions.saveLoyaltySettings({ ...R, championRenewalRate: 140 });
    ok("a renewal rate of 140% is refused", !refused.ok, refused);
    const crossed = await settingsActions.saveLoyaltySettings({ ...R, atRiskFromMonths: 12, lapsedAfterMonths: 12 });
    ok("At risk starting where Lapsed does is refused", !crossed.ok, crossed);
    const savedRules = await settingsActions.saveLoyaltySettings({ ...R, newWithinDays: 10 });
    ok("New within 10 days saved, every customer refreshed", savedRules.ok && savedRules.data.customers >= 9, savedRules);
    ok("  the month-old customer is no longer New", (await db.customerStats.findUnique({ where: { companyId: fresh.id } }))?.tier === null);
    ok("  and the rule is stored", (await db.loyaltySettings.findUnique({ where: { id: "default" } }))?.newWithinDays === 10);
    ok("  a full refresh stamps when, and how long it took", !!(await db.loyaltySettings.findUnique({ where: { id: "default" } }))?.refreshedAt);
    const fresh2 = await stats.runCustomerStats();
    ok("the heartbeat leaves a refresh done in the last day alone", fresh2.refreshed === 0 && fresh2.reason === "fresh", fresh2);
  } finally {
    actorId = "";
    await cleanup();
    // The rules as they were: the shared database's own settings row, or none.
    if (saved) {
      const { id, updatedAt, ...rest } = saved;
      void updatedAt;
      await db.loyaltySettings.update({ where: { id }, data: rest });
    } else {
      await db.loyaltySettings.deleteMany({ where: { id: "default" } });
    }
    // Everybody else's tiers under the rules put back — the save above re-tiered the whole workspace.
    await stats.refreshCustomerStats().catch((err) => console.error("could not refresh after", err));
    if (!saved) await db.loyaltySettings.deleteMany({ where: { id: "default" } });
  }

  console.log(failures === 0 ? `\nAll ${passes} customer loyalty checks passed.` : `\n${failures} customer loyalty check(s) FAILED.`);
  await db.$disconnect();
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  process.exit(1);
});
