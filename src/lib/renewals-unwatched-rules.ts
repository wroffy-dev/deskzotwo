import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { PERPETUAL_CATEGORY } from "@/lib/validation/item";

/**
 * Items › Services that renew (owner, 11 Nov 2026): services that look as if they renew — an AMC, a yearly support
 * contract — and aren't watched.
 *
 * Renewals watches one thing: an item ticked "Manage as a subscription". A service is whatever isn't, so an AMC
 * entered as a plain service gets no reminder, no escalation and no row on Renewals, however clearly its order says
 * when it ends. Rather than a second kind of renewing item, which every part of Renewals would have to learn, this
 * finds the services that look like one and asks: does it renew? Yes ticks the box; no marks it sold once
 * (`billingCycle` ONE_TIME), and it isn't asked about again (src/actions/item.ts `setServiceRenews`).
 *
 * It looks like one when either is true:
 *   · an order of it carries a term — an end date — that is still running, or ended within the last year;
 *   · its name says so (AMC, annual, maintenance contract, warranty, support plan…), and it has been sold in the last
 *     eighteen months.
 * Never a perpetual licence, an item no longer sold, or one already marked sold once.
 */

const DAY_MS = 86_400_000;
/** How far back an order's term still counts as a sign that it renews. */
const TERM_LOOKBACK_DAYS = 365;
/** How lately a service named like one must have been sold. */
const SOLD_LOOKBACK_DAYS = 548;

/** Words in a service's name that say it's sold for a term. Whole words, so "amc" doesn't match "camcorder". */
export const RENEWING_NAME = /\b(amc|cmc|annual|yearly|maintenance contract|maintenance plan|support plan|support contract|support pack|warranty|renewal|subscription|care pack)\b/i;
const NAME_WORDS = ["amc", "cmc", "annual", "yearly", "maintenance contract", "maintenance plan", "support plan", "support contract", "support pack", "warranty", "renewal", "subscription", "care pack"];

const LIVE_ORDER = { parentId: null, orderStatus: { notIn: ["CANCELLED", "REJECTED"] } } satisfies Prisma.CompanyProductWhereInput;

const termedOrders = (today: Date): Prisma.CompanyProductWhereInput => ({ ...LIVE_ORDER, endDate: { not: null, gte: new Date(today.getTime() - TERM_LOOKBACK_DAYS * DAY_MS) } });

/** The services to ask about. */
export function unwatchedServiceWhere(today: Date): Prisma.ItemWhereInput {
  return {
    type: "SERVICE",
    active: true,
    AND: [
      // ORs, as a comparison over a null drops the rows that have none.
      { OR: [{ category: null }, { category: { not: PERPETUAL_CATEGORY } }] },
      { OR: [{ billingCycle: null }, { billingCycle: { not: "ONE_TIME" } }] },
      {
        OR: [
          { companyProducts: { some: termedOrders(today) } },
          {
            AND: [
              { OR: NAME_WORDS.map((word) => ({ name: { contains: word, mode: "insensitive" as const } })) },
              { companyProducts: { some: { ...LIVE_ORDER, createdAt: { gte: new Date(today.getTime() - SOLD_LOOKBACK_DAYS * DAY_MS) } } } },
            ],
          },
        ],
      },
    ],
  };
}

export type UnwatchedService = {
  id: string;
  name: string;
  sku: string | null;
  /** Orders of it with a term running now. */
  running: number;
  /** Orders whose term ended within the last year. */
  ended: number;
  /** The next of the running terms to end. */
  nextEnd: Date | null;
  /** Its name alone says so: no order of it has a term. */
  byName: boolean;
};

/** Without a session — the bell's Monday count asks this too (src/lib/notify.ts). */
export async function unwatchedServices(today: Date): Promise<UnwatchedService[]> {
  const items = await db.item.findMany({ where: unwatchedServiceWhere(today), select: { id: true, name: true, sku: true }, orderBy: { name: "asc" }, take: 500 });
  if (items.length === 0) return [];
  const ids = items.map((i) => i.id);
  const [running, ended] = await Promise.all([
    db.companyProduct.groupBy({ by: ["itemId"], where: { ...LIVE_ORDER, itemId: { in: ids }, endDate: { not: null, gte: today } }, _count: { _all: true }, _min: { endDate: true } }),
    db.companyProduct.groupBy({
      by: ["itemId"],
      where: { ...LIVE_ORDER, itemId: { in: ids }, endDate: { not: null, lt: today, gte: new Date(today.getTime() - TERM_LOOKBACK_DAYS * DAY_MS) } },
      _count: { _all: true },
    }),
  ]);
  const runningOf = new Map(running.map((r) => [r.itemId, r]));
  const endedOf = new Map(ended.map((r) => [r.itemId, r._count._all]));
  return items
    .map((i) => {
      const r = runningOf.get(i.id);
      const row = { ...i, running: r?._count._all ?? 0, ended: endedOf.get(i.id) ?? 0, nextEnd: r?._min.endDate ?? null };
      // A name the database matched as a fragment ("annually", "camcorder") is no sign on its own.
      return { ...row, byName: row.running + row.ended === 0 };
    })
    .filter((row) => !row.byName || RENEWING_NAME.test(row.name))
    .sort((a, b) => b.running - a.running || b.ended - a.ended || a.name.localeCompare(b.name));
}
