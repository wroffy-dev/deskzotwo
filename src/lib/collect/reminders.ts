import { randomBytes } from "crypto";
import { writeOffsFor } from "@/lib/receivables/write-off";
import { maySeeStatement } from "@/lib/statements/print-data";
import { statementFilename, statementPdf } from "@/lib/statements/render";
import { PDF_MAX_BYTES } from "@/lib/documents/pdf";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { formatMoney } from "@/lib/currency";
import { settleInvoice } from "@/lib/receivables";
import { getOrganisation } from "@/lib/organisation";
import { getBranding } from "@/actions/branding";
import { findTradeDocumentFor } from "@/lib/documents/load";
import { deliverDocumentSend, prepareDocumentSend, preselectedRecipients, recipientsFor } from "@/lib/documents/send-email";
import { documentSender, sendDocumentMail } from "@/lib/documents/mail-route";
import { mailboxState } from "@/lib/mail/mailbox";
import { allowanceRefusal, deskzoAllowance, recordDeskzoSend } from "@/lib/documents/deskzo-mail-allowance";
import { recipientNames } from "@/lib/documents/email-template";
import { STILL_THERE } from "@/lib/contacts/left";
import { unconfirmedAmong, withConfirmed } from "@/lib/contacts/unconfirmed";
import { RECEIVABLE_DOC_TYPE } from "@/lib/trade-documents";
import { deliverNow, marketingSettings, resolveRecipients } from "@/lib/marketing/pipeline";
import { collectionConfig, msmeClaims, REMINDER_FIELDS, type CollectionConfig, type ReminderFieldKey, type ReminderStep } from "@/lib/collect/settings";
import { payLinkFor } from "@/lib/collect/links";
import { interestInputFor, msmeInterest } from "@/lib/collect/msme";
import { sendAsFor, sharedFrom, type SendAs, type SharedFrom } from "@/lib/collect/sender";
import { recentlyChased } from "@/lib/collections/chase-server";

/**
 * Payment reminders (owner, 23 Oct 2026): the schedule in Settings › Payment collection, run on the
 * heartbeat once the workspace's day is past 9 in the morning.
 *
 *   · Off until an admin switches them on. A step whose day came before that is never sent — switching on
 *     sends no backlog.
 *   · Each open invoice gets the latest step whose day has come — at most a few days late, if a day's run
 *     was missed — once, ever: claimed in the log before it goes (`PaymentReminder.key`). Earlier steps
 *     it missed aren't sent after a later one.
 *   · Not while a promise to pay it is open, nor to a customer whose reminders are paused, and never once
 *     it's settled. A promise broken lets the next step go.
 *   · Business mail, like the invoice itself (src/lib/documents/send-email.ts): an unsubscribe from offers
 *     doesn't stop it; a bounce or a complaint does. It goes as the person the settings name, the way their
 *     Mail button would send — the invoice attached, the pay-now link in the words.
 *   · On the 1st, a statement of account to each customer who owes something.
 *   · Not to a customer somebody sent a chase email in the last five days (Arjun, owner 19 Nov 2026 —
 *     src/lib/collections/chase-server.ts): one fuller email is enough; a step it held back still goes once they're over,
 *     if it's within the few days a missed step may run late.
 */

const DAY = 86_400_000;
/** Not before this hour of the workspace's day. */
const SEND_FROM_HOUR = 9;
/** A step missed by a day's run still goes this many days late; after that it's let go. */
const CATCH_UP_DAYS = 3;
/** A send that failed is tried again on later beats, up to this many tries in all. */
const MAX_ATTEMPTS = 3;

export type ReminderRunReport = { ran: boolean; reason?: string; sent: number; failed: number; skipped: number; statements: number; errors: string[]; awaiting?: number };

type Sender = { id: string; name: string; email: string | null };

const REMINDER_KEYS = new Set<string>(REMINDER_FIELDS.map((f) => f.key));
const FIELD = /\{\{\s*([a-zA-Z.]+)\s*(?:\|([^}]*))?\}\}/g;

/** A reminder's own fields filled in; the document email's fields are left for its merge. */
export function fillReminderFields(text: string, values: Partial<Record<ReminderFieldKey, string | null>>): string {
  return text.replace(FIELD, (whole, key: string, fallback: string | undefined) => {
    if (!REMINDER_KEYS.has(key)) return whole;
    const value = values[key as ReminderFieldKey]?.trim();
    return value || (fallback ?? "");
  });
}

/** Claims a send in the log: a new key, or one that failed and may be tried again. */
async function claim(key: string, data: { companyId: string; documentId: string | null; step: string }): Promise<boolean> {
  try {
    await db.paymentReminder.create({ data: { key, ...data } });
    return true;
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    const retried = await db.paymentReminder.updateMany({ where: { key, status: "FAILED", attempts: { lt: MAX_ATTEMPTS } }, data: { status: "PENDING" } });
    return retried.count === 1;
  }
}

async function settle(key: string, outcome: { status: "SENT" | "FAILED" | "SKIPPED"; sentTo?: string | null; error?: string | null; lasting?: boolean }) {
  await db.paymentReminder.update({
    where: { key },
    data: {
      status: outcome.status,
      sentTo: outcome.sentTo ?? null,
      error: outcome.error ? outcome.error.slice(0, 500) : null,
      sentAt: outcome.status === "SENT" ? new Date() : null,
      // A failure that trying again can't fix is tried no more.
      attempts: outcome.lasting ? MAX_ATTEMPTS : { increment: 1 },
    },
  });
}

/**
 * The people an invoice's reminder or a statement would go to, as the Mail button lists them — less anybody a website
 * form added to the customer and staff haven't confirmed (security audit round two, 13 Nov 2026 — R2-14): a reminder
 * picks its recipients by itself, so it must never pick a stranger who typed the customer's name.
 */
async function confirmedRecipients(companyId: string, senderId: string): Promise<Awaited<ReturnType<typeof recipientsFor>>> {
  const contacts = await recipientsFor(companyId, senderId);
  const unconfirmed = await unconfirmedAmong(contacts.map((c) => c.id));
  return unconfirmed.size ? contacts.filter((c) => !unconfirmed.has(c.id)) : contacts;
}

/** The WhatsApp template's values, in this order: name, invoice, amount, due date, pay-now link. */
export const WHATSAPP_VALUES = ["Their first names", "The invoice's number", "What's left to pay", "Its due date", "The pay-now link (or \"–\")"] as const;

async function whatsappReminder(config: CollectionConfig, companyId: string, values: string[], sender: Sender): Promise<void> {
  const template = config.whatsappTemplate?.trim();
  if (!template) return;
  // Security audit round two, 13 Nov 2026 (R2-14): nobody a website form added and staff haven't confirmed.
  const contact = await withConfirmed((confirmed) =>
    db.contact.findFirst({
      where: { companyId, phone: { not: null }, ...STILL_THERE, ...confirmed },
      orderBy: [{ receivesDocuments: "desc" }, { isPrimary: "desc" }, { createdAt: "asc" }],
      select: { id: true },
    }),
  );
  if (!contact) return;
  const [resolved] = await resolveRecipients({ contactIds: [contact.id], channel: "WHATSAPP", topic: "SERVICE", messageClass: "TRANSACTIONAL", settings: await marketingSettings() });
  if (!resolved?.verdict.ok || !resolved.recipient.phone) return;
  const r = resolved.recipient;
  const body = values.map((v) => v.replace(/\s+/g, " ").trim() || "–").join("\n");
  const sent = await deliverNow({ to: r.phone!, toName: r.name, subject: template, html: body }, "TRANSACTIONAL", { delivering: true, kind: "WHATSAPP" });
  const now = new Date();
  await db.marketingMessage.create({
    data: {
      token: randomBytes(24).toString("base64url"),
      companyId,
      contactId: r.contactId,
      channel: "WHATSAPP",
      messageClass: "TRANSACTIONAL",
      subject: template,
      body,
      toPhone: r.phone,
      status: sent.ok ? "SENT" : "FAILED",
      error: sent.ok ? null : sent.error,
      scheduledFor: now,
      sentAt: sent.ok ? now : null,
      attempts: 1,
      sentByUserId: sender.id,
    },
  });
}

type OpenInvoice = { id: string; companyId: string; docNumber: string | null; currency: string; issueDate: Date; dueDate: Date | null; balance: number };

/** One reminder for one invoice: the step's words, its fields filled, sent as the Mail button would. */
async function sendInvoiceReminder(
  invoice: OpenInvoice,
  step: ReminderStep,
  daysPast: number,
  sender: Sender,
  config: CollectionConfig,
  /** From the shared collections address (src/lib/collect/sender.ts), not the sender's own. */
  shared?: SharedFrom,
  /** Copied — typed by a person sending it by hand (owner, 16 Nov 2026: "add cc"); never by the schedule. */
  cc: string[] = [],
): Promise<{ status: "SENT" | "FAILED" | "SKIPPED"; sentTo?: string; error?: string; lasting?: boolean }> {
  const doc = await findTradeDocumentFor(sender.id, invoice.id);
  if (!doc) return { status: "FAILED", error: `${sender.name} can't open this invoice, so it can't go out in their name. Choose someone who sees every invoice to send reminders.`, lasting: true };
  // Only people the sender may see (owner, 3 Nov 2026 — Phase 2 permission fixes, audit H-4), as the Mail button asks.
  const contacts = preselectedRecipients(await confirmedRecipients(invoice.companyId, sender.id));
  if (contacts.length === 0) return { status: "SKIPPED", error: "Nobody at the customer can be emailed — no contact who receives documents, or the primary contact, with a working address.", lasting: true };

  // The pay-now line, where a gateway is connected — for an invoice in another currency, one that takes international
  // payments (owner, 30 Oct 2026). Where there's no link, the line is simply left out.
  const link = await payLinkFor(invoice.id, null);
  const url = link?.ok ? link.link.url : null;
  // The MSMED Act line, on a final notice, for a business that can claim it.
  let interestLine: string | null = null;
  if (step.tone === "final" && msmeClaims(config)) {
    const facts = await interestInputFor(invoice.id);
    const worked = facts ? msmeInterest(facts, new Date(), config.bankRate!) : null;
    if (worked && worked.interest >= 1) {
      interestLine = `As a ${config.msmeCategory === "MICRO" ? "micro" : "small"} enterprise registered under the MSMED Act, 2006 (Udyam ${config.udyamNumber}), we are entitled under section 16 to compound interest with monthly rests at three times the RBI bank rate (${worked.rate}% a year) on payments made after the due date — ${formatMoney(worked.interest, "INR")} on this invoice so far, and growing each day it stays unpaid.`;
    }
  }
  const values: Partial<Record<ReminderFieldKey, string | null>> = {
    "invoice.balance": formatMoney(invoice.balance, invoice.currency),
    "invoice.daysOverdue": String(Math.max(daysPast, 0)),
    "payment.link": url,
    "payment.line": url ? `You can pay it online in a minute here: ${url}` : null,
    "interest.line": interestLine,
  };
  const prepared = await prepareDocumentSend(sender, doc, { contactIds: contacts, subject: fillReminderFields(step.subject, values), body: fillReminderFields(step.body, values), ccEmails: cc }, shared);
  if (!prepared.ok) return { status: "FAILED", error: prepared.error };
  // In the invoice's own email thread, where the admin chose it (Settings › Payment collection).
  const sent = await deliverDocumentSend(prepared.prepared, `by the payment reminder schedule (${step.key})`, { replyInThread: config.reminderThread });
  if (!sent.ok) return { status: "FAILED", error: sent.error, lasting: sent.lasting };

  await whatsappReminder(
    config,
    invoice.companyId,
    [recipientNames(prepared.prepared.recipients.map((r) => r.name)), invoice.docNumber ?? "", values["invoice.balance"] ?? "", invoice.dueDate ? formatCalendarDay(invoice.dueDate) : "", url ?? "–"],
    sender,
  ).catch((err) => console.error("payment reminder: WhatsApp failed", err));
  return { status: "SENT", sentTo: sent.data.sentTo.join(", ") };
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

type Outcome = { status: "SENT" | "FAILED" | "SKIPPED"; sentTo?: string; error?: string; lasting?: boolean };

/**
 * One invoice's reminder as the settings say it comes from (src/lib/collect/sender.ts) — and, where its account manager
 * can't send it (can't open the invoice, a mailbox not connected), from the person named instead.
 */
async function sendAs(invoice: OpenInvoice, step: ReminderStep, daysPast: number, as: SendAs, config: CollectionConfig, cc: string[] = []): Promise<Outcome> {
  const first = await sendInvoiceReminder(invoice, step, daysPast, as.sender, config, as.shared, cc);
  if (first.status !== "FAILED" || !as.fallback) return first;
  const second = await sendInvoiceReminder(invoice, step, daysPast, as.fallback, config, undefined, cc);
  return second.status === "SENT" ? { ...second, sentTo: `${second.sentTo} (from ${as.fallback.name} — ${as.sender.name} couldn't: ${first.error})` } : second;
}

async function daysPastDue(invoice: OpenInvoice): Promise<number> {
  const today = (await workspaceClock()).calendarDate(new Date());
  return Math.round((today.getTime() - (invoice.dueDate ?? invoice.issueDate).getTime()) / DAY);
}

/** The step a person's send goes with: the one named, else the one whose day has come (the first, before any has). */
function stepForNow(config: CollectionConfig, daysPast: number, stepKey?: string | null): ReminderStep | undefined {
  const steps = config.steps;
  return (stepKey ? steps.find((s) => s.key === stepKey) : undefined) ?? [...steps].reverse().find((s) => s.days <= daysPast) ?? steps[0];
}

/**
 * What `deliverReminderNow` would send for one invoice, before it goes: from whom, to whom, and the step's words with
 * their fields still in them, to read and change (owner, 6 Nov 2026 — the invoice's Mail reminder). No pay-now link is made.
 */
export async function reminderDraft(documentId: string): Promise<
  | { ok: true; from: string; to: string[]; stepKey: string; days: number; daysPast: number; subject: string; body: string; balance: string; companyId: string }
  | { ok: false; error: string }
> {
  const config = await collectionConfig();
  const named = config.senderUserId ? await db.user.findUnique({ where: { id: config.senderUserId }, select: { id: true, name: true, email: true, active: true } }) : null;
  if (!named?.active) return { ok: false, error: "Nobody is set to send reminders — choose someone in Settings › Payment collection." };
  const [invoice] = await openInvoices({ id: documentId }, 1);
  if (!invoice) return { ok: false, error: "It's paid, or no longer open — nothing to remind them of." };
  const daysPast = await daysPastDue(invoice);
  const step = stepForNow(config, daysPast);
  if (!step) return { ok: false, error: "There's no reminder step to send." };
  const as = await sendAsFor(config, invoice.companyId, named, await sharedFrom(config));
  const contacts = await confirmedRecipients(invoice.companyId, as.sender.id);
  const chosen = new Set(preselectedRecipients(contacts));
  return {
    ok: true,
    from: as.shared ? (as.shared.fromEmail ? `${as.shared.fromName} <${as.shared.fromEmail}>` : as.shared.fromName) : as.sender.name,
    to: contacts.filter((c) => chosen.has(c.id)).map((c) => c.email ? `${c.name} <${c.email}>` : c.name),
    stepKey: step.key,
    days: step.days,
    daysPast,
    subject: step.subject,
    body: step.body,
    balance: formatMoney(invoice.balance, invoice.currency),
    companyId: invoice.companyId,
  };
}

/**
 * A reminder sent by a person rather than the schedule (owner, 3 Nov 2026): one waiting for review, sent as it is or as
 * they edited it, or "Remind now" on Receivables — the step whose day has come for it (the first, before any has). It
 * comes from whoever the settings say, as the schedule's would; the invoice paid since is said, not chased.
 */
export async function deliverReminderNow(input: { documentId: string; stepKey?: string | null; subject?: string | null; body?: string | null; cc?: string[] }): Promise<Outcome & { step?: string }> {
  const config = await collectionConfig();
  const named = config.senderUserId ? await db.user.findUnique({ where: { id: config.senderUserId }, select: { id: true, name: true, email: true, active: true } }) : null;
  if (!named?.active) return { status: "FAILED", error: "Nobody is set to send reminders — choose someone in Settings › Payment collection.", lasting: true };
  const [invoice] = await openInvoices({ id: input.documentId }, 1);
  if (!invoice) return { status: "SKIPPED", error: "It's paid, or no longer open — nothing to remind them of.", lasting: true };
  const daysPast = await daysPastDue(invoice);
  const step = stepForNow(config, daysPast, input.stepKey);
  if (!step) return { status: "FAILED", error: "There's no reminder step to send.", lasting: true };
  const worded = { ...step, subject: input.subject?.trim() || step.subject, body: input.body?.trim() || step.body };
  const as = await sendAsFor(config, invoice.companyId, named, await sharedFrom(config));
  return { ...(await sendAs(invoice, worded, daysPast, as, config, input.cc ?? [])), step: step.key };
}

/** A customer's statement of account by email: what's open, what's late, and what it comes to. */
async function sendStatement(companyId: string, invoices: OpenInvoice[], today: Date, sender: Sender, shared?: SharedFrom): Promise<{ status: "SENT" | "FAILED" | "SKIPPED"; sentTo?: string; error?: string; lasting?: boolean }> {
  // The people its invoices go to, as the Mail button would tick them.
  // Only people the sender may see (audit H-4): a statement goes out in their name, as the Mail button would send it.
  const contacts = await confirmedRecipients(companyId, sender.id);
  const chosen = new Set(preselectedRecipients(contacts));
  const to = contacts.filter((p) => chosen.has(p.id) && p.email).map((p) => ({ id: p.id, name: p.name, email: p.email! }));
  if (to.length === 0) return { status: "SKIPPED", error: "Nobody at the customer can be emailed.", lasting: true };
  const mailbox = await mailboxState(sender.id);
  // From the shared address, the company's mail server carries it (src/lib/collect/sender.ts).
  const route = shared ? { choice: "COMPANY" as const } : await documentSender(mailbox);
  if (route.choice === "CONNECT") return { status: "FAILED", error: `${sender.name} has to connect their mailbox before statements can go out in their name.` };
  if (route.choice === "DESKZO") {
    const over = allowanceRefusal(await deskzoAllowance(sender.id), to.length);
    if (over) return { status: "FAILED", error: over };
  }
  const [org, branding] = await Promise.all([getOrganisation(), getBranding()]);
  const ours = org.tradeName || org.legalName || branding.appName;
  const currency = invoices[0]?.currency ?? "INR";
  const sameCurrency = invoices.every((i) => i.currency === currency);
  const total = invoices.reduce((t, i) => t + i.balance, 0);
  const late = invoices.filter((i) => (i.dueDate ?? i.issueDate).getTime() < today.getTime());
  const lateTotal = late.reduce((t, i) => t + i.balance, 0);
  const asOf = formatCalendarDay(today);
  const rows = invoices.map((i) => {
    const due = i.dueDate ?? i.issueDate;
    const daysLate = Math.floor((today.getTime() - due.getTime()) / DAY);
    return { number: i.docNumber ?? "—", issued: formatCalendarDay(i.issueDate), due: formatCalendarDay(due), balance: formatMoney(i.balance, i.currency), late: daysLate > 0 ? `${daysLate} days late` : "Not yet due" };
  });
  const names = recipientNames(to.map((r) => r.name));
  const summary = sameCurrency
    ? `${invoices.length} invoice${invoices.length === 1 ? " is" : "s are"} open, ${formatMoney(total, currency)} in all${lateTotal > 0 ? `, of which ${formatMoney(lateTotal, currency)} is past due` : ""}.`
    : `${invoices.length} invoices are open.`;
  const subject = `Statement of account from ${ours} — as of ${asOf}`;
  const text = [
    `Dear ${names || "Sir/Madam"},`,
    "",
    `Here is your statement with us as of ${asOf}. ${summary}`,
    "",
    ...rows.map((r) => `${r.number} · issued ${r.issued} · due ${r.due} · ${r.balance} · ${r.late}`),
    "",
    "If anything here doesn't match your books, just reply and we'll go through it together.",
    "",
    "Regards,",
    sender.name,
    ours,
  ].join("\n");
  const cell = 'style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:left"';
  const html = `<p>Dear ${esc(names || "Sir/Madam")},</p>
<p>Here is your statement with us as of ${esc(asOf)}. ${esc(summary)}</p>
<table style="border-collapse:collapse;font-size:14px"><thead><tr><th ${cell}>Invoice</th><th ${cell}>Issued</th><th ${cell}>Due</th><th ${cell}>Still to pay</th><th ${cell}></th></tr></thead><tbody>
${rows.map((r) => `<tr><td ${cell}>${esc(r.number)}</td><td ${cell}>${esc(r.issued)}</td><td ${cell}>${esc(r.due)}</td><td ${cell}>${esc(r.balance)}</td><td ${cell}>${esc(r.late)}</td></tr>`).join("\n")}
</tbody></table>
<p>If anything here doesn't match your books, just reply and we'll go through it together.</p>
<p>Regards,<br>${esc(sender.name)}<br>${esc(ours)}</p>`;

  // The statement of accounts as a PDF too, what is still open (owner, 31 Oct 2026) — as the sender may see it. Without
  // a browser to print it, or past the size limit, the email goes as before rather than not at all.
  let attachment: { filename: string; contentType: string; content: Buffer } | undefined;
  if (await maySeeStatement(sender.id, "AR", companyId)) {
    try {
      const pdf = await statementPdf(sender.id, "AR", companyId, { show: "outstanding" });
      const party = await db.company.findUnique({ where: { id: companyId }, select: { name: true } });
      if (pdf.length <= PDF_MAX_BYTES) attachment = { filename: statementFilename(party?.name ?? "statement", {}), contentType: "application/pdf", content: pdf };
    } catch (err) {
      console.error("[collect] statement PDF not attached", err instanceof Error ? err.message : err);
    }
  }
  const outcome = await sendDocumentMail(route.choice, {
    senderUserId: sender.id,
    senderName: sender.name,
    senderEmail: sender.email ?? "",
    companyName: ours,
    to: to.map((r) => ({ name: r.name, email: r.email })),
    subject,
    html,
    text,
    attachment,
    ...(shared ? { shared } : {}),
  });
  const now = new Date();
  await db.marketingMessage.createMany({
    data: to.map((r) => ({
      token: randomBytes(24).toString("base64url"),
      companyId,
      contactId: r.id,
      channel: "EMAIL" as const,
      messageClass: "TRANSACTIONAL" as const,
      subject,
      body: html,
      textBody: text,
      toEmail: r.email,
      status: outcome.ok ? ("SENT" as const) : ("FAILED" as const),
      error: outcome.ok ? null : outcome.error,
      scheduledFor: now,
      sentAt: outcome.ok ? now : null,
      attempts: 1,
      sentByUserId: sender.id,
      fromEmail: outcome.ok ? outcome.from : null,
    })),
  });
  if (!outcome.ok) return { status: "FAILED", error: outcome.error };
  if (outcome.via === "DESKZO") await recordDeskzoSend(sender.id, null, to.length);
  return { status: "SENT", sentTo: to.map((r) => r.email).join(", ") };
}

/** Open invoices, each with what's left to pay; settled ones left out. */
async function openInvoices(where: Prisma.TradeDocumentWhereInput, take: number): Promise<OpenInvoice[]> {
  const rows = await db.tradeDocument.findMany({
    where: { AND: [{ docType: RECEIVABLE_DOC_TYPE, status: { in: ["ISSUED", "PARTIALLY_PAID"] } }, where] },
    orderBy: [{ dueDate: "asc" }, { issueDate: "asc" }],
    take,
    select: {
      id: true,
      companyId: true,
      docNumber: true,
      currency: true,
      issueDate: true,
      dueDate: true,
      total: true,
      paidBefore: true,
      payments: { select: { amount: true } },
      creditsReceived: { select: { amount: true } },
    },
  });
  const sum = (r: { amount: Prisma.Decimal }[]) => r.reduce((t, x) => t + Number(x.amount), 0);
  // Written off (src/lib/receivables/write-off.ts): nothing left to remind anybody of.
  const writtenOff = await writeOffsFor(rows.map((r) => r.id));
  return rows
    .map((r) => ({
      id: r.id,
      companyId: r.companyId,
      docNumber: r.docNumber,
      currency: r.currency,
      issueDate: r.issueDate,
      dueDate: r.dueDate,
      balance: settleInvoice(Number(r.total), sum(r.payments), sum(r.creditsReceived) + (writtenOff.get(r.id) ?? 0), Number(r.paidBefore)).balance,
    }))
    .filter((r) => r.balance >= 0.5);
}

export async function runPaymentReminders(now: Date = new Date(), opts: { budgetMs?: number } = {}): Promise<ReminderRunReport> {
  const report: ReminderRunReport = { ran: false, sent: 0, failed: 0, skipped: 0, statements: 0, errors: [] };
  if (!(await moduleAvailableForTenant("receivables"))) return { ...report, reason: "the receivables module is off" };
  const config = await collectionConfig();
  if (!config.migrated || !config.remindersOn) return { ...report, reason: "reminders are off" };
  const clock = await workspaceClock();
  const parts = clock.parts(now);
  if (parts.hour < SEND_FROM_HOUR) return { ...report, reason: "before office hours" };
  const sender = config.senderUserId ? await db.user.findUnique({ where: { id: config.senderUserId }, select: { id: true, name: true, email: true, active: true } }) : null;
  if (!sender?.active) return { ...report, reason: "nobody is set to send them" };
  report.ran = true;
  report.awaiting = 0;
  // Who each customer's comes from (src/lib/collect/sender.ts): the person named, their account manager, or the shared address.
  const shared = config.senderMode === "COLLECTIONS" ? await sharedFrom(config) : null;

  const deadline = Date.now() + (opts.budgetMs ?? 60_000);
  const today = clock.calendarDate(now);
  const from = config.remindersFrom ? clock.calendarDate(config.remindersFrom) : today;
  const steps = config.steps.filter((s) => s.on);

  if (steps.length > 0) {
    const earliest = Math.min(...steps.map((s) => s.days));
    const latest = Math.max(...steps.map((s) => s.days));
    // Due on a day some step falls on today, or did in the last few days.
    const window = { gte: new Date(today.getTime() - (latest + CATCH_UP_DAYS) * DAY), lte: new Date(today.getTime() - earliest * DAY) };
    const invoices = await openInvoices({ OR: [{ dueDate: window }, { dueDate: null, issueDate: window }] }, 3000);
    const ids = invoices.map((i) => i.id);
    const [paused, promised, logged] = await Promise.all([
      db.paymentReminderPause.findMany({ where: { companyId: { in: [...new Set(invoices.map((i) => i.companyId))] } }, select: { companyId: true } }),
      db.paymentFollowUp.findMany({ where: { documentId: { in: ids }, promiseStatus: "OPEN" }, select: { documentId: true } }),
      db.paymentReminder.findMany({ where: { documentId: { in: ids }, status: { in: ["SENT", "SKIPPED"] } }, select: { key: true } }),
    ]);
    const pausedIds = new Set(paused.map((p) => p.companyId));
    const promisedIds = new Set(promised.map((p) => p.documentId));
    const done = new Set(logged.map((l) => l.key));
    const chasedIds = await recentlyChased([...new Set(invoices.map((i) => i.companyId))], now);

    for (const invoice of invoices) {
      if (Date.now() > deadline) break;
      if (pausedIds.has(invoice.companyId) || promisedIds.has(invoice.id) || chasedIds.has(invoice.companyId)) continue;
      const due = invoice.dueDate ?? invoice.issueDate;
      const daysPast = Math.round((today.getTime() - due.getTime()) / DAY);
      // The latest step whose day has come — no more than a few days ago, and not before reminders were on.
      const step = [...steps]
        .reverse()
        .find((s) => s.days <= daysPast && daysPast - s.days <= CATCH_UP_DAYS && due.getTime() + s.days * DAY >= from.getTime());
      if (!step) continue;
      const key = `${invoice.id}:${step.key}`;
      if (done.has(key)) continue;
      if (!(await claim(key, { companyId: invoice.companyId, documentId: invoice.id, step: step.key }))) continue;
      // Review first (owner, 3 Nov 2026): it waits in Receivables › Reminders to send for a person, not sent by itself.
      if (step.review) {
        const parked = await db.paymentReminder
          .update({ where: { key }, data: { status: "AWAITING" }, select: { id: true } })
          .then(() => true)
          .catch(() => false);
        if (parked) {
          report.awaiting! += 1;
          continue;
        }
        // A workspace not migrated yet for review: sent as every step was before.
      }
      try {
        const outcome = await sendAs(invoice, step, daysPast, await sendAsFor(config, invoice.companyId, sender, shared), config);
        await settle(key, outcome);
        if (outcome.status === "SENT") report.sent += 1;
        else if (outcome.status === "SKIPPED") report.skipped += 1;
        else report.failed += 1;
      } catch (err) {
        report.failed += 1;
        report.errors.push(`${invoice.docNumber}: ${err instanceof Error ? err.message : String(err)}`);
        await settle(key, { status: "FAILED", error: err instanceof Error ? err.message : String(err) }).catch(() => {});
      }
    }
  }

  // The statement, on the 1st of the month.
  if (config.statementOn && parts.day === 1 && Date.now() <= deadline) {
    const month = clock.monthKey(now);
    const open = await openInvoices({}, 20_000);
    const byCompany = new Map<string, OpenInvoice[]>();
    for (const i of open) byCompany.set(i.companyId, [...(byCompany.get(i.companyId) ?? []), i]);
    const paused = new Set((await db.paymentReminderPause.findMany({ select: { companyId: true } })).map((p) => p.companyId));
    for (const [companyId, invoices] of byCompany) {
      if (Date.now() > deadline) break;
      if (paused.has(companyId)) continue;
      const key = `statement:${companyId}:${month}`;
      if (!(await claim(key, { companyId, documentId: null, step: "statement" }))) continue;
      try {
        const as = await sendAsFor(config, companyId, sender, shared);
        const outcome = await sendStatement(companyId, invoices, today, as.sender, as.shared);
        await settle(key, outcome);
        if (outcome.status === "SENT") report.statements += 1;
        else if (outcome.status === "FAILED") report.failed += 1;
      } catch (err) {
        report.failed += 1;
        report.errors.push(`statement ${companyId}: ${err instanceof Error ? err.message : String(err)}`);
        await settle(key, { status: "FAILED", error: err instanceof Error ? err.message : String(err) }).catch(() => {});
      }
    }
  }
  return report;
}
