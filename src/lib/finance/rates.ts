import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { baseCurrency, CURRENCY_CODES, isBaseCurrency } from "@/lib/currency";
import { lookupRate } from "@/lib/finance/exchange-rate";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * The workspace's exchange-rate table (owner, 30 Oct 2026): what each foreign currency was worth in the workspace's own
 * currency on a day, base per unit as everywhere (src/lib/currency.ts). Server only.
 *
 * Why a table when lib/finance/exchange-rate.ts already looks a rate up: a rate a document was started at should be one
 * the business can see, correct and get again — the same figure for every invoice raised that day, not whatever the
 * provider answered for each. So the heartbeat fetches the day's rates for the currencies in use once a day and keeps
 * them, somebody in accounts can type the bank's figure over one, and a typed figure is never overwritten by a fetch.
 *
 * A workspace not migrated to 20261201100000_currency_defaults_and_rates has no table: `rateFor` then answers from the
 * lookup alone, keeping nothing, as before.
 */

export type RateSource = "fetched" | "typed";
export type KnownRate = { rate: number; day: string; source: RateSource | "base" };

/** How far back a rate still stands in for a day that has none — a weekend, a holiday, a missed fetch. */
export const RATE_STANDS_FOR_DAYS = 7;

const DAY_MS = 86_400_000;

/**
 * Where a missing rate is looked up — the public dataset. An object so a check can put a stand-in here and never
 * reach the network (scripts/check-currency-defaults.ts).
 */
export const rateLookup = { lookup: lookupRate };

/** "yyyy-mm-dd" as the @db.Date it is stored in: midnight UTC of that calendar day. */
export function dayDate(day: string): Date {
  return new Date(`${day}T00:00:00.000Z`);
}

function dayString(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(day: string, days: number): string {
  return dayString(new Date(dayDate(day).getTime() + days * DAY_MS));
}

function isDay(day: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(dayDate(day).getTime());
}

/** A currency this table holds: one of CURRENCIES, and not the workspace's own. */
export function foreignCurrency(code: string | null | undefined): code is string {
  return !!code && (CURRENCY_CODES as readonly string[]).includes(code) && !isBaseCurrency(code);
}

/** Whether this workspace has the table yet. */
export async function ratesHere(): Promise<boolean> {
  try {
    await db.exchangeRate.findFirst({ select: { id: true } });
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

/**
 * Keeps a rate for a day. A fetched one never replaces a typed one (the typed figure is the business's own — the bank's
 * rate, the one agreed); a typed one replaces anything. Returns whether it was written.
 */
export async function storeRate(input: { currency: string; day: string; rate: number; source: RateSource; setById?: string | null }): Promise<boolean> {
  if (!foreignCurrency(input.currency) || !isDay(input.day) || !(input.rate > 0) || !Number.isFinite(input.rate)) return false;
  const day = dayDate(input.day);
  const rate = new Prisma.Decimal(input.rate.toFixed(6));
  if (input.source === "typed") {
    await db.exchangeRate.upsert({
      where: { day_currency: { day, currency: input.currency } },
      create: { day, currency: input.currency, rate, source: "typed", setById: input.setById ?? null },
      update: { rate, source: "typed", setById: input.setById ?? null },
    });
    return true;
  }
  // A fetch fills an empty day or refreshes an earlier fetch — and leaves a typed day alone.
  const updated = await db.exchangeRate.updateMany({ where: { day, currency: input.currency, source: "fetched" }, data: { rate } });
  if (updated.count > 0) return true;
  try {
    await db.exchangeRate.create({ data: { day, currency: input.currency, rate, source: "fetched", setById: null } });
    return true;
  } catch (err) {
    // The day is there already: typed, or another fetch got in first. Either way it stands.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
    throw err;
  }
}

/** The table's rate for the day, else the latest earlier one within RATE_STANDS_FOR_DAYS; null without one. */
export async function storedRateFor(currency: string, day: string): Promise<KnownRate | null> {
  const row = await db.exchangeRate.findFirst({
    // Calendar days on both ends, inclusive: a strict bound on a @db.Date drops the day itself.
    where: { currency, day: { lte: dayDate(day), gte: dayDate(addDays(day, -RATE_STANDS_FOR_DAYS)) } },
    orderBy: { day: "desc" },
    select: { day: true, rate: true, source: true },
  });
  return row ? { rate: Number(row.rate), day: dayString(row.day), source: row.source === "typed" ? "typed" : "fetched" } : null;
}

/**
 * What one unit of `currency` was worth on `day` (yyyy-mm-dd): the table's rate for the day, else the latest earlier
 * one within a week, else looked up and kept (`fetch: false` skips that), else null. The workspace's own currency is 1.
 */
export async function rateFor(currency: string, day: string, opts: { fetch?: boolean } = {}): Promise<KnownRate | null> {
  if (isBaseCurrency(currency)) return { rate: 1, day, source: "base" };
  if (!foreignCurrency(currency) || !isDay(day)) return null;
  const here = await ratesHere();
  if (here) {
    const stored = await storedRateFor(currency, day);
    if (stored) return stored;
  }
  if (opts.fetch === false) return null;
  const found = await rateLookup.lookup(currency, day);
  if (!found.ok) return null;
  // The provider answers with the day it actually has — a weekend asks for Friday's. Only a day within the week before
  // the one asked for stands in for it; its "latest" for a back-dated document would be a rate from after the date.
  const gap = (dayDate(day).getTime() - dayDate(found.onDate).getTime()) / DAY_MS;
  if (!isDay(found.onDate) || gap < 0 || gap > RATE_STANDS_FOR_DAYS) return null;
  if (here) await storeRate({ currency, day: found.onDate, rate: found.rate, source: "fetched" });
  return { rate: found.rate, day: found.onDate, source: "fetched" };
}

/**
 * The foreign currencies this workspace deals in: its companies' own currencies and those of documents dated in the
 * last year. What the heartbeat fetches and Settings › Currencies lists.
 */
export async function currenciesInUse(today?: string): Promise<string[]> {
  const day = today ?? (await workspaceClock()).today();
  const base = baseCurrency();
  const [documents, companies] = await Promise.all([
    db.tradeDocument.findMany({
      where: { currency: { not: base }, issueDate: { gte: dayDate(addDays(day, -365)) } },
      distinct: ["currency"],
      select: { currency: true },
    }),
    db.company
      .findMany({ where: { defaultCurrency: { not: null } }, distinct: ["defaultCurrency"], select: { defaultCurrency: true } })
      .catch((err) => {
        if (notMigratedYet(err)) return [] as { defaultCurrency: string | null }[];
        throw err;
      }),
  ]);
  const codes = new Set<string>();
  for (const d of documents) if (foreignCurrency(d.currency)) codes.add(d.currency);
  for (const c of companies) if (foreignCurrency(c.defaultCurrency)) codes.add(c.defaultCurrency);
  return CURRENCY_CODES.filter((c) => codes.has(c));
}

/**
 * Fetches each currency in use's rate for today and keeps it as "fetched" — the heartbeat's daily chore. A currency
 * with a rate for today already, or one fetched in the last 12 hours (a weekend's "today" is Friday's publication), is
 * left alone, so the five-minute heartbeat asks the provider about once a day. Never overwrites a typed rate.
 */
export async function fetchRatesInUse(opts: { force?: boolean } = {}): Promise<{ fetched: number; failed: string[]; currencies: string[] }> {
  if (!(await ratesHere())) return { fetched: 0, failed: [], currencies: [] };
  const today = (await workspaceClock()).today();
  const currencies = await currenciesInUse(today);
  if (currencies.length === 0) return { fetched: 0, failed: [], currencies };
  const recent = opts.force
    ? []
    : await db.exchangeRate.findMany({
        where: { currency: { in: currencies }, OR: [{ day: dayDate(today) }, { source: "fetched", updatedAt: { gte: new Date(Date.now() - 12 * 3600_000) } }] },
        select: { currency: true },
      });
  const done = new Set(recent.map((r) => r.currency));
  let fetched = 0;
  const failed: string[] = [];
  for (const currency of currencies) {
    if (done.has(currency)) continue;
    const found = await rateLookup.lookup(currency, today);
    const gap = found.ok ? (dayDate(today).getTime() - dayDate(found.onDate).getTime()) / DAY_MS : -1;
    if (!found.ok || !isDay(found.onDate) || gap < 0 || gap > RATE_STANDS_FOR_DAYS) {
      failed.push(currency);
      continue;
    }
    await storeRate({ currency, day: found.onDate, rate: found.rate, source: "fetched" });
    fetched += 1;
  }
  return { fetched, failed, currencies };
}
