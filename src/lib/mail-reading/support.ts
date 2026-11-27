import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { currentTenant } from "@/lib/tenancy/resolve";
import { automationUserId } from "@/lib/automation-user";
import { styled } from "@/lib/ai/house-style";
import { AiRefusal, aiTurn, aiUnavailable } from "@/lib/ai/gateway";
import { searchKnowledge } from "@/lib/ai-knowledge/search";
import { receiveEmail } from "@/lib/support-mail/receive";
import { ticketSeqFromSubject } from "@/lib/support-mail/rules";
import { agentMayRead, mailReadingEnabled } from "@/lib/mail-reading/server";

/**
 * Support reading customers' emails in the mailboxes an admin lets it read (owner, 23 Nov 2026: "Support tickets next" —
 * phase four of src/lib/mail-reading). A customer who writes about a problem to the person they know — not the helpdesk
 * address — still gets a ticket:
 *
 *   · **A customer's email about a problem**, or one whose subject carries a ticket's [TCK-…] tag, goes through the
 *     helpdesk's own receiver (src/lib/support-mail/receive.ts) as though it had come to the helpdesk address: a reply
 *     to its ticket (only from somebody already on it), else a new ticket under the sender's company, else the Support
 *     inbox. Nothing is sent to the customer — the email went to a person, who may have answered already — and the
 *     ticket's email says whose mailbox it came from. Attachments stay in the mailbox.
 *   · **Kabir drafts the answer**: an internal comment on the ticket, written from the workspace's AI Knowledge files
 *     shared with customers (feature "tickets.draft", charged to the mailbox's owner). Never sent; an agent checks it
 *     and answers with Reply by email. No draft when Deskzo AI isn't on for the owner, or it has nothing to go on.
 *
 * Only customers (a client or reseller, or a company that is also a customer); never an email Arjun took as money mail
 * or Tara as a lead's reply. Each email once, even copied to several mailboxes; every read logged.
 */

const PROBLEM =
  /\b(not working|doesn'?t work|isn'?t working|stopped working|not able to|unable to|can'?t (log|sign|open|access|connect|install|activate|see|send|receive)|cannot (log|sign|open|access|connect|install|activate|see|send|receive)|issue|issues|problem|problems|error|errors|failed|failing|broken|is down|went down|outage|need help|please help|help needed|support ticket|complaint|bug|crash(ed|es|ing)?|no access|access denied|locked out|reset (my|the|our) password|installation|activation|licen[cs]e key)\b/i;
const PER_TICK = 20;
const DAY = 86_400_000;
const DRAFT_MAX = 1500;

type Drafter = (input: { system: string; question: string; chargedTo: string }) => Promise<string | null>;
let testDrafter: Drafter | null = null;

/** For the checks: Kabir's drafts come from here instead of a model. Null puts the gateway back. */
export function setTestTicketDrafter(drafter: Drafter | null) {
  testDrafter = drafter;
}

/**
 * Whether another teammate already took this email: Arjun as money mail, Tara as a nurtured lead's reply or an answer to
 * her check-in. Tara noting an email on an open lead's activity doesn't take it — a customer with a deal open still gets
 * their problem a ticket.
 */
async function takenElsewhere(messageId: string): Promise<boolean> {
  const logs = await db.mailReadLog.findMany({ where: { messageId, agent: { in: ["arjun", "tara"] } }, select: { purpose: true } });
  return logs.some((l) => !l.purpose.includes("passed") && !l.purpose.startsWith("bill:") && !l.purpose.includes("on its activity"));
}

export async function supportReadsMail(now = new Date()): Promise<{ tickets: number; replies: number; inbox: number; drafts: number } | null> {
  try {
    if (!(await mailReadingEnabled())) return null;
    const owners = (await db.mailReadGrant.findMany({ where: { agent: "support", user: { active: true } }, select: { userId: true } })).map((g) => g.userId);
    const out = { tickets: 0, replies: 0, inbox: 0, drafts: 0 };
    if (!owners.length) return out;
    const rows = await db.mailMessage.findMany({
      where: {
        userId: { in: owners },
        direction: "IN",
        sentAt: { gte: new Date(now.getTime() - 14 * DAY) },
        company: { OR: [{ relationshipType: { in: ["CLIENT", "RESELLER"] } }, { alsoCustomer: true }] },
      },
      orderBy: { sentAt: "asc" },
      take: 200,
      select: {
        id: true,
        userId: true,
        companyId: true,
        fromEmail: true,
        fromName: true,
        toEmails: true,
        ccEmails: true,
        subject: true,
        bodyText: true,
        snippet: true,
        hasAttachments: true,
        sentAt: true,
        user: { select: { name: true } },
      },
    });
    const done = new Set((await db.mailReadLog.findMany({ where: { messageId: { in: rows.map((r) => r.id) }, agent: "support" }, select: { messageId: true } })).map((l) => l.messageId));
    let handled = 0;
    for (const m of rows) {
      if (handled >= PER_TICK) break;
      if (done.has(m.id)) continue;
      const tagged = ticketSeqFromSubject(m.subject) !== null;
      if (!tagged && !PROBLEM.test(`${m.subject}\n${m.bodyText.slice(0, 4000)}`)) continue;
      if (await takenElsewhere(m.id)) {
        await db.mailReadLog.create({ data: { messageId: m.id, agent: "support", purpose: "ticket: another teammate's — passed" } });
        continue;
      }
      if (!(await agentMayRead("support", [m.id], tagged ? "ticket: a customer's email on a ticket" : "ticket: a customer's email about a problem")).length) continue;
      handled += 1;
      // The same email in two mailboxes (one copied in) is one ticket: the helpdesk sees one Message-ID.
      const messageId = `<mailbox-${createHash("sha256").update(`${m.companyId}|${m.fromEmail}|${m.subject}|${Math.floor(m.sentAt.getTime() / 60_000)}`).digest("hex").slice(0, 32)}@mail-reading.deskzo>`;
      const text = (m.bodyText || m.snippet) + (m.hasAttachments ? `\n\n[Its attachments are in ${m.user.name}'s mailbox.]` : "");
      const got = await receiveEmail(
        {
          from: { address: m.fromEmail, name: m.fromName },
          to: m.toEmails,
          cc: m.ccEmails,
          subject: m.subject,
          text,
          messageId,
          inReplyTo: null,
          references: [],
          automated: null,
          attachments: [],
          // It arrived in a real mailbox through the provider's own checks, from somebody already in Deskzo.
          senderVerified: true,
          senderCheck: "Read from a connected mailbox",
        },
        now,
        { acknowledge: false, via: `Came to ${m.user.name}'s mailbox` },
      );
      if (got.state === "NEW_TICKET") out.tickets += 1;
      else if (got.state === "REPLY") out.replies += 1;
      else if (got.state === "INBOX") out.inbox += 1;
      if ((got.state === "NEW_TICKET" || got.state === "REPLY") && got.ticketSeq) {
        if (await kabirDrafts(got.ticketSeq, m.userId, m.subject, m.bodyText || m.snippet)) out.drafts += 1;
      }
    }
    return out;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

function draftSystem(business: string, knowledge: { file: string; heading: string; text: string }[]): string {
  return [
    `You are Kabir, on the support desk of ${business}. A customer emailed about a problem. Draft the answer a support agent will check, change if need be, and send.`,
    "Use only the knowledge below. Never promise a date, a refund, a price, a replacement or anything about the customer's own account or order — the agent decides those.",
    "When the knowledge doesn't answer it, write a short, kind reply saying it's being looked into and asking for exactly what would help (a screenshot, the error's wording, when it started).",
    "Plain text, under 150 words, no subject line, no sign-off.",
    "",
    knowledge.length ? "Knowledge:" : "Knowledge: none.",
    ...knowledge.map((k) => `— ${k.file}${k.heading ? ` › ${k.heading}` : ""}:\n${k.text}`),
  ].join("\n");
}

/** Kabir's draft answer as an internal comment on the ticket. Never throws; false when there's none. */
async function kabirDrafts(ticketSeq: number, chargedTo: string, subject: string, body: string): Promise<boolean> {
  try {
    const question = `Subject: ${subject}\n\n${body.slice(0, 4000)}`;
    let text: string | null;
    if (testDrafter) {
      text = await testDrafter({ system: draftSystem("the business", []), question, chargedTo });
    } else {
      if (await aiUnavailable(chargedTo, "tickets.draft")) return false;
      const knowledge = await searchKnowledge(`${subject}\n${body.slice(0, 1000)}`, 3, { forCustomers: true });
      const system = await styled(draftSystem((await currentTenant()).name || "the business", knowledge), { signOff: false });
      const outcome = await aiTurn({ userId: chargedTo, feature: "tickets.draft", system, history: [{ role: "user", text: question }], tools: [] });
      text = outcome.stop === "done" ? outcome.text : null;
    }
    const draft = text?.trim() ?? "";
    if (!draft || draft.length > DRAFT_MAX) return false;
    const ticket = await db.ticket.findUnique({ where: { ticketSeq }, select: { id: true } });
    if (!ticket) return false;
    await db.ticketComment.create({
      data: { ticketId: ticket.id, userId: await automationUserId(), body: `Kabir's draft answer — not sent. Check it, then answer with Reply by email:\n\n${draft}` },
    });
    return true;
  } catch (err) {
    if (!(err instanceof AiRefusal)) console.error("[mail-reading] Kabir couldn't draft a ticket's answer", err instanceof Error ? err.message : err);
    return false;
  }
}
