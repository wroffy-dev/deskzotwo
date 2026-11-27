import { db } from "@/lib/db";
import { formatOrderId } from "@/lib/order-id";

/**
 * A salesperson's own "Remind me" on a renewal (owner, 31 Oct 2026 — "help the sales person remember the renewal"):
 * a task for them, due on the day they pick, with their note — so the bell rings that day (and when it's late), it can
 * be emailed, and it sits in My tasks with everything else. The task names its order in its title, which is how a
 * renewal row finds it again; one open reminder a person a renewal. Not a sign the renewal is being worked: the
 * renewal watch (src/lib/renewal-watch-rules.ts) counts calls, quotes and its own task, not this.
 */

const PREFIX = "Renewal reminder — ";

export const reminderTitle = (orderSeq: number, itemName: string, companyName: string) => `${PREFIX}${formatOrderId(orderSeq)} · ${itemName} — ${companyName}`;

/** The order number a reminder's title names, or null for any other task. */
export function orderSeqOfReminder(title: string): number | null {
  const m = title.match(/^Renewal reminder — ORD-(\d+)\b/);
  return m ? Number(m[1]) : null;
}

export type MyReminder = { taskId: string; remindOn: string | null; note: string | null };

/** This person's open reminders on these renewals, by order id — one query for a page. */
export async function myRemindersFor(userId: string, orders: { id: string; orderSeq: number; companyId: string }[]): Promise<Map<string, MyReminder>> {
  const out = new Map<string, MyReminder>();
  if (orders.length === 0) return out;
  const tasks = await db.task.findMany({
    where: { assignedToUserId: userId, done: false, companyId: { in: [...new Set(orders.map((o) => o.companyId))] }, title: { startsWith: PREFIX } },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, dueDate: true, description: true, companyId: true },
  });
  for (const o of orders) {
    const t = tasks.find((task) => task.companyId === o.companyId && orderSeqOfReminder(task.title) === o.orderSeq);
    if (t) out.set(o.id, { taskId: t.id, remindOn: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null, note: t.description });
  }
  return out;
}

/** The orders this person has an open reminder on — for the renewals list's "My reminders". */
export async function myReminderOrderSeqs(userId: string): Promise<number[]> {
  const tasks = await db.task.findMany({ where: { assignedToUserId: userId, done: false, title: { startsWith: PREFIX } }, select: { title: true } });
  return [...new Set(tasks.map((t) => orderSeqOfReminder(t.title)).filter((n): n is number => n !== null))];
}
