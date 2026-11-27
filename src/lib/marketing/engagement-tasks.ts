import { db } from "@/lib/db";
import { refreshLeadScoreQuietly } from "@/lib/leads/score-store";
import { notifyUser } from "@/lib/notify";
import { leadPath } from "@/lib/record-links";

/**
 * A marketing email clicked is a lead warming up (owner, 1 Nov 2026 — the gaps against HubSpot, ActiveCampaign, Zoho):
 * the lead's score is worked out again — its contact's opens and clicks now count (src/lib/leads/score-store.ts) — and
 * whoever owns the lead gets a task to follow up while it's warm. At most one such task a lead a week, however many
 * links they click. Never the reason a click fails to land.
 */

export const CLICK_TASK_PREFIX = "Clicked our email";
const WEEK = 7 * 24 * 60 * 60 * 1000;

export async function afterMarketingClick(messageId: string): Promise<{ tasks: number }> {
  const message = await db.marketingMessage.findUnique({
    where: { id: messageId },
    select: { messageClass: true, contactId: true, subject: true, campaign: { select: { name: true } }, contact: { select: { name: true } } },
  });
  if (!message || message.messageClass !== "MARKETING" || !message.contactId) return { tasks: 0 };
  // Their leads still being worked — a won or lost one has nothing to follow up.
  const leads = await db.lead.findMany({
    where: { contactId: message.contactId, status: { notIn: ["WON", "LOST"] } },
    select: { id: true, leadSeq: true, title: true, ownerUserId: true },
    take: 3,
  });
  let tasks = 0;
  for (const lead of leads) {
    await refreshLeadScoreQuietly(lead.id).catch(() => null);
    if (!lead.ownerUserId) continue;
    const recent = await db.task.count({ where: { leadId: lead.id, title: { startsWith: CLICK_TASK_PREFIX }, createdAt: { gte: new Date(Date.now() - WEEK) } } });
    if (recent > 0) continue;
    const what = message.campaign?.name ?? message.subject ?? "a marketing email";
    const due = new Date(Date.now() + 24 * 60 * 60 * 1000);
    await db.task.create({
      data: {
        title: `${CLICK_TASK_PREFIX} — ${message.contact?.name ?? "the contact"} on “${what}”`.slice(0, 200),
        description: `They clicked a link in “${what}”. Call while it's on their mind.`,
        leadId: lead.id,
        assignedToUserId: lead.ownerUserId,
        createdByUserId: lead.ownerUserId,
        dueDate: due,
      },
    });
    await notifyUser({ userId: lead.ownerUserId, type: "TASK_ASSIGNED", title: `${message.contact?.name ?? "A lead"} clicked your email`, message: `On “${what}” — a task to follow up is on ${lead.title}.`, link: leadPath(lead.leadSeq) }).catch(() => undefined);
    tasks += 1;
  }
  return { tasks };
}
