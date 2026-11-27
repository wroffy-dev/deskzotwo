"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { refuseWhileViewingAs } from "@/lib/session";
import { requireModuleUser } from "@/lib/modules-access";
import { mayAccess } from "@/lib/authz/access";
import { recordAudit } from "@/lib/audit";
import { calendarDayRange, formatCalendarDay } from "@/lib/time/zone";
import { collectionReminderTitle, myCollectionReminder } from "@/lib/collection-reminders";
import type { ActionResult } from "@/actions/company";

/**
 * "Remind me" on a customer who owes money (src/lib/collection-reminders.ts — Receivables' row actions): set it — a day
 * and a note — change it, or clear it. On a customer this person can see, where Receivables is theirs to open; always
 * for themselves.
 */

const NOTE_MAX = 1000;

async function reachableCustomer(userId: string, companyId: string) {
  const id = String(companyId ?? "");
  if (!id || !(await mayAccess(userId, "companies", "view", id))) return null;
  return db.company.findUnique({ where: { id }, select: { id: true, name: true, companySeq: true } });
}

export async function setCollectionReminder(input: { companyId: string; remindOn: string; note?: string | null }): Promise<ActionResult<{ remindOn: string }>> {
  const user = await requireModuleUser("receivables");
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  const company = await reachableCustomer(user.id, input?.companyId);
  if (!company) return { ok: false, error: "That customer isn't there." };
  const day = calendarDayRange(String(input?.remindOn ?? ""), null)?.gte ?? null;
  if (!day) return { ok: false, error: "Pick the day to be reminded." };
  const note = String(input?.note ?? "").trim().slice(0, NOTE_MAX) || null;

  // One open follow-up a person a customer: a second "Remind me" moves the first.
  const existing = await myCollectionReminder(user.id, company.id);
  const title = collectionReminderTitle(company.companySeq, company.name);
  if (existing) await db.task.update({ where: { id: existing.taskId }, data: { dueDate: day, description: note, title } });
  else await db.task.create({ data: { title, description: note, dueDate: day, companyId: company.id, assignedToUserId: user.id, createdByUserId: user.id } });
  await recordAudit({
    userId: user.id,
    action: existing ? "UPDATE" : "CREATE",
    entityType: "Task",
    entityId: company.id,
    entityLabel: `Collection follow-up — ${company.name}: ${formatCalendarDay(day)}${note ? ` — ${note}` : ""}`.slice(0, 500),
    subject: { companyId: company.id },
  });
  revalidatePath("/receivables");
  revalidatePath("/tasks");
  return { ok: true, data: { remindOn: day.toISOString().slice(0, 10) } };
}

/** Done with it: the follow-up's task is ticked off, so it stops ringing. */
export async function clearCollectionReminder(companyId: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("receivables");
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  const company = await reachableCustomer(user.id, companyId);
  if (!company) return { ok: false, error: "That customer isn't there." };
  const existing = await myCollectionReminder(user.id, company.id);
  if (!existing) return { ok: true, data: null };
  await db.task.update({ where: { id: existing.taskId }, data: { done: true, doneAt: new Date(), status: "DONE" } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Task", entityId: company.id, entityLabel: `Collection follow-up — ${company.name}: done`, subject: { companyId: company.id } });
  revalidatePath("/receivables");
  revalidatePath("/tasks");
  return { ok: true, data: null };
}
