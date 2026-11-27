"use server";

import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { getDownlineUserIds } from "@/lib/org-chart";
import { recordAudit } from "@/lib/audit";
import { recordApproval } from "@/lib/approvals/log";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/not-migrated";
import { closedDates, dateOnly, monthRange, toKey } from "@/lib/hr/calendar";
import { workspaceClock } from "@/lib/time/workspace";
import { officeHours } from "@/lib/hr/office-hours";
import { shiftsFor } from "@/lib/hr/shifts";
import { payrollLockRefusal } from "@/lib/hr/payroll-lock";
import { ensureBalance } from "@/lib/hr/leave-balance";
import { leaveYearOfDay } from "@/lib/hr/leave-year-server";
import { RH_CODE, isRestrictedHolidayType } from "@/lib/hr/restricted-holiday";
import { DEFAULT_SHORT_LEAVE_POLICY, draftOrRefusal, limitsRefusal, spanWords, type ShortLeavePolicy } from "@/lib/hr/short-leave-rules";
import { timeOfMinute } from "@/lib/hr/office-hours-rules";
import type { ActionResult } from "@/actions/company";

/**
 * What HR records on one person's day from the attendance grid besides its status (owner, 26 Nov 2026 — "RH option is
 * not there … and short leave also"): a restricted holiday, taken from their RH allowance, and a short leave by the hour.
 * Both are written as decided by whoever records them — HR, or a manager for the people under them, the same people who
 * may mark the day — with the rules an employee's own request meets: RH only on a day marked Restricted and only while
 * some is left; a short leave in its length and monthly count. A month whose payroll is run is refused, as marking is.
 */

const day = (input: unknown) => {
  const text = String(input ?? "");
  return /^\d{4}-\d{2}-\d{2}$/.test(text) && new Date(`${text}T00:00:00Z`).toISOString().slice(0, 10) === text ? text : null;
};

/** As marking a day: HR, or a manager for the people under them — never one's own. */
async function mayRecordFor(actorId: string, targetId: string) {
  if (actorId === targetId) return false;
  if (await hasEffectivePermission(actorId, "hr.manage")) return true;
  return (await getDownlineUserIds(actorId)).includes(targetId);
}

async function checked(input: { userId?: unknown; date?: unknown }) {
  const user = await requireModuleAccess("hr");
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false as const, error: viewingAs };
  const date = day(input.date);
  const userId = String(input.userId ?? "");
  if (!date || !userId) return { ok: false as const, error: "Pick the day." };
  if (!(await mayRecordFor(user.id, userId))) return { ok: false as const, error: "You can't record this for them." };
  const person = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, active: true } });
  if (!person) return { ok: false as const, error: "That person isn't here any more." };
  return { ok: true as const, user, person, date };
}

async function shortLeavePolicy(): Promise<ShortLeavePolicy | null> {
  try {
    const row = await db.shortLeavePolicy.findUnique({ where: { id: "global" } });
    return row ? { maxMinutes: row.maxMinutes, perMonth: row.perMonth } : DEFAULT_SHORT_LEAVE_POLICY;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

export type DayExtras = {
  /** The day is marked Restricted on the holiday list: its name. */
  restricted: string | null;
  /** The RH leave type and what's left of it, or why there's none to take. */
  rh: { typeId: string; name: string; left: number } | { missing: string } | null;
  /** RH already taken that day. */
  rhTaken: boolean;
  /** Their short leave that day, if any. */
  shortLeave: { id: string; from: string; to: string; words: string; reason: string; approved: boolean } | null;
  /** Whether short leave is offered at all here. */
  shortLeaveOn: boolean;
};

/** What the day's dialog offers beside its status. */
export async function dayExtras(input: { userId: string; date: string }): Promise<ActionResult<DayExtras>> {
  const c = await checked(input);
  if (!c.ok) return c;
  const d = dateOnly(c.date);
  const [holidays, type, taken, short, rules] = await Promise.all([
    db.holiday.findMany({ where: { date: d }, select: { name: true, optional: true } }),
    db.leaveType.findFirst({ where: { code: { equals: RH_CODE, mode: "insensitive" }, active: true }, select: { id: true, name: true, paid: true } }),
    db.leaveRequest.findFirst({ where: { userId: c.person.id, status: "APPROVED", fromDate: { lte: d }, toDate: { gte: d }, type: { code: { equals: RH_CODE, mode: "insensitive" } } }, select: { id: true } }),
    db.shortLeaveRequest
      .findFirst({ where: { userId: c.person.id, date: d, status: { in: ["PENDING", "APPROVED"] } }, select: { id: true, fromMinute: true, toMinute: true, reason: true, status: true } })
      .catch((err) => (notMigratedYet(err) ? null : Promise.reject(err))),
    shortLeavePolicy(),
  ]);
  const restricted = holidays.find((h) => h.optional)?.name ?? null;
  let rh: DayExtras["rh"] = null;
  if (restricted) {
    if (!type) rh = { missing: `There's no leave type with the code ${RH_CODE}. Add one in Leave settings, with how many a year, and it's offered here.` };
    else {
      const fy = await leaveYearOfDay(d);
      const balance = await ensureBalance(c.person.id, type.id, fy, (await workspaceClock()).calendarDate(new Date()));
      const pending = await db.leaveRequest.aggregate({ where: { userId: c.person.id, typeId: type.id, status: "PENDING" }, _sum: { days: true } });
      const n = (v: Prisma.Decimal | number | null | undefined) => Number(v ?? 0);
      const left = balance ? n(balance.opening) + n(balance.credited) + n(balance.adjustment) - n(balance.used) - n(pending._sum.days) : 0;
      rh = { typeId: type.id, name: type.name, left: Math.round(left * 100) / 100 };
    }
  }
  return {
    ok: true,
    data: {
      restricted,
      rh,
      rhTaken: !!taken,
      shortLeave: short
        ? { id: short.id, from: timeOfMinute(short.fromMinute), to: timeOfMinute(short.toMinute), words: spanWords(short), reason: short.reason, approved: short.status === "APPROVED" }
        : null,
      shortLeaveOn: !!rules && rules.perMonth > 0,
    },
  };
}

/**
 * A restricted holiday taken, recorded by HR: one day of their RH allowance, approved as it is written, and the day
 * marked as leave from it. Only on a day marked Restricted, while some is left, and with no other leave that day.
 */
export async function recordRestrictedHoliday(input: { userId: string; date: string; note?: string }): Promise<ActionResult<null>> {
  const c = await checked(input);
  if (!c.ok) return c;
  const d = dateOnly(c.date);
  const [holiday, type] = await Promise.all([
    db.holiday.findFirst({ where: { date: d, optional: true }, select: { name: true } }),
    db.leaveType.findFirst({ where: { code: { equals: RH_CODE, mode: "insensitive" }, active: true } }),
  ]);
  if (!holiday) return { ok: false, error: `${c.date} isn't a restricted holiday on the holiday list, so RH can't be taken on it.` };
  if (!type || !isRestrictedHolidayType(type)) return { ok: false, error: `There's no leave type with the code ${RH_CODE}. Add one in Leave settings first.` };
  const locked = await payrollLockRefusal(d);
  if (locked) return { ok: false, error: locked };
  const clash = await db.leaveRequest.findFirst({
    where: { userId: c.person.id, status: { in: ["PENDING", "APPROVED"] }, fromDate: { lte: d }, toDate: { gte: d } },
    select: { status: true },
  });
  if (clash) return { ok: false, error: `${c.person.name} already has ${clash.status.toLowerCase()} leave that day. Sort that out under Leave first.` };

  const fy = await leaveYearOfDay(d);
  const today = (await workspaceClock()).calendarDate(new Date());
  const balance = await ensureBalance(c.person.id, type.id, fy, today);
  const pending = await db.leaveRequest.aggregate({ where: { userId: c.person.id, typeId: type.id, status: "PENDING" }, _sum: { days: true } });
  const n = (v: Prisma.Decimal | number | null | undefined) => Number(v ?? 0);
  const left = balance ? n(balance.opening) + n(balance.credited) + n(balance.adjustment) - n(balance.used) - n(pending._sum.days) : 0;
  if (type.paid && left < 1) return { ok: false, error: `${c.person.name} has no ${type.name} left this year${n(pending._sum.days) ? " (some is waiting for approval)" : ""}.` };

  const note = String(input.note ?? "").trim().slice(0, 500);
  const reason = note || `${holiday.name} — recorded by ${c.user.name}`;
  const made = await db.$transaction(async (tx) => {
    // Under one lock per person, so two at once can't both take the last one.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deskzo:leave:${c.person.id}`}))`;
    const again = await tx.leaveRequest.findFirst({ where: { userId: c.person.id, status: { in: ["PENDING", "APPROVED"] }, fromDate: { lte: d }, toDate: { gte: d } }, select: { id: true } });
    if (again) return null;
    const request = await tx.leaveRequest.create({
      data: { userId: c.person.id, typeId: type.id, fromDate: d, toDate: d, days: new Prisma.Decimal(1), reason, status: "APPROVED", approverId: c.user.id, decidedAt: new Date(), decisionNote: "Recorded from the attendance grid" },
      select: { id: true },
    });
    if (type.paid) {
      await tx.leaveBalance.update({ where: { userId_typeId_year: { userId: c.person.id, typeId: type.id, year: fy } }, data: { used: { increment: new Prisma.Decimal(1) } } });
    }
    await tx.attendanceDay.upsert({
      where: { userId_date: { userId: c.person.id, date: d } },
      create: { userId: c.person.id, date: d, status: "ON_LEAVE", leaveRequestId: request.id, note: note || null },
      update: { status: "ON_LEAVE", leaveRequestId: request.id, ...(note ? { note } : {}) },
    });
    return request;
  });
  if (!made) return { ok: false, error: `${c.person.name} got leave on that day a moment ago. Look again.` };

  const words = `${type.name} on ${c.date} (${holiday.name})`;
  await notifyUser({ userId: c.person.id, type: "LEAVE_DECIDED", title: "Restricted holiday recorded", message: `${c.user.name} recorded ${words} for you.`, link: "/people/leave" });
  await recordAudit({ userId: c.user.id, action: "CREATE", entityType: "LeaveRequest", entityId: made.id, entityLabel: `${type.code} ${c.date} for ${c.person.name}, recorded from attendance` });
  await recordApproval({ kind: "leave", decision: "APPROVED", recordId: made.id, label: `1 day(s) ${type.code} — ${c.person.name}`, note: "Recorded from the attendance grid", requestedById: c.person.id, decidedById: c.user.id });
  revalidatePath("/people/attendance");
  revalidatePath("/people/leave");
  return { ok: true, data: null };
}

/**
 * A short leave recorded by HR: approved as it is written, inside the company's length and monthly count, on a working
 * day with no leave — the employee's own rules, bar asking for a past month (payroll's lock decides that).
 */
export async function recordShortLeave(input: { userId: string; date: string; from: string; to: string; reason: string }): Promise<ActionResult<null>> {
  const c = await checked(input);
  if (!c.ok) return c;
  const rules = await shortLeavePolicy();
  if (!rules) return { ok: false, error: "Short leave isn't set up in this workspace yet." };
  const clock = await workspaceClock();
  const today = clock.today();
  const parsed = draftOrRefusal({ date: c.date, from: input.from, to: input.to, reason: input.reason }, { today, policy: rules, hours: await officeHours(), byHr: true });
  if (!parsed.ok) return parsed;
  const { fromMinute, toMinute, reason } = parsed.value;
  const d = dateOnly(c.date);
  const locked = await payrollLockRefusal(d);
  if (locked) return { ok: false, error: locked };

  const [holidays, leave, shiftOf] = await Promise.all([
    db.holiday.findMany({ where: { date: d }, select: { date: true, optional: true } }),
    db.leaveRequest.findFirst({ where: { userId: c.person.id, status: { in: ["PENDING", "APPROVED"] }, fromDate: { lte: d }, toDate: { gte: d } }, select: { id: true } }),
    shiftsFor([c.person.id], d, d),
  ]);
  const offDay = shiftOf(c.person.id, d).weekOff ? ("week off" as const) : closedDates(holidays).has(c.date) ? ("holiday" as const) : null;
  const { from, to } = monthRange(d.getUTCFullYear(), d.getUTCMonth() + 1);

  const outcome = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deskzo:short-leave:${c.person.id}`}))`;
    const [sameDay, usedInMonth] = await Promise.all([
      tx.shortLeaveRequest.findFirst({ where: { userId: c.person.id, date: d, status: { in: ["PENDING", "APPROVED"] } }, select: { id: true } }),
      tx.shortLeaveRequest.count({ where: { userId: c.person.id, status: { in: ["PENDING", "APPROVED"] }, date: { gte: from, lte: to } } }),
    ]);
    const refusal = limitsRefusal({ date: c.date, today, perMonth: rules.perMonth, offDay, onLeave: !!leave, sameDay: !!sameDay, usedInMonth });
    if (refusal) return { ok: false as const, error: refusal.replace(/^You've had/, "They've had").replace(/^You already/, "They already") };
    const made = await tx.shortLeaveRequest.create({
      data: { userId: c.person.id, date: d, fromMinute, toMinute, reason, status: "APPROVED", approverId: c.user.id, decidedAt: new Date(), decisionNote: "Recorded from the attendance grid" },
      select: { id: true },
    });
    return { ok: true as const, id: made.id };
  });
  if (!outcome.ok) return outcome;

  const words = `${clock.date(d)}, ${spanWords({ fromMinute, toMinute })}`;
  await notifyUser({ userId: c.person.id, type: "LEAVE_DECIDED", title: "Short leave recorded", message: `${c.user.name} recorded a short leave for you on ${words}.`, link: "/people/leave#short-leave" });
  await recordAudit({ userId: c.user.id, action: "CREATE", entityType: "ShortLeaveRequest", entityId: outcome.id, entityLabel: `Short leave ${words} for ${c.person.name}, recorded from attendance` });
  await recordApproval({ kind: "shortLeave", decision: "APPROVED", recordId: outcome.id, label: `Short leave ${words} — ${c.person.name}`, note: "Recorded from the attendance grid", requestedById: c.person.id, decidedById: c.user.id });
  revalidatePath("/people/attendance");
  revalidatePath("/people/leave");
  return { ok: true, data: null };
}

/** Taking a short leave off a day — HR's correction, whatever its state, outside a month whose payroll is run. */
export async function removeShortLeave(input: { userId: string; date: string; id: string }): Promise<ActionResult<null>> {
  const c = await checked(input);
  if (!c.ok) return c;
  const request = await db.shortLeaveRequest.findUnique({ where: { id: String(input.id ?? "") }, select: { id: true, userId: true, date: true, fromMinute: true, toMinute: true, status: true } });
  if (!request || request.userId !== c.person.id || toKey(request.date) !== c.date) return { ok: false, error: "That short leave isn't there any more." };
  const locked = await payrollLockRefusal(request.date);
  if (locked) return { ok: false, error: locked };
  const gone = await db.shortLeaveRequest.updateMany({ where: { id: request.id, status: { in: ["PENDING", "APPROVED"] } }, data: { status: "CANCELLED", cancelledAt: new Date() } });
  if (gone.count === 0) return { ok: false, error: "It was already withdrawn." };
  const clock = await workspaceClock();
  await recordAudit({ userId: c.user.id, action: "UPDATE", entityType: "ShortLeaveRequest", entityId: request.id, entityLabel: `Removed short leave ${clock.date(request.date)}, ${spanWords(request)} for ${c.person.name}` });
  revalidatePath("/people/attendance");
  revalidatePath("/people/leave");
  return { ok: true, data: null };
}
