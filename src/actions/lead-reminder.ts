"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { refuseWhileViewingAs } from "@/lib/session";
import { requireModuleUser } from "@/lib/modules-access";
import { leadAccess } from "@/lib/authz/access";
import { recordAudit } from "@/lib/audit";
import { calendarDayRange, formatCalendarDay } from "@/lib/time/zone";
import { formatLeadId } from "@/lib/order-id";
import { leadPath } from "@/lib/record-links";
import { leadReminderTitle, myLeadRemindersFor } from "@/lib/lead-reminders";
import { listLeadMasker, maskLeadTitle } from "@/lib/leads/masking";
import type { ActionResult } from "@/actions/company";

/** "Remind me" on a lead (src/lib/lead-reminders.ts): set, change or clear it — only on a lead this person can see, always for themselves. */

const NOTE_MAX = 1000;

/**
 * The lead, if this person can see it — its title as they see it in a list (owner, 5 Nov 2026 — Phase 3 masking fixes,
 * audit H.4.3). The reminder's task and the audit line copy the title, and a copy outlives the screen it was made on:
 * as stored it showed in My tasks, the bell and the log in full to somebody who sees it masked. So the copy is what its
 * author sees, by the list's answers and not today's "Show" (a reveal is for the day; the task isn't). Somebody who
 * sees the title in the clear gets it as before; the task names its lead by number, and links to it, either way.
 */
async function reachableLead(userId: string, leadId: string) {
  const lead = await db.lead.findFirst({
    where: { AND: [{ id: String(leadId) }, await leadAccess(userId, "view")] },
    select: { id: true, leadSeq: true, title: true, companyId: true },
  });
  return lead && { ...lead, title: maskLeadTitle(await listLeadMasker(userId), lead.title) };
}

export async function setLeadReminder(input: { leadId: string; remindOn: string; note?: string | null }): Promise<ActionResult<{ remindOn: string }>> {
  const user = await requireModuleUser("leads");
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  const lead = await reachableLead(user.id, input?.leadId);
  if (!lead) return { ok: false, error: "That lead isn't there." };
  const day = calendarDayRange(String(input?.remindOn ?? ""), null)?.gte ?? null;
  if (!day) return { ok: false, error: "Pick the day to be reminded." };
  const note = String(input?.note ?? "").trim().slice(0, NOTE_MAX) || null;

  // One open reminder a person a lead: a second "Remind me" moves the first.
  const existing = (await myLeadRemindersFor(user.id, [lead.id])).get(lead.id);
  const title = leadReminderTitle(lead.leadSeq, lead.title);
  if (existing) {
    await db.task.update({ where: { id: existing.taskId }, data: { dueDate: day, description: note, title } });
  } else {
    await db.task.create({ data: { title, description: note, dueDate: day, leadId: lead.id, companyId: lead.companyId, assignedToUserId: user.id, createdByUserId: user.id } });
  }
  await recordAudit({
    userId: user.id,
    action: existing ? "UPDATE" : "CREATE",
    entityType: "Task",
    entityId: lead.id,
    entityLabel: `Reminder on ${formatLeadId(lead.leadSeq)} “${lead.title}”: ${formatCalendarDay(day)}${note ? ` — ${note}` : ""}`.slice(0, 500),
    subject: { companyId: lead.companyId, leadId: lead.id },
  });
  revalidatePath("/leads");
  revalidatePath(leadPath(lead.leadSeq));
  revalidatePath("/tasks");
  return { ok: true, data: { remindOn: day.toISOString().slice(0, 10) } };
}

/** Done with it: the reminder's task is ticked off, so it stops ringing. */
export async function clearLeadReminder(leadId: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("leads");
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  const lead = await reachableLead(user.id, leadId);
  if (!lead) return { ok: false, error: "That lead isn't there." };
  const existing = (await myLeadRemindersFor(user.id, [lead.id])).get(lead.id);
  if (!existing) return { ok: true, data: null };
  await db.task.update({ where: { id: existing.taskId }, data: { done: true, doneAt: new Date(), status: "DONE" } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Task", entityId: lead.id, entityLabel: `Reminder on ${formatLeadId(lead.leadSeq)} “${lead.title}”: done`, subject: { companyId: lead.companyId, leadId: lead.id } });
  revalidatePath("/leads");
  revalidatePath(leadPath(lead.leadSeq));
  revalidatePath("/tasks");
  return { ok: true, data: null };
}
