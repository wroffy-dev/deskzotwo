import type { BillingCycle, RecurringBillingMode, RenewalStage } from "@prisma/client";
import { instalmentPeriods, isInstalmentCycle, type InstalmentCycle } from "@/lib/recurring-billing/periods";

/**
 * What keeps a subscription from billing itself, and when it bills next (owner, 30 Oct 2026 — "nothing gets
 * missed"). Pure, so the daily job (src/lib/recurring-billing/run.ts), Renewals › Billing check and the
 * renewals list's "Next bill" column all answer from the same rules (scripts/check-recurring-billing.ts).
 *
 * Dates are calendar days at UTC midnight, as a `@db.Date` holds them.
 */

const DAY = 86_400_000;

export type BillingOrder = {
  mode: RecurringBillingMode;
  cycle: BillingCycle | null;
  billFrom: Date | null;
  startDate: Date | null;
  endDate: Date | null;
  unitPrice: number | null;
  locationId: string | null;
  renewalStage: RenewalStage | null;
  renewed: boolean;
  /** Keeps renewing on this plan (16 Nov 2026); missing reads as no. */
  keepRenewing?: boolean;
};

/**
 * Why a switched-on order will be passed over when it falls due — a gap somebody has to fill (a date, a price, a
 * site). Null when nothing stands in the way. A renewal marked Lost or On hold isn't a gap: somebody chose it.
 */
export function billingBlocker(o: Pick<BillingOrder, "mode" | "cycle" | "startDate" | "endDate" | "unitPrice" | "locationId">): string | null {
  if (o.mode === "INSTALMENTS") {
    if (!isInstalmentCycle(o.cycle)) return "instalments need a monthly, quarterly, half-yearly or yearly cycle";
    if (!o.startDate || !o.endDate) return "no term dates";
    if (o.unitPrice === null || o.unitPrice <= 0) return "no price";
    return null;
  }
  if (!o.endDate) return "no expiry date, so no next term";
  if (!o.locationId) return "no site to renew to";
  return null;
}

export type NextBill = { day: Date; what: string } | { day: null; what: string };

/**
 * The next day the order raises an invoice by itself, after today: the next instalment's first day, or the day
 * after the term ends for one that renews itself. Without a day, why not — said plainly for the list.
 */
export function nextBill(o: BillingOrder | null, today: Date): NextBill {
  if (!o) return { day: null, what: "Not set" };
  if (billingBlocker(o)) return { day: null, what: "Held up" };
  if (o.mode === "INSTALMENTS") {
    const parts = instalmentPeriods(o.startDate!, o.endDate!, o.cycle as InstalmentCycle);
    const next = parts.find((p) => p.start > today && (!o.billFrom || p.start >= o.billFrom));
    if (next) return { day: next.start, what: `Part ${next.index + 1} of ${next.count}` };
    // Every part raised: a plan that keeps renewing goes on into the next term, as auto-renew does.
    if (!o.keepRenewing) return { day: null, what: "All parts raised" };
  }
  if (o.renewed) return { day: null, what: "Renewed" };
  if (o.renewalStage === "LOST") return { day: null, what: "Lost — won't renew" };
  if (o.renewalStage === "ON_HOLD") return { day: null, what: "On hold" };
  const renewalDay = new Date(o.endDate!.getTime() + DAY);
  // Past its day and still not renewed: the job tries again each morning, so tomorrow is when.
  return { day: renewalDay > today ? renewalDay : new Date(today.getTime() + DAY), what: "Renews itself" };
}

/** A term this short with nothing switched on is renewed — and billed — by hand every time. */
export function shortTerm(startDate: Date | null, endDate: Date | null): boolean {
  return !!startDate && !!endDate && endDate.getTime() - startDate.getTime() <= 35 * DAY;
}
