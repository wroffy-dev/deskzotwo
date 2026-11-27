import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readFileSync } from "node:fs";
import path from "node:path";
import { Reader, type AsnResponse } from "mmdb-lib";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { notifyUser } from "@/lib/notify";
import { emitEvent } from "@/lib/automate/events";
import { leadFacts } from "@/lib/automate/emit-leads";
import { refreshLeadScoreQuietly } from "@/lib/leads/score-store";
import { contactAccess } from "@/lib/authz/access";
import { STILL_THERE } from "@/lib/contacts/left";
import { leadPath, companyPath } from "@/lib/record-links";
import { currentKeys } from "@/lib/tenancy/keys";
import { deviceFromUserAgent, locationFromHeaders, validLanguage, validZone } from "@/lib/inbox/visitor";
import {
  ALERT_EVERY_MS,
  INVITE_LASTS_MS,
  KEEP_IP_DAYS,
  KEEP_PAGES_DAYS,
  NEW_VISIT_MS,
  cleanPage,
  type CleanPage,
  deviceKind,
  isBot,
  isKeyPage,
  journeyOf,
  networkKind,
  pageSeconds,
  referrerHost,
  screenSize,
  validVisitorId,
} from "@/lib/inbox/activity-rules";

/**
 * Website activity (owner, 6 Nov 2026): part of the Customer inbox's website chat, switched on channel by channel.
 * The bubble's script reports the pages of a visitor who agreed (src/lib/inbox/widget-script.ts); they stay anonymous
 * until they chat, send a form or click a campaign email, and then their visits are on their lead.
 *
 * Who somebody is isn't copied around: a chat links the visitor to the conversation, and the contact is the
 * conversation's — so linking or unlinking a conversation in the inbox is right here too, with nothing to keep in step.
 *
 * ISP and network come from a database on this server (DB-IP's ASN Lite, CC BY 4.0, via @ip-location-db): a visitor's
 * address is never sent to anybody to look up. City and country are Cloudflare's headers.
 */

const digest = (id: string) => createHash("sha256").update(id).digest("hex");

/** The network lookup, opened once; null when the file can't be read — a page view never fails for it. */
let networks: Reader<AsnResponse> | null | undefined;
function networkReader(): Reader<AsnResponse> | null {
  if (networks !== undefined) return networks;
  try {
    networks = new Reader<AsnResponse>(readFileSync(path.join(process.cwd(), "node_modules", "@ip-location-db", "dbip-asn-mmdb", "dbip-asn.mmdb")));
  } catch (err) {
    console.error("[activity] the network database couldn't be read", err instanceof Error ? err.message : "");
    networks = null;
  }
  return networks;
}

/** Who runs the network an address is on: "Reliance Jio Infocomm Limited". */
export function ispOf(ip: string | null): string | null {
  if (!ip) return null;
  try {
    return networkReader()?.get(ip)?.autonomous_system_organization?.slice(0, 200) ?? null;
  } catch {
    return null;
  }
}

/** For check scripts: a stand-in for reading the network file. */
export function setTestNetworks(reader: Reader<AsnResponse> | null): void {
  networks = reader;
}

// ─── The campaign email's link ────────────────────────────────────────────────────────────────────

const SIGNATURE_LENGTH = 32;

/** What a campaign link carries to the website: the message and a signature — not its token, which can unsubscribe. */
export async function visitLinkParam(messageId: string): Promise<string> {
  const sig = createHmac("sha256", (await currentKeys()).trackingKey).update(`visit ${messageId}`).digest("hex").slice(0, SIGNATURE_LENGTH);
  return `${messageId}.${sig}`;
}

async function messageOfParam(raw: unknown): Promise<string | null> {
  if (typeof raw !== "string" || raw.length > 120) return null;
  const at = raw.lastIndexOf(".");
  if (at < 1) return null;
  const expected = await visitLinkParam(raw.slice(0, at));
  const a = Buffer.from(raw);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b) ? raw.slice(0, at) : null;
}

/**
 * Whether a campaign link's destination is a site with the bubble on it, seen reporting pages: only those are given
 * the parameter — a link to somebody else's site learns nothing.
 */
export async function siteReportsActivity(host: string): Promise<boolean> {
  try {
    return (await db.webPageView.count({ where: { host: host.toLowerCase() }, take: 1 })) > 0;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

// ─── Recording ────────────────────────────────────────────────────────────────────────────────────

export type ViewInput = {
  visitorId: unknown;
  page: unknown;
  title: unknown;
  referrer: unknown;
  /** The campaign email's parameter, when they came from one. */
  fromEmail: unknown;
  screen: unknown;
  touchPoints: unknown;
  connection: unknown;
  language: unknown;
  timezone: unknown;
  ip: string | null;
  headers: Pick<Headers, "get">;
};

const DAY_MS = 24 * 60 * 60_000;

/**
 * Security audit, 11 Nov 2026 (SEC-34): the most pages one visitor adds in a day, and the most new visitors one
 * address starts on a channel in a day. Past either, the view is left out — the site never hears of it.
 */
export const ACTIVITY_LIMITS = { viewsPerVisitorPerDay: 500, newVisitorsPerAddressPerDay: 200 } as const;

/** One page a visitor who agreed opened. Gives back nothing: a visitor's browser has no use for any of this. */
export async function recordView(channelId: string, input: ViewInput, keyPages: readonly string[]): Promise<boolean> {
  const id = validVisitorId(input.visitorId);
  const page = cleanPage(input.page);
  const userAgent = input.headers.get("user-agent");
  if (!id || !page || isBot(userAgent)) return false;

  const tokenHash = digest(id);
  const now = new Date();
  const where = locationFromHeaders(input.headers);
  const isp = ispOf(input.ip);
  const network = networkKind(isp, input.connection);
  const seenFrom = { ipAddress: input.ip, country: where.country, region: where.region, city: where.city, isp, networkKind: network };
  const described = {
    ...seenFrom,
    deviceKind: deviceKind(userAgent, input.touchPoints),
    browser: deviceFromUserAgent(userAgent),
    screen: screenSize(input.screen),
    language: validLanguage(input.language),
    timezone: validZone(input.timezone),
  };
  const referrerSite = referrerHost(input.referrer, page.host);

  const existing = await db.webVisitor.findUnique({ where: { tokenHash }, select: { id: true, channelId: true, lastSeenAt: true, visits: true } });
  // Another channel's visitor isn't this one's to add to.
  if (existing && existing.channelId !== channelId) return false;
  // Security audit, 11 Nov 2026 (SEC-34): what one browser, and one address, may add in a day — every view is a
  // row in the workspace's database, written for anybody who loads the site.
  const dayAgo = new Date(now.getTime() - DAY_MS);
  if (existing && (await db.webPageView.count({ where: { visitorId: existing.id, at: { gte: dayAgo } } })) >= ACTIVITY_LIMITS.viewsPerVisitorPerDay) return false;
  if (!existing && input.ip && (await db.webVisitor.count({ where: { channelId, ipAddress: input.ip, firstSeenAt: { gte: dayAgo } } })) >= ACTIVITY_LIMITS.newVisitorsPerAddressPerDay) return false;
  const newVisit = !!existing && now.getTime() - existing.lastSeenAt.getTime() > NEW_VISIT_MS;
  const visitNo = existing ? existing.visits + (newVisit ? 1 : 0) : 1;

  const visitor = existing
    ? await db.webVisitor.update({ where: { id: existing.id }, data: { lastSeenAt: now, visits: visitNo, pageCount: { increment: 1 }, ...described } })
    : await db.webVisitor.create({
        data: { channelId, tokenHash, firstSource: page.utmSource ?? referrerSite, firstCampaign: page.utmCampaign, pageCount: 1, firstSeenAt: now, lastSeenAt: now, ...described },
      });

  await db.webPageView.create({
    data: {
      visitorId: visitor.id,
      host: page.host,
      path: page.path,
      title: typeof input.title === "string" ? input.title.trim().slice(0, 200) || null : null,
      referrerHost: referrerSite,
      utmSource: page.utmSource,
      utmMedium: page.utmMedium,
      utmCampaign: page.utmCampaign,
      visitNo,
      at: now,
      ...seenFrom,
    },
  });

  // Came from a campaign email: that's who they are, unless the browser is already somebody's.
  const messageId = await messageOfParam(input.fromEmail);
  if (messageId && !visitor.contactId) {
    const message = await db.marketingMessage.findUnique({ where: { id: messageId }, select: { contactId: true } });
    if (message?.contactId) await db.webVisitor.update({ where: { id: visitor.id }, data: { contactId: message.contactId, identifiedBy: "email", identifiedAt: now } });
  }

  const key = isKeyPage(page.path, keyPages);
  await afterKnownVisit(visitor.id, { page, title: typeof input.title === "string" ? input.title.trim().slice(0, 200) || null : null, key, startsVisit: !existing || newVisit, now }).catch((err) =>
    console.error("[activity] after a visit", err instanceof Error ? err.message : ""),
  );
  return true;
}

/** How long they stayed, once they leave the page — on the newest page of theirs at that path. */
export async function recordLeave(channelId: string, input: { visitorId: unknown; page: unknown; seconds: unknown }): Promise<void> {
  const id = validVisitorId(input.visitorId);
  const page = cleanPage(input.page);
  const seconds = pageSeconds(input.seconds);
  if (!id || !page || seconds === null) return;
  const visitor = await db.webVisitor.findUnique({ where: { tokenHash: digest(id) }, select: { id: true, channelId: true } });
  if (!visitor || visitor.channelId !== channelId) return;
  const view = await db.webPageView.findFirst({ where: { visitorId: visitor.id, path: page.path }, orderBy: { at: "desc" }, select: { id: true } });
  if (view) await db.webPageView.update({ where: { id: view.id }, data: { durationSec: seconds } });
}

/**
 * The token of a conversation somebody on the team started for a visitor. Worked out rather than stored, so nothing
 * that opens a conversation is kept: the visitor's browser gets it once, and from then on it is a chat like any other.
 */
export async function startedChatToken(conversationId: string): Promise<string> {
  return createHmac("sha256", (await currentKeys()).trackingKey).update(`visitor chat ${conversationId}`).digest("base64url");
}

/**
 * The bubble saying it's still here, every 20 seconds while the tab is showing: that's what makes "on the site now"
 * true, and how a chat somebody started reaches them. A write at most once a minute. A `token` is theirs to keep;
 * without one the chat is the one they already have.
 */
export async function pingVisitor(channelId: string, visitorId: unknown, now = new Date()): Promise<{ text: string | null; token: string | null } | null> {
  const id = validVisitorId(visitorId);
  if (!id) return null;
  const visitor = await db.webVisitor.findUnique({ where: { tokenHash: digest(id) }, select: { id: true, channelId: true, lastSeenAt: true, inviteAt: true, inviteConversationId: true, conversationId: true } });
  if (!visitor || visitor.channelId !== channelId) return null;
  const invited = visitor.inviteAt && now.getTime() - visitor.inviteAt.getTime() < INVITE_LASTS_MS;
  if (visitor.inviteAt) await db.webVisitor.update({ where: { id: visitor.id }, data: { inviteAt: null, inviteConversationId: null, lastSeenAt: now } });
  else if (now.getTime() - visitor.lastSeenAt.getTime() > 60_000) await db.webVisitor.update({ where: { id: visitor.id }, data: { lastSeenAt: now } });
  if (!invited) return null;
  const conversationId = visitor.inviteConversationId ?? visitor.conversationId;
  if (!conversationId) return null;
  const said = await db.conversationMessage.findFirst({ where: { conversationId, author: "AGENT" }, orderBy: { createdAt: "desc" }, select: { body: true } });
  return { text: said?.body.slice(0, 200) ?? null, token: visitor.inviteConversationId ? await startedChatToken(visitor.inviteConversationId) : null };
}

/** They changed their mind: everything kept for this browser goes, pages and all. */
export async function forgetVisitor(channelId: string, visitorId: unknown): Promise<void> {
  const id = validVisitorId(visitorId);
  if (id) await db.webVisitor.deleteMany({ where: { tokenHash: digest(id), channelId } });
}

/**
 * Somebody known has been on the site. A new visit or a key page moves their open leads' scores (phase 2, owner,
 * 6 Nov 2026). On a key page, whoever has their open lead or looks after their account is told and a workflow can
 * start ("website.key_page") — once in half a day, however many pages they open. The workflow's data leaves out the IP
 * address and ISP: a workflow can hand what it reads to an outside app.
 */
async function afterKnownVisit(visitorId: string, visit: { page: CleanPage; title: string | null; key: boolean; startsVisit: boolean; now: Date }): Promise<void> {
  if (!visit.key && !visit.startsVisit) return;
  const visitor = await db.webVisitor.findUnique({
    where: { id: visitorId },
    select: { lastAlertAt: true, contactId: true, visits: true, city: true, country: true, deviceKind: true, networkKind: true, conversation: { select: { contactId: true } } },
  });
  const contactId = visitor?.contactId ?? visitor?.conversation?.contactId ?? null;
  if (!visitor || !contactId) return;
  const contact = await db.contact.findFirst({ where: { id: contactId, ...STILL_THERE }, select: { id: true, name: true, company: { select: { id: true, name: true, companySeq: true, ownerUserId: true } } } });
  if (!contact) return;
  const open = { contactId, status: { notIn: ["WON" as const, "LOST" as const, "DISQUALIFIED" as const] } };
  const leads = await db.lead.findMany({ where: open, orderBy: { updatedAt: "desc" }, take: 3, select: { id: true, leadSeq: true, ownerUserId: true } });
  for (const lead of leads) await refreshLeadScoreQuietly(lead.id).catch(() => null);

  if (!visit.key) return;
  if (visitor.lastAlertAt && visit.now.getTime() - visitor.lastAlertAt.getTime() < ALERT_EVERY_MS) return;
  await db.webVisitor.update({ where: { id: visitorId }, data: { lastAlertAt: visit.now } });
  const lead = leads[0];
  const payloadVisit = { path: visit.page.path, title: visit.title, host: visit.page.host, visits: visitor.visits, city: visitor.city, country: visitor.country, device: visitor.deviceKind, network: visitor.networkKind };
  await db.$transaction(async (tx) => {
    const facts = lead ? await leadFacts(tx, lead.id) : null;
    await emitEvent(tx, {
      type: "website.key_page",
      recordType: lead ? "lead" : "contact",
      recordId: lead ? lead.id : contact.id,
      payload: facts ? { ...facts, visit: payloadVisit } : { visit: payloadVisit, lead: null, company: { id: contact.company.id, name: contact.company.name, ownerUserId: contact.company.ownerUserId }, contact: { id: contact.id, name: contact.name } },
    });
  });
  const to = lead?.ownerUserId ?? contact.company.ownerUserId;
  if (to) {
    await notifyUser({
      userId: to,
      type: "WEBSITE_VISIT",
      title: `${contact.name} is on your website`,
      message: `${contact.company.name} — looking at ${visit.page.path}`,
      link: lead ? leadPath(lead.leadSeq) : companyPath(contact.company.companySeq),
    });
  }
}

// ─── Who they are ─────────────────────────────────────────────────────────────────────────────────

/** A chat has started in this browser: the conversation says who they are, now and whenever it's linked. */
export async function linkVisitorToConversation(visitorId: unknown, conversationToken: string): Promise<void> {
  const id = validVisitorId(visitorId);
  if (!id) return;
  const conversation = await db.conversation.findUnique({ where: { visitorTokenHash: digest(conversationToken) }, select: { id: true } });
  if (conversation) await db.webVisitor.updateMany({ where: { tokenHash: digest(id) }, data: { conversationId: conversation.id } });
}

/**
 * A website form sent this browser's id along with the enquiry (the lead capture API's `visitor_id`).
 *
 * Security audit round three, 14 Nov 2026 (low): whoever typed an email into a form became that contact's browser —
 * every later page they opened was shown, and alerted, as the real person's visit — and a visitor already known was
 * re-pointed at whoever was typed last. Now a visitor is linked only while nobody is linked to it yet, and only one
 * seen by an active website chat channel (`channelId`, when the caller knows which). Which contacts may be linked at
 * all is the caller's to decide (src/lib/lead-capture/receive.ts: one this submission made, or one still unconfirmed).
 */
export async function linkVisitorToContact(visitorId: unknown, contactId: string | null | undefined, how: "form", opts: { channelId?: string | null } = {}): Promise<void> {
  const id = validVisitorId(visitorId);
  if (!id || !contactId) return;
  await db.webVisitor.updateMany({
    where: {
      tokenHash: digest(id),
      contactId: null,
      channel: { active: true, kind: "WEB" },
      ...(opts.channelId ? { channelId: opts.channelId } : {}),
    },
    data: { contactId, identifiedBy: how, identifiedAt: new Date() },
  });
}

// ─── Reading ──────────────────────────────────────────────────────────────────────────────────────

const VIEW_SELECT = { id: true, host: true, path: true, title: true, referrerHost: true, utmSource: true, utmCampaign: true, visitNo: true, durationSec: true, ipAddress: true, city: true, region: true, country: true, isp: true, networkKind: true, at: true } as const;
const VISITOR_SELECT = {
  id: true,
  firstSeenAt: true,
  lastSeenAt: true,
  visits: true,
  pageCount: true,
  firstSource: true,
  firstCampaign: true,
  identifiedBy: true,
  ipAddress: true,
  country: true,
  region: true,
  city: true,
  isp: true,
  networkKind: true,
  deviceKind: true,
  browser: true,
  screen: true,
  language: true,
  timezone: true,
  contact: { select: { id: true, name: true, company: { select: { id: true, companySeq: true, name: true } } } },
  conversation: { select: { contact: { select: { id: true, name: true, company: { select: { id: true, companySeq: true, name: true } } } }, customerName: true, customerCompany: true } },
} as const;

/** A lead's visitors, with the journey of the most recent: nothing when the tables aren't there yet. */
export async function activityOfLead(lead: { id: string; contactId: string | null }) {
  try {
    const visitors = await db.webVisitor.findMany({
      where: { OR: [...(lead.contactId ? [{ contactId: lead.contactId }, { conversation: { contactId: lead.contactId } }] : []), { conversation: { leadId: lead.id } }] },
      orderBy: { lastSeenAt: "desc" },
      take: 10,
      select: VISITOR_SELECT,
    });
    if (!visitors.length) return null;
    const views = await db.webPageView.findMany({ where: { visitorId: { in: visitors.map((v) => v.id) } }, orderBy: { at: "desc" }, take: 100, select: { ...VIEW_SELECT, visitorId: true } });
    return { visitors, journey: journeyOf(views.filter((v) => v.visitorId === visitors[0]!.id)), pages: visitors.reduce((t, v) => t + v.pageCount, 0), visits: visitors.reduce((t, v) => t + v.visits, 0) };
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

export type VisitorViewer = { viewerId: string; seesEveryChat: boolean };

/**
 * Which visitors somebody may see. A known visitor shows only to somebody who may view that contact (`contactAccess`), as
 * a lead's card does by its lead's page; an anonymous one is nobody's in particular.
 */
async function visitorReach(viewerId: string) {
  const scope = await contactAccess(viewerId, "view");
  const anonymous = { contactId: null, OR: [{ conversationId: null }, { conversation: { contactId: null } }] };
  // Named outright: an empty relation filter (somebody who sees every contact) doesn't mean "has one".
  const has = Object.keys(scope).length ? { contactId: { not: null }, contact: scope } : { contactId: { not: null } };
  const known = { OR: [has, { conversation: has }] };
  return { known, reach: { OR: [anonymous, known] } };
}

/** The name typed into a chat not yet linked to a contact is for those who see every conversation. */
function asSeenBy<T extends { conversation: { contact: unknown; customerName: string | null; customerCompany: string | null } | null }>(v: T, seesEveryChat: boolean): T {
  return v.conversation && !v.conversation.contact && !seesEveryChat ? { ...v, conversation: { ...v.conversation, customerName: null, customerCompany: null } } : v;
}

/** The inbox's Visitors tab: the latest first, so those on the site now lead, with the page each was last on. */
export async function recentVisitors(params: VisitorViewer & { knownOnly: boolean; take: number }) {
  try {
    const { known, reach } = await visitorReach(params.viewerId);
    const [visitors, total, identified] = await Promise.all([
      db.webVisitor.findMany({ where: params.knownOnly ? known : reach, orderBy: { lastSeenAt: "desc" }, take: params.take, select: { ...VISITOR_SELECT, pageViews: { orderBy: { at: "desc" }, take: 1, select: { path: true } } } }),
      db.webVisitor.count({ where: reach }),
      db.webVisitor.count({ where: known }),
    ]);
    return {
      visitors: visitors.map(({ pageViews, ...v }) => ({ ...asSeenBy(v, params.seesEveryChat), lastPath: pageViews[0]?.path ?? null })),
      total,
      identified,
    };
  } catch (err) {
    if (notMigratedYet(err)) return { visitors: [], total: 0, identified: 0 };
    throw err;
  }
}

/** One visitor and their whole journey, if they're in the viewer's reach, and the open chat they have if any. */
export async function visitorDetail(params: VisitorViewer & { visitorId: string }) {
  try {
    const { reach } = await visitorReach(params.viewerId);
    const visitor = await db.webVisitor.findFirst({ where: { AND: [{ id: params.visitorId }, reach] }, select: { ...VISITOR_SELECT, id: true, conversationId: true, pageViews: { orderBy: { at: "desc" }, take: 100, select: VIEW_SELECT } } });
    if (!visitor) return null;
    const { pageViews, ...v } = visitor;
    return { ...asSeenBy(v, params.seesEveryChat), journey: journeyOf(pageViews) };
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** A conversation's visitor, for the panel beside it — whoever may see the conversation and has "See website activity". */
export async function activityOfConversation(conversationId: string) {
  try {
    const visitor = await db.webVisitor.findFirst({ where: { conversationId }, orderBy: { lastSeenAt: "desc" }, select: { ...VISITOR_SELECT, pageViews: { orderBy: { at: "desc" }, take: 100, select: VIEW_SELECT } } });
    if (!visitor) return null;
    const { pageViews, ...v } = visitor;
    return { ...v, journey: journeyOf(pageViews) };
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** Pages older than a year go, and visitors with them; an IP address goes after 90 days. Run from the marketing heartbeat, once a day. */
export async function sweepWebActivity(now = new Date()): Promise<void> {
  const pages = new Date(now.getTime() - KEEP_PAGES_DAYS * 86_400_000);
  const ip = new Date(now.getTime() - KEEP_IP_DAYS * 86_400_000);
  try {
    await db.webPageView.deleteMany({ where: { at: { lt: pages } } });
    await db.webVisitor.deleteMany({ where: { lastSeenAt: { lt: pages } } });
    await db.webPageView.updateMany({ where: { at: { lt: ip }, ipAddress: { not: null } }, data: { ipAddress: null } });
    await db.webVisitor.updateMany({ where: { lastSeenAt: { lt: ip }, ipAddress: { not: null } }, data: { ipAddress: null } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
}
