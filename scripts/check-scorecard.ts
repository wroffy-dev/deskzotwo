/**
 * check:scorecard — Performance › Sales scorecard (src/lib/scorecard).
 *
 * The periods and rates by hand-worked cases first, then the figures for a fixture of its own in the financial year
 * 2001-02 — a customer, new business, a renewal, a lost renewal, an add-on, leads won and lost, calls — worked out by
 * hand and compared row by row. Everything is named ZZPROBE_SC and removed in a finally.
 *
 *   npm run check:scorecard
 */
import "dotenv/config";
import { directClient } from "../src/lib/tenancy/direct-client";

const db = directClient();
const TAG = "ZZPROBE_SC";
const MAIL = "@zzprobe-sc.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
/** A moment in the middle of an Indian day, clear of either midnight. */
const at = (iso: string) => new Date(`${iso}T06:30:00Z`);

async function cleanup() {
  const users = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  await db.target.deleteMany({ where: { label: { startsWith: TAG } } });
  await db.callLog.deleteMany({ where: { companyId: { in: companies } } });
  await db.lead.deleteMany({ where: { companyId: { in: companies } } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companies } } });
  const orders = { companyId: { in: companies } };
  await db.companyProduct.deleteMany({ where: { ...orders, parentId: { not: null } } });
  await db.companyProduct.deleteMany({ where: { ...orders, renewedFromId: { not: null } } });
  await db.companyProduct.deleteMany({ where: orders });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companies } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
  await db.user.deleteMany({ where: { id: { in: users } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const rules = require("../src/lib/scorecard/rules") as typeof import("../src/lib/scorecard/rules");
  const { buildScorecard, hasActivity } = require("../src/lib/scorecard/compute") as typeof import("../src/lib/scorecard/compute");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("Periods");
  const w = (today: string, period?: string, from?: string, to?: string) => {
    const x = rules.scorecardWindow(d(today), period, from, to);
    return `${x.fromDate}..${x.toDate}`;
  };
  ok("this financial year, by default: April to March", w("2026-10-31") === "2026-04-01..2027-03-31", w("2026-10-31"));
  ok("this quarter in October: October to December", w("2026-10-31", "this-quarter") === "2026-10-01..2026-12-31");
  ok("last quarter: July to September", w("2026-10-31", "last-quarter") === "2026-07-01..2026-09-30");
  ok("this month, last month", w("2026-10-31", "this-month") === "2026-10-01..2026-10-31" && w("2026-10-31", "last-month") === "2026-09-01..2026-09-30");
  ok("in January: last month is December, this quarter January to March, last quarter October to December", w("2027-01-15", "last-month") === "2026-12-01..2026-12-31" && w("2027-01-15", "this-quarter") === "2027-01-01..2027-03-31" && w("2027-01-15", "last-quarter") === "2026-10-01..2026-12-31");
  ok("…and this financial year is still the one that began in April 2026", w("2027-01-15", "this-fy") === "2026-04-01..2027-03-31");
  ok("last financial year", w("2026-10-31", "last-fy") === "2025-04-01..2026-03-31");
  ok("custom dates when both are whole days in order; this year otherwise", w("2026-10-31", undefined, "2026-05-01", "2026-05-31") === "2026-05-01..2026-05-31" && w("2026-10-31", undefined, "2026-06-01", "2026-05-01") === "2026-04-01..2027-03-31");

  section("Rates");
  const r = rules.leadRates({ won: 1, lost: 3, created: 5, createdClosed: 2 });
  ok("won 1 and lost 3: 25% won, 75% lost", r.wonRate === 25 && r.lostRate === 75);
  ok("closure: 2 of the 5 made in the period closed — 40%", r.closureRate === 40);
  const none = rules.leadRates({ won: 0, lost: 0, created: 0, createdClosed: 0 });
  ok("nothing closed or made: no rate, not 0%", none.wonRate === null && none.lostRate === null && none.closureRate === null);

  await cleanup();
  try {
    section("The fixture");
    const rep = await db.user.create({ data: { name: `${TAG} Rep`, email: `rep${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const quiet = await db.user.create({ data: { name: `${TAG} Quiet`, email: `quiet${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const company = await db.company.create({
      data: { name: `${TAG} Customer`, normalizedName: `${TAG} customer`.toLowerCase(), createdById: rep.id, ownerUserId: rep.id, relationshipType: "CLIENT", stage: "CUSTOMER" },
    });
    const site = await db.companyLocation.create({ data: { companyId: company.id, label: "Head Office", isPrimary: true, address: "1 MG Road", city: "Bengaluru", state: "Karnataka", pincode: "560001", country: "India" } });
    const sub = await db.item.create({ data: { name: `${TAG} Licence`, sku: `${TAG}-1`, type: "SUBSCRIPTION", billingCycle: "ANNUAL", sellingPrice: 1000, createdById: rep.id } });
    const goods = await db.item.create({ data: { name: `${TAG} Laptop`, sku: `${TAG}-2`, type: "GOOD", sellingPrice: 1000, createdById: rep.id } });
    type OrderInput = { item: string; qty: number; price: number; cost?: number; booked: string; type: "NEW" | "NEW_TO_US_RENEWAL" | "RENEWAL" | "ADDON"; start?: string; end?: string; renewedFrom?: string; parent?: string; stage?: "LOST" };
    const order = (o: OrderInput) =>
      db.companyProduct.create({
        data: {
          companyId: company.id,
          locationId: site.id,
          itemId: o.item,
          addedByUserId: rep.id,
          quantity: o.qty,
          unitPrice: o.price,
          fullTermUnitPrice: o.price,
          purchasePrice: o.cost ?? null,
          bookedAt: at(o.booked),
          businessType: o.type,
          startDate: o.start ? d(o.start) : null,
          endDate: o.end ? d(o.end) : null,
          renewedFromId: o.renewedFrom ?? null,
          parentId: o.parent ?? null,
          renewalStage: o.stage ?? null,
          orderStatus: "FULFILLED",
        },
      });
    // New: two laptops at 1,000 bought at 600 — 2,000, margin 800. And a licence won from elsewhere — 500, its cost unknown.
    await order({ item: goods.id, qty: 2, price: 1000, cost: 600, booked: "2001-05-10", type: "NEW" });
    await order({ item: sub.id, qty: 1, price: 500, booked: "2001-06-01", type: "NEW_TO_US_RENEWAL", start: "2000-10-01", end: "2001-09-30" });
    // A subscription from last year, ending in August, renewed: 2 at 1,100 bought at 800 — 2,200, margin 600.
    // New customers count from the first tax invoice (first-billed.ts), not the first order: billed the same September.
    await db.tradeDocument.create({ data: { docNumber: `${TAG}-INV1`, docType: "INVOICE", direction: "SALES", status: "ISSUED", companyId: company.id, createdById: rep.id, total: 2000, issueDate: at("2000-09-05") } });
    const old = await order({ item: sub.id, qty: 2, price: 1000, cost: 700, booked: "2000-09-01", type: "NEW", start: "2000-09-01", end: "2001-08-31" });
    const renewal = await order({ item: sub.id, qty: 2, price: 1100, cost: 800, booked: "2001-09-01", type: "RENEWAL", start: "2001-09-01", end: "2002-08-31", renewedFrom: old.id });
    // Another ending in October, marked lost.
    await order({ item: sub.id, qty: 1, price: 1000, booked: "2000-11-01", type: "NEW", start: "2000-11-01", end: "2001-10-31", stage: "LOST" });
    // Seats added to the renewal: 300, cost unknown.
    await order({ item: sub.id, qty: 1, price: 300, booked: "2001-10-01", type: "ADDON", start: "2001-10-01", end: "2002-08-31", parent: renewal.id });

    const lead = (title: string, status: "NEW" | "WON" | "LOST", created: string, moved: string) =>
      db.lead.create({ data: { title: `${TAG} ${title}`, companyId: company.id, ownerUserId: rep.id, sourcedByUserId: rep.id, status, createdAt: at(created), stageChangedAt: at(moved), estimatedValue: 1000 } });
    await lead("won", "WON", "2001-05-01", "2001-07-01");
    await lead("lost in the year", "LOST", "2001-05-02", "2001-08-01");
    await lead("made last year, lost in this one", "LOST", "2000-01-01", "2001-09-01");
    await lead("still open", "NEW", "2001-06-01", "2001-06-01");

    const call = (outcome: "CONNECTED" | "NO_ANSWER", seconds: number, when: string) =>
      db.callLog.create({ data: { companyId: company.id, userId: rep.id, phoneNumber: "9810000001", outcome, durationSeconds: seconds, startedAt: at(when) } });
    await call("CONNECTED", 120, "2001-05-03");
    await call("NO_ANSWER", 0, "2001-05-04");
    await call("CONNECTED", 60, "2001-05-05");
    ok("a customer, six orders, four leads and three calls", true);

    section("The scorecard for 2001-02");
    const window = rules.scorecardWindow(d("2026-10-31"), undefined, "2001-04-01", "2002-03-31");
    const rows = await buildScorecard(db as never, [{ id: rep.id, name: rep.name }, { id: quiet.id, name: quiet.name }], window);
    const a = rows.find((x) => x.userId === rep.id)!;
    const b = rows.find((x) => x.userId === quiet.id)!;
    ok("new business: 2,500 — the laptops and the licence won from elsewhere; margin 800 where known", a.orders.new.value === 2500 && a.orders.new.margin === 800, a.orders.new);
    ok("renewals: 2,200 at a margin of 600", a.orders.renewal.value === 2200 && a.orders.renewal.margin === 600, a.orders.renewal);
    ok("add-ons: 300", a.orders.addon.value === 300, a.orders.addon);
    ok("total business 5,000 — the three together, as Targets measures it", a.orderValue === 5000, a.orderValue);
    ok("margin 1,400, 33% of the 4,200 it is known on", a.orderMargin === 1400 && a.marginPercent === 33, `${a.orderMargin} ${a.marginPercent}%`);
    ok("a new customer: none — its first invoice was the year before", a.newCustomers === 0, a.newCustomers);
    ok("renewals due 3: renewed 1, lost 1, still open 1 — a rate of 50%", a.renewals.due === 3 && a.renewals.renewed === 1 && a.renewals.lost === 1 && a.renewals.open === 1 && a.renewals.rate === 50, a.renewals);
    ok("leads: won 1, lost 2 — won rate 33%, lost rate 67%", a.leads.won === 1 && a.leads.lost === 2 && a.leads.wonRate === 33 && a.leads.lostRate === 67, a.leads);
    ok("…made 3 in the year, 2 of them closed — closure rate 67%; 1 open now", a.leads.created === 3 && a.leads.closureRate === 67 && a.leads.open === 1, a.leads);
    ok("…the value of the one won", a.leads.wonValue === 1000, a.leads.wonValue);
    ok("calls: 3 made, 2 reached, 3 minutes", a.calls.made === 3 && a.calls.reached === 2 && a.calls.minutes === 3, a.calls);
    ok("the quiet one has nothing, and is left off unless asked for", !hasActivity(b) && hasActivity(a) && b.orderValue === 0 && b.leads.wonRate === null && b.renewals.rate === null);

    section("Targets and the Excel workbook");
    const target = (metric: "ORDER_VALUE" | "LEADS_WON" | "COLLECTED_VALUE", value: number, fromDate: string, toDate: string, scope: "USER" | "COMPANY" = "USER") =>
      db.target.create({ data: { metric, period: "YEAR", fromDate: d(fromDate), toDate: d(toDate), label: `${TAG} target`, scope, userId: scope === "USER" ? rep.id : null, value, createdById: rep.id } });
    await target("ORDER_VALUE", 4000, "2001-04-01", "2002-03-31");
    await target("LEADS_WON", 4, "2001-04-01", "2002-03-31");
    // Another stretch of time, and the company's own: neither is the rep's for this year.
    await target("COLLECTED_VALUE", 100, "2001-04-01", "2001-06-30");
    await target("COLLECTED_VALUE", 100, "2001-04-01", "2002-03-31", "COMPANY");
    const withTargets = (await buildScorecard(db as never, [{ id: rep.id, name: rep.name }], window))[0]!;
    ok("total business 5,000 of a 4,000 target: 125%", withTargets.targets.orderValue?.target === 4000 && withTargets.targets.orderValue.percent === 125, withTargets.targets);
    ok("leads won 1 of 4: 25%", withTargets.targets.leadsWon?.percent === 25);
    ok("a quarter's target and the company's aren't this year's for the rep", withTargets.targets.collected === undefined);
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const { scorecardWorkbook, scorecardFilename } = require("../src/lib/scorecard/workbook") as typeof import("../src/lib/scorecard/workbook");
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const ExcelJS = require("exceljs") as typeof import("exceljs");
    const file = await scorecardWorkbook([withTargets], { period: "FY 2001-02", fromDate: window.fromDate, toDate: window.toDate, by: "Zz Boss", takenAt: new Date() });
    const book = new ExcelJS.Workbook();
    await book.xlsx.load(file as never);
    const sheet = book.getWorksheet("Scorecard")!;
    const headers = (sheet.getRow(1).values as unknown[]).slice(1) as string[];
    const cell = (header: string) => sheet.getRow(2).getCell(headers.indexOf(header) + 1).value;
    ok("the workbook: a row a person, the figures as numbers", cell("Person") === rep.name && cell("Total business") === 5000 && cell("Margin %") === 33 && cell("Won rate %") === 33, headers.length);
    ok("…each target beside its figure, blank where none is set", cell("Total business target") === 4000 && cell("Leads won target") === 4 && (cell("Collected target") === null || cell("Collected target") === undefined));
    ok("…and a sheet saying what it is", !!book.getWorksheet("About") && scorecardFilename(window.fromDate, window.toDate) === "sales-scorecard-2001-04-01-to-2002-03-31.xlsx");

    const before = rules.scorecardWindow(d("2026-10-31"), undefined, "2000-04-01", "2001-03-31");
    const earlier = (await buildScorecard(db as never, [{ id: rep.id, name: rep.name }], before))[0]!;
    ok("the year before: the old subscriptions' 3,000, and the customer new that year", earlier.orderValue === 3000 && earlier.newCustomers === 1, `${earlier.orderValue} ${earlier.newCustomers}`);
  } finally {
    await cleanup();
    const left = (await db.user.count({ where: { email: { endsWith: MAIL } } })) + (await db.company.count({ where: { name: { startsWith: TAG } } }));
    ok("nothing of the fixture is left behind", left === 0, left);
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll scorecard checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
