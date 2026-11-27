/**
 * check:missing-prices — orders saved without a price (owner, 3 Nov 2026): Orders › Fill missing prices
 * (src/actions/order-prices.ts, src/lib/orders/missing-prices.ts) and the sale price typed for such an order
 * in the pro-rata calculator and Add seats (`quoteAddon`'s `salePrice`, src/actions/addon.ts).
 *
 * The CSV and price reading by hand; then a fixture of its own in the local database — an order with no
 * price, one with a price, seats added without a full-year price, a cancelled one — filled from the page,
 * from the product price, and from a CSV, and quoted with a typed price. Named ZZPROBE_MP, removed in a finally.
 *
 *   npm run check:missing-prices
 */
import "dotenv/config";
import Module from "node:module";
import { db } from "../src/lib/db";
import { parsePriceCsv, priceField, readPrice } from "../src/lib/orders/missing-prices";

const TAG = "ZZPROBE_MP";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
let actorId = "";
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {} };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return { requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

async function cleanup() {
  const items = (await db.item.findMany({ where: { sku: { startsWith: TAG } }, select: { id: true } })).map((i) => i.id);
  const orders = (await db.companyProduct.findMany({ where: { itemId: { in: items } }, select: { id: true } })).map((o) => o.id);
  await db.auditLog.deleteMany({ where: { entityType: "Order", entityId: { in: orders } } });
  await db.companyProduct.deleteMany({ where: { itemId: { in: items }, parentId: { not: null } } });
  await db.companyProduct.deleteMany({ where: { itemId: { in: items } } });
  await db.company.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.item.deleteMany({ where: { id: { in: items } } });
  await db.user.deleteMany({ where: { email: { endsWith: "@zzprobe-mp.invalid" } } });
}

async function main() {
  console.log("\n— Reading prices and the CSV —\n");
  ok("a price with commas and ₹", readPrice("₹1,250.50") === 1250.5);
  ok("zero, negative, three decimals and words aren't prices", [readPrice("0"), readPrice("-5"), readPrice("1.234"), readPrice("abc")].every((p) => p === null));
  const rows = parsePriceCsv('Order,Price\nORD-035836,"1,250"\n35837;900\nnonsense,5\nORD-1,abc\n');
  ok("a heading row is passed over", rows.length === 4, rows);
  ok("ORD- numbers, quotes and semicolons read", rows[0]!.orderSeq === 35836 && rows[0]!.price === 1250 && rows[1]!.orderSeq === 35837 && rows[1]!.price === 900);
  ok("a bad order number and a bad price are reported by line", rows[2]!.problem?.includes("isn't an order number") === true && rows[3]!.problem?.includes("isn't a price") === true && rows[3]!.line === 5);
  ok("seats added later fill the full-year price; an order its own price", priceField({ parentId: "x" }) === "fullTermUnitPrice" && priceField({ parentId: null }) === "unitPrice");

  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin to act as");
  actorId = admin.id;
  const { listMissingPrices, fillMissingPrices, fillAllFromProductPrice, importMissingPrices } = await import("../src/actions/order-prices");
  const { quoteAddon } = await import("../src/actions/addon");

  await cleanup();
  try {
    const item = await db.item.create({ data: { name: `${TAG} Revit`, sku: `${TAG}-A`, type: "SUBSCRIPTION", unit: "seat", sellingPrice: 91102, taxRatePercent: 18, createdById: admin.id }, select: { id: true } });
    const bare = await db.item.create({ data: { name: `${TAG} Unpriced`, sku: `${TAG}-B`, type: "SUBSCRIPTION", unit: "seat", sellingPrice: 0, createdById: admin.id }, select: { id: true } });
    const company = await db.company.create({
      data: { name: `${TAG} Jasper Colin`, normalizedName: `${TAG.toLowerCase()} jasper colin`, createdById: admin.id, locations: { create: { label: "Head office", isPrimary: true } } },
      select: { id: true, locations: { select: { id: true } } },
    });
    const now = new Date();
    const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1));
    const end = new Date(Date.UTC(now.getUTCFullYear() + 1, now.getUTCMonth() - 2, 1));
    const order = (data: Record<string, unknown>) =>
      db.companyProduct.create({ data: { companyId: company.id, locationId: company.locations[0]!.id, itemId: item.id, quantity: 5, startDate: start, endDate: end, orderStatus: "FULFILLED", addedByUserId: admin.id, ...data }, select: { id: true, orderSeq: true } });
    const noPrice = await order({});
    const priced = await order({ unitPrice: 5000 });
    const added = await order({ parentId: noPrice.id, quantity: 2, unitPrice: 2000 });
    const cancelled = await order({ orderStatus: "CANCELLED" });
    const zeroPrice = await order({ unitPrice: 0 });
    const noProductPrice = await order({ itemId: bare.id });

    console.log("\n— The list —\n");
    const list = await listMissingPrices({ q: TAG });
    const ids = new Set(list.rows.map((r) => r.id));
    ok("orders with no price, a 0 price, and seats added without a full-year price are listed", ids.has(noPrice.id) && ids.has(zeroPrice.id) && ids.has(added.id) && ids.has(noProductPrice.id), list.rows.map((r) => r.ref));
    ok("a priced order and a cancelled one aren't", !ids.has(priced.id) && !ids.has(cancelled.id));
    ok("the product's price is suggested", list.rows.find((r) => r.id === noPrice.id)?.item.sellingPrice === 91102);
    ok("…and counted where there is one", list.withProductPrice === 3, list.withProductPrice);

    console.log("\n— The sale price typed in the calculator —\n");
    const startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString().slice(0, 10);
    const none = await quoteAddon({ parentId: noPrice.id, quantity: 1, startDate });
    ok("an order without a price: no quote, and it says so", none !== null && none.quote === null && none.priceFrom === "none");
    const typed = await quoteAddon({ parentId: noPrice.id, quantity: 1, startDate, salePrice: 60000 });
    ok("with a sale price typed, quoted from it", typed?.priceFrom === "typed" && typed.annualUnitPrice === 60000 && (typed.quote?.total ?? 0) > 0, typed?.annualUnitPrice);
    const notOver = await quoteAddon({ parentId: priced.id, quantity: 1, startDate, salePrice: 1 });
    ok("an order's own price is never overridden by a typed one", notOver?.priceFrom === "order" && notOver.annualUnitPrice === 5000, notOver?.annualUnitPrice);

    console.log("\n— Filling —\n");
    const page = await fillMissingPrices({ entries: [{ id: noPrice.id, price: "1,07,500" }, { id: priced.id, price: "1" }, { id: zeroPrice.id, price: "nope" }] });
    ok("the page's prices are saved", page.ok && page.data.filled === 1, page.ok ? page.data : page.error);
    ok("…an order with a price is left as it was", page.ok && page.data.skipped.some((s) => s.reason === "it has a price already") && Number((await db.companyProduct.findUnique({ where: { id: priced.id } }))?.unitPrice) === 5000);
    ok("…the price is the order's unit price", Number((await db.companyProduct.findUnique({ where: { id: noPrice.id } }))?.unitPrice) === 107500);
    ok("…and audited", (await db.auditLog.count({ where: { entityType: "Order", entityId: noPrice.id, entityLabel: { contains: "filled the missing price" } } })) === 1);

    const all = await fillAllFromProductPrice({ q: TAG });
    ok("the product price for all: the rest that have one", all.ok && all.data.filled === 2, all.ok ? all.data : all.error);
    const addedRow = await db.companyProduct.findUnique({ where: { id: added.id } });
    ok("…seats added get it as their full-year price, their charge untouched", Number(addedRow?.fullTermUnitPrice) === 91102 && Number(addedRow?.unitPrice) === 2000);
    ok("…an order whose product has no price is left for a person", Number((await db.companyProduct.findUnique({ where: { id: noProductPrice.id } }))?.unitPrice ?? 0) === 0);

    const csv = await importMissingPrices({ csv: `Order,Price\nORD-${noProductPrice.orderSeq},4400\nORD-${priced.orderSeq},9\nORD-999999999,5` });
    ok("a CSV fills the one still missing", csv.ok && csv.data.filled === 1 && Number((await db.companyProduct.findUnique({ where: { id: noProductPrice.id } }))?.unitPrice) === 4400, csv.ok ? csv.data : csv.error);
    ok("…skips the priced one, and names an order that doesn't exist", csv.ok && csv.data.skipped.length === 1 && csv.data.problems.some((p) => p.includes("no order")));
    ok("nothing left to fill", (await listMissingPrices({ q: TAG })).total === 0);

    // A batch at a time (owner, 5 Nov 2026): 5,000 in one request ran past Cloudflare's 100 seconds and the page fell over.
    console.log("\n— Long runs —\n");
    await db.companyProduct.createMany({ data: Array.from({ length: 450 }, () => ({ companyId: company.id, locationId: company.locations[0]!.id, itemId: item.id, quantity: 1, startDate: start, endDate: end, orderStatus: "FULFILLED" as const, addedByUserId: admin.id })) });
    const sizes: number[] = [];
    let after: string | null = null;
    let leftAtEnd = -1;
    do {
      const batch: Awaited<ReturnType<typeof fillAllFromProductPrice>> = await fillAllFromProductPrice({ q: TAG, after });
      if (!batch.ok) throw new Error(batch.error);
      sizes.push(batch.data.filled);
      after = batch.data.next;
      leftAtEnd = batch.data.left;
    } while (after);
    ok("450 orders go in batches of 200, and all of them are priced", sizes.join() === "200,200,50" && leftAtEnd === 0 && (await listMissingPrices({ q: TAG })).total === 0, sizes);
    const offset = await importMissingPrices({ csv: "ORD-999999999,5", firstLine: 401 });
    ok("a part of a long file names its line in the whole file", offset.ok && offset.data.problems.some((p) => p.startsWith("Line 401:")), offset.ok ? offset.data.problems : offset.error);

    console.log("\n— Who may —\n");
    const sales = await db.user.create({ data: { name: "Zz Sales", email: `sales@zzprobe-mp.invalid`, role: "SALES", passwordHash: "!" }, select: { id: true } });
    await db.userPermission.create({ data: { userId: sales.id, permission: "products.edit", allowed: false, reason: "check:missing-prices" } });
    actorId = sales.id;
    const refused = await fillMissingPrices({ entries: [{ id: cancelled.id, price: "100" }] });
    ok("without permission to edit products: refused", !refused.ok && /edit products/.test(refused.error));
    ok("…and the list says so", (await listMissingPrices({})).allowed === false);
    await db.userPermission.deleteMany({ where: { userId: sales.id } });
  } finally {
    actorId = admin.id;
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
