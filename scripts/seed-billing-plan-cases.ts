/**
 * Live cases for billing plans on a local workspace (owner, 16 Nov 2026: "build it — can create some live cases in
 * localhost for testing"). One customer for each way subscriptions are paid, each with an order and its billing plan,
 * and today's recurring billing run for them — so the drafts, the renewals and Renewals › Billing check have something
 * real to show:
 *
 *   1. Monthly payment, annual commitment     a year, billed in monthly parts, keeps renewing
 *   2. Month to month                         a month's term that ended yesterday: renews today, keeps renewing
 *   3. Annual commitment, paid every 6 months a year, billed in half-yearly parts
 *   4. Annual commitment, paid quarterly      a year, billed in quarterly parts
 *   5. Monthly order, paid quarterly          a three-month term that ended yesterday: renews today, keeps renewing
 *   6. No plan                                a running subscription nobody bills — Billing check's "Nothing set to bill"
 *   7. Missed parts                           monthly parts from three months back, not run — Billing check's "Missed parts"
 *
 *   npx tsx scripts/seed-billing-plan-cases.ts            make them (again: the old ones are removed first)
 *   npx tsx scripts/seed-billing-plan-cases.ts --remove   remove them
 *
 * Never on a live workspace (prisma/seed-guard.ts). Everything it makes is named "Demo Billing —".
 */
import "../prisma/seed-guard";
import "dotenv/config";
import { db } from "../src/lib/db";
import { runRecurringBilling } from "../src/lib/recurring-billing/run";
import { orderPath } from "../src/lib/record-links";

/** The local workspace these go into, as the app serves it. */
const BASE = process.env.DEMO_WORKSPACE_URL ?? "http://deskzo.localhost:3000";

const TAG = "Demo Billing —";
const SKU = "DEMO-BILLING-M365";
const DAY = 86_400_000;

async function remove() {
  const companies = (await db.company.findMany({ where: { name: { startsWith: TAG } }, select: { id: true } })).map((c) => c.id);
  const orders = (await db.companyProduct.findMany({ where: { companyId: { in: companies } }, select: { id: true } })).map((o) => o.id);
  await db.recurringBillingPeriod.deleteMany({ where: { companyProductId: { in: orders } } });
  await db.recurringBilling.deleteMany({ where: { companyProductId: { in: orders } } });
  await db.tradeDocument.deleteMany({ where: { companyId: { in: companies } } });
  await db.companyProduct.deleteMany({ where: { id: { in: orders }, renewedFromId: { not: null } } });
  await db.companyProduct.deleteMany({ where: { id: { in: orders } } });
  await db.companyLocation.deleteMany({ where: { companyId: { in: companies } } });
  await db.company.deleteMany({ where: { id: { in: companies } } });
  await db.item.deleteMany({ where: { sku: SKU } });
  return companies.length;
}

async function main() {
  const removed = await remove();
  if (process.argv.includes("--remove")) {
    console.log(`Removed ${removed} demo customers and everything on them.`);
    return;
  }
  const owner = await db.user.findFirst({ where: { active: true, kind: "MEMBER", role: "ADMIN" }, orderBy: { createdAt: "asc" }, select: { id: true, name: true } });
  if (!owner) throw new Error("No active admin to own the demo records.");

  const today = new Date(new Date().toISOString().slice(0, 10) + "T00:00:00Z");
  const day = (offset: number) => new Date(today.getTime() + offset * DAY);
  const monthStart = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
  const plusMonths = (from: Date, months: number) => new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth() + months, from.getUTCDate()));
  const lastDayBefore = (d: Date) => new Date(d.getTime() - DAY);

  const item = await db.item.create({
    data: { name: "Microsoft 365 Business Basic (demo)", sku: SKU, type: "SUBSCRIPTION", billingCycle: "ANNUAL", sellingPrice: 12_000, taxRatePercent: 18, hsnCode: "997331", unit: "Nos", createdById: owner.id },
  });

  type Case = { name: string; start: Date; end: Date; price: number; plan?: { mode: "AUTO_RENEW" | "INSTALMENTS"; cycle?: "MONTHLY" | "QUARTERLY" | "HALF_YEARLY"; billFrom?: Date; keepRenewing?: boolean }; run: boolean };
  const yearFromMonth = monthStart;
  const cases: Case[] = [
    // 1. A year from the start of this month, a twelfth billed each month; this month's part raised today.
    { name: "Monthly payment, annual commitment", start: yearFromMonth, end: lastDayBefore(plusMonths(yearFromMonth, 12)), price: 12_000, plan: { mode: "INSTALMENTS", cycle: "MONTHLY", billFrom: yearFromMonth, keepRenewing: true }, run: true },
    // 2. A month that ended yesterday: renews into the next month today, its invoice drafted.
    { name: "Month to month", start: plusMonths(day(0), -1), end: day(-1), price: 1_000, plan: { mode: "AUTO_RENEW", keepRenewing: true }, run: true },
    // 3. A year from this month, billed in two halves; the first raised today.
    { name: "Annual commitment, paid every 6 months", start: yearFromMonth, end: lastDayBefore(plusMonths(yearFromMonth, 12)), price: 12_000, plan: { mode: "INSTALMENTS", cycle: "HALF_YEARLY", billFrom: yearFromMonth }, run: true },
    // 4. A year from three months ago, billed quarterly from this quarter's part.
    { name: "Annual commitment, paid quarterly", start: plusMonths(yearFromMonth, -3), end: lastDayBefore(plusMonths(yearFromMonth, 9)), price: 12_000, plan: { mode: "INSTALMENTS", cycle: "QUARTERLY", billFrom: yearFromMonth }, run: true },
    // 5. Three months that ended yesterday: renews into the next three months today, billed a quarter at a time.
    { name: "Monthly order, paid quarterly", start: plusMonths(day(0), -3), end: day(-1), price: 3_000, plan: { mode: "AUTO_RENEW", keepRenewing: true }, run: true },
    // 6. Running, nothing set to bill it, nothing invoiced.
    { name: "No plan set", start: yearFromMonth, end: lastDayBefore(plusMonths(yearFromMonth, 12)), price: 12_000, run: false },
    // 7. Monthly parts from three months back that the job hasn't raised.
    { name: "Missed parts", start: plusMonths(yearFromMonth, -3), end: lastDayBefore(plusMonths(yearFromMonth, 9)), price: 12_000, plan: { mode: "INSTALMENTS", cycle: "MONTHLY", billFrom: plusMonths(yearFromMonth, -3) }, run: false },
  ];

  const made: { name: string; orderId: string; seq: number }[] = [];
  for (const c of cases) {
    const company = await db.company.create({
      data: { name: `${TAG} ${c.name}`, normalizedName: `${TAG} ${c.name}`.toLowerCase(), createdById: owner.id, ownerUserId: owner.id, relationshipType: "CLIENT", stage: "CUSTOMER" },
    });
    const site = await db.companyLocation.create({
      data: { companyId: company.id, label: "Head Office", isPrimary: true, address: "1 MG Road", city: "Bengaluru", state: "Karnataka", pincode: "560001", country: "India" },
    });
    const order = await db.companyProduct.create({
      data: {
        companyId: company.id,
        locationId: site.id,
        itemId: item.id,
        addedByUserId: owner.id,
        quantity: 1,
        unitPrice: c.price,
        fullTermUnitPrice: c.price,
        startDate: c.start,
        endDate: c.end,
        orderStatus: "FULFILLED",
      },
      select: { id: true, orderSeq: true },
    });
    if (c.plan) {
      await db.recurringBilling.create({
        data: { companyProductId: order.id, mode: c.plan.mode, cycle: c.plan.cycle ?? null, billFrom: c.plan.billFrom ?? null, keepRenewing: c.plan.keepRenewing ?? false, setById: owner.id },
      });
    }
    made.push({ name: c.name, orderId: order.id, seq: order.orderSeq });
  }

  const toRun = made.filter((m, i) => cases[i]!.run).map((m) => m.orderId);
  const report = await runRecurringBilling({ only: toRun, claim: false, notify: false });

  console.log(`\nMade ${made.length} demo customers, owned by ${owner.name}. Today's billing for them: ${report.drafts} draft invoice(s), ${report.renewals} renewal(s).`);
  if (report.errors.length) console.log(`  Couldn't: ${report.errors.join(" | ")}`);
  for (const m of made) console.log(`  ${m.name.padEnd(40)} ${BASE}${orderPath(m.seq)}`);
  console.log(`\n  Renewals › Billing check   ${BASE}/renewals/billing`);
  console.log(`  The drafts                 ${BASE}/sales/invoices?status=DRAFT&origin=RECURRING_BILLING`);
  console.log("\nRemove them with: npx tsx scripts/seed-billing-plan-cases.ts --remove\n");
}

main()
  .catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
