import { DEFAULT_WEEK_OFFS, toKey } from "@/lib/hr/calendar";
import { dayTiming, minuteOfTime, type DayTiming, type OfficeHours } from "@/lib/hr/office-hours-rules";

/**
 * Shifts and the roster (owner, 31 Oct 2026 — src/actions/shifts.ts) — pure, for the roster, attendance and the checks.
 *
 * A day's shift: the roster's own entry for the day (another shift, or a week off), else the standing shift assigned
 * from on or before the day, else none — the company's office hours and Saturday–Sunday off, as before shifts.
 * A shift whose end comes before its start is a night shift: it ends the next morning.
 */

export type ShiftLike = { id: string; name: string; code: string; startMinute: number; endMinute: number; graceMinutes: number; weekOffs: number[] };

export type DayShift = {
  shift: ShiftLike | null;
  weekOff: boolean;
  /** Where it came from: the roster's entry for the day, the standing shift, or neither. */
  source: "roster" | "assigned" | "default";
};

/** Whether a shift runs past midnight. */
export const crossesMidnight = (s: { startMinute: number; endMinute: number }) => s.endMinute <= s.startMinute;

/** A shift's length in minutes, a night shift's included. */
export const shiftMinutes = (s: { startMinute: number; endMinute: number }) => (crossesMidnight(s) ? s.endMinute + 1440 - s.startMinute : s.endMinute - s.startMinute);

/**
 * Somebody's shift on a day. `assignments` are theirs, any order; `rosterEntry` the roster's for the day — undefined
 * when there is none, `null` shift for a week off.
 */
export function shiftOn(
  day: Date,
  assignments: { fromDate: Date; shift: ShiftLike }[],
  rosterEntry: { shift: ShiftLike | null } | undefined,
): DayShift {
  if (rosterEntry) return { shift: rosterEntry.shift, weekOff: rosterEntry.shift === null, source: "roster" };
  const key = toKey(day);
  let standing: { fromDate: Date; shift: ShiftLike } | null = null;
  for (const a of assignments) if (toKey(a.fromDate) <= key && (!standing || a.fromDate > standing.fromDate)) standing = a;
  if (standing) return { shift: standing.shift, weekOff: standing.shift.weekOffs.includes(day.getUTCDay()), source: "assigned" };
  return { shift: null, weekOff: DEFAULT_WEEK_OFFS.includes(day.getUTCDay()), source: "default" };
}

/** The hours a day is measured against: its shift's, or the office's when it has none. */
export function hoursFor(day: DayShift, office: OfficeHours | null): OfficeHours | null {
  return day.shift ? { startMinute: day.shift.startMinute, endMinute: day.shift.endMinute, graceMinutes: day.shift.graceMinutes } : office;
}

/** The working day's length in minutes against those hours. */
export const dayLengthOf = (hours: OfficeHours) => shiftMinutes(hours);

/**
 * Late, left early and overtime, against a day's hours — a night shift's too. A night shift's minutes are counted on
 * from its start, so 1 am on a 10 pm–6 am shift is three hours in, not twenty-one hours early.
 */
export function shiftTiming(
  day: { status: string | null; checkInAt: Date | string | null; checkOutAt: Date | string | null; workedMinutes: number | null },
  hours: OfficeHours | null,
  minuteOf: (at: Date) => number,
): DayTiming {
  if (!hours || !crossesMidnight(hours)) return dayTiming(day, hours, minuteOf);
  // Moved so the shift starts at 6 am: the night is then one ordinary day (16 hours at most ends by 10 pm), and the
  // office-hours rules apply.
  const shift = (m: number) => (m - hours.startMinute + 360 + 1440) % 1440;
  const moved: OfficeHours = { startMinute: 360, endMinute: 360 + shiftMinutes(hours), graceMinutes: hours.graceMinutes };
  return dayTiming(day, moved, (at) => shift(minuteOf(at)));
}

export type ShiftInput = { name: string; code: string; start: string; end: string; grace: unknown; weekOffs: unknown };

/** A shift as typed, or why it can't be kept. */
export function shiftOrRefusal(input: ShiftInput): { ok: true; shift: Omit<ShiftLike, "id"> } | { ok: false; error: string } {
  const name = String(input.name ?? "").trim();
  const code = String(input.code ?? "").trim().toUpperCase();
  if (name.length < 2 || name.length > 60) return { ok: false, error: "Name the shift — for example “General” or “Night”." };
  if (!/^[A-Z0-9]{1,4}$/.test(code)) return { ok: false, error: "The code is 1–4 letters or digits, for the roster — like G or N." };
  const startMinute = minuteOfTime(String(input.start ?? ""));
  const endMinute = minuteOfTime(String(input.end ?? ""));
  if (startMinute === null || endMinute === null) return { ok: false, error: "Give the start and end as times, like 09:30 and 18:30." };
  const length = shiftMinutes({ startMinute, endMinute });
  if (length < 60) return { ok: false, error: "A shift is at least an hour." };
  if (length > 16 * 60) return { ok: false, error: "A shift is at most 16 hours." };
  const grace = Number(input.grace);
  if (!Number.isInteger(grace) || grace < 0 || grace > 120) return { ok: false, error: "The grace is whole minutes, from 0 to 120." };
  const offs = Array.isArray(input.weekOffs) ? input.weekOffs.map(Number) : [];
  if (offs.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) return { ok: false, error: "Week offs are days of the week." };
  const weekOffs = [...new Set(offs)].sort();
  if (weekOffs.length > 3) return { ok: false, error: "At most three days off a week." };
  return { ok: true, shift: { name, code, startMinute, endMinute, graceMinutes: grace, weekOffs } };
}
