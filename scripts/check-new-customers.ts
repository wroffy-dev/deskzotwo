/**
 * check:new-customers — Performance › New customers, and Targets' "New customers won" (owner, 9 Nov 2026: "billed, not
 * just the record added"). src/lib/customers/first-billed.ts.
 *
 * Companies of its own (ZZPROBE_NC) in FY 2019–20, a year nothing real is in: billed first in the year, to a salesperson
 * or with none; billed the year before; only a draft and a cancelled invoice; billed first in the old system's archive.
 * The report's months and people, the drill-down's list, and the measure agree. Removed in a finally.
 *
 *   npm run check:new-customers
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor: { id: string; role: string; name: string; email: string } | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_NC";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function cleanup() {
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  await db.archivedDocument.deleteMany({ where: { number: { startsWith: TAG } } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companies } } });
  await db.companyProduct.deleteMany({ where: { companyId: { in: companies } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companies } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.item.deleteMany({ where: { sku: { startsWith: TAG } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { newBilledCustomers } = require("../src/actions/new-customers") as typeof import("../src/actions/new-customers");
  const { getSource } = require("../src/lib/analytics/sources") as typeof import("../src/lib/analytics/sources");
  const { measure } = require("../src/lib/targets/measure") as typeof import("../src/lib/targets/measure");
  await cleanup();
  try {
    const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true, role: true, name: true, email: true } });
    const seller = await db.user.findFirstOrThrow({ where: { active: true, isSuperAdmin: false, kind: "MEMBER" }, select: { id: true, name: true } });
    actor = admin;
    const company = (name: string, owner: string | null) => db.company.create({ data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), ownerUserId: owner, createdById: admin.id }, select: { id: true } });
    // Noon India time, so the day is the same on any workspace clock nearby.
    const at = (day: string) => new Date(`${day}T12:00:00+05:30`);
    const invoice = (companyId: string, n: string, day: string, opts: { status?: "ISSUED" | "DRAFT" | "CANCELLED"; salespersonId?: string | null; total?: number; lines?: { name: string; taxableValue: number; quantity?: number; itemId?: string; companyProductId?: string }[] } = {}) =>
      db.tradeDocument.create({ data: { docNumber: `${TAG}-${n}`, docType: "INVOICE", direction: "SALES", status: opts.status ?? "ISSUED", companyId, createdById: admin.id, salespersonId: opts.salespersonId ?? null, total: opts.total ?? 1000, issueDate: at(day), lines: { create: (opts.lines ?? []).map((l) => ({ name: l.name, quantity: l.quantity ?? 1, unitPrice: l.taxableValue, taxableValue: l.taxableValue, lineTotal: l.taxableValue, itemId: l.itemId ?? null, companyProductId: l.companyProductId ?? null })) } } });

    const laptop = await db.item.create({ data: { name: `${TAG} Laptop`, sku: `${TAG}-L`, type: "GOOD", sellingPrice: 50000, costPrice: 30000, createdById: admin.id } });
    const licence = await db.item.create({ data: { name: `${TAG} Licence`, sku: `${TAG}-S`, type: "SUBSCRIPTION", sellingPrice: 12000, createdById: admin.id } });
    const bySeller = await company("by seller", admin.id);
    await invoice(bySeller.id, "A1", "2019-05-10", { salespersonId: seller.id, total: 50000, lines: [{ name: "Laptop", taxableValue: 50000, itemId: laptop.id }] });
    await invoice(bySeller.id, "A2", "2019-08-01", { salespersonId: seller.id });
    const byOwner = await company("by owner", seller.id);
    await invoice(byOwner.id, "B1", "2019-11-20");
    const returning = await company("returning", seller.id);
    await invoice(returning.id, "C0", "2018-12-01", { salespersonId: seller.id });
    // A month's bill of a yearly renewal bought at 9,000 of 12,000: a month's share of the cost, 750 of 1,000.
    const site = await db.companyLocation.create({ data: { companyId: returning.id, label: "Head Office", isPrimary: true, address: "1 MG Road", city: "Bengaluru", state: "Karnataka", pincode: "560001", country: "India" } });
    const renewal = await db.companyProduct.create({ data: { companyId: returning.id, locationId: site.id, itemId: licence.id, addedByUserId: seller.id, quantity: 1, unitPrice: 12000, fullTermUnitPrice: 12000, purchasePrice: 9000, bookedAt: at("2019-06-01"), businessType: "RENEWAL", orderStatus: "FULFILLED" } });
    await invoice(returning.id, "C1", "2019-06-01", { salespersonId: seller.id, lines: [{ name: "Licence, June", taxableValue: 1000, companyProductId: renewal.id }, { name: "Setup, typed in", taxableValue: 500 }] });
    const notBilled = await company("not billed", seller.id);
    await invoice(notBilled.id, "D1", "2019-07-01", { status: "DRAFT", salespersonId: seller.id });
    await invoice(notBilled.id, "D2", "2019-07-02", { status: "CANCELLED", salespersonId: seller.id });
    const fromBefore = await company("old system", seller.id);
    await invoice(fromBefore.id, "E1", "2019-09-01", { salespersonId: seller.id });
    const migration = await db.migration.findFirst({ select: { id: true } }).catch(() => null);
    if (migration) {
      await db.archivedDocument.create({ data: { migrationId: migration.id, kind: "INVOICE", key: `${TAG}-E0`, number: `${TAG}-E0`, date: new Date("2017-03-01T00:00:00Z"), year: "2016-17", partyName: `${TAG} old system`, companyId: fromBefore.id, total: 500 } });
    }

    const view = (await newBilledCustomers({ year: 2019 }))!;
    const mine = view.customers.filter((c) => c.name.startsWith(TAG));
    const named = (n: string) => mine.find((c) => c.name === `${TAG} ${n}`);
    ok("billed first in the year: counted, in the month of its first invoice", named("by seller")?.month === 1 && named("by seller")?.number === `${TAG}-A1`, named("by seller"));
    ok("…credited to the salesperson on that invoice, not the account manager", named("by seller")?.userId === seller.id && named("by seller")?.creditFrom === "SALESPERSON");
    ok("…its first invoice's value, not its second's", named("by seller")?.value === 50000);
    ok("no salesperson on it: the account manager", named("by owner")?.userId === seller.id && named("by owner")?.creditFrom === "ACCOUNT_MANAGER" && named("by owner")?.month === 7);
    ok("billed the year before: a returning customer, not new", !named("returning"));
    ok("only a draft and a cancelled invoice: not a customer yet", !named("not billed"));
    if (migration) ok("billed first in the old system's archive: not new", !named("old system"));
    else console.log("  ..   no migration here to archive under — the archive case is skipped");
    ok("every customer once", new Set(mine.map((c) => c.companyId)).size === mine.length);
    const row = view.people.find((p) => p.userId === seller.id);
    ok("the person's months and year add up", !!row && row.total === row.counts.reduce((t, n) => t + n, 0) && row.counts[1]! >= 1 && row.counts[7]! >= 1, row);
    ok("the months' totals are everyone's", view.totals.reduce((t, n) => t + n, 0) === view.total);
    ok("a financial year runs April to March", view.months[0] === "Apr" && view.months[11] === "Mar" && view.label === "FY 2019–20");

    const won = await measure(db as never, "NEW_CUSTOMERS", { from: new Date("2019-04-01T00:00:00Z"), to: new Date("2020-03-31T00:00:00Z"), userIds: [seller.id] });
    ok("Targets' New customers won agrees with the report", won === (view.people.find((p) => p.userId === seller.id)?.total ?? 0), { measured: won });

    actor = { ...admin, id: seller.id };
    // Reports › Invoices (and the New vs old customers template) for the same year.
    const source = getSource("invoices")!;
    const rows = ((await source.load({ userId: admin.id, from: new Date("2019-03-31T18:30:00Z"), to: new Date("2020-03-31T18:30:00Z"), dateColumn: "issueDate" } as never)) as never as { company: { name: string } }[]).filter((r) => r.company.name.startsWith(TAG));
    const sum = (key: string, name?: string) => { const m = source.measures.find((x) => x.key === key)!; return rows.filter((r) => !name || r.company.name === `${TAG} ${name}`).reduce((t, r) => t + m.value(r as never), 0); };
    const age = (name: string) => { const d = source.dimensions.find((x) => x.key === "customerAge")!; return [...new Set(rows.filter((r) => r.company.name === `${TAG} ${name}`).map((r) => d.of(r as never)))].join(); };
    ok("Reports: billed first this year is a new customer, billed before an old one", age("by seller") === "New customer" && age("returning") === "Old customer" && age("old system") === "Old customer", [age("by seller"), age("returning"), age("old system")]);
    ok("Reports: turnover before GST from the lines", sum("turnover", "by seller") === 50000 && sum("turnover", "returning") === 1500, [sum("turnover", "by seller"), sum("turnover", "returning")]);
    ok("Reports: an item's cost price, per unit", sum("cost", "by seller") === 30000 && sum("margin", "by seller") === 20000);
    ok("Reports: a month of a yearly renewal costs a month's share", sum("cost", "returning") === 750 && sum("renewalTurnover", "returning") === 1000 && sum("freshTurnover", "returning") === 500);
    ok("Reports: a line with no cost is left out of the margin, not counted as profit", sum("costedTurnover", "returning") === 1000 && sum("margin", "returning") === 250);
    ok("Reports: each customer once, at their first invoice", sum("customers", "by seller") === 1 && sum("customers") === new Set(rows.map((r) => r.company.name)).size);
    const { REPORT_TEMPLATES } = require("../src/lib/reporting/templates") as typeof import("../src/lib/reporting/templates");
    ok("the New vs old customers template is there", REPORT_TEMPLATES.some((t) => t.key === "new-vs-old-customers"));

    const { hasEffectivePermission } = require("../src/actions/permission") as typeof import("../src/actions/permission");
    const allowed = await hasEffectivePermission(seller.id, "performance.view");
    const refused = await newBilledCustomers({ year: 2019 });
    ok("it follows Performance view: shown to who may, nothing to who may not", allowed ? refused !== null : refused === null, { allowed });
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
