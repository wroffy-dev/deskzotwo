import { db } from "@/lib/db";
import { formatOrderId } from "@/lib/order-id";

/**
 * A person's own "Remind me" on an order still owing money (owner, 3 Nov 2026 — the Payments list's row actions, as the
 * renewals list has them): a task for them, due the day they pick, with their note. The task names its order in its
 * title, which is how the row finds it again; one open follow-up a person an order. As src/lib/renewal-reminders.ts,
 * under its own name, so a renewal's reminder and a payment's never take each other's place.
 */

const PREFIX = "Payment follow-up — ";

export const paymentReminderTitle = (orderSeq: number, itemName: string, companyName: string) => `${PREFIX}${formatOrderId(orderSeq)} · ${itemName} — ${companyName}`;

/** The order number a follow-up's title names, or null for any other task. */
export function orderSeqOfPaymentReminder(title: string): number | null {
  const m = title.match(/^Payment follow-up — ORD-(\d+)\b/);
  return m ? Number(m[1]) : null;
}

export type MyPaymentReminder = { taskId: string; remindOn: string | null; note: string | null };

/** This person's open follow-ups on these orders, by order id — one query for a page. */
export async function myPaymentRemindersFor(userId: string, orders: { id: string; orderSeq: number; companyId: string }[]): Promise<Map<string, MyPaymentReminder>> {
  const out = new Map<string, MyPaymentReminder>();
  if (orders.length === 0) return out;
  const tasks = await db.task.findMany({
    where: { assignedToUserId: userId, done: false, companyId: { in: [...new Set(orders.map((o) => o.companyId))] }, title: { startsWith: PREFIX } },
    orderBy: { createdAt: "desc" },
    select: { id: true, title: true, dueDate: true, description: true, companyId: true },
  });
  for (const o of orders) {
    const t = tasks.find((task) => task.companyId === o.companyId && orderSeqOfPaymentReminder(task.title) === o.orderSeq);
    if (t) out.set(o.id, { taskId: t.id, remindOn: t.dueDate ? t.dueDate.toISOString().slice(0, 10) : null, note: t.description });
  }
  return out;
}
