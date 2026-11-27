import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";

/**
 * A lapsed customer (owner, 26 Oct 2026): one who had subscriptions with us, and has none running now — every
 * one ended and none renewed. A customer to win back, flagged on their page and filterable on Customers.
 *
 *   · A subscription: a subscription item's order, not an add-on, not cancelled or refused.
 *   · Running: no end date set, or ending today or later. A renewal is its own order with the next term's
 *     dates, so a renewed customer always has one running.
 *   · A customer who only ever bought goods or services is neither: there was nothing to renew.
 */

const SUBSCRIPTIONS = {
  item: { type: "SUBSCRIPTION" },
  parentId: null,
  orderStatus: { notIn: ["CANCELLED", "REJECTED"] },
} as const satisfies Prisma.CompanyProductWhereInput;

const running = (today: Date): Prisma.CompanyProductWhereInput => ({ ...SUBSCRIPTIONS, OR: [{ endDate: null }, { endDate: { gte: today } }] });

/** Customers who had a subscription and have none running — for a list's filter. `today` is a typed day. */
export function lapsedCustomerWhere(today: Date): Prisma.CompanyWhereInput {
  return { AND: [{ products: { some: SUBSCRIPTIONS } }, { products: { none: running(today) } }] };
}

export type CustomerStanding = { lapsed: false } | { lapsed: true; since: Date; subscriptions: number };

/** Whether this customer has lapsed, since when (their last subscription's end), and how many they had. */
export async function customerStanding(companyId: string, today: Date): Promise<CustomerStanding> {
  const [current, ended] = await Promise.all([
    db.companyProduct.count({ where: { companyId, ...running(today) } }),
    db.companyProduct.aggregate({ where: { companyId, ...SUBSCRIPTIONS, endDate: { lt: today } }, _max: { endDate: true }, _count: true }),
  ]);
  if (current > 0 || !ended._max.endDate) return { lapsed: false };
  return { lapsed: true, since: ended._max.endDate, subscriptions: ended._count };
}
