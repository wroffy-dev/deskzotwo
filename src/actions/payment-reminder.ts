"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { refuseWhileViewingAs } from "@/lib/session";
import { requireModuleUser } from "@/lib/modules-access";
import { orderAccess } from "@/lib/authz/access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { calendarDayRange, formatCalendarDay } from "@/lib/time/zone";
import { formatOrderId } from "@/lib/order-id";
import { myPaymentRemindersFor, paymentReminderTitle } from "@/lib/payment-reminders";
import type { ActionResult } from "@/actions/company";

/**
 * "Remind me" on an order still owing money (src/lib/payment-reminders.ts): set it — a day and a note — change it, or
 * clear it. Only on an order this person can see, for whoever may see payments; always for themselves.
 */

const NOTE_MAX = 1000;

async function reachableOrder(userId: string, orderId: string) {
  if (!(await can(userId, "payments.view"))) return null;
  return db.companyProduct.findFirst({
    where: { AND: [{ id: String(orderId) }, await orderAccess(userId, "view")] },
    select: { id: true, orderSeq: true, companyId: true, item: { select: { name: true } }, company: { select: { name: true } } },
  });
}

export async function setPaymentReminder(input: { orderId: string; remindOn: string; note?: string | null }): Promise<ActionResult<{ remindOn: string }>> {
  const user = await requireModuleUser("payments");
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  const order = await reachableOrder(user.id, input?.orderId);
  if (!order) return { ok: false, error: "That order isn't there." };
  const day = calendarDayRange(String(input?.remindOn ?? ""), null)?.gte ?? null;
  if (!day) return { ok: false, error: "Pick the day to be reminded." };
  const note = String(input?.note ?? "").trim().slice(0, NOTE_MAX) || null;

  // One open follow-up a person an order: a second "Remind me" moves the first.
  const existing = (await myPaymentRemindersFor(user.id, [order])).get(order.id);
  const title = paymentReminderTitle(order.orderSeq, order.item.name, order.company.name);
  if (existing) await db.task.update({ where: { id: existing.taskId }, data: { dueDate: day, description: note, title } });
  else await db.task.create({ data: { title, description: note, dueDate: day, companyId: order.companyId, assignedToUserId: user.id, createdByUserId: user.id } });
  await recordAudit({
    userId: user.id,
    action: existing ? "UPDATE" : "CREATE",
    entityType: "Task",
    entityId: order.id,
    entityLabel: `Payment follow-up for ${formatOrderId(order.orderSeq)} — ${order.company.name}: ${formatCalendarDay(day)}${note ? ` — ${note}` : ""}`.slice(0, 500),
    subject: { companyId: order.companyId },
  });
  revalidatePath("/payments");
  revalidatePath("/tasks");
  return { ok: true, data: { remindOn: day.toISOString().slice(0, 10) } };
}

/** Done with it: the follow-up's task is ticked off, so it stops ringing. */
export async function clearPaymentReminder(orderId: string): Promise<ActionResult<null>> {
  const user = await requireModuleUser("payments");
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  const order = await reachableOrder(user.id, orderId);
  if (!order) return { ok: false, error: "That order isn't there." };
  const existing = (await myPaymentRemindersFor(user.id, [order])).get(order.id);
  if (!existing) return { ok: true, data: null };
  await db.task.update({ where: { id: existing.taskId }, data: { done: true, doneAt: new Date(), status: "DONE" } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Task", entityId: order.id, entityLabel: `Payment follow-up for ${formatOrderId(order.orderSeq)} — ${order.company.name}: done`, subject: { companyId: order.companyId } });
  revalidatePath("/payments");
  revalidatePath("/tasks");
  return { ok: true, data: null };
}
