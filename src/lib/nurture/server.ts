import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { notMigratedYet } from "@/lib/not-migrated";
import { moduleAvailableForTenant } from "@/lib/modules-access";
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
import { leadPath } from "@/lib/record-links";
import { quickContext } from "@/lib/quick-messages/server";
import { gatherPlanInput, latestPlan } from "@/lib/research/plan-server";
import {
  nurtureSystemFor,
  PROPOSE_EMAIL,
  TOUCHES,
  emailSchema,
  finalText,
  newReplyToken,
  nextTouchAt,
  nurturePrompt,
  replyAddress,
  type SentTouch,
} from "@/lib/nurture/rules";
import type { IncomingEmail } from "@/lib/support-mail/parse";
import { randomBytes } from "node:crypto";
import { teammateWork } from "@/lib/ai/teammate-work";
import { NURTURE_STEPS } from "@/lib/ai/teammate-steps";
import { noteFrom } from "@/lib/ai/teammates";
import { teammate } from "@/lib/ai/teammates-server";
import { examplesBlock, examplesFor, markSkipped, noteReplied, recordDraft } from "@/lib/ai/drafts";
import { styled } from "@/lib/ai/house-style";
import { TOPICS } from "@/lib/marketing/topics";
import {
  READ_REPLY,
  REPLY_KIND_LABELS,
  REPLY_SYSTEM,
  bookingRef,
  morningOf,
  otherAddresses,
  readReplySchema,
  replyPrompt,
  scrubReply,
  sendTimeFor,
  sendTimeLabel,
  usableResume,
  withBookingLine,
  type ReadReply,
  type ReplyKind,
} from "@/lib/nurture/replies";
import { workspacePack } from "@/lib/country-pack";

/**
 * Deskzo AI nurturing a lead (owner, 18 Nov 2026 — phase 3; src/lib/nurture/rules.ts for the cadence and the words).
 *
 *   · Switched on for the workspace in Settings › Deskzo AI, then for a lead by somebody who may use Deskzo AI, from its
 *     Research & plan: the first email is the plan's own draft.
 *   · Every email waits for the lead's owner — whose mailbox it goes from — to read, change and send it. The heartbeat
 *     drafts the next when it falls due (at most so many a day); nothing goes by itself.
 *   · Sent as a quick message is: the customer's own choices and blocks honoured, the "manage what we send you" line, in
 *     the mail log, and counted toward the workspace's 24-hour limit as a workflow's (src/lib/customer-mail-cap.ts).
 *   · The reply-to is the workspace's own inbound address with a secret in it (`<slug>+n-<token>@…`). A reply ends it,
 *     reaches the owner forwarded, with a task and a notice. So does a call or meeting somebody logs, a meeting booked,
 *     the lead closing, or the contact leaving or opting out. Four emails and a week with no answer: handed back.
 */

const DAY = 86_400_000;
const CLOSED: ("WON" | "LOST" | "DISQUALIFIED")[] = ["WON", "LOST", "DISQUALIFIED"];
const PER_TICK = 10;
export const NURTURE_PER_DAY_MAX = 500;

export class NurtureRefusal extends Error {}

// ─── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type NurtureConfig = {
  enabled: boolean;
  perDay: number;
  migrated: boolean;
  /** Phase 4: hot and warm leads planned by themselves nurtured without a click, since when. */
  autoStart: boolean;
  autoStartSince: Date | null;
  /** Phase 4: the owner's booking page at the foot of each email. */
  bookingLinks: boolean;
  /** Whether phase 4's columns are here yet (src/lib/tenancy/clients.ts NOT_YET_EVERYWHERE). */
  phase4: boolean;
};

export async function nurtureConfig(): Promise<NurtureConfig> {
  let base: { enabled: boolean; perDay: number; updatedById: string | null } | null;
  try {
    base = await db.nurtureSettings.findUnique({ where: { id: "global" }, select: { enabled: true, perDay: true, updatedById: true } });
  } catch (err) {
    if (notMigratedYet(err)) return { enabled: false, perDay: 50, migrated: false, autoStart: false, autoStartSince: null, bookingLinks: true, phase4: false };
    throw err;
  }
  const out: NurtureConfig = { enabled: base?.enabled ?? false, perDay: base?.perDay ?? 50, migrated: true, autoStart: false, autoStartSince: null, bookingLinks: true, phase4: true };
  try {
    const more = await db.nurtureSettings.findUnique({ where: { id: "global" }, select: { autoStart: true, autoStartSince: true, bookingLinks: true } });
    if (more) Object.assign(out, { autoStart: more.autoStart, autoStartSince: more.autoStartSince, bookingLinks: more.bookingLinks });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
    out.phase4 = false;
  }
  return out;
}

export async function saveNurtureConfig(input: { enabled: boolean; perDay: number; autoStart?: boolean; bookingLinks?: boolean }, userId: string, now = new Date()): Promise<void> {
  const before = await nurtureConfig();
  await db.nurtureSettings.upsert({
    where: { id: "global" },
    create: { id: "global", enabled: input.enabled, perDay: input.perDay, updatedById: userId },
    update: { enabled: input.enabled, perDay: input.perDay, updatedById: userId },
    select: { id: true },
  });
  if (!before.phase4 || (input.autoStart === undefined && input.bookingLinks === undefined)) return;
  const autoStart = input.autoStart ?? before.autoStart;
  await db.nurtureSettings.update({
    where: { id: "global" },
    data: {
      autoStart,
      // Only leads planned from the moment it goes on — never the backlog.
      autoStartSince: autoStart ? (before.autoStart ? before.autoStartSince : now) : null,
      bookingLinks: input.bookingLinks ?? before.bookingLinks,
    },
    select: { id: true },
  });
}

/** Emails drafted since the workspace's midnight — each was a Deskzo AI turn (the first, the plan's, wasn't). */
export async function draftedToday(now = new Date()): Promise<number> {
  const clock = await workspaceClock();
  const midnight = clock.startOfDay(clock.today(now)) ?? new Date(now.getTime() - DAY);
  return db.nurtureTouch.count({ where: { createdAt: { gte: midnight }, step: { gt: 0 } } }).catch(() => 0);
}

// ─── Why it should stop ───────────────────────────────────────────────────────────────────────────────────────────

type Enrolment = Awaited<ReturnType<typeof loadEnrolment>>;

async function loadEnrolment(where: { id: string } | { leadId: string } | { replyToken: string }) {
  return db.nurtureEnrolment.findUnique({
    where,
    include: {
      touches: { orderBy: { step: "asc" } },
      lead: { select: { id: true, leadSeq: true, title: true, status: true, companyId: true, company: { select: { name: true } } } },
      contact: { select: { id: true, name: true, email: true, leftAt: true } },
    },
  });
}

/** Why the nurture should end now, in words — or null to carry on. The contact's own choices are read at sending. */
export async function stopReasonFor(e: NonNullable<Enrolment>): Promise<string | null> {
  if (CLOSED.includes(e.lead.status as (typeof CLOSED)[number])) return `The lead was marked ${e.lead.status.toLowerCase()}`;
  if (e.contact.leftAt) return `${e.contact.name.split(/\s+/)[0]} has left the company`;
  if (!e.contact.email) return "The contact has no email address";
  const person = await db.activity.findFirst({ where: { leadId: e.leadId, type: { in: ["CALL", "MEETING"] }, occurredAt: { gt: e.createdAt } }, select: { type: true } });
  if (person) return person.type === "CALL" ? "A call was logged — a person has it now" : "A meeting was logged — a person has it now";
  const meeting = await db.calendarEvent.findFirst({ where: { leadId: e.leadId, createdAt: { gt: e.createdAt } }, select: { id: true } }).catch(() => null);
  if (meeting) return "A meeting was booked — a person has it now";
  return null;
}

/** Ends it: no more emails, a waiting draft set aside; `handover` gives the owner a task and a notice. */
async function endNurture(e: NonNullable<Enrolment>, status: "STOPPED" | "DONE", reason: string, handover: { title: string; notice: string } | null, at = new Date()): Promise<void> {
  await db.nurtureEnrolment.update({ where: { id: e.id }, data: { status, stopReason: reason.slice(0, 300), nextTouchAt: null, endedAt: at } });
  await db.nurtureTouch.updateMany({ where: { enrolmentId: e.id, status: { in: ["WAITING", "SCHEDULED"] } }, data: { status: "SKIPPED", error: reason.slice(0, 300) } });
  if (!handover) return;
  const owner = await db.user.findUnique({ where: { id: e.ownerId }, select: { active: true } });
  if (!owner?.active) return;
  await db.task.create({
    data: {
      title: handover.title.slice(0, 500),
      description: `${reason}.\n\nFrom Deskzo AI's nurture of this lead.`,
      dueDate: (await workspaceClock()).calendarDate(at),
      assignedToUserId: e.ownerId,
      createdByUserId: e.ownerId,
      leadId: e.leadId,
      status: "TODO",
      priority: "HIGH",
    },
    select: { id: true },
  });
  await notifyUser({ userId: e.ownerId, type: "LEAD_ACTIVITY", title: handover.notice, message: `${e.lead.company.name} — ${e.lead.title}`, link: leadPath(e.lead.leadSeq) });
}

// ─── Starting ─────────────────────────────────────────────────────────────────────────────────────────────────────

/** Starts nurturing a lead from its plan: the plan's email waits for its owner. Throws NurtureRefusal with words. */
export async function enrolLead(leadId: string, userId: string, now = new Date()): Promise<void> {
  const config = await nurtureConfig();
  if (!config.enabled) throw new NurtureRefusal("Nurturing isn't switched on — an admin can switch it on in Settings → Deskzo AI.");
  const lead = await db.lead.findUnique({ where: { id: leadId }, select: { id: true, status: true, companyId: true, contactId: true, ownerUserId: true, nurture: { select: { status: true } } } });
  if (!lead) throw new NurtureRefusal("Lead not found.");
  if (CLOSED.includes(lead.status as (typeof CLOSED)[number])) throw new NurtureRefusal("This lead is closed.");
  if (lead.nurture?.status === "ACTIVE") throw new NurtureRefusal("Deskzo AI is already nurturing this lead.");
  const plan = await latestPlan({ kind: "lead", id: leadId });
  if (!plan?.plan.email) throw new NurtureRefusal("Make a Research & plan first — its email is the first one.");

  // Whose mailbox: the lead's owner where they may use Deskzo AI, else whoever starts it.
  const ownerOk = lead.ownerUserId ? await db.user.findUnique({ where: { id: lead.ownerUserId }, select: { active: true } }) : null;
  const ownerId = lead.ownerUserId && ownerOk?.active && (await can(lead.ownerUserId, "copilot.use")) ? lead.ownerUserId : userId;
  const context = await quickContext(ownerId, { moment: "ANY", companyId: lead.companyId, leadId });
  if (!context) throw new NurtureRefusal("That company isn't there any more.");
  if ("error" in context) throw new NurtureRefusal(context.error);
  if (context.emailRoute.via === "none") throw new NurtureRefusal(context.emailRoute.why);
  const contact = context.contacts.find((c) => c.id === lead.contactId && c.email) ?? context.contacts.find((c) => c.primary && c.email) ?? context.contacts.find((c) => c.email);
  if (!contact) throw new NurtureRefusal("Nobody at this company has an email address to write to.");
  if (contact.emailStopped) throw new NurtureRefusal(`${contact.name} can't be emailed: ${contact.emailStopped}`);

  await db.$transaction(async (tx) => {
    // A finished or stopped nurture is replaced: one per lead.
    await tx.nurtureEnrolment.deleteMany({ where: { leadId, status: { not: "ACTIVE" } } });
    await tx.nurtureEnrolment.create({
      data: {
        leadId,
        contactId: contact.id,
        ownerId,
        enrolledById: userId,
        replyToken: newReplyToken(),
        createdAt: now,
        touches: { create: [{ step: 0, status: "WAITING", subject: plan.plan.email!.subject, body: plan.plan.email!.body }] },
      },
      select: { id: true },
    });
  });
  await recordAudit({ userId, action: "UPDATE", entityType: "Lead", entityId: leadId, entityLabel: `Deskzo AI started nurturing this lead: ${TOUCHES} emails over two weeks, each approved before it goes` });
  if (ownerId !== userId) {
    // In Tara's own voice (src/lib/ai/teammates.ts `noteFrom`).
    await notifyUser({ userId: ownerId, type: "LEAD_ACTIVITY", title: noteFrom((await teammate("tara")).name, "the first email for one of your leads is ready — have a look?"), message: "Nothing goes until you send it.", link: "/today" });
  }
}

// ─── Drafting (the heartbeat) ─────────────────────────────────────────────────────────────────────────────────────

async function sentSoFar(e: NonNullable<Enrolment>, now: Date): Promise<SentTouch[]> {
  return e.touches.filter((t) => t.status === "SENT").map((t) => ({ step: t.step, subject: t.subject, body: t.body, daysAgo: Math.max(0, Math.floor((now.getTime() - (t.sentAt ?? t.createdAt).getTime()) / DAY)) }));
}

/** Writes email `step` with Deskzo AI, asked once more if it doesn't come back as one. Throws NurtureRefusal. */
async function draftEmail(e: NonNullable<Enrolment>, step: number, now: Date, writing?: () => Promise<void>): Promise<{ subject: string; body: string }> {
  const plan = await latestPlan({ kind: "lead", id: e.leadId });
  if (!plan) throw new NurtureRefusal("The lead's plan isn't there any more.");
  const gathered = await gatherPlanInput({ kind: "lead", id: e.leadId }, e.ownerId);
  const prompt = nurturePrompt({ plan: plan.plan, lead: gathered?.input.lead ?? null, companyName: e.lead.company.name, step, sent: await sentSoFar(e, now) });
  // Step 2: a few of this team's follow-ups that went (nearly) as written and got a reply, to write like them.
  const learned = examplesBlock(await examplesFor("nurture.email"));
  await writing?.();
  const history: Parameters<typeof aiTurn>[0]["history"] = [{ role: "user", text: prompt + learned }];
  for (let attempt = 0; attempt < 2; attempt++) {
    let outcome;
    try {
      outcome = await aiTurn({ userId: e.ownerId, feature: "nurture.email", system: await styled(nurtureSystemFor(workspacePack().india)), history, tools: [PROPOSE_EMAIL] });
    } catch (err) {
      if (err instanceof AiRefusal) throw new NurtureRefusal(err.message);
      throw err;
    }
    const call = outcome.toolCalls.find((c) => c.name === PROPOSE_EMAIL.name);
    const read = call ? emailSchema.safeParse(call.input) : null;
    if (read?.success) return read.data;
    history.push({ role: "assistant", text: outcome.text, toolCalls: outcome.toolCalls, ...(outcome.native ? { native: { provider: outcome.family, model: outcome.model, content: outcome.native, masked: outcome.masked } } : {}) });
    if (outcome.toolCalls.length) history.push({ role: "tool", results: outcome.toolCalls.map((c) => ({ id: c.id, name: c.name, output: "Call propose_email again with a subject and a body of a few sentences.", isError: true })) });
    else history.push({ role: "user", text: "Call propose_email now." });
  }
  throw new NurtureRefusal("Deskzo AI didn't come back with an email.");
}

export type NurtureRun = { drafted: number; ended: number; sent?: number; started?: number; reason?: string };

/**
 * Emails approved for a working morning whose time has come (phase 4): sent as their owner, every check made again. One
 * that can't go comes back to its owner to look at, saying why — never sent later by itself.
 */
async function sendHeld(config: NurtureConfig, now: Date): Promise<number> {
  if (!config.phase4) return 0;
  const held = await db.nurtureTouch.findMany({ where: { status: "SCHEDULED", sendAt: { lte: now } }, orderBy: { sendAt: "asc" }, take: PER_TICK, select: { id: true, step: true, subject: true, body: true, approvedById: true, enrolmentId: true } });
  let sent = 0;
  for (const t of held) {
    const e = await loadEnrolment({ id: t.enrolmentId });
    if (!e || e.status !== "ACTIVE") {
      await db.nurtureTouch.update({ where: { id: t.id }, data: { status: "SKIPPED", sendAt: null, error: "The nurture had ended before it was due." } });
      continue;
    }
    try {
      await deliverTouch(e, t, { subject: t.subject, body: t.body }, t.approvedById ?? e.ownerId, now, config);
      sent += 1;
    } catch (err) {
      const why = err instanceof NurtureRefusal ? err.message : "It couldn't be sent.";
      if (!(err instanceof NurtureRefusal)) console.error("[nurture] a held email failed", err instanceof Error ? err.message : err);
      // Back to its owner, unsent — unless the checks ended the nurture, which set it aside already.
      await db.nurtureTouch.updateMany({ where: { id: t.id, status: "SCHEDULED" }, data: { status: "WAITING", sendAt: null, error: why.slice(0, 500) } });
      await notifyUser({ userId: e.ownerId, type: "LEAD_ACTIVITY", title: `A nurture email for ${e.lead.company.name} didn't go`, message: why.slice(0, 300), link: leadPath(e.lead.leadSeq) }).catch(() => undefined);
    }
  }
  return sent;
}

/**
 * Hot and warm leads Research & plan read by itself, nurtured without a click (phase 4 — off until an admin switches it
 * on): only leads planned since then, opened within the last three days, not nurtured before. Started as whoever
 * switched it on, the email going from the lead's owner as when somebody presses the button.
 */
async function autoStart(config: NurtureConfig, now: Date): Promise<number> {
  if (!config.autoStart || !config.autoStartSince) return 0;
  const by = (await db.nurtureSettings.findUnique({ where: { id: "global" }, select: { updatedById: true } }))?.updatedById;
  if (!by) return 0;
  const since = new Date(Math.max(config.autoStartSince.getTime(), now.getTime() - 3 * DAY));
  const runs = await db.autoPlanRun.findMany({
    where: { status: "DONE", at: { gte: since }, lead: { nurture: { is: null }, status: { notIn: CLOSED } } },
    orderBy: { at: "asc" },
    take: 5,
    select: { leadId: true },
  });
  let started = 0;
  for (const { leadId } of runs) {
    const plan = await latestPlan({ kind: "lead", id: leadId });
    if (!plan || (plan.plan.fit !== "HOT" && plan.plan.fit !== "WARM") || !plan.plan.email) continue;
    try {
      await enrolLead(leadId, by, now);
      started += 1;
    } catch (err) {
      // No email to write to, the owner's mailbox gone: passed over, as the button would say.
      if (!(err instanceof NurtureRefusal)) console.error("[nurture] starting by itself failed", err instanceof Error ? err.message : err);
    }
  }
  return started;
}

/** The heartbeat's turn: each nurture whose next email is due is checked, ended, or given its next draft to approve. */
export async function runNurture(now = new Date()): Promise<NurtureRun> {
  const config = await nurtureConfig();
  if (!config.enabled) return { drafted: 0, ended: 0, reason: "off" };
  if (!(await moduleAvailableForTenant("leads"))) return { drafted: 0, ended: 0, reason: "leads are off" };
  // Sending what its owner approved is no AI's: it goes even with Deskzo AI paused.
  const sent = await sendHeld(config, now);
  if (!(await copilotConfig()).enabled) return { drafted: 0, ended: 0, sent, reason: "Deskzo AI is off" };
  const started = await autoStart(config, now).catch((err) => {
    console.error("[nurture] auto-start failed", err instanceof Error ? err.message : err);
    return 0;
  });
  const due = await db.nurtureEnrolment.findMany({ where: { status: "ACTIVE", nextTouchAt: { lte: now } }, orderBy: { nextTouchAt: "asc" }, take: PER_TICK, select: { id: true } });
  const out: NurtureRun = { drafted: 0, ended: 0, sent, started };
  let left = config.perDay - (await draftedToday(now));
  for (const { id } of due) {
    const e = await loadEnrolment({ id });
    if (!e || e.status !== "ACTIVE") continue;
    const stop = await stopReasonFor(e);
    if (stop) {
      await endNurture(e, "STOPPED", stop, null, now);
      out.ended += 1;
      continue;
    }
    if (e.touches.some((t) => t.status === "WAITING" || t.status === "SCHEDULED")) {
      await db.nurtureEnrolment.update({ where: { id: e.id }, data: { nextTouchAt: null } });
      continue;
    }
    const step = e.touches.length;
    if (step >= TOUCHES) {
      await endNurture(e, "DONE", `No reply after ${e.touchesSent} email${e.touchesSent === 1 ? "" : "s"}`, { title: `No reply from ${e.lead.company.name} — call them?`, notice: noteFrom((await teammate("tara")).name, `no reply from ${e.lead.company.name} after my emails — worth a call? I've left you a task.`) }, now);
      out.ended += 1;
      continue;
    }
    if (left <= 0) {
      out.reason = "today's limit";
      break;
    }
    try {
      // Tara's work, for the lead's owner to see as it happens (src/lib/ai/teammate-work.ts).
      await teammateWork(
        { teammate: "tara", userId: e.ownerId, kind: "nurture.draft", subject: `lead:${e.leadId}`, label: e.lead.company.name, href: leadPath(e.lead.leadSeq), steps: NURTURE_STEPS },
        async (work) => {
          const email = await draftEmail(e, step, now, () => work.step(1));
          await work.step(2);
          await db.nurtureTouch.create({ data: { enrolmentId: e.id, step, status: "WAITING", subject: email.subject, body: email.body } });
        },
        () => `Email ${step + 1} of ${TOUCHES} is ready for you to check`,
      );
      // And she says so, in her own voice — once a draft, never for one that failed.
      await notifyUser({
        userId: e.ownerId,
        type: "LEAD_ACTIVITY",
        title: noteFrom((await teammate("tara")).name, `I've drafted email ${step + 1} of ${TOUCHES} for ${e.lead.company.name} — have a look?`),
        message: "Nothing goes until you send it.",
        link: "/today",
      }).catch((err) => console.error("[nurture] the draft's notice failed", err instanceof Error ? err.message : err));
      await db.nurtureEnrolment.update({ where: { id: e.id }, data: { nextTouchAt: null } });
      out.drafted += 1;
      left -= 1;
    } catch (err) {
      // Out of credits, AI paused: try again on a later heartbeat, not now.
      await db.nurtureEnrolment.update({ where: { id: e.id }, data: { nextTouchAt: new Date(now.getTime() + 6 * 60 * 60_000) } });
      if (err instanceof NurtureRefusal) break;
      console.error("[nurture] drafting failed", err instanceof Error ? err.message : err);
    }
  }
  return out;
}

// ─── Approving, skipping, stopping ────────────────────────────────────────────────────────────────────────────────

/**
 * Approves a waiting email as its owner, as written or as they changed it (phase 4, owner 20 Nov 2026 — "sent in their
 * working hours"): `when: "working-hours"` sends it now inside a working day's hours and otherwise holds it for 10 the
 * next working morning; `"now"` sends it at once. A held one can be sent now from the card. Throws NurtureRefusal.
 */
export async function approveTouch(
  touchId: string,
  userId: string,
  edited: { subject: string; body: string },
  now = new Date(),
  when: "now" | "working-hours" = "now",
): Promise<{ to: string; at: string | null }> {
  const touch = await db.nurtureTouch.findUnique({ where: { id: touchId }, select: { id: true, status: true, step: true, enrolmentId: true, subject: true, body: true } });
  if (!touch || (touch.status !== "WAITING" && touch.status !== "SCHEDULED")) throw new NurtureRefusal("That email isn't waiting any more.");
  // The workspace's switch stops sending too, not only drafting: off is off.
  const config = await nurtureConfig();
  if (!config.enabled) throw new NurtureRefusal("Nurturing is switched off in Settings → Deskzo AI.");
  const e = await loadEnrolment({ id: touch.enrolmentId });
  if (!e || e.status !== "ACTIVE") throw new NurtureRefusal("This lead isn't being nurtured any more.");
  if (e.ownerId !== userId) throw new NurtureRefusal("Only the lead's owner sends these — they go from their mailbox.");
  const subject = edited.subject.trim().slice(0, 300);
  const body = edited.body.trim().slice(0, 5000);
  if (subject.length < 3 || body.length < 20) throw new NurtureRefusal("The email needs a subject and a few sentences.");
  if (when === "working-hours" && config.phase4) {
    const clock = await workspaceClock();
    const at = sendTimeFor(now, clock.zone);
    if (at.getTime() > now.getTime() + 60_000) {
      await preflight(e, now);
      await db.nurtureTouch.update({ where: { id: touch.id }, data: { status: "SCHEDULED", subject, body, approvedById: userId, sendAt: at, error: null } });
      // Step 2 (owner, 20 Nov 2026): the draft as written beside what was approved (src/lib/ai/drafts.ts).
      if (touch.status === "WAITING") await recordDraft({ teammate: "tara", kind: "nurture.email", ref: touch.id, userId, draft: { subject: touch.subject, body: touch.body }, sent: { subject, body } });
      await recordAudit({ userId, action: "UPDATE", entityType: "NurtureTouch", entityId: touch.id, entityLabel: `Nurture email ${touch.step + 1} approved, to go ${sendTimeLabel(at, clock.zone)}: ${subject}` });
      return { to: e.contact.name, at: at.toISOString() };
    }
  }
  const sent = await deliverTouch(e, touch, { subject, body }, userId, now, config);
  // Held for the morning already counted its draft; one sent from waiting is counted now.
  if (touch.status === "WAITING") await recordDraft({ teammate: "tara", kind: "nurture.email", ref: touch.id, userId, draft: { subject: touch.subject, body: touch.body }, sent: { subject, body } });
  return { to: sent.to, at: null };
}

/** The checks made before an email is sent or held to be sent: the nurture still on, the contact still reachable. */
async function preflight(e: NonNullable<Enrolment>, now: Date) {
  const stop = await stopReasonFor(e);
  if (stop) {
    await endNurture(e, "STOPPED", stop, null, now);
    throw new NurtureRefusal(`Stopped before sending: ${stop}.`);
  }
  const context = await quickContext(e.ownerId, { moment: "ANY", companyId: e.lead.companyId, leadId: e.leadId });
  if (!context || "error" in context) throw new NurtureRefusal(context && "error" in context ? context.error : "That company isn't there any more.");
  if (context.emailRoute.via === "none") throw new NurtureRefusal(context.emailRoute.why);
  const contact = context.contacts.find((c) => c.id === e.contactId);
  if (!contact?.email) throw new NurtureRefusal("The contact has no email address any more.");
  if (contact.emailStopped) {
    await endNurture(e, "STOPPED", `${contact.name} can't be emailed: ${contact.emailStopped}`, null, now);
    throw new NurtureRefusal(`${contact.name} can't be emailed: ${contact.emailStopped}`);
  }
  return { context, contact };
}

/** The owner's booking page for this lead, tied to it by the nurture's reference — or null when they have none. */
async function bookingLinkFor(e: NonNullable<Enrolment>, origin: string): Promise<string | null> {
  if (!(await moduleAvailableForTenant("booking"))) return null;
  const page = await db.bookingPage
    .findFirst({ where: { active: true, hostUserIds: { has: e.ownerId } }, orderBy: { createdAt: "asc" }, select: { slug: true } })
    .catch(() => null);
  return page ? `${origin}/book/${page.slug}?ref=${bookingRef(e.replyToken)}` : null;
}

/** Sends one email of a nurture, as its owner — the checks made again first. Throws NurtureRefusal with words. */
async function deliverTouch(
  e: NonNullable<Enrolment>,
  touch: { id: string; step: number },
  edited: { subject: string; body: string },
  userId: string,
  now: Date,
  config: NurtureConfig,
): Promise<{ to: string }> {
  const subject = edited.subject;
  let body = edited.body;
  const { context, contact } = await preflight(e, now);

  const owner = await db.user.findUnique({ where: { id: e.ownerId }, select: { id: true, name: true, email: true } });
  if (!owner) throw new NurtureRefusal("The lead's owner no longer works here.");
  const [origin, org, tenant] = await Promise.all([tenantOrigin(), getOrganisation(), currentTenant()]);
  // Phase 4: the owner's booking page, tied to this lead — a booking lands on it and ends the nurture.
  const booking = config.bookingLinks ? await bookingLinkFor(e, origin) : null;
  if (booking) body = withBookingLine(body, booking);
  const token = randomBytes(24).toString("base64url");
  const text = finalText(body, { firstName: contact.name.split(/\s+/)[0] ?? null, senderName: owner.name }, `${origin}/preferences/${token}`);
  const html = textToHtml(text);
  const domain = inboundDomain();
  const replyTo = domain ? replyAddress(tenant.slug, e.replyToken, domain) : null;

  let from = "";
  const sent = await countedAs("automation", async () => {
    if (context.emailRoute.via === "mailbox") {
      const out = await sendAsUser(owner.id, { subject, html, to: [{ name: contact.name, email: contact.email! }], ...(replyTo ? { replyTo: { name: owner.name, email: replyTo } } : {}), attachments: [] });
      if (out.ok) from = out.mailbox;
      return out.ok ? null : out.error;
    }
    const out = await deliverNow({ to: contact.email!, toName: contact.name, fromName: senderDisplayName(owner.name, org.tradeName || org.legalName || ""), replyTo: replyTo ?? owner.email, subject, html, text }, "TRANSACTIONAL", { delivering: true });
    if (out.ok) from = out.fromEmail ?? out.provider;
    return out.ok ? null : out.error;
  });
  if (sent) {
    await db.nurtureTouch.update({ where: { id: touch.id }, data: { error: sent.slice(0, 500) } });
    throw new NurtureRefusal(`It didn't go: ${sent}`);
  }

  await db.marketingMessage.create({
    data: { token, companyId: e.lead.companyId, contactId: contact.id, channel: "EMAIL", messageClass: "TRANSACTIONAL", subject, body: html, textBody: text, toEmail: contact.email, status: "SENT", scheduledFor: now, sentAt: now, attempts: 1, sentByUserId: owner.id, fromEmail: from },
  });
  await db.activity.create({ data: { leadId: e.leadId, userId: owner.id, type: "EMAIL", notes: `Nurture email ${touch.step + 1} of ${TOUCHES}, written by Deskzo AI and sent by ${owner.name}: ${subject}`, occurredAt: now } });
  await db.nurtureTouch.update({ where: { id: touch.id }, data: { status: "SENT", subject, body: edited.body, approvedById: userId, sentAt: now, error: null } });
  const sentCount = e.touchesSent + 1;
  await db.nurtureEnrolment.update({ where: { id: e.id }, data: { touchesSent: sentCount, lastSentAt: now, nextTouchAt: nextTouchAt(e.createdAt, touch.step + 1, now) } });
  await recordAudit({ userId, action: "CREATE", entityType: "NurtureTouch", entityId: touch.id, entityLabel: `Nurture email ${touch.step + 1} sent to ${contact.name}: ${subject}` });
  return { to: contact.name };
}

/** Sets a waiting email aside; the next one comes on the cadence. Only its owner. */
export async function skipTouch(touchId: string, userId: string, now = new Date()): Promise<void> {
  const touch = await db.nurtureTouch.findUnique({ where: { id: touchId }, select: { id: true, status: true, step: true, enrolmentId: true, subject: true, body: true } });
  if (!touch || (touch.status !== "WAITING" && touch.status !== "SCHEDULED")) throw new NurtureRefusal("That email isn't waiting any more.");
  const e = await loadEnrolment({ id: touch.enrolmentId });
  if (!e || e.ownerId !== userId) throw new NurtureRefusal("Only the lead's owner decides on these.");
  await db.nurtureTouch.update({ where: { id: touch.id }, data: { status: "SKIPPED", sendAt: null } });
  if (touch.status === "WAITING") await recordDraft({ teammate: "tara", kind: "nurture.email", ref: touch.id, userId, draft: { subject: touch.subject, body: touch.body }, sent: null });
  else await markSkipped("nurture.email", touch.id);
  await db.nurtureEnrolment.update({ where: { id: e.id }, data: { nextTouchAt: nextTouchAt(e.createdAt, touch.step + 1, e.lastSentAt ?? now) } });
}

/** Stops it by hand: "Stop" or "They replied". */
export async function stopNurture(leadId: string, userId: string, replied: boolean, now = new Date()): Promise<void> {
  const e = await loadEnrolment({ leadId });
  if (!e || e.status !== "ACTIVE") throw new NurtureRefusal("This lead isn't being nurtured.");
  const who = (await db.user.findUnique({ where: { id: userId }, select: { name: true } }))?.name ?? "Somebody";
  if (replied) await db.nurtureEnrolment.update({ where: { id: e.id }, data: { repliedAt: now } });
  await endNurture(e, "STOPPED", replied ? `They replied (marked by ${who})` : `Stopped by ${who}`, null, now);
  await recordAudit({ userId, action: "UPDATE", entityType: "Lead", entityId: leadId, entityLabel: replied ? "Nurture ended: they replied" : "Nurture stopped" });
}

// ─── A reply ──────────────────────────────────────────────────────────────────────────────────────────────────────

export type ReplyOutcome = "unknown" | "automated" | "forwarded";

/** The words a handover task and notice take for each kind of reply. */
function handoverFor(kind: ReplyKind, fromName: string, company: string, suggestedName: string | null): { title: string; notice: string } {
  switch (kind) {
    case "CALL_ME":
      return { title: `Call ${fromName} back — ${company}`, notice: `${fromName} asked for a call` };
    case "INTERESTED":
      return { title: `${fromName} is interested — answer them (${company})`, notice: `${fromName} replied, interested` };
    case "WRONG_PERSON":
      return { title: `${fromName} points to ${suggestedName || "somebody else"} at ${company} — add them?`, notice: `${fromName} says to talk to ${suggestedName || "somebody else"}` };
    case "NOT_INTERESTED":
      return { title: `${fromName} isn't interested — close the lead? (${company})`, notice: `${fromName} isn't interested` };
    default:
      return { title: `Answer ${fromName}'s reply — ${company}`, notice: `${fromName} replied to your email` };
  }
}

/**
 * Deskzo AI's reading of a reply (phase 4): what kind it is, a sentence for the owner, a day it names, the person it
 * points to, a stage it suggests, and an answer drafted. Only the reply's own words go, addresses and numbers taken out;
 * read on the owner's credits. Null when Deskzo AI is off, out of credits or doesn't answer — the reply is UNREAD then.
 */
async function readReply(e: NonNullable<Enrolment>, mail: IncomingEmail, now: Date): Promise<ReadReply | null> {
  if (!(await copilotConfig()).enabled) return null;
  const clock = await workspaceClock();
  const answered = [...e.touches].reverse().find((t) => t.status === "SENT")?.subject ?? e.lead.title;
  const prompt = replyPrompt({ today: clock.today(now), answered, reply: scrubReply(mail.text), automated: !!mail.automated });
  try {
    const outcome = await aiTurn({ userId: e.ownerId, feature: "nurture.reply", system: await styled(REPLY_SYSTEM), history: [{ role: "user", text: prompt }], tools: [READ_REPLY] });
    const call = outcome.toolCalls.find((c) => c.name === READ_REPLY.name);
    const read = call ? readReplySchema.safeParse(call.input) : null;
    return read?.success ? read.data : null;
  } catch (err) {
    if (!(err instanceof AiRefusal)) console.error("[nurture] reading a reply failed", err instanceof Error ? err.message : err);
    return null;
  }
}

/**
 * They asked not to be emailed (phase 4 — acted on at once, the customer's own choice): every email topic withdrawn
 * for the contact, their address and the replier's suppressed, any journey they were on ended — as the unsubscribe
 * link does, the reply as the evidence.
 */
export async function stopEmailing(contactId: string, replier: string | null, evidence: string, now: Date): Promise<void> {
  const contact = await db.contact.findUnique({ where: { id: contactId }, select: { id: true, email: true } });
  if (!contact) return;
  for (const t of TOPICS) {
    await db.contactConsent.upsert({
      where: { contactId_channel_topic: { contactId: contact.id, channel: "EMAIL", topic: t.key } },
      create: { contactId: contact.id, channel: "EMAIL", topic: t.key, status: "UNSUBSCRIBED", source: "VERBAL", evidence, withdrawnAt: now },
      update: { status: "UNSUBSCRIBED", evidence, withdrawnAt: now },
    });
  }
  for (const address of new Set([contact.email, replier].filter((a): a is string => !!a).map((a) => a.trim().toLowerCase()))) {
    await db.suppression.upsert({
      where: { scope_value: { scope: "EMAIL", value: address } },
      create: { scope: "EMAIL", value: address, reason: "UNSUBSCRIBED", note: evidence },
      update: { reason: "UNSUBSCRIBED" },
    });
  }
  await db.journeyEnrolment.updateMany({ where: { contactId: contact.id, status: "ACTIVE" }, data: { status: "EXITED", exitedAt: now, exitReason: "They asked not to be emailed", nextRunAt: null } });
}

/** Away until a day (an out-of-office, or "I'm back on the 3rd"): the next email waits for their first morning back. */
async function waitUntil(e: NonNullable<Enrolment>, day: string): Promise<string> {
  const clock = await workspaceClock();
  const morning = morningOf(day, clock.zone);
  if (e.nextTouchAt && e.nextTouchAt < morning) await db.nurtureEnrolment.update({ where: { id: e.id }, data: { nextTouchAt: morning } });
  await db.nurtureTouch.updateMany({ where: { enrolmentId: e.id, status: "SCHEDULED", sendAt: { lt: morning } }, data: { sendAt: morning } });
  return `next email after they're back (${sendTimeLabel(morning, clock.zone)})`;
}

/**
 * An email to a nurture's reply-to address (src/lib/support-mail/inbound.ts). Phase 3: it reaches its owner forwarded,
 * with replies going straight back to the customer, and the nurture ends with a task. Phase 4 (owner, 20 Nov 2026): read
 * by Deskzo AI first, and acted on by its kind —
 *
 *   · asked to stop: no more email to them at all, at once;
 *   · not now, try in March: paused, picked up that morning;
 *   · away until the 3rd (an out-of-office too): the next email waits for them;
 *   · interested, a call, the wrong person, not interested: ended, handed back with the matching task and an answer drafted.
 *
 * One to a nurture that already ended is still forwarded, and still read: a "please stop" is honoured whenever it comes.
 */
/**
 * `forward: false` (owner, 23 Nov 2026 — src/lib/mail-reading/tara.ts): a reply Tara found in the lead owner's own
 * mailbox is in front of them already — read and acted on as any other, but not emailed to them again.
 */
export async function receiveNurtureReply(token: string, mail: IncomingEmail & { senderVerified: boolean }, now = new Date(), opts: { forward?: boolean } = {}): Promise<ReplyOutcome> {
  const e = await loadEnrolment({ replyToken: token });
  if (!e) return "unknown";
  const config = await nurtureConfig();
  if (mail.automated) {
    // An out-of-office naming the day they're back moves the next email after it; any other machine answer changes nothing.
    if (e.status === "ACTIVE" && config.phase4) {
      const read = await readReply(e, mail, now);
      const back = read?.kind === "OUT_OF_OFFICE" ? usableResume(read.resumeOn, (await workspaceClock()).today(now)) : null;
      if (read && back) {
        const acted = await waitUntil(e, back);
        await db.nurtureReply.create({ data: { enrolmentId: e.id, fromName: mail.from?.name ?? null, fromEmail: null, subject: mail.subject.slice(0, 300), kind: "OUT_OF_OFFICE", summary: read.summary, resumeOn: new Date(`${back}T00:00:00Z`), acted } });
      }
    }
    return "automated";
  }
  const owner = await db.user.findUnique({ where: { id: e.ownerId }, select: { id: true, name: true, email: true, active: true } });
  const fromAddress = mail.from?.address ?? "";
  const fromName = mail.from?.name || fromAddress || "The customer";
  // The email they answered — the last that went — got a reply (step 2, src/lib/ai/drafts.ts).
  const answered = [...e.touches].filter((t) => t.status === "SENT").sort((x, y) => (y.sentAt?.getTime() ?? 0) - (x.sentAt?.getTime() ?? 0))[0];
  if (answered) await noteReplied("nurture.email", answered.id, now);
  await db.activity.create({ data: { leadId: e.leadId, userId: e.ownerId, type: "EMAIL", notes: `Reply from ${fromName}${mail.senderVerified ? "" : " (sender not verified)"}: ${mail.subject}\n\n${mail.text.slice(0, 2000)}`, occurredAt: now } });

  if (opts.forward !== false && owner?.active && owner.email) {
    const intro = `${fromName}${fromAddress && fromName !== fromAddress ? ` <${fromAddress}>` : ""} replied to your email about ${e.lead.title} (${e.lead.company.name}).${mail.senderVerified ? "" : "\nTheir mail server didn't confirm the sender — check before acting on it."}\nReply to this email to answer them directly.`;
    await sendPlatformMail({
      type: "DOCUMENTS",
      to: owner.email,
      fromName: `${fromName.slice(0, 60)} via Deskzo`,
      ...(fromAddress && mail.senderVerified ? { replyTo: fromAddress } : {}),
      subject: mail.subject.toLowerCase().startsWith("re:") ? mail.subject : `Re: ${mail.subject}`,
      text: `${intro}\n\n———\n\n${mail.text.slice(0, 20_000)}`,
      logSubject: "A reply to a nurture email, forwarded to the lead's owner",
    }).catch((err) => console.error("[nurture] forwarding a reply failed", err instanceof Error ? err.message : err));
  }

  // Phase 4: read, and kept for the lead's card — with the answer drafted, sent only by its owner.
  const read = config.phase4 ? await readReply(e, mail, now) : null;
  const kind: ReplyKind = read?.kind ?? "UNREAD";
  const clock = await workspaceClock();
  const resume = read ? usableResume(read.resumeOn, clock.today(now)) : null;
  const suggestedEmail = kind === "WRONG_PERSON" ? (otherAddresses(mail.text, fromAddress)[0] ?? null) : null;
  let acted: string | null = null;
  if (kind === "UNSUBSCRIBE") {
    await stopEmailing(e.contactId, mail.senderVerified ? fromAddress || null : null, `Asked not to be emailed, replying to a nurture email on ${clock.today(now)}.`, now);
    acted = "no more email to them — unsubscribed from everything";
  }
  const pausing = e.status === "ACTIVE" && !!resume && (kind === "NOT_NOW" || kind === "OUT_OF_OFFICE");
  if (pausing && resume) {
    if (kind === "NOT_NOW") {
      // Picked up that morning: what was waiting set aside, the next email drafted then.
      await db.nurtureTouch.updateMany({ where: { enrolmentId: e.id, status: { in: ["WAITING", "SCHEDULED"] } }, data: { status: "SKIPPED", sendAt: null, error: `They asked to wait until ${resume}` } });
      const morning = morningOf(resume, clock.zone);
      await db.nurtureEnrolment.update({ where: { id: e.id }, data: { nextTouchAt: morning } });
      acted = `paused until ${sendTimeLabel(morning, clock.zone)}`;
    } else acted = await waitUntil(e, resume);
  }
  if (config.phase4) {
    await db.nurtureReply.create({
      data: {
        enrolmentId: e.id,
        fromName: mail.from?.name ?? null,
        // Answered from Deskzo only to an address its mail server confirmed — anything else from the owner's own inbox.
        fromEmail: mail.senderVerified && fromAddress ? fromAddress.toLowerCase() : null,
        subject: mail.subject.slice(0, 300),
        kind,
        summary: read?.summary ?? null,
        resumeOn: resume ? new Date(`${resume}T00:00:00Z`) : null,
        suggestedName: read?.suggestedName ?? null,
        suggestedEmail,
        suggestedStage: read?.suggestedStage ?? null,
        answerSubject: kind === "UNSUBSCRIBE" ? null : (read?.answer?.subject ?? null),
        answerBody: kind === "UNSUBSCRIBE" ? null : (read?.answer?.body ?? null),
        acted,
      },
    });
  }

  const tara = (await teammate("tara")).name;
  if (e.status !== "ACTIVE") {
    await notifyUser({ userId: e.ownerId, type: "LEAD_ACTIVITY", title: noteFrom(tara, `${fromName} replied to your email — it's yours from here.`), message: `${e.lead.company.name} — ${e.lead.title}${acted ? ` · ${acted}` : ""}`, link: leadPath(e.lead.leadSeq) });
    return "forwarded";
  }
  await db.nurtureEnrolment.update({ where: { id: e.id }, data: { repliedAt: now } });
  if (pausing) {
    await notifyUser({ userId: e.ownerId, type: "LEAD_ACTIVITY", title: noteFrom(tara, `${fromName} replied — ${acted}. I'll pick it up then.`), message: `${e.lead.company.name} — ${e.lead.title}`, link: leadPath(e.lead.leadSeq) });
    return "forwarded";
  }
  if (kind === "UNSUBSCRIBE") {
    await endNurture(e, "STOPPED", `${fromName} asked not to be emailed`, null, now);
    await notifyUser({ userId: e.ownerId, type: "LEAD_ACTIVITY", title: noteFrom(tara, `${fromName} asked not to be emailed — I've stopped, and they're unsubscribed.`), message: `${e.lead.company.name} — ${e.lead.title}`, link: leadPath(e.lead.leadSeq) });
    return "forwarded";
  }
  await endNurture(e, "STOPPED", read ? `${fromName} replied: ${REPLY_KIND_LABELS[kind].toLowerCase()}` : `${fromName} replied`, handoverFor(kind, fromName, e.lead.company.name, read?.suggestedName ?? null), now);
  return "forwarded";
}

/**
 * The answer Deskzo AI drafted to a reply, sent by the lead's owner as they changed it (phase 4): from their mailbox, else
 * the company's mail, to the address that wrote — only one its mail server confirmed. A person's own answer, so not
 * counted toward the 24-hour limit. Throws NurtureRefusal with words.
 */
export async function answerReply(replyId: string, userId: string, edited: { subject: string; body: string }, now = new Date()): Promise<{ to: string }> {
  const reply = await db.nurtureReply.findUnique({ where: { id: replyId }, select: { id: true, enrolmentId: true, fromName: true, fromEmail: true, answeredAt: true, answerSubject: true, answerBody: true } });
  if (!reply) throw new NurtureRefusal("That reply isn't there any more.");
  if (reply.answeredAt) throw new NurtureRefusal("It's been answered already.");
  const e = await loadEnrolment({ id: reply.enrolmentId });
  if (!e || e.ownerId !== userId) throw new NurtureRefusal("Only the lead's owner answers — it goes from their mailbox.");
  if (!reply.fromEmail) throw new NurtureRefusal("Their mail server didn't confirm who sent it — answer from your own inbox.");
  const subject = edited.subject.trim().slice(0, 300);
  const body = edited.body.trim().slice(0, 5000);
  if (subject.length < 2 || body.length < 10) throw new NurtureRefusal("The answer needs a subject and a few words.");
  const context = await quickContext(e.ownerId, { moment: "ANY", companyId: e.lead.companyId, leadId: e.leadId });
  if (!context || "error" in context) throw new NurtureRefusal(context && "error" in context ? context.error : "That company isn't there any more.");
  if (context.emailRoute.via === "none") throw new NurtureRefusal(context.emailRoute.why);
  const owner = await db.user.findUnique({ where: { id: e.ownerId }, select: { id: true, name: true, email: true } });
  if (!owner) throw new NurtureRefusal("The lead's owner no longer works here.");
  const org = await getOrganisation();
  const to = reply.fromEmail;
  const toName = reply.fromName || to;
  const text = body.replace(/\{\{\s*firstName\s*\}\}/g, (reply.fromName ?? "").split(/\s+/)[0] || "there").replace(/\{\{\s*senderName\s*\}\}/g, owner.name);
  const html = textToHtml(text);
  let from = "";
  let failed: string | null;
  if (context.emailRoute.via === "mailbox") {
    const out = await sendAsUser(owner.id, { subject, html, to: [{ name: toName, email: to }], attachments: [] });
    if (out.ok) from = out.mailbox;
    failed = out.ok ? null : out.error;
  } else {
    const out = await deliverNow({ to, toName, fromName: senderDisplayName(owner.name, org.tradeName || org.legalName || ""), replyTo: owner.email, subject, html, text }, "TRANSACTIONAL", { delivering: true });
    if (out.ok) from = out.fromEmail ?? out.provider;
    failed = out.ok ? null : out.error;
  }
  if (failed) throw new NurtureRefusal(`It didn't go: ${failed}`);
  const isContact = e.contact.email?.toLowerCase() === to;
  await db.marketingMessage.create({
    data: { token: randomBytes(24).toString("base64url"), companyId: e.lead.companyId, contactId: isContact ? e.contactId : null, channel: "EMAIL", messageClass: "TRANSACTIONAL", subject, body: html, textBody: text, toEmail: to, status: "SENT", scheduledFor: now, sentAt: now, attempts: 1, sentByUserId: owner.id, fromEmail: from },
  });
  await db.activity.create({ data: { leadId: e.leadId, userId: owner.id, type: "EMAIL", notes: `Answered ${toName}'s reply (drafted by Deskzo AI, sent by ${owner.name}): ${subject}`, occurredAt: now } });
  await db.nurtureReply.update({ where: { id: reply.id }, data: { answeredAt: now, answeredById: userId, answerSubject: subject, answerBody: body } });
  if (reply.answerSubject && reply.answerBody) await recordDraft({ teammate: "tara", kind: "nurture.answer", ref: reply.id, userId, draft: { subject: reply.answerSubject, body: reply.answerBody }, sent: { subject, body } });
  await recordAudit({ userId, action: "CREATE", entityType: "NurtureReply", entityId: reply.id, entityLabel: `Answered ${toName}'s reply to a nurture email: ${subject}` });
  return { to: toName };
}

/**
 * A booking made from a nurture email's link (src/lib/booking/server.ts, phase 4): the lead it was for, to book on —
 * not a new lead. Null when the reference is nobody's.
 */
export async function nurtureForBooking(token: string): Promise<{ enrolmentId: string; leadId: string; companyId: string; contactId: string; leadSeq: number } | null> {
  try {
    const e = await db.nurtureEnrolment.findUnique({ where: { replyToken: token }, select: { id: true, leadId: true, contactId: true, lead: { select: { companyId: true, leadSeq: true } } } });
    return e ? { enrolmentId: e.id, leadId: e.leadId, companyId: e.lead.companyId, contactId: e.contactId, leadSeq: e.lead.leadSeq } : null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** The meeting booked from a nurture email: the nurture ended, handed back with a task to get ready for it. */
export async function bookedFromNurture(enrolmentId: string, guest: string, when: string, now = new Date()): Promise<void> {
  const e = await loadEnrolment({ id: enrolmentId });
  if (!e || e.status !== "ACTIVE") return;
  const tara = (await teammate("tara")).name;
  await endNurture(e, "STOPPED", `${guest} booked a meeting for ${when}`, { title: `Get ready for the meeting with ${guest} — ${e.lead.company.name}, ${when}`, notice: noteFrom(tara, `${guest} booked a time with you from my email — ${when}.`) }, now);
}

// ─── What screens show ────────────────────────────────────────────────────────────────────────────────────────────

export type NurtureTouchView = { id: string; step: number; status: string; subject: string; body: string; sentAt: string | null; sendAt: string | null; error: string | null };
export type NurtureReplyView = {
  id: string;
  at: string;
  fromName: string | null;
  kind: ReplyKind;
  label: string;
  summary: string | null;
  acted: string | null;
  resumeOn: string | null;
  suggestedName: string | null;
  suggestedEmail: string | null;
  suggestedStage: string | null;
  answer: { subject: string; body: string } | null;
  answeredAt: string | null;
  /** Its sender confirmed by their mail server: answered from Deskzo. Otherwise from the owner's own inbox. */
  canAnswer: boolean;
};
export type NurtureView = {
  status: string;
  stopReason: string | null;
  ownerId: string;
  ownerName: string | null;
  contactName: string;
  touchesSent: number;
  nextAt: string | null;
  repliesCaught: boolean;
  touches: NurtureTouchView[];
  /** Phase 4: the replies Deskzo AI read, newest first. */
  replies: NurtureReplyView[];
  /** Phase 4: when "Approve" would send now — null inside working hours, else "Mon 24 Nov, 10:00". */
  holdUntil: string | null;
  /** Phase 4: whether its emails carry the owner's booking link. */
  bookingLink: boolean;
};

export async function nurtureOf(leadId: string, now = new Date()): Promise<NurtureView | null> {
  let e;
  try {
    e = await loadEnrolment({ leadId });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
  if (!e) return null;
  const [owner, config, clock] = await Promise.all([db.user.findUnique({ where: { id: e.ownerId }, select: { name: true } }), nurtureConfig(), workspaceClock()]);
  const held = config.phase4
    ? new Map((await db.nurtureTouch.findMany({ where: { enrolmentId: e.id, status: "SCHEDULED" }, select: { id: true, sendAt: true } })).map((t) => [t.id, t.sendAt]))
    : new Map<string, Date | null>();
  const replies = config.phase4 ? await db.nurtureReply.findMany({ where: { enrolmentId: e.id }, orderBy: { createdAt: "desc" }, take: 5 }) : [];
  const hold = sendTimeFor(now, clock.zone);
  const origin = config.phase4 && config.bookingLinks ? await tenantOrigin() : null;
  return {
    status: e.status,
    stopReason: e.stopReason,
    ownerId: e.ownerId,
    ownerName: owner?.name ?? null,
    contactName: e.contact.name,
    touchesSent: e.touchesSent,
    nextAt: e.nextTouchAt?.toISOString() ?? null,
    repliesCaught: !!inboundDomain(),
    touches: e.touches.map((t) => ({ id: t.id, step: t.step, status: t.status, subject: t.subject, body: t.body, sentAt: t.sentAt?.toISOString() ?? null, sendAt: held.get(t.id)?.toISOString() ?? null, error: t.error })),
    replies: replies.map((r) => ({
      id: r.id,
      at: r.createdAt.toISOString(),
      fromName: r.fromName,
      kind: r.kind as ReplyKind,
      label: REPLY_KIND_LABELS[r.kind as ReplyKind] ?? "Replied",
      summary: r.summary,
      acted: r.acted,
      resumeOn: r.resumeOn?.toISOString().slice(0, 10) ?? null,
      suggestedName: r.suggestedName,
      suggestedEmail: r.suggestedEmail,
      suggestedStage: r.suggestedStage,
      answer: r.answerSubject && r.answerBody ? { subject: r.answerSubject, body: r.answerBody } : null,
      answeredAt: r.answeredAt?.toISOString() ?? null,
      canAnswer: !!r.fromEmail,
    })),
    holdUntil: config.phase4 && hold.getTime() > now.getTime() + 60_000 ? sendTimeLabel(hold, clock.zone) : null,
    bookingLink: !!origin && !!(await bookingLinkFor(e, origin)),
  };
}

export type WaitingEmail = { touchId: string; leadTitle: string; company: string; href: string; step: number; subject: string };

/** The emails waiting for this person to check — their Today. */
export async function waitingFor(userId: string, take = 6): Promise<WaitingEmail[]> {
  try {
    const rows = await db.nurtureTouch.findMany({
      where: { status: "WAITING", enrolment: { ownerId: userId, status: "ACTIVE" } },
      orderBy: { createdAt: "asc" },
      take,
      select: { id: true, step: true, subject: true, enrolment: { select: { lead: { select: { leadSeq: true, title: true, company: { select: { name: true } } } } } } },
    });
    return rows.map((r) => ({ touchId: r.id, leadTitle: r.enrolment.lead.title, company: r.enrolment.lead.company.name, href: leadPath(r.enrolment.lead.leadSeq), step: r.step, subject: r.subject }));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

export type NurtureReport = {
  nurtured: number;
  active: number;
  sent: number;
  replied: number;
  noReply: number;
  /** Phase 4: each email of the four — how many went, and how many were the last before a reply. */
  bySteps: { step: number; sent: number; replies: number }[];
  /** Phase 4: each salesperson's — emails sent, leads that replied. */
  byOwner: { name: string; sent: number; replies: number }[];
};

/** The last 30 days, for Settings: leads nurtured, emails sent, replies, and those that finished with none. */
export async function nurtureReport(now = new Date()): Promise<NurtureReport> {
  const since = new Date(now.getTime() - 30 * DAY);
  const empty: NurtureReport = { nurtured: 0, active: 0, sent: 0, replied: 0, noReply: 0, bySteps: [], byOwner: [] };
  try {
    const [nurtured, active, sent, replied, noReply, sentRows, repliedRows] = await Promise.all([
      db.nurtureEnrolment.count({ where: { createdAt: { gte: since } } }),
      db.nurtureEnrolment.count({ where: { status: "ACTIVE" } }),
      db.nurtureTouch.count({ where: { status: "SENT", sentAt: { gte: since } } }),
      db.nurtureEnrolment.count({ where: { repliedAt: { gte: since } } }),
      db.nurtureEnrolment.count({ where: { status: "DONE", endedAt: { gte: since } } }),
      db.nurtureTouch.findMany({ where: { status: "SENT", sentAt: { gte: since } }, select: { step: true, enrolment: { select: { ownerId: true } } } }),
      db.nurtureEnrolment.findMany({ where: { repliedAt: { gte: since } }, select: { ownerId: true, touchesSent: true } }),
    ]);
    // A reply is put down to the last email before it: the one that got the answer. One before any went counts nowhere.
    const bySteps = Array.from({ length: TOUCHES }, (_, step) => ({
      step,
      sent: sentRows.filter((t) => t.step === step).length,
      replies: repliedRows.filter((r) => r.touchesSent - 1 === step).length,
    }));
    const owners = [...new Set([...sentRows.map((t) => t.enrolment.ownerId), ...repliedRows.map((r) => r.ownerId)])];
    const names = new Map((await db.user.findMany({ where: { id: { in: owners } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const byOwner = owners
      .map((id) => ({ name: names.get(id) ?? "Somebody who has left", sent: sentRows.filter((t) => t.enrolment.ownerId === id).length, replies: repliedRows.filter((r) => r.ownerId === id).length }))
      .sort((a, b) => b.sent - a.sent);
    return { nurtured, active, sent, replied, noReply, bySteps, byOwner };
  } catch (err) {
    if (notMigratedYet(err)) return empty;
    throw err;
  }
}

/**
 * Many leads at once, from the Leads list (phase 4, owner 20 Nov 2026 — "start many at once"): each started as one would
 * be by its button, those without a Research & plan counted rather than planned here, every refusal said.
 */
export async function enrolMany(leadIds: string[], userId: string, now = new Date()): Promise<{ started: number; needPlan: number; refused: { leadId: string; why: string }[] }> {
  const out = { started: 0, needPlan: 0, refused: [] as { leadId: string; why: string }[] };
  for (const leadId of [...new Set(leadIds)].slice(0, 100)) {
    try {
      await enrolLead(leadId, userId, now);
      out.started += 1;
    } catch (err) {
      if (!(err instanceof NurtureRefusal)) throw err;
      if (/Research & plan first/.test(err.message)) out.needPlan += 1;
      else out.refused.push({ leadId, why: err.message });
    }
  }
  return out;
}
