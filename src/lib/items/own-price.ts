/**
 * Which of an item's own prices in another currency a line takes (owner, 30 Oct 2026 — `ItemPrice`,
 * src/lib/items/currency-prices.ts). Pure, so the document form and the server pick the same way.
 *
 * A sale takes the selling price. A purchase takes the cost price in that currency, else the selling price in it — a
 * dollar list price is still nearer what a dollar vendor charges than a rupee figure converted. Null when the item has
 * no price of its own in the currency: the caller converts the workspace-currency price at the document's rate.
 */

export type ItemCurrencyPrice = { currency: string; sellingPrice: number; costPrice: number | null };

export function ownPriceFor(
  prices: readonly ItemCurrencyPrice[] | null | undefined,
  currency: string,
  opts: { purchase?: boolean } = {},
): number | null {
  const row = prices?.find((p) => p.currency === currency);
  if (!row) return null;
  if (opts.purchase && row.costPrice !== null && Number.isFinite(row.costPrice)) return row.costPrice;
  return Number.isFinite(row.sellingPrice) ? row.sellingPrice : null;
}
