/**
 * An item's own prices in other currencies (owner, 30 Oct 2026 — `ItemPrice`, src/lib/items/currency-prices.ts).
 *
 *   · Saved as a whole list: a currency left out goes, the workspace's own is never kept.
 *   · `itemPricesIn`: the selling price on a sale; on a purchase the cost price, else the selling price; null without one.
 *   · A new document's form for a foreign-currency party: a catalogue-priced line takes the item's own price, a line
 *     without one converts, an order's agreed price converts; a purchase takes the cost price.
 *   · An invoice raised from orders: an order with no price of its own takes the item's own price; one with an agreed
 *     price converts it.
 *   · A workspace without the table yet: no own prices, so everything converts as before.
 *
 * Never reaches the network (the rate provider is replaced by a stand-in). The rate it types is for a currency with
 * nothing kept this week, and it removes exactly what it made, in a finally — the dev database is shared and full.
 *
 *   npm run check:item-currency-prices
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
/** Set while a case plays a workspace not migrated to item_prices: the helper's reads then fail as that one's would. */
let unmigrated = false;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "ADMIN", name: "Zzprobe Item Currency" });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  const from = (parent as { filename?: string } | null)?.filename ?? "";
  if (request === "@/lib/db" && /currency-prices\.ts$/.test(from)) {
    const real = originalLoad.call(this, request, parent, isMain) as { db: Record<string | symbol, unknown> };
    const missing = () => Promise.reject(new Error('relation "item_prices" does not exist'));
    const db = new Proxy(real.db, {
      get(target, prop) {
        if (unmigrated && prop === "itemPrice") return { findMany: missing, deleteMany: missing, upsert: missing };
        if (unmigrated && prop === "$transaction") return missing;
        return Reflect.get(target, prop);
      },
    });
    return { ...real, db };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_ITEMFX";
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
  const prices = require("../src/lib/items/currency-prices") as typeof import("../src/lib/items/currency-prices");
  const defaults = require("../src/lib/companies/default-currency") as typeof import("../src/lib/companies/default-currency");
  const draft = require("../src/lib/document-draft") as typeof import("../src/lib/document-draft");
  const invoiceDraft = require("../src/lib/orders/invoice-draft") as typeof import("../src/lib/orders/invoice-draft");
  const { baseCurrency, CURRENCY_CODES } = require("../src/lib/currency") as typeof import("../src/lib/currency");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
  /* eslint-enable @typescript-eslint/no-require-imports */

  rates.rateLookup.lookup = async () => ({ ok: false, reason: "offline in the check" });

  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;

  const base = baseCurrency();
  const today = (await workspaceClock()).today();
  const madeRates: string[] = [];
  const made = { documents: [] as string[], orders: [] as string[], companies: [] as string[], items: [] as string[] };

  try {
    section("Set-up");
    const recent = await db.exchangeRate.findMany({ where: { day: { gte: day(new Date(Date.parse(`${today}T00:00:00Z`) - 8 * 86_400_000).toISOString().slice(0, 10)) } }, select: { currency: true } });
    const busy = new Set(recent.map((r) => r.currency));
    const free = (CURRENCY_CODES as readonly string[]).filter((c) => c !== base && c !== "JPY" && !busy.has(c));
    if (free.length < 2) {
      ok("two currencies free of this week's rates to test with", false, `free: ${free.join(", ") || "none"}`);
      return;
    }
    const [fx, other] = [free[0]!, free[1]!];
    const RATE = 80;
    await rates.storeRate({ currency: fx, day: today, rate: RATE, source: "typed", setById: actorId });
    const rateRow = await db.exchangeRate.findUnique({ where: { day_currency: { day: day(today), currency: fx } }, select: { id: true } });
    if (rateRow) madeRates.push(rateRow.id);
    ok(`testing in ${fx} at ${RATE}`, !!rateRow);

    const item = async (n: string, sellingPrice: number) => {
      const row = await db.item.create({ data: { name: `${TAG} ${n}`, sku: `${TAG}-${n}`, type: "SERVICE", sellingPrice, costPrice: sellingPrice / 2, taxRatePercent: 18, hsnCode: "997331", createdById: actorId } });
      made.items.push(row.id);
      return row;
    };
    const priced = await item("Priced", 8000);
    const plain = await item("Plain", 8000);

    section("Saving an item's own prices");
    ok(
      "a list is saved",
      await prices.saveItemCurrencyPrices(priced.id, [
        { currency: fx, sellingPrice: 95, costPrice: 70 },
        { currency: other, sellingPrice: 88, costPrice: null },
        { currency: base, sellingPrice: 1, costPrice: null },
      ]),
    );
    const saved = (await prices.itemCurrencyPrices([priced.id])).get(priced.id) ?? [];
    ok("  one row a currency, the workspace's own left out", saved.length === 2 && !saved.some((p) => p.currency === base), JSON.stringify(saved));
    await prices.saveItemCurrencyPrices(priced.id, [{ currency: fx, sellingPrice: 99, costPrice: 72 }]);
    const after = (await prices.itemCurrencyPrices([priced.id])).get(priced.id) ?? [];
    ok("  saved again: a currency left out goes, one kept is updated", after.length === 1 && after[0]!.sellingPrice === 99 && after[0]!.costPrice === 72, JSON.stringify(after));
    await prices.saveItemCurrencyPrices(priced.id, [{ currency: fx, sellingPrice: 95, costPrice: 70 }, { currency: other, sellingPrice: 88, costPrice: null }]);

    section("itemPricesIn");
    ok("a sale takes the selling price", (await prices.itemPriceIn(priced.id, fx)) === 95);
    ok("a purchase takes the cost price", (await prices.itemPriceIn(priced.id, fx, { purchase: true })) === 70);
    ok("  else the selling price in that currency", (await prices.itemPriceIn(priced.id, other, { purchase: true })) === 88);
    ok("an item without one: null", (await prices.itemPriceIn(plain.id, fx)) === null);
    ok("the workspace's own currency: null", (await prices.itemPriceIn(priced.id, base)) === null);
    const batch = await prices.itemPricesIn([priced.id, plain.id], fx);
    ok("the batch has only the items with one", batch.size === 1 && batch.get(priced.id) === 95);

    section("A new document's form, in the party's currency");
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
    const abroad = await company("Abroad", fx);
    const form = () => {
      const d = draft.emptyDefaults({ today: () => today } as Parameters<typeof draft.emptyDefaults>[0]);
      d.companyId = abroad.id;
      d.lines = [
        { ...draft.blankLine(), itemId: priced.id, unitPrice: "8000" },
        { ...draft.blankLine(), itemId: plain.id, unitPrice: "8000" },
        { ...draft.blankLine(), itemId: priced.id, companyProductId: "an-order", unitPrice: "8000" },
      ];
      return d;
    };
    const f1 = form();
    await defaults.applyPartyCurrency(f1, { fetch: false, cataloguePriced: (l) => !l.companyProductId });
    ok(`in ${fx}`, f1.currency === fx && f1.exchangeRate === RATE, `${f1.currency} @ ${f1.exchangeRate}`);
    ok("  a catalogue line takes the item's own price", f1.lines[0]!.unitPrice === "95", f1.lines[0]!.unitPrice);
    ok("  an item without one converts its base price", f1.lines[1]!.unitPrice === "100", f1.lines[1]!.unitPrice);
    ok("  an order's agreed price converts", f1.lines[2]!.unitPrice === "100", f1.lines[2]!.unitPrice);
    const f2 = form();
    await defaults.applyPartyCurrency(f2, { fetch: false, cataloguePriced: (l) => !l.companyProductId, purchase: true });
    ok("  a purchase takes the cost price in it", f2.lines[0]!.unitPrice === "70", f2.lines[0]!.unitPrice);
    const f3 = form();
    await defaults.applyPartyCurrency(f3, { fetch: false });
    ok("  without saying which lines are the catalogue's, every line converts (as in phase 1)", f3.lines[0]!.unitPrice === "100", f3.lines[0]!.unitPrice);

    section("An invoice raised from orders");
    const raise = async (unitPrice: number | null, itemId: string) => {
      const o = await db.companyProduct.create({
        data: { companyId: abroad.id, locationId: abroad.locations[0]!.id, itemId, addedByUserId: actorId, quantity: 2, ...(unitPrice === null ? {} : { unitPrice }), orderStatus: "APPROVED" },
        select: { id: true },
      });
      made.orders.push(o.id);
      const orders = await invoiceDraft.loadOrders([o.id]);
      if (!orders) return null;
      const result = await invoiceDraft.createOrderInvoiceDraft(orders, actorId);
      if (!result.ok) return result.error;
      made.documents.push(result.data.id);
      return db.tradeDocument.findUnique({ where: { id: result.data.id }, select: { currency: true, lines: { select: { unitPrice: true } } } });
    };
    const fromCatalogue = await raise(null, priced.id);
    ok(
      "an order with no price of its own: the item's own price",
      typeof fromCatalogue === "object" && fromCatalogue?.currency === fx && Number(fromCatalogue.lines[0]?.unitPrice) === 95,
      JSON.stringify(fromCatalogue),
    );
    const agreed = await raise(8000, priced.id);
    ok(
      "an order's agreed price: converted, though the item has its own",
      typeof agreed === "object" && agreed?.currency === fx && Number(agreed.lines[0]?.unitPrice) === 100,
      JSON.stringify(agreed),
    );
    const noOwn = await raise(null, plain.id);
    ok(
      "  an order with no price on an item without its own: the base price converted",
      typeof noOwn === "object" && Number(noOwn?.lines[0]?.unitPrice) === 100,
      JSON.stringify(noOwn),
    );

    section("A workspace not migrated yet");
    unmigrated = true;
    try {
      ok("no own prices: an empty map", (await prices.itemCurrencyPrices([priced.id])).size === 0);
      ok("  itemPriceIn is null", (await prices.itemPriceIn(priced.id, fx)) === null);
      ok("  saving reports it wasn't kept", (await prices.saveItemCurrencyPrices(priced.id, [{ currency: fx, sellingPrice: 1, costPrice: null }])) === false);
      const f4 = form();
      await defaults.applyPartyCurrency(f4, { fetch: false, cataloguePriced: (l) => !l.companyProductId });
      ok("  and a catalogue line converts as before", f4.lines[0]!.unitPrice === "100", f4.lines[0]!.unitPrice);
    } finally {
      unmigrated = false;
    }
  } finally {
    for (const id of made.documents) await db.tradeDocument.delete({ where: { id } }).catch(() => {});
    await db.auditLog.deleteMany({ where: { entityId: { in: [...made.documents, ...made.orders, ...made.companies] } } }).catch(() => {});
    for (const id of made.orders) await db.companyProduct.delete({ where: { id } }).catch(() => {});
    await db.companyLocation.deleteMany({ where: { companyId: { in: made.companies } } }).catch(() => {});
    for (const id of made.companies) await db.company.delete({ where: { id } }).catch(() => {});
    // Its own prices go with it (onDelete: Cascade).
    for (const id of made.items) await db.item.delete({ where: { id } }).catch(() => {});
    await db.exchangeRate.deleteMany({ where: { id: { in: madeRates } } });
    const left =
      (await db.company.count({ where: { name: { startsWith: TAG } } })) +
      (await db.item.count({ where: { name: { startsWith: TAG } } })) +
      (await db.itemPrice.count({ where: { itemId: { in: made.items } } })) +
      (await db.exchangeRate.count({ where: { id: { in: madeRates } } }));
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
