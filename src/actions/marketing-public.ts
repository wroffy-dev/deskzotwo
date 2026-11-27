"use server";

import { companyIdByName } from "@/lib/companies/by-name";
import { sendConfirmation } from "@/lib/marketing/double-opt-in";
import { createHash } from "node:crypto";
import { headers } from "next/headers";
import { callerKeyIp, clientIpFrom } from "@/lib/client-ip";
import { withinCallerBudget } from "@/lib/security/caller-budget";
import { tenantKey } from "@/lib/tenancy/cache";
import { newLeadStage } from "@/lib/pipeline/server";
import { emitLeadCreated } from "@/lib/automate/emit-leads";
import { emitEvent } from "@/lib/automate/events";
import type { FormCategory, MarketingTopic, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { isResellerManaged } from "@/lib/reseller";
import { getOrganisation } from "@/lib/organisation";
import { normalizeCompanyName } from "@/lib/validation/company";
import {
  firstError,
  linkQuestions,
  linkedAnswers,
  noLinkedValues,
  parseFields,
  questionsOf,
  savedToLead,
  summariseAnswers,
  validateAnswers,
  type Answers,
  type FormField,
} from "@/lib/marketing/form-fields";
import { stillToFill, stillToFillLines } from "@/lib/custom-fields/outside";
import { createData, outsideDefinitions } from "@/lib/custom-fields/outside-server";
import { REMINDER_TOPICS, TOPICS, countsAsOptOut } from "@/lib/marketing/topics";
// Whichever kind of token arrived — a message's, or the contact's own long-lived one.
import { contactForToken, unsubscribeByToken } from "@/lib/marketing/unsubscribe";
import { notifyUser } from "@/lib/notify";
import { leadPath } from "@/lib/record-links";
import type { ActionResult } from "@/actions/company";
import { leadCapacityError, markLeadWrite } from "@/lib/leads/limits";
import { intakeOwner, notifyOverflow, overflowReason, LeadRuleRefused, type IntakeOwner, type IntakeOwnerPlan } from "@/lib/leads/intake-owner";
import { refreshLeadScore } from "@/lib/leads/score-store";
import { allowsLink } from "@/lib/forms/categories";
import { formOpenState, hasSeat } from "@/lib/forms/invites";
import { workspaceClock } from "@/lib/time/workspace";
import type { Clock } from "@/lib/time/zone";
import { unconfirmedColumnHere, unconfirmedData } from "@/lib/contacts/unconfirmed";

/**
 * The customer-facing half: the preference centre, and the forms that turn a stranger into a lead.
 *
 * The third module in this app that serves somebody with no account, after the new-joiner intake
 * and the feedback form, and it follows the same rules:
 *
 *   · The token is the authentication — 192 bits, and it grants exactly one capability.
 *   · Every failure looks identical, so the endpoint cannot be used to work out which tokens exist.
 *   · It returns only what the page needs to render, all of which the holder already knows.
 *
 * With one deliberate difference. A preference token does **not** expire and is **not** one-time:
 * somebody has to be able to come back next month and change their mind, and an unsubscribe link
 * that has gone stale is not an unsubscribe link. What it can do is correspondingly small — it
 * reads a name and sets subscription flags, and that is all.
 */


// ─── The preference centre ────────────────────────────────────────────────────

export async function getPreferences(token: string) {
  const contact = await contactForToken(token);
  if (!contact) return null;

  const [company, consents, org, suppressed] = await Promise.all([
    db.company.findUnique({ where: { id: contact.companyId }, select: { name: true } }),
    db.contactConsent.findMany({ where: { contactId: contact.id, channel: "EMAIL" } }),
    getOrganisation(),
    contact.email
      ? db.suppression.findFirst({
          where: { scope: "EMAIL", value: contact.email.trim().toLowerCase(), reason: "UNSUBSCRIBED" },
          select: { id: true },
        })
      : Promise.resolve(null),
  ]);

  const byTopic = new Map(consents.map((c) => [c.topic, c]));
  return {
    firstName: contact.name.trim().split(/\s+/)[0] ?? null,
    email: contact.email,
    companyName: company?.name ?? null,
    ourName: org.tradeName || org.legalName || "us",
    postalAddress: org.marketingPostalAddress,
    unsubscribedFromEverything: !!suppressed,
    /**
     * Offers and news: ticked only when they opted in. Reminders (src/lib/marketing/topics.ts): ticked
     * unless they turned them off, or unsubscribed from everything — as they're sent.
     */
    topics: TOPICS.map((t) => {
      const row = byTopic.get(t.key);
      const reminder = REMINDER_TOPICS.has(t.key);
      return { ...t, reminder, subscribed: reminder ? !suppressed && !(row && countsAsOptOut(row)) : row?.status === "SUBSCRIBED" };
    }),
  };
}

/**
 * Where a preference-centre change came from, for its evidence (security audit round three, 14 Nov 2026 — R3-22): the
 * address and browser behind it, so a change made with somebody else's link can be told apart afterwards. There are no
 * columns for them on a consent, so they go in its evidence text. The address only behind a trusted proxy
 * (src/lib/client-ip.ts); the browser cut short.
 */
async function changeOrigin(): Promise<string> {
  try {
    const h = await headers();
    const ip = clientIpFrom(h);
    const agent = (h.get("user-agent") ?? "").replace(/[\r\n]+/g, " ").trim().slice(0, 160);
    const parts = [ip ? `from ${ip}` : null, agent ? `using “${agent}”` : null].filter(Boolean);
    return parts.length ? ` (${parts.join(", ")})` : "";
  } catch {
    return "";
  }
}

export async function updatePreferences(input: {
  token: string;
  topics: MarketingTopic[];
}): Promise<ActionResult<{ subscribed: number; awaitingConfirmation?: boolean }>> {
  const contact = await contactForToken(input.token);
  if (!contact) return { ok: false, error: "This link is no longer valid." };

  // Only topics that exist: a server action takes whatever it is sent.
  const known = new Set(TOPICS.map((t) => t.key));
  const chosen = new Set((Array.isArray(input.topics) ? input.topics : []).filter((t) => known.has(t)));
  const now = new Date();
  const existing = new Map((await db.contactConsent.findMany({ where: { contactId: contact.id, channel: "EMAIL" }, select: { topic: true, status: true, source: true, withdrawnAt: true } })).map((c) => [c.topic, c]));
  const address = contact.email?.trim().toLowerCase() ?? null;

  /**
   * Security audit round three, 14 Nov 2026 (R3-22): after "unsubscribe from everything", ticking a topic deleted the
   * suppression and recorded SUBSCRIBED as the contact's own choice — and the link that did it is in every email they
   * were sent, which more people than they can open (a forwarded mail, a shared inbox, marketing staff who were shown
   * it). Now a re-subscribe after a blanket unsubscribe goes through the double opt-in: the chosen topics are recorded
   * as PENDING, a confirmation is emailed to the address itself (src/lib/marketing/double-opt-in.ts), and only pressing
   * its button subscribes them and lifts the suppression. Turning things off still takes effect at once.
   */
  const blanket = address
    ? await db.suppression.findFirst({ where: { scope: "EMAIL", value: address, reason: "UNSUBSCRIBED" }, select: { id: true } })
    : null;
  const confirmFirst = !!blanket && chosen.size > 0;

  // The day on the workspace's calendar, not UTC's.
  const stamp = (await workspaceClock()).today(now);
  const origin = await changeOrigin();
  let pendingId: string | null = null;
  for (const topic of TOPICS) {
    const subscribed = chosen.has(topic.key);
    // A reminder left ticked is as it was: shown ticked because it's sent, not an opt-in they gave. Ticked
    // again after turning it off, it's on again.
    const row = existing.get(topic.key);
    if (REMINDER_TOPICS.has(topic.key) && subscribed && !(row && countsAsOptOut(row))) continue;
    // The evidence has to describe the status it sits beside. A row reading SUBSCRIBED while its
    // evidence recounts an unsubscribe is the kind of consent record that is worse than none.
    const status = !subscribed ? "UNSUBSCRIBED" : confirmFirst ? "PENDING" : "SUBSCRIBED";
    const evidence =
      status === "SUBSCRIBED"
        ? `Chosen by the contact in the preference centre on ${stamp}${origin}.`
        : status === "PENDING"
          ? `Asked for again in the preference centre on ${stamp}${origin}, after unsubscribing from everything; waiting for the emailed confirmation.`
          : `Turned off by the contact in the preference centre on ${stamp}${origin}.`;
    const saved = await db.contactConsent.upsert({
      where: { contactId_channel_topic: { contactId: contact.id, channel: "EMAIL", topic: topic.key } },
      create: {
        contactId: contact.id,
        channel: "EMAIL",
        topic: topic.key,
        status,
        source: "PREFERENCE_CENTRE",
        evidence,
        withdrawnAt: subscribed ? null : now,
      },
      update: {
        status,
        source: "PREFERENCE_CENTRE",
        evidence,
        withdrawnAt: subscribed ? null : now,
      },
      select: { id: true },
    });
    if (status === "PENDING" && !pendingId) pendingId = saved.id;
  }

  // One confirmation email for everything asked for again: confirming it subscribes each pending topic and lifts the
  // blanket unsubscribe (`confirmConsent`). Never more than once a day, however often the page is sent.
  if (confirmFirst && pendingId) {
    await sendConfirmation(pendingId, "our preference centre", { resubscribe: true }).catch(() => undefined);
    return { ok: true, data: { subscribed: 0, awaitingConfirmation: true } };
  }

  return { ok: true, data: { subscribed: chosen.size } };
}

/** The preference centre's "unsubscribe from everything" — see src/lib/marketing/unsubscribe.ts. */
export async function unsubscribeAll(token: string): Promise<ActionResult<null>> {
  if (!(await unsubscribeByToken(token, "PREFERENCE_CENTRE"))) return { ok: false, error: "This link is no longer valid." };
  return { ok: true, data: null };
}

// ─── Inbound forms ────────────────────────────────────────────────────────────

/**
 * The questions as they are asked today: the stored spec, with every question that saves its answer
 * to one of the workspace's own fields asked as that field now is (`linkQuestions` in
 * src/lib/marketing/form-fields.ts). The definitions are read only when some question needs them.
 */
async function askedQuestions(raw: unknown) {
  const parsed = parseFields(raw);
  if (!parsed.some((f) => f.saveTo)) return parsed;
  return linkQuestions(parsed, await outsideDefinitions());
}

/** The questions as the page gets them — where an answer is also saved is no business of the page's. */
function forThePage(fields: FormField[]): FormField[] {
  return fields.map((f) => {
    const shown = { ...f };
    delete shown.saveTo;
    return shown;
  });
}

type OwnFields = Awaited<ReturnType<typeof outsideDefinitions>>;

/**
 * What a new lead takes from the workspace's own fields: the values its questions saved to them, and
 * a description that says what is still to fill in — on the company and contact too, when this
 * answer is what made them. A company or contact already on file is never changed by what somebody
 * types into a form (src/lib/custom-fields/outside.ts); their own values are written where they are
 * created, by the caller.
 */
function leadExtras(
  fields: FormField[],
  answers: Answers,
  defs: OwnFields,
  values: ReturnType<typeof linkedAnswers>["values"],
  made: { company: boolean; contact: boolean },
) {
  const description = [
    // The answers saved to the lead's own fields are on its page already.
    summariseAnswers(fields, answers, { except: savedToLead(fields, values.LEAD) }),
    ...stillToFillLines({
      LEAD: stillToFill(defs.LEAD, values.LEAD),
      COMPANY: made.company ? stillToFill(defs.COMPANY, values.COMPANY) : [],
      CONTACT: made.contact ? stillToFill(defs.CONTACT, values.CONTACT) : [],
    }),
  ]
    .filter(Boolean)
    .join("\n\n");
  return { description: description || null, ...createData(values.LEAD) };
}

/**
 * What the page needs to show a form: the questions, and for an event, when and where.
 *
 * Parsed here rather than in the component: the page and the submit handler have to agree on what
 * the questions are, and the only way to guarantee that is for both to read them through the same
 * function.
 */
async function presentForm(form: {
  id: string;
  slug: string;
  name: string;
  headline: string | null;
  intro: string | null;
  fields: unknown;
  thankYouText: string | null;
  topic: MarketingTopic;
  category: FormCategory;
  active: boolean;
  closesAt: Date | null;
  eventStartsAt: Date | null;
  eventEndsAt: Date | null;
  venue: string | null;
  capacity: number | null;
}) {
  const org = await getOrganisation();
  const clock = await workspaceClock();
  const open = formOpenState(form, new Date());
  const coming =
    form.category === "EVENT" && form.capacity !== null
      ? await db.formSubmission.count({ where: { formId: form.id, OR: [{ attending: true }, { attending: null }] } })
      : 0;
  return {
    id: form.id,
    slug: form.slug,
    name: form.name,
    headline: form.headline,
    intro: form.intro,
    thankYouText: form.thankYouText,
    topic: form.topic,
    category: form.category,
    eventStartsAt: form.eventStartsAt,
    eventEndsAt: form.eventEndsAt,
    venue: form.venue,
    /** Written out on the server, on the workspace's clock, so the page and the browser cannot disagree. */
    eventWhen: form.eventStartsAt ? eventWhenText(clock, form.eventStartsAt, form.eventEndsAt) : null,
    fields: forThePage(await askedQuestions(form.fields)),
    ourName: org.tradeName || org.legalName || "us",
    /** Why it isn't taking answers, or null when it is. */
    closedMessage: open.open ? null : open.message,
    /** Every seat taken. A "can't make it" is still accepted. */
    full: form.category === "EVENT" && !hasSeat(form.capacity, coming),
  };
}

/** "Thu, 15 Oct 2026, 6:30 pm – 9:00 pm", or both dates in full when it runs past midnight. */
function eventWhenText(clock: Clock, starts: Date, ends: Date | null): string {
  if (!ends) return clock.dateTime(starts);
  const sameDay = clock.dateKey(starts) === clock.dateKey(ends);
  return `${clock.dateTime(starts)} – ${sameDay ? clock.time(ends) : clock.dateTime(ends)}`;
}

const publicFormSelect = {
  id: true,
  slug: true,
  name: true,
  headline: true,
  intro: true,
  fields: true,
  thankYouText: true,
  active: true,
  topic: true,
  category: true,
  fillMode: true,
  closesAt: true,
  eventStartsAt: true,
  eventEndsAt: true,
  venue: true,
  capacity: true,
} as const;

/**
 * The form behind a public link.
 *
 * An invitation-only form answers exactly as a closed one does: its address is a slug, which is
 * guessable, and "this one exists but you weren't invited" would say so to anybody who tried.
 */
export async function getForm(slug: string) {
  if (!slug) return null;
  if (!(await moduleAvailableForTenant("forms"))) return null;
  const form = await db.inboundForm.findUnique({ where: { slug }, select: publicFormSelect });
  if (!form || !form.active || !allowsLink(form.fillMode)) return null;
  return presentForm(form);
}

/**
 * The form behind a personal invitation — who they are, and what they said last time.
 *
 * Every failure — no such token, the wrong form's slug, a withdrawn invitation, a closed form —
 * answers the same null, so the endpoint cannot be used to work out which tokens exist. Loading the
 * page notes that the link was opened; a mail scanner following links counts too, which is why the
 * list says "link opened" and never "read".
 */
export async function getInvitedForm(slug: string, token: string) {
  if (!slug || !token || token.length < 20) return null;
  if (!(await moduleAvailableForTenant("forms"))) return null;
  const invite = await db.formInvite.findUnique({
    where: { token },
    select: {
      id: true,
      email: true,
      openedAt: true,
      revokedAt: true,
      form: { select: publicFormSelect },
      contact: { select: { name: true } },
      company: { select: { name: true } },
      submission: { select: { payload: true, attending: true } },
    },
  });
  if (!invite || invite.revokedAt || invite.form.slug !== slug || !invite.form.active) return null;

  if (!invite.openedAt) {
    await db.formInvite.update({ where: { id: invite.id }, data: { openedAt: new Date() } });
  }

  const previous =
    invite.submission && invite.submission.payload && typeof invite.submission.payload === "object" && !Array.isArray(invite.submission.payload)
      ? Object.fromEntries(
          Object.entries(invite.submission.payload as Record<string, unknown>).filter((e): e is [string, string] => typeof e[1] === "string"),
        )
      : null;

  return {
    ...(await presentForm(invite.form)),
    invitation: {
      token,
      /** Fixed: the invitation is to this person, at this address, from this company. */
      name: invite.contact.name,
      email: invite.email,
      companyName: invite.company.name,
      /** Their last answer, so coming back changes it rather than starting again. */
      previous,
      attending: invite.submission?.attending ?? null,
    },
  };
}

/** One seat-check at a time per form, so two people cannot both take the last place. */
async function lockSeats(tx: Prisma.TransactionClient, formId: string) {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`form-seats:${formId}`}))`;
}

const COMING_WHERE = { OR: [{ attending: true }, { attending: null }] } satisfies Prisma.FormSubmissionWhereInput;

/**
 * Somebody fills a form in — a stranger on the public link, or an invited customer on their own.
 *
 * No CAPTCHA. A honeypot field plus a minimum fill time stops the automated traffic a form this
 * obscure actually attracts, and a CAPTCHA taxes every real person to inconvenience a bot that
 * mostly isn't there. The source is hashed rather than stored: rate limiting needs to know how
 * often, never who.
 */
/** Answers to one form an hour: from one address, and in all (security review, 23 Oct 2026). */
const FORM_RATE = { perAddress: 5, perCaller: 10, perCallerAllForms: 30, perForm: 300, windowMs: 60 * 60_000 } as const;

/** How far past the per-form cap held answers are still kept, as a multiple of it (RL-03, in submitForm). */
const FORM_HELD_CEILING_FACTOR = 10;

export async function submitForm(input: {
  slug: string;
  /**
   * Every answer, keyed by the field it answers.
   *
   * Not a fixed set of named arguments: the form decides what it asks, so the handler cannot know
   * the shape in advance. It reads the same spec the page rendered from and validates against it.
   */
  values: Answers;
  /** An event's RSVP. Required on an event, ignored everywhere else. */
  attending?: boolean;
  /** The personal invitation this came through, when it did. */
  inviteToken?: string;
  /** Hidden field. A real person never fills it in. */
  website?: string;
  /** Milliseconds the form was on screen. */
  elapsedMs?: number;
}): Promise<ActionResult<{ thankYou: string }>> {
  if (!(await moduleAvailableForTenant("forms"))) return { ok: false, error: "This form is closed." };
  if (input.inviteToken) return submitInvited({ ...input, inviteToken: input.inviteToken });

  const form = await db.inboundForm.findUnique({ where: { slug: input.slug } });
  if (!form || !form.active || !allowsLink(form.fillMode)) return { ok: false, error: "This form is closed." };
  const open = formOpenState(form, new Date());
  if (!open.open) return { ok: false, error: open.message };

  const event = form.category === "EVENT";
  if (event && typeof input.attending !== "boolean") return { ok: false, error: "Let us know whether you can come." };
  const attending = event ? input.attending! : null;

  const thankYou =
    attending === false
      ? "Thanks for letting us know — we'll keep you in mind for the next one."
      : (form.thankYouText ?? "Thank you — somebody will be in touch.");

  // Both bot checks answer with success. Telling a bot it was detected only teaches it.
  if (input.website?.trim()) return { ok: true, data: { thankYou } };
  if (typeof input.elapsedMs === "number" && input.elapsedMs < 2000) return { ok: true, data: { thankYou } };

  /**
   * The page validated too, and this is the copy that counts.
   *
   * A browser can be made to post anything, so a required question is only required because the
   * server says so. Answers are also narrowed to the questions the form actually asks: a payload
   * carrying extra keys is either a stale page or somebody probing, and neither should end up
   * stored as though it had been asked for.
   */
  const defs = await outsideDefinitions();
  const fields = linkQuestions(parseFields(form.fields), defs);
  const answers: Answers = Object.fromEntries(questionsOf(fields).map((f) => [f.key, (input.values[f.key] ?? "").trim()]));
  const refusal = firstError(validateAnswers(fields, answers, { onlyMandatory: attending === false }));
  if (refusal) return { ok: false, error: refusal };

  /**
   * The answers saved to the workspace's own fields, checked as those fields check a value — and
   * refused, in the question's words, when one can't be used: the person is here to put it right.
   * Checked whatever the company turns out to be, so the answer never says whether it is on file.
   * Somebody declining an event was asked only who they are.
   */
  const own = attending === false ? null : linkedAnswers(fields, answers, defs);
  const ownRefusal = own ? firstError(own.errors) : null;
  if (ownRefusal) return { ok: false, error: ownRefusal };
  const values = own?.values ?? noLinkedValues();

  // Present and valid, because `parseFields` guarantees both fields exist and are required.
  const email = answers.email!.toLowerCase();
  const name = answers.name!;

  const admin = await db.user.findFirst({ where: { role: "ADMIN", active: true }, select: { id: true } });
  const companyName = answers.companyName || email.split("@")[1]!;
  /**
   * A form makes a lead only where the plan has leads (owner, 14 Oct 2026): without them its answer
   * still makes or finds the company and contact, and the submission is kept as always.
   */
  const makesLead = form.createsLead && (await moduleAvailableForTenant("leads"));
  /**
   * A person named on the form wins; otherwise the lead assignment rules decide, as they do for
   * the website API; an admin only when no rule fits — so a form lead never lands on nobody.
   *
   * Decided inside the transaction below, after the rate limit and the event's seats (owner, 12 Nov 2026 — Phase 4
   * lead limits, audit D.5 and H.6.5): a refused answer takes nobody's round-robin turn, and whoever it goes to has their
   * room taken with it. Somebody at their lead limit — the form's person, or everybody the rules would choose — leaves
   * the lead with nobody, saying why, and the managers are told; an answer is never lost to a limit.
   */
  const knownCompany = await db.company.findUnique({
    where: { normalizedName: normalizeCompanyName(companyName) },
    select: { ownerUserId: true },
  });
  const plan: IntakeOwnerPlan = form.assignToUserId
    ? { kind: "named", userId: form.assignToUserId, note: null }
    : {
        kind: "rules",
        signals: { brandIds: [], itemTypes: [], designation: null, source: "WEBSITE", state: null, companyOwnerId: knownCompany?.ownerUserId ?? null },
        // No company to judge by (`whoCouldOpen` needs one): nobody preferred for reach.
        mayOpen: null,
        fallback: admin ? { userId: admin.id, note: null } : null,
      };
  // Who makes what the answer makes, and is told of it, when no lead owner does.
  const routeTo = form.assignToUserId ?? admin?.id ?? null;
  if (!makesLead && !routeTo) return { ok: false, error: "This form isn't set up properly yet." };

  const normalizedName = normalizeCompanyName(companyName);

  // Rate limiting needs to know how often, never who — so the same hash whichever path is taken.
  const submissionHash = createHash("sha256").update(`${email}:${form.id}`).digest("hex").slice(0, 32);
  /**
   * And it is asked now (security review, 23 Oct 2026): the hash was kept but never counted, so a script could post
   * a form a thousand times, each a company, a contact and a lead. Counted as a booking page counts its bookings
   * (src/lib/booking/server.ts): by address on this form, and by the form in all, over the last hour.
   */
  const since = new Date(Date.now() - FORM_RATE.windowMs);
  /**
   * Security audit, 11 Nov 2026 (SEC-35): "from one address" above is the email typed, which a script changes on every
   * post — so it is counted by the caller's own network address too, on this form and on every form, where the
   * address can be known (src/lib/client-ip.ts; unknown, and only the per-form ceiling above stands).
   */
  // No request behind the call (a job or a check script posting a form): no address to count by.
  let caller: string | null = null;
  try {
    caller = clientIpFrom(await headers());
  } catch {
    caller = null;
  }
  if (caller) {
    const workspace = await tenantKey();
    const allowed = withinCallerBudget(
      [
        // By /64 for IPv6 (RL-03): groupKeyIps can't find an address after the form's id, so it is reduced here.
        { key: `${workspace}|form-caller:${form.id}:${callerKeyIp(caller)}`, max: FORM_RATE.perCaller },
        { key: `${workspace}|forms-caller:${callerKeyIp(caller)}`, max: FORM_RATE.perCallerAllForms },
      ],
      FORM_RATE.windowMs,
    );
    if (!allowed) return { ok: false, error: "Too many answers to this form just now. Try again in a little while." };
  }

  // Where a lead from the form starts (src/lib/pipeline) — read before the transaction, which holds a connection.
  const entry = makesLead ? await newLeadStage() : null;
  // R2-14: whether a visitor-made contact can be marked unconfirmed here — asked outside the transaction.
  const markable = await unconfirmedColumnHere();
  // Its name in another legal form counts too — "Pvt Ltd" for "Private Limited" (src/lib/companies/by-name.ts). Read
  // before the transaction too: answers to one form queue on its lock below, each holding a connection, and a workspace
  // has two — a read through the global client in there would wait on the one queued behind it.
  const likeId = await companyIdByName(companyName);
  const save = () => db.$transaction(async (tx) => {
    /**
     * Counted under the form's lock, in the transaction that writes the answer (owner, 12 Nov 2026 — Phase 4, audit
     * M-17): two answers at once queue here, so a burst can't all read "under the limit" and all be written.
     */
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deskzo:form-rate:${form.id}`}))`;
    const fromAddress = await tx.formSubmission.count({ where: { formId: form.id, sourceHash: submissionHash, createdAt: { gte: since } } });
    const onForm = await tx.formSubmission.count({ where: { formId: form.id, createdAt: { gte: since } } });
    if (fromAddress >= FORM_RATE.perAddress) return { kind: "busy" as const };
    /**
     * Security review, 15 Nov 2026 — RL-03: the per-form cap was one caller's to fill (a fresh email each post), closing
     * the form for everybody for an hour. Past it, a caller whose address is known — and so already held to its own
     * caps above (withinCallerBudget, by its address or IPv6 /64) — is "held": the answer is kept as a submission
     * only, with no company, contact or lead made, no Automate event, and nobody notified or emailed, up to
     * FORM_HELD_CEILING_FACTOR times the cap. A caller whose address isn't known is refused past the cap, as before.
     */
    const held = onForm >= FORM_RATE.perForm;
    if (held && (!caller || onForm >= FORM_RATE.perForm * FORM_HELD_CEILING_FACTOR)) return { kind: "busy" as const };
    if (event) {
      await lockSeats(tx, form.id);
      /**
       * An address already registered is left exactly as it was, and answered with the same
       * thank-you. The public link proves nothing about who is typing, so it must not let a stranger
       * cancel somebody's place by entering their address and "can't make it" — nor book a second
       * seat for them. Somebody genuinely changing their mind uses their invitation, or tells us.
       */
      const already = await tx.formSubmission.findFirst({ where: { formId: form.id, email, ...COMING_WHERE }, select: { id: true } });
      if (already) return { kind: "unchanged" as const };
      if (attending) {
        const coming = await tx.formSubmission.count({ where: { formId: form.id, ...COMING_WHERE } });
        if (!hasSeat(form.capacity, coming)) return { kind: "full" as const };
      }
    }

    // RL-03 (above): held — the answer as given, nothing made from it and nothing sent about it.
    if (held) {
      await tx.formSubmission.create({
        data: { formId: form.id, payload: answers, name, email, phone: answers.phone || null, companyName, sourceHash: submissionHash, attending },
      });
      return { kind: "held" as const };
    }

    // An existing company is reused rather than duplicated — the global uniqueness rule this whole
    // CRM is built on. A form must not be the one thing that gets round it.
    // Its name in another legal form counts too (`likeId`, above).
    const knownCo = await tx.company.findUnique({ where: likeId ? { id: likeId } : { normalizedName }, select: { id: true, managedByResellerId: true } });

    // The lead's owner, now that nothing above can refuse the answer — none for a reseller's customer, who gets no lead.
    const makingLead = !!entry && attending !== false && !(knownCo && isResellerManaged(knownCo));
    let owner: IntakeOwner | null = null;
    if (makingLead) {
      await markLeadWrite(tx, "form");
      owner = await intakeOwner(tx, plan);
    }
    const ownerId = makingLead ? (owner?.userId ?? null) : routeTo;
    const creatorId = ownerId ?? routeTo ?? form.ownerUserId;

    const company =
      knownCo ??
      (await tx.company.create({
        data: {
          name: companyName,
          normalizedName,
          source: "INBOUND",
          stage: "LEAD",
          createdById: creatorId,
          ownerUserId: ownerId,
          ...createData(values.COMPANY),
        },
        select: { id: true, managedByResellerId: true },
      }));

    /**
     * A reseller's end customer is not ours to write to.
     *
     * `src/lib/reseller.ts` states the rule the arrangement rests on — no direct calls, no direct
     * email — and an anonymous form matched on company name could walk straight past it, creating a
     * contact, a lead and a consent row against a company we are contractually not to approach. The
     * submission is still recorded, because "who filled this in" is worth keeping either way, and
     * it is linked to the company so whoever reviews it can route it to the reseller.
     */
    if (isResellerManaged(company)) {
      await tx.formSubmission.create({
        data: {
          formId: form.id,
          payload: answers,
          name,
          email,
          phone: answers.phone || null,
          companyName,
          companyId: company.id,
          sourceHash: submissionHash,
          attending,
        },
      });
      return { kind: "reseller" as const };
    }

    const knownContact = await tx.contact.findFirst({ where: { companyId: company.id, email }, select: { id: true } });
    const contact =
      knownContact ??
      (await tx.contact.create({
        data: {
          companyId: company.id,
          name,
          email,
          phone: answers.phone || null,
          createdByUserId: creatorId,
          ...createData(values.CONTACT),
          // Security audit round two, 13 Nov 2026 (R2-14): anybody can type a customer's name into the form, so
          // a person it adds to a company we already had is unconfirmed until staff say otherwise — never
          // picked by itself for a pay link or a reminder (src/lib/contacts/unconfirmed.ts).
          ...unconfirmedData("WEB_FORM", !!knownCo, markable),
        },
        select: { id: true },
      }));

    // Nobody saying "can't make it" to an event is a sales opportunity.
    const lead =
      makingLead && entry
        ? await tx.lead.create({
            data: {
              companyId: company.id,
              contactId: contact.id,
              title: `${form.name} — ${companyName}`,
              // Everything the form asked that is not already a column of its own, so whoever
              // picks this up reads the answers instead of opening the submission to find them.
              // Answers saved to the lead's own fields go into them; the description says what
              // is still to fill in.
              ...leadExtras(fields, answers, defs, values, { company: !knownCo, contact: !knownContact }),
              ...entry,
              ownerUserId: ownerId,
              sourcedByUserId: ownerId,
              source: "WEBSITE",
              sourceDetail: `Form: ${form.name}`,
              assignmentNote: owner?.note ?? null,
            },
            select: { id: true, leadSeq: true },
          })
        : null;

    /**
     * Recorded as **PENDING**, never as consent.
     *
     * This wrote `SUBSCRIBED`, which is a claim the submission cannot support. Nobody proved they
     * own the address they typed: anyone who knows a customer's company name and a colleague's
     * email address could post this form and have the app record, in that person's name, that they
     * asked to be marketed to — with an evidence string saying so. That is a forged consent
     * artefact, and DPDP asks for the artefact precisely because it is the thing that must be true.
     *
     * `PENDING` is the honest state and it already works: where the workspace asks for an opt-in
     * (Settings › Mail & messaging — off by default since 2 Nov 2026), `suppressionReasons` treats
     * anything that is not `SUBSCRIBED` as "No recorded consent for this topic" and withholds the
     * message. Where it doesn't, a PENDING sign-up is like any contact with no record: marketed to
     * until they opt out.
     *
     * `update: {}` stays deliberately empty — an existing row, in either direction, is a decision
     * the contact themselves made, and a stranger's form submission must not disturb it. In
     * particular it must never turn an UNSUBSCRIBED back on.
     *
     * Double opt-in promotes it (owner, 1 Nov 2026 — src/lib/marketing/double-opt-in.ts): once the
     * transaction is done the address is emailed a link, and pressing its button makes it SUBSCRIBED.
     */
    await tx.contactConsent.upsert({
      where: { contactId_channel_topic: { contactId: contact.id, channel: "EMAIL", topic: form.topic } },
      create: {
        contactId: contact.id,
        channel: "EMAIL",
        topic: form.topic,
        status: "PENDING",
        source: "FORM",
        evidence: `Submitted "${form.name}" (${form.slug}) — address not confirmed.`,
      },
      update: {},
    });

    const submission = await tx.formSubmission.create({
      data: {
        formId: form.id,
        // Every answer as given. The named columns beside it are for searching and matching;
        // this is the record of what was actually filled in, including questions that have
        // since been taken off the form.
        payload: answers,
        name,
        email,
        phone: answers.phone || null,
        companyName,
        companyId: company.id,
        contactId: contact.id,
        leadId: lead?.id ?? null,
        sourceHash: submissionHash,
        attending,
      },
      select: { id: true },
    });

    // For Automate's workflows: the form sent, and the lead it made. Ids only — the answers stay on the submission.
    await emitEvent(tx, {
      type: "form.submitted",
      recordType: "form-submission",
      recordId: submission.id,
      payload: { form: { id: form.id, name: form.name }, submission: { id: submission.id }, companyId: company.id, contactId: contact.id, leadId: lead?.id ?? null, invited: false },
    });
    if (lead) await emitLeadCreated(tx, lead.id, null, "form");
    return { kind: "created" as const, company, lead, contactId: contact.id, ownerId, overflow: owner?.overflow ?? null };
  }, { maxWait: 10_000, timeout: 20_000 });
  let result: Awaited<ReturnType<typeof save>>;
  try {
    result = await save();
  } catch (err) {
    // The plan's cap on leads, or a rule that refuses a lead when its people are all full: nothing was saved, and the
    // person filling the form in is asked to come back rather than told about the workspace's plan or rules.
    if (leadCapacityError(err) || err instanceof LeadRuleRefused) return { ok: false, error: CANT_TAKE };
    throw err;
  }

  if (result.kind === "busy") return { ok: false, error: "Too many answers to this form just now. Try again in a little while." };
  if (result.kind === "full") return { ok: false, error: "Sorry — every seat has been taken." };
  // The same thank-you either way, so the link cannot be used to learn who has registered.
  if (result.kind === "unchanged" || result.kind === "held") return { ok: true, data: { thankYou } };

  /**
   * The same thank-you either way.
   *
   * A form that answered differently for a reseller-managed company would tell any stranger which
   * of our customers belong to a reseller, one company name at a time.
   */
  if (result.kind === "reseller") {
    await notifyUser({
      userId: routeTo ?? form.ownerUserId,
      type: "LEAD_ASSIGNED",
      title: `Enquiry from ${companyName} — reseller-managed`,
      message: `${name} filled in "${form.name}". This account belongs to a reseller, so nothing was created and nobody should contact them directly. Route it through the reseller.`,
      link: `/marketing/forms/${form.id}`,
    });
    return { ok: true, data: { thankYou } };
  }

  if (result.lead) {
    await refreshLeadScore(result.lead.id);
    if (result.overflow) await notifyOverflow([result.lead.id], overflowReason(`${form.name} — ${companyName}`, result.overflow));
  }
  // Double opt-in (owner, 1 Nov 2026 — src/lib/marketing/double-opt-in.ts): the address is emailed a link to confirm the
  // pending consent recorded above. Never the reason a sign-up fails.
  const pending = await db.contactConsent.findUnique({ where: { contactId_channel_topic: { contactId: result.contactId, channel: "EMAIL", topic: form.topic } }, select: { id: true, status: true } });
  if (pending?.status === "PENDING") await sendConfirmation(pending.id, form.name).catch((err) => console.error("[double opt-in] confirmation not sent", err instanceof Error ? err.message : err));

  // A lead goes to whoever owns it. Without one the link is to the form's answers, so it goes to
  // somebody chosen to see them — the person the form routes to, else its owner — rather than to
  // whoever the lead rules happened to pick, who may not be able to open the form at all.
  // A lead left with nobody is the managers' (told above); the form's own person still hears of the answer.
  const leadOwner = result.lead ? result.ownerId : null;
  await notifyUser({
    userId: leadOwner ?? form.assignToUserId ?? form.ownerUserId,
    type: leadOwner ? "LEAD_ASSIGNED" : "FORM_RESPONSE",
    title: event
      ? attending
        ? `${name} (${companyName}) is coming to ${form.name}`
        : `${name} (${companyName}) can't make ${form.name}`
      : `New answer from ${companyName}`,
    message: `${name} filled in "${form.name}".`,
    link: leadOwner && result.lead ? leadPath(result.lead.leadSeq) : `/marketing/forms/${form.id}?tab=responses`,
  });

  return { ok: true, data: { thankYou } };
}

/** What somebody filling a form in is told when the lead it would make can't be taken (lead limits, owner 12 Nov 2026). */
const CANT_TAKE = "We can't take answers to this form just now. Please try again later.";

/**
 * The invited path: the token says who they are, so nothing is matched on a typed company name.
 *
 * Answering again changes the one answer rather than adding a second — somebody who said yes and
 * then can't make it presses the same link and says so. Their name, address and company are the
 * invitation's, whatever the page sends: the link is theirs, not a way to register somebody else.
 */
async function submitInvited(input: {
  slug: string;
  values: Answers;
  attending?: boolean;
  inviteToken: string;
  website?: string;
}): Promise<ActionResult<{ thankYou: string }>> {
  const invite = await db.formInvite.findUnique({
    where: { token: input.inviteToken },
    select: {
      id: true,
      email: true,
      revokedAt: true,
      invitedById: true,
      form: true,
      contact: { select: { id: true, name: true } },
      company: { select: { id: true, name: true, managedByResellerId: true, ownerUserId: true } },
      submission: { select: { id: true, attending: true } },
    },
  });
  // One refusal for every way this can be wrong, as for any token.
  if (!invite || invite.revokedAt || invite.form.slug !== input.slug || !invite.form.active) {
    return { ok: false, error: "This invitation isn't available." };
  }
  const form = invite.form;
  const open = formOpenState(form, new Date());
  if (!open.open) return { ok: false, error: open.message };

  const event = form.category === "EVENT";
  if (event && typeof input.attending !== "boolean") return { ok: false, error: "Let us know whether you can come." };
  const attending = event ? input.attending! : null;
  const thankYou =
    attending === false
      ? "Thanks for letting us know — we'll keep you in mind for the next one."
      : (form.thankYouText ?? "Thank you — somebody will be in touch.");

  if (input.website?.trim()) return { ok: true, data: { thankYou } };

  const defs = await outsideDefinitions();
  const fields = linkQuestions(parseFields(form.fields), defs);
  const answers: Answers = Object.fromEntries(questionsOf(fields).map((f) => [f.key, (input.values[f.key] ?? "").trim()]));
  // Who they are comes from the invitation. A name they corrected is kept on the answer; the
  // address and company never change — those are what the invitation was to.
  answers.email = invite.email;
  answers.name = answers.name || invite.contact.name;
  if (questionsOf(fields).some((f) => f.key === "companyName")) answers.companyName = invite.company.name;
  const refusal = firstError(validateAnswers(fields, answers, { onlyMandatory: attending === false }));
  if (refusal) return { ok: false, error: refusal };

  // Checked as on the public link. The company and contact are on file already, so only a lead this
  // answer makes takes the values.
  const own = attending === false ? null : linkedAnswers(fields, answers, defs);
  const ownRefusal = own ? firstError(own.errors) : null;
  if (ownRefusal) return { ok: false, error: ownRefusal };
  const values = own?.values ?? noLinkedValues();

  const first = invite.submission === null;
  const reseller = isResellerManaged(invite.company);

  // A lead only where the plan has leads, as on the public link.
  const entry = first && form.createsLead && !reseller && (await moduleAvailableForTenant("leads")) ? await newLeadStage() : null;
  const save = () => db.$transaction(async (tx) => {
    if (event) {
      await lockSeats(tx, form.id);
      if (attending) {
        const coming = await tx.formSubmission.count({
          where: { formId: form.id, ...COMING_WHERE, ...(invite.submission ? { id: { not: invite.submission.id } } : {}) },
        });
        if (!hasSeat(form.capacity, coming)) return { kind: "full" as const };
      }
    }

    /**
     * Its owner takes their room here, with the lead (owner, 12 Nov 2026 — Phase 4 lead limits, audit H.6.5): at their
     * limit, the lead is made with nobody, saying why, and the managers are told.
     */
    let owner: IntakeOwner | null = null;
    if (entry && attending !== false) {
      await markLeadWrite(tx, "form");
      owner = await intakeOwner(tx, { kind: "named", userId: form.assignToUserId ?? invite.company.ownerUserId ?? invite.invitedById ?? form.ownerUserId, note: null });
    }
    const lead =
      entry && attending !== false
        ? await tx.lead.create({
            data: {
              companyId: invite.company.id,
              contactId: invite.contact.id,
              title: `${form.name} — ${invite.company.name}`,
              ...leadExtras(fields, answers, defs, values, { company: false, contact: false }),
              ...entry,
              ownerUserId: owner?.userId ?? null,
              assignmentNote: owner?.note ?? null,
              sourcedByUserId: invite.invitedById ?? form.ownerUserId,
              source: "WEBSITE",
              sourceDetail: `Form: ${form.name} (invited)`,
            },
            select: { id: true },
          })
        : null;

    const data = {
      payload: answers,
      name: answers.name!,
      email: invite.email,
      phone: answers.phone || null,
      companyName: invite.company.name,
      attending,
      // They answered it themselves, so nobody here "recorded" it any more.
      recordedById: null,
      // A "no" after a "yes" takes them off the register; there is nothing left to mark.
      ...(attending === false ? { attendance: null, attendanceMarkedAt: null, attendanceMarkedById: null } : {}),
    };
    let submissionId: string;
    if (invite.submission) {
      await tx.formSubmission.update({ where: { id: invite.submission.id }, data });
      submissionId = invite.submission.id;
    } else {
      submissionId = (
        await tx.formSubmission.create({
          select: { id: true },
          data: {
          ...data,
          formId: form.id,
          inviteId: invite.id,
          companyId: invite.company.id,
          contactId: invite.contact.id,
          leadId: lead?.id ?? null,
          sourceHash: createHash("sha256").update(`${invite.email}:${form.id}`).digest("hex").slice(0, 32),
        },
        })
      ).id;
    }
    await emitEvent(tx, {
      type: "form.submitted",
      recordType: "form-submission",
      recordId: submissionId,
      payload: { form: { id: form.id, name: form.name }, submission: { id: submissionId }, companyId: invite.company.id, contactId: invite.contact.id, leadId: lead?.id ?? null, invited: true },
    });
    if (lead) await emitLeadCreated(tx, lead.id, null, "form");
    return { kind: "saved" as const, lead, overflow: owner?.overflow ?? null };
  }, { maxWait: 10_000, timeout: 20_000 });
  let outcome: Awaited<ReturnType<typeof save>>;
  try {
    outcome = await save();
  } catch (err) {
    // The plan's cap on leads: nothing was saved, and they're asked to come back (owner, 12 Nov 2026 — lead limits).
    if (leadCapacityError(err) || err instanceof LeadRuleRefused) return { ok: false, error: CANT_TAKE };
    throw err;
  }

  if (outcome.kind === "full") {
    return { ok: false, error: "Sorry — every seat has been taken. Your account manager can let you know if one frees up." };
  }
  if (outcome.lead) {
    await refreshLeadScore(outcome.lead.id);
    if (outcome.overflow) await notifyOverflow([outcome.lead.id], overflowReason(`${form.name} — ${invite.company.name}`, outcome.overflow));
  }

  // Whoever sent the invitation hears about it, then whoever the form routes to, then its owner.
  const tell = invite.invitedById ?? form.assignToUserId ?? form.ownerUserId;
  const changed = !first && event && invite.submission?.attending !== attending;
  if (first || changed) {
    await notifyUser({
      userId: tell,
      type: outcome.lead ? "LEAD_ASSIGNED" : "FORM_RESPONSE",
      title: event
        ? attending
          ? `${answers.name} (${invite.company.name}) is coming to ${form.name}`
          : `${answers.name} (${invite.company.name}) can't make ${form.name}`
        : `${answers.name} (${invite.company.name}) answered ${form.name}`,
      message: changed ? "They changed their answer." : "They answered the invitation you sent.",
      link: `/marketing/forms/${form.id}?tab=${event ? "invites" : "responses"}`,
    });
  }
  return { ok: true, data: { thankYou } };
}

/*
 * `preferenceLinkFor` was here.
 *
 * It took a contact id from an unauthenticated caller and returned that contact's long-lived
 * preference token — a permanent credential for somebody else's communication settings, handed out
 * to anybody who could guess or scrape an id. It had no callers: every real send path mints its own
 * per-message token (see `newToken` in src/lib/marketing/pipeline.ts).
 *
 * If the capability is wanted, it belongs in a plain module rather than a "use server" one, where
 * it is not an endpoint, and its caller should hold a session and a marketing permission.
 */
