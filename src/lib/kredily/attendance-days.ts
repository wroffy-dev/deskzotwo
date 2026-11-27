import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { toKey } from "@/lib/hr/calendar";
import { payrollMonthLocked } from "@/lib/hr/payroll-lock";
import { calendarDayRange } from "@/lib/time/zone";
import { workspaceClock } from "@/lib/time/workspace";
import { markMeaning, NOT_A_DAY, tidyMark, type KredilyAttendance } from "@/lib/kredily/attendance";

export type AttendancePlan = {
  from: string;
  to: string;
  /** Days by Kredily's mark, every one in the report. */
  marks: { mark: string; days: number; known: boolean; absent: boolean }[];
  /** Whether absent marks come across; days marked present (a half counted as one) and absent, every person's. */
  withAbsent: boolean;
  presentDays: number;
  absentDays: number;
  people: number;
  /** Employee codes in the report with no Deskzo employee record of that code. */
  notHere: string[];
  /** Days to write; days Deskzo already has, kept as they are. */
  days: number;
  kept: number;
  /** Of those kept, days in a month whose payroll is already run — never written (src/lib/hr/payroll-lock.ts). */
  locked: number;
};

/**
 * Kredily's attendance history as Deskzo days (owner, 31 Oct 2026): each person found by employee code — the code their
 * Deskzo employee record carries — and each day's mark as its status (src/lib/kredily/attendance.ts), nothing past
 * today. A day Deskzo already has for that person is kept as it is, so a second run writes only what's missing.
 *
 * Absent marks come only when asked, or when the report has more days present than absent: a Kredily nobody punched
 * into marks nearly every working day absent (Wroffy's: two half days present, eleven thousand absent), and those
 * aren't absences.
 */
export async function attendancePlan(att: KredilyAttendance, asked?: boolean, only?: { userIds: string[] }) {
  const today = toKey((await workspaceClock()).calendarDate(new Date()));
  const marks = new Map<string, { mark: string; days: number; known: boolean; absent: boolean }>();
  for (const m of att.marks) {
    const mark = tidyMark(m.mark);
    if (NOT_A_DAY.has(mark)) continue;
    const meaning = markMeaning(mark);
    const was = marks.get(mark) ?? { mark, days: 0, known: !!meaning, absent: !!meaning?.absent };
    was.days += 1;
    marks.set(mark, was);
  }
  const presentDays = att.marks.filter((m) => tidyMark(m.mark).split(" / ").some((p) => p === "P" || p === "OD" || p === "WFH")).length;
  const absentDays = att.marks.filter((m) => markMeaning(m.mark)?.absent).length;
  const withAbsent = asked ?? presentDays > absentDays;

  const codes = [...new Set(att.marks.map((m) => m.code))];
  // `only`: a check's own people, so a run against a full database never writes anybody else's days.
  const profiles = await db.employeeProfile.findMany({ where: { employeeCode: { in: codes, mode: "insensitive" }, ...(only ? { userId: { in: only.userIds } } : {}) }, select: { userId: true, employeeCode: true } });
  const userOf = new Map(profiles.map((p) => [p.employeeCode!.toLowerCase(), p.userId]));
  const span = calendarDayRange(att.from, att.to < today ? att.to : today);
  const had = userOf.size && span ? await db.attendanceDay.findMany({ where: { userId: { in: [...userOf.values()] }, date: span }, select: { userId: true, date: true } }) : [];
  const taken = new Set(had.map((d) => `${d.userId}:${toKey(d.date)}`));

  // Security audit round two, 13 Nov 2026 (low): a month whose payroll is run (LOCKED or PAID) has turned its days into
  // payslips, and every other writer of attendance refuses it (src/lib/hr/payroll-lock.ts, SEC-44). Kredily's history
  // wrote into it regardless; now its days there are left out, counted as kept.
  const lockedMonths = new Map<string, Promise<boolean>>();
  const monthLocked = (date: string) => {
    const key = date.slice(0, 7);
    let found = lockedMonths.get(key);
    if (!found) {
      found = payrollMonthLocked(Number(date.slice(5, 7)), Number(date.slice(0, 4)));
      lockedMonths.set(key, found);
    }
    return found;
  };

  const rows: Prisma.AttendanceDayCreateManyInput[] = [];
  let kept = 0;
  let locked = 0;
  for (const m of att.marks) {
    const userId = userOf.get(m.code.toLowerCase());
    const meaning = markMeaning(m.mark);
    if (!userId || !meaning || m.date > today || (meaning.absent && !withAbsent)) continue;
    if (taken.has(`${userId}:${m.date}`)) {
      kept += 1;
      continue;
    }
    if (await monthLocked(m.date)) {
      locked += 1;
      continue;
    }
    taken.add(`${userId}:${m.date}`);
    rows.push({ userId, date: calendarDayRange(m.date, null)!.gte!, status: meaning.status, note: `From Kredily (${tidyMark(m.mark)})` });
  }
  const plan: AttendancePlan = {
    from: att.from,
    to: att.to,
    marks: [...marks.values()].sort((a, b) => b.days - a.days),
    withAbsent,
    presentDays,
    absentDays,
    people: new Set(rows.map((r) => r.userId)).size,
    notHere: codes.filter((c) => !userOf.has(c.toLowerCase())),
    days: rows.length,
    kept: kept + locked,
    locked,
  };
  return { plan, rows };
}

/** The attendance days, written after the employee records so a person brought in this run is found by their code. */
export async function writeAttendance(att: KredilyAttendance, withAbsent?: boolean, only?: { userIds: string[] }) {
  const planned = await attendancePlan(att, withAbsent, only);
  let created = 0;
  for (let i = 0; i < planned.rows.length; i += 1000) {
    created += (await db.attendanceDay.createMany({ data: planned.rows.slice(i, i + 1000), skipDuplicates: true })).count;
  }
  return { created, kept: planned.plan.kept + (planned.rows.length - created), notHere: planned.plan.notHere.length };
}
