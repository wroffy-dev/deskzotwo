import { addMonths, cycleMonths } from "@/lib/subscriptions/renewal-order";

/**
 * The arithmetic of recurring billing — pure, so every date and every paisa can be re-run without a
 * database (scripts/check-recurring-billing.ts).
 *
 * Dates are calendar days as a `@db.Date` holds them, at UTC midnight.
 */

const DAY = 86_400_000;

export type InstalmentCycle = "MONTHLY" | "QUARTERLY" | "HALF_YEARLY" | "ANNUAL";
export const INSTALMENT_CYCLES: readonly InstalmentCycle[] = ["MONTHLY", "QUARTERLY", "HALF_YEARLY", "ANNUAL"];
export const isInstalmentCycle = (v: unknown): v is InstalmentCycle => typeof v === "string" && (INSTALMENT_CYCLES as readonly string[]).includes(v);
/** "monthly", "every six months"… — for sentences. */
export const cycleWords: Record<InstalmentCycle, string> = { MONTHLY: "monthly", QUARTERLY: "quarterly", HALF_YEARLY: "every six months", ANNUAL: "yearly" };
export type Period = { start: Date; end: Date; index: number; count: number };

/**
 * The parts a term is invoiced in: one every cycle from the term's first day, each ending the day
 * before the next begins, the last cut short at the term's end. A year from 15 January is twelve
 * months, 15th to 14th. Each part is counted from the term's first day, not from the part before, so
 * a term from 31 January has parts starting 28 February and then 31 March — `addMonths` clamps a
 * short month without the clamp carrying forward — and no day is in two parts or in neither.
 */
export function instalmentPeriods(termStart: Date, termEnd: Date, cycle: InstalmentCycle): Period[] {
  const months = cycleMonths[cycle];
  const parts: { start: Date; end: Date }[] = [];
  // A term of fifty years is still bounded; a corrupt end date must not loop for ever.
  for (let k = 0; k < 600; k++) {
    const start = addMonths(termStart, k * months);
    if (start > termEnd) break;
    const next = addMonths(termStart, (k + 1) * months);
    parts.push({ start, end: new Date(Math.min(next.getTime() - DAY, termEnd.getTime())) });
  }
  return parts.map((p, index) => ({ ...p, index, count: parts.length }));
}

/** The parts to raise today: begun by today, and none that began before billing was switched on. */
export function instalmentsDue(periods: Period[], today: Date, billFrom: Date | null): Period[] {
  return periods.filter((p) => p.start <= today && (!billFrom || p.start >= billFrom));
}

/**
 * One unit's price split across the parts: even to the paisa, the last part taking whatever rounding
 * left over — so the parts always add up to the price, never a paisa more or less.
 */
export function instalmentAmounts(price: number, count: number): number[] {
  if (count <= 0) return [];
  const paise = Math.round(price * 100);
  const each = Math.floor(paise / count);
  return Array.from({ length: count }, (_, i) => (i === count - 1 ? paise - each * (count - 1) : each) / 100);
}

/**
 * The parts whose day has gone by with nothing raised for them (16 Nov 2026 — "nothing gets missed"): begun more than
 * `graceDays` ago (the job runs once a day), on or after the day billing started, and not claimed — no draft, and not
 * skipped by deleting one. Each is a part the daily job should have raised and didn't.
 */
export function missedParts(periods: Period[], claimedStarts: Set<string>, today: Date, billFrom: Date | null, graceDays = 2): Period[] {
  const cutoff = today.getTime() - graceDays * DAY;
  return periods.filter((p) => p.start.getTime() <= cutoff && (!billFrom || p.start >= billFrom) && !claimedStarts.has(isoDay(p.start)));
}

/** Auto-renew raises the next term on its first day: the day after the current one ends. */
export function renewalDue(termEnd: Date, today: Date): boolean {
  return today.getTime() >= termEnd.getTime() + DAY;
}

/** "1 Apr 2026 – 30 Apr 2026" as ISO days, for the service period on an invoice line. */
export const isoDay = (d: Date) => d.toISOString().slice(0, 10);
