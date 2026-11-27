import { countedAs, type CountedMail } from "@/lib/customer-mail-cap";
import { randomBytes } from "node:crypto";
import type { MessageChannel, MessageClass, MarketingTopic, Prisma, TemplateFormat } from "@prisma/client";
import { db } from "@/lib/db";
import { domainAndParents, domainCovers } from "@/lib/mail-block-rules";
import { STILL_THERE } from "@/lib/contacts/left";
import { decryptSecret } from "@/lib/crypto";
import { getOrganisation } from "@/lib/organisation";
import { closedDates } from "@/lib/hr/calendar";
import { getTicketSlaStatus } from "@/lib/tickets";
import { daysOverdue } from "@/lib/receivables";
import { audienceCompanyWhere, capPerCompany, contactWhere, parseCompanyFilters, parseContactFilters } from "@/lib/marketing/audience";
import { canSend, type RecipientState, type SendContext, type SendVerdict } from "@/lib/marketing/suppression";
import { nextSendTime, type ScheduleRules } from "@/lib/marketing/schedule";
import { fieldsUsed, render, type MergeValues } from "@/lib/marketing/merge";
import { daysLeftPhrase } from "@/lib/marketing/customer-notices";
import { formatOrderId } from "@/lib/order-id";
import { expandWidgets } from "@/lib/marketing/email-widgets";
import { campaignOptions, splitTest } from "@/lib/marketing/campaign-options";
import { atHour, quietContacts, requireOptIn, usualOpenHours } from "@/lib/marketing/policy";
import { checkUncheckedAddresses } from "@/lib/marketing/check-before-send";
import { composeEmail, escapeHtml } from "@/lib/marketing/html";
import { trackedLinkWith } from "@/lib/marketing/tracking";
import { campaignEligibility, countsAsOptOut } from "@/lib/marketing/topics";
import { currentKeys } from "@/lib/tenancy/keys";
import { postalAddressFor } from "@/lib/marketing/footer";
import { providerByKey, routeFor, type RoutableProvider } from "@/lib/marketing/providers";
import { addressVerdict } from "@/lib/mail-address-gate";
import type { OutboundMessage } from "@/lib/marketing/providers/types";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import { workspaceClock } from "@/lib/time/workspace";
import { DEFAULT_UTM, tagHtmlLinks, tagTextLinks, type UtmSettings, type UtmTags } from "@/lib/marketing/utm";
import { utmSettings } from "@/lib/marketing/utm-settings";

/**
 * The machinery between "somebody pressed send" and "a provider accepted it".
 *
 * Server-only, and deliberately **not** a `"use server"` module: every export in one of those is a
 * client-callable endpoint, and these functions queue mail, decrypt provider secrets and mark
 * messages as sent. The same reasoning guards `notifyUser` and `recordAudit`.
 */

const WEEK = 7 * 86400000;

// ─── Settings ─────────────────────────────────────────────────────────────────

export type MarketingSettings = {
  rules: ScheduleRules;
  limits: SendContext["limits"];
  postalAddress: string | null;
  approvalThreshold: number;
  ourName: string;
  /** UTM tags on the links (src/lib/marketing/utm.ts); the defaults when a caller builds settings of its own. */
  utm?: UtmSettings;
};

export async function marketingSettings(): Promise<MarketingSettings> {
  const [org, holidays, clock, utm, optIn] = await Promise.all([
    getOrganisation(),
    db.holiday.findMany({ select: { date: true, optional: true } }),
    workspaceClock(),
    utmSettings(),
    requireOptIn(),
  ]);

  return {
    rules: {
      quiet: { startMinute: org.marketingQuietStartMinute, endMinute: org.marketingQuietEndMinute },
      skipNonWorkingDays: org.marketingSkipNonWorkingDays,
      // Restricted holidays are excluded by `closedDates` — the office is open on those.
      holidays: closedDates(holidays),
      // Quiet hours are the workspace's own: 8 pm in Dubai is 8 pm there, not in India.
      clock,
    },
    limits: {
      maxPerContactPerWeek: org.marketingMaxPerContactPerWeek,
      overdueDaysBlock: 60,
      requireVerifiedAddress: true,
      requireOptIn: optIn,
    },
    // Falls back to the registered office — the app already knows where the company is.
    postalAddress: postalAddressFor(org).text,
    approvalThreshold: org.marketingApprovalThreshold,
    ourName: org.tradeName || org.legalName || "us",
    utm,
  };
}

// ─── Who would receive this ───────────────────────────────────────────────────

export type Recipient = {
  contactId: string;
  companyId: string;
  companyName: string;
  name: string;
  email: string | null;
  phone: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  state: RecipientState;
  /** For dynamic content (src/lib/marketing/merge.ts): has the company bought from us, and where is it. */
  isCustomer?: boolean;
  city?: string | null;
  region?: string | null;
};

export type ResolvedRecipient = { recipient: Recipient; verdict: SendVerdict };

/**
 * Everybody an audience reaches, each with the verdict on whether they may actually be reached.
 *
 * Suppressed recipients are returned rather than filtered out. A dry run has to be able to say
 * *why* 112 people are not getting this, and a message row is written for each of them so the
 * question is still answerable in six months.
 *
 * Every signal is gathered in a handful of grouped queries rather than per contact — a campaign is
 * a few thousand rows, and this runs on a five-minute tick.
 */
export async function resolveRecipients(params: {
  /** An audience's filters — leave both out for a list-only send. */
  companyFilters?: unknown;
  contactFilters?: unknown;
  /** An uploaded list, on its own or on top of the audience. */
  listId?: string | null;
  /** Particular people, by id — a workflow's email to a lead's contact (src/lib/automate/actions). */
  contactIds?: string[];
  channel: MessageChannel;
  topic: MarketingTopic;
  messageClass: MessageClass;
  settings: MarketingSettings;
  /** A reminder: the person's own opt-outs stop it too (src/lib/marketing/suppression.ts `optOuts`). */
  optOuts?: boolean;
  /**
   * Check every address nobody has checked before judging (src/lib/marketing/check-before-send.ts) — a campaign being
   * sent. A preview leaves it out and reports them as checked when it goes.
   */
  checkAddresses?: boolean;
  /**
   * Narrows whatever the sources reach to these companies and people — a journey step for one enrolment. Security audit
   * round three, 14 Nov 2026 (low): a step resolved the whole workspace's audience (up to 5,000 contacts) and then kept
   * one company, so each email step read thousands of contacts — and skipped the company if it wasn't among them.
   */
  narrowTo?: { companyIds?: string[]; contactIds?: string[] };
}): Promise<ResolvedRecipient[]> {
  const companyFilters = parseCompanyFilters(params.companyFilters);
  const contactFilters = parseContactFilters(params.contactFilters);

  const fromAudience: Prisma.ContactWhereInput | null =
    params.companyFilters !== undefined
      ? { company: audienceCompanyWhere(companyFilters, params.settings.rules.clock), ...contactWhere(contactFilters, params.channel, db.contact.fields.email) }
      : null;
  // A list is everyone on it. Whether each of them may be mailed is the verdict's job below, the
  // same as for anybody else — being uploaded earns nobody a way round the rules.
  const fromList: Prisma.ContactWhereInput | null = params.listId ? { marketingLists: { some: { listId: params.listId } } } : null;
  const fromIds: Prisma.ContactWhereInput | null = params.contactIds?.length ? { id: { in: params.contactIds } } : null;
  const sources = [fromAudience, fromList, fromIds].filter((w): w is Prisma.ContactWhereInput => !!w);
  if (sources.length === 0) return [];

  const contacts = await db.contact.findMany({
    // Nobody who has left their company (src/lib/contacts/left.ts), from an audience, a list or by name.
    where: {
      AND: [
        sources.length === 1 ? sources[0]! : { OR: sources },
        STILL_THERE,
        ...(params.narrowTo?.companyIds ? [{ companyId: { in: params.narrowTo.companyIds } }] : []),
        ...(params.narrowTo?.contactIds ? [{ id: { in: params.narrowTo.contactIds } }] : []),
      ],
    },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      isPrimary: true,
      emailStatus: true,
      emailCheckedValue: true,
      companyId: true,
      company: {
        select: {
          id: true,
          name: true,
          managedByResellerId: true,
          owner: { select: { name: true, email: true } },
          _count: { select: { products: true } },
          locations: { orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }], take: 1, select: { city: true, state: true } },
        },
      },
    },
    take: 5000,
  });

  // The per-company cap is the audience's rule; a list, or a name, was chosen person by person.
  const capped = fromList || fromIds ? contacts : capPerCompany(contacts, contactFilters.maxPerCompany);
  if (capped.length === 0) return [];

  // Sending marketing that asks for a checked address: check the ones nobody has, and judge them by what they became.
  if (params.checkAddresses && params.channel === "EMAIL" && params.messageClass === "MARKETING" && params.settings.limits.requireVerifiedAddress) {
    const checked = await checkUncheckedAddresses(capped);
    for (const c of capped) {
      const now = checked.get(c.id);
      if (now) Object.assign(c, { emailStatus: now.status, emailCheckedValue: now.value });
    }
  }

  const contactIds = capped.map((c) => c.id);
  const companyIds = [...new Set(capped.map((c) => c.companyId))];
  const addresses = capped.map((c) => c.email?.trim().toLowerCase()).filter((e): e is string => !!e);
  // A domain blocked covers its subdomains (src/lib/mail-block-rules.ts): ask for the parents too.
  const domains = [...new Set(addresses.flatMap((a) => domainAndParents(a.split("@")[1] ?? "")))];
  const since = new Date(Date.now() - WEEK);
  const now = new Date();

  const [suppressions, consents, feedback, invoices, tickets, recentSends] = await Promise.all([
    db.suppression.findMany({
      where: {
        OR: [
          { scope: "EMAIL", value: { in: addresses } },
          { scope: "CONTACT", value: { in: contactIds } },
          { scope: "COMPANY", value: { in: companyIds } },
          { scope: "DOMAIN", value: { in: domains } },
        ],
        AND: [{ OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] }],
      },
      select: { scope: true, value: true, reason: true },
    }),
    db.contactConsent.findMany({
      where: { contactId: { in: contactIds }, channel: params.channel, topic: params.topic },
      select: { contactId: true, status: true, source: true, withdrawnAt: true },
    }),
    // Feedback at 3 or below that nobody has answered — the strongest "don't sell to them" signal
    // the app has, after the reseller flag.
    db.feedbackRequest.findMany({
      where: { companyId: { in: companyIds }, response: { rating: { lte: 3 }, acknowledgedAt: null } },
      select: { companyId: true },
    }),
    db.tradeDocument.findMany({
      where: {
        companyId: { in: companyIds },
        docType: "INVOICE",
        status: { in: ["ISSUED", "PARTIALLY_PAID", "ACCEPTED"] },
        dueDate: { lt: now },
      },
      select: { companyId: true, dueDate: true, issueDate: true },
    }),
    db.ticket.findMany({
      where: { companyId: { in: companyIds }, status: { notIn: ["RESOLVED", "CLOSED"] } },
      select: { companyId: true, priority: true, status: true, createdAt: true },
    }),
    db.marketingMessage.groupBy({
      by: ["contactId"],
      where: {
        contactId: { in: contactIds },
        messageClass: "MARKETING",
        sentAt: { gte: since },
        status: { notIn: ["SUPPRESSED", "FAILED"] },
      },
      _count: { _all: true },
    }),
  ]);

  const tally = <T>(rows: T[], key: (row: T) => string | null) => {
    const map = new Map<string, number>();
    for (const row of rows) {
      const k = key(row);
      if (k) map.set(k, (map.get(k) ?? 0) + 1);
    }
    return map;
  };

  const unanswered = tally(feedback, (f) => f.companyId);
  const breached = tally(
    tickets.filter((t) => getTicketSlaStatus(t.priority, t.status, t.createdAt, params.settings.rules.clock, now).key === "overdue"),
    (t) => t.companyId,
  );
  const overdueBy = new Map<string, number>();
  for (const inv of invoices) {
    if (!inv.companyId) continue;
    const days = daysOverdue(inv.dueDate, inv.issueDate, now);
    overdueBy.set(inv.companyId, Math.max(overdueBy.get(inv.companyId) ?? 0, days));
  }
  // A reminder asks only whether they turned it off, as src/lib/marketing/topics.ts counts that.
  const reminder = params.optOuts === true && params.messageClass !== "MARKETING";
  const consentBy = new Map(consents.filter((c) => !reminder || countsAsOptOut(c)).map((c) => [c.contactId, c.status]));
  const sentBy = new Map(recentSends.map((r) => [r.contactId ?? "", r._count._all]));
  // The sunset rule (src/lib/marketing/policy.ts): sent several marketing emails in its window and opened none.
  const quiet = params.messageClass === "MARKETING" && params.channel === "EMAIL" ? await quietContacts(contactIds) : null;

  const ctx: SendContext = {
    messageClass: params.messageClass,
    channel: params.channel,
    topic: params.topic,
    limits: params.settings.limits,
    optOuts: params.optOuts === true,
  };

  return capped.map((contact) => {
    const address = contact.email?.trim().toLowerCase() ?? null;
    const domain = address?.split("@")[1] ?? null;
    const mine = suppressions.filter(
      (s) =>
        (s.scope === "EMAIL" && address !== null && s.value === address) ||
        (s.scope === "CONTACT" && s.value === contact.id) ||
        (s.scope === "COMPANY" && s.value === contact.companyId) ||
        (s.scope === "DOMAIN" && domainCovers(s.value, domain)),
    );

    const state: RecipientState = {
      company: { managedByResellerId: contact.company.managedByResellerId },
      contact: {
        email: contact.email,
        phone: contact.phone,
        emailStatus: contact.emailStatus,
        emailCheckedValue: contact.emailCheckedValue,
      },
      suppressions: mine.map((s) => ({ reason: s.reason })),
      consent: consentBy.has(contact.id) ? { status: consentBy.get(contact.id)! } : null,
      signals: {
        unansweredFeedback: unanswered.get(contact.companyId) ?? 0,
        daysOverdue: overdueBy.get(contact.companyId) ?? null,
        breachedTickets: breached.get(contact.companyId) ?? 0,
        sentInLastWeek: sentBy.get(contact.id) ?? 0,
        quietForDays: quiet?.ids.has(contact.id) ? quiet.days : null,
      },
    };

    return {
      recipient: {
        contactId: contact.id,
        companyId: contact.companyId,
        companyName: contact.company.name,
        name: contact.name,
        email: contact.email,
        phone: contact.phone,
        ownerName: contact.company.owner?.name ?? null,
        ownerEmail: contact.company.owner?.email ?? null,
        state,
        isCustomer: contact.company._count.products > 0,
        city: contact.company.locations[0]?.city ?? null,
        region: contact.company.locations[0]?.state ?? null,
      },
      verdict: canSend(state, ctx),
    };
  });
}

// ─── Merge values ─────────────────────────────────────────────────────────────

export function mergeValuesFor(
  recipient: Recipient,
  settings: MarketingSettings,
  extras: MergeValues = {},
): MergeValues {
  return {
    firstName: recipient.name.trim().split(/\s+/)[0] ?? null,
    fullName: recipient.name,
    companyName: recipient.companyName,
    ourName: settings.ourName,
    ownerName: recipient.ownerName,
    ownerEmail: recipient.ownerEmail,
    postalAddress: settings.postalAddress,
    // Facts for dynamic blocks only — not fields a template can print.
    isCustomer: recipient.isCustomer ? "yes" : null,
    city: recipient.city ?? null,
    state: recipient.region ?? null,
    ...extras,
  };
}

/** The renewal and cover fields, formatted the way the rest of the app formats them. */
export function subscriptionMergeValues(product: {
  item: { name: string };
  quantity: number;
  endDate: Date | null;
  fullTermUnitPrice: Prisma.Decimal | number | null;
}): MergeValues {
  const price = product.fullTermUnitPrice === null ? null : Number(product.fullTermUnitPrice);
  const days = product.endDate
    ? Math.ceil((new Date(product.endDate).getTime() - Date.now()) / 86400000)
    : null;
  return {
    productName: product.item.name,
    quantity: product.quantity,
    // A typed day, held at UTC midnight: the day itself, in any zone.
    expiryDate: product.endDate ? formatCalendarDay(product.endDate) : null,
    daysLeft: days,
    renewalValue: price === null ? null : formatCurrency(price * product.quantity),
  };
}

/** The merge fields a subscription fills — a template using any is about a renewal. */
export const SUBSCRIPTION_FIELDS = ["productName", "quantity", "expiryDate", "daysLeft", "daysLeftPhrase", "renewalValue", "orderId", "poNumber"] as const;

/** Whether a template reads a subscription's fields anywhere — its subject, preview line or body. */
export function usesSubscriptionFields(template: { subject: string | null; preheader: string | null; body: string }): boolean {
  const { known } = fieldsUsed(`${template.subject ?? ""} ${template.preheader ?? ""} ${template.body}`);
  return known.some((k) => (SUBSCRIPTION_FIELDS as readonly string[]).includes(k));
}

/**
 * Each company's soonest-renewing live subscription, as merge values (owner, 3 Nov 2026: a renewal notice sent as a
 * mass mail read "Your subscription · We'll confirm" — a campaign goes to people, so nothing said which subscription).
 * The one ending first from today on: a subscription line of its own (not an add-on), not cancelled or rejected — the
 * one "Send test" fills a test with (src/actions/email-builder-tools.ts). A company with none isn't in the map.
 */
export async function soonestSubscriptions(companyIds: string[], today: Date): Promise<Map<string, MergeValues>> {
  const ids = [...new Set(companyIds.filter(Boolean))];
  if (ids.length === 0) return new Map();
  const rows = await db.companyProduct.findMany({
    where: { companyId: { in: ids }, parentId: null, item: { type: "SUBSCRIPTION" }, endDate: { gte: today }, orderStatus: { notIn: ["CANCELLED", "REJECTED"] } },
    orderBy: [{ endDate: "asc" }, { orderSeq: "asc" }],
    select: { companyId: true, orderSeq: true, quantity: true, endDate: true, fullTermUnitPrice: true, poNumber: true, item: { select: { name: true } } },
  });
  const out = new Map<string, MergeValues>();
  for (const r of rows) {
    if (out.has(r.companyId)) continue;
    const v = subscriptionMergeValues(r);
    out.set(r.companyId, { ...v, daysLeftPhrase: daysLeftPhrase(typeof v.daysLeft === "number" ? v.daysLeft : null), orderId: formatOrderId(r.orderSeq), poNumber: r.poNumber });
  }
  return out;
}

/** Why a renewal email wasn't sent to somebody — said on their row. */
export const NO_SUBSCRIPTION_REASON = "No live subscription to fill the renewal details from — held back rather than sent \"Your subscription · We'll confirm\"";

// ─── Queueing ─────────────────────────────────────────────────────────────────

export function newToken() {
  return randomBytes(24).toString("base64url");
}

export type QueueOutcome = { queued: number; suppressed: number; blocked: number };

export type BuiltEmail =
  | { ok: true; subject: string; html: string; text: string; unsubscribeUrl: string }
  | { ok: false; missing: string[] };

/**
 * One recipient's email, finished: merged, composed with its footer, tracked, and with its own
 * one-click unsubscribe address. Campaigns and journeys both build theirs here, so a journey step is
 * held to exactly the same rules as a broadcast.
 */
export function buildMarketingEmail(input: {
  template: { subject: string | null; preheader: string | null; body: string; format: TemplateFormat };
  recipient: Recipient;
  settings: MarketingSettings;
  token: string;
  origin: string;
  /** The workspace's tracking key, to track opens and clicks; null not to. */
  trackingKey: Buffer | null;
  /** What the links are tagged as coming from (src/lib/marketing/utm.ts): the campaign's or journey's name, the template's. */
  utm?: UtmTags;
  /** More values to fill in — a renewal email's subscription (`soonestSubscriptions`). */
  extras?: MergeValues;
}): BuiltEmail {
  const { template, token, origin, settings } = input;
  const values = mergeValuesFor(input.recipient, settings, { ...input.extras, unsubscribeUrl: `${origin}/preferences/${token}` });
  const subject = render(template.subject ?? "", values);
  const preheader = render(template.preheader ?? "", values);
  // An HTML template's merged values are escaped; its own markup, and a fallback it wrote, are not.
  const body = render(template.body, values, template.format === "HTML" ? { escape: escapeHtml } : undefined);
  if (!subject.ok || !preheader.ok || !body.ok) {
    return { ok: false, missing: [...new Set([subject, preheader, body].flatMap((r) => (r.ok ? [] : r.missing)))] };
  }
  // Countdown timers and polls (src/lib/marketing/email-widgets.ts), drawn in once the fields are filled.
  const filled = expandWidgets(body.text, template.format, { origin, token });
  // Tagged before the tracker wraps them, so the place a click lands carries the tags; the app's own links are left alone.
  const tagged = input.utm ? (template.format === "HTML" ? tagHtmlLinks(filled, settings.utm ?? DEFAULT_UTM, input.utm, origin) : tagTextLinks(filled, settings.utm ?? DEFAULT_UTM, input.utm, origin)) : filled;
  const email = composeEmail({
    format: template.format,
    body: tagged,
    preheader: preheader.text,
    footer: {
      senderName: settings.ourName,
      unsubscribeUrl: String(values.unsubscribeUrl),
      postalAddress: settings.postalAddress,
      // Placed by the author already — once is enough.
      includeUnsubscribe: !body.used.includes("unsubscribeUrl"),
      includeAddress: !body.used.includes("postalAddress"),
    },
    origin,
    track: input.trackingKey
      ? { openPixelUrl: `${origin}/track/${token}`, link: (url) => trackedLinkWith(input.trackingKey!, origin, token, url) }
      : undefined,
  });
  return { ok: true, subject: subject.text, html: email.html, text: email.text, unsubscribeUrl: `${origin}/api/marketing/unsubscribe/${token}` };
}

/**
 * Turns an audience into message rows.
 *
 * Every recipient gets a row, including the ones who will never receive it — a suppressed row with
 * a reason is the only thing that can answer "why didn't they get it?" later. Both unique indexes
 * on `MarketingMessage` make this safe to run twice.
 */
export async function queueCampaign(campaignId: string, origin: string): Promise<QueueOutcome> {
  const campaign = await db.campaign.findUniqueOrThrow({
    where: { id: campaignId },
    include: { audience: true, template: true },
  });
  const settings = await marketingSettings();
  // An A/B test, a resend's subject and its people, each person's best hour (src/lib/marketing/campaign-options.ts).
  const options = await campaignOptions(campaign.id);

  const resolved = await resolveRecipients(
    options.recipientIds
      ? { contactIds: options.recipientIds, channel: campaign.channel, topic: campaign.template.topic, ...campaignEligibility(campaign.template.topic), settings, checkAddresses: true }
      : {
          companyFilters: campaign.audience?.companyFilters,
          contactFilters: campaign.audience?.contactFilters,
          listId: campaign.listId,
          channel: campaign.channel,
          topic: campaign.template.topic,
          ...campaignEligibility(campaign.template.topic),
          settings,
          // Going now: an address nobody has checked is checked first (src/lib/marketing/check-before-send.ts).
          checkAddresses: true,
        },
  );

  // Which email each person gets. A resend goes with its new subject. An A/B test not yet decided goes to its slice
  // only, half A and half B — everybody else waits for the winner; once decided, the winner goes to everybody not yet sent.
  const versionA = options.subject ? { ...campaign.template, subject: options.subject } : campaign.template;
  const ab = options.abTest;
  let versionB = versionA;
  if (ab?.test === "subject" && ab.subjectB) versionB = { ...versionA, subject: ab.subjectB };
  if (ab?.test === "template" && ab.templateBId) versionB = (await db.marketingTemplate.findUnique({ where: { id: ab.templateBId } })) ?? versionA;
  const testing = !!ab && !ab.winner;
  const split = testing ? splitTest(campaign.id, resolved.filter((r) => r.verdict.ok && r.recipient.contactId).map((r) => r.recipient.contactId!), ab.percent) : null;
  const winnerTemplate = ab?.winner === "B" ? versionB : versionA;
  const alreadySent = ab?.winner
    ? new Set((await db.marketingMessage.findMany({ where: { campaignId: campaign.id }, select: { contactId: true } })).map((m) => m.contactId))
    : null;

  const sendAt = nextSendTime(campaign.scheduledFor ?? new Date(), {
    ...settings.rules,
    window:
      campaign.windowStartMinute !== null && campaign.windowEndMinute !== null
        ? { startMinute: campaign.windowStartMinute, endMinute: campaign.windowEndMinute }
        : null,
  });

  // A renewal email (its template reads a subscription's fields): each person's from their company's soonest-renewing
  // subscription, and nobody sent one whose company has none (owner, 3 Nov 2026).
  const aboutRenewal = [versionA, versionB, winnerTemplate].some(usesSubscriptionFields);
  const subscriptions = aboutRenewal ? await soonestSubscriptions(resolved.flatMap((r) => (r.verdict.ok && r.recipient.companyId ? [r.recipient.companyId] : [])), settings.rules.clock.calendarDate(new Date())) : null;

  let queued = 0;
  let suppressed = 0;
  let blocked = 0;
  // Each person at the hour they usually open, where the campaign asks and they've opened before (src/lib/marketing/policy.ts) —
  // within a day of the send time, and still inside quiet hours and holidays.
  const bestHours = options.sendTime === "best" && campaign.channel === "EMAIL" ? await usualOpenHours(resolved.map((r) => r.recipient.contactId), settings.rules.clock) : null;
  const sendAtFor = (contactId: string) => {
    const hour = bestHours?.get(contactId);
    return hour === undefined ? sendAt : nextSendTime(atHour(sendAt, hour, settings.rules.clock), { ...settings.rules, window: null });
  };

  for (const { recipient, verdict } of resolved) {
    // The winner's send: those the test already reached, or held back, aren't sent again.
    if (alreadySent?.has(recipient.contactId)) continue;
    // An undecided test: somebody outside its slice waits for the winner — unless they can't be sent at all, which is said now.
    const variant = split && recipient.contactId ? (split.get(recipient.contactId) ?? null) : null;
    if (testing && verdict.ok && !variant) continue;
    const template = testing ? (variant === "B" ? versionB : versionA) : winnerTemplate;
    const token = newToken();
    const base = {
      token,
      campaignId: campaign.id,
      companyId: recipient.companyId,
      contactId: recipient.contactId,
      channel: campaign.channel,
      messageClass: "MARKETING" as const,
      toEmail: recipient.email,
      toPhone: recipient.phone,
      scheduledFor: sendAtFor(recipient.contactId),
    };

    if (!verdict.ok) {
      await db.marketingMessage
        .create({
          data: {
            ...base,
            subject: campaign.template.subject,
            body: "",
            status: "SUPPRESSED",
            suppressedReason: `${verdict.reason}: ${verdict.detail}`,
          },
        })
        .catch(() => undefined); // Already queued by an earlier run; the unique index did its job.
      suppressed += 1;
      continue;
    }

    const subscription = subscriptions && recipient.companyId ? subscriptions.get(recipient.companyId) : undefined;
    if (subscriptions && !subscription) {
      await db.marketingMessage
        .create({ data: { ...base, subject: campaign.template.subject, body: "", status: "SUPPRESSED", suppressedReason: NO_SUBSCRIPTION_REASON } })
        .catch(() => undefined);
      blocked += 1;
      continue;
    }

    const email =
      campaign.channel === "EMAIL"
        ? buildMarketingEmail({ template, recipient, settings, token, origin, trackingKey: (await currentKeys()).trackingKey, utm: { campaign: campaign.name, content: template.name }, extras: subscription })
        : null;
    // WhatsApp carries its words as they are — no HTML, no footer, no pixel.
    const values = mergeValuesFor(recipient, settings, { ...subscription, unsubscribeUrl: `${origin}/preferences/${token}` });
    const plain = email ? null : { subject: render(template.subject ?? "", values), body: render(template.body, values) };

    // A message that cannot be filled in is not sent half-finished. "Hi ," is unrecoverable.
    const missing = email ? (email.ok ? [] : email.missing) : [plain!.subject, plain!.body].flatMap((r) => (r.ok ? [] : r.missing));
    if (missing.length > 0) {
      await db.marketingMessage
        .create({
          data: {
            ...base,
            subject: campaign.template.subject,
            body: "",
            status: "SUPPRESSED",
            suppressedReason: `Missing merge field(s): ${[...new Set(missing)].join(", ")}`,
          },
        })
        .catch(() => undefined);
      blocked += 1;
      continue;
    }

    const content =
      email && email.ok
        ? { subject: email.subject, body: email.html, textBody: email.text, unsubscribeUrl: email.unsubscribeUrl }
        : { subject: plain!.subject.ok ? plain!.subject.text : "", body: plain!.body.ok ? plain!.body.text : "" };
    const row = await db.marketingMessage.create({ data: { ...base, ...content, status: "QUEUED" }, select: { id: true } }).catch(() => null);
    // Which version it carried, for the winner to be worked out from.
    if (row && variant) await db.abVariant.create({ data: { messageId: row.id, campaignId: campaign.id, variant } }).catch(() => undefined);
    queued += 1;
  }

  return { queued, suppressed, blocked };
}

/**
 * Campaigns, moved along by what their messages have done: SCHEDULED → SENDING once the first has
 * gone, and SENT once nothing is left waiting. Without this a campaign said "Scheduled" for ever,
 * long after the last message was delivered.
 */
export async function settleCampaigns(): Promise<void> {
  const active = await db.campaign.findMany({ where: { status: { in: ["SCHEDULED", "SENDING"] } }, select: { id: true, status: true } });
  if (active.length === 0) return;
  const counts = await db.marketingMessage.groupBy({
    by: ["campaignId", "status"],
    where: { campaignId: { in: active.map((c) => c.id) } },
    _count: { _all: true },
  });
  // A campaign whose A/B test hasn't been decided isn't finished: the winner's send is still to come.
  const testing = new Set<string>();
  for (const c of active) {
    if ((await campaignOptions(c.id)).abTest?.winner === null) testing.add(c.id);
  }
  for (const c of active) {
    const mine = counts.filter((r) => r.campaignId === c.id);
    const waiting = mine.filter((r) => r.status === "QUEUED" || r.status === "SENDING").reduce((t, r) => t + r._count._all, 0);
    const gone = mine.filter((r) => !["QUEUED", "SENDING", "SUPPRESSED"].includes(r.status)).reduce((t, r) => t + r._count._all, 0);
    if (waiting === 0 && !testing.has(c.id)) {
      await db.campaign.update({ where: { id: c.id }, data: { status: "SENT", finishedAt: new Date() } });
    } else if (gone > 0 && c.status === "SCHEDULED") {
      await db.campaign.update({ where: { id: c.id }, data: { status: "SENDING" } });
    }
  }
}

// ─── Sending ──────────────────────────────────────────────────────────────────

async function loadProviders(): Promise<RoutableProvider[]> {
  const rows = await db.messagingProvider.findMany({
    select: { id: true, key: true, label: true, kind: true, enabled: true, priority: true, classes: true, fromEmail: true },
  });
  return rows;
}

async function providerCredentials(id: string) {
  const row = await db.messagingProvider.findUniqueOrThrow({ where: { id } });
  return {
    key: row.key,
    label: row.label,
    fromName: row.fromName,
    fromEmail: row.fromEmail,
    replyTo: row.replyTo,
    config: (row.config as Record<string, unknown>) ?? {},
    secret: row.secretCipher ? await decryptSecret(row.secretCipher) : null,
  };
}

/**
 * Straight through the provider chain, now — for a test send, which has no row to queue. The same
 * routing and failover as the queue, so a test that arrives proves the real thing can.
 */
/**
 * The mail route a class of mail would go out by now, without sending anything: the first provider in
 * its chain that really delivers, and the address it sends from. Null when none is set up — for the
 * document mail's choice of sender (src/lib/documents/mail-route.ts).
 */
export async function emailRouteFor(messageClass: MessageClass): Promise<{ label: string; fromEmail: string | null } | null> {
  const chain = routeFor(await loadProviders(), { kind: "EMAIL", messageClass }).filter((p) => p.key !== "mock" && providerByKey[p.key]);
  const first = chain[0];
  return first ? { label: first.label, fromEmail: first.fromEmail } : null;
}

export async function deliverNow(
  message: OutboundMessage,
  messageClass: MessageClass,
  /** `kind`: WhatsApp's chain instead of email's — a workflow's WhatsApp template (src/lib/automate). */
  options: { delivering?: boolean; kind?: "EMAIL" | "WHATSAPP" } = {},
): Promise<{ ok: true; provider: string; fromEmail: string | null } | { ok: false; error: string }> {
  // `delivering`: only a provider that puts mail on the wire. Mock "sends" by recording, which is
  // right for a test send and wrong for mail somebody has to receive.
  const kind = options.kind ?? "EMAIL";
  const chain = routeFor(await loadProviders(), { kind, messageClass }).filter((p) => !options.delivering || p.key !== "mock");
  if (chain.length === 0) return { ok: false, error: `No ${kind === "WHATSAPP" ? "WhatsApp" : "email"} provider is set up for ${messageClass.toLowerCase()} messages — add one in Settings › Mail & messaging.` };
  let last = "No provider accepted it.";
  for (const candidate of chain) {
    const implementation = providerByKey[candidate.key];
    if (!implementation) continue;
    const credentials = await providerCredentials(candidate.id);
    const result = await implementation.send(message, credentials);
    if (result.ok) return { ok: true, provider: candidate.label, fromEmail: message.fromEmail ?? credentials.fromEmail };
    last = result.error;
    if (!result.retryable) break;
  }
  return { ok: false, error: last };
}

export type TickOutcome = { claimed: number; sent: number; failed: number };

/**
 * One pass of the sender.
 *
 * The claim is a single atomic `UPDATE … RETURNING`, so two ticks that overlap — a slow run and the
 * next one starting — cannot take the same row. The ten-minute clause releases anything a crashed
 * run left locked, which is the only way a stuck message ever gets sent.
 */
export async function sendQueued(runId: string, batchSize = 100): Promise<TickOutcome> {
  const claimed = await db.$queryRaw<{ id: string }[]>`
    UPDATE marketing_messages
       SET "lockedAt" = now(), "lockedBy" = ${runId}, status = 'SENDING', attempts = attempts + 1
     WHERE id IN (
       SELECT id FROM marketing_messages
        WHERE status = 'QUEUED'
          AND "scheduledFor" <= now()
          AND "sentAt" IS NULL
          AND ("lockedAt" IS NULL OR "lockedAt" < now() - interval '10 minutes')
        ORDER BY "scheduledFor"
        LIMIT ${batchSize}
        FOR UPDATE SKIP LOCKED
     )
     RETURNING id`;

  if (claimed.length === 0) return { claimed: 0, sent: 0, failed: 0 };

  const providers = await loadProviders();
  const credentialCache = new Map<string, Awaited<ReturnType<typeof providerCredentials>>>();
  let sent = 0;
  let failed = 0;

  for (const { id } of claimed) {
    const message = await db.marketingMessage.findUnique({
      where: { id },
      include: { contact: { select: { name: true } } },
    });
    if (!message) continue;

    const chain = routeFor(providers, {
      kind: message.channel === "WHATSAPP" ? "WHATSAPP" : "EMAIL",
      messageClass: message.messageClass,
    });
    if (chain.length === 0) {
      await db.marketingMessage.update({
        where: { id },
        data: { status: "QUEUED", lockedAt: null, lockedBy: null, error: "No provider is configured for this." },
      });
      failed += 1;
      continue;
    }

    // An address that can't receive mail (src/lib/mail-address-gate.ts) — the providers refuse it too; here it also
    // marks the contact, so its page says so and the next send stops before the queue. Not for the mock's suites.
    if (message.channel === "EMAIL" && message.toEmail && chain.some((p) => p.key !== "mock")) {
      const verdict = await addressVerdict(message.toEmail);
      if (!verdict.ok) {
        await db.marketingMessage.update({ where: { id }, data: { status: "FAILED", lockedAt: null, lockedBy: null, error: `Not sent: ${verdict.detail}` } });
        if (message.contactId) {
          await db.contact.updateMany({
            where: { id: message.contactId, email: { equals: message.toEmail, mode: "insensitive" } },
            data: { emailStatus: "INVALID", emailCheckedValue: message.toEmail, emailCheckedAt: new Date(), emailCheckMethod: "AUTOMATIC", emailCheckDetail: verdict.detail, emailCheckedByUserId: null },
          });
        }
        failed += 1;
        continue;
      }
    }

    // Who it's copied to — a customer notice CC'd to the sender or the account manager (owner, 3 Nov 2026). Read by name:
    // only a transactional email carries one, and a workspace not migrated yet has none.
    const cc =
      message.channel === "EMAIL" && message.messageClass === "TRANSACTIONAL"
        ? await db.marketingMessage
            .findUnique({ where: { id }, select: { ccEmails: true } })
            .then((r) => r?.ccEmails ?? [])
            .catch(() => [] as string[])
        : [];

    let result: Awaited<ReturnType<(typeof providerByKey)[string]["send"]>> | null = null;
    let usedProviderId: string | null = null;
    // What Settings › Customer emails' 24-hour limit counts (src/lib/customer-mail-cap.ts): a campaign's or journey's
    // email, any marketing one, and a renewal notice. A form invitation or an order's fulfilment isn't counted.
    const counts: CountedMail | null =
      message.campaignId || message.enrolmentId || message.messageClass === "MARKETING"
        ? "marketing"
        : message.noticeKind === "RENEWAL" || message.noticeKind === "RENEWED"
          ? "renewal"
          : null;

    for (const candidate of chain) {
      const implementation = providerByKey[candidate.key];
      if (!implementation) continue;
      if (!credentialCache.has(candidate.id)) {
        credentialCache.set(candidate.id, await providerCredentials(candidate.id));
      }
      usedProviderId = candidate.id;
      result = await countedAs(counts, () => implementation.send(
        {
          to: message.toEmail ?? message.toPhone ?? "",
          toName: message.contact?.name ?? null,
          subject: message.subject ?? "",
          html: message.body,
          text: message.textBody ?? undefined,
          // The one-click unsubscribe Gmail and Yahoo require of bulk senders. Null for a notice.
          listUnsubscribe: message.unsubscribeUrl,
          ...(cc.length ? { cc } : {}),
        },
        credentialCache.get(candidate.id)!,
      ));
      // Only a retryable failure is worth the next provider. A rejected address is rejected
      // everywhere, and trying again is how the same person gets two copies.
      if (result.ok || !result.retryable) break;
    }

    if (result?.ok) {
      await db.marketingMessage.update({
        where: { id },
        data: {
          status: "SENT",
          sentAt: new Date(),
          providerId: usedProviderId,
          providerMessageId: result.providerMessageId,
          lockedAt: null,
          lockedBy: null,
          error: null,
        },
      });
      sent += 1;
    } else {
      const retryable = result ? result.retryable : true;
      await db.marketingMessage.update({
        where: { id },
        data: {
          // A retryable failure goes back in the queue; anything else is done with.
          status: retryable ? "QUEUED" : "FAILED",
          providerId: usedProviderId,
          lockedAt: null,
          lockedBy: null,
          error: result?.ok === false ? result.error : "No provider accepted it.",
        },
      });
      failed += 1;
    }
  }

  return { claimed: claimed.length, sent, failed };
}
