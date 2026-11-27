import type { SupportEmailState } from "@prisma/client";
import { db } from "@/lib/db";
import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import { STILL_THERE } from "@/lib/contacts/left";
import { recordAudit } from "@/lib/audit";
import { automationUserId } from "@/lib/automation-user";
import { notifyUser } from "@/lib/notify";
import { PEOPLE_ONLY } from "@/lib/people";
import { ticketPath } from "@/lib/record-links";
import { formatTicketId } from "@/lib/tickets";
import { emitTicketCreated } from "@/lib/automate/emit-tickets";
import { inboundDomain } from "@/lib/support-mail/config";
import type { IncomingEmail, SenderTrust } from "@/lib/support-mail/parse";
import {
  ATTACHMENT_BYTES_PER_DAY,
  ATTACHMENT_BYTES_PER_SENDER_PER_DAY,
  domainOf,
  FLOOD_PER_DOMAIN_PER_HOUR,
  FLOOD_PER_HOUR,
  isForwardingConfirmation,
  normalizeAddress,
  ticketSeqFromSubject,
  visiblePart,
} from "@/lib/support-mail/rules";
import { sendSupportEmail } from "@/lib/support-mail/send";
import { companiesForSenderDomain } from "@/lib/support-mail/domain-match";
import { activeWordFilter } from "@/lib/word-filter/server";
import { keepDataUrl } from "@/lib/storage/files";
import { isStorageFull } from "@/lib/file-refusal";

/**
 * One email that reached this workspace's helpdesk address, decided — inside the workspace
 * (`runAsTenant`, src/app/api/platform/inbound-email). In this order:
 *
 *   1. **A repeat** of one already received (the same Message-ID): nothing new, nothing stored.
 *   (after 2) **An unverified sender** — its From address not backed by DMARC or an aligned DKIM signature
 *      (src/lib/support-mail/sender-auth.ts) — waits in the Support inbox, flagged, before anything below is tried.
 *   2. **Left out** (IGNORED, kept so it can be looked at): no sender, mail from this helpdesk itself, an
 *      automatic reply, a bounce or a newsletter (`automatedReason`), or the thirty-first email from one
 *      address in an hour. Never acknowledged — that is how mail loops start.
 *   3. **A reply** to a ticket — by its In-Reply-To or References, else the [TCK-…] tag in the subject —
 *      added to the ticket's conversation (REPLY), and a resolved or closed ticket opens again. Only from
 *      somebody already on the ticket: its contact, or an address that wrote to it or was written to. A
 *      stranger quoting a ticket number waits in the inbox instead; nobody adds to a customer's ticket by
 *      guessing its number.
 *   4. **A new ticket** (NEW_TICKET) when the sender is a contact at exactly one company — or, not a
 *      contact anywhere, writes from a domain that exactly one company's contacts use (owner, 15 Oct
 *      2026: aman@wroffy.com is Wroffy's when sachin@wroffy.com is a contact there; never Gmail and the
 *      like, src/lib/support-mail/domain-match.ts). Opened by the workspace's Automation account, given
 *      to the default agent when there is one, acknowledged by email when the workspace says so. A
 *      ticket filed by its domain has no contact: the ticket offers to add the sender as one.
 *   5. **The Support inbox** (INBOX) otherwise — an unknown sender at an unknown domain, one known (or
 *      whose domain is known) at several companies, one who has left, Gmail's forwarding confirmation —
 *      for somebody to decide where it belongs.
 *
 * The support team (anybody in a support-team department) is told about each new ticket and reply that
 * nobody is assigned to, and about each email waiting in the inbox; an assigned ticket tells its agent.
 */

export type Received = { state: SupportEmailState | "DUPLICATE"; emailId: string | null; ticketSeq?: number; note?: string };

const ONE_HOUR = 60 * 60_000;

/** The people a support email is news to: the ticket's agent, else everybody in a support team. */
async function supportTeam(): Promise<string[]> {
  const rows = await db.user.findMany({ where: { active: true, ...PEOPLE_ONLY, department: { isSupportTeam: true } }, select: { id: true } });
  return rows.map((r) => r.id);
}

async function tell(userIds: string[], title: string, message: string, link: string) {
  for (const userId of userIds) await notifyUser({ userId, type: "TICKET_EMAIL", title, message, link });
}

/** Whether `address` is already part of this ticket: its contact, or an address in its conversation. */
async function onTicket(ticketId: string, contactEmail: string | null, address: string): Promise<boolean> {
  if (contactEmail && normalizeAddress(contactEmail) === address) return true;
  const seen = await db.supportEmail.count({
    where: { ticketId, OR: [{ fromAddress: address }, { toAddresses: { has: address } }, { ccAddresses: { has: address } }] },
  });
  return seen > 0;
}

/**
 * The files of one email that fit today's budgets (SEC-34): the workspace's ATTACHMENT_BYTES_PER_DAY and the
 * sender's ATTACHMENT_BYTES_PER_SENDER_PER_DAY, counted over what was kept in the last 24 hours. In order,
 * stopping at the first that doesn't fit.
 */
export async function attachmentsWithinBudget<T extends { sizeBytes: number }>(files: T[], sender: string, now = new Date()): Promise<T[]> {
  if (files.length === 0) return files;
  const since = new Date(now.getTime() - 24 * ONE_HOUR);
  const [all, mine] = await Promise.all([
    db.supportEmailAttachment.aggregate({ where: { createdAt: { gte: since } }, _sum: { sizeBytes: true } }),
    sender
      ? db.supportEmailAttachment.aggregate({ where: { createdAt: { gte: since }, email: { fromAddress: sender } }, _sum: { sizeBytes: true } })
      : Promise.resolve({ _sum: { sizeBytes: 0 } }),
  ]);
  let workspace = all._sum.sizeBytes ?? 0;
  let theirs = mine._sum.sizeBytes ?? 0;
  const kept: T[] = [];
  for (const file of files) {
    if (workspace + file.sizeBytes > ATTACHMENT_BYTES_PER_DAY || theirs + file.sizeBytes > ATTACHMENT_BYTES_PER_SENDER_PER_DAY) break;
    workspace += file.sizeBytes;
    theirs += file.sizeBytes;
    kept.push(file);
  }
  return kept;
}

/**
 * An email's files as their rows keep them: in the storage box when the server has one (src/lib/storage/files.ts), the
 * row holding its reference; in the row itself when it hasn't.
 *
 * With the workspace's storage full (storage in the plans, 20 Nov 2026 — src/lib/file-refusal.ts) the email is still
 * received — a customer's words reach their ticket — and the files there was no room for are left out, logged, and
 * named in what is kept, as the daily allowance's are. One at a time, so the room is counted file by file.
 */
async function toBox<T extends { dataUrl: string; fileName: string }>(files: T[], body: string): Promise<{ files: T[]; body: string }> {
  const kept: T[] = [];
  const left: string[] = [];
  for (const f of files) {
    try {
      kept.push({ ...f, dataUrl: await keepDataUrl("support-email", f.dataUrl) });
    } catch (err) {
      if (!isStorageFull(err)) throw err;
      left.push(f.fileName);
    }
  }
  if (!left.length) return { files: kept, body };
  console.warn(`[support-mail] ${left.length} attachment${left.length === 1 ? "" : "s"} not kept — the workspace's storage is full`);
  return { files: kept, body: `${body}

[Not kept, the workspace's storage is full: ${left.join(", ")}.]` };
}

/**
 * `opts` (owner, 23 Nov 2026 — src/lib/mail-reading/support.ts): an email read from a person's connected mailbox comes
 * through here too, with `acknowledge: false` — it went to a person, who may have answered already — and `via`, which
 * the kept email's note says (whose mailbox it came to).
 */
export async function receiveEmail(mail: IncomingEmail & SenderTrust, now = new Date(), opts: { acknowledge?: boolean; via?: string } = {}): Promise<Received> {
  if (mail.messageId && (await db.supportEmail.count({ where: { messageId: mail.messageId } })) > 0) {
    return { state: "DUPLICATE", emailId: null, note: "Already received" };
  }

  const sender = mail.from?.address ?? "";
  // A customer's words the workspace keeps out of tickets are let in as stars (owner, 15 Oct 2026) — the
  // email still reaches its ticket; what is kept, and shown, is masked (src/lib/word-filter).
  const filter = await activeWordFilter("TICKETS");
  const subject = filter ? filter.mask(mail.subject ?? "") : mail.subject;
  const text = filter ? filter.mask(mail.text ?? "") : mail.text;
  const base = {
    direction: "INBOUND" as const,
    fromAddress: sender || "unknown",
    fromName: mail.from?.name ?? null,
    toAddresses: mail.to,
    ccAddresses: mail.cc,
    subject: subject || "(no subject)",
    body: text,
    messageId: mail.messageId,
    inReplyTo: mail.inReplyTo,
    references: mail.references,
  };
  // Security audit, 11 Nov 2026 (SEC-34): the files are kept only within the day's budgets — the workspace's
  // and this sender's. Over either, the email is still kept, and its text names the files left out.
  const attachments = await attachmentsWithinBudget(mail.attachments, sender, now);
  if (attachments.length < mail.attachments.length) {
    const left = mail.attachments.slice(attachments.length).map((a) => a.fileName);
    base.body = `${base.body}\n\n[Not kept, over the helpdesk's daily file allowance: ${left.join(", ")}.]`;
  }
  const keep = async (state: SupportEmailState, extra: { ticketId?: string; contactId?: string | null; note?: string | null } = {}) => {
    const filed = await toBox(attachments, base.body);
    const row = await db.supportEmail.create({
      data: {
        ...base,
        body: filed.body,
        state,
        ticketId: extra.ticketId ?? null,
        contactId: extra.contactId ?? null,
        note: [extra.note, opts.via].filter(Boolean).join(" · ") || null,
        attachments: { create: filed.files },
      },
      select: { id: true },
    });
    return row.id;
  };
  const ignore = async (note: string): Promise<Received> => ({ state: "IGNORED", emailId: await keep("IGNORED", { note }), note });

  // ── 2. Left out ─────────────────────────────────────────────────────────────────────────────────
  if (!sender) return ignore("It had no sender to answer");
  const domain = inboundDomain();
  if (domain && sender.endsWith(`@${domain}`)) return ignore("It came from a helpdesk address itself");
  if (mail.automated) return ignore(mail.automated);
  const recent = await db.supportEmail.count({ where: { direction: "INBOUND", fromAddress: sender, createdAt: { gte: new Date(now.getTime() - ONE_HOUR) } } });
  if (recent >= FLOOD_PER_HOUR) return ignore(`More than ${FLOOD_PER_HOUR} emails from this address in an hour`);
  // Security audit, 11 Nov 2026 (SEC-07): and per sender domain, so a new address for every email floods nothing.
  const senderDomain = domainOf(sender);
  if (senderDomain) {
    const fromDomain = await db.supportEmail.count({
      where: { direction: "INBOUND", fromAddress: { endsWith: `@${senderDomain}` }, createdAt: { gte: new Date(now.getTime() - ONE_HOUR) } },
    });
    if (fromDomain >= FLOOD_PER_DOMAIN_PER_HOUR) return ignore(`More than ${FLOOD_PER_DOMAIN_PER_HOUR} emails from ${senderDomain} in an hour`);
  }

  const waiting = async (note: string): Promise<Received> => {
    const emailId = await keep("INBOX", { note });
    await tell(await supportTeam(), "An email waits in the Support inbox", `${base.fromName ?? sender}: ${base.subject}`, "/tickets/inbox");
    return { state: "INBOX", emailId, note };
  };
  if (isForwardingConfirmation(sender)) return waiting("Gmail's forwarding confirmation: open the link in it to finish setting up forwarding");

  /**
   * An unverified sender (security audit, Nov 2026): its From address is only what it says. It is not added to a
   * ticket, does not open one again, and is not matched to a contact or filed under a company by that address — it
   * waits here, flagged, for somebody to look at it and decide. Anything but `true` counts as unverified.
   */
  if (mail.senderVerified !== true) {
    return waiting(`Unverified sender: ${mail.senderCheck || "nothing shows who sent it"}. It may not be from ${sender} — check before adding it to a ticket`);
  }

  // ── 3. A reply ──────────────────────────────────────────────────────────────────────────────────
  const threadIds = [mail.inReplyTo, ...mail.references].filter((id): id is string => !!id);
  const threaded = threadIds.length
    ? await db.supportEmail.findFirst({ where: { messageId: { in: threadIds }, ticketId: { not: null } }, orderBy: { createdAt: "desc" }, select: { ticketId: true } })
    : null;
  const tagged = ticketSeqFromSubject(base.subject);
  const ticket = threaded?.ticketId
    ? await db.ticket.findUnique({ where: { id: threaded.ticketId }, include: { contact: { select: { email: true } } } })
    : tagged
      ? await db.ticket.findUnique({ where: { ticketSeq: tagged }, include: { contact: { select: { email: true } } } })
      : null;
  if (ticket) {
    const ref = formatTicketId(ticket.ticketSeq);
    if (!(await onTicket(ticket.id, ticket.contact?.email ?? null, sender))) {
      return waiting(`It answers ${ref}, from an address that isn't on that ticket`);
    }
    const reopens = ticket.status === "RESOLVED" || ticket.status === "CLOSED";
    const emailId = await keep("REPLY", { ticketId: ticket.id, contactId: ticket.contactId, note: reopens ? `${ref} opened again` : null });
    await db.ticket.update({
      where: { id: ticket.id },
      // A customer answering is activity on the ticket; answering a closed one means it isn't done.
      data: reopens ? { status: "OPEN", resolvedAt: null, closedAt: null } : { updatedAt: now },
    });
    const who = ticket.assignedToUserId ? [ticket.assignedToUserId] : await supportTeam();
    await tell(who, `${base.fromName ?? sender} replied on ${ref}`, reopens ? `${base.subject} — ${slot(await getWording(), "the ticket is open again", "ticket", "the {one:lower} is open again")}` : base.subject, ticketPath(ticket.ticketSeq));
    return { state: "REPLY", emailId, ticketSeq: ticket.ticketSeq };
  }

  // ── 4. A new ticket ─────────────────────────────────────────────────────────────────────────────
  const contacts = await db.contact.findMany({
    // Somebody who has left is no longer who the company is: their mail waits, like a stranger's.
    where: { email: { equals: sender, mode: "insensitive" }, ...STILL_THERE },
    select: { id: true, companyId: true },
    orderBy: { createdAt: "asc" },
  });
  const companies = [...new Set(contacts.map((c) => c.companyId))];
  if (companies.length > 1) return waiting(`The sender is a contact at ${companies.length} companies`);

  // Where it goes: the sender's own company, else the one company their domain belongs to.
  let place: { companyId: string; contactId: string | null; note: string | null; companyName: string | null };
  if (companies.length === 1) {
    place = { companyId: contacts[0]!.companyId, contactId: contacts[0]!.id, note: null, companyName: null };
  } else {
    // Somebody who has left speaks for nobody there — not even through their old colleagues' domain.
    const left = await db.contact.count({ where: { email: { equals: sender, mode: "insensitive" }, leftAt: { not: null } } });
    if (left > 0) return waiting("The sender has left the company they were a contact at");
    const byDomain = await companiesForSenderDomain(sender);
    if (!byDomain || byDomain.companies.length === 0) return waiting("The sender isn't a contact yet");
    if (byDomain.companies.length > 1) {
      const names = byDomain.companies.slice(0, 3).map((c) => c.name).join(", ");
      return waiting(`${byDomain.domain} is the domain of contacts at ${byDomain.companies.length} companies: ${names}${byDomain.companies.length > 3 ? "…" : ""}`);
    }
    const company = byDomain.companies[0]!;
    place = { companyId: company.id, contactId: null, note: `Filed under ${company.name} by the sender's domain, ${byDomain.domain}`, companyName: company.name };
  }

  const settings = await db.supportMailSettings.findUnique({ where: { id: "global" } });
  const agent = settings?.defaultAssigneeUserId
    ? await db.user.findFirst({
        where: { id: settings.defaultAssigneeUserId, active: true, ...PEOPLE_ONLY, department: { isSupportTeam: true } },
        select: { id: true },
      })
    : null;
  const opener = await automationUserId();
  // The files into the box before the transaction, so it holds no connection while they upload. Only those within the
  // day's budgets (security audit round three, 14 Nov 2026 — low): a new ticket kept every file, SEC-34's allowance or not.
  const filed = await toBox(attachments, base.body);
  const { ticket: made, emailId } = await db.$transaction(async (tx) => {
    const created = await tx.ticket.create({
      data: {
        companyId: place.companyId,
        contactId: place.contactId,
        title: base.subject.slice(0, 200),
        description: visiblePart(base.body).visible.slice(0, 5000) || null,
        assignedToUserId: agent?.id ?? null,
        createdByUserId: opener,
      },
      select: { id: true, ticketSeq: true, title: true },
    });
    const row = await tx.supportEmail.create({
      data: { ...base, body: filed.body, state: "NEW_TICKET", ticketId: created.id, contactId: place.contactId, note: [place.note, opts.via].filter(Boolean).join(" · ") || null, attachments: { create: filed.files } },
      select: { id: true },
    });
    await emitTicketCreated(tx, created.id, null, "email");
    return { ticket: created, emailId: row.id };
  });
  const ref = formatTicketId(made.ticketSeq);
  await recordAudit({ userId: opener, action: "CREATE", entityType: "Ticket", entityId: made.id, entityLabel: `${ref} — ${made.title} (by email from ${sender}${place.companyName ? `, filed under ${place.companyName} by its domain` : ""})` });

  if (opts.acknowledge !== false && (settings?.acknowledge ?? true)) {
    await sendSupportEmail({
      ticket: made,
      to: sender,
      sentByUserId: null,
      answering: { messageId: base.messageId, references: base.references },
      body: [
        // Security audit, 11 Nov 2026 (SEC-07): no display name — it is the sender's own words, and an
        // acknowledgement must not carry them to whoever the From names.
        "Hello,",
        "",
        `Thank you for writing to us. We've opened ticket ${ref} for your request, and we'll get back to you soon.`,
        "",
        "To add anything, just reply to this email.",
      ].join("\n"),
    });
  }
  await tell(
    agent ? [agent.id] : await supportTeam(),
    `${slot(await getWording(), "New ticket by email", "ticket", "New {one:lower} by email")}: ${ref}`,
    `${base.fromName ?? sender}: ${made.title}${place.companyName ? ` — filed under ${place.companyName} by their email's domain` : ""}`,
    ticketPath(made.ticketSeq),
  );
  return { state: "NEW_TICKET", emailId, ticketSeq: made.ticketSeq };
}
