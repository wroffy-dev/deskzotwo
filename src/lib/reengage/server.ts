import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { notMigratedYet } from "@/lib/not-migrated";
import { copilotConfig } from "@/lib/copilot/settings";
import { aiTurn, AiRefusal } from "@/lib/ai/gateway";
import { countedAs } from "@/lib/customer-mail-cap";
import { sendAsUser } from "@/lib/mail/mailbox";
import { deliverNow } from "@/lib/marketing/pipeline";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { senderDisplayName } from "@/lib/documents/mail-route-labels";
import { textToHtml } from "@/lib/pipeline/automation-rules";
import { getOrganisation } from "@/lib/organisation";
import { currentTenant, tenantOrigin } from "@/lib/tenancy/resolve";
import { inboundDomain } from "@/lib/support-mail/config";
import { workspaceClock } from "@/lib/time/workspace";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { companyPath, leadPath } from "@/lib/record-links";
import { quickContext } from "@/lib/quick-messages/server";
import { workspacePack } from "@/lib/country-pack";
import type { IncomingEmail } from "@/lib/support-mail/parse";
import { PROPOSE_EMAIL, emailSchema, finalText, newReplyToken } from "@/lib/nurture/rules";
import { READ_REPLY, REPLY_KIND_LABELS, REPLY_SYSTEM, readReplySchema, replyPrompt, scrubReply, sendTimeFor, sendTimeLabel, type ReplyKind } from "@/lib/nurture/replies";
import { stopEmailing } from "@/lib/nurture/server";
import { teammateWork } from "@/lib/ai/teammate-work";
import { REENGAGE_STEPS } from "@/lib/ai/teammate-steps";
import { noteFrom } from "@/lib/ai/teammates";
import { teammate } from "@/lib/ai/teammates-server";
import { examplesBlock, examplesFor, feedbackOf, markSkipped, noteReplied, recordDraft } from "@/lib/ai/drafts";
import { styled } from "@/lib/ai/house-style";
import { newLeadStage } from "@/lib/pipeline/server";
import { markLeadWrite, leadCapacityError } from "@/lib/leads/limits";
import { intakeOwner } from "@/lib/leads/intake-owner";
import { emitLeadCreated } from "@/lib/automate/emit-leads";
import { refreshLeadScoreQuietly } from "@/lib/leads/score-store";
import {
  CHASE_QUIET_DAYS,
  DEFAULT_MONTHS,
  MAIL_QUIET_DAYS,
  RENEWAL_WINDOW_DAYS,
  SKIPPED_QUIET_DAYS,
  checkInPrompt,
  checkInReplyAddress,
  checkInSystemFor,
  monthsBefore,
  sinceInWords,
  voiceReason,
  type Bought,
  type VoiceFacts,
} from "@/lib/reengage/rules";

/**
 * Tara re-engaging existing customers (owner, 20 Nov 2026 — AI team step 4; src/lib/reengage/rules.ts for who and the
 * words). Off until an admin switches it on in Settings › Deskzo AI.
 *
 *   · A customer quiet for N months, with nobody else talking to them (rules.ts `voiceReason`), gets one short check-in
 *     drafted from what they bought — on the customer's page by a click, or each day by herself for the most valuable
 *     few (at most so many a day).
 *   · It waits for the account manager (`Company.ownerUserId`), whose mailbox it goes from, to read, change and send —
 *     in working hours, or at 10 the next working morning. Every check is made again as it goes.
 *   · Sent as a nurture email is: the customer's own choices honoured, the "manage what we send you" line, the mail log,
 *     and the workspace's 24-hour limit. Replies come to `<slug>+e-<token>@…`: forwarded to the account manager, read
 *     by Tara — interested or wanting a call opens a lead for them; asking to stop unsubscribes them at once.
 */

const DAY = 86_400_000;
const CLOSED: ("WON" | "LOST" | "DISQUALIFIED")[] = ["WON", "LOST", "DISQUALIFIED"];
/** Drafts a heartbeat writes by itself — the day's are spread over the morning's ticks. */
const PER_TICK = 3;
/** A customer Tara couldn't write to (no email address, say) isn't tried again for this long. */
const PASSED_QUIET_DAYS = 30;

export class ReengageRefusal extends Error {}
/** Deskzo AI itself said no — out of credits, paused: nothing about the customer. */
class AiSaidNo extends ReengageRefusal {}

// ─── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type ReengageConfig = { enabled: boolean; months: number; perDay: number; migrated: boolean };

export async function reengageConfig(): Promise<ReengageConfig> {
  try {
    const row = await db.reengageSettings.findUnique({ where: { id: "global" }, select: { enabled: true, months: true, perDay: true } });
    return { enabled: row?.enabled ?? false, months: row?.months ?? DEFAULT_MONTHS, perDay: row?.perDay ?? 10, migrated: true };
  } catch (err) {
    if (notMigratedYet(err)) return { enabled: false, months: DEFAULT_MONTHS, perDay: 10, migrated: false };
    throw err;
  }
}

export async function saveReengageConfig(input: { enabled: boolean; months: number; perDay: number }, userId: string): Promise<void> {
  await db.reengageSettings.upsert({
    where: { id: "global" },
    create: { id: "global", ...input, updatedById: userId },
    update: { ...input, updatedById: userId },
    select: { id: true },
  });
}

/** Check-ins drafted since the workspace's midnight — each a Deskzo AI turn. */
export async function draftedToday(now = new Date()): Promise<number> {
  const clock = await workspaceClock();
  const midnight = clock.startOfDay(clock.today(now)) ?? new Date(now.getTime() - DAY);
  return db.reengageEmail.count({ where: { createdAt: { gte: midnight }, status: { not: "PASSED" } } }).catch(() => 0);
}

// ─── One voice per customer ───────────────────────────────────────────────────────────────────────────────────────

const renewalSoon = (now: Date): Prisma.CompanyProductWhereInput => ({
  parentId: null,
  orderStatus: { notIn: ["CANCELLED", "REJECTED"] },
  endDate: { gte: now, lte: new Date(now.getTime() + RENEWAL_WINDOW_DAYS * DAY) },
  renewedBy: { is: null },
  // NOT over a null column drops the row (memory: prisma-not-over-null-drops-rows): a stage not set counts as coming.
  OR: [{ renewalStage: null }, { renewalStage: { notIn: ["LOST", "RENEWED"] } }],
});

/** What the one-voice check reads of a customer. `except`: a check-in being sent, which doesn't count against itself. */
export async function voiceFacts(companyId: string, now: Date, months: number, except?: string): Promise<VoiceFacts> {
  const notThis = except ? { id: { not: except } } : {};
  const [company, renewals, chases, openLeads, mailed, live, turnedDown] = await Promise.all([
    db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true, customerStats: { select: { lastPurchaseAt: true, overdue: true } } } }),
    db.companyProduct.count({ where: { companyId, ...renewalSoon(now) } }),
    db.collectionChase.count({ where: { companyId, OR: [{ status: "WAITING" }, { sentAt: { gte: new Date(now.getTime() - CHASE_QUIET_DAYS * DAY) } }] } }).catch(() => 0),
    db.lead.count({ where: { companyId, status: { notIn: CLOSED } } }),
    db.marketingMessage.count({ where: { companyId, sentAt: { gte: new Date(now.getTime() - MAIL_QUIET_DAYS * DAY) } } }),
    db.reengageEmail.count({ where: { companyId, ...notThis, OR: [{ status: { in: ["WAITING", "SCHEDULED"] } }, { status: "SENT", sentAt: { gte: monthsBefore(now, months) } }] } }),
    db.reengageEmail.count({ where: { companyId, ...notThis, status: "SKIPPED", updatedAt: { gte: new Date(now.getTime() - SKIPPED_QUIET_DAYS * DAY) } } }),
  ]);
  return {
    hasAccountManager: !!company?.ownerUserId,
    lastPurchaseAt: company?.customerStats?.lastPurchaseAt ?? null,
    renewalsDueSoon: renewals,
    chasedRecently: chases,
    overdue: Number(company?.customerStats?.overdue ?? 0),
    openLeads,
    mailedRecently: mailed,
    checkInLive: live > 0,
    checkInTurnedDown: turnedDown > 0,
  };
}

/**
 * The quiet customers Tara may write to by herself, most valuable first: the query keeps out what it can (bought
 * lately, an account manager missing, a lead open, money overdue, a renewal coming, a check-in already this period);
 * `voiceFacts` makes every check again for each.
 */
async function quietCustomers(now: Date, months: number, take: number): Promise<{ id: string }[]> {
  return db.company.findMany({
    where: {
      ownerUserId: { not: null },
      managedByResellerId: null,
      OR: [{ relationshipType: { not: "VENDOR" } }, { alsoCustomer: true }],
      customerStats: { lastPurchaseAt: { lt: monthsBefore(now, months) }, overdue: { lte: 0 } },
      contacts: { some: { email: { not: null }, leftAt: null } },
      leads: { none: { status: { notIn: CLOSED } } },
      products: { none: renewalSoon(now) },
      reengageEmails: { none: { OR: [{ createdAt: { gte: monthsBefore(now, months) }, status: { not: "PASSED" } }, { status: "PASSED", createdAt: { gte: new Date(now.getTime() - PASSED_QUIET_DAYS * DAY) } }] } },
    },
    orderBy: { customerStats: { lifetimeValue: "desc" } },
    take,
    select: { id: true },
  });
}

// ─── What they bought ─────────────────────────────────────────────────────────────────────────────────────────────

/** Their products, by name — quantity summed and the last day — and a few others customers buy from the same shelves. */
export async function boughtAndOthers(companyId: string, now: Date): Promise<{ bought: Bought[]; others: string[] }> {
  const rows = await db.companyProduct.findMany({
    where: { companyId, orderStatus: { notIn: ["CANCELLED", "REJECTED"] } },
    orderBy: { createdAt: "desc" },
    take: 300,
    select: { quantity: true, startDate: true, createdAt: true, item: { select: { id: true, name: true, category: true, productFamilyId: true } } },
  });
  const byName = new Map<string, { name: string; quantity: number; last: Date }>();
  for (const r of rows) {
    const at = r.startDate ?? r.createdAt;
    const had = byName.get(r.item.name);
    if (had) {
      had.quantity += r.quantity;
      if (at > had.last) had.last = at;
    } else byName.set(r.item.name, { name: r.item.name, quantity: r.quantity, last: at });
  }
  const clock = await workspaceClock();
  const bought = [...byName.values()]
    .sort((a, b) => b.last.getTime() - a.last.getTime())
    .slice(0, 8)
    .map((b) => ({ name: b.name, quantity: b.quantity, lastOn: monthYear(b.last, clock.zone) }));

  // Others: what other customers ordered most in the last year from the same categories or families — never theirs.
  const mine = [...new Set(rows.map((r) => r.item.id))];
  const categories = [...new Set(rows.map((r) => r.item.category).filter((c): c is string => !!c))];
  const families = [...new Set(rows.map((r) => r.item.productFamilyId).filter((f): f is string => !!f))];
  const shelves: Prisma.ItemWhereInput[] = [...(categories.length ? [{ category: { in: categories } }] : []), ...(families.length ? [{ productFamilyId: { in: families } }] : [])];
  let others: string[] = [];
  if (shelves.length) {
    const popular = await db.companyProduct.groupBy({
      by: ["itemId"],
      where: { createdAt: { gte: new Date(now.getTime() - 365 * DAY) }, companyId: { not: companyId }, itemId: { notIn: mine }, orderStatus: { notIn: ["CANCELLED", "REJECTED"] }, item: { active: true, OR: shelves } },
      _count: { _all: true },
      orderBy: { _count: { itemId: "desc" } },
      take: 4,
    });
    const names = new Map((await db.item.findMany({ where: { id: { in: popular.map((p) => p.itemId) } }, select: { id: true, name: true } })).map((i) => [i.id, i.name]));
    others = popular.map((p) => names.get(p.itemId)).filter((n): n is string => !!n && !byName.has(n));
  }
  return { bought, others };
}

const monthYear = (at: Date, zone: string) => new Intl.DateTimeFormat("en-GB", { timeZone: zone, month: "long", year: "numeric" }).format(at);

// ─── Drafting ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Writes the check-in with Deskzo AI on the account manager's credits, asked once more if it doesn't come back as one. */
async function writeCheckIn(ownerId: string, prompt: string): Promise<{ subject: string; body: string }> {
  const learned = examplesBlock(await examplesFor("reengage.email"));
  const history: Parameters<typeof aiTurn>[0]["history"] = [{ role: "user", text: prompt + learned }];
  for (let attempt = 0; attempt < 2; attempt++) {
    let outcome;
    try {
      outcome = await aiTurn({ userId: ownerId, feature: "reengage.email", system: await styled(checkInSystemFor(workspacePack().india)), history, tools: [PROPOSE_EMAIL] });
    } catch (err) {
      if (err instanceof AiRefusal) throw new AiSaidNo(err.message);
      throw err;
    }
    const call = outcome.toolCalls.find((c) => c.name === PROPOSE_EMAIL.name);
    const read = call ? emailSchema.safeParse(call.input) : null;
    if (read?.success) return read.data;
    history.push({ role: "assistant", text: outcome.text, toolCalls: outcome.toolCalls, ...(outcome.native ? { native: { provider: outcome.family, model: outcome.model, content: outcome.native, masked: outcome.masked } } : {}) });
    if (outcome.toolCalls.length) history.push({ role: "tool", results: outcome.toolCalls.map((c) => ({ id: c.id, name: c.name, output: "Call propose_email again with a subject and a body of a few sentences.", isError: true })) });
    else history.push({ role: "user", text: "Call propose_email now." });
  }
  throw new ReengageRefusal("Deskzo AI didn't come back with an email.");
}

/** Who it goes from, and to — or why not, before any credits are spent. */
async function senderAndContact(companyId: string, ownerId: string | null) {
  if (!ownerId) throw new ReengageRefusal("It has no account manager to send from — give it one first.");
  const owner = await db.user.findUnique({ where: { id: ownerId }, select: { id: true, name: true, email: true, active: true } });
  if (!owner?.active) throw new ReengageRefusal("Its account manager no longer works here — give it a new one first.");
  if (!(await can(owner.id, "copilot.use"))) throw new ReengageRefusal(`${owner.name}, its account manager, can't use Deskzo AI.`);
  const context = await quickContext(owner.id, { moment: "ANY", companyId });
  if (!context) throw new ReengageRefusal("That company isn't there any more.");
  if ("error" in context) throw new ReengageRefusal(context.error);
  if (context.emailRoute.via === "none") throw new ReengageRefusal(context.emailRoute.why);
  const usable = context.contacts.filter((c) => c.email && !c.emailStopped);
  const contact = usable.find((c) => c.primary) ?? usable[0];
  if (!contact) {
    const stopped = context.contacts.find((c) => c.email && c.emailStopped);
    throw new ReengageRefusal(stopped ? `${stopped.name} can't be emailed: ${stopped.emailStopped}` : "Nobody at this company has an email address to write to.");
  }
  return { owner, context, contact };
}

/**
 * Drafts one check-in for a customer: the one-voice checks, then Tara's email from what they bought, waiting for the
 * account manager. `by` is whoever asked (the account manager themself when it's the heartbeat). Throws ReengageRefusal.
 */
export async function draftCheckIn(companyId: string, by: string, now = new Date()): Promise<{ id: string; ownerId: string }> {
  const config = await reengageConfig();
  if (!config.enabled) throw new ReengageRefusal("Re-engaging customers isn't switched on — an admin can switch it on in Settings → Deskzo AI.");
  if (!(await copilotConfig()).enabled) throw new ReengageRefusal("Deskzo AI is switched off.");
  const company = await db.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, companySeq: true, ownerUserId: true } });
  if (!company) throw new ReengageRefusal("That company isn't there any more.");
  const facts = await voiceFacts(companyId, now, config.months);
  const why = voiceReason(facts, now, config.months);
  if (why) throw new ReengageRefusal(`Not now: ${why.charAt(0).toLowerCase()}${why.slice(1)}.`);
  const { owner, contact } = await senderAndContact(companyId, company.ownerUserId);

  const made = await teammateWork(
    { teammate: "tara", userId: owner.id, kind: "reengage.draft", subject: `company:${company.id}`, label: company.name, href: companyPath(company.companySeq), steps: REENGAGE_STEPS },
    async (work) => {
      const { bought, others } = await boughtAndOthers(company.id, now);
      await work.step(1);
      const email = await writeCheckIn(owner.id, checkInPrompt({ companyName: company.name, since: sinceInWords(facts.lastPurchaseAt!, now), bought, others }));
      await work.step(2);
      return db.reengageEmail.create({
        data: { companyId: company.id, contactId: contact.id, ownerId: owner.id, subject: email.subject, body: email.body, replyToken: newReplyToken(), createdAt: now },
        select: { id: true },
      });
    },
    () => "A check-in email is ready for you to check",
  );
  await recordAudit({ userId: by, action: "CREATE", entityType: "ReengageEmail", entityId: made.id, entityLabel: `Tara drafted a check-in to ${company.name}, waiting for ${owner.name}` });
  await notifyUser({
    userId: owner.id,
    type: "LEAD_ACTIVITY",
    title: noteFrom((await teammate("tara")).name, `${company.name} has been quiet a while — I've drafted a check-in for you. Have a look?`),
    message: "Nothing goes until you send it.",
    link: `${companyPath(company.companySeq)}#check-in`,
  }).catch((err) => console.error("[reengage] the draft's notice failed", err instanceof Error ? err.message : err));
  return { id: made.id, ownerId: owner.id };
}

// ─── Approving, sending, setting aside ────────────────────────────────────────────────────────────────────────────

async function loadEmail(id: string) {
  return db.reengageEmail.findUnique({ where: { id }, include: { company: { select: { id: true, name: true, companySeq: true } } } });
}
type Email = NonNullable<Awaited<ReturnType<typeof loadEmail>>>;

/** The checks made again before it goes or is held to go: one voice still, the contact still reachable. */
async function preflight(e: Email, now: Date) {
  const config = await reengageConfig();
  const why = voiceReason(await voiceFacts(e.companyId, now, config.months, e.id), now, config.months);
  if (why) {
    await db.reengageEmail.update({ where: { id: e.id }, data: { status: "SKIPPED", sendAt: null, error: why.slice(0, 300) } });
    await markSkipped("reengage.email", e.id);
    throw new ReengageRefusal(`Not sent — ${why.charAt(0).toLowerCase()}${why.slice(1)}.`);
  }
  const context = await quickContext(e.ownerId, { moment: "ANY", companyId: e.companyId });
  if (!context || "error" in context) throw new ReengageRefusal(context && "error" in context ? context.error : "That company isn't there any more.");
  if (context.emailRoute.via === "none") throw new ReengageRefusal(context.emailRoute.why);
  const contact = context.contacts.find((c) => c.id === e.contactId);
  if (!contact?.email) throw new ReengageRefusal("The contact has no email address any more.");
  if (contact.emailStopped) throw new ReengageRefusal(`${contact.name} can't be emailed: ${contact.emailStopped}`);
  return { context, contact };
}

/** Sends it as the account manager. Throws ReengageRefusal with words. */
async function deliver(e: Email, edited: { subject: string; body: string }, now: Date): Promise<{ to: string }> {
  const { context, contact } = await preflight(e, now);
  const owner = await db.user.findUnique({ where: { id: e.ownerId }, select: { id: true, name: true, email: true } });
  if (!owner) throw new ReengageRefusal("The account manager no longer works here.");
  const [origin, org, tenant] = await Promise.all([tenantOrigin(), getOrganisation(), currentTenant()]);
  const token = randomBytes(24).toString("base64url");
  const text = finalText(edited.body, { firstName: contact.name.split(/\s+/)[0] ?? null, senderName: owner.name }, `${origin}/preferences/${token}`);
  const html = textToHtml(text);
  const domain = inboundDomain();
  const replyTo = domain ? checkInReplyAddress(tenant.slug, e.replyToken, domain) : null;

  let from = "";
  const failed = await countedAs("automation", async () => {
    if (context.emailRoute.via === "mailbox") {
      const out = await sendAsUser(owner.id, { subject: edited.subject, html, to: [{ name: contact.name, email: contact.email! }], ...(replyTo ? { replyTo: { name: owner.name, email: replyTo } } : {}), attachments: [] });
      if (out.ok) from = out.mailbox;
      return out.ok ? null : out.error;
    }
    const out = await deliverNow({ to: contact.email!, toName: contact.name, fromName: senderDisplayName(owner.name, org.tradeName || org.legalName || ""), replyTo: replyTo ?? owner.email, subject: edited.subject, html, text }, "TRANSACTIONAL", { delivering: true });
    if (out.ok) from = out.fromEmail ?? out.provider;
    return out.ok ? null : out.error;
  });
  if (failed) {
    await db.reengageEmail.update({ where: { id: e.id }, data: { error: failed.slice(0, 500) } });
    throw new ReengageRefusal(`It didn't go: ${failed}`);
  }
  await db.marketingMessage.create({
    data: { token, companyId: e.companyId, contactId: contact.id, channel: "EMAIL", messageClass: "TRANSACTIONAL", subject: edited.subject, body: html, textBody: text, toEmail: contact.email, status: "SENT", scheduledFor: now, sentAt: now, attempts: 1, sentByUserId: owner.id, fromEmail: from },
  });
  await db.reengageEmail.update({ where: { id: e.id }, data: { status: "SENT", subject: edited.subject, body: edited.body, sentAt: now, sendAt: null, error: null } });
  await recordAudit({ userId: owner.id, action: "CREATE", entityType: "ReengageEmail", entityId: e.id, entityLabel: `Check-in sent to ${contact.name} at ${e.company.name}: ${edited.subject}` });
  return { to: contact.name };
}

/**
 * The account manager approves a check-in, as written or as they changed it: `"working-hours"` sends it now inside a
 * working day's hours and otherwise holds it for 10 the next working morning; `"now"` sends it at once.
 */
export async function approveCheckIn(id: string, userId: string, edited: { subject: string; body: string }, now = new Date(), when: "now" | "working-hours" = "working-hours"): Promise<{ to: string; at: string | null }> {
  const e = await loadEmail(id);
  if (!e || (e.status !== "WAITING" && e.status !== "SCHEDULED")) throw new ReengageRefusal("That email isn't waiting any more.");
  if (!(await reengageConfig()).enabled) throw new ReengageRefusal("Re-engaging customers is switched off in Settings → Deskzo AI.");
  if (e.ownerId !== userId) throw new ReengageRefusal("Only the account manager sends this — it goes from their mailbox.");
  const subject = edited.subject.trim().slice(0, 300);
  const body = edited.body.trim().slice(0, 5000);
  if (subject.length < 3 || body.length < 20) throw new ReengageRefusal("The email needs a subject and a few sentences.");
  if (when === "working-hours") {
    const clock = await workspaceClock();
    const at = sendTimeFor(now, clock.zone);
    if (at.getTime() > now.getTime() + 60_000) {
      const { contact } = await preflight(e, now);
      await db.reengageEmail.update({ where: { id: e.id }, data: { status: "SCHEDULED", subject, body, sendAt: at, error: null } });
      if (e.status === "WAITING") await recordDraft({ teammate: "tara", kind: "reengage.email", ref: e.id, userId, draft: { subject: e.subject, body: e.body }, sent: { subject, body } });
      return { to: contact.name, at: at.toISOString() };
    }
  }
  const sent = await deliver(e, { subject, body }, now);
  if (e.status === "WAITING") await recordDraft({ teammate: "tara", kind: "reengage.email", ref: e.id, userId, draft: { subject: e.subject, body: e.body }, sent: { subject, body } });
  return { to: sent.to, at: null };
}

/** "Don't send": set aside; this customer isn't offered again for a while. Only the account manager. */
export async function skipCheckIn(id: string, userId: string): Promise<void> {
  const e = await loadEmail(id);
  if (!e || (e.status !== "WAITING" && e.status !== "SCHEDULED")) throw new ReengageRefusal("That email isn't waiting any more.");
  if (e.ownerId !== userId) throw new ReengageRefusal("Only the account manager decides on this.");
  await db.reengageEmail.update({ where: { id: e.id }, data: { status: "SKIPPED", sendAt: null } });
  if (e.status === "WAITING") await recordDraft({ teammate: "tara", kind: "reengage.email", ref: e.id, userId, draft: { subject: e.subject, body: e.body }, sent: null });
  else await markSkipped("reengage.email", e.id);
}

/** Approved check-ins whose working morning has come: sent, every check made again — or back to the account manager. */
async function sendHeld(now: Date): Promise<number> {
  const held = await db.reengageEmail.findMany({ where: { status: "SCHEDULED", sendAt: { lte: now } }, orderBy: { sendAt: "asc" }, take: 10, select: { id: true } });
  let sent = 0;
  for (const { id } of held) {
    const e = await loadEmail(id);
    if (!e || e.status !== "SCHEDULED") continue;
    try {
      await deliver(e, { subject: e.subject, body: e.body }, now);
      sent += 1;
    } catch (err) {
      const why = err instanceof ReengageRefusal ? err.message : "It couldn't be sent.";
      if (!(err instanceof ReengageRefusal)) console.error("[reengage] a held check-in failed", err instanceof Error ? err.message : err);
      // Back to the account manager, unsent — unless the checks set it aside already.
      await db.reengageEmail.updateMany({ where: { id: e.id, status: "SCHEDULED" }, data: { status: "WAITING", sendAt: null, error: why.slice(0, 500) } });
      await notifyUser({ userId: e.ownerId, type: "LEAD_ACTIVITY", title: `The check-in to ${e.company.name} didn't go`, message: why.slice(0, 300), link: `${companyPath(e.company.companySeq)}#check-in` }).catch(() => undefined);
    }
  }
  return sent;
}

// ─── The heartbeat ────────────────────────────────────────────────────────────────────────────────────────────────

export type ReengageRun = { drafted: number; passed: number; sent: number; reason?: string };

/** Sends what was approved for this morning, then drafts the day's check-ins for the most valuable quiet customers. */
export async function runReengage(now = new Date()): Promise<ReengageRun> {
  const config = await reengageConfig();
  if (!config.enabled) return { drafted: 0, passed: 0, sent: 0, reason: "off" };
  // Sending what the account manager approved is no AI's: it goes even with Deskzo AI paused.
  const sent = await sendHeld(now);
  if (!(await copilotConfig()).enabled) return { drafted: 0, passed: 0, sent, reason: "Deskzo AI is off" };
  let left = Math.min(PER_TICK, config.perDay - (await draftedToday(now)));
  const out: ReengageRun = { drafted: 0, passed: 0, sent };
  if (left <= 0) return { ...out, reason: "today's limit" };
  for (const { id } of await quietCustomers(now, config.months, 20)) {
    if (left <= 0) break;
    const company = await db.company.findUnique({ where: { id }, select: { ownerUserId: true } });
    try {
      await draftCheckIn(id, company?.ownerUserId ?? "", now);
      out.drafted += 1;
      left -= 1;
    } catch (err) {
      if (!(err instanceof ReengageRefusal)) {
        console.error("[reengage] drafting failed", err instanceof Error ? err.message : err);
        break;
      }
      // Out of credits or Deskzo AI paused: stop for this tick. Anything about the customer: passed over for a month.
      if (err instanceof AiSaidNo) {
        out.reason = err.message;
        break;
      }
      const contactId = await anyContact(id);
      if (company?.ownerUserId && contactId) {
        await db.reengageEmail.create({ data: { companyId: id, contactId, ownerId: company.ownerUserId, status: "PASSED", subject: "", body: "", replyToken: newReplyToken(), error: err.message.slice(0, 300), createdAt: now } }).catch(() => undefined);
      }
      out.passed += 1;
    }
  }
  return out;
}

/** A contact to hang a passed-over row on (the column is required); none at all leaves no row — and the customer, with
 * nobody on file, isn't in the list at all (`quietCustomers` asks for a contact with an email). */
async function anyContact(companyId: string): Promise<string | null> {
  return (await db.contact.findFirst({ where: { companyId }, orderBy: { isPrimary: "desc" }, select: { id: true } }))?.id ?? null;
}

// ─── A reply ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type CheckInReplyOutcome = "unknown" | "automated" | "forwarded";

/**
 * An email to a check-in's reply-to address (src/lib/support-mail/inbound.ts): forwarded to the account manager with
 * replies going straight back to the customer, read by Tara, and acted on —
 *
 *   · interested, or asking for a call: a lead opened for the account manager, from this customer and contact;
 *   · asking to stop: no more email to them at all, at once;
 *   · anything else: a task for the account manager to answer it.
 */
/** `forward: false`: found in the account manager's own mailbox (src/lib/mail-reading/tara.ts) — not emailed to them again. */
export async function receiveCheckInReply(token: string, mail: IncomingEmail & { senderVerified: boolean }, now = new Date(), opts: { forward?: boolean } = {}): Promise<CheckInReplyOutcome> {
  let e: Email | null;
  try {
    const row = await db.reengageEmail.findUnique({ where: { replyToken: token }, select: { id: true } });
    e = row ? await loadEmail(row.id) : null;
  } catch (err) {
    if (notMigratedYet(err)) return "unknown";
    throw err;
  }
  if (!e || e.status !== "SENT") return "unknown";
  if (mail.automated) return "automated";
  const fromAddress = mail.from?.address ?? "";
  const fromName = mail.from?.name || fromAddress || "The customer";
  const first = !e.repliedAt;
  await noteReplied("reengage.email", e.id, now);

  const owner = await db.user.findUnique({ where: { id: e.ownerId }, select: { id: true, name: true, email: true, active: true } });
  if (opts.forward !== false && owner?.active && owner.email) {
    const intro = `${fromName}${fromAddress && fromName !== fromAddress ? ` <${fromAddress}>` : ""} replied to your check-in with ${e.company.name}.${mail.senderVerified ? "" : "\nTheir mail server didn't confirm the sender — check before acting on it."}\nReply to this email to answer them directly.`;
    await sendPlatformMail({
      type: "DOCUMENTS",
      to: owner.email,
      fromName: `${fromName.slice(0, 60)} via Deskzo`,
      ...(fromAddress && mail.senderVerified ? { replyTo: fromAddress } : {}),
      subject: mail.subject.toLowerCase().startsWith("re:") ? mail.subject : `Re: ${mail.subject}`,
      text: `${intro}\n\n———\n\n${mail.text.slice(0, 20_000)}`,
      logSubject: "A reply to a check-in email, forwarded to the account manager",
    }).catch((err) => console.error("[reengage] forwarding a reply failed", err instanceof Error ? err.message : err));
  }

  // Read by Tara on the account manager's credits — the reply's own words only, addresses and numbers taken out.
  let kind: ReplyKind = "UNREAD";
  let summary: string | null = null;
  if ((await copilotConfig()).enabled) {
    try {
      const clock = await workspaceClock();
      const outcome = await aiTurn({ userId: e.ownerId, feature: "nurture.reply", system: await styled(REPLY_SYSTEM), history: [{ role: "user", text: replyPrompt({ today: clock.today(now), answered: e.subject, reply: scrubReply(mail.text), automated: false }) }], tools: [READ_REPLY] });
      const call = outcome.toolCalls.find((c) => c.name === READ_REPLY.name);
      const read = call ? readReplySchema.safeParse(call.input) : null;
      if (read?.success) {
        kind = read.data.kind;
        summary = read.data.summary;
      }
    } catch (err) {
      if (!(err instanceof AiRefusal)) console.error("[reengage] reading a reply failed", err instanceof Error ? err.message : err);
    }
  }

  const tara = (await teammate("tara")).name;
  const where = `${e.company.name}`;
  const link = `${companyPath(e.company.companySeq)}#check-in`;
  let leadId: string | null = e.leadId;
  if (kind === "UNSUBSCRIBE") {
    await stopEmailing(e.contactId, mail.senderVerified ? fromAddress || null : null, `Asked not to be emailed, replying to a check-in email on ${(await workspaceClock()).today(now)}.`, now);
    await notifyUser({ userId: e.ownerId, type: "LEAD_ACTIVITY", title: noteFrom(tara, `${fromName} asked not to be emailed — they're unsubscribed from everything.`), message: where, link });
  } else if ((kind === "INTERESTED" || kind === "CALL_ME") && !leadId) {
    leadId = await openLead(e, fromName, kind, summary, mail, now).catch((err) => {
      console.error("[reengage] opening a lead failed", err instanceof Error ? err.message : err);
      return null;
    });
    if (leadId) {
      const lead = await db.lead.findUnique({ where: { id: leadId }, select: { leadSeq: true } });
      await notifyUser({ userId: e.ownerId, type: "LEAD_ASSIGNED", title: noteFrom(tara, `${fromName} ${kind === "CALL_ME" ? "asked for a call" : "is interested"} — I've opened a lead for you.`), message: `${where}${summary ? ` · ${summary}` : ""}`, link: lead ? leadPath(lead.leadSeq) : link });
    }
  }
  if (kind !== "UNSUBSCRIBE" && !leadId && first) {
    // Anything else — or the lead couldn't be opened: theirs to answer, with a task.
    await db.task
      .create({
        data: {
          title: `Answer ${fromName}'s reply to your check-in — ${e.company.name}`.slice(0, 500),
          description: `${summary ?? "They replied to the check-in email Tara drafted."}\n\nThe reply is in your mailbox, forwarded.`,
          dueDate: (await workspaceClock()).calendarDate(now),
          assignedToUserId: e.ownerId,
          createdByUserId: e.ownerId,
          companyId: e.companyId,
          status: "TODO",
          priority: "HIGH",
        },
        select: { id: true },
      })
      .catch((err) => console.error("[reengage] the reply's task failed", err instanceof Error ? err.message : err));
    await notifyUser({ userId: e.ownerId, type: "LEAD_ACTIVITY", title: noteFrom(tara, `${fromName} replied to your check-in${kind !== "UNREAD" ? ` (${REPLY_KIND_LABELS[kind].toLowerCase()})` : ""} — it's in your mailbox, with a task.`), message: where, link });
  }
  await db.reengageEmail.update({ where: { id: e.id }, data: { repliedAt: e.repliedAt ?? now, replyKind: kind, replySummary: summary?.slice(0, 300) ?? null, leadId } });
  return "forwarded";
}

/** The lead a keen reply opens: this customer and contact, the account manager's, from an existing customer. */
async function openLead(e: Email, fromName: string, kind: ReplyKind, summary: string | null, mail: IncomingEmail, now: Date): Promise<string> {
  const entry = await newLeadStage(now);
  const title = `${e.company.name} — ${kind === "CALL_ME" ? "wants a call" : "interested"} after a check-in`.slice(0, 200);
  const made = await db
    .$transaction(
      async (tx) => {
        await markLeadWrite(tx, "reengage");
        const decided = await intakeOwner(tx, { kind: "named", userId: e.ownerId, note: "Their account manager — the check-in went from them" });
        const created = await tx.lead.create({
          data: {
            ...entry,
            companyId: e.companyId,
            contactId: e.contactId,
            title,
            description: summary ?? null,
            ownerUserId: decided.userId,
            createdByUserId: e.ownerId,
            source: "EXISTING_CUSTOMER",
            sourceDetail: "A reply to Tara's check-in email",
            assignmentNote: decided.note?.slice(0, 300) ?? null,
          },
          select: { id: true },
        });
        await tx.activity.create({ data: { leadId: created.id, userId: e.ownerId, type: "EMAIL", notes: `Reply from ${fromName} to the check-in "${e.subject}":\n\n${mail.text.slice(0, 2000)}`, occurredAt: now } });
        await emitLeadCreated(tx, created.id, e.ownerId, "check-in-reply");
        return created;
      },
      { maxWait: 10_000, timeout: 20_000 },
    )
    .catch((err) => {
      throw leadCapacityError(err) ?? err;
    });
  await recordAudit({ userId: e.ownerId, action: "CREATE", entityType: "Lead", entityId: made.id, entityLabel: `${title} — opened from a reply to a check-in` });
  await refreshLeadScoreQuietly(made.id);
  return made.id;
}

// ─── What screens show ────────────────────────────────────────────────────────────────────────────────────────────

export type CheckInView = {
  id: string;
  status: string;
  subject: string;
  body: string;
  ownerName: string | null;
  contactName: string;
  createdAt: string;
  sendAt: string | null;
  sentAt: string | null;
  repliedAt: string | null;
  replyLabel: string | null;
  replySummary: string | null;
  leadHref: string | null;
  error: string | null;
};

export type CheckInCard = {
  companyId: string;
  latest: CheckInView | null;
  isOwner: boolean;
  /** This person may ask Tara for one now. */
  mayDraft: boolean;
  /** Why Tara won't write now (one voice), or why this person can't ask — null when nothing to say. */
  note: string | null;
  /** Whether replies come back to Deskzo (an inbound domain is set). */
  repliesCaught: boolean;
  /** When "Approve" would send now — null inside working hours, else "Mon 24 Nov, 10:00". */
  holdUntil: string | null;
  months: number;
  /** This person's thumbs on the latest draft (step 2's scorecard). */
  thumb: boolean | null;
};

/** The check-in card on a customer's page — null when re-engaging is off and there's nothing to show. */
export async function checkInCardOf(companyId: string, userId: string, mayEditCompany: boolean, now = new Date()): Promise<CheckInCard | null> {
  const config = await reengageConfig();
  if (!config.migrated) return null;
  const row = await db.reengageEmail.findFirst({
    where: { companyId, status: { not: "PASSED" } },
    orderBy: { createdAt: "desc" },
    include: { contact: { select: { name: true } } },
  });
  if (!config.enabled && !row) return null;
  const [owner, company, clock] = await Promise.all([
    row ? db.user.findUnique({ where: { id: row.ownerId }, select: { name: true } }) : null,
    db.company.findUnique({ where: { id: companyId }, select: { ownerUserId: true } }),
    workspaceClock(),
  ]);
  const lead = row?.leadId ? await db.lead.findUnique({ where: { id: row.leadId }, select: { leadSeq: true } }) : null;
  const isOwner = company?.ownerUserId === userId;
  let mayDraft = false;
  let note: string | null = null;
  if (config.enabled && (!row || (row.status !== "WAITING" && row.status !== "SCHEDULED"))) {
    const why = voiceReason(await voiceFacts(companyId, now, config.months), now, config.months);
    if (why) note = why;
    else if (!(isOwner || mayEditCompany)) note = "Its account manager can ask Tara for a check-in";
    else if (!(await can(userId, "copilot.use"))) note = "Asking Tara takes the “Use Deskzo AI” permission";
    else if (!(await copilotConfig()).enabled) note = "Deskzo AI is switched off";
    else mayDraft = true;
  }
  const hold = sendTimeFor(now, clock.zone);
  return {
    companyId,
    latest: row
      ? {
          id: row.id,
          status: row.status,
          subject: row.subject,
          body: row.body,
          ownerName: owner?.name ?? null,
          contactName: row.contact.name,
          createdAt: row.createdAt.toISOString(),
          sendAt: row.sendAt?.toISOString() ?? null,
          sentAt: row.sentAt?.toISOString() ?? null,
          repliedAt: row.repliedAt?.toISOString() ?? null,
          replyLabel: row.replyKind ? (REPLY_KIND_LABELS[row.replyKind as ReplyKind] ?? "Replied") : row.repliedAt ? "Replied" : null,
          replySummary: row.replySummary,
          leadHref: lead ? leadPath(lead.leadSeq) : null,
          error: row.error,
        }
      : null,
    isOwner: row ? row.ownerId === userId : isOwner,
    mayDraft,
    note,
    repliesCaught: !!inboundDomain(),
    holdUntil: hold.getTime() > now.getTime() + 60_000 ? sendTimeLabel(hold, clock.zone) : null,
    months: config.months,
    thumb: row ? ((await feedbackOf("reengage.email", [row.id], userId))[row.id] ?? null) : null,
  };
}

/** Check-ins waiting for this account manager — "Waiting for you". */
export async function checkInsWaitingFor(userId: string, take = 8): Promise<{ items: { id: string; company: string; href: string; subject: string; at: Date }[]; count: number }> {
  try {
    const where = { ownerId: userId, status: "WAITING" };
    const [rows, count] = await Promise.all([
      db.reengageEmail.findMany({ where, orderBy: { createdAt: "asc" }, take, select: { id: true, subject: true, createdAt: true, company: { select: { name: true, companySeq: true } } } }),
      db.reengageEmail.count({ where }),
    ]);
    return { items: rows.map((r) => ({ id: r.id, company: r.company.name, href: `${companyPath(r.company.companySeq)}#check-in`, subject: r.subject, at: r.createdAt })), count };
  } catch (err) {
    if (notMigratedYet(err)) return { items: [], count: 0 };
    throw err;
  }
}

export type ReengageReport = { quietNow: number; drafted: number; sent: number; replied: number; leads: number; turnedDown: number };

/** The last 30 days, for Settings — and how many customers are quiet by the workspace's months today. */
export async function reengageReport(months: number, now = new Date()): Promise<ReengageReport> {
  const since = new Date(now.getTime() - 30 * DAY);
  try {
    const [quietNow, drafted, sent, replied, leads, turnedDown] = await Promise.all([
      db.company.count({ where: { managedByResellerId: null, customerStats: { lastPurchaseAt: { lt: monthsBefore(now, months) } } } }),
      db.reengageEmail.count({ where: { createdAt: { gte: since }, status: { not: "PASSED" } } }),
      db.reengageEmail.count({ where: { status: "SENT", sentAt: { gte: since } } }),
      db.reengageEmail.count({ where: { repliedAt: { gte: since } } }),
      db.reengageEmail.count({ where: { repliedAt: { gte: since }, leadId: { not: null } } }),
      db.reengageEmail.count({ where: { status: "SKIPPED", updatedAt: { gte: since } } }),
    ]);
    return { quietNow, drafted, sent, replied, leads, turnedDown };
  } catch (err) {
    if (notMigratedYet(err)) return { quietNow: 0, drafted: 0, sent: 0, replied: 0, leads: 0, turnedDown: 0 };
    throw err;
  }
}
