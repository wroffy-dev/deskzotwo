/**
 * A resignation's arithmetic (owner, 31 Oct 2026). Pure, for src/actions/resignation.ts and scripts/check-resignation.ts.
 *
 * Days are calendar days at midnight UTC, as a `@db.Date` holds them. Notice runs from the day it is handed in: with
 * 30 days' notice, handed in on 1 November, the last working day is 1 December.
 */

const DAY = 86_400_000;

/** How far ahead a last working day may be asked for — a resignation is not a plan for next year. */
export const MAX_DAYS_AHEAD = 365;

export const lastDayForNotice = (submittedOn: Date, noticeDays: number): Date => new Date(submittedOn.getTime() + Math.max(0, noticeDays) * DAY);

export const daysBetween = (from: Date, to: Date): number => Math.round((to.getTime() - from.getTime()) / DAY);

/** Days of notice not served by leaving on `lastDay` — what a settlement may recover; 0 when it is served in full. */
export function noticeShortfall(submittedOn: Date, noticeDays: number, lastDay: Date): number {
  return Math.max(0, noticeDays - daysBetween(submittedOn, lastDay));
}

/** Why a last working day can't be asked for or accepted, or null when it can. */
export function lastDayProblem(submittedOn: Date, lastDay: Date): string | null {
  if (Number.isNaN(lastDay.getTime())) return "Choose the last working day.";
  if (lastDay < submittedOn) return "The last working day can't be before the day it was handed in.";
  if (daysBetween(submittedOn, lastDay) > MAX_DAYS_AHEAD) return "The last working day can be at most a year away.";
  return null;
}
