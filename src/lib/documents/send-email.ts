import { randomBytes } from "crypto";
import type { Prisma } from "@prisma/client";
import { emailRouteFor } from "@/lib/marketing/pipeline";
import { documentThread, headersFor, rememberSent, replySubject } from "@/lib/documents/mail-thread";
import { db } from "@/lib/db";
import { parseEmailAddress } from "@/lib/email-verification";
import { allMailBlockFor } from "@/lib/mail-blocks";
import { STILL_THERE } from "@/lib/contacts/left";
import { contactScope } from "@/lib/authz/contact-access";
import { contactMasker } from "@/lib/contacts/masking";
import { recordAudit } from "@/lib/audit";
import { getBranding } from "@/actions/branding";
import { getOrganisation } from "@/lib/organisation";
import { formatMoney } from "@/lib/currency";
import { formatCalendarDay } from "@/lib/time/zone";
import { tradeDocumentLabels } from "@/lib/trade-documents";
import { approvalDocumentFor, approvalPolicyFor } from "@/lib/documents/approval-policy";
import { approvalRequirement } from "@/lib/documents/approval";
import { canSend } from "@/lib/marketing/suppression";
import { allMailBlocksAmong, blockedReason } from "@/lib/calendar/invitees";
import { mintRenderGrant } from "@/lib/documents/render-grant";
import { RENDER_PARAM } from "@/lib/documents/render-token";
import { PDF_MAX_BYTES, PdfError, renderPdf } from "@/lib/documents/pdf";
import { mailboxState } from "@/lib/mail/mailbox";
import { documentSender, sendDocumentMail, type SenderChoice } from "@/lib/documents/mail-route";
import { allowanceRefusal, deskzoAllowance, recordDeskzoSend, releaseDeskzoSend, reserveDeskzoSend } from "@/lib/documents/deskzo-mail-allowance";
import { MAIL_NAMES, SIGN_IN_NAMES, sayEither } from "@/lib/workplace/providers";
import { DEFAULT_TEMPLATES, attachmentName, isEmailable, mergeTemplate, recipientNames, toEmailHtml, type EmailableType, type MergeValues } from "@/lib/documents/email-template";
import { renderTarget } from "@/lib/tenancy/render-target";
import type { findTradeDocumentFor } from "@/lib/documents/load";

/**
 * Emailing a document to the customer — the one way it is done, from the Mail button on a document
 * (src/actions/document-mail.ts) or by a workflow's step (src/lib/automate/actions/document-email.ts).
 * Whether the person may send documents at all, and reaches this one, is the caller's question; this is
 * what a send is, in two parts:
 *
 *   · `prepareDocumentSend` — everything that can refuse it before anything is made: a document that
 *     is issued, approved if it must be, and emailable; this customer's own contacts, each able to
 *     receive it; the words merged; a way to send it; and today's allowance through Deskzo's mail.
 *   · `deliverDocumentSend` — the PDF from the document's own print page, the send, and the log: one
 *     row per person on the document's mail log, the document's last-emailed time, and the audit.
 */

export const MAX_RECIPIENTS = 10;
export const SUBJECT_MAX = 200;
export const BODY_MAX = 10_000;

export type EmailDoc = NonNullable<Awaited<ReturnType<typeof findTradeDocumentFor>>>;

/** Why this document can't go out as it is, or null. */
export async function unsendable(doc: EmailDoc): Promise<string | null> {
  if (!isEmailable(doc.docType)) return `A ${tradeDocumentLabels[doc.docType].toLowerCase()} isn't emailed to a customer from here.`;
  if (doc.status === "DRAFT") return "Issue it first — a draft has no number yet, and the customer would be sent a preview.";
  if (doc.status === "CANCELLED") return "It's cancelled. Send the document that replaced it instead.";
  // Sign-off is asked for before a document is issued, and an issued one can't be edited — so an issued document is
  // past it: approved, or issued before approval applied to it (an older invoice, an import, one brought from Zoho).
  // Asking it again refused to email an invoice already registered with the GST portal (owner, 3 Nov 2026). Only a
  // request still open or sent back stops it.
  if (doc.approvalStatus === "PENDING" || doc.approvalStatus === "REJECTED") {
    const [policy, facts] = await Promise.all([approvalPolicyFor(doc.docType), approvalDocumentFor(doc.id)]);
    const needsSignOff = facts ? approvalRequirement(policy, facts).required : policy.enabled;
    if (needsSignOff) return "It's waiting for approval. It can be emailed once it's approved.";
  }
  return null;
}

export async function mergeValuesFor(doc: EmailDoc, senderId: string): Promise<MergeValues> {
  const [sender, org, branding] = await Promise.all([
    db.user.findUnique({ where: { id: senderId }, select: { name: true, email: true, phone: true } }),
    getOrganisation(),
    getBranding(),
  ]);
  // A document's dates are calendar days, held as midnight UTC: the day typed, in any zone.
  const day = (d: string | Date | null | undefined) => (d ? formatCalendarDay(d) : null);
  return {
    "customer.name": doc.company.name,
    "document.type": tradeDocumentLabels[doc.docType],
    "document.number": doc.docNumber,
    "document.date": day(doc.issueDate),
    "document.total": formatMoney(doc.total, doc.currency),
    "document.dueDate": day(doc.dueDate),
    "document.validUntil": day(doc.validUntil),
    "sender.name": sender?.name ?? null,
    "sender.email": sender?.email ?? null,
    "sender.phone": sender?.phone ?? null,
    "company.name": org.tradeName || org.legalName || branding.appName,
  };
}

export async function templateFor(docType: EmailableType): Promise<{ subject: string; body: string }> {
  const row = await db.documentEmailTemplate.findUnique({ where: { docType } });
  return row ? { subject: row.subject, body: row.body } : DEFAULT_TEMPLATES[docType];
}

/**
 * The company's contacts, each with whether mail can go to them — worked out before anybody presses send.
 *
 * Given the person it goes out as, only the contacts they may see (owner, 3 Nov 2026 — Phase 2 permission fixes,
 * audit H-4): `contacts.view` and the Contacts record level (`contactScope`), as the company's Contacts tab asks. A
 * send always asks it of its sender (`prepareDocumentSend`), so somebody whose role has Contacts at None can't mail
 * the people they can't see, and one outside their level answers as somebody else's contact does. A list shown to a
 * person — the Mail and statement dialogs — must pass them too; without one it is the company's whole list.
 */
export async function recipientsFor(companyId: string, forUserId?: string) {
  const reach: Prisma.ContactWhereInput = forUserId ? await contactScope(forUserId) : {};
  const [company, contacts] = await Promise.all([
    db.company.findUnique({ where: { id: companyId }, select: { managedByResellerId: true } }),
    db.contact.findMany({
      // Not anybody who has left the company: an invoice to a former employee is a leak.
      where: { AND: [{ companyId, ...STILL_THERE }, reach] },
      orderBy: [{ receivesDocuments: "desc" }, { isPrimary: "desc" }, { name: "asc" }],
      select: { id: true, name: true, email: true, phone: true, designation: true, isPrimary: true, receivesDocuments: true, emailStatus: true, emailCheckedValue: true },
    }),
  ]);
  const addresses = contacts.map((c) => c.email?.trim().toLowerCase()).filter((e): e is string => !!e);
  const domains = [...new Set(addresses.map((a) => a.split("@")[1]).filter(Boolean))];
  const now = new Date();
  // Only the suppressions a transactional mail respects — a bounce or a complaint. An unsubscribe
  // from offers does not stop somebody receiving the invoice they owe.
  const suppressions = await db.suppression.findMany({
    where: {
      reason: { in: ["HARD_BOUNCE", "COMPLAINT"] },
      OR: [
        { scope: "EMAIL", value: { in: addresses } },
        { scope: "CONTACT", value: { in: contacts.map((c) => c.id) } },
        { scope: "COMPANY", value: companyId },
        { scope: "DOMAIN", value: { in: domains } },
      ],
      AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
    },
    select: { scope: true, value: true, reason: true },
  });
  // Security audit round two, 13 Nov 2026 (R2-17): and Settings › Blocked addresses ("never mail them"), which only a
  // send checked — shown here, so the dialog says which contact is left out and why.
  const blocked = await allMailBlocksAmong(addresses);

  return contacts.map((c) => {
    const address = c.email?.trim().toLowerCase() ?? null;
    const domain = address?.split("@")[1] ?? null;
    const block = address ? blocked.get(address) : undefined;
    if (block) {
      return { id: c.id, name: c.name, email: c.email, designation: c.designation, isPrimary: c.isPrimary, receivesDocuments: c.receivesDocuments, canReceive: false, blockedBecause: blockedReason(block) };
    }
    const verdict = canSend(
      {
        company: { managedByResellerId: company?.managedByResellerId ?? null },
        contact: { email: c.email, phone: c.phone, emailStatus: c.emailStatus, emailCheckedValue: c.emailCheckedValue },
        suppressions: suppressions
          .filter(
            (s) =>
              (s.scope === "EMAIL" && s.value === address) ||
              (s.scope === "CONTACT" && s.value === c.id) ||
              s.scope === "COMPANY" ||
              (s.scope === "DOMAIN" && s.value === domain),
          )
          .map((s) => ({ reason: s.reason })),
        consent: null,
        signals: { unansweredFeedback: 0, daysOverdue: null, breachedTickets: 0, sentInLastWeek: 0 },
      },
      // Transactional: only the hard stops apply. Topic and limits are the marketing half, unused here.
      { messageClass: "TRANSACTIONAL", channel: "EMAIL", topic: "SERVICE", limits: { maxPerContactPerWeek: 0, overdueDaysBlock: 0, requireVerifiedAddress: false } },
    );
    return {
      id: c.id,
      name: c.name,
      email: c.email,
      designation: c.designation,
      isPrimary: c.isPrimary,
      receivesDocuments: c.receivesDocuments,
      canReceive: verdict.ok,
      blockedBecause: verdict.ok ? null : verdict.detail,
    };
  });
}

/**
 * The recipients as a dialog shows them to the person at it (owner, 5 Nov 2026 — Phase 3 masking fixes): each contact's
 * name and address as their contacts policy shows a contact in a list (src/lib/contacts/masking.ts) — the Mail dialog
 * (src/actions/document-mail.ts) and the statement's (src/actions/statement-send.ts). Who can receive it was worked out
 * on the real address. The send asks `recipientsFor` again and goes to the real addresses, by the contact ids ticked.
 */
export async function recipientsShownTo(companyId: string, userId: string): Promise<Awaited<ReturnType<typeof recipientsFor>>> {
  const contacts = await recipientsFor(companyId, userId);
  const m = await contactMasker(userId, "list", contacts.map((c) => c.id));
  if (!m.active) return contacts;
  return contacts.map((c) => ({ ...c, name: m.present(c.id, "name", c.name) ?? "", email: c.email === null ? null : m.present(c.id, "email", c.email) }));
}

/** Who the dialog ticks to begin with: the people who receive documents, else the primary contact. */
export function preselectedRecipients(contacts: Awaited<ReturnType<typeof recipientsFor>>): string[] {
  const ticked = contacts.filter((c) => c.receivesDocuments && c.canReceive).map((c) => c.id);
  return ticked.length > 0 ? ticked : contacts.filter((c) => c.isPrimary && c.canReceive).map((c) => c.id);
}

export type PreparedDocumentSend = {
  /** Through the company's mail server as a shared address (payment reminders from "Accounts" — src/lib/collect/sender.ts). */
  shared?: { fromName: string; fromEmail: string | null; replyTo: string };
  senderId: string;
  senderName: string;
  senderEmail: string;
  doc: EmailDoc;
  recipients: { id: string; name: string; email: string }[];
  /** Copied (owner, 16 Nov 2026: "cc option here"): this customer's contacts ticked as Cc, and addresses typed in. */
  cc: { id: string | null; name: string | null; email: string }[];
  subject: string;
  text: string;
  html: string;
  companyName: string;
  choice: Exclude<SenderChoice, "CONNECT">;
  /** Where it would have gone from, for the log when it doesn't go. */
  triedFrom: string | null;
};

export type DocumentSendInput = {
  contactIds: string[];
  subject: string;
  body: string;
  /** Copied: contacts of this customer, and any other addresses — a colleague, the customer's accounts mailbox. */
  ccContactIds?: string[];
  ccEmails?: string[];
};

/** Everything that can refuse the send before anything is made — and, when nothing does, the send ready to go. */
export async function prepareDocumentSend(
  sender: { id: string; name?: string | null; email?: string | null },
  doc: EmailDoc,
  input: DocumentSendInput,
  /** Through the company's mail server as a shared address, whatever Settings › Document emails says for people. */
  shared?: { fromName: string; fromEmail: string | null; replyTo: string },
): Promise<{ ok: true; prepared: PreparedDocumentSend } | { ok: false; error: string }> {
  const blocked = await unsendable(doc);
  if (blocked) return { ok: false, error: blocked };

  // Recipients: this customer's own contacts, each still able to receive mail.
  const wanted = [...new Set(input.contactIds.map(String))];
  if (wanted.length === 0) return { ok: false, error: "Tick at least one person to send it to." };
  if (wanted.length > MAX_RECIPIENTS) return { ok: false, error: `Send it to ${MAX_RECIPIENTS} people at most.` };
  // Only people the sender may see (audit H-4): whoever it goes out as, a person at the Mail button or a workflow's owner.
  const contacts = await recipientsFor(doc.companyId, sender.id);
  const chosen = wanted.map((id) => contacts.find((c) => c.id === id));
  if (chosen.some((c) => !c)) return { ok: false, error: "One of those people isn't a contact of this customer." };
  const refused = chosen.find((c) => !c!.canReceive);
  if (refused) return { ok: false, error: `${refused.name} can't be sent this: ${refused.blockedBecause}` };
  const recipients = (chosen as NonNullable<(typeof chosen)[number]>[]).map((r) => ({ id: r.id, name: r.name, email: r.email! }));

  // Copied: contacts by the same rules as the To line, typed addresses checked as addresses — and nobody twice.
  const ccIds = [...new Set((input.ccContactIds ?? []).map(String))].filter((id) => !wanted.includes(id));
  const ccContacts = ccIds.map((id) => contacts.find((c) => c.id === id));
  if (ccContacts.some((c) => !c)) return { ok: false, error: "One of the people copied isn't a contact of this customer." };
  const ccRefused = ccContacts.find((c) => !c!.canReceive);
  if (ccRefused) return { ok: false, error: `${ccRefused.name} can't be copied on this: ${ccRefused.blockedBecause}` };
  const cc: PreparedDocumentSend["cc"] = (ccContacts as NonNullable<(typeof ccContacts)[number]>[]).map((c) => ({ id: c.id, name: c.name, email: c.email! }));
  const taken = new Set([...recipients, ...cc].map((r) => r.email.toLowerCase()));
  for (const raw of input.ccEmails ?? []) {
    const typed = String(raw).trim();
    if (!typed) continue;
    const parsed = parseEmailAddress(typed);
    if (!parsed) return { ok: false, error: `"${typed.slice(0, 80)}" isn't an email address.` };
    const address = `${parsed.local}@${parsed.domain}`;
    if (taken.has(address)) continue;
    taken.add(address);
    cc.push({ id: null, name: null, email: address });
  }
  if (recipients.length + cc.length > MAX_RECIPIENTS) return { ok: false, error: `Send it to ${MAX_RECIPIENTS} people at most, counting those copied.` };
  const blockedCc = await allMailBlockFor(cc.filter((c) => !c.id).map((c) => c.email));
  if (blockedCc) return { ok: false, error: `${blockedCc.address} can't be copied: mail to ${blockedCc.scope === "DOMAIN" ? `${blockedCc.value}` : "that address"} is blocked${blockedCc.by ? ` by ${blockedCc.by}` : ""}.` };

  // The words: merged here, authoritatively, whatever the dialog showed.
  const values: MergeValues = { ...(await mergeValuesFor(doc, sender.id)), "recipient.names": recipientNames(recipients.map((r) => r.name)) };
  const subjectIn = input.subject.trim();
  const bodyIn = input.body.trim();
  if (!subjectIn) return { ok: false, error: "Give the email a subject." };
  if (!bodyIn) return { ok: false, error: "Write the message." };
  if (subjectIn.length > SUBJECT_MAX || bodyIn.length > BODY_MAX) return { ok: false, error: "The message is too long." };
  const subject = mergeTemplate(subjectIn, values);
  if (!subject.ok) return { ok: false, error: subject.error };
  const body = mergeTemplate(bodyIn, values);
  if (!body.ok) return { ok: false, error: body.error };
  if (/[\r\n]/.test(subject.text)) return { ok: false, error: "The subject has to be one line." };

  // A way to send it before the PDF: no point making one to find there's nothing to send it with.
  // Their own mailbox, the company's mail server, or Deskzo's — as the company chose (Settings → Document emails).
  const mailbox = await mailboxState(sender.id);
  const route = shared ? await sharedRoute() : await documentSender(mailbox);
  if (!route) return { ok: false, error: "There's no company mail server to send from the shared address — set one up in Settings › Messaging, or send reminders as a person." };
  if (route.choice === "CONNECT") {
    return {
      ok: false,
      // Only a mailbox the company offers but this person hasn't connected (or that broke) is CONNECT.
      error:
        mailbox.state === "broken"
          ? `${SIGN_IN_NAMES[mailbox.provider]} stopped accepting your ${MAIL_NAMES[mailbox.provider]} connection. Connect it again from My profile.`
          : mailbox.state === "not-connected"
            ? `Connect your ${sayEither(mailbox.providers.map((p) => MAIL_NAMES[p]))} first — it's what the email is sent from.`
            : "Connect your mailbox first — it's what the email is sent from.",
    };
  }

  // Deskzo's mail carries Deskzo's reputation: a day's sends are limited, per person and per company.
  if (route.choice === "DESKZO") {
    const over = allowanceRefusal(await deskzoAllowance(sender.id), recipients.length + cc.length);
    if (over) return { ok: false, error: over };
  }

  const me = await db.user.findUnique({ where: { id: sender.id }, select: { name: true, email: true } });
  return {
    ok: true,
    prepared: {
      ...(shared ? { shared } : {}),
      senderId: sender.id,
      senderName: me?.name ?? sender.name ?? "",
      senderEmail: me?.email ?? sender.email ?? "",
      doc,
      recipients,
      cc,
      subject: subject.text,
      text: body.text,
      html: toEmailHtml(body.text),
      companyName: values["company.name"] ?? "",
      choice: route.choice,
      triedFrom: route.choice === "OWN" && mailbox.state === "connected" ? mailbox.mailbox : (route.company?.fromEmail ?? null),
    },
  };
}

/** The company's mail server, as a route — null when there's none to send a shared address's mail from. */
async function sharedRoute(): Promise<{ choice: "COMPANY"; company: { fromEmail: string | null } } | null> {
  const company = await emailRouteFor("TRANSACTIONAL");
  return company ? { choice: "COMPANY", company } : null;
}

export type DocumentSent = { sentTo: string[]; copied: string[]; from: string; mailName: string; via: SenderChoice };

/**
 * The PDF, the send and the log. A failure here sent nothing; `lasting` says whether trying again could
 * help — a PDF over the size limit won't shrink.
 */
export async function deliverDocumentSend(
  prepared: PreparedDocumentSend,
  byline: string | null = null,
  /** A payment reminder, where the admin chose it: a reply in the document's email thread (src/lib/documents/mail-thread.ts). */
  options: { replyInThread?: boolean } = {},
): Promise<{ ok: true; data: DocumentSent } | { ok: false; error: string; lasting: boolean }> {
  const { doc, recipients } = prepared;
  // Every email a document goes with carries a Message-ID of ours, so a reminder can reply under it later.
  const thread = options.replyInThread ? await documentThread(doc.id) : null;
  const subject = thread ? replySubject(thread.subject) : prepared.subject;
  const headers = headersFor(prepared.senderEmail, thread);
  // The PDF, from the document's own print page, printed as the sender would see it.
  let pdf: Buffer;
  try {
    const token = await mintRenderGrant(doc.id, prepared.senderId);
    const target = await renderTarget(`/documents/${doc.id}/print?${RENDER_PARAM}=${encodeURIComponent(token)}`);
    pdf = await renderPdf(target.url, { hostRules: target.hostRules });
  } catch (e) {
    return { ok: false, error: e instanceof PdfError ? e.message : "The PDF couldn't be made. Nothing was sent.", lasting: false };
  }
  if (pdf.length > PDF_MAX_BYTES) return { ok: false, error: "The PDF is over 3 MB — too big to send this way. Nothing was sent.", lasting: true };

  // Through Deskzo's mail: its recipients counted before it goes, so sends at the same moment can't share the last of
  // the day's room (reserveDeskzoSend); given back below if it doesn't go that way after all.
  const cc = prepared.cc ?? [];
  const reserved = prepared.choice === "DESKZO" ? await reserveDeskzoSend(prepared.senderId, doc.id, recipients.length + cc.length) : null;
  if (reserved && !reserved.ok) return { ok: false, error: reserved.error, lasting: true };

  const outcome = await sendDocumentMail(prepared.choice, {
    senderUserId: prepared.senderId,
    senderName: prepared.senderName,
    senderEmail: prepared.senderEmail,
    companyName: prepared.companyName,
    to: recipients.map((r) => ({ name: r.name, email: r.email })),
    ...(cc.length ? { cc: cc.map((r) => ({ name: r.name, email: r.email })) } : {}),
    subject,
    html: prepared.html,
    text: prepared.text,
    attachment: { filename: attachmentName(tradeDocumentLabels[doc.docType], doc.docNumber), contentType: "application/pdf", content: pdf },
    thread: headers,
    ...(prepared.shared ? { shared: prepared.shared } : {}),
  });

  // Logged either way, one row per person, so the document's history and the mail log both say
  // exactly who it went to — or who it did not reach, and why.
  const now = new Date();
  await db.marketingMessage.createMany({
    data: [...recipients, ...cc].map((r) => ({
      token: randomBytes(24).toString("base64url"),
      companyId: doc.companyId,
      contactId: r.id,
      channel: "EMAIL" as const,
      messageClass: "TRANSACTIONAL" as const,
      subject,
      body: prepared.html,
      textBody: prepared.text,
      toEmail: r.email,
      status: outcome.ok ? ("SENT" as const) : ("FAILED" as const),
      error: outcome.ok ? null : outcome.error,
      scheduledFor: now,
      sentAt: outcome.ok ? now : null,
      attempts: 1,
      sentByUserId: prepared.senderId,
      tradeDocumentId: doc.id,
      fromEmail: outcome.ok ? outcome.from : prepared.triedFrom,
    })),
  });
  if (reserved?.ok && (!outcome.ok || outcome.via !== "DESKZO")) await releaseDeskzoSend(reserved.id);
  if (!outcome.ok) return { ok: false, error: outcome.error, lasting: false };
  if (outcome.via === "DESKZO" && !reserved?.ok) await recordDeskzoSend(prepared.senderId, doc.id, recipients.length + cc.length);

  await db.tradeDocument.update({ where: { id: doc.id }, data: { lastEmailedAt: now } });
  await rememberSent(doc.id, prepared.subject, headers.messageId);
  const to = recipients.map((r) => r.email);
  await recordAudit({
    userId: prepared.senderId,
    action: "UPDATE",
    entityType: "TradeDocument",
    entityId: doc.id,
    entityLabel: `${tradeDocumentLabels[doc.docType]} ${doc.docNumber ?? ""} emailed to ${to.join(", ")}${cc.length ? `, cc ${cc.map((r) => r.email).join(", ")}` : ""} from ${outcome.from} (${outcome.label})${byline ? ` ${byline}` : ""}`.slice(0, 500),
  });
  return { ok: true, data: { sentTo: to, copied: cc.map((r) => r.email), from: outcome.from, mailName: outcome.label, via: outcome.via } };
}
