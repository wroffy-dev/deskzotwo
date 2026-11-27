"use server";

import { revalidatePath } from "next/cache";
import type { BillingCycle, RecurringBillingMode } from "@prisma/client";
import { db } from "@/lib/db";
import { moduleAvailableForTenant, requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { mayAccess } from "@/lib/authz/access";
import { recordAudit } from "@/lib/audit";
import { workspaceClock } from "@/lib/time/workspace";
import { formatOrderId } from "@/lib/order-id";
import { orderPath } from "@/lib/record-links";
import { INSTALMENT_CYCLES, cycleWords, instalmentPeriods, isInstalmentCycle, isoDay, type InstalmentCycle } from "@/lib/recurring-billing/periods";
import { notMigratedYet } from "@/lib/not-migrated";
import type { ActionResult } from "@/actions/company";

/**
 * Switching recurring billing on, off, or between its two kinds, on one subscription order — and
 * reading what it has raised. The daily job is src/lib/recurring-billing/run.ts.
 *
 * Read by anybody who can open the order. Changed by somebody who raises documents ("Raise and issue
 * sales documents") and may edit this order — the drafts it makes are invoices in this order's name.
 */

export type RecurringBillingView = {
  orderId: string;
  setting: { mode: RecurringBillingMode; cycle: BillingCycle | null; billFrom: string | null; keepRenewing: boolean; setBy: string; since: string } | null;
  /** Null where that kind of billing can be switched on; otherwise why not. */
  why: { AUTO_RENEW: string | null; INSTALMENTS: string | null };
  /** The first part beginning today or later, per cycle: where instalments start unless told otherwise. */
  suggestedFrom: Record<InstalmentCycle, string | null>;
  /** Null where keeping on renewing can be chosen; otherwise why not (it punches renewals, which needs Renewals). */
  whyNotKeep: string | null;
  term: { start: string | null; end: string | null };
  raised: { start: string; end: string; documentId: string | null; docNumber: string | null; status: string | null; renewal: { seq: number; path: string } | null }[];
  canManage: boolean;
};

const SUBSCRIPTION_ONLY = "Only a subscription recurs.";

async function loadOrder(orderId: string) {
  return db.companyProduct.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      orderSeq: true,
      orderStatus: true,
      startDate: true,
      endDate: true,
      unitPrice: true,
      fullTermUnitPrice: true,
      item: { select: { type: true } },
    },
  });
}

type LoadedOrder = NonNullable<Awaited<ReturnType<typeof loadOrder>>>;

function whyNot(order: LoadedOrder, renewalsOn: boolean): RecurringBillingView["why"] {
  const price = Number(order.fullTermUnitPrice ?? order.unitPrice ?? 0);
  const autoRenew = !renewalsOn
    ? "Auto-renewal punches the next term's order, which needs Renewals — part of Deskzo Subscriptions and Deskzo One."
    : !order.endDate
      ? "It has no expiry date, so there is no next term to renew."
      : price <= 0
        ? "It has no price to renew at."
        : null;
  const instalments =
    !order.startDate || !order.endDate
      ? "It needs a start and an end date to be split into parts."
      : Number(order.unitPrice ?? 0) <= 0
        ? "It has no price to split."
        : instalmentPeriods(order.startDate, order.endDate, "MONTHLY").length < 2
          ? "Its term is a month or less — there is nothing to split."
          : null;
  return { AUTO_RENEW: autoRenew, INSTALMENTS: instalments };
}

function firstPartFrom(order: LoadedOrder, cycle: InstalmentCycle, today: Date): string | null {
  if (!order.startDate || !order.endDate) return null;
  const next = instalmentPeriods(order.startDate, order.endDate, cycle).find((p) => p.start >= today);
  return next ? isoDay(next.start) : null;
}

export async function recurringBillingFor(orderId: string): Promise<RecurringBillingView | null> {
  const user = await requireModuleUser("orders");
  if (!(await mayAccess(user.id, "orders", "view", orderId))) return null;
  const order = await loadOrder(orderId);
  if (!order || order.item.type !== "SUBSCRIPTION") return null;

  const [setting, periods] = await Promise.all([
    readSetting(orderId),
    db.recurringBillingPeriod.findMany({
      where: { companyProductId: orderId },
      orderBy: { periodStart: "asc" },
      select: { periodStart: true, periodEnd: true, documentId: true, renewalOrderId: true, document: { select: { docNumber: true, status: true } } },
    }),
  ]);
  const renewalIds = periods.map((p) => p.renewalOrderId).filter((v): v is string => !!v);
  const renewals = new Map(
    (await db.companyProduct.findMany({ where: { id: { in: renewalIds } }, select: { id: true, orderSeq: true } })).map((r) => [r.id, r.orderSeq]),
  );
  const today = (await workspaceClock()).calendarDate(new Date());
  const renewalsOn = await moduleAvailableForTenant("renewals");

  return {
    orderId,
    setting: setting
      ? { mode: setting.mode, cycle: setting.cycle, billFrom: setting.billFrom ? isoDay(setting.billFrom) : null, keepRenewing: setting.keepRenewing, setBy: setting.setBy.name, since: setting.createdAt.toISOString() }
      : null,
    why: whyNot(order, renewalsOn),
    suggestedFrom: Object.fromEntries(INSTALMENT_CYCLES.map((c) => [c, firstPartFrom(order, c, today)])) as Record<InstalmentCycle, string | null>,
    whyNotKeep: !renewalsOn
      ? "Renewing punches the next term's order, which needs Renewals — part of Deskzo Subscriptions and Deskzo One."
      : !order.endDate
        ? "It has no expiry date, so there is no next term to renew into."
        : null,
    term: { start: order.startDate ? isoDay(order.startDate) : null, end: order.endDate ? isoDay(order.endDate) : null },
    raised: periods.map((p) => {
      const seq = p.renewalOrderId ? renewals.get(p.renewalOrderId) : undefined;
      return {
        start: isoDay(p.periodStart),
        end: isoDay(p.periodEnd),
        documentId: p.documentId,
        docNumber: p.document?.docNumber ?? null,
        status: p.document?.status ?? null,
        renewal: seq ? { seq, path: orderPath(seq) } : null,
      };
    }),
    canManage: (await can(user.id, "docs.createInvoice")) && (await mayAccess(user.id, "orders", "edit", orderId)),
  };
}

/** The setting read back, keepRenewing as no where the workspace hasn't the column yet. */
async function readSetting(orderId: string) {
  const base = { mode: true, cycle: true, billFrom: true, createdAt: true, setBy: { select: { name: true } } } as const;
  try {
    return await db.recurringBilling.findUnique({ where: { companyProductId: orderId }, select: { ...base, keepRenewing: true } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    const row = await db.recurringBilling.findUnique({ where: { companyProductId: orderId }, select: base });
    return row ? { ...row, keepRenewing: false } : null;
  }
}

/**
 * The billing plan on one subscription (owner, 16 Nov 2026): the whole term when it renews, or the term in parts, and —
 * either way — whether it keeps renewing on this plan, term after term.
 */
export type RecurringBillingSetting =
  | { mode: "AUTO_RENEW"; keepRenewing?: boolean }
  | { mode: "INSTALMENTS"; cycle: InstalmentCycle; billFrom: string; keepRenewing?: boolean }
  | null;

/** Switches it on, changes it, or (`null`) switches it off. What it has raised already stays raised. */
export async function setRecurringBilling(orderId: string, setting: RecurringBillingSetting): Promise<ActionResult<null>> {
  const user = await requireModuleUser("orders");
  if (!(await can(user.id, "docs.createInvoice"))) return { ok: false, error: "Recurring billing raises invoices, so it takes \"Create tax invoices\"." };
  if (!(await mayAccess(user.id, "orders", "edit", orderId))) return { ok: false, error: "That order no longer exists." };
  const order = await loadOrder(orderId);
  if (!order) return { ok: false, error: "That order no longer exists." };
  if (order.item.type !== "SUBSCRIPTION") return { ok: false, error: SUBSCRIPTION_ONLY };
  const label = formatOrderId(order.orderSeq);

  if (setting === null) {
    const { count } = await db.recurringBilling.deleteMany({ where: { companyProductId: orderId } });
    if (count > 0) await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Order", entityId: orderId, entityLabel: `${label} — recurring billing switched off` });
    revalidatePath(orderPath(order.orderSeq));
    return { ok: true, data: null };
  }

  const why = whyNot(order, await moduleAvailableForTenant("renewals"))[setting.mode];
  if (why) return { ok: false, error: why };

  let cycle: BillingCycle | null = null;
  let billFrom: Date | null = null;
  if (setting.mode === "INSTALMENTS") {
    if (!isInstalmentCycle(setting.cycle)) return { ok: false, error: "Instalments are monthly, quarterly, half-yearly or yearly." };
    if (instalmentPeriods(order.startDate!, order.endDate!, setting.cycle).length < 2) {
      return { ok: false, error: `Its term is no longer than one ${setting.cycle === "ANNUAL" ? "year" : setting.cycle === "HALF_YEARLY" ? "half-year" : setting.cycle === "QUARTERLY" ? "quarter" : "month"} — there is nothing to split.` };
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(setting.billFrom ?? "")) return { ok: false, error: "Pick the day billing starts from." };
    billFrom = new Date(`${setting.billFrom}T00:00:00.000Z`);
    if (Number.isNaN(billFrom.getTime()) || billFrom < order.startDate! || billFrom > order.endDate!) {
      return { ok: false, error: `Billing starts inside the term: ${isoDay(order.startDate!)} to ${isoDay(order.endDate!)}.` };
    }
    cycle = setting.cycle;
  }

  /**
   * Security audit round three, 14 Nov 2026 (R3-17, low): periods are claimed by their start day, so a new cycle or
   * start cut the term into different periods whose starts weren't claimed yet — overlapping what was already
   * billed (a monthly March billed, then quarterly from February billing February to April again). A new cycle or
   * start now begins after the last period already claimed; earlier than that is refused.
   */
  const current = await db.recurringBilling.findUnique({ where: { companyProductId: orderId }, select: { mode: true, cycle: true, billFrom: true } });
  const changes =
    !current || current.mode !== setting.mode || (current.cycle ?? null) !== cycle || (current.billFrom ? isoDay(current.billFrom) : null) !== (billFrom ? isoDay(billFrom) : null);
  if (changes && setting.mode === "INSTALMENTS" && billFrom) {
    const last = await db.recurringBillingPeriod.findFirst({ where: { companyProductId: orderId }, orderBy: { periodEnd: "desc" }, select: { periodEnd: true } });
    if (last && billFrom <= last.periodEnd) {
      return {
        ok: false,
        error: `This order is billed up to ${isoDay(last.periodEnd)} already — a new cycle starts after that, or it would bill those days again.`,
      };
    }
  }

  const keepRenewing = setting.keepRenewing === true;
  if (keepRenewing && (!(await moduleAvailableForTenant("renewals")) || !order.endDate)) {
    return { ok: false, error: "Keeping on renewing punches the next term's order: it needs Renewals, and an expiry date to renew from." };
  }
  try {
    await db.recurringBilling.upsert({
      where: { companyProductId: orderId },
      create: { companyProductId: orderId, mode: setting.mode, cycle, billFrom, keepRenewing, setById: user.id },
      update: { mode: setting.mode, cycle, billFrom, keepRenewing, setById: user.id },
      select: { companyProductId: true },
    });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    if (keepRenewing) return { ok: false, error: "This workspace is still being updated to offer renewing on a plan. Try again in a few minutes." };
    await db.recurringBilling.upsert({
      where: { companyProductId: orderId },
      create: { companyProductId: orderId, mode: setting.mode, cycle, billFrom, setById: user.id },
      update: { mode: setting.mode, cycle, billFrom, setById: user.id },
      select: { companyProductId: true },
    });
  }
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "Order",
    entityId: orderId,
    entityLabel:
      (setting.mode === "AUTO_RENEW"
        ? `${label} — set to renew itself at the end of its term`
        : `${label} — set to be invoiced ${cycleWords[cycle as InstalmentCycle]} from ${isoDay(billFrom!)}`) + (keepRenewing ? ", and to keep renewing on this plan" : ""),
  });
  revalidatePath(orderPath(order.orderSeq));
  return { ok: true, data: null };
}
