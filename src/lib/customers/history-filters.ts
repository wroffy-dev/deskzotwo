import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import type { Clock } from "@/lib/time/zone";

/**
 * Filters on a customer's history with us (owner, 17 Nov 2026: "filters for these in customers") — the list's Lifetime
 * value, Last 12 months, Orders (live), Last purchase, Renewal rate, Last activity, Customer since and Pays in columns,
 * each as they read there. All but Last activity go by the stored figures (`customer_stats`, worked out once a day —
 * src/lib/customers/stats.ts); a customer without them yet matches none of these. Last activity is its last call, note
 * or email, as the column works it out (src/lib/tables/list-extras.ts lastActivityOfCompanies).
 */

export type HistoryFilterParams = {
  ltvMin?: string;
  ltvMax?: string;
  l12Min?: string;
  l12Max?: string;
  /** "live" | "none" | "five" | "one" */
  liveOrders?: string;
  /** "30" | "90" | "180" | "365" within; "over180" | "over365" none since; "never" */
  lastPurchase?: string;
  /** "low" (<50%) | "mid" (50–79%) | "high" (≥80%) | "none" (none due yet) */
  renewalRate?: string;
  /** "7" | "30" | "90" within; "none30" | "none90" | "none180" none since */
  activity?: string;
  sinceFrom?: string;
  sinceTo?: string;
  /** "30" (≤30 days) | "60" (31–60) | "slow" (>60) | "overdue" (has overdue) */
  paysIn?: string;
};

export const HISTORY_FILTER_PARAMS = ["ltvMin", "ltvMax", "l12Min", "l12Max", "liveOrders", "lastPurchase", "renewalRate", "activity", "sinceFrom", "sinceTo", "paysIn"] as const;

const amount = (v: string | undefined) => {
  if (!v?.trim()) return null;
  const n = Number(v.replace(/[,₹\s]/g, ""));
  return Number.isFinite(n) ? n : null;
};
const DAY = 86_400_000;

/** The filters' conditions, each its own AND term. `statsHere`: the stats table exists in this workspace. */
export async function historyFilterWhere(params: HistoryFilterParams, clock: Clock, statsHere: boolean, now = new Date()): Promise<Prisma.CompanyWhereInput[]> {
  const out: Prisma.CompanyWhereInput[] = [];
  const stats: Prisma.CustomerStatsWhereInput[] = [];
  const range = (min: number | null, max: number | null) => ({ ...(min !== null ? { gte: min } : {}), ...(max !== null ? { lte: max } : {}) });

  const ltvMin = amount(params.ltvMin);
  const ltvMax = amount(params.ltvMax);
  if (ltvMin !== null || ltvMax !== null) stats.push({ lifetimeValue: range(ltvMin, ltvMax) });
  const l12Min = amount(params.l12Min);
  const l12Max = amount(params.l12Max);
  if (l12Min !== null || l12Max !== null) stats.push({ last12Value: range(l12Min, l12Max) });

  if (params.liveOrders === "live") stats.push({ liveSubscriptions: { gte: 1 } });
  else if (params.liveOrders === "none") stats.push({ liveSubscriptions: 0 });
  else if (params.liveOrders === "five") stats.push({ orders: { gte: 5 } });
  else if (params.liveOrders === "one") stats.push({ orders: 1 });

  const daysAgo = (n: number) => new Date(now.getTime() - n * DAY);
  const lp = params.lastPurchase;
  if (lp && /^(30|90|180|365)$/.test(lp)) stats.push({ lastPurchaseAt: { gte: daysAgo(Number(lp)) } });
  else if (lp === "over180" || lp === "over365") stats.push({ lastPurchaseAt: { lt: daysAgo(lp === "over180" ? 180 : 365) } });
  else if (lp === "never") stats.push({ lastPurchaseAt: null });

  const paysIn = params.paysIn;
  if (paysIn === "30") stats.push({ avgDaysToPay: { lte: 30 } });
  else if (paysIn === "60") stats.push({ avgDaysToPay: { gt: 30, lte: 60 } });
  else if (paysIn === "slow") stats.push({ avgDaysToPay: { gt: 60 } });
  else if (paysIn === "overdue") stats.push({ overdue: { gt: 0 } });

  const since = clock.dayRange(params.sinceFrom, params.sinceTo);
  if (since) stats.push({ firstOrderAt: since });

  if (params.renewalRate === "none") stats.push({ renewalsDue: 0 });
  else if (params.renewalRate === "low" || params.renewalRate === "mid" || params.renewalRate === "high") {
    // A ratio of two columns: asked of the database, and its customers taken by id.
    const band = params.renewalRate;
    const rows = statsHere
      ? await db.$queryRaw<{ companyId: string }[]>`
          SELECT "companyId" FROM "customer_stats"
          WHERE "renewalsDue" > 0
            AND (${band} <> 'low'  OR "renewalsRenewed"::float / "renewalsDue" <  0.5)
            AND (${band} <> 'mid'  OR ("renewalsRenewed"::float / "renewalsDue" >= 0.5 AND "renewalsRenewed"::float / "renewalsDue" < 0.8))
            AND (${band} <> 'high' OR "renewalsRenewed"::float / "renewalsDue" >= 0.8)`
      : [];
    out.push({ id: { in: rows.map((r) => r.companyId) } });
  }

  if (stats.length) out.push(statsHere ? { customerStats: { is: { AND: stats } } } : { id: { in: [] } });

  // Its last call, note or email — within the days, or none since.
  const act = params.activity;
  const within = act && /^(7|30|90)$/.test(act) ? Number(act) : null;
  const noneSince = act && /^none(30|90|180)$/.test(act) ? Number(act.slice(4)) : null;
  const days = within ?? noneSince;
  if (days !== null) {
    const after = daysAgo(days);
    const active: Prisma.CompanyWhereInput = {
      OR: [
        { calls: { some: { startedAt: { gte: after } } } },
        { leads: { some: { activities: { some: { occurredAt: { gte: after } } } } } },
        { marketingMessages: { some: { messageClass: "TRANSACTIONAL", status: "SENT", sentAt: { gte: after } } } },
      ],
    };
    out.push(within !== null ? active : { NOT: active });
  }
  return out;
}
