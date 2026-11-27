/**
 * check:customer-history-filters — the customer list's filters on its history with us (owner, 17 Nov 2026 —
 * src/lib/customers/history-filters.ts): Lifetime value, Last 12 months, Orders (live), Last purchase, Renewal rate,
 * Last activity, Customer since and Pays in, each against three customers whose stored figures differ. Run on the
 * database as the list runs them, narrowed to its own customers; removed in a finally.
 *
 *   npm run check:customer-history-filters
 */
import "dotenv/config";
import { db } from "../src/lib/db";
import { workspaceClock } from "../src/lib/time/workspace";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const TAG = "ZZHISTFILTER";
const DAY = 86_400_000;

async function main() {
  const { historyFilterWhere } = await import("../src/lib/customers/history-filters");
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin");
  const clock = await workspaceClock();
  const now = new Date();
  const ago = (d: number) => new Date(now.getTime() - d * DAY);
  const made: string[] = [];
  try {
    const customer = async (name: string, stats: Record<string, unknown>) => {
      const c = await db.company.create({ data: { name: `${TAG} ${name}`, normalizedName: `${TAG} ${name}`.toLowerCase(), createdById: admin.id, ownerUserId: admin.id, relationshipType: "CLIENT", stage: "CUSTOMER" } as never, select: { id: true } });
      made.push(c.id);
      await db.customerStats.create({ data: { companyId: c.id, ...stats } as never });
      return c.id;
    };
    // A: a champion. B: lapsed, slow to pay. C: in between, no renewals due yet.
    const a = await customer("Alpha", { lifetimeValue: 500000, last12Value: 200000, orders: 6, liveSubscriptions: 2, lastPurchaseAt: ago(10), renewalsDue: 10, renewalsRenewed: 9, avgDaysToPay: 20, overdue: 0, firstOrderAt: new Date("2023-01-15T00:00:00Z") });
    const b = await customer("Bravo", { lifetimeValue: 50000, last12Value: 0, orders: 1, liveSubscriptions: 0, lastPurchaseAt: ago(400), renewalsDue: 4, renewalsRenewed: 1, avgDaysToPay: 75, overdue: 5000, firstOrderAt: new Date("2025-06-01T00:00:00Z") });
    const c = await customer("Charlie", { lifetimeValue: 150000, last12Value: 60000, orders: 3, liveSubscriptions: 1, lastPurchaseAt: ago(100), renewalsDue: 0, renewalsRenewed: 0, avgDaysToPay: 45, overdue: 0, firstOrderAt: new Date("2024-03-10T00:00:00Z") });
    const names = new Map([[a, "A"], [b, "B"], [c, "C"]]);

    const run = async (params: Record<string, string>) => {
      const where = await historyFilterWhere(params, clock, true, now);
      const rows = await db.company.findMany({ where: { AND: [{ id: { in: made } }, ...where] }, select: { id: true } });
      return rows.map((r) => names.get(r.id)).sort().join("");
    };
    const expect = async (label: string, params: Record<string, string>, want: string) => {
      const got = await run(params);
      ok(`${label}: ${want || "none"}`, got === want, got);
    };

    await expect("Lifetime value from ₹1,00,000", { ltvMin: "1,00,000" }, "AC");
    await expect("  ₹1,00,000 to ₹2,00,000", { ltvMin: "100000", ltvMax: "200000" }, "C");
    await expect("Last 12 months up to ₹10,000", { l12Max: "10000" }, "B");
    await expect("With a live subscription", { liveOrders: "live" }, "AC");
    await expect("  none live", { liveOrders: "none" }, "B");
    await expect("  5 or more orders", { liveOrders: "five" }, "A");
    await expect("  one order only", { liveOrders: "one" }, "B");
    await expect("Last purchase in the last 30 days", { lastPurchase: "30" }, "A");
    await expect("  in the last 6 months", { lastPurchase: "180" }, "AC");
    await expect("  none in 12 months", { lastPurchase: "over365" }, "B");
    await expect("Renewal rate 80% and above", { renewalRate: "high" }, "A");
    await expect("  below 50%", { renewalRate: "low" }, "B");
    await expect("  none due yet", { renewalRate: "none" }, "C");
    await expect("Customer since 2024 onwards", { sinceFrom: "2024-01-01" }, "BC");
    await expect("  during 2023", { sinceFrom: "2023-01-01", sinceTo: "2023-12-31" }, "A");
    await expect("Pays within 30 days", { paysIn: "30" }, "A");
    await expect("  31–60 days", { paysIn: "60" }, "C");
    await expect("  over 60 days", { paysIn: "slow" }, "B");
    await expect("  has something overdue", { paysIn: "overdue" }, "B");
    await expect("Last activity in the last 30 days (none logged)", { activity: "30" }, "");
    await expect("  none in 30 days", { activity: "none30" }, "ABC");
    await expect("Two together: live and paying slowly", { liveOrders: "live", paysIn: "slow" }, "");
    await expect("No filter at all: all three", {}, "ABC");
    ok("without the stats table, a stats filter matches nobody rather than failing", (await historyFilterWhere({ ltvMin: "1" }, clock, false, now)).some((w) => JSON.stringify(w) === '{"id":{"in":[]}}'));
  } finally {
    await db.customerStats.deleteMany({ where: { companyId: { in: made } } });
    await db.company.deleteMany({ where: { id: { in: made } } });
  }
}

main()
  .then(() => {
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
