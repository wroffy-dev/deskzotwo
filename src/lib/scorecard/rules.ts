import { monthWindow, quarterWindow, yearWindow, type PeriodWindow } from "@/lib/targets/metrics";

/**
 * The Sales scorecard's arithmetic (owner, 31 Oct 2026: "how do I check user performance — new business, renewal
 * rate, yearly total, margin, calling… also lead closure rate, won rate, lost rate"). Pure, for the page and
 * scripts/check-scorecard.ts.
 */

export const SCORECARD_PERIODS = [
  { key: "this-month", label: "This month" },
  { key: "last-month", label: "Last month" },
  { key: "this-quarter", label: "This quarter" },
  { key: "last-quarter", label: "Last quarter" },
  { key: "this-fy", label: "This financial year" },
  { key: "last-fy", label: "Last financial year" },
] as const;
export type ScorecardPeriod = (typeof SCORECARD_PERIODS)[number]["key"];

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The window a period names around `today` (a calendar day at midnight UTC, the workspace's today) — India's
 * financial year, April to March, as Targets counts it. Custom dates when both are whole days in order; this
 * financial year otherwise.
 */
export function scorecardWindow(today: Date, period: string | undefined, from?: string, to?: string): PeriodWindow & { key: string } {
  if (from && to && ISO_DAY.test(from) && ISO_DAY.test(to) && from <= to) {
    return { fromDate: from, toDate: to, label: `${from} to ${to}`, period: "MONTH", key: "custom" };
  }
  const y = today.getUTCFullYear();
  const m = today.getUTCMonth() + 1;
  const fyStart = m >= 4 ? y : y - 1;
  const quarter = Math.floor(((m + 8) % 12) / 3) + 1;
  const key = SCORECARD_PERIODS.some((p) => p.key === period) ? (period as ScorecardPeriod) : "this-fy";
  const window =
    key === "this-month"
      ? monthWindow(y, m)
      : key === "last-month"
        ? monthWindow(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1)
        : key === "this-quarter"
          ? quarterWindow(fyStart, quarter)
          : key === "last-quarter"
            ? quarter === 1
              ? quarterWindow(fyStart - 1, 4)
              : quarterWindow(fyStart, quarter - 1)
            : key === "last-fy"
              ? yearWindow(fyStart - 1)
              : yearWindow(fyStart);
  return { ...window, key };
}

/** A share as a whole percent, or null when there is nothing to share out — "—", never a made-up 0%. */
export const percent = (part: number, whole: number): number | null => (whole > 0 ? Math.round((part / whole) * 100) : null);

/**
 * How a person's leads went:
 *   · Won rate and lost rate — of the leads they closed in the period (won or lost then), the share won and lost.
 *     Disqualified ones are left out of both: a lead that was never real isn't a sale lost.
 *   · Closure rate — of the leads made in the period and theirs, the share closed by now (won or lost).
 */
export function leadRates(l: { won: number; lost: number; created: number; createdClosed: number }) {
  const closed = l.won + l.lost;
  return { wonRate: percent(l.won, closed), lostRate: percent(l.lost, closed), closureRate: percent(l.createdClosed, l.created) };
}
