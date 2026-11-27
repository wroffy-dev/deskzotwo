import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { toKey } from "@/lib/hr/calendar";
import { crossesMidnight, shiftOn, type DayShift, type ShiftLike } from "@/lib/hr/shift-rules";

/**
 * Who works which shift on which day, for a set of people over a span (owner, 31 Oct 2026 — the rules are
 * src/lib/hr/shift-rules.ts). Server only; the caller decides who may see it. A workspace without the tables yet
 * answers as before shifts: no shift, Saturday and Sunday off.
 */
export type ShiftLookup = (userId: string, day: Date) => DayShift;

const SHIFT_SELECT = { id: true, name: true, code: true, startMinute: true, endMinute: true, graceMinutes: true, weekOffs: true } as const;

export async function shiftsFor(userIds: string[], from: Date, to: Date): Promise<ShiftLookup> {
  let assignments: { userId: string; fromDate: Date; shift: ShiftLike }[] = [];
  let roster: { userId: string; date: Date; shift: ShiftLike | null }[] = [];
  if (userIds.length > 0) {
    try {
      [assignments, roster] = await Promise.all([
        db.shiftAssignment.findMany({ where: { userId: { in: userIds }, fromDate: { lte: to } }, select: { userId: true, fromDate: true, shift: { select: SHIFT_SELECT } } }),
        db.rosterDay.findMany({ where: { userId: { in: userIds }, date: { gte: from, lte: to } }, select: { userId: true, date: true, shift: { select: SHIFT_SELECT } } }),
      ]);
    } catch (err) {
      if (!notMigratedYet(err)) throw err;
    }
  }
  const byUser = new Map<string, { fromDate: Date; shift: ShiftLike }[]>();
  for (const a of assignments) {
    if (!byUser.has(a.userId)) byUser.set(a.userId, []);
    byUser.get(a.userId)!.push(a);
  }
  const entries = new Map(roster.map((r) => [`${r.userId}:${toKey(r.date)}`, { shift: r.shift }]));
  return (userId, day) => shiftOn(day, byUser.get(userId) ?? [], entries.get(`${userId}:${toKey(day)}`));
}

/**
 * The day a clock-out after midnight belongs to (owner, 31 Oct 2026): yesterday, when they are on a night shift
 * yesterday, clocked in then and haven't clocked out — and haven't clocked in today. Otherwise today.
 */
export async function dayToClockOut(userId: string, today: Date): Promise<Date> {
  const yesterday = new Date(today.getTime() - 86_400_000);
  const [todays, last] = await Promise.all([
    db.attendanceDay.findUnique({ where: { userId_date: { userId, date: today } }, select: { checkInAt: true } }),
    db.attendanceDay.findUnique({ where: { userId_date: { userId, date: yesterday } }, select: { checkInAt: true, checkOutAt: true } }),
  ]);
  if (todays?.checkInAt || !last?.checkInAt || last.checkOutAt) return today;
  const shift = (await shiftsFor([userId], yesterday, yesterday))(userId, yesterday).shift;
  return shift && crossesMidnight(shift) ? yesterday : today;
}
