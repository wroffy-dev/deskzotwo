"use server";

import { revalidatePath } from "next/cache";
import { tooLong } from "@/lib/validation/text";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { toPlain } from "@/lib/serialize";
import { recordAudit } from "@/lib/audit";
import { recordApproval } from "@/lib/approvals/log";
import { notifyUser } from "@/lib/notify";
import { hasEffectivePermission } from "@/actions/permission";
import { getDownlineUserIds } from "@/lib/org-chart";
import { dateOnly, toKey } from "@/lib/hr/calendar";
import { payrollLockRefusal } from "@/lib/hr/payroll-lock";
import { refuseWhileViewingAs } from "@/lib/session";
import { attendanceStatusValues } from "@/lib/validation/hr";
import type { ActionResult } from "@/actions/company";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Asking for a day of your own attendance to be corrected.
 *
 * The whole point is that raising one changes nothing. Attendance drives loss of pay, so an
 * employee editing their own would be an employee editing their own salary — the request is the
 * self-service part, and the decision stays with a manager or HR exactly as it did before.
 */

const regularisationSchema = z
  .object({
    date: z.string().max(100, tooLong(100)).min(1, "Pick the day."),
    requestedStatus: z.enum(attendanceStatusValues),
    checkIn: z.string().trim().max(100, tooLong(100)).optional().or(z.literal("")),
    checkOut: z.string().trim().max(100, tooLong(100)).optional().or(z.literal("")),
    reason: z.string().trim().max(5000, tooLong(5000)).min(3, "Say what happened — the approver has to decide on something."),
  })
  .superRefine((val, ctx) => {
    if (val.checkIn && val.checkOut && val.checkOut <= val.checkIn) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: "Check-out is before check-in.", path: ["checkOut"] });
    }
  });

const decisionSchema = z.object({
  id: z.string().max(100, tooLong(100)).min(1),
  approve: z.boolean(),
  note: z.string().trim().max(300).optional().or(z.literal("")),
});

const ON_LEAVE_REFUSAL = "A day off is asked for with a leave application, so it comes off a balance — not as an attendance correction.";

async function canDecide(deciderId: string, requesterId: string) {
  // Never your own, whatever else is true — the same rule leave uses.
  if (deciderId === requesterId) return false;
  if (await hasEffectivePermission(deciderId, "hr.manage")) return true;
  if (await hasEffectivePermission(deciderId, "hr.approveLeave")) return true;
  return (await getDownlineUserIds(deciderId)).includes(requesterId);
}

const selectShape = {
  id: true,
  date: true,
  requestedStatus: true,
  requestedCheckIn: true,
  requestedCheckOut: true,
  reason: true,
  status: true,
  decidedAt: true,
  decisionNote: true,
  createdAt: true,
  user: { select: { id: true, name: true } },
  approver: { select: { id: true, name: true } },
} satisfies Prisma.AttendanceRegularisationSelect;

export async function requestRegularisation(input: unknown): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleAccess("hr");
  const parsed = regularisationSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const data = parsed.data;

  // The workspace's today, not UTC's: before 05:30 in India, UTC's still said yesterday.
  const clock = await workspaceClock();
  const date = dateOnly(data.date);
  if (date > clock.calendarDate(new Date())) {
    return { ok: false, error: "That day hasn't happened yet." };
  }
  // Security audit, 11 Nov 2026 (SEC-44): a correction to "on leave" was a paid day with no leave taken off any
  // balance. Leave goes through a leave application; and a month whose payroll is run isn't corrected here.
  if (data.requestedStatus === "ON_LEAVE") return { ok: false, error: ON_LEAVE_REFUSAL };
  const locked = await payrollLockRefusal(date);
  if (locked) return { ok: false, error: locked };

  // One open request per day. A second would give two approvers the same decision to make, and the
  // loser's answer would silently vanish.
  const open = await db.attendanceRegularisation.findFirst({
    where: { userId: user.id, date, status: "PENDING" },
    select: { id: true },
  });
  if (open) return { ok: false, error: "You already have a request awaiting a decision for that day." };

  const existing = await db.attendanceDay.findUnique({
    where: { userId_date: { userId: user.id, date } },
    select: { leaveRequestId: true },
  });
  if (existing?.leaveRequestId) {
    return { ok: false, error: "That day is approved leave. Withdraw the leave instead, or ask HR to correct it." };
  }

  // The times typed are the workspace's times on that day — read in the server's zone (UTC) they came
  // back shifted by the workspace's offset.
  const requestedCheckIn = data.checkIn ? clock.parseInput(`${data.date}T${data.checkIn}`) : null;
  const requestedCheckOut = data.checkOut ? clock.parseInput(`${data.date}T${data.checkOut}`) : null;
  if ((data.checkIn && !requestedCheckIn) || (data.checkOut && !requestedCheckOut)) {
    return { ok: false, error: "Enter the times as hh:mm." };
  }

  const me = await db.user.findUnique({ where: { id: user.id }, select: { managerId: true, name: true } });

  const created = await db.attendanceRegularisation.create({
    data: {
      userId: user.id,
      date,
      requestedStatus: data.requestedStatus,
      requestedCheckIn,
      requestedCheckOut,
      reason: data.reason,
      approverId: me?.managerId ?? null,
    },
    select: { id: true },
  });

  if (me?.managerId) {
    await notifyUser({
      userId: me.managerId,
      type: "REGULARISATION_REQUESTED",
      title: "Attendance correction requested",
      message: `${me.name} has asked for ${toKey(date)} to be marked ${data.requestedStatus.toLowerCase().replaceAll("_", " ")}.`,
      link: "/people/me",
    });
  }

  await recordAudit({
    userId: user.id,
    action: "CREATE",
    entityType: "AttendanceRegularisation",
    entityId: created.id,
    entityLabel: `Asked for ${toKey(date)} to be marked ${data.requestedStatus.toLowerCase().replaceAll("_", " ")}`,
  });
  revalidatePath("/people/attendance");
  revalidatePath("/people/me");
  return { ok: true, data: created };
}

export async function decideRegularisation(input: unknown): Promise<ActionResult<null>> {
  const user = await requireModuleUser("hr");
  // Security audit, 11 Nov 2026 (SEC-19): "never your own" compared the borrowed person while viewing as somebody.
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const parsed = decisionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  const { id, approve, note } = parsed.data;

  const request = await db.attendanceRegularisation.findUnique({
    where: { id },
    include: { user: { select: { id: true, name: true } } },
  });
  if (!request) return { ok: false, error: "That request no longer exists." };
  if (request.status !== "PENDING") return { ok: false, error: `It was already ${request.status.toLowerCase()}.` };
  if (!(await canDecide(user.id, request.userId))) return { ok: false, error: "You can't decide this request." };
  // SEC-44: one raised before these rules can still be rejected, never approved into a paid day or a run month.
  if (approve) {
    if (request.requestedStatus === "ON_LEAVE") return { ok: false, error: ON_LEAVE_REFUSAL };
    const locked = await payrollLockRefusal(request.date);
    if (locked) return { ok: false, error: locked };
  }

  const workedMinutes =
    request.requestedCheckIn && request.requestedCheckOut
      ? Math.max(
          0,
          Math.round((request.requestedCheckOut.getTime() - request.requestedCheckIn.getTime()) / 60000),
        )
      : null;

  const claimed = await db.$transaction(async (tx) => {
    // SEC-31: decided only while still pending, so two approvers at once can't both write the day.
    const claim = await tx.attendanceRegularisation.updateMany({
      where: { id, status: "PENDING" },
      data: { status: approve ? "APPROVED" : "REJECTED", approverId: user.id, decidedAt: new Date(), decisionNote: note?.trim() || null },
    });
    if (claim.count === 0) return false;
    for (const op of (approve
      ? [
          tx.attendanceDay.upsert({
            where: { userId_date: { userId: request.userId, date: request.date } },
            create: {
              userId: request.userId,
              date: request.date,
              status: request.requestedStatus,
              checkInAt: request.requestedCheckIn,
              checkOutAt: request.requestedCheckOut,
              workedMinutes,
              note: `Corrected: ${request.reason}`,
              regularisedById: user.id,
              regularisedAt: new Date(),
            },
            update: {
              status: request.requestedStatus,
              checkInAt: request.requestedCheckIn,
              checkOutAt: request.requestedCheckOut,
              workedMinutes,
              note: `Corrected: ${request.reason}`,
              regularisedById: user.id,
              regularisedAt: new Date(),
            },
          }),
        ]
      : [])) await op;
    return true;
  });
  if (!claimed) return { ok: false, error: "Somebody decided it a moment ago." };

  await notifyUser({
    userId: request.userId,
    type: "REGULARISATION_DECIDED",
    title: `Attendance correction ${approve ? "approved" : "rejected"}`,
    message: `${user.name} ${approve ? "approved" : "rejected"} your correction for ${toKey(request.date)}${note ? `: ${note}` : "."}`,
    link: "/people/me",
  });

  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "AttendanceRegularisation",
    entityId: id,
    entityLabel: `${approve ? "Approved" : "Rejected"} ${request.user.name}'s correction for ${toKey(request.date)}`,
  });
  await recordApproval({
    kind: "regularisation",
    decision: approve ? "APPROVED" : "REJECTED",
    recordId: id,
    label: `Attendance for ${toKey(request.date)} — ${request.user.name}`,
    note,
    requestedById: request.userId,
    decidedById: user.id,
  });
  revalidatePath("/people/attendance");
  revalidatePath("/people/me");
  return { ok: true, data: null };
}

export async function cancelRegularisation(id: string): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("hr");
  const request = await db.attendanceRegularisation.findUnique({ where: { id }, select: { userId: true, status: true } });
  if (!request) return { ok: false, error: "That request no longer exists." };
  if (request.userId !== user.id) return { ok: false, error: "That isn't your request." };
  if (request.status !== "PENDING") return { ok: false, error: "Only a request still awaiting a decision can be withdrawn." };

  await db.attendanceRegularisation.update({ where: { id }, data: { status: "CANCELLED" } });
  revalidatePath("/people/me");
  return { ok: true, data: null };
}

export async function myRegularisations() {
  const user = await requireModuleAccess("hr");
  return toPlain(
    await db.attendanceRegularisation.findMany({
      where: { userId: user.id },
      orderBy: { date: "desc" },
      take: 30,
      select: selectShape,
    }),
  );
}

/** Corrections waiting on this user to decide. */
export async function regularisationQueue() {
  const user = await requireModuleUser("hr");
  const wide =
    (await hasEffectivePermission(user.id, "hr.manage")) || (await hasEffectivePermission(user.id, "hr.approveLeave"));
  const downline = await getDownlineUserIds(user.id);
  const scope = wide ? { userId: { not: user.id } } : { userId: { in: downline } };

  return toPlain(
    await db.attendanceRegularisation.findMany({
      where: { ...scope, status: "PENDING" },
      orderBy: { date: "asc" },
      select: selectShape,
    }),
  );
}
