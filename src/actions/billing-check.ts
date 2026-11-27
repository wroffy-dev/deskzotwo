"use server";

import { db } from "@/lib/db";
import { toPlain } from "@/lib/serialize";
import { requireModuleAccess } from "@/lib/modules-access";
import { orderAccess } from "@/lib/authz/access";
import { viewerHas } from "@/actions/permission";
import { workspaceClock } from "@/lib/time/workspace";
import { toInvoiceWhere } from "@/lib/orders/billing";
import { resellerOrderRefusal } from "@/lib/orders/reseller-gate";
import { billingBlocker, shortTerm } from "@/lib/recurring-billing/check-rules";
import { instalmentPeriods, isInstalmentCycle, isoDay, missedParts } from "@/lib/recurring-billing/periods";
import { waitingDraftsWhere, WAITING_DAYS } from "@/lib/recurring-billing/run";

/** Orders that still bill: approved and going, as the daily job counts them. */
const LIVE = ["APPROVED", "PROCESSING", "FULFILLED"] as const;
/** Each list stops here — a list longer than this is a cleanup, not a check. */
const CAP = 200;

type OrderRow = {
  id: string;
  orderSeq: number;
  company: { id: string; companySeq: number; name: string };
  item: { name: string };
  quantity: number;
  startDate: Date | null;
  endDate: Date | null;
};

export type BillingCheck = {
  /** Running subscriptions nothing bills by itself: not invoiced in full, or so short they're renewed by hand. */
  notSet: (OrderRow & { why: "not-invoiced" | "short-term" })[];
  notSetTotal: number;
  /** Switched on, but the job will pass them over when they fall due — and why. */
  heldUp: (OrderRow & { mode: "AUTO_RENEW" | "INSTALMENTS"; why: string })[];
  /** Billed in parts, with a part whose day has gone by and nothing raised for it (owner, 16 Nov 2026). */
  missed: (OrderRow & { parts: { start: string; end: string; index: number; count: number }[] })[];
  /** Drafts recurring billing raised that nobody has issued; null when the viewer can't see documents. */
  waiting: { id: string; orderSeq: number | null; company: string; createdAt: Date; days: number }[] | null;
  waitingDays: number;
};

const orderSelect = {
  id: true,
  orderSeq: true,
  quantity: true,
  startDate: true,
  endDate: true,
  company: { select: { id: true, companySeq: true, name: true } },
  item: { select: { name: true } },
} as const;

/**
 * Renewals › Billing check (owner, 30 Oct 2026 — "how will that be managed that nothing gets missed"): every
 * subscription that might not get billed, within the viewer's reach as the renewals list is.
 */
export async function billingCheck(): Promise<BillingCheck | null> {
  const user = await requireModuleAccess("renewals");
  if (!(await viewerHas("orders.view"))) return null;
  const clock = await workspaceClock();
  const today = clock.calendarDate(new Date());
  const scope = await orderAccess(user.id, "view");
  const running = {
    item: { type: "SUBSCRIPTION" as const },
    parentId: null,
    orderStatus: { in: [...LIVE] },
    endDate: { gte: today },
    renewedBy: { is: null },
  };

  // Nothing switched on, and money left unbilled — or a month's term, renewed by hand each time and soon.
  const unswitched = { AND: [scope, running, { recurringBilling: { is: null } }] };
  const toInvoice = await toInvoiceWhere();
  const [unbilled, unbilledTotal, soon] = await Promise.all([
    db.companyProduct.findMany({ where: { AND: [unswitched, toInvoice] }, select: orderSelect, orderBy: [{ endDate: "asc" }, { id: "asc" }], take: CAP }),
    db.companyProduct.count({ where: { AND: [unswitched, toInvoice] } }),
    db.companyProduct.findMany({
      where: { AND: [unswitched, { endDate: { lte: new Date(today.getTime() + 45 * 86_400_000) } }] },
      select: orderSelect,
      orderBy: [{ endDate: "asc" }, { id: "asc" }],
      take: CAP * 5,
    }),
  ]);
  const seen = new Set(unbilled.map((o) => o.id));
  const short = soon.filter((o) => !seen.has(o.id) && shortTerm(o.startDate, o.endDate));
  const notSet = [...unbilled.map((o) => ({ ...o, why: "not-invoiced" as const })), ...short.map((o) => ({ ...o, why: "short-term" as const }))].slice(0, CAP);

  // Switched on, with a gap the job can't get past.
  const switched = await db.companyProduct.findMany({
    where: { AND: [scope, running, { recurringBilling: { isNot: null } }] },
    select: {
      ...orderSelect,
      unitPrice: true,
      locationId: true,
      company: { select: { id: true, companySeq: true, name: true, relationshipType: true } },
      recurringBilling: { select: { mode: true, cycle: true, billFrom: true } },
      recurringBillingPeriods: { select: { periodStart: true } },
    },
    orderBy: [{ endDate: "asc" }, { id: "asc" }],
  });
  const heldUp: BillingCheck["heldUp"] = [];
  const missed: BillingCheck["missed"] = [];
  for (const o of switched) {
    const rb = o.recurringBilling!;
    let why = billingBlocker({ ...rb, startDate: o.startDate, endDate: o.endDate, unitPrice: o.unitPrice === null ? null : Number(o.unitPrice), locationId: o.locationId });
    if (!why && rb.mode === "AUTO_RENEW") why = await resellerOrderRefusal(o.company);
    const row = { id: o.id, orderSeq: o.orderSeq, quantity: o.quantity, startDate: o.startDate, endDate: o.endDate, company: o.company, item: o.item };
    if (why && heldUp.length < CAP) heldUp.push({ ...row, mode: rb.mode, why });
    // A part whose day has gone by with nothing raised: the job should have, and didn't (a gap filled since, a failure).
    if (!why && rb.mode === "INSTALMENTS" && isInstalmentCycle(rb.cycle) && o.startDate && o.endDate && missed.length < CAP) {
      const claimed = new Set(o.recurringBillingPeriods.map((p) => isoDay(p.periodStart)));
      const parts = missedParts(instalmentPeriods(o.startDate, o.endDate, rb.cycle), claimed, today, rb.billFrom);
      if (parts.length) missed.push({ ...row, parts: parts.map((p) => ({ start: isoDay(p.start), end: isoDay(p.end), index: p.index, count: p.count })) });
    }
  }

  // Raised and not issued — oldest first, as those are the ones forgotten.
  let waiting: BillingCheck["waiting"] = null;
  if (await viewerHas("documents.view")) {
    const docs = await db.tradeDocument.findMany({
      where: { AND: [waitingDraftsWhere(new Date(today.getTime() + 86_400_000)), { lines: { some: { companyProduct: scope } } }] },
      select: { id: true, createdAt: true, company: { select: { name: true } }, lines: { take: 1, select: { companyProduct: { select: { orderSeq: true } } } } },
      orderBy: { createdAt: "asc" },
      take: CAP,
    });
    waiting = docs.map((d) => ({
      id: d.id,
      orderSeq: d.lines[0]?.companyProduct?.orderSeq ?? null,
      company: d.company.name,
      createdAt: d.createdAt,
      days: Math.max(0, Math.round((today.getTime() - clock.calendarDate(d.createdAt).getTime()) / 86_400_000)),
    }));
  }

  return toPlain({ notSet, notSetTotal: unbilledTotal + short.length, heldUp, missed, waiting, waitingDays: WAITING_DAYS });
}
