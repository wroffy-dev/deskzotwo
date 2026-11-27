import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { notifyUser } from "@/lib/notify";
import { leadPath } from "@/lib/record-links";
import { receiveNurtureReply } from "@/lib/nurture/server";
import { receiveCheckInReply } from "@/lib/reengage/server";
import type { IncomingEmail } from "@/lib/support-mail/parse";
import { agentMayRead, mailReadingEnabled } from "@/lib/mail-reading/server";

/**
 * Tara and Ved reading leads' and customers' replies in the mailboxes an admin lets them read (owner, 23 Nov 2026: "Tara
 * and Ved next" — phase three of src/lib/mail-reading). A lead who answers the salesperson directly — not Tara's own
 * reply-to address — or answers an email the salesperson sent themselves, is caught too, and handed to what Tara does:
 *
 *   · **A lead in a nurture**: Tara's nurture-reply reader (src/lib/nurture/server.ts) — asked to stop, unsubscribed;
 *     "not now", paused; away, the next email waits; interested, a call, the wrong person, not interested: ended, with
 *     the task and the answer drafted. The same as a reply to her own email.
 *   · **A customer Tara checked in with** (a check-in sent in the last 60 days): her check-in reader
 *     (src/lib/reengage/server.ts) — interested, a lead opened; anything else, a task.
 *   · **Any other open lead**: the email on the lead's activity — which its score and Ved's research read — and its
 *     owner told, when the mailbox isn't theirs.
 *
 * Only received mail from the lead's or customer's side, only once each, every read logged. A reply in the owner's own
 * mailbox isn't emailed to them again; in a colleague's, it is.
 */

const PER_TICK = 20;
const DAY = 86_400_000;

function asIncoming(m: { fromEmail: string; fromName: string | null; toEmails: string[]; ccEmails: string[]; subject: string; bodyText: string; snippet: string; providerId: string }): IncomingEmail & { senderVerified: boolean } {
  return {
    from: { address: m.fromEmail, name: m.fromName },
    to: m.toEmails,
    cc: m.ccEmails,
    subject: m.subject || "(no subject)",
    text: m.bodyText || m.snippet,
    messageId: m.providerId,
    inReplyTo: null,
    references: [],
    automated: null,
    attachments: [],
    // It arrived in a real mailbox through the provider's own checks.
    senderVerified: true,
  };
}

export async function taraReadsReplies(now = new Date()): Promise<{ nurture: number; checkIns: number; logged: number } | null> {
  try {
    if (!(await mailReadingEnabled())) return null;
    const owners = (await db.mailReadGrant.findMany({ where: { agent: "tara", user: { active: true } }, select: { userId: true } })).map((g) => g.userId);
    const out = { nurture: 0, checkIns: 0, logged: 0 };
    if (!owners.length) return out;
    const rows = await db.mailMessage.findMany({
      where: { userId: { in: owners }, direction: "IN", companyId: { not: null }, sentAt: { gte: new Date(now.getTime() - 14 * DAY) } },
      orderBy: { sentAt: "asc" },
      take: 200,
      select: { id: true, userId: true, companyId: true, leadId: true, fromEmail: true, fromName: true, toEmails: true, ccEmails: true, subject: true, bodyText: true, snippet: true, providerId: true, sentAt: true },
    });
    const done = new Set((await db.mailReadLog.findMany({ where: { messageId: { in: rows.map((r) => r.id) }, agent: "tara" }, select: { messageId: true } })).map((l) => l.messageId));
    let handled = 0;
    for (const m of rows) {
      if (handled >= PER_TICK) break;
      if (done.has(m.id) || !m.companyId) continue;
      const mail = asIncoming(m);

      // A lead in a nurture.
      const enrolment = m.leadId ? await db.nurtureEnrolment.findUnique({ where: { leadId: m.leadId }, select: { replyToken: true, ownerId: true, replies: { where: { createdAt: { gte: new Date(m.sentAt.getTime() - 10 * 60_000) } }, select: { subject: true } } } }).catch(() => null) : null;
      if (enrolment) {
        if (!(await agentMayRead("tara", [m.id], "reply: a nurtured lead's email")).length) continue;
        // Answered to Tara's own address as well: read there already.
        if (!enrolment.replies.some((r) => r.subject === mail.subject.slice(0, 300))) {
          await receiveNurtureReply(enrolment.replyToken, mail, now, { forward: m.userId !== enrolment.ownerId });
          out.nurture += 1;
        }
        handled += 1;
        continue;
      }

      // A customer Tara checked in with lately.
      const checkIn = await db.reengageEmail
        .findFirst({ where: { companyId: m.companyId, status: "SENT", sentAt: { gte: new Date(now.getTime() - 60 * DAY), lte: m.sentAt } }, orderBy: { sentAt: "desc" }, select: { replyToken: true, ownerId: true, repliedAt: true } })
        .catch(() => null);
      if (checkIn) {
        if (!(await agentMayRead("tara", [m.id], "reply: a customer's answer to a check-in")).length) continue;
        const already = checkIn.repliedAt && Math.abs(checkIn.repliedAt.getTime() - m.sentAt.getTime()) < 10 * 60_000;
        if (!already) {
          await receiveCheckInReply(checkIn.replyToken, mail, now, { forward: m.userId !== checkIn.ownerId });
          out.checkIns += 1;
        }
        handled += 1;
        continue;
      }

      // Any other open lead: on its activity, and its owner told.
      if (m.leadId) {
        const lead = await db.lead.findUnique({ where: { id: m.leadId }, select: { id: true, leadSeq: true, title: true, ownerUserId: true, status: true } });
        if (!lead || ["WON", "LOST", "DISQUALIFIED"].includes(lead.status)) {
          await db.mailReadLog.create({ data: { messageId: m.id, agent: "tara", purpose: "reply: no open lead — passed" } });
          continue;
        }
        if (!(await agentMayRead("tara", [m.id], "reply: a lead's email, on its activity")).length) continue;
        const who = lead.ownerUserId ?? m.userId;
        await db.activity.create({ data: { leadId: lead.id, userId: m.userId, type: "EMAIL", notes: `Email from ${m.fromName || m.fromEmail}: ${mail.subject}\n\n${mail.text.slice(0, 2000)}`, occurredAt: m.sentAt } });
        if (who !== m.userId) {
          await notifyUser({ userId: who, type: "LEAD_ASSIGNED", title: `Tara: ${m.fromName || m.fromEmail} emailed about ${lead.title}`, message: mail.subject, link: leadPath(lead.leadSeq) }).catch(() => {});
        }
        out.logged += 1;
        handled += 1;
        continue;
      }
      await db.mailReadLog.create({ data: { messageId: m.id, agent: "tara", purpose: "reply: no lead or check-in — passed" } });
    }
    return out;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}
