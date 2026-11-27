/**
 * The leave year (owner, 18 Nov 2026 — "the leave year of some companies is Calendar year"): April to March, as Deskzo
 * always ran it, or January to December. Only leave follows it — payroll, PF and TDS stay on April to March, as the law
 * has them (src/lib/hr/calendar.ts `financialYearOf`).
 *
 * A leave year is named by the calendar year it starts in, as before: "2026" is April 2026 to March 2027 under the
 * April year, January to December 2026 under the calendar one. The company's choice is kept as a short list of rules,
 * each the first year a start month holds from (`LeaveYearSettings.rules`); none is April throughout. A change takes
 * effect from the next start of the new year after the day it is made, so the year running then is the changeover: it
 * ends where the new one begins — April to December (9 months) going to the calendar year, January to the next March
 * (15 months) going back. Its quota is that many twelfths, so nobody gains or loses days in the move.
 *
 * Pure: the rules come in as an argument. `leaveYearRules()` (./leave-year-server.ts) reads them.
 */

export const LEAVE_YEAR_STARTS = [3, 0] as const;
export type LeaveYearStart = (typeof LEAVE_YEAR_STARTS)[number];
export type LeaveYearRule = { fromYear: number; startMonth: LeaveYearStart };

/** As Deskzo always ran it: April. */
export const DEFAULT_LEAVE_YEAR_START: LeaveYearStart = 3;

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

export const leaveYearStartName = (start: LeaveYearStart) => (start === 0 ? "January to December" : "April to March");

/** The stored list, checked and in order: anything malformed is left out, never guessed at. */
export function parseLeaveYearRules(value: unknown): LeaveYearRule[] {
  if (!Array.isArray(value)) return [];
  const rules = value.flatMap((r) => {
    const fromYear = (r as { fromYear?: unknown })?.fromYear;
    const startMonth = (r as { startMonth?: unknown })?.startMonth;
    return Number.isInteger(fromYear) && (LEAVE_YEAR_STARTS as readonly unknown[]).includes(startMonth)
      ? [{ fromYear: fromYear as number, startMonth: startMonth as LeaveYearStart }]
      : [];
  });
  return rules.sort((a, b) => a.fromYear - b.fromYear);
}

/** The month a leave year starts in (0 = January). */
export function startMonthOf(year: number, rules: readonly LeaveYearRule[]): LeaveYearStart {
  let start: LeaveYearStart = DEFAULT_LEAVE_YEAR_START;
  for (const r of rules) if (r.fromYear <= year) start = r.startMonth;
  return start;
}

/** The first day of a leave year, as a `@db.Date` holds it. */
export function leaveYearStart(year: number, rules: readonly LeaveYearRule[]): Date {
  return new Date(Date.UTC(year, startMonthOf(year, rules), 1));
}

/** The day after a leave year's last: the next one's first. */
export function leaveYearEnd(year: number, rules: readonly LeaveYearRule[]): Date {
  return leaveYearStart(year + 1, rules);
}

/** Its last day. */
export function leaveYearLastDay(year: number, rules: readonly LeaveYearRule[]): Date {
  const end = leaveYearEnd(year, rules);
  return new Date(end.getTime() - 86_400_000);
}

/** How many months a leave year has: 12, or the changeover's 9 or 15. */
export function monthsInLeaveYear(year: number, rules: readonly LeaveYearRule[]): number {
  const a = leaveYearStart(year, rules);
  const b = leaveYearEnd(year, rules);
  return (b.getUTCFullYear() - a.getUTCFullYear()) * 12 + (b.getUTCMonth() - a.getUTCMonth());
}

/** A day's month within a leave year: its first month is 0; before the year is negative. */
export function monthOfLeaveYear(year: number, day: Date, rules: readonly LeaveYearRule[]): number {
  const start = leaveYearStart(year, rules);
  return (day.getUTCFullYear() - start.getUTCFullYear()) * 12 + (day.getUTCMonth() - start.getUTCMonth());
}

/** The leave year a day falls in. */
export function leaveYearOf(day: Date | string, rules: readonly LeaveYearRule[]): number {
  const d = typeof day === "string" ? new Date(`${day.slice(0, 10)}T00:00:00Z`) : day;
  const year = d.getUTCFullYear();
  return d < leaveYearStart(year, rules) ? year - 1 : year;
}

/**
 * A leave year's name: "FY 2026-27" for April to March, "2027" for a calendar year, and the months themselves for a
 * changeover — "Apr 2026 – Dec 2026".
 */
export function leaveYearLabel(year: number, rules: readonly LeaveYearRule[]): string {
  const months = monthsInLeaveYear(year, rules);
  const start = leaveYearStart(year, rules);
  if (months !== 12) {
    const last = leaveYearLastDay(year, rules);
    return `${MONTHS[start.getUTCMonth()]} ${start.getUTCFullYear()} – ${MONTHS[last.getUTCMonth()]} ${last.getUTCFullYear()}`;
  }
  return start.getUTCMonth() === 0 ? String(year) : `FY ${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}

export type LeaveYearChange = {
  rules: LeaveYearRule[];
  /** The year running now, which becomes the changeover. */
  changeoverYear: number;
  changeoverFrom: Date;
  changeoverTo: Date;
  changeoverMonths: number;
  /** The first year on the new start. */
  firstYear: number;
  firstYearFrom: Date;
  /** It takes back a change not begun yet, and nothing else moves. */
  cancelsPending?: boolean;
};

/**
 * The rules after moving to `startMonth` on `today`: from the next start of the new year after today — never one
 * already begun, and never a start inside the year running now that would name two years alike. Null when the year
 * already starts there.
 */
export function changeLeaveYear(rules: readonly LeaveYearRule[], startMonth: LeaveYearStart, today: Date): LeaveYearChange | null {
  const current = leaveYearOf(today, rules);
  // Already on its way there, or already there with nothing on its way: nothing to change.
  const pending = rules.find((r) => r.fromYear > current);
  if (pending ? pending.startMonth === startMonth : startMonthOf(current, rules) === startMonth) return null;
  // Years after this one keep no rule of their own: they follow the new start.
  const kept = rules.filter((r) => r.fromYear <= current);
  if (startMonthOf(current, kept) === startMonth) {
    if (kept.length === rules.length) return null;
    // A change not begun yet, taken back: the year running now stays as it was.
    return {
      rules: kept,
      changeoverYear: current,
      changeoverFrom: leaveYearStart(current, kept),
      changeoverTo: leaveYearLastDay(current, kept),
      changeoverMonths: monthsInLeaveYear(current, kept),
      firstYear: current + 1,
      firstYearFrom: leaveYearStart(current + 1, kept),
      cancelsPending: true,
    };
  }
  let firstYear = current + 1;
  while (new Date(Date.UTC(firstYear, startMonth, 1)) <= today) firstYear += 1;
  const next = parseLeaveYearRules([...kept, { fromYear: firstYear, startMonth }]);
  // The year before the first on the new start is the changeover; a year between (the April year after a January to
  // March the switch was made in) stays whole.
  const changeoverYear = firstYear - 1;
  return {
    rules: next,
    changeoverYear,
    changeoverFrom: leaveYearStart(changeoverYear, next),
    changeoverTo: leaveYearLastDay(changeoverYear, next),
    changeoverMonths: monthsInLeaveYear(changeoverYear, next),
    firstYear,
    firstYearFrom: leaveYearStart(firstYear, next),
  };
}
