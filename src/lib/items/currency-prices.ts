import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { CURRENCY_CODES, isBaseCurrency } from "@/lib/currency";
import { ownPriceFor, type ItemCurrencyPrice } from "@/lib/items/own-price";

/**
 * An item's own prices in currencies other than the workspace's (owner, 30 Oct 2026): Wroffy resells Microsoft and
 * Autodesk licences with real dollar list prices, so a USD quote should carry the item's USD price, not the rupee
 * price converted at the day's rate. Server only.
 *
 * Every read tolerates a workspace not migrated to 20261201110000_item_currency_prices: it has no own prices, so
 * everything converts the base price as before (src/lib/companies/default-currency.ts).
 */

export type { ItemCurrencyPrice } from "@/lib/items/own-price";

/** A code an item may have its own price in: one of CURRENCIES, and not the workspace's own. */
export function itemPriceCurrency(code: string | null | undefined): code is string {
  return !!code && (CURRENCY_CODES as readonly string[]).includes(code) && !isBaseCurrency(code);
}

function plain(row: { currency: string; sellingPrice: Prisma.Decimal; costPrice: Prisma.Decimal | null }): ItemCurrencyPrice {
  return { currency: row.currency, sellingPrice: Number(row.sellingPrice), costPrice: row.costPrice === null ? null : Number(row.costPrice) };
}

/** Each item's own prices, in CURRENCIES order; an item with none is missing from the map. */
export async function itemCurrencyPrices(itemIds: readonly string[]): Promise<Map<string, ItemCurrencyPrice[]>> {
  const ids = [...new Set(itemIds.filter(Boolean))];
  const out = new Map<string, ItemCurrencyPrice[]>();
  if (ids.length === 0) return out;
  let rows: { itemId: string; currency: string; sellingPrice: Prisma.Decimal; costPrice: Prisma.Decimal | null }[];
  try {
    rows = await db.itemPrice.findMany({
      where: { itemId: { in: ids } },
      select: { itemId: true, currency: true, sellingPrice: true, costPrice: true },
    });
  } catch (err) {
    if (notMigratedYet(err)) return out;
    throw err;
  }
  const order = (c: string) => (CURRENCY_CODES as readonly string[]).indexOf(c);
  rows.sort((a, b) => order(a.currency) - order(b.currency));
  for (const r of rows) {
    // A row left in what has since become the workspace's own currency (a country pack changed) is never "another".
    if (!itemPriceCurrency(r.currency)) continue;
    out.set(r.itemId, [...(out.get(r.itemId) ?? []), plain(r)]);
  }
  return out;
}

/**
 * Each item's own price in `currency` (cost first on a purchase — `ownPriceFor`); items without one are missing from
 * the map, and the caller converts their base price.
 */
export async function itemPricesIn(itemIds: readonly string[], currency: string, opts: { purchase?: boolean } = {}): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (!itemPriceCurrency(currency)) return out;
  const all = await itemCurrencyPrices(itemIds);
  for (const [itemId, prices] of all) {
    const price = ownPriceFor(prices, currency, opts);
    if (price !== null) out.set(itemId, price);
  }
  return out;
}

/** One item's own price in `currency`, else null. */
export async function itemPriceIn(itemId: string, currency: string, opts: { purchase?: boolean } = {}): Promise<number | null> {
  return (await itemPricesIn([itemId], currency, opts)).get(itemId) ?? null;
}

/**
 * Replaces the item's own prices with these (the item form sends the whole list). Returns false where the workspace
 * isn't migrated yet — the rest of the item still saves. The caller has validated the list (one row a currency, none in
 * the workspace's own).
 */
export async function saveItemCurrencyPrices(itemId: string, prices: readonly ItemCurrencyPrice[]): Promise<boolean> {
  const keep = prices.filter((p) => itemPriceCurrency(p.currency));
  try {
    await db.$transaction(async (tx) => {
      await tx.itemPrice.deleteMany({ where: { itemId, currency: { notIn: keep.map((p) => p.currency) } } });
      for (const p of keep) {
        await tx.itemPrice.upsert({
          where: { itemId_currency: { itemId, currency: p.currency } },
          create: { itemId, currency: p.currency, sellingPrice: p.sellingPrice, costPrice: p.costPrice },
          update: { sellingPrice: p.sellingPrice, costPrice: p.costPrice },
        });
      }
    });
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}
