import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { baseCurrency, getCurrency } from "@/lib/currency";
import { foreignCurrency, rateFor } from "@/lib/finance/rates";
import type { DocumentFormDefaults } from "@/lib/document-draft";
import { itemPricesIn } from "@/lib/items/currency-prices";

/**
 * The currency a customer or vendor is quoted and billed in (owner, 30 Oct 2026) — `Company.defaultCurrency`, null
 * being the workspace's own. Server only.
 *
 * Read and written by name, on its own: the column is in NOT_YET_EVERYWHERE (src/lib/tenancy/clients.ts), and a
 * workspace not migrated to 20261201100000_currency_defaults_and_rates has every company in its own currency.
 */

/** The company's own currency, or null for the workspace's (or a company that isn't there). */
export async function companyCurrency(companyId: string | null | undefined): Promise<string | null> {
  if (!companyId) return null;
  try {
    const row = await db.company.findUnique({ where: { id: companyId }, select: { defaultCurrency: true } });
    return foreignCurrency(row?.defaultCurrency) ? row!.defaultCurrency : null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/**
 * Sets it: a code from CURRENCIES, or "" / null / the workspace's own for none. Returns false where the workspace isn't
 * migrated yet — the rest of the company still saves.
 */
export async function saveCompanyCurrency(companyId: string, code: string | null | undefined): Promise<boolean> {
  const next = foreignCurrency(code) ? code : null;
  try {
    await db.company.update({ where: { id: companyId }, data: { defaultCurrency: next }, select: { id: true } });
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

export type PartyTerms = {
  currency: string;
  /** Base per unit; 1 in the workspace's own currency. */
  exchangeRate: number;
  /** Why it stayed in the workspace's currency when the party has another — for the form's hint line. */
  note: string | null;
};

/**
 * What a new document for this party starts in, on its issue day: the party's currency at the day's rate from the
 * exchange-rate table (src/lib/finance/rates.ts), else the workspace's own.
 *
 * With no rate to be had — nothing in the table within the week, the lookup offline — it stays in the workspace's own
 * currency rather than going out in dollars at a made-up 1 or at last month's figure: a base-currency draft is right as
 * far as it goes and somebody can switch it, where a dollar draft at the wrong rate would post the wrong amount to the
 * books the moment it is issued.
 */
export async function partyTerms(companyId: string | null | undefined, issueDate: string, opts: { fetch?: boolean } = {}): Promise<PartyTerms> {
  const base = { currency: baseCurrency(), exchangeRate: 1, note: null };
  const currency = await companyCurrency(companyId);
  if (!currency) return base;
  const known = await rateFor(currency, issueDate, opts);
  if (!known || !(known.rate > 0)) return { ...base, note: `No ${currency} rate known for ${issueDate}, so this starts in ${baseCurrency()}.` };
  return { currency, exchangeRate: known.rate, note: null };
}

/**
 * A new document's form (src/lib/document-draft.ts) started in its party's currency, once the page has chosen the party
 * and the opening lines — from orders, a lead, or `?companyId=`. The lines' prices came from orders and the catalogue
 * in the workspace's currency, so they are converted at the same rate. An edit's defaults are never passed here: a
 * saved document keeps what it was written in. Returns the note `partyTerms` gave, if any.
 *
 * `cataloguePriced` says which lines took the catalogue's price (a lead's products, an order with no price of its own):
 * those take the item's own price in the party's currency where it has one (owner, 30 Oct 2026 —
 * src/lib/items/currency-prices.ts), the cost price first on a `purchase`. Every other line — an order's agreed price —
 * is converted.
 */
export async function applyPartyCurrency(
  defaults: DocumentFormDefaults,
  opts: { fetch?: boolean; cataloguePriced?: (line: DocumentFormDefaults["lines"][number]) => boolean; purchase?: boolean } = {},
): Promise<string | null> {
  if (defaults.id || !defaults.companyId) return null;
  const terms = await partyTerms(defaults.companyId, defaults.issueDate, opts);
  defaults.currency = terms.currency;
  defaults.exchangeRate = terms.exchangeRate;
  if (terms.currency !== baseCurrency()) {
    const fromCatalogue = defaults.lines.filter((l) => l.itemId && opts.cataloguePriced?.(l));
    const own = await itemPricesIn(fromCatalogue.map((l) => l.itemId), terms.currency, { purchase: opts.purchase });
    defaults.lines = defaults.lines.map((l) => {
      const ownPrice = fromCatalogue.includes(l) ? own.get(l.itemId) : undefined;
      return { ...l, unitPrice: String(ownPrice ?? priceInCurrency(Number(l.unitPrice) || 0, terms)) };
    });
  }
  return terms.note;
}

/**
 * A price kept in the workspace's own currency (an order's, the catalogue's), in the document's — rounded to that
 * currency's own places, as the form does for a catalogue price. Unchanged in the workspace's currency.
 */
export function priceInCurrency(baseAmount: number, terms: Pick<PartyTerms, "currency" | "exchangeRate">): number {
  if (terms.currency === baseCurrency() || !(terms.exchangeRate > 0)) return baseAmount;
  const factor = 10 ** getCurrency(terms.currency).decimals;
  return Math.round((baseAmount / terms.exchangeRate) * factor) / factor;
}
