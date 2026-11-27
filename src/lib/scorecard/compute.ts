import type { PrismaClient } from "@prisma/client";
import { measureMany, ordersByType, type MeasureRequest, type OrdersByType } from "@/lib/targets/measure";
import type { MetricKey } from "@/lib/targets/metrics";
import { byStageDate, salesLeads } from "@/lib/pipeline/server";
import { workspaceClock } from "@/lib/time/workspace";
import { buildRenewalReport } from "@/lib/renewals-report";
import { TIDY_NOTE } from "@/lib/renewal-tidy";
import { leadRates, percent } from "@/lib/scorecard/rules";

/**
 * The Sales scorecard's figures, one row a person over a window (owner, 31 Oct 2026). Every figure Targets also
 * measures is Targets' own measurement (src/lib/targets/measure.ts), so the two pages never disagree; the renewal
 * rate is the renewals report's (src/lib/renewals-report.ts), credited as that report credits it — to the
 * customer's account manager. Not a "use server" file: the action and the check suite call it.
 */

export type ScorecardRow = {
  userId: string;
  name: string;
  orders: OrdersByType;
  orderValue: number;
  orderMargin: number;
  marginPercent: number | null;
  invoiced: number;
  collected: number;
  newCustomers: number;
  leads: { created: number; won: number; lost: number; open: number; wonValue: number; wonRate: number | null; lostRate: number | null; closureRate: number | null };
  renewals: { due: number; renewed: number; lost: number; open: number; valueRenewed: number; rate: number | null };
  calls: { made: number; reached: number; minutes: number };
  /** The person's own targets for exactly this period, by the figure they are set on — what was set and how much is done. */
  targets: Partial<Record<TargetedFigure, { target: number; percent: number | null }>>;
};

/** The figures a person's target can be set on, by the metric it is set as. */
export const TARGETED: Record<string, TargetedFigure> = {
  ORDER_VALUE: "orderValue",
  ORDER_MARGIN: "orderMargin",
  INVOICED_VALUE: "invoiced",
  COLLECTED_VALUE: "collected",
  NEW_CUSTOMERS: "newCustomers",
  LEADS_WON: "leadsWon",
  CALLS_CONNECTED: "callsReached",
  CALL_MINUTES: "callMinutes",
};
export type TargetedFigure = "orderValue" | "orderMargin" | "invoiced" | "collected" | "newCustomers" | "leadsWon" | "callsReached" | "callMinutes";

/** A row's figure as its target counts it. */
export function figureOf(r: Omit<ScorecardRow, "targets">, f: TargetedFigure): number {
  return f === "newCustomers" ? r.newCustomers : f === "leadsWon" ? r.leads.won : f === "callsReached" ? r.calls.reached : f === "callMinutes" ? r.calls.minutes : r[f];
}

const METRICS: MetricKey[] = ["INVOICED_VALUE", "COLLECTED_VALUE", "ORDER_VALUE", "ORDER_MARGIN", "LEADS_WON", "LEAD_VALUE_WON", "LEADS_CREATED", "NEW_CUSTOMERS", "CALLS_CONNECTED", "CALL_MINUTES"];

const zeroSplit = { value: 0, margin: 0, marginOf: 0 };

export async function buildScorecard(db: PrismaClient, people: { id: string; name: string }[], window: { fromDate: string; toDate: string }): Promise<ScorecardRow[]> {
  if (people.length === 0) return [];
  const clock = await workspaceClock();
  const from = new Date(`${window.fromDate}T00:00:00Z`);
  const to = new Date(`${window.toDate}T00:00:00Z`);
  const ids = people.map((p) => p.id);
  // The window as instants on the workspace's clock: its first day's midnight to the midnight after its last.
  const [fy, fm, fd] = [from.getUTCFullYear(), from.getUTCMonth(), from.getUTCDate()];
  const [ty, tm, td] = [to.getUTCFullYear(), to.getUTCMonth(), to.getUTCDate()];
  const range = { gte: clock.midnight(fy, fm, fd), lt: clock.midnight(ty, tm, td + 1) };

  // Targets' measurements, one person a request, asked once a metric across everybody.
  const requests: MeasureRequest[] = METRICS.flatMap((metric) => ids.map((id) => ({ metric, from, to, userIds: [id] })));
  const answers = await measureMany(db, requests);
  const measured = (metric: MetricKey, id: string) => answers[METRICS.indexOf(metric) * ids.length + ids.indexOf(id)] ?? 0;

  const sales = await salesLeads();
  const [byType, lost, createdByStatus, open, dialled, renewalRows] = await Promise.all([
    ordersByType(db, { from, to, userIds: ids }),
    // Lost in the window, by when it moved to lost — as won is counted.
    byStageDate((moved) => db.lead.groupBy({ by: ["ownerUserId"], where: { status: "LOST", ownerUserId: { in: ids }, ...moved(range), AND: [sales] }, _count: { _all: true } })),
    // Made in the window and theirs, by where each stands now — for the closure rate.
    db.lead.groupBy({ by: ["ownerUserId", "status"], where: { ownerUserId: { in: ids }, createdAt: range, AND: [sales] }, _count: { _all: true } }),
    db.lead.groupBy({ by: ["ownerUserId"], where: { ownerUserId: { in: ids }, status: { notIn: ["WON", "LOST", "DISQUALIFIED"] }, AND: [sales] }, _count: { _all: true } }),
    db.callLog.groupBy({ by: ["userId"], where: { userId: { in: ids }, startedAt: range }, _count: { _all: true } }),
    // The renewals report's rows (src/actions/renewal.ts renewalReport): subscriptions whose term ended in the window,
    // credited to the customer's account manager. End dates are typed days, kept at midnight UTC.
    db.companyProduct.findMany({
      where: {
        item: { type: "SUBSCRIPTION" },
        parentId: null,
        orderStatus: { notIn: ["CANCELLED", "REJECTED"] },
        endDate: { gte: from, lt: new Date(to.getTime() + 86_400_000) },
        company: { managedByResellerId: null, ownerUserId: { in: ids } },
      },
      take: 50_000,
      select: {
        id: true,
        endDate: true,
        quantity: true,
        unitPrice: true,
        fullTermUnitPrice: true,
        renewalStage: true,
        renewalStageNote: true,
        item: { select: { name: true } },
        company: { select: { owner: { select: { id: true, name: true } } } },
        renewedBy: { select: { orderStatus: true } },
      },
    }),
  ]);

  const count = (rows: { ownerUserId: string | null; _count: { _all: number } }[]) => new Map(rows.map((r) => [r.ownerUserId, r._count._all]));
  const lostBy = count(lost);
  const openBy = count(open);
  const dialledBy = new Map(dialled.map((r) => [r.userId, r._count._all]));
  const created = new Map<string, { all: number; closed: number }>();
  for (const r of createdByStatus) {
    if (!r.ownerUserId) continue;
    const c = created.get(r.ownerUserId) ?? { all: 0, closed: 0 };
    c.all += r._count._all;
    if (r.status === "WON" || r.status === "LOST") c.closed += r._count._all;
    created.set(r.ownerUserId, c);
  }
  const renewalReport = buildRenewalReport(
    renewalRows
      .filter((r) => r.renewalStageNote !== TIDY_NOTE)
      .map((r) => {
        const price = Number(r.fullTermUnitPrice ?? r.unitPrice ?? 0);
        const renewed = !!r.renewedBy && r.renewedBy.orderStatus !== "CANCELLED" && r.renewedBy.orderStatus !== "REJECTED";
        return {
          id: r.id,
          endDate: r.endDate!,
          value: Math.round(price * r.quantity * 100) / 100,
          outcome: renewed ? ("RENEWED" as const) : r.renewalStage === "LOST" ? ("LOST" as const) : ("OPEN" as const),
          lostReason: r.renewalStageNote,
          product: r.item.name,
          ownerId: r.company.owner?.id ?? null,
          ownerName: r.company.owner?.name ?? null,
        };
      }),
    (d) => d.toISOString().slice(0, 7),
  );
  const renewalsBy = new Map(renewalReport.people.map((p) => [p.key, p]));

  // Each person's own active targets set for exactly this period (owner, 31 Oct 2026: "% of target"). A target over
  // another stretch of time isn't this period's, so it isn't shown against it; a team's target is the team's.
  const targets = await db.target.findMany({
    where: { active: true, scope: "USER", userId: { in: ids }, fromDate: from, toDate: to, metric: { in: Object.keys(TARGETED) as never } },
    select: { userId: true, metric: true, value: true },
  });

  const rows = people.map((p): Omit<ScorecardRow, "targets"> => {
    const orders = byType.get(p.id) ?? { new: zeroSplit, renewal: zeroSplit, addon: zeroSplit };
    const marginOf = orders.new.marginOf + orders.renewal.marginOf + orders.addon.marginOf;
    const orderMargin = measured("ORDER_MARGIN", p.id);
    const won = measured("LEADS_WON", p.id);
    const lostCount = lostBy.get(p.id) ?? 0;
    const c = created.get(p.id) ?? { all: 0, closed: 0 };
    const r = renewalsBy.get(p.id);
    return {
      userId: p.id,
      name: p.name,
      orders,
      orderValue: measured("ORDER_VALUE", p.id),
      orderMargin,
      marginPercent: percent(orderMargin, marginOf),
      invoiced: measured("INVOICED_VALUE", p.id),
      collected: measured("COLLECTED_VALUE", p.id),
      newCustomers: measured("NEW_CUSTOMERS", p.id),
      leads: {
        created: measured("LEADS_CREATED", p.id),
        won,
        lost: lostCount,
        open: openBy.get(p.id) ?? 0,
        wonValue: measured("LEAD_VALUE_WON", p.id),
        ...leadRates({ won, lost: lostCount, created: c.all, createdClosed: c.closed }),
      },
      renewals: { due: r?.due ?? 0, renewed: r?.renewed ?? 0, lost: r?.lost ?? 0, open: r?.open ?? 0, valueRenewed: r?.valueRenewed ?? 0, rate: r?.rate ?? null },
      calls: { made: dialledBy.get(p.id) ?? 0, reached: measured("CALLS_CONNECTED", p.id), minutes: measured("CALL_MINUTES", p.id) },
    };
  });

  return rows.map((r) => {
    const mine: ScorecardRow["targets"] = {};
    for (const t of targets) {
      if (t.userId !== r.userId) continue;
      const figure = TARGETED[t.metric]!;
      const target = Number(t.value);
      mine[figure] = { target, percent: percent(figureOf(r, figure), target) };
    }
    return { ...r, targets: mine };
  });
}

/** Whether a row has anything in it — the page lists the people with something to show first, and can hide the rest. */
export function hasActivity(r: ScorecardRow): boolean {
  return r.orderValue !== 0 || r.invoiced !== 0 || r.collected !== 0 || r.leads.created + r.leads.won + r.leads.lost + r.leads.open > 0 || r.renewals.due > 0 || r.calls.made > 0;
}
