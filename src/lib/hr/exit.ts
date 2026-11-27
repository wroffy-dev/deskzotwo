import { revalidatePath } from "next/cache";
import type { ExitType } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { dateOnly, toKey } from "@/lib/hr/calendar";
import { formatCalendarDay } from "@/lib/time/zone";
import { OFFBOARDING_TASKS } from "@/lib/hr/onboarding";
import { accountsChanged } from "@/lib/platform/account-hooks";

/**
 * Recording that somebody leaves — the one way it is done, whether HR records it by hand (recordExit in
 * src/actions/hr.ts) or a resignation is accepted (src/actions/resignation.ts). Not a "use server" file: the actions
 * decide who may, this writes it.
 */

export type ExitInput = { userId: string; exitedOn: string; exitType: ExitType; exitReason: string | null; deactivateLogin: boolean };
type Result = { ok: true } | { ok: false; error: string };

export async function applyExit(actorId: string, data: ExitInput): Promise<Result> {
  const target = await db.user.findUnique({ where: { id: data.userId }, select: { id: true, name: true } });
  if (!target) return { ok: false, error: "That user no longer exists." };

  // An approved settlement paid the last month to the day it was worked out for, and the payroll left
  // that month to it. Moving the day under it would leave the days in between to nobody, or to both.
  const settlement = await db.finalSettlement.findUnique({
    where: { userId: data.userId },
    select: { status: true, lastWorkingDay: true },
  });
  if (settlement && settlement.status !== "DRAFT" && toKey(settlement.lastWorkingDay) !== toKey(data.exitedOn)) {
    return {
      ok: false,
      error:
        settlement.status === "PAID"
          ? `Their full and final settlement has been paid for a last working day of ${formatCalendarDay(settlement.lastWorkingDay)}, so that day can't change now.`
          : `Their full and final settlement is approved for a last working day of ${formatCalendarDay(settlement.lastWorkingDay)}. Put it back to draft first, then change the day and recalculate it.`,
    };
  }

  await db.$transaction(async (tx) => {
    const fields = { exitedOn: dateOnly(data.exitedOn), exitType: data.exitType, exitReason: data.exitReason?.trim() || null };
    await tx.employeeProfile.upsert({ where: { userId: data.userId }, create: { userId: data.userId, ...fields }, update: fields });
    if (data.deactivateLogin) await tx.user.update({ where: { id: data.userId }, data: { active: false } });
  });
  if (data.deactivateLogin) await accountsChanged([data.userId], { revoke: "deactivated", by: `admin:${actorId}` });

  await recordAudit({
    userId: actorId,
    action: "UPDATE",
    entityType: "EmployeeProfile",
    entityId: data.userId,
    entityLabel: `${target.name} marked as exited (${data.exitType.toLowerCase().replaceAll("_", " ")})${data.deactivateLogin ? ", login deactivated" : ""}`,
  });
  // Raised here rather than left to somebody's memory: the first of them is revoking access, and
  // it is due on the last working day. A failure is not worth losing the exit over — the record
  // offers the same button if this did not run.
  await raiseOffboardingTasksFor(actorId, data.userId);

  revalidatePath("/people");
  revalidatePath(`/people/${data.userId}`);
  revalidatePath("/tasks");
  return { ok: true };
}

/** The offboarding tasks for somebody whose exit is recorded — once; dated from their last working day. */
export async function raiseOffboardingTasksFor(actorId: string, userId: string): Promise<{ ok: true; data: { tasks: number } } | { ok: false; error: string }> {
  const person = await db.user.findUnique({
    where: { id: userId },
    select: { name: true, managerId: true, employeeProfile: { select: { exitedOn: true } } },
  });
  if (!person?.employeeProfile?.exitedOn) {
    return { ok: false, error: "Record their exit first — the tasks are dated from the last working day." };
  }

  const existing = await db.task.count({ where: { aboutUserId: userId, hrStage: "OFFBOARDING" } });
  if (existing > 0) return { ok: false, error: "Offboarding tasks have already been raised for them." };

  const lastDay = person.employeeProfile.exitedOn;
  let count = 0;
  for (const template of OFFBOARDING_TASKS) {
    await db.task.create({
      data: {
        title: `${template.title} — ${person.name}`,
        description: template.description,
        dueDate: new Date(lastDay.getTime() + template.dueDayOffset * 86400000),
        assignedToUserId: template.role === "MANAGER" ? (person.managerId ?? actorId) : actorId,
        createdByUserId: actorId,
        aboutUserId: userId,
        hrStage: "OFFBOARDING",
      },
    });
    count += 1;
  }

  await recordAudit({
    userId: actorId,
    action: "CREATE",
    entityType: "Task",
    entityId: userId,
    entityLabel: `Raised ${count} offboarding task(s) for ${person.name}`,
  });
  revalidatePath(`/people/${userId}`);
  revalidatePath("/tasks");
  return { ok: true, data: { tasks: count } };
}
