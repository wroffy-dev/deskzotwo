import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { automationUserId } from "@/lib/automation-user";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { formatOrderId } from "@/lib/order-id";
import { renewalConfig } from "@/lib/renewal-lapse";
import { renewalManagersHere } from "@/lib/companies/renewal-manager";
import { renewalTaskTitle, upForRenewalWhere } from "@/lib/renewal-watch-rules";

const DAY = 86_400_000;
/** The task falls due this long before the subscription ends, so there's a week left to act on it. */
const DUE_BEFORE_END_DAYS = 7;

export type RenewalTaskRun = { raised: number; reason?: string };

/**
 * The renewal task raised ahead (owner, 30 Oct 2026 — src/lib/renewal-watch-rules.ts): Settings › Renewals'
 * `taskLeadDays` before a subscription ends, a task "Renew <product> — <customer>" for its renewal manager — the
 * customer's own, else its account manager, else nobody (the admins are told it has nobody) — due a week before the
 * end. Once a term: not where one of that title is open, nor where one was made for this term and closed.
 *
 * On the heartbeat (src/lib/marketing/heartbeat.ts), by the Automation account. The list then reads "Task raised",
 * which isn't "started": the escalations still go until somebody calls, quotes or renews.
 */
export async function runRenewalTasks(now = new Date()): Promise<RenewalTaskRun> {
  if (!(await moduleAvailableForTenant("renewals"))) return { raised: 0, reason: "renewals are off" };
  const config = await renewalConfig();
  const lead = config.watch.taskLeadDays;
  if (!config.migrated || lead === null) return { raised: 0, reason: "off" };
  const today = (await workspaceClock()).calendarDate(now);
  const due = await db.companyProduct.findMany({
    where: upForRenewalWhere(today, new Date(today.getTime() + lead * DAY)),
    orderBy: { endDate: "asc" },
    take: 200,
    select: {
      id: true,
      orderSeq: true,
      endDate: true,
      companyId: true,
      item: { select: { name: true } },
      company: { select: { name: true, ownerUserId: true, owner: { select: { active: true } } } },
    },
  });
  if (due.length === 0) return { raised: 0 };

  const titleOf = (o: (typeof due)[number]) => renewalTaskTitle(o.item.name, o.company.name);
  const [existing, managers] = await Promise.all([
    db.task.findMany({
      where: { OR: due.map((o) => ({ companyId: o.companyId, title: titleOf(o) })) },
      select: { companyId: true, title: true, done: true, createdAt: true },
    }),
    (await renewalManagersHere())
      ? db.company.findMany({
          where: { id: { in: [...new Set(due.map((o) => o.companyId))] }, renewalManagerId: { not: null } },
          select: { id: true, renewalManager: { select: { id: true, active: true } } },
        })
      : [],
  ]);
  const managerOf = new Map(managers.map((m) => [m.id, m.renewalManager]));
  const automation = await automationUserId();

  let raised = 0;
  for (const order of due) {
    const title = titleOf(order);
    // This term's: made since its lead began (a month's grace for a lead lengthened since), open or closed.
    const termStart = order.endDate!.getTime() - (lead + 30) * DAY;
    const had = existing.some((t) => t.companyId === order.companyId && t.title === title && (!t.done || t.createdAt.getTime() >= termStart));
    if (had) continue;
    const manager = managerOf.get(order.companyId);
    const assignee = manager?.active ? manager.id : order.company.owner?.active ? order.company.ownerUserId : null;
    const dueDate = new Date(Math.max(today.getTime(), order.endDate!.getTime() - DUE_BEFORE_END_DAYS * DAY));
    await db.task.create({
      data: {
        title,
        description: `${formatOrderId(order.orderSeq)} ends ${formatCalendarDay(order.endDate)}. Raised ${lead} days ahead (Settings › Renewals).`,
        dueDate,
        companyId: order.companyId,
        assignedToUserId: assignee,
        createdByUserId: automation,
      },
    });
    existing.push({ companyId: order.companyId, title, done: false, createdAt: now });
    raised += 1;
    if (assignee) await notifyUser({ userId: assignee, type: "TASK_ASSIGNED", title: "Renewal task assigned", message: title, link: "/tasks" });
  }
  return { raised };
}
