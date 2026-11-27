import { db } from "@/lib/db";
import { formatLeadId } from "@/lib/order-id";

/**
 * A salesperson's own "Remind me" on a lead (owner, 31 Oct 2026 — as on a renewal, src/lib/renewal-reminders.ts): a
 * task for them on the lead, due the day they pick, with their note, so the bell rings that day and it sits in My
 * tasks. One open reminder a person a lead; the title marks it as one, beside the lead's other tasks.
 */

const PREFIX = "Lead reminder — ";

export const leadReminderTitle = (leadSeq: number, title: string) => `${PREFIX}${formatLeadId(leadSeq)} · ${title}`.slice(0, 200);

export type MyLeadReminder = { taskId: string; remindOn: string | null; note: string | null };

/** This person's open reminders on these leads, by lead id — one query for a page. */
export async function myLeadRemindersFor(userId: string, leadIds: string[]): Promise<Map<string, MyLeadReminder>> {
  const out = new Map<string, MyLeadReminder>();
  if (leadIds.length === 0) return out;
  const tasks = await db.task.findMany({
    where: { assignedToUserId: userId, done: false, leadId: { in: [...new Set(leadIds)] }, title: { startsWith: PREFIX } },
    orderBy: { createdAt: "desc" },
    select: { id: true, leadId: true, dueDate: true, description: true },
  });
  for (const t of tasks) {
    if (t.leadId && !out.has(t.leadId)) out.set(t.leadId, { taskId: t.id, remindOn: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null, note: t.description });
  }
  return out;
}
