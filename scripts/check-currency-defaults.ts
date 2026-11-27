/**
 * A customer's or vendor's own currency, and the exchange-rate table new documents start at (owner, 30 Oct 2026 —
 * src/lib/finance/rates.ts, src/lib/companies/default-currency.ts).
 *
 *   · `rateFor`: a typed rate is never overwritten by a fetch; a day without one takes the latest within the week before;
 *     past that, nothing — and a lookup's rate is kept, but only for a day that can stand in for the one asked.
 *   · A company's currency flows into a new document's form (prices converted) and into an invoice raised from an order.
 *   · With no rate to be had, the draft stays in the workspace's own currency.
 *
 * Never reaches the network: the provider lookup is replaced by a stand-in, and a set-up check proves it is live. The
 * table rows it uses are dated in 2019 or picked from currencies with nothing kept this week, and it removes exactly
 * what it made, in a finally — the dev database is shared and full.
 *
 *   npm run check:currency-defaults
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "ADMIN", name: "Zzprobe Currency" });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_FXDEF";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const day = (s: string) => new Date(`${s}T00:00:00.000Z`);

async function main() {
  // Required here, after the hook above: a top-of-file import would load them before the stubs exist.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const rates = require("../src/lib/finance/rates") as typeof import("../src/lib/finance/rates");
  const defaults = require("../src/lib/companies/default-currency") as typeof import("../src/lib/companies/default-currency");
  const draft = require("../src/lib/document-draft") as typeof import("../src/lib/document-draft");
  const invoiceDraft = require("../src/lib/orders/invoice-draft") as typeof import("../src/lib/orders/invoice-draft");
  const { baseCurrency, CURRENCY_CODES } = require("../src/lib/currency") as typeof import("../src/lib/currency");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
  /* eslint-enable @typescript-eslint/no-require-imports */

  // The provider, replaced: offline unless a case says otherwise. Every call is counted.
  let lookups = 0;
  let answer: Awaited<ReturnType<typeof rates.rateLookup.lookup>> = { ok: false, reason: "offline in the check" };
  rates.rateLookup.lookup = async () => {
    lookups += 1;
    return answer;
  };

  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;

  const base = baseCurrency();
  const today = (await workspaceClock()).today();
  const madeRates: string[] = [];
  const made = { documents: [] as string[], orders: [] as string[], companies: [] as string[], items: [] as string[] };
  const keep = async (currency: string, d: string) => {
    const row = await db.exchangeRate.findUnique({ where: { day_currency: { day: day(d), currency } }, select: { id: true } });
    if (row && !madeRates.includes(row.id)) madeRates.push(row.id);
  };

  try {
    section("Set-up");
    const before = lookups;
    ok("the provider stand-in is live", (await rates.rateFor("CHF", "2019-01-02")) === null && lookups === before + 1);
    const fixtureYear = await db.exchangeRate.count({ where: { currency: "CHF", day: { gte: day("2019-05-01"), lte: day("2019-07-31") } } });
    ok("nothing of the fixture's days is in the table already", fixtureYear === 0, `${fixtureYear} rows`);

    section("rateFor and the table");
    ok("the workspace's own currency is 1", (await rates.rateFor(base, "2019-06-10"))?.rate === 1);

    await rates.storeRate({ currency: "CHF", day: "2019-06-10", rate: 95.5, source: "typed", setById: actorId });
    await keep("CHF", "2019-06-10");
    const overwrote = await rates.storeRate({ currency: "CHF", day: "2019-06-10", rate: 90, source: "fetched" });
    const stillTyped = await db.exchangeRate.findUnique({ where: { day_currency: { day: day("2019-06-10"), currency: "CHF" } } });
    ok("a fetch never overwrites a typed rate", !overwrote && stillTyped?.source === "typed" && Number(stillTyped.rate) === 95.5, `${stillTyped?.source} ${stillTyped?.rate}`);

    await rates.storeRate({ currency: "CHF", day: "2019-06-05", rate: 92, source: "fetched" });
    await keep("CHF", "2019-06-05");
    const refreshed = await rates.storeRate({ currency: "CHF", day: "2019-06-05", rate: 92.25, source: "fetched" });
    ok("  a fetch refreshes an earlier fetch", refreshed && (await rates.storedRateFor("CHF", "2019-06-05"))?.rate === 92.25);
    await rates.storeRate({ currency: "CHF", day: "2019-06-05", rate: 93, source: "typed", setById: actorId });
    ok("  and a typed rate replaces a fetched one", (await rates.storedRateFor("CHF", "2019-06-05"))?.source === "typed");

    const onDay = await rates.rateFor("CHF", "2019-06-10");
    ok("the day's own rate", onDay?.rate === 95.5 && onDay.day === "2019-06-10" && onDay.source === "typed", JSON.stringify(onDay));
    const later = await rates.rateFor("CHF", "2019-06-12");
    ok("a day without one takes the latest earlier", later?.day === "2019-06-10" && later.rate === 95.5, JSON.stringify(later));
    const between = await rates.rateFor("CHF", "2019-06-08");
    ok("  the latest earlier, not a later one", between?.day === "2019-06-05", JSON.stringify(between));
    const edge = await rates.rateFor("CHF", "2019-06-17");
    ok("  seven days back still stands", edge?.day === "2019-06-10", JSON.stringify(edge));
    const n = lookups;
    ok("eight days back doesn't — nothing, without a fetch", (await rates.rateFor("CHF", "2019-06-18", { fetch: false })) === null && lookups === n);
    ok("  nor with one, when the provider has none", (await rates.rateFor("CHF", "2019-06-18")) === null && lookups === n + 1);

    answer = { ok: true, rate: 96.1234, source: "stand-in", onDate: "2019-06-28" };
    const fetched = await rates.rateFor("CHF", "2019-07-01");
    await keep("CHF", "2019-06-28");
    const kept = await rates.storedRateFor("CHF", "2019-06-28");
    ok("a looked-up rate is returned and kept as fetched, for the day it is for", fetched?.rate === 96.1234 && kept?.source === "fetched" && kept.day === "2019-06-28", JSON.stringify(kept));
    answer = { ok: true, rate: 97, source: "stand-in", onDate: "2019-07-20" };
    ok("  a rate from after the day asked for is not used", (await rates.rateFor("CHF", "2019-05-15")) === null);
    answer = { ok: false, reason: "offline in the check" };

    section("A company's currency");
    // Two currencies with nothing kept in the last eight days: one is given a typed rate for today, one is left without.
    const recent = await db.exchangeRate.findMany({ where: { day: { gte: day(new Date(Date.parse(`${today}T00:00:00Z`) - 8 * 86_400_000).toISOString().slice(0, 10)) } }, select: { currency: true } });
    const busy = new Set(recent.map((r) => r.currency));
    const free = (CURRENCY_CODES as readonly string[]).filter((c) => c !== base && !busy.has(c));
    if (free.length < 2) {
      ok("two currencies free of this week's rates to test with", false, `free: ${free.join(", ") || "none"}`);
      return;
    }
    const [withRate, withoutRate] = [free[0]!, free[1]!];
    const RATE = 80;
    await rates.storeRate({ currency: withRate, day: today, rate: RATE, source: "typed", setById: actorId });
    await keep(withRate, today);

    const item = await db.item.create({ data: { name: `${TAG} Licence`, sku: `${TAG}-1`, type: "SERVICE", sellingPrice: 8000, taxRatePercent: 18, hsnCode: "997331", createdById: actorId } });
    made.items.push(item.id);
    const company = async (name: string, currency: string | null) => {
      const c = await db.company.create({
        data: {
          name: `${TAG} ${name}`,
          normalizedName: `${TAG} ${name}`.toLowerCase(),
          createdById: actorId,
          ownerUserId: actorId,
          relationshipType: "CLIENT",
          stage: "CUSTOMER",
          locations: {
            create: { label: "Head Office", isPrimary: true, isBilling: true, isShipping: true, address: "1 MG Road", city: "Bengaluru", state: "Karnataka", pincode: "560001", country: "India" },
          },
        },
        select: { id: true, locations: { select: { id: true } } },
      });
      made.companies.push(c.id);
      if (currency) await defaults.saveCompanyCurrency(c.id, currency);
      return c;
    };
    const abroad = await company("Abroad", withRate);
    const unpriced = await company("Unpriced", withoutRate);
    const home = await company("Home", null);

    ok("the currency is kept and read back", (await defaults.companyCurrency(abroad.id)) === withRate);
    ok("  none set is the workspace's own", (await defaults.companyCurrency(home.id)) === null);
    await defaults.saveCompanyCurrency(home.id, base);
    ok("  the workspace's own, set, is kept as none", (await defaults.companyCurrency(home.id)) === null);

    const form = (companyId: string) => {
      const d = draft.emptyDefaults({ today: () => today } as Parameters<typeof draft.emptyDefaults>[0]);
      d.companyId = companyId;
      d.lines = [{ ...draft.blankLine(), unitPrice: "8000" }];
      return d;
    };
    const f1 = form(abroad.id);
    await defaults.applyPartyCurrency(f1, { fetch: false });
    ok("a new document's form starts in the party's currency at the day's rate", f1.currency === withRate && f1.exchangeRate === RATE, `${f1.currency} @ ${f1.exchangeRate}`);
    ok("  its opening prices converted", f1.lines[0]!.unitPrice === "100", f1.lines[0]!.unitPrice);
    const f2 = form(unpriced.id);
    await defaults.applyPartyCurrency(f2, { fetch: false });
    ok("no rate known: the form stays in the workspace's currency", f2.currency === base && f2.exchangeRate === 1 && f2.lines[0]!.unitPrice === "8000", `${f2.currency} @ ${f2.exchangeRate}`);
    const f3 = form(home.id);
    await defaults.applyPartyCurrency(f3, { fetch: false });
    ok("  as does a party in it", f3.currency === base && f3.exchangeRate === 1);
    const edit = { ...form(abroad.id), id: "an-existing-document" };
    await defaults.applyPartyCurrency(edit, { fetch: false });
    ok("  and an edit keeps what it was written in", edit.currency === base);

    section("An invoice raised from an order");
    const order = async (c: { id: string; locations: { id: string }[] }) => {
      const o = await db.companyProduct.create({
        data: { companyId: c.id, locationId: c.locations[0]!.id, itemId: item.id, addedByUserId: actorId, quantity: 2, unitPrice: 8000, orderStatus: "APPROVED" },
        select: { id: true },
      });
      made.orders.push(o.id);
      return o;
    };
    const raise = async (c: { id: string; locations: { id: string }[] }) => {
      const o = await order(c);
      const orders = await invoiceDraft.loadOrders([o.id]);
      if (!orders) return null;
      const result = await invoiceDraft.createOrderInvoiceDraft(orders, actorId);
      if (!result.ok) return result.error;
      made.documents.push(result.data.id);
      return db.tradeDocument.findUnique({ where: { id: result.data.id }, select: { currency: true, exchangeRate: true, lines: { select: { unitPrice: true } } } });
    };
    const lookupsBefore = lookups;
    const inTheirs = await raise(abroad);
    ok(
      "in the customer's currency at the day's rate, the order's price converted",
      typeof inTheirs === "object" && inTheirs?.currency === withRate && Number(inTheirs.exchangeRate) === RATE && Number(inTheirs.lines[0]?.unitPrice) === 100,
      JSON.stringify(inTheirs),
    );
    const inOurs = await raise(unpriced);
    ok(
      "no rate known: in the workspace's currency at the order's price",
      typeof inOurs === "object" && inOurs?.currency === base && Number(inOurs.exchangeRate) === 1 && Number(inOurs.lines[0]?.unitPrice) === 8000,
      JSON.stringify(inOurs),
    );
    ok("  having asked the provider (the stand-in) only for the one without", lookups === lookupsBefore + 1, `${lookups - lookupsBefore} lookups`);
    const plain = await raise(home);
    ok("a customer in the workspace's currency is as before", typeof plain === "object" && plain?.currency === base && Number(plain.lines[0]?.unitPrice) === 8000);
  } finally {
    for (const id of made.documents) await db.tradeDocument.delete({ where: { id } }).catch(() => {});
    await db.auditLog.deleteMany({ where: { entityId: { in: [...made.documents, ...made.orders, ...made.companies] } } }).catch(() => {});
    for (const id of made.orders) await db.companyProduct.delete({ where: { id } }).catch(() => {});
    await db.companyLocation.deleteMany({ where: { companyId: { in: made.companies } } }).catch(() => {});
    for (const id of made.companies) await db.company.delete({ where: { id } }).catch(() => {});
    for (const id of made.items) await db.item.delete({ where: { id } }).catch(() => {});
    await db.exchangeRate.deleteMany({ where: { id: { in: madeRates } } });
    const left = (await db.company.count({ where: { name: { startsWith: TAG } } })) + (await db.exchangeRate.count({ where: { id: { in: madeRates } } }));
    ok("the fixture cleaned up after itself", left === 0, `${left} left behind`);
  }
}

main()
  .then(async () => {
    await db.$disconnect();
    console.log(failures === 0 ? "\nAll checks passed." : `\n${failures} failed.`);
    process.exit(failures === 0 ? 0 : 1);
  })
  .catch(async (error) => {
    console.error(error);
    await db.$disconnect();
    process.exit(1);
  });
