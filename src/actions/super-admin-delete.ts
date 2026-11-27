"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { recordAudit } from "@/lib/audit";
import { dateOnly } from "@/lib/hr/calendar";
import { formatLeadId } from "@/lib/order-id";
import type { ActionResult } from "@/actions/company";

/**
 * Deleting a lead or a day's attendance (owner, 27 Oct 2026): the workspace's super admin's alone — the account
 * flag the database keeps to exactly one, read from the database on every call, never while viewing as somebody.
 * No role or permission opens it, so there is no key to grant. Each is written to the audit log.
 *
 *   · **A lead** goes with what is only its own — its activities, tasks, requirements, proposals, notes and
 *     who it was with (the database cascades them). Quotations, calls, visits, expenses, bookings and form
 *     entries raised from it stay, no longer pointing at it.
 *   · **A day** goes with where the person clocked in and out from that day. Refused while approved leave
 *     covers it (cancel the leave instead) and once its month's payroll is locked, so the attendance never
 *     disagrees with a payslip already issued. A biometric terminal's raw punches stay as the machine sent
 *     them; reprocessing them writes the day again.
 */

const REFUSED = "Only the workspace's super admin can delete this.";

/** Whether the person asking may delete leads and attendance: the super admin, as themselves. */
export async function mayDeleteRecords(): Promise<boolean> {
  const user = await requireUser();
  return actingAsSuperAdmin(user.id);
}

export async function deleteLead(leadId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await actingAsSuperAdmin(user.id))) return { ok: false, error: REFUSED };
  if (typeof leadId !== "string" || !leadId) return { ok: false, error: "That lead isn't there." };
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true, leadSeq: true, title: true, companyId: true } });
  if (!lead) return { ok: false, error: "That lead isn't there." };

  await db.lead.delete({ where: { id: lead.id } });
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "Lead",
    entityId: lead.id,
    entityLabel: `Deleted lead ${formatLeadId(lead.leadSeq)} “${lead.title}”`,
    // Gone, so nothing to look up: kept on its company's activity.
    subject: { companyId: lead.companyId, leadId: null },
  });
  revalidatePath("/leads");
  return { ok: true, data: null };
}

export async function deleteAttendanceDay(input: { userId: string; date: string }): Promise<ActionResult<null>> {
  const user = await requireUser();
  if (!(await actingAsSuperAdmin(user.id))) return { ok: false, error: REFUSED };
  const userId = typeof input?.userId === "string" ? input.userId : "";
  const day = typeof input?.date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(input.date) ? input.date : "";
  if (!userId || !day) return { ok: false, error: "Choose a person and a day." };
  const date = dateOnly(day);

  const existing = await db.attendanceDay.findUnique({ where: { userId_date: { userId, date } }, select: { id: true, status: true, leaveRequestId: true } });
  if (!existing) return { ok: false, error: "Nothing is recorded for that day." };
  if (existing.leaveRequestId) return { ok: false, error: "That day is covered by approved leave. Cancel the leave request instead." };
  const [year, month] = day.split("-").map(Number) as [number, number];
  const run = await db.payrollRun.findUnique({ where: { month_year: { month, year } }, select: { status: true } });
  if (run && run.status !== "DRAFT") return { ok: false, error: "That month's payroll is locked, so its attendance stays as the payslips used it." };

  await db.$transaction(async (tx) => {
    await tx.attendanceLocation.deleteMany({ where: { userId, date } });
    await tx.attendanceDay.delete({ where: { id: existing.id } });
  });
  const person = await db.user.findUnique({ where: { id: userId }, select: { name: true } });
  await recordAudit({
    userId: user.id,
    action: "DELETE",
    entityType: "AttendanceDay",
    entityId: `${userId}:${day}`,
    entityLabel: `Deleted ${person?.name ?? "someone"}'s attendance on ${day} (was ${existing.status.toLowerCase().replaceAll("_", " ")})`,
  });
  revalidatePath("/people/attendance");
  return { ok: true, data: null };
}
