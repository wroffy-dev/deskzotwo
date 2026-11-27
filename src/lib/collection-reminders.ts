import { db } from "@/lib/db";
import { formatCompanyId } from "@/lib/order-id";

/**
 * A person's own "Remind me" on a customer who owes money (owner, 3 Nov 2026 — Receivables' row actions, as the
 * Payments list has them for an order): a task for them, due the day they pick, with their note, on the customer. The
 * task names the customer in its title, which is how the row finds it again; one open follow-up a person a customer.
 * As src/lib/payment-reminders.ts, under its own name, so a customer's and an order's never take each other's place.
 */

const PREFIX = "Collection follow-up — ";

export const collectionReminderTitle = (companySeq: number, companyName: string) => `${PREFIX}${companyName} (${formatCompanyId(companySeq)})`;

export type MyCollectionReminder = { taskId: string; remindOn: string | null; note: string | null };

/** This person's open follow-ups on these customers, by customer id — one query for a page. */
export async function myCollectionRemindersFor(userId: string, companyIds: string[]): Promise<Map<string, MyCollectionReminder>> {
  const out = new Map<string, MyCollectionReminder>();
  if (companyIds.length === 0) return out;
  const tasks = await db.task.findMany({
    where: { assignedToUserId: userId, done: false, companyId: { in: [...new Set(companyIds)] }, title: { startsWith: PREFIX } },
    orderBy: { createdAt: "desc" },
    select: { id: true, dueDate: true, description: true, companyId: true },
  });
  for (const t of tasks) {
    if (!t.companyId || out.has(t.companyId)) continue;
    out.set(t.companyId, { taskId: t.id, remindOn: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null, note: t.description });
  }
  return out;
}

/** This person's open follow-up on one customer, or null. */
export async function myCollectionReminder(userId: string, companyId: string): Promise<MyCollectionReminder | null> {
  return (await myCollectionRemindersFor(userId, [companyId])).get(companyId) ?? null;
}
