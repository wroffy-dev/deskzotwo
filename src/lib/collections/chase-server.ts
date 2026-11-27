import { examplesBlock, examplesFor, noteReplied, recordDraft } from "@/lib/ai/drafts";
import { styled } from "@/lib/ai/house-style";
import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { notMigratedYet } from "@/lib/not-migrated";
import { copilotConfig } from "@/lib/copilot/settings";
import { aiTurn, AiRefusal } from "@/lib/ai/gateway";
import { countedAs } from "@/lib/customer-mail-cap";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { formatMoney } from "@/lib/currency";
import { inBatches } from "@/lib/batches";
import { settleInvoice } from "@/lib/receivables";
import { writeOffsFor } from "@/lib/receivables/write-off";
import { RECEIVABLE_DOC_TYPE } from "@/lib/trade-documents";
import { getOrganisation } from "@/lib/organisation";
import { getBranding } from "@/actions/branding";
import { mailboxState } from "@/lib/mail/mailbox";
import { documentSender, sendDocumentMail } from "@/lib/documents/mail-route";
import { allowanceRefusal, deskzoAllowance, recordDeskzoSend } from "@/lib/documents/deskzo-mail-allowance";
import { preselectedRecipients, recipientsFor, recipientsShownTo } from "@/lib/documents/send-email";
import { recipientNames } from "@/lib/documents/email-template";
import { unconfirmedAmong } from "@/lib/contacts/unconfirmed";
import { maySeeStatement } from "@/lib/statements/print-data";
import { statementFilename, statementPdf } from "@/lib/statements/render";
import { PDF_MAX_BYTES } from "@/lib/documents/pdf";
import { payLinkFor } from "@/lib/collect/links";
import { collectionConfig, msmeClaims } from "@/lib/collect/settings";
import { interestInputFor, msmeInterest } from "@/lib/collect/msme";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { inboundDomain } from "@/lib/support-mail/config";
import type { IncomingEmail } from "@/lib/support-mail/parse";
import { currentTenant } from "@/lib/tenancy/resolve";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { teammateWork } from "@/lib/ai/teammate-work";
import { CHASE_STEPS, REPLY_STEPS } from "@/lib/ai/teammate-steps";
import { noteFrom } from "@/lib/ai/teammates";
import { teammate } from "@/lib/ai/teammates-server";
import { inCollectionsScope, loadDues, type DueRow } from "@/lib/collections/load";
import { dayKey, followUpChannelLabels, shortDay } from "@/lib/collections/rules";
import {
  CHASE_SYSTEM,
  PROPOSE_CHASE,
  PROPOSE_READING,
  READ_SYSTEM,
  READING_LABELS,
  callBrief,
  chaseDues,
  chaseEmailSchema,
  chaseHtml,
  chasePrompt,
  chaseReplyAddress,
  chaseText,
  rankChases,
  readPrompt,
  readingSchema,
  scrubRemarks,
  settleReading,
  strayAmounts,
  stripQuoted,
  toneFor,
  withInvoicesPlace,
  type CallBrief,
  type ChaseItem,
  type ChaseLine,
  type ChaseTone,
  type CompanyFacts,
  type DueFact,
  type PromiseNow,
  type Reading,
} from "@/lib/collections/chase";

/**
 * Arjun, the Collections teammate (owner, 19 Nov 2026 — phases 1 and 2; the rules and the words are ./chase.ts).
 *
 *   · **Who to chase today** and **the call brief**: the person's own collections (src/lib/collections/load.ts — the
 *     accounts they manage, their team's, and orders they punched), ranked by rules. No AI, no credits.
 *   · **A chase email**: Deskzo AI drafts it when somebody presses the button, charged to them; it waits for them to read,
 *     change and send it — from their mailbox or the company's mail, as their documents go — with the invoices listed
 *     and a pay-now link on each, and the customer's statement attached. Business mail, like the schedule's reminders:
 *     an unsubscribe from offers doesn't stop it, a bounce or complaint does; counted toward the workspace's 24-hour limit
 *     on automated mail (src/lib/customer-mail-cap.ts). Each invoice in it gets a payment follow-up, so My collections
 *     shows it was chased. After one goes, the reminder schedule leaves that customer alone for five days.
 *   · **A reply** comes to the workspace's inbound address (`<slug>+c-<token>@…`), is forwarded to whoever sent the
 *     email, and on the next heartbeat Arjun reads it — a promise, a payment they say they made, a dispute, a question.
 *     The person then logs the promise, asks accounts to check the bank, pauses reminders, or sets it aside. Nothing is
 *     done with a reply by itself.
 */

const DAY = 86_400_000;
/** After a chase email, the reminder schedule leaves the customer alone this long (src/lib/collect/reminders.ts). */
export const QUIET_AFTER_CHASE_DAYS = 5;
/** The most invoices one email carries. */
const MAX_INVOICES = 15;
const READ_PER_TICK = 5;

export class ChaseRefusal extends Error {
  /** Deskzo AI said no — out of credits, paused, busy: nothing more will be drafted just now either. */
  constructor(
    message: string,
    readonly fromAi = false,
  ) {
    super(message);
  }
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ─── The facts ────────────────────────────────────────────────────────────────────────────────────────────────────

function promiseNow(p: DueRow["promise"], todayKey: string): DueFact["promise"] {
  if (!p || !p.promisedOn || !p.promiseStatus || p.promiseStatus === "SUPERSEDED") return null;
  const now: PromiseNow =
    p.promiseStatus === "KEPT" ? "kept" : p.promiseStatus === "BROKEN" || p.promisedOn < todayKey ? "broken" : p.promisedOn === todayKey ? "today" : "ahead";
  return { on: p.promisedOn, amount: p.promisedAmount, now };
}

/** The dues grouped by customer, as facts — without what needs more reading (reminders, chases, how they pay). */
function groupFacts(rows: DueRow[], todayKey: string): Map<string, CompanyFacts> {
  const out = new Map<string, CompanyFacts>();
  const seen = new Map<string, Set<string>>();
  for (const r of rows) {
    const f =
      out.get(r.companyId) ??
      ({
        companyId: r.companyId,
        companySeq: r.companySeq,
        companyName: r.companyName,
        ownerName: r.ownerName,
        onTheirAccount: r.onTheirAccount,
        dues: [],
        lastFollowUp: null,
        plannedOn: null,
        promisesKept: 0,
        promisesBroken: 0,
        paused: null,
        lastReminderAt: null,
        lastChaseAt: null,
        usualDaysLate: null,
      } satisfies CompanyFacts);
    f.onTheirAccount ||= r.onTheirAccount;
    f.dues.push({ id: r.id, kind: r.kind, label: r.label, dueOn: r.dueOn, daysLate: r.daysOverdue, balance: r.balance, currency: r.currency, balanceInr: r.balanceInr, promise: promiseNow(r.promise, todayKey) });
    const last = r.lastFollowUp;
    if (last && (!f.lastFollowUp || last.createdAt > f.lastFollowUp.at)) f.lastFollowUp = { at: last.createdAt, channel: last.channel, remarks: last.remarks, byName: last.byName };
    if (r.nextFollowUpOn && (!f.plannedOn || r.nextFollowUpOn < f.plannedOn)) f.plannedOn = r.nextFollowUpOn;
    const ids = seen.get(r.companyId) ?? new Set<string>();
    for (const h of r.history) {
      if (ids.has(h.id)) continue;
      ids.add(h.id);
      if (h.promiseStatus === "KEPT") f.promisesKept += 1;
      else if (h.promiseStatus === "BROKEN" || (h.promiseStatus === "OPEN" && h.promisedOn !== null && h.promisedOn < todayKey)) f.promisesBroken += 1;
    }
    seen.set(r.companyId, ids);
    out.set(r.companyId, f);
  }
  return out;
}

/** Typical days from due date to payment, per customer, over their invoices paid this past year (the latest 12; 3 at least). */
async function usualLateness(companyIds: string[], now: Date): Promise<Map<string, number>> {
  const since = new Date(now.getTime() - 365 * DAY);
  const rows = await inBatches(companyIds, (batch) =>
    db.tradeDocument.findMany({
      where: { companyId: { in: batch }, docType: RECEIVABLE_DOC_TYPE, status: "PAID", issueDate: { gte: since } },
      orderBy: { issueDate: "desc" },
      take: batch.length * 12,
      select: { companyId: true, dueDate: true, issueDate: true, payments: { select: { payment: { select: { paidOn: true } } } } },
    }),
  );
  const days = new Map<string, number[]>();
  for (const r of rows) {
    const paid = r.payments.map((p) => p.payment.paidOn.getTime());
    if (!paid.length) continue;
    const list = days.get(r.companyId) ?? [];
    if (list.length >= 12) continue;
    list.push(Math.max(0, Math.floor((Math.max(...paid) - (r.dueDate ?? r.issueDate).getTime()) / DAY)));
    days.set(r.companyId, list);
  }
  const out = new Map<string, number>();
  for (const [id, list] of days) {
    if (list.length < 3) continue;
    const sorted = [...list].sort((a, b) => a - b);
    out.set(id, sorted[Math.floor(sorted.length / 2)]!);
  }
  return out;
}

/** Reminders, chase emails and how they pay — laid onto these customers' facts. */
async function fillFacts(facts: CompanyFacts[], now: Date): Promise<void> {
  const ids = facts.map((f) => f.companyId);
  if (!ids.length) return;
  const [reminders, chases, usual] = await Promise.all([
    inBatches(ids, (batch) => db.paymentReminder.groupBy({ by: ["companyId"], where: { companyId: { in: batch }, status: "SENT" }, _max: { sentAt: true } })),
    inBatches(ids, (batch) => db.collectionChase.groupBy({ by: ["companyId"], where: { companyId: { in: batch }, status: "SENT" }, _max: { sentAt: true } })).catch((err) => {
      if (notMigratedYet(err)) return [];
      throw err;
    }),
    usualLateness(ids, now),
  ]);
  const reminded = new Map(reminders.map((r) => [r.companyId, r._max.sentAt]));
  const chased = new Map(chases.map((r) => [r.companyId, r._max.sentAt]));
  for (const f of facts) {
    f.lastReminderAt = reminded.get(f.companyId) ?? null;
    f.lastChaseAt = chased.get(f.companyId) ?? null;
    f.usualDaysLate = usual.get(f.companyId) ?? null;
  }
}

async function pausesOf(ids: string[]): Promise<Map<string, string | null>> {
  const rows = await inBatches(ids, (batch) => db.paymentReminderPause.findMany({ where: { companyId: { in: batch } }, select: { companyId: true, reason: true } }));
  return new Map(rows.map((r) => [r.companyId, r.reason]));
}

/** One customer's facts as this person may see them, or null when nothing of it is theirs to chase. */
export async function factsOf(userId: string, companyId: string, now = new Date()): Promise<CompanyFacts | null> {
  const clock = await workspaceClock();
  const { rows } = await loadDues(userId, { now });
  const mine = rows.filter((r) => r.companyId === companyId);
  if (!mine.length) return null;
  const f = groupFacts(mine, dayKey(clock.calendarDate(now))).get(companyId)!;
  const paused = await pausesOf([companyId]);
  f.paused = paused.has(companyId) ? { reason: paused.get(companyId) ?? null } : null;
  await fillFacts([f], now);
  return f;
}

export type ChaseList = { items: (ChaseItem & { brief: CallBrief })[]; considered: number };

/**
 * Who this person should chase today, most pressing first, each with its call brief. Ranked twice: first on the dues
 * alone across everybody in their collections, then — for the few that came top — again with the reminders, chase
 * emails and payment habits read in, so the reading stays small however many customers owe.
 */
export async function chaseListFor(userId: string, now = new Date(), take = 8): Promise<ChaseList> {
  const clock = await workspaceClock();
  const today = clock.calendarDate(now);
  const { rows } = await loadDues(userId, { now });
  const grouped = groupFacts(rows, dayKey(today));
  const paused = await pausesOf([...grouped.keys()]);
  for (const [id, f] of grouped) if (paused.has(id)) f.paused = { reason: paused.get(id) ?? null };
  const first = rankChases([...grouped.values()], today, now, take * 4);
  const shortlist = first.map((i) => grouped.get(i.companyId)!);
  await fillFacts(shortlist, now);
  const items = rankChases(shortlist, today, now, take).map((i) => ({ ...i, brief: callBrief(grouped.get(i.companyId)!, today, now) }));
  return { items, considered: grouped.size };
}

// ─── Drafting ─────────────────────────────────────────────────────────────────────────────────────────────────────

type OpenInvoice = { id: string; number: string; currency: string; issueDate: Date; dueDate: Date | null; balance: number };

/** The invoices among `ids` still owed on, each with what's left — write-offs counted, as the schedule counts them. */
async function openInvoicesAmong(ids: string[]): Promise<OpenInvoice[]> {
  if (!ids.length) return [];
  const rows = await db.tradeDocument.findMany({
    where: { id: { in: ids }, docType: RECEIVABLE_DOC_TYPE, status: { notIn: ["DRAFT", "CANCELLED", "PAID"] } },
    orderBy: [{ dueDate: "asc" }, { issueDate: "asc" }],
    select: { id: true, docNumber: true, currency: true, issueDate: true, dueDate: true, total: true, paidBefore: true, payments: { select: { amount: true } }, creditsReceived: { select: { amount: true } } },
  });
  const sum = (r: { amount: Prisma.Decimal }[]) => r.reduce((t, x) => t + Number(x.amount), 0);
  const off = await writeOffsFor(rows.map((r) => r.id));
  return rows
    .map((r) => ({
      id: r.id,
      number: r.docNumber ?? "—",
      currency: r.currency,
      issueDate: r.issueDate,
      dueDate: r.dueDate,
      balance: settleInvoice(Number(r.total), sum(r.payments), sum(r.creditsReceived) + (off.get(r.id) ?? 0), Number(r.paidBefore)).balance,
    }))
    .filter((r) => r.balance >= 0.5);
}

const lateWords = (days: number) => (days > 0 ? `${plural(days, "day", "days")} late` : days === 0 ? "due today" : `due in ${plural(-days, "day", "days")}`);

/** Totals per currency, formatted: "₹1,20,000.00" or "₹1,20,000.00 and $2,000.00". */
function totalsOf(list: { balance: number; currency: string }[]): string[] {
  const by = new Map<string, number>();
  for (const i of list) by.set(i.currency, (by.get(i.currency) ?? 0) + i.balance);
  return [...by].map(([c, n]) => formatMoney(Math.round(n * 100) / 100, c));
}

/**
 * Arjun drafts a chase email to a customer about its overdue invoices — those in this person's collections — in the
 * tone asked for, or the one the facts call for. It waits for them to check; an earlier draft of theirs for the same
 * customer is set aside. Throws ChaseRefusal with words. Returns the draft's id.
 *
 * `chargeTo`: who the model turn is charged to, when not the person it's for — Arjun drafting by himself for an
 * account manager who may not use Deskzo AI, on the credits of whoever switched him on (./arjun-auto.ts).
 */
export async function draftChase(userId: string, companyId: string, wanted: ChaseTone | null, now = new Date(), opts: { chargeTo?: string } = {}): Promise<string> {
  const f = await factsOf(userId, companyId, now);
  if (!f) throw new ChaseRefusal("Nothing is owed on this customer that's yours to chase.");
  if (f.paused) throw new ChaseRefusal(`Reminders are paused for ${f.companyName}${f.paused.reason ? ` (${f.paused.reason})` : ""} — resume them on the customer's Statement tab first.`);
  const dueIds = chaseDues(f)
    .filter((d) => d.kind === "invoice")
    .map((d) => d.id);
  const invoices = (await openInvoicesAmong(dueIds)).slice(0, MAX_INVOICES);
  if (!invoices.length) throw new ChaseRefusal(`Nothing on an invoice is overdue for ${f.companyName}. An order not invoiced yet is better chased by a call.`);
  const clock = await workspaceClock();
  const today = clock.calendarDate(now);
  const daysLate = (i: OpenInvoice) => Math.round((today.getTime() - (i.dueDate ?? i.issueDate).getTime()) / DAY);
  const tone = wanted ?? toneFor(f);

  // Not yet due, on invoices — said as a total, not chased.
  const ahead = f.dues.filter((d) => d.kind === "invoice" && !dueIds.includes(d.id));
  const notYetDue = ahead.length ? `${totalsOf(ahead).join(" and ")} on ${plural(ahead.length, "invoice", "invoices")}` : null;
  const broken = f.dues.find((d) => d.promise?.now === "broken" && dueIds.includes(d.id));
  const promise = broken
    ? { amount: broken.promise!.amount !== null ? formatMoney(broken.promise!.amount, broken.currency) : null, on: shortDay(broken.promise!.on), broken: true }
    : null;
  const [earlier, remindersSent, org] = await Promise.all([
    db.collectionChase.findMany({ where: { companyId, status: "SENT", sentAt: { gte: new Date(now.getTime() - 90 * DAY) } }, orderBy: { sentAt: "desc" }, take: 3, select: { subject: true, sentAt: true } }),
    db.paymentReminder.count({ where: { documentId: { in: invoices.map((i) => i.id) }, status: "SENT" } }),
    getOrganisation(),
  ]);
  const totals = totalsOf(invoices);
  const lines = invoices.map((i) => ({ number: i.number, due: formatCalendarDay(i.dueDate ?? i.issueDate), daysLate: daysLate(i), balance: formatMoney(i.balance, i.currency) }));
  const prompt = chasePrompt({
    ours: org.tradeName || org.legalName || "our company",
    companyName: f.companyName,
    tone,
    invoices: lines,
    totals,
    notYetDue,
    promise,
    promisesKept: f.promisesKept,
    lastSaid: f.lastFollowUp ? { on: shortDay(f.lastFollowUp.at.toISOString()), channel: followUpChannelLabels[f.lastFollowUp.channel].toLowerCase(), remarks: scrubRemarks(f.lastFollowUp.remarks) } : null,
    usualDaysLate: f.usualDaysLate,
    earlier: earlier.map((e) => ({ subject: e.subject, daysAgo: Math.max(0, Math.floor((now.getTime() - (e.sentAt ?? now).getTime()) / DAY)) })),
    remindersSent,
  });
  // Every amount the email may say: the invoices', the totals, the promise, what's not yet due.
  const allowed = [...lines.map((l) => l.balance), ...totals, ...(promise?.amount ? [promise.amount] : []), ...(ahead.length ? totalsOf(ahead) : [])];

  return teammateWork(
    { teammate: "arjun", userId, kind: "collections.chase", subject: `company:${companyId}`, label: f.companyName, href: "/collections", steps: CHASE_STEPS },
    async (work) => {
      await work.step(1);
      // Step 2 (owner, 20 Nov 2026): a few of this team's chases that went (nearly) as written and got a reply.
      const history: Parameters<typeof aiTurn>[0]["history"] = [{ role: "user", text: prompt + examplesBlock(await examplesFor("collections.chase")) }];
      let email: { subject: string; body: string } | null = null;
      for (let attempt = 0; attempt < 3 && !email; attempt++) {
        let outcome;
        try {
          outcome = await aiTurn({ userId: opts.chargeTo ?? userId, feature: "collections.email", system: await styled(CHASE_SYSTEM), history, tools: [PROPOSE_CHASE] });
        } catch (err) {
          if (err instanceof AiRefusal) throw new ChaseRefusal(err.message, true);
          throw err;
        }
        if (attempt === 0) await work.step(2);
        const call = outcome.toolCalls.find((c) => c.name === PROPOSE_CHASE.name);
        const read = call ? chaseEmailSchema.safeParse(call.input) : null;
        const stray = read?.success ? strayAmounts(`${read.data.subject}\n${read.data.body}`, allowed) : [];
        if (read?.success && stray.length === 0) {
          email = read.data;
          break;
        }
        const why = read?.success
          ? `These amounts aren't in the facts: ${stray.join(", ")}. Write it again without them — refer to "the invoices below" instead.`
          : "Call propose_email again with a subject and a body of a few sentences.";
        history.push({ role: "assistant", text: outcome.text, toolCalls: outcome.toolCalls, ...(outcome.native ? { native: { provider: outcome.family, model: outcome.model, content: outcome.native, masked: outcome.masked } } : {}) });
        if (outcome.toolCalls.length) history.push({ role: "tool", results: outcome.toolCalls.map((c) => ({ id: c.id, name: c.name, output: why, isError: true })) });
        else history.push({ role: "user", text: `${why} Call propose_email now.` });
      }
      if (!email) throw new ChaseRefusal("Arjun couldn't write an email that keeps to the amounts in your books. Try again, or write it yourself.");
      await work.step(3);
      return db.$transaction(async (tx) => {
        // One draft of theirs per customer: an earlier one is set aside.
        await tx.collectionChase.updateMany({ where: { companyId, createdById: userId, status: "WAITING" }, data: { status: "DISCARDED", error: "A newer draft replaced it." } });
        const row = await tx.collectionChase.create({
          data: { companyId, createdById: userId, tone, subject: email.subject, body: withInvoicesPlace(email.body), documentIds: invoices.map((i) => i.id), replyToken: randomBytes(12).toString("hex") },
          select: { id: true },
        });
        return row.id;
      });
    },
    () => "Your chase email is ready to check",
  );
}

// ─── The draft, as the dialog shows it ────────────────────────────────────────────────────────────────────────────

export type ChaseView = {
  id: string;
  status: string;
  companyId: string;
  companyName: string;
  tone: ChaseTone;
  subject: string;
  body: string;
  lines: { number: string; due: string; late: string; balance: string }[];
  recipients: { id: string; name: string; email: string | null; canReceive: boolean; blockedBecause: string | null; ticked: boolean }[];
  /** What it goes from, or why it can't go yet. */
  from: string | null;
  fromProblem: string | null;
  mayAttachStatement: boolean;
  notes: string[];
  mine: boolean;
};

async function loadChase(id: string) {
  return db.collectionChase.findUnique({ where: { id }, include: { company: { select: { id: true, name: true } } } });
}

/** May this person see and send this chase: theirs, or every invoice in it is in their collections. */
async function mayHandle(userId: string, chase: { createdById: string; sentById: string | null; documentIds: string[] }): Promise<boolean> {
  if (chase.createdById === userId || chase.sentById === userId) return true;
  for (const documentId of chase.documentIds) if (!(await inCollectionsScope(userId, { documentId }))) return false;
  return chase.documentIds.length > 0;
}

export async function chaseView(id: string, userId: string, now = new Date()): Promise<ChaseView | null> {
  const chase = await loadChase(id);
  if (!chase || !(await mayHandle(userId, chase))) return null;
  const clock = await workspaceClock();
  const today = clock.calendarDate(now);
  const invoices = await openInvoicesAmong(chase.documentIds);
  const contacts = await recipientsShownTo(chase.companyId, userId);
  const unconfirmed = await unconfirmedAmong(contacts.map((c) => c.id));
  const reachable = contacts.filter((c) => !unconfirmed.has(c.id));
  const ticked = new Set(preselectedRecipients(reachable));
  const route = await documentSender(await mailboxState(userId));
  const notes: string[] = [];
  const lastReminder = await db.paymentReminder.findFirst({ where: { companyId: chase.companyId, status: "SENT" }, orderBy: { sentAt: "desc" }, select: { sentAt: true } });
  if (lastReminder?.sentAt && now.getTime() - lastReminder.sentAt.getTime() < QUIET_AFTER_CHASE_DAYS * DAY) {
    notes.push(`The schedule's reminder went to them ${clock.date(lastReminder.sentAt)} — you may want to call instead.`);
  }
  if (invoices.length < chase.documentIds.length) notes.push(`${plural(chase.documentIds.length - invoices.length, "invoice has", "invoices have")} been paid since this was drafted — left out.`);
  notes.push(
    inboundDomain()
      ? "Replies come to you, and Arjun reads them for a promise, a payment or a dispute."
      : "Replies go to your mailbox — Deskzo can't catch them here, so log what they say as a follow-up.",
  );
  return {
    id: chase.id,
    status: chase.status,
    companyId: chase.companyId,
    companyName: chase.company.name,
    tone: chase.tone as ChaseTone,
    subject: chase.subject,
    body: chase.body,
    lines: invoices.map((i) => ({ number: i.number, due: formatCalendarDay(i.dueDate ?? i.issueDate), late: lateWords(Math.round((today.getTime() - (i.dueDate ?? i.issueDate).getTime()) / DAY)), balance: formatMoney(i.balance, i.currency) })),
    recipients: reachable.map((c) => ({ id: c.id, name: c.name, email: c.email, canReceive: c.canReceive, blockedBecause: c.blockedBecause, ticked: ticked.has(c.id) })),
    from: route.choice === "CONNECT" ? null : route.from,
    fromProblem: route.choice === "CONNECT" ? "Connect your mailbox first (your profile) — chase emails go from you, as your documents do." : null,
    mayAttachStatement: await maySeeStatement(userId, "AR", chase.companyId),
    notes,
    mine: chase.createdById === userId,
  };
}

// ─── Sending ──────────────────────────────────────────────────────────────────────────────────────────────────────

/** The MSMED Act line for a final notice, where the business may claim it — on these invoices together, in rupees. */
async function interestNote(invoiceIds: string[], now: Date): Promise<string | null> {
  const config = await collectionConfig();
  if (!msmeClaims(config)) return null;
  let total = 0;
  let rate = 0;
  for (const id of invoiceIds) {
    const facts = await interestInputFor(id);
    const worked = facts ? msmeInterest(facts, now, config.bankRate!) : null;
    if (worked && worked.interest >= 1) {
      total += worked.interest;
      rate = worked.rate;
    }
  }
  if (total < 1) return null;
  return `As a ${config.msmeCategory === "MICRO" ? "micro" : "small"} enterprise registered under the MSMED Act, 2006 (Udyam ${config.udyamNumber}), we are entitled under section 16 to compound interest with monthly rests at three times the RBI bank rate (${rate}% a year) on payments made after the due date — ${formatMoney(Math.round(total * 100) / 100, "INR")} on these invoices so far, and growing each day they stay unpaid.`;
}

/**
 * Sends a waiting chase as this person, as written or as they changed it, to the contacts they ticked. Throws ChaseRefusal.
 * The invoices paid since it was drafted are left out; with none left, nothing goes.
 */
export async function sendChase(
  id: string,
  userId: string,
  edited: { subject: string; body: string; contactIds: string[]; attachStatement: boolean },
  now = new Date(),
): Promise<{ to: string[] }> {
  const chase = await loadChase(id);
  if (!chase || !(await mayHandle(userId, chase))) throw new ChaseRefusal("That chase email isn't there any more.");
  if (chase.status !== "WAITING") throw new ChaseRefusal(chase.status === "SENT" ? "It has been sent already." : "That draft was set aside.");
  for (const documentId of chase.documentIds) {
    if (!(await inCollectionsScope(userId, { documentId }))) throw new ChaseRefusal("One of its invoices isn't in your collections, so it can't go out from you.");
  }
  if ((await db.paymentReminderPause.count({ where: { companyId: chase.companyId } })) > 0) throw new ChaseRefusal(`Reminders were paused for ${chase.company.name} since this was drafted — nothing sent.`);
  const subject = edited.subject.replace(/\s+/g, " ").trim().slice(0, 200);
  const body = edited.body.trim().slice(0, 6000);
  if (subject.length < 3 || body.length < 20) throw new ChaseRefusal("The email needs a subject and a few sentences.");
  const invoices = await openInvoicesAmong(chase.documentIds);
  if (!invoices.length) {
    await db.collectionChase.update({ where: { id }, data: { status: "DISCARDED", error: "Paid before it went." } });
    throw new ChaseRefusal("Every invoice in it has been paid since — nothing to chase.");
  }

  // To the ticked people the sender may see, who can receive it — as the invoice's own Mail would send.
  const contacts = await recipientsFor(chase.companyId, userId);
  const unconfirmed = await unconfirmedAmong(contacts.map((c) => c.id));
  const chosen = new Set(edited.contactIds);
  const to = contacts.filter((c) => chosen.has(c.id) && c.canReceive && c.email && !unconfirmed.has(c.id)).map((c) => ({ id: c.id, name: c.name, email: c.email! }));
  if (!to.length) throw new ChaseRefusal("Tick somebody at the customer who can receive it.");

  const sender = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, email: true } });
  if (!sender) throw new ChaseRefusal("Your account wasn't found.");
  const route = await documentSender(await mailboxState(userId));
  if (route.choice === "CONNECT") throw new ChaseRefusal("Connect your mailbox first (your profile) — chase emails go from you, as your documents do.");
  if (route.choice === "DESKZO") {
    const over = allowanceRefusal(await deskzoAllowance(userId), to.length);
    if (over) throw new ChaseRefusal(over);
  }

  const clock = await workspaceClock();
  const today = clock.calendarDate(now);
  // A pay-now link on each, where a gateway is connected; without one the line simply has none.
  const lines: ChaseLine[] = [];
  for (const i of invoices) {
    const link = await payLinkFor(i.id, userId).catch(() => null);
    const due = i.dueDate ?? i.issueDate;
    lines.push({ number: i.number, due: formatCalendarDay(due), late: lateWords(Math.round((today.getTime() - due.getTime()) / DAY)), balance: formatMoney(i.balance, i.currency), payUrl: link?.ok ? link.link.url : null });
  }
  const note = chase.tone === "final" ? await interestNote(invoices.map((i) => i.id), now) : null;
  const values = { names: recipientNames(to.map((r) => r.name)), senderName: sender.name };
  const text = chaseText(body, values, lines, note);
  const html = chaseHtml(body, values, lines, note);

  let attachment: { filename: string; contentType: string; content: Buffer } | undefined;
  if (edited.attachStatement && (await maySeeStatement(userId, "AR", chase.companyId))) {
    try {
      const pdf = await statementPdf(userId, "AR", chase.companyId, { show: "outstanding" });
      if (pdf.length <= PDF_MAX_BYTES) attachment = { filename: statementFilename(chase.company.name, {}), contentType: "application/pdf", content: pdf };
    } catch (err) {
      console.error("[chase] statement PDF not attached", err instanceof Error ? err.message : err);
    }
  }
  const [org, branding, tenant] = await Promise.all([getOrganisation(), getBranding(), currentTenant()]);
  const domain = inboundDomain();
  const outcome = await countedAs("automation", () =>
    sendDocumentMail(route.choice as Exclude<typeof route.choice, "CONNECT">, {
      senderUserId: sender.id,
      senderName: sender.name,
      senderEmail: sender.email ?? "",
      companyName: org.tradeName || org.legalName || branding.appName,
      to: to.map((r) => ({ name: r.name, email: r.email })),
      subject,
      html,
      text,
      attachment,
      ...(domain ? { replyTo: chaseReplyAddress(tenant.slug, chase.replyToken, domain) } : {}),
    }),
  );
  if (!outcome.ok) {
    await db.collectionChase.update({ where: { id }, data: { error: outcome.error.slice(0, 500) } });
    throw new ChaseRefusal(`It didn't go: ${outcome.error}`);
  }
  if (outcome.via === "DESKZO") await recordDeskzoSend(userId, null, to.length);

  await db.marketingMessage.createMany({
    data: to.map((r) => ({
      token: randomBytes(24).toString("base64url"),
      companyId: chase.companyId,
      contactId: r.id,
      channel: "EMAIL" as const,
      messageClass: "TRANSACTIONAL" as const,
      subject,
      body: html,
      textBody: text,
      toEmail: r.email,
      status: "SENT" as const,
      scheduledFor: now,
      sentAt: now,
      attempts: 1,
      sentByUserId: userId,
      fromEmail: outcome.from,
    })),
  });
  // Each invoice chased, as a follow-up — My collections shows it, and the "nobody in touch" clock starts again.
  const remarks = `Chase email sent by ${sender.name} (drafted by Arjun): ${subject}`.slice(0, 1000);
  await db.paymentFollowUp.createMany({ data: invoices.map((i) => ({ companyId: chase.companyId, documentId: i.id, byUserId: userId, channel: "EMAIL" as const, remarks })) });
  await db.collectionChase.update({
    where: { id },
    data: { status: "SENT", subject, body, documentIds: invoices.map((i) => i.id), sentById: userId, sentAt: now, sentTo: to.map((r) => r.email).join(", ").slice(0, 1000), error: null },
  });
  await recordDraft({ teammate: "arjun", kind: "collections.chase", ref: id, userId, draft: { subject: chase.subject, body: chase.body }, sent: { subject, body } });
  await recordAudit({ userId, action: "CREATE", entityType: "Company", entityId: chase.companyId, entityLabel: `Chase email sent to ${chase.company.name} about ${plural(invoices.length, "invoice", "invoices")}: ${subject}` });
  return { to: to.map((r) => r.name) };
}

/** Sets a waiting draft aside. */
export async function discardChase(id: string, userId: string): Promise<void> {
  const chase = await loadChase(id);
  if (!chase || !(await mayHandle(userId, chase))) throw new ChaseRefusal("That chase email isn't there any more.");
  if (chase.status !== "WAITING") return;
  await db.collectionChase.update({ where: { id }, data: { status: "DISCARDED" } });
  await recordDraft({ teammate: "arjun", kind: "collections.chase", ref: id, userId, draft: { subject: chase.subject, body: chase.body }, sent: null });
}

export type WaitingChase = { id: string; companyName: string; subject: string; createdAt: string; /** Drafted by Arjun by himself, one morning. */ auto: boolean };

/** This person's drafts waiting to be checked, the last two weeks'. */
export async function waitingChasesFor(userId: string, now = new Date()): Promise<WaitingChase[]> {
  try {
    const rows = await db.collectionChase.findMany({
      where: { createdById: userId, status: "WAITING", createdAt: { gte: new Date(now.getTime() - 14 * DAY) } },
      orderBy: { createdAt: "desc" },
      take: 10,
      select: { id: true, subject: true, createdAt: true, company: { select: { name: true } } },
    });
    const auto = new Set(
      (await db.collectionAutoRun.findMany({ where: { chaseId: { in: rows.map((r) => r.id) } }, select: { chaseId: true } }).catch(() => [])).map((r) => r.chaseId),
    );
    return rows.map((r) => ({ id: r.id, companyName: r.company.name, subject: r.subject, createdAt: r.createdAt.toISOString(), auto: auto.has(r.id) }));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

// ─── Replies ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type ChaseReplyOutcome = "unknown" | "automated" | "kept";

/**
 * An email to a chase's reply-to address (src/lib/support-mail/inbound.ts): kept, forwarded to whoever sent the chase
 * — answering the forward answers the customer, when their mail server vouched for the sender — and left for Arjun to
 * read on the next heartbeat. An out-of-office or other machine answer is dropped.
 */
export async function receiveChaseReply(token: string, mail: IncomingEmail & { senderVerified: boolean }): Promise<ChaseReplyOutcome> {
  let chase;
  try {
    chase = await db.collectionChase.findUnique({ where: { replyToken: token }, select: { id: true, sentById: true, createdById: true, company: { select: { name: true } } } });
  } catch (err) {
    if (notMigratedYet(err)) return "unknown";
    throw err;
  }
  if (!chase) return "unknown";
  if (mail.automated) return "automated";
  // The chase got a reply (step 2, src/lib/ai/drafts.ts).
  await noteReplied("collections.chase", chase.id);
  const fromAddress = mail.from?.address ?? "";
  const fromName = mail.from?.name || fromAddress || "The customer";
  const own = stripQuoted(mail.text);
  await db.collectionReply.create({
    data: { chaseId: chase.id, fromName: fromName.slice(0, 200), fromEmail: fromAddress.slice(0, 320) || null, senderVerified: mail.senderVerified, subject: mail.subject.slice(0, 300), text: (own || mail.text).slice(0, 20_000) },
  });
  const ownerId = chase.sentById ?? chase.createdById;
  const owner = await db.user.findUnique({ where: { id: ownerId }, select: { email: true, active: true } });
  if (owner?.active && owner.email) {
    const intro = `${fromName}${fromAddress && fromName !== fromAddress ? ` <${fromAddress}>` : ""} replied to your payment email to ${chase.company.name}.${mail.senderVerified ? "" : "\nTheir mail server didn't confirm the sender — check before acting on it."}\nReply to this email to answer them directly. Arjun will read it too, and suggest what to do in My collections.`;
    await sendPlatformMail({
      type: "DOCUMENTS",
      to: owner.email,
      fromName: `${fromName.slice(0, 60)} via Deskzo`,
      ...(fromAddress && mail.senderVerified ? { replyTo: fromAddress } : {}),
      subject: mail.subject.toLowerCase().startsWith("re:") ? mail.subject : `Re: ${mail.subject}`,
      text: `${intro}\n\n———\n\n${mail.text.slice(0, 20_000)}`,
      logSubject: "A reply to a payment chase email, forwarded to whoever sent it",
    }).catch((err) => console.error("[chase] forwarding a reply failed", err instanceof Error ? err.message : err));
  }
  return "kept";
}

/** What Arjun suggests for a reading, in his voice. */
function suggestion(reading: Reading | "UNREAD", r: { promisedOn: Date | null; paidOn: Date | null }): string {
  switch (reading) {
    case "PROMISE":
      return r.promisedOn ? `they'll pay by ${shortDay(r.promisedOn.toISOString())} — log the promise?` : "they'll pay — ask for a date?";
    case "PAID":
      return "they say they've paid — ask accounts to check the bank?";
    case "DISPUTE":
      return "they dispute it — pause their reminders while it's sorted?";
    case "QUESTION":
      return "they're asking for something — have a look?";
    default:
      return "have a look?";
  }
}

/**
 * The heartbeat's turn: replies not yet read, read by Deskzo AI — charged to whoever sent the chase, where Deskzo AI is
 * on and theirs to use; otherwise left as an unread reply for them to read themselves. Either way they are told.
 */
export async function readChaseReplies(now = new Date()): Promise<{ read: number; unread: number }> {
  let waiting;
  try {
    waiting = await db.collectionReply.findMany({
      where: { reading: null, readTries: { lt: 2 } },
      orderBy: { createdAt: "asc" },
      take: READ_PER_TICK,
      include: { chase: { select: { id: true, companyId: true, sentById: true, createdById: true, documentIds: true, status: true, company: { select: { name: true } } } } },
    });
  } catch (err) {
    if (notMigratedYet(err)) return { read: 0, unread: 0 };
    throw err;
  }
  const out = { read: 0, unread: 0 };
  if (!waiting.length) return out;
  const ai = (await copilotConfig()).enabled;
  const clock = await workspaceClock();
  const today = clock.calendarDate(now);
  const name = (await teammate("arjun")).name;
  for (const reply of waiting) {
    const ownerId = reply.chase.sentById ?? reply.chase.createdById;
    // A customer's email Arjun found in a mailbox he reads (src/lib/mail-reading/arjun.ts) — not a reply to a chase.
    const said = reply.chase.status === "MAILBOX" ? "emailed you about what they owe" : "replied to your payment email";
    const tell = (text: string) =>
      notifyUser({ userId: ownerId, type: "PAYMENT_FOLLOW_UP_DUE", title: noteFrom(name, text), message: reply.chase.company.name, link: "/collections#replies" }).catch(() => {});
    const mayRead = ai && (await can(ownerId, "copilot.use"));
    if (!mayRead) {
      await db.collectionReply.update({ where: { id: reply.id }, data: { reading: "UNREAD" } });
      await tell(`${reply.fromName ?? "The customer"} ${said} — it's in My collections.`);
      out.unread += 1;
      continue;
    }
    const invoices = await db.tradeDocument.findMany({ where: { id: { in: reply.chase.documentIds } }, select: { id: true, docNumber: true, currency: true, total: true } });
    try {
      const reading = await teammateWork(
        { teammate: "arjun", userId: ownerId, kind: "collections.reply", subject: `chase:${reply.chase.id}`, label: reply.chase.company.name, href: "/collections#replies", steps: REPLY_STEPS },
        async (work) => {
          const outcome = await aiTurn({
            userId: ownerId,
            feature: "collections.reply",
            system: READ_SYSTEM,
            history: [{ role: "user", text: readPrompt({ today, invoices: invoices.map((i) => ({ number: i.docNumber ?? "—", balance: formatMoney(Number(i.total), i.currency) })), subject: reply.subject, text: reply.text }) }],
            tools: [PROPOSE_READING],
          });
          await work.step(1);
          const call = outcome.toolCalls.find((c) => c.name === PROPOSE_READING.name);
          const read = call ? readingSchema.safeParse(call.input) : null;
          if (!read?.success) throw new ChaseRefusal("Arjun couldn't make the reply out — read it yourself.");
          await work.step(2);
          return settleReading(read.data, today, invoices.map((i) => ({ id: i.id, number: i.docNumber ?? "" })));
        },
        (r) => `${READING_LABELS[r.reading]}: ${r.summary}`,
      );
      await db.collectionReply.update({
        where: { id: reply.id },
        data: {
          reading: reading.reading,
          readTries: { increment: 1 },
          summary: reading.summary,
          promisedOn: reading.promisedOn,
          promisedAmount: reading.promisedAmount,
          paidOn: reading.paidOn,
          paidAmount: reading.paidAmount,
          reference: reading.reference,
          detail: reading.detail,
          documentIds: reading.documentIds,
        },
      });
      await tell(`${reply.fromName ?? "The customer"} replied: ${reading.summary.replace(/\.$/, "")} — ${suggestion(reading.reading, reading)}`);
      out.read += 1;
    } catch (err) {
      const tries = reply.readTries + 1;
      // Credits out, AI paused or no sense made of it: tried twice, then left for the person to read.
      await db.collectionReply.update({ where: { id: reply.id }, data: { readTries: tries, ...(tries >= 2 ? { reading: "UNREAD" } : {}) } });
      if (tries >= 2) await tell(`${reply.fromName ?? "The customer"} ${said} — I couldn't read it, so it's in My collections for you.`);
      if (!(err instanceof ChaseRefusal) && !(err instanceof AiRefusal)) console.error("[chase] reading a reply failed", err instanceof Error ? err.message : err);
      if (err instanceof AiRefusal) break;
    }
  }
  return out;
}

export type ReplyView = {
  id: string;
  chaseId: string;
  companyId: string;
  companyName: string;
  fromName: string | null;
  senderVerified: boolean;
  subject: string;
  text: string;
  reading: Reading | "UNREAD" | null;
  summary: string | null;
  promisedOn: string | null;
  promisedAmount: number | null;
  paidOn: string | null;
  paidAmount: number | null;
  reference: string | null;
  detail: string | null;
  /** The invoices it's about — those it names, else all the email's — still open: id, number, balance and currency. */
  invoices: { id: string; number: string; balance: number; currency: string }[];
  receivedAt: string;
};

/** Replies waiting for this person to act on: to chases they sent. */
export async function repliesFor(userId: string): Promise<ReplyView[]> {
  let rows;
  try {
    rows = await db.collectionReply.findMany({
      where: { status: "OPEN", chase: { OR: [{ sentById: userId }, { sentById: null, createdById: userId }] } },
      orderBy: { createdAt: "desc" },
      take: 20,
      include: { chase: { select: { id: true, companyId: true, documentIds: true, company: { select: { name: true } } } } },
    });
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
  const out: ReplyView[] = [];
  for (const r of rows) {
    const about = r.documentIds.length ? r.documentIds : r.chase.documentIds;
    const open = await openInvoicesAmong(about);
    out.push({
      id: r.id,
      chaseId: r.chase.id,
      companyId: r.chase.companyId,
      companyName: r.chase.company.name,
      fromName: r.fromName,
      senderVerified: r.senderVerified,
      subject: r.subject,
      text: r.text.slice(0, 3000),
      reading: (r.reading as ReplyView["reading"]) ?? null,
      summary: r.summary,
      promisedOn: r.promisedOn ? dayKey(r.promisedOn) : null,
      promisedAmount: r.promisedAmount === null ? null : Number(r.promisedAmount),
      paidOn: r.paidOn ? dayKey(r.paidOn) : null,
      paidAmount: r.paidAmount === null ? null : Number(r.paidAmount),
      reference: r.reference,
      detail: r.detail,
      invoices: open.map((i) => ({ id: i.id, number: i.number, balance: i.balance, currency: i.currency })),
      receivedAt: r.createdAt.toISOString(),
    });
  }
  return out;
}

/** A reply, for acting on it: only one still open, to a chase this person may handle. */
export async function openReply(replyId: string, userId: string) {
  const reply = await db.collectionReply.findUnique({
    where: { id: replyId },
    include: { chase: { select: { id: true, companyId: true, createdById: true, sentById: true, documentIds: true, company: { select: { name: true } } } } },
  });
  if (!reply || !(await mayHandle(userId, reply.chase))) return null;
  return reply;
}

/** Marks a reply dealt with, saying how. */
export async function closeReply(replyId: string, userId: string, status: "DONE" | "DISMISSED", outcome: string): Promise<void> {
  await db.collectionReply.update({ where: { id: replyId }, data: { status, outcome: outcome.slice(0, 300), actedById: userId, actedAt: new Date() } });
}

/** Who checks the bank or sorts out a dispute: the person reminders go out as, where they record payments; else whoever acts. */
export async function accountsPerson(fallbackId: string): Promise<string> {
  const config = await collectionConfig();
  if (config.senderUserId) {
    const named = await db.user.findUnique({ where: { id: config.senderUserId }, select: { active: true } });
    if (named?.active && (await can(config.senderUserId, "payments.record"))) return config.senderUserId;
  }
  return fallbackId;
}

/** Customers chased by email in the last few days — the reminder schedule leaves them alone (src/lib/collect/reminders.ts). */
export async function recentlyChased(companyIds: string[], now = new Date()): Promise<Set<string>> {
  if (!companyIds.length) return new Set();
  try {
    const rows = await inBatches(companyIds, (batch) =>
      db.collectionChase.findMany({ where: { companyId: { in: batch }, status: "SENT", sentAt: { gte: new Date(now.getTime() - QUIET_AFTER_CHASE_DAYS * DAY) } }, select: { companyId: true }, distinct: ["companyId"] }),
    );
    return new Set(rows.map((r) => r.companyId));
  } catch (err) {
    if (notMigratedYet(err)) return new Set();
    throw err;
  }
}

/** For Today and the team card: drafts waiting, and replies to act on. */
export async function arjunWaiting(userId: string): Promise<{ drafts: number; replies: number }> {
  try {
    const [drafts, replies] = await Promise.all([
      db.collectionChase.count({ where: { createdById: userId, status: "WAITING", createdAt: { gte: new Date(Date.now() - 14 * DAY) } } }),
      db.collectionReply.count({ where: { status: "OPEN", reading: { not: null }, chase: { OR: [{ sentById: userId }, { sentById: null, createdById: userId }] } } }),
    ]);
    return { drafts, replies };
  } catch (err) {
    if (notMigratedYet(err)) return { drafts: 0, replies: 0 };
    throw err;
  }
}
