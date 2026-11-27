"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { getDownlineUserIds } from "@/lib/org-chart";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { PEOPLE_ONLY } from "@/lib/people";
import { workspaceClock } from "@/lib/time/workspace";
import { dateOnly, eachDay, toKey } from "@/lib/hr/calendar";
import { shiftsFor } from "@/lib/hr/shifts";
import { shiftOrRefusal, type ShiftInput, type ShiftLike } from "@/lib/hr/shift-rules";
import type { ActionResult } from "@/actions/company";

/**
 * Shifts and the roster (owner, 31 Oct 2026: Deskzo People as a complete HRMS — Kredily's shifts and rosters).
 *
 * HR (`hr.manage`) sets up the shifts — times, grace, the week's days off; a night shift ends the next morning — gives
 * people a standing shift from a day, and changes single days on the roster: another shift, or a week off. Attendance
 * then measures each day against that day's shift (src/lib/hr/shift-rules.ts). Everybody sees their own week, and a
 * manager their team's.
 */

const DAY_ISO = /^\d{4}-\d{2}-\d{2}$/;
const PAGE = "/people/shifts";

const SHIFT_SELECT = { id: true, name: true, code: true, startMinute: true, endMinute: true, graceMinutes: true, weekOffs: true, archived: true } as const;
export type ShiftRow = ShiftLike & { archived: boolean; people: number };

export type RosterCell = { date: string; code: string | null; shiftId: string | null; weekOff: boolean; source: "roster" | "assigned" | "default" };
export type RosterRow = { userId: string; name: string; department: string | null; standing: { shiftId: string; code: string; fromDate: string } | null; days: RosterCell[] };

/** The Monday on or before a day. */
function weekStart(day: Date): Date {
  return new Date(day.getTime() - ((day.getUTCDay() + 6) % 7) * 86_400_000);
}

/** People › Shifts & roster: the shifts, and a week of the roster — everybody's for HR, a manager's team, or one's own. */
export async function shiftsPage(params: { week?: string; departmentId?: string }) {
  const user = await requireModuleAccess("hr");
  const canEdit = await hasEffectivePermission(user.id, "hr.manage");
  const clock = await workspaceClock();
  const today = clock.calendarDate(new Date());
  const from = weekStart(params.week && DAY_ISO.test(params.week) ? dateOnly(params.week) : today);
  const to = new Date(from.getTime() + 6 * 86_400_000);
  const scope = canEdit ? null : [user.id, ...(await getDownlineUserIds(user.id))];

  const [shifts, people, departments] = await Promise.all([
    db.shift.findMany({ orderBy: [{ archived: "asc" }, { startMinute: "asc" }], select: { ...SHIFT_SELECT, _count: { select: { assignments: true } } } }),
    db.user.findMany({
      where: {
        ...PEOPLE_ONLY,
        active: true,
        ...(scope ? { id: { in: scope } } : {}),
        ...(params.departmentId ? { departmentId: params.departmentId } : {}),
        OR: [{ employeeProfile: { is: null } }, { employeeProfile: { exitedOn: null } }],
      },
      orderBy: { name: "asc" },
      select: { id: true, name: true, department: { select: { name: true } } },
    }),
    db.department.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const ids = people.map((p) => p.id);
  const [shiftOf, standing] = await Promise.all([
    shiftsFor(ids, from, to),
    db.shiftAssignment.findMany({ where: { userId: { in: ids }, fromDate: { lte: to } }, orderBy: { fromDate: "desc" }, select: { userId: true, fromDate: true, shift: { select: { id: true, code: true } } } }),
  ]);
  const latest = new Map<string, (typeof standing)[number]>();
  for (const a of standing) if (!latest.has(a.userId)) latest.set(a.userId, a);
  const days = eachDay(from, to);

  const rows: RosterRow[] = people.map((p) => {
    const s = latest.get(p.id);
    return {
      userId: p.id,
      name: p.name,
      department: p.department?.name ?? null,
      standing: s ? { shiftId: s.shift.id, code: s.shift.code, fromDate: toKey(s.fromDate) } : null,
      days: days.map((day) => {
        const d = shiftOf(p.id, day);
        return { date: toKey(day), code: d.shift?.code ?? null, shiftId: d.shift?.id ?? null, weekOff: d.weekOff, source: d.source };
      }),
    };
  });

  return toPlain({
    canEdit,
    shifts: shifts.map(({ _count, ...s }) => ({ ...s, people: _count.assignments })) as ShiftRow[],
    week: { from: toKey(from), days: days.map(toKey), today: toKey(today), previous: toKey(new Date(from.getTime() - 7 * 86_400_000)), next: toKey(new Date(from.getTime() + 7 * 86_400_000)) },
    rows,
    departments: canEdit ? departments : [],
  });
}

async function requireHr() {
  const user = await requireModuleAccess("hr");
  return (await hasEffectivePermission(user.id, "hr.manage")) ? user : null;
}

export async function saveShift(input: ShiftInput & { id?: string }): Promise<ActionResult<{ id: string }>> {
  const user = await requireHr();
  if (!user) return { ok: false, error: "Only HR can set up shifts." };
  const parsed = shiftOrRefusal(input);
  if (!parsed.ok) return parsed;
  const clash = await db.shift.findFirst({ where: { code: parsed.shift.code, ...(input.id ? { id: { not: String(input.id) } } : {}) }, select: { name: true } });
  if (clash) return { ok: false, error: `The code ${parsed.shift.code} is ${clash.name}'s already.` };
  const saved = input.id
    ? await db.shift.update({ where: { id: String(input.id) }, data: parsed.shift, select: { id: true } })
    : await db.shift.create({ data: parsed.shift, select: { id: true } });
  await recordAudit({ userId: user.id, action: input.id ? "UPDATE" : "CREATE", entityType: "Shift", entityId: saved.id, entityLabel: `Shift ${parsed.shift.name} (${parsed.shift.code})` });
  revalidatePath(PAGE);
  revalidatePath("/people/attendance");
  return { ok: true, data: { id: saved.id } };
}

/** Retires a shift from the pickers, or brings it back — the days already worked on it keep it. */
export async function archiveShift(id: string, archived: boolean): Promise<ActionResult<null>> {
  const user = await requireHr();
  if (!user) return { ok: false, error: "Only HR can change shifts." };
  const shift = await db.shift.findUnique({ where: { id: String(id ?? "") }, select: { id: true, name: true } });
  if (!shift) return { ok: false, error: "That shift no longer exists." };
  await db.shift.update({ where: { id: shift.id }, data: { archived: !!archived } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Shift", entityId: shift.id, entityLabel: `Shift ${shift.name} ${archived ? "archived" : "brought back"}` });
  revalidatePath(PAGE);
  return { ok: true, data: null };
}

/** Puts people on a standing shift from a day on; a later one for the same day replaces it. */
export async function assignShift(input: { userIds: string[]; shiftId: string; fromDate: string }): Promise<ActionResult<{ assigned: number }>> {
  const user = await requireHr();
  if (!user) return { ok: false, error: "Only HR can assign shifts." };
  const userIds = [...new Set((Array.isArray(input?.userIds) ? input.userIds : []).map(String))];
  if (userIds.length === 0) return { ok: false, error: "Choose who goes on the shift." };
  if (userIds.length > 2000) return { ok: false, error: "That's too many at once — 2,000 people at most." };
  if (!DAY_ISO.test(String(input.fromDate ?? ""))) return { ok: false, error: "Choose the day it starts from." };
  const shift = await db.shift.findUnique({ where: { id: String(input.shiftId ?? "") }, select: { id: true, name: true, archived: true } });
  if (!shift || shift.archived) return { ok: false, error: "Choose a shift in use." };
  const fromDate = dateOnly(input.fromDate);
  const known = await db.user.count({ where: { id: { in: userIds }, ...PEOPLE_ONLY } });
  if (known !== userIds.length) return { ok: false, error: "Somebody chosen isn't one of your people." };
  await db.$transaction(async (tx) => {
    for (const userId of userIds) {
      await tx.shiftAssignment.upsert({
        where: { userId_fromDate: { userId, fromDate } },
        create: { userId, shiftId: shift.id, fromDate, assignedById: user.id },
        update: { shiftId: shift.id, assignedById: user.id },
      });
    }
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Shift", entityId: shift.id, entityLabel: `${userIds.length} people on ${shift.name} from ${input.fromDate}` });
  revalidatePath(PAGE);
  revalidatePath("/people/attendance");
  return { ok: true, data: { assigned: userIds.length } };
}

/**
 * One day of somebody's roster: a shift's id, "OFF" for a week off, or "" to go back to their standing shift.
 */
export async function setRosterDay(input: { userId: string; date: string; value: string }): Promise<ActionResult<null>> {
  const user = await requireHr();
  if (!user) return { ok: false, error: "Only HR can change the roster." };
  const userId = String(input?.userId ?? "");
  if (!DAY_ISO.test(String(input.date ?? ""))) return { ok: false, error: "Choose the day." };
  const date = dateOnly(input.date);
  const value = String(input.value ?? "");
  const person = await db.user.findFirst({ where: { id: userId, ...PEOPLE_ONLY }, select: { name: true } });
  if (!person) return { ok: false, error: "That person isn't one of your people." };

  if (value === "") {
    await db.rosterDay.deleteMany({ where: { userId, date } });
  } else {
    let shiftId: string | null = null;
    if (value !== "OFF") {
      const shift = await db.shift.findUnique({ where: { id: value }, select: { id: true, archived: true } });
      if (!shift || shift.archived) return { ok: false, error: "Choose a shift in use." };
      shiftId = shift.id;
    }
    await db.rosterDay.upsert({ where: { userId_date: { userId, date } }, create: { userId, date, shiftId, setById: user.id }, update: { shiftId, setById: user.id } });
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "RosterDay", entityId: userId, entityLabel: `${person.name}'s roster for ${input.date}: ${value === "" ? "as assigned" : value === "OFF" ? "week off" : "another shift"}` });
  revalidatePath(PAGE);
  revalidatePath("/people/attendance");
  return { ok: true, data: null };
}
