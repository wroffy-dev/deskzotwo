import { cache } from "react";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { customerSide } from "@/lib/companies/roles";
import { workspaceClock } from "@/lib/time/workspace";
import { baseCurrency } from "@/lib/currency";
import { loadAging, readAgingParams } from "@/lib/receivables/aging";
import { DEFAULT_LOYALTY_RULES, loyaltyTier, topValueThreshold, type LoyaltyRules, type LoyaltyTier } from "@/lib/customers/loyalty-rules";

/**
 * Each customer's history with this workspace's business, and its loyalty tier (owner, 31 Oct 2026). Inside one
 * workspace only — Wroffy's customers' business with Wroffy — kept in CustomerStats so the Customers and Companies lists
 * (12,000 companies) show, filter and badge it from a stored row rather than adding up every invoice for every page.
 *
 *   · Refreshed whole once a day on the heartbeat (`runCustomerStats`) and by Settings › Customer loyalty's "Refresh
 *     now"; a handful of grouped queries over every customer at once, never one a customer.
 *   · **Customer since**: its first order (the earlier of when it was punched and its start — an imported order from
 *     2019 is punched the day it came across), invoice, or Zoho archived invoice or sales order (src/lib/migration/
 *     archive.ts — the years before the books were brought across).
 *   · **Lifetime value**: invoices and debit notes issued, less credit notes issued, sales side, not draft or cancelled,
 *     each at its own rate into the base currency (the ledger's `bookingRate`), totals as the customer was billed
 *     them, tax in. Plus the archived years' invoices less credit notes, not void or draft — only those in the base
 *     currency, as the archive keeps no rate. Last 12 months and the 12 before them the same, by the workspace's days.
 *   · **Orders**: orders not cancelled or refused, add-ons included; **products** the different items among them.
 *   · **Live subscriptions**: a subscription (not an add-on) not ended — or with no end — not renewed, not marked Lost.
 *   · **Renewal rate**: of its subscriptions whose term has ended, those renewed (`renewedBy`, as Renewals says).
 *   · **Pays in**: average days from an invoice's date to the payment that settled it, invoices paid in full in the last
 *     24 months. **Overdue**: the aging report's own figure (src/lib/receivables/aging.ts) — what is open past due today.
 *   · Only customers (src/lib/companies/roles.ts), not a reseller's end customers; one with nothing bought has no row.
 */

export type CustomerStatsRow = {
  companyId: string;
  firstOrderAt: Date | null;
  lifetimeValue: number;
  last12Value: number;
  prev12Value: number;
  orders: number;
  liveSubscriptions: number;
  lastPurchaseAt: Date | null;
  renewalsDue: number;
  renewalsRenewed: number;
  renewalsLostRecently: number;
  avgDaysToPay: number | null;
  overdue: number;
  productCount: number;
  tier: LoyaltyTier | null;
  computedAt: Date;
};

const DAY = 86_400_000;
const n = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));
const round2 = (v: number) => Math.round(v * 100) / 100;
const earlier = (a: Date | null, b: Date | null | undefined) => (!b ? a : !a || b < a ? b : a);
const later = (a: Date | null, b: Date | null | undefined) => (!b ? a : !a || b > a ? b : a);

/** The workspace's rules, or the defaults — where none are saved or the table isn't there yet. */
export async function loyaltyRules(): Promise<{ rules: LoyaltyRules; migrated: boolean; refreshedAt: Date | null; refreshMs: number | null }> {
  try {
    const row = await db.loyaltySettings.findUnique({ where: { id: "default" } });
    if (!row) return { rules: { ...DEFAULT_LOYALTY_RULES }, migrated: true, refreshedAt: null, refreshMs: null };
    const rules = Object.fromEntries(Object.keys(DEFAULT_LOYALTY_RULES).map((k) => [k, row[k as keyof LoyaltyRules]])) as LoyaltyRules;
    return { rules, migrated: true, refreshedAt: row.refreshedAt, refreshMs: row.refreshMs };
  } catch (err) {
    if (notMigratedYet(err)) return { rules: { ...DEFAULT_LOYALTY_RULES }, migrated: false, refreshedAt: null, refreshMs: null };
    throw err;
  }
}

/** `yyyy-mm-dd` moved by whole days. */
const shiftKey = (key: string, days: number) => new Date(Date.parse(`${key}T00:00:00Z`) + days * DAY).toISOString().slice(0, 10);

type Acc = Omit<CustomerStatsRow, "tier" | "computedAt">;

/**
 * Works every customer's figures out afresh and stores them, tiers and all. `only`: just these companies — the
 * check's fixture — whose top-10% bar is still read against every other customer's stored lifetime value.
 */
export async function refreshCustomerStats(opts: { only?: string[]; now?: Date } = {}): Promise<{ customers: number; ms: number; migrated: boolean }> {
  const started = Date.now();
  const now = opts.now ?? new Date();
  const { rules, migrated } = await loyaltyRules();
  if (!migrated) return { customers: 0, ms: 0, migrated: false };
  const only = opts.only ? [...new Set(opts.only)] : null;
  if (only && only.length === 0) return { customers: 0, ms: 0, migrated: true };

  const clock = await workspaceClock();
  const todayKey = clock.today(now);
  const today = clock.calendarDate(now);
  const from365 = clock.startOfDay(shiftKey(todayKey, -365))!;
  const from730 = clock.startOfDay(shiftKey(todayKey, -730))!;
  const lostFrom = new Date(today.getTime() - rules.atRiskLostDays * DAY);
  const base = baseCurrency();
  const onlyOf = (column: string) => (only ? Prisma.sql`AND ${Prisma.raw(column)} IN (${Prisma.join(only)})` : Prisma.empty);
  // A document's figure in the base currency at its own rate — `bookingRate` (src/lib/ledger/posting.ts) said in SQL.
  const inBase = Prisma.sql`(CASE WHEN d."docType"::text = 'CREDIT_NOTE' THEN -1 ELSE 1 END) * d."total" * (CASE WHEN d."currency" IS NULL OR d."currency" = ${base} THEN 1 ELSE COALESCE(NULLIF(d."exchangeRate", 0), 1) END)`;

  type Money = Prisma.Decimal | number | null;
  const [orders, invoices, paid, archived, aging, customers] = await Promise.all([
    db.$queryRaw<{ id: string; orders: number; products: number; first: Date | null; last: Date | null; live: number; due: number; renewed: number; lost: number }[]>`
      SELECT cp."companyId" AS id,
        COUNT(*)::int AS orders,
        COUNT(DISTINCT cp."itemId")::int AS products,
        MIN(LEAST(cp."createdAt", COALESCE(cp."startDate", cp."createdAt"))) AS first,
        MAX(cp."createdAt") AS last,
        COUNT(*) FILTER (WHERE i."type"::text = 'SUBSCRIPTION' AND cp."parentId" IS NULL AND (cp."endDate" IS NULL OR cp."endDate" >= ${today})
          AND r."id" IS NULL AND (cp."renewalStage" IS NULL OR cp."renewalStage"::text <> 'LOST'))::int AS live,
        COUNT(*) FILTER (WHERE i."type"::text = 'SUBSCRIPTION' AND cp."parentId" IS NULL AND cp."endDate" < ${today})::int AS due,
        COUNT(*) FILTER (WHERE i."type"::text = 'SUBSCRIPTION' AND cp."parentId" IS NULL AND cp."endDate" < ${today} AND r."id" IS NOT NULL)::int AS renewed,
        COUNT(*) FILTER (WHERE i."type"::text = 'SUBSCRIPTION' AND cp."parentId" IS NULL AND r."id" IS NULL AND cp."renewalStage"::text = 'LOST'
          AND cp."endDate" >= ${lostFrom} AND cp."endDate" < ${today})::int AS lost
      FROM "company_products" cp
      JOIN "items" i ON i."id" = cp."itemId"
      LEFT JOIN "company_products" r ON r."renewedFromId" = cp."id"
      WHERE cp."orderStatus"::text NOT IN ('CANCELLED', 'REJECTED') ${onlyOf(`cp."companyId"`)}
      GROUP BY cp."companyId"`,
    db.$queryRaw<{ id: string; lifetime: Money; last12: Money; prev12: Money; first: Date | null; last: Date | null }[]>`
      SELECT d."companyId" AS id,
        SUM(${inBase}) AS lifetime,
        SUM(${inBase}) FILTER (WHERE d."issueDate" >= ${from365}) AS last12,
        SUM(${inBase}) FILTER (WHERE d."issueDate" >= ${from730} AND d."issueDate" < ${from365}) AS prev12,
        MIN(d."issueDate") FILTER (WHERE d."docType"::text <> 'CREDIT_NOTE') AS first,
        MAX(d."issueDate") FILTER (WHERE d."docType"::text <> 'CREDIT_NOTE') AS last
      FROM "trade_documents" d
      WHERE d."direction"::text = 'SALES' AND d."docType"::text IN ('INVOICE', 'DEBIT_NOTE', 'CREDIT_NOTE')
        AND d."status"::text IN ('ISSUED', 'ACCEPTED', 'PARTIALLY_PAID', 'PAID') ${onlyOf(`d."companyId"`)}
      GROUP BY d."companyId"`,
    // Paid in full (src/lib/receivables/sync.ts keeps the status): the day of the last payment set against it.
    db.$queryRaw<{ id: string; days: number | null }[]>`
      SELECT d."companyId" AS id, ROUND(AVG(GREATEST(0, EXTRACT(EPOCH FROM (s."paid" - d."issueDate")) / 86400)))::int AS days
      FROM "trade_documents" d
      JOIN (SELECT pa."documentId", MAX(p."paidOn") AS paid FROM "payment_allocations" pa JOIN "payments" p ON p."id" = pa."paymentId"
            WHERE pa."documentId" IS NOT NULL GROUP BY pa."documentId") s ON s."documentId" = d."id"
      WHERE d."direction"::text = 'SALES' AND d."docType"::text IN ('INVOICE', 'DEBIT_NOTE') AND d."status"::text = 'PAID'
        AND d."issueDate" >= ${from730} ${onlyOf(`d."companyId"`)}
      GROUP BY d."companyId"`,
    // The archive is a later migration than some workspaces have; without it, no archived years.
    db.$queryRaw<{ id: string; lifetime: Money; last12: Money; prev12: Money; first: Date | null; last: Date | null }[]>`
      SELECT a."companyId" AS id,
        SUM(CASE WHEN a."kind" = 'CREDIT_NOTE' THEN -a."total" ELSE a."total" END) FILTER (WHERE a."kind" IN ('INVOICE', 'CREDIT_NOTE') AND ${archivedInBase(base)}) AS lifetime,
        SUM(CASE WHEN a."kind" = 'CREDIT_NOTE' THEN -a."total" ELSE a."total" END) FILTER (WHERE a."kind" IN ('INVOICE', 'CREDIT_NOTE') AND ${archivedInBase(base)} AND a."date" >= ${from365}) AS last12,
        SUM(CASE WHEN a."kind" = 'CREDIT_NOTE' THEN -a."total" ELSE a."total" END) FILTER (WHERE a."kind" IN ('INVOICE', 'CREDIT_NOTE') AND ${archivedInBase(base)} AND a."date" >= ${from730} AND a."date" < ${from365}) AS prev12,
        MIN(a."date") FILTER (WHERE a."kind" IN ('INVOICE', 'SALES_ORDER')) AS first,
        MAX(a."date") FILTER (WHERE a."kind" = 'INVOICE') AS last
      FROM "books_archived_documents" a
      WHERE a."companyId" IS NOT NULL AND a."kind" IN ('INVOICE', 'CREDIT_NOTE', 'SALES_ORDER')
        AND lower(coalesce(a."status", '')) NOT IN ('void', 'draft') ${onlyOf(`a."companyId"`)}
      GROUP BY a."companyId"`.catch((err) => {
      if (notMigratedYet(err)) return [];
      throw err;
    }),
    // What is open past due today, as the aging report has it: the total less its Current column.
    loadAging("AR", readAgingParams({}, todayKey), only ? { companyId: { in: only } } : {}),
    customerSide().then((side) =>
      db.company.findMany({ where: { AND: [side, { managedByResellerId: null }, only ? { id: { in: only } } : {}] }, select: { id: true } }),
    ),
  ]);

  const isCustomer = new Set(customers.map((c) => c.id));
  const rows = new Map<string, Acc>();
  const of = (id: string): Acc | null => {
    if (!isCustomer.has(id)) return null;
    let r = rows.get(id);
    if (!r) {
      r = {
        companyId: id, firstOrderAt: null, lifetimeValue: 0, last12Value: 0, prev12Value: 0, orders: 0, liveSubscriptions: 0, lastPurchaseAt: null,
        renewalsDue: 0, renewalsRenewed: 0, renewalsLostRecently: 0, avgDaysToPay: null, overdue: 0, productCount: 0,
      };
      rows.set(id, r);
    }
    return r;
  };
  for (const o of orders) {
    const r = of(o.id);
    if (!r) continue;
    Object.assign(r, { orders: o.orders, productCount: o.products, liveSubscriptions: o.live, renewalsDue: o.due, renewalsRenewed: o.renewed, renewalsLostRecently: o.lost });
    r.firstOrderAt = earlier(r.firstOrderAt, o.first);
    r.lastPurchaseAt = later(r.lastPurchaseAt, o.last);
  }
  for (const d of [...invoices, ...archived]) {
    const r = of(d.id);
    if (!r) continue;
    r.lifetimeValue += n(d.lifetime);
    r.last12Value += n(d.last12);
    r.prev12Value += n(d.prev12);
    r.firstOrderAt = earlier(r.firstOrderAt, d.first);
    r.lastPurchaseAt = later(r.lastPurchaseAt, d.last);
  }
  // Paying and owing alone don't make a customer a row: only alongside something bought, which every invoice is.
  for (const p of paid) {
    const r = rows.get(p.id);
    if (r) r.avgDaysToPay = p.days;
  }
  for (const a of aging.rows) {
    const r = rows.get(a.id);
    if (r) r.overdue = round2(a.total - (a.cells[0] ?? 0));
  }
  for (const r of rows.values()) {
    r.lifetimeValue = round2(r.lifetimeValue);
    r.last12Value = round2(r.last12Value);
    r.prev12Value = round2(r.prev12Value);
  }

  // The top-10% bar over every customer: the fresh figures, and — refreshing only some — everybody else's stored ones.
  const values = [...rows.values()].map((r) => r.lifetimeValue);
  if (only) {
    const others = await db.customerStats.findMany({ where: { companyId: { notIn: only } }, select: { lifetimeValue: true } });
    for (const o of others) values.push(Number(o.lifetimeValue));
  }
  const topValue = topValueThreshold(values, rules.championTopPercent);
  const computedAt = new Date();
  const data = [...rows.values()].map((r) => ({ ...r, tier: loyaltyTier(r, rules, now, topValue), computedAt }));

  await db.$transaction(
    async (tx) => {
      await tx.customerStats.deleteMany({ where: only ? { companyId: { in: only } } : {} });
      for (let i = 0; i < data.length; i += 2000) await tx.customerStats.createMany({ data: data.slice(i, i + 2000) });
    },
    { timeout: 120_000, maxWait: 20_000 },
  );
  const ms = Date.now() - started;
  if (!only) {
    await db.loyaltySettings.upsert({
      where: { id: "default" },
      create: { id: "default", refreshedAt: computedAt, refreshMs: ms },
      update: { refreshedAt: computedAt, refreshMs: ms },
      select: { id: true },
    });
  }
  return { customers: data.length, ms, migrated: true };
}

/** An archived document whose figure is in the base currency — the archive keeps no rate to convert the rest by. */
function archivedInBase(base: string) {
  return Prisma.sql`(a."currency" IS NULL OR a."currency" = '' OR upper(a."currency") = ${base})`;
}

/**
 * The heartbeat's: a whole refresh once a day, where Companies is on. Claimed first — the heartbeat comes every five
 * minutes and a refresh mustn't start twice — and the claim given back if it fails, so the next tick tries again.
 */
export async function runCustomerStats(now = new Date()): Promise<{ refreshed: number; ms?: number; reason?: string }> {
  const { migrated, refreshedAt } = await loyaltyRules();
  if (!migrated) return { refreshed: 0, reason: "not migrated" };
  const due = new Date(now.getTime() - 20 * 60 * 60 * 1000);
  if (refreshedAt && refreshedAt > due) return { refreshed: 0, reason: "fresh" };
  // Claimed by moving refreshedAt on, only if nobody else moved it first.
  if (refreshedAt) {
    const { count } = await db.loyaltySettings.updateMany({ where: { id: "default", refreshedAt }, data: { refreshedAt: now } });
    if (count === 0) return { refreshed: 0, reason: "claimed" };
  } else {
    const made = await db.loyaltySettings.createMany({ data: [{ id: "default", refreshedAt: now }], skipDuplicates: true });
    if (made.count === 0) {
      const { count } = await db.loyaltySettings.updateMany({ where: { id: "default", refreshedAt: null }, data: { refreshedAt: now } });
      if (count === 0) return { refreshed: 0, reason: "claimed" };
    }
  }
  try {
    const run = await refreshCustomerStats({ now });
    return { refreshed: run.customers, ms: run.ms };
  } catch (err) {
    await db.loyaltySettings.updateMany({ where: { id: "default" }, data: { refreshedAt } }).catch(() => {});
    throw err;
  }
}

/** Whether this workspace has the stats table yet — asked before a list filters on it; once a request. */
export const customerStatsHere = cache(async (): Promise<boolean> => {
  try {
    await db.customerStats.findFirst({ select: { companyId: true } });
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
});

/** The stored figures as a client component is handed them: plain numbers, ISO days, the base currency beside them. */
export type CustomerHistory = Omit<CustomerStatsRow, "firstOrderAt" | "lastPurchaseAt" | "computedAt"> & {
  firstOrderAt: string | null;
  lastPurchaseAt: string | null;
  computedAt: string;
  currency: string;
};

/** The stored figures of these companies — none for one with no row, and none at all where the table isn't there yet. */
export async function historyOfCompanies(companyIds: string[]): Promise<Map<string, CustomerHistory> | null> {
  const ids = [...new Set(companyIds)];
  const out = new Map<string, CustomerHistory>();
  if (ids.length === 0) return out;
  let rows;
  try {
    rows = await db.customerStats.findMany({ where: { companyId: { in: ids } } });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
  const currency = baseCurrency();
  for (const r of rows) {
    out.set(r.companyId, {
      ...r,
      lifetimeValue: Number(r.lifetimeValue),
      last12Value: Number(r.last12Value),
      prev12Value: Number(r.prev12Value),
      overdue: Number(r.overdue),
      tier: r.tier as LoyaltyTier | null,
      firstOrderAt: r.firstOrderAt?.toISOString() ?? null,
      lastPurchaseAt: r.lastPurchaseAt?.toISOString() ?? null,
      computedAt: r.computedAt.toISOString(),
      currency,
    });
  }
  return out;
}
