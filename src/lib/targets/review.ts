/**
 * Holding incentive earnings for a second look when the sale behind them goes away.
 *
 * Security audit round three, 14 Nov 2026 (R3-15): an earning is worked out once and frozen, so an order
 * cancelled (or an invoice credited) after it was worked out left it due or approved — and payroll paid
 * it — on a number that is no longer true. Nothing here recalculates: the earnings whose window covers the
 * sale, on a money metric, for a target that counted the seller, are put on hold with the reason, and an
 * approver looks again (approving a held earning is the normal decision on the Incentives page).
 *
 * Earnings already on a payslip are left alone: that is payroll's to unwind, not this.
 */
import type { IncentiveStatus, Prisma, PrismaClient, TargetMetric } from "@prisma/client";
import { workspaceClock } from "@/lib/time/workspace";

/** The metrics a cancelled order or a credit note can change. */
const MONEY_METRICS: TargetMetric[] = [
  "INVOICED_VALUE",
  "COLLECTED_VALUE",
  "ORDER_VALUE",
  "ORDER_MARGIN",
  "ADDON_VALUE",
  "NEW_CUSTOMERS",
  "PURCHASE_SAVINGS",
];
const OPEN: IncentiveStatus[] = ["DUE", "APPROVED"];

type Client = PrismaClient | Prisma.TransactionClient;

/**
 * Puts on hold the open earnings a sale by `sellerId` on `on` fed into, saying why. Returns the ids held.
 *
 * `on` is the instant the sale counted (an order's booking, an invoice's issue date); its calendar day on
 * the workspace's clock is compared with the earnings' date columns.
 */
export async function holdEarningsForReview(
  client: Client,
  input: { sellerId: string; on: Date; reason: string },
): Promise<string[]> {
  const day = (await workspaceClock()).calendarDate(input.on);
  const [seller, earnings] = await Promise.all([
    client.user.findUnique({ where: { id: input.sellerId }, select: { departmentId: true } }),
    client.incentiveEarning.findMany({
      where: {
        status: { in: OPEN },
        payslipId: null,
        metric: { in: MONEY_METRICS },
        fromDate: { lte: day },
        toDate: { gte: day },
      },
      select: { id: true, userId: true, target: { select: { scope: true, userId: true, departmentId: true } } },
    }),
  ]);
  const counted = earnings.filter((e) => {
    if (e.userId === input.sellerId) return true;
    const t = e.target;
    if (!t) return false;
    if (t.scope === "USER") return t.userId === input.sellerId;
    if (t.scope === "DEPARTMENT") return !!t.departmentId && t.departmentId === seller?.departmentId;
    return true;
  });
  if (counted.length === 0) return [];
  const ids = counted.map((e) => e.id);
  await client.incentiveEarning.updateMany({
    where: { id: { in: ids }, status: { in: OPEN }, payslipId: null },
    data: { status: "HELD", heldReason: input.reason.slice(0, 500) },
  });
  return ids;
}
