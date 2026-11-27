"use server";

import { parseCc } from "@/lib/mail/cc";
import { writeOffsFor } from "@/lib/receivables/write-off";
import { revalidatePath } from "next/cache";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { refuseWhileViewingAs } from "@/lib/session";
import { documentAccess, mayAccess } from "@/lib/authz/access";
import { mayLogFollowUps } from "@/lib/collections/load";
import { recordAudit } from "@/lib/audit";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { formatMoney } from "@/lib/currency";
import { settleInvoice } from "@/lib/receivables";
import { RECEIVABLE_DOC_TYPE } from "@/lib/trade-documents";
import { collectionConfig } from "@/lib/collect/settings";
import { deliverReminderNow, reminderDraft } from "@/lib/collect/reminders";
import type { ActionResult } from "@/actions/company";

/**
 * Payment reminders a person decides (owner, 3 Nov 2026: "this is automated — what if individual actions are required"):
 *
 *   · Receivables › Reminders to send — the steps marked "Review first" in Settings › Payment collection wait here, for
 *     somebody to Send as they are, Edit then send, Skip, or Snooze a week.
 *   · "Remind now" beside a customer on Receivables — each overdue invoice of theirs gets the reminder whose day has
 *     come, there and then, once a day at most.
 *   · "Mail reminder" on one open invoice (owner, 6 Nov 2026), due yet or not: the same, with the words to read and change.
 *
 * For whoever follows up payments (src/lib/collections/load.ts `mayLogFollowUps`), on invoices they may open. What goes
 * comes from whoever the settings say (src/lib/collect/sender.ts), as the schedule's would.
 */

const SNOOZE_DAYS = 7;

type Gate = { user: Awaited<ReturnType<typeof requireModuleUser>>; error?: never } | { error: string; user?: never };

async function gate(): Promise<Gate> {
  const user = await requireModuleUser("receivables");
  if (!(await mayLogFollowUps(user.id))) return { error: "You don't follow up payments, so can't send or hold back reminders." };
  return { user };
}

export type AwaitingReminder = {
  key: string;
  step: string;
  stepLabel: string;
  tone: string;
  companyId: string;
  companyName: string;
  companySeq: number;
  documentId: string;
  docNumber: string | null;
  dueDate: string | null;
  daysOverdue: number;
  balance: string;
  subject: string;
  /** The subject as it would read — the invoice's number, what's left and the days late filled in. */
  preview: string;
  body: string;
  /** Edited by somebody and not sent yet. */
  edited: boolean;
  snoozedUntil: string | null;
  /** Snoozed and not back yet — shown faded. */
  snoozedNow: boolean;
  waitingSince: string;
};

/** A subject as it would read, for the list: its commonest fields filled; the send fills them all. */
const field = (name: string) => new RegExp(`[{][{][ ]*${name.replace(".", "[.]")}[ ]*([|][^}]*)?[}][}]`, "g");
const shown = (text: string, number: string | null, balance: string, days: number) =>
  text.replace(field("document.number"), number ?? "").replace(field("invoice.balance"), balance).replace(field("invoice.daysOverdue"), String(Math.max(days, 0)));

const whenLabel = (days: number) => (days < 0 ? `${-days} days before it's due` : days === 0 ? "On the due day" : `${days} days overdue`);

/** What waits for review — due now first, the snoozed after, each with the words it would go with. */
export async function remindersToSend(): Promise<{ rows: AwaitingReminder[]; snoozed: number; ready: boolean }> {
  const g = await gate();
  if (g.error !== undefined) return { rows: [], snoozed: 0, ready: true };
  let waiting;
  try {
    waiting = await db.paymentReminder.findMany({
      where: { status: "AWAITING" },
      orderBy: { createdAt: "asc" },
      take: 500,
      select: { key: true, step: true, companyId: true, documentId: true, subject: true, body: true, snoozedUntil: true, createdAt: true },
    });
  } catch (err) {
    if (notMigratedYet(err) || err instanceof Prisma.PrismaClientValidationError) return { rows: [], snoozed: 0, ready: false };
    throw err;
  }
  const ids = waiting.flatMap((w) => (w.documentId ? [w.documentId] : []));
  const [config, docs, clock] = await Promise.all([
    collectionConfig(),
    db.tradeDocument.findMany({
      where: { AND: [{ id: { in: ids }, docType: RECEIVABLE_DOC_TYPE }, await documentAccess(g.user.id, "view")] },
      select: { id: true, docNumber: true, currency: true, dueDate: true, issueDate: true, total: true, paidBefore: true, payments: { select: { amount: true } }, creditsReceived: { select: { amount: true } }, company: { select: { name: true, companySeq: true } } },
    }),
    workspaceClock(),
  ]);
  const byId = new Map(docs.map((d) => [d.id, d]));
  const writtenOff = await writeOffsFor(docs.map((d) => d.id));
  const today = clock.calendarDate(new Date()).getTime();
  const sum = (r: { amount: Prisma.Decimal }[]) => r.reduce((t, x) => t + Number(x.amount), 0);
  const rows: AwaitingReminder[] = [];
  let snoozed = 0;
  for (const w of waiting) {
    const doc = w.documentId ? byId.get(w.documentId) : undefined;
    if (!doc) continue;
    if (w.snoozedUntil && w.snoozedUntil.getTime() > Date.now()) snoozed += 1;
    const step = config.steps.find((s) => s.key === w.step);
    const due = doc.dueDate ?? doc.issueDate;
    const balanceText = formatMoney(settleInvoice(Number(doc.total), sum(doc.payments), sum(doc.creditsReceived) + (writtenOff.get(doc.id) ?? 0), Number(doc.paidBefore)).balance, doc.currency);
    rows.push({
      key: w.key,
      step: w.step,
      stepLabel: step ? whenLabel(step.days) : w.step,
      tone: step?.tone ?? "friendly",
      companyId: w.companyId,
      companyName: doc.company.name,
      companySeq: doc.company.companySeq,
      documentId: doc.id,
      docNumber: doc.docNumber,
      dueDate: formatCalendarDay(due),
      daysOverdue: Math.round((today - due.getTime()) / 86_400_000),
      balance: balanceText,
      subject: w.subject ?? step?.subject ?? "",
      preview: shown(w.subject ?? step?.subject ?? "", doc.docNumber, balanceText, Math.round((today - due.getTime()) / 86_400_000)),
      body: w.body ?? step?.body ?? "",
      edited: w.subject !== null || w.body !== null,
      snoozedUntil: w.snoozedUntil ? w.snoozedUntil.toISOString() : null,
      snoozedNow: !!w.snoozedUntil && w.snoozedUntil.getTime() > Date.now(),
      waitingSince: w.createdAt.toISOString(),
    });
  }
  rows.sort((a, b) => Number(a.snoozedNow) - Number(b.snoozedNow) || b.daysOverdue - a.daysOverdue);
  return { rows, snoozed, ready: true };
}

/** One waiting reminder this person may decide: theirs to open, still waiting. */
async function waitingRow(userId: string, key: string) {
  const row = await db.paymentReminder.findUnique({ where: { key: String(key ?? "") }, select: { key: true, status: true, step: true, companyId: true, documentId: true, subject: true, body: true } });
  if (!row || row.status !== "AWAITING" || !row.documentId) return null;
  const seen = await db.tradeDocument.findFirst({ where: { AND: [{ id: row.documentId }, await documentAccess(userId, "view")] }, select: { id: true } });
  return seen ? row : null;
}

/** Sends a waiting reminder — as it is, or with the words given (which are kept, so a failure keeps the edit). */
export async function sendAwaitingReminder(key: string, words?: { subject?: string; body?: string; cc?: string }): Promise<ActionResult<{ sentTo: string }>> {
  const g = await gate();
  if (g.error !== undefined) return { ok: false, error: g.error };
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  const row = await waitingRow(g.user.id, key);
  if (!row) return { ok: false, error: "That reminder isn't waiting any more." };
  const subject = words?.subject?.trim().slice(0, 200) || row.subject;
  const body = words?.body?.trim().slice(0, 10_000) || row.body;
  // Copied (owner, 16 Nov 2026: "add cc") — checked before anything is claimed.
  const copied = parseCc(typeof words?.cc === "string" ? words.cc.slice(0, 1000) : "");
  if (!copied.ok) return { ok: false, error: copied.error };
  if (words) await db.paymentReminder.update({ where: { key: row.key }, data: { subject, body } });
  // Claimed before it goes: a second click, or a colleague's, finds it taken.
  const claimed = await db.paymentReminder.updateMany({ where: { key: row.key, status: "AWAITING" }, data: { status: "PENDING", decidedByUserId: g.user.id } });
  if (claimed.count === 0) return { ok: false, error: "Somebody else just dealt with it." };
  const outcome = await deliverReminderNow({ documentId: row.documentId!, stepKey: row.step, subject, body, cc: copied.cc });
  // A send that failed goes back to wait, the error said, so it can be tried again or skipped.
  await db.paymentReminder.update({
    where: { key: row.key },
    data: outcome.status === "FAILED" ? { status: "AWAITING", error: outcome.error?.slice(0, 500) ?? null } : { status: outcome.status, sentTo: outcome.sentTo ?? null, error: outcome.error?.slice(0, 500) ?? null, sentAt: outcome.status === "SENT" ? new Date() : null },
  });
  if (outcome.status !== "SENT") return { ok: false, error: outcome.error ?? "It wasn't sent." };
  await recordAudit({ userId: g.user.id, action: "UPDATE", entityType: "Company", entityId: row.companyId, entityLabel: `Payment reminder (${row.step}) sent after review${words ? ", edited" : ""} — ${outcome.sentTo}` });
  revalidatePath("/receivables/reminders");
  return { ok: true, data: { sentTo: outcome.sentTo ?? "" } };
}

/** Skips a waiting reminder for good: this step won't go for this invoice; later steps still will. */
export async function skipAwaitingReminder(key: string): Promise<ActionResult<null>> {
  const g = await gate();
  if (g.error !== undefined) return { ok: false, error: g.error };
  const row = await waitingRow(g.user.id, key);
  if (!row) return { ok: false, error: "That reminder isn't waiting any more." };
  await db.paymentReminder.update({ where: { key: row.key }, data: { status: "SKIPPED", error: `Skipped by ${g.user.name}`, decidedByUserId: g.user.id } });
  await recordAudit({ userId: g.user.id, action: "UPDATE", entityType: "Company", entityId: row.companyId, entityLabel: `Payment reminder (${row.step}) skipped after review` });
  revalidatePath("/receivables/reminders");
  return { ok: true, data: null };
}

/** Snoozes a waiting reminder a week: off the list until then, then back to decide. */
export async function snoozeAwaitingReminder(key: string): Promise<ActionResult<{ until: string }>> {
  const g = await gate();
  if (g.error !== undefined) return { ok: false, error: g.error };
  const row = await waitingRow(g.user.id, key);
  if (!row) return { ok: false, error: "That reminder isn't waiting any more." };
  const until = new Date(Date.now() + SNOOZE_DAYS * 86_400_000);
  await db.paymentReminder.update({ where: { key: row.key }, data: { snoozedUntil: until, decidedByUserId: g.user.id } });
  revalidatePath("/receivables/reminders");
  return { ok: true, data: { until: formatCalendarDay(until) } };
}

export type InvoiceReminderDraft = { from: string; to: string[]; stepLabel: string; balance: string; subject: string; body: string; paused: string | null };

/** One open invoice this person may open, for its Mail reminder. */
async function reachableInvoice(userId: string, documentId: string) {
  return db.tradeDocument.findFirst({
    where: { AND: [{ id: String(documentId ?? ""), docType: RECEIVABLE_DOC_TYPE }, await documentAccess(userId, "view")] },
    select: { id: true, companyId: true, docNumber: true },
  });
}

/** What the invoice's Mail reminder would send, to read and change first. */
export async function invoiceReminderDraft(documentId: string): Promise<ActionResult<InvoiceReminderDraft>> {
  const g = await gate();
  if (g.error !== undefined) return { ok: false, error: g.error };
  const invoice = await reachableInvoice(g.user.id, documentId);
  if (!invoice) return { ok: false, error: "That invoice isn't there." };
  const draft = await reminderDraft(invoice.id);
  if (!draft.ok) return draft;
  const pause = await db.paymentReminderPause.findUnique({ where: { companyId: invoice.companyId }, select: { reason: true } }).catch((err: unknown) => {
    if (notMigratedYet(err)) return null;
    throw err;
  });
  return {
    ok: true,
    data: { from: draft.from, to: draft.to, stepLabel: whenLabel(draft.daysPast), balance: draft.balance, subject: draft.subject, body: draft.body, paused: pause ? pause.reason || "no reason given" : null },
  };
}

/**
 * Sends one invoice's reminder now, with the words given. Once a day, shared with Remind now, as a customer shouldn't get
 * the same chase twice over; a send that failed can be tried again. A pause or a promise doesn't stop it: somebody chose to.
 */
export async function remindInvoiceNow(documentId: string, words?: { subject?: string; body?: string; cc?: string }): Promise<ActionResult<{ sentTo: string }>> {
  const g = await gate();
  if (g.error !== undefined) return { ok: false, error: g.error };
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  // Copied (owner, 16 Nov 2026: "add cc") — checked before today's reminder is claimed.
  const copied = parseCc(typeof words?.cc === "string" ? words.cc.slice(0, 1000) : "");
  if (!copied.ok) return { ok: false, error: copied.error };
  const invoice = await reachableInvoice(g.user.id, documentId);
  if (!invoice) return { ok: false, error: "That invoice isn't there." };
  const clock = await workspaceClock();
  const key = `${invoice.id}:now:${clock.dateKey(new Date())}`;
  try {
    await db.paymentReminder.create({ data: { key, companyId: invoice.companyId, documentId: invoice.id, step: "now", decidedByUserId: g.user.id } });
  } catch (err) {
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    const again = await db.paymentReminder.updateMany({ where: { key, status: { in: ["FAILED", "SKIPPED"] } }, data: { status: "PENDING", decidedByUserId: g.user.id } });
    if (again.count === 0) return { ok: false, error: "It has already had a reminder today." };
  }
  const outcome = await deliverReminderNow({ documentId: invoice.id, subject: words?.subject?.trim().slice(0, 200) || null, body: words?.body?.trim().slice(0, 10_000) || null, cc: copied.cc });
  await db.paymentReminder.update({
    where: { key },
    data: { status: outcome.status, step: outcome.step ? `now:${outcome.step}` : "now", sentTo: outcome.sentTo ?? null, error: outcome.error?.slice(0, 500) ?? null, sentAt: outcome.status === "SENT" ? new Date() : null },
  });
  if (outcome.status !== "SENT") return { ok: false, error: outcome.error ?? "It wasn't sent." };
  await recordAudit({ userId: g.user.id, action: "UPDATE", entityType: "Company", entityId: invoice.companyId, entityLabel: `Payment reminder mailed for ${invoice.docNumber ?? "an invoice"}` });
  revalidatePath("/receivables");
  revalidatePath("/receivables/reminders");
  return { ok: true, data: { sentTo: outcome.sentTo ?? "" } };
}

/**
 * "Remind now" for one customer: each open invoice past its due date gets the reminder whose day has come for it, now —
 * once a day per invoice, whatever the schedule, a pause or a promise (somebody chose to). Says what went and what didn't.
 */
export async function remindCustomerNow(companyId: string): Promise<ActionResult<{ sent: number; failed: string[] }>> {
  const g = await gate();
  if (g.error !== undefined) return { ok: false, error: g.error };
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { ok: false, error: viewing };
  const id = String(companyId ?? "");
  if (!id || !(await mayAccess(g.user.id, "companies", "view", id))) return { ok: false, error: "Customer not found." };
  const clock = await workspaceClock();
  const today = clock.calendarDate(new Date());
  const invoices = await db.tradeDocument.findMany({
    where: { AND: [{ companyId: id, docType: RECEIVABLE_DOC_TYPE, status: { in: ["ISSUED", "PARTIALLY_PAID"] }, OR: [{ dueDate: { lt: today } }, { dueDate: null, issueDate: { lt: today } }] }, await documentAccess(g.user.id, "view")] },
    orderBy: { dueDate: "asc" },
    take: 25,
    select: { id: true, docNumber: true },
  });
  if (invoices.length === 0) return { ok: false, error: "Nothing of theirs is overdue." };
  let sent = 0;
  const failed: string[] = [];
  for (const invoice of invoices) {
    const key = `${invoice.id}:now:${clock.dateKey(new Date())}`;
    try {
      await db.paymentReminder.create({ data: { key, companyId: id, documentId: invoice.id, step: "now", decidedByUserId: g.user.id } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        failed.push(`${invoice.docNumber ?? "An invoice"}: already reminded today`);
        continue;
      }
      throw err;
    }
    const outcome = await deliverReminderNow({ documentId: invoice.id });
    await db.paymentReminder.update({ where: { key }, data: { status: outcome.status, step: outcome.step ? `now:${outcome.step}` : "now", sentTo: outcome.sentTo ?? null, error: outcome.error?.slice(0, 500) ?? null, sentAt: outcome.status === "SENT" ? new Date() : null, attempts: 1 } });
    if (outcome.status === "SENT") sent += 1;
    else failed.push(`${invoice.docNumber ?? "An invoice"}: ${outcome.error ?? "not sent"}`);
  }
  if (sent > 0) await recordAudit({ userId: g.user.id, action: "UPDATE", entityType: "Company", entityId: id, entityLabel: `Payment reminder sent now for ${sent} invoice${sent === 1 ? "" : "s"}` });
  revalidatePath("/receivables");
  return { ok: true, data: { sent, failed } };
}
