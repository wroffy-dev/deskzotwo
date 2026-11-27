/**
 * Working days, week-offs and holidays — the arithmetic every other part of HR rests on.
 *
 * Pure and date-only on purpose. Everything here deals in calendar days, and the moment a timezone
 * gets involved a leave application submitted at 11pm in India starts counting from the day before.
 */

/** Days the office is closed every week. Saturday/Sunday; 0 = Sunday, 6 = Saturday. */
export const DEFAULT_WEEK_OFFS = [0, 6];

/**
 * A date reduced to its calendar day, at UTC midnight, matching how `@db.Date` stores it.
 *
 * The UTC day: right for a `@db.Date` value or a "yyyy-mm-dd" string, wrong for "today". Today is the
 * workspace's day, `clock.calendarDate(new Date())` (src/lib/time/zone.ts) — `dateOnly(new Date())` put
 * a clock-in in India before 05:30 on yesterday.
 */
export function dateOnly(value: Date | string): Date {
  const d = typeof value === "string" ? new Date(value) : value;
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

export function toKey(value: Date | string): string {
  return dateOnly(value).toISOString().slice(0, 10);
}

export function addDays(value: Date, days: number): Date {
  const d = dateOnly(value);
  d.setUTCDate(d.getUTCDate() + days);
  return d;
}

/** The longest leave span one request may cover: a year, leap day included. */
export const LEAVE_SPAN_MAX_DAYS = 366;

/**
 * Why a leave span can't be counted, or null when it can.
 *
 * Security audit, 11 Nov 2026 (SEC-28): the preview walked any span it was handed, year 1 to 9999, a day at a time in
 * memory, and an application for ten years of loss of pay crashed on the database's own limit. A real request is a year
 * at most, in a year somebody is employed in.
 */
export function leaveSpanProblem(from: Date | string, to: Date | string): string | null {
  const start = dateOnly(from);
  const end = dateOnly(to);
  if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) return "Pick real dates.";
  for (const d of [start, end]) {
    const year = d.getUTCFullYear();
    if (year < 2000 || year > 2100) return "Pick dates between the years 2000 and 2100.";
  }
  if (end < start) return "The end date is before the start date.";
  if (Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1 > LEAVE_SPAN_MAX_DAYS) {
    return `One request can cover at most ${LEAVE_SPAN_MAX_DAYS} days — apply for a longer absence in parts.`;
  }
  return null;
}

/**
 * Past this many days `eachDay` refuses rather than build the list (SEC-28): ten years of days is more than any
 * screen or rule here walks, and an unbounded span is a way to fill the server's memory.
 */
const EACH_DAY_CEILING = 3700;

/** Every calendar day from `from` to `to`, inclusive. */
export function eachDay(from: Date | string, to: Date | string): Date[] {
  const start = dateOnly(from);
  const end = dateOnly(to);
  if ((end.getTime() - start.getTime()) / 86_400_000 > EACH_DAY_CEILING) {
    throw new RangeError(`A span of more than ${EACH_DAY_CEILING} days can't be walked day by day.`);
  }
  const days: Date[] = [];
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d);
  return days;
}

export function isWeekOff(day: Date, weekOffs: number[] = DEFAULT_WEEK_OFFS) {
  return weekOffs.includes(day.getUTCDay());
}

export type HolidayLike = { date: Date | string; optional?: boolean };

/**
 * A lookup of the dates the office is actually closed.
 *
 * Optional (restricted) holidays are excluded: the office is open on those, so somebody who wants
 * one applies for leave like any other day. Counting them as company holidays would hand everybody
 * a dozen free days a year.
 */
export function closedDates(holidays: HolidayLike[]): Set<string> {
  return new Set(holidays.filter((h) => !h.optional).map((h) => toKey(h.date)));
}

export type LeaveSpan = {
  from: Date | string;
  to: Date | string;
  /** Only the afternoon of the first day is taken. */
  fromHalfDay?: boolean;
  /** Only the morning of the last day is taken. */
  toHalfDay?: boolean;
};

export type LeaveDayCount = {
  days: number;
  /** The working days actually consumed, for showing back what was counted. */
  workingDates: string[];
  skipped: { date: string; why: "week off" | "holiday" }[];
};

/**
 * How many days of entitlement a request actually costs.
 *
 * Weekends and holidays inside the span are free — which is the rule almost everywhere, and the
 * thing people most expect a system to get right. A half day at either end takes half off the
 * total, but only if that end is a working day: taking "the afternoon of Saturday" off should not
 * cost anybody half a day of leave.
 */
export function countLeaveDays(
  span: LeaveSpan,
  holidays: HolidayLike[],
  weekOffs: number[] = DEFAULT_WEEK_OFFS,
): LeaveDayCount {
  // SEC-28: callers check leaveSpanProblem first and say why; this is the backstop for one that didn't.
  const tooLong = leaveSpanProblem(span.from, span.to);
  if (tooLong && /at most/.test(tooLong)) throw new RangeError(tooLong);
  const closed = closedDates(holidays);
  const all = eachDay(span.from, span.to);
  const workingDates: string[] = [];
  const skipped: LeaveDayCount["skipped"] = [];

  for (const day of all) {
    const key = toKey(day);
    if (isWeekOff(day, weekOffs)) {
      skipped.push({ date: key, why: "week off" });
      continue;
    }
    if (closed.has(key)) {
      skipped.push({ date: key, why: "holiday" });
      continue;
    }
    workingDates.push(key);
  }

  let days = workingDates.length;
  const firstKey = toKey(span.from);
  const lastKey = toKey(span.to);

  if (span.fromHalfDay && workingDates.includes(firstKey)) days -= 0.5;
  // Guarded against double-counting: a single-day request flagged as both halves is one half day,
  // not zero. Somebody ticking both boxes on one date means "half of that day".
  if (span.toHalfDay && workingDates.includes(lastKey) && lastKey !== firstKey) days -= 0.5;

  return { days: Math.max(days, 0), workingDates, skipped };
}

/** Whole calendar days in a month — the denominator a monthly salary is divided by. */
export function daysInMonth(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function monthRange(year: number, month: number) {
  return {
    from: new Date(Date.UTC(year, month - 1, 1)),
    to: new Date(Date.UTC(year, month - 1, daysInMonth(year, month))),
  };
}

export const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export function monthLabel(month: number, year: number) {
  return `${MONTH_NAMES[month - 1] ?? month} ${year}`;
}

/**
 * The Indian financial year a date falls in — April to March.
 *
 * Leave quotas, PF returns and Form 16 all run on it, so "2026" here means April 2026 to March 2027.
 */
export function financialYearOf(value: Date | string) {
  const d = dateOnly(value);
  return d.getUTCMonth() >= 3 ? d.getUTCFullYear() : d.getUTCFullYear() - 1;
}

export function financialYearLabel(year: number) {
  return `FY ${year}-${String((year + 1) % 100).padStart(2, "0")}`;
}
