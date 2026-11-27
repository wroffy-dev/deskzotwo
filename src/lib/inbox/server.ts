import { createHash, randomBytes } from "node:crypto";
import type { ConversationAuthor, ConversationDelivery, InboxChannel, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { bytesOf, keepBytes, StoredFileMissing } from "@/lib/storage/files";
import { assertRoomFor } from "@/lib/storage/allowance";
import { isStorageFull, keepOrRefuse } from "@/lib/file-refusal";
import { can } from "@/lib/authz/resolve";
import { notifyUser } from "@/lib/notify";
import { tenantKey } from "@/lib/tenancy/cache";
import { listeningIn, publishIn } from "@/lib/chat/bus";
import { intakeLead, type IntakeResult, type LeadPayload } from "@/lib/lead-capture/intake";
import { leadCapacityError } from "@/lib/leads/limits";
import { LeadRuleRefused } from "@/lib/leads/intake-owner";
import { newTicketRefusal, writeTicket } from "@/lib/ticket-open";
import { activeWordFilter } from "@/lib/word-filter/server";
import { formatLeadId } from "@/lib/order-id";
import { emitEvent } from "@/lib/automate/events";
import { currentTenant } from "@/lib/tenancy/resolve";
import { workspaceClock } from "@/lib/time/workspace";
import { aiAnswer } from "@/lib/inbox/ai";
import { knowledgeFor } from "@/lib/inbox/knowledge";
import { INBOX_KNOWLEDGE_CHUNKS } from "@/lib/ai-knowledge/budget";
import { searchKnowledge } from "@/lib/ai-knowledge/search";
import { broadcast, onBroadcast } from "@/lib/cluster/hub";
import { botGreeting, botReply, firstNameOf, typingMs, withName, type BotState, type Known } from "@/lib/inbox/bot";
import { INBOX_LIMITS, channelSettings, conversationRef, detailsMissing, whatsappWindowOpen, withinHours, type ChannelSettings, type InboxKind } from "@/lib/inbox/settings";
import { fetchWhatsAppMedia, markWhatsAppRead, sendWhatsApp, type InboundMedia, type InboundWhatsApp, type WhatsAppStatus } from "@/lib/inbox/whatsapp";
import { countryOfNumber, pagePath, pagesOf, placeText, withPage } from "@/lib/inbox/visitor";
import { TEAM_LIMITS, fileText, ratingOf, replyInText, sendableType } from "@/lib/inbox/team-rules";
import { emailFollowUp } from "@/lib/inbox/follow-up";
import { startedChatToken } from "@/lib/inbox/activity";
import { onSiteNow } from "@/lib/inbox/activity-rules";
import { contactMasker, maskedInLists, type ContactMasker } from "@/lib/contacts/masking";
import { teammate } from "@/lib/ai/teammates-server";

/**
 * The Customer inbox (owner, 24 Oct 2026): every outside conversation in one place — a website's chat
 * bubble with its bot, and WhatsApp, on a shared number or a rep's own. Team chat between colleagues is
 * src/lib/chat and stays apart; email tickets stay in the helpdesk, and a conversation can become one.
 *
 *   · A customer's message is kept, the conversation is linked to the contact on file with that email
 *     or number (and their open lead), and the channel's bot — set answers — takes its turn while it has
 *     the conversation. When it hands over, or a person replies, the bot is done.
 *   · New customers make leads where the channel says so (owner: WhatsApp and bot chats can create
 *     leads): a WhatsApp number on its first message, a website visitor once the bot has their name and
 *     a phone number or email. A person can make one from any conversation.
 *   · Who sees what: a shared channel's conversations, everybody with the inbox; a rep's own number's,
 *     that rep, whoever it is assigned to, and those who see every conversation (`inbox.viewAll`).
 *   · Live: every change is announced on team chat's connection by conversation id only, and each screen
 *     asks again as its own person (src/lib/chat/bus.ts).
 *
 * Whether a person may use the inbox at all is the caller's question (src/actions/inbox.ts); the rules
 * here are about each conversation.
 */

export type InboxViewer = { id: string; viewAll: boolean };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
const CLOSED_LEADS = ["WON", "LOST", "DISQUALIFIED"] as const;
export const NOT_FOUND = "That conversation isn't there, or isn't yours to see.";
/**
 * What the customer's side of the conversation is — never the inbox's own lines or colleagues' notes to
 * each other. Named, not "not SYSTEM or NOTE": a workspace not migrated yet has no NOTE to filter by.
 */
const THE_CUSTOMERS: ConversationAuthor[] = ["CUSTOMER", "AGENT", "BOT"];

/** Conversations this person may read. */
export function visibleWhere(viewer: InboxViewer): Prisma.ConversationWhereInput {
  if (viewer.viewAll) return {};
  return { OR: [{ channel: { is: { ownerUserId: null } } }, { channel: { is: { ownerUserId: viewer.id } } }, { assignedToUserId: viewer.id }] };
}

/** The same rule, for a row already read. */
export function mayRead(viewer: InboxViewer, c: { assignedToUserId: string | null; channel: { ownerUserId: string | null } }): boolean {
  return viewer.viewAll || c.channel.ownerUserId === null || c.channel.ownerUserId === viewer.id || c.assignedToUserId === viewer.id;
}

/**
 * Tells every open screen in the workspace that this conversation changed — its id, and whether a customer
 * just began it, nothing else. Never throws.
 */
export async function announce(conversationId: string, opts: { started?: boolean } = {}): Promise<void> {
  try {
    const tenantId = await tenantKey();
    publishIn(tenantId, listeningIn(tenantId), { type: "inbox", conversationId, ...(opts.started ? { started: true } : {}) });
  } catch {
    // Not live: the screens ask again on their own every little while.
  }
}

// ─── Like a person: pacing, typing, seen (owner, 24 Oct 2026: "like a real human agent talks") ───

let pacing = true;

/** For the checks: no waiting between the bot's messages. */
export function setInboxPacing(on: boolean) {
  pacing = on;
}

const pause = (ms: number) => (pacing && ms > 0 ? new Promise<void>((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

/** How long "typing…" lasts after a staff member's last keystroke. */
const TYPING_MS = 6_000;
/** WhatsApp shows its own "typing…" for up to 25 seconds; asked again no more often than this. */
const WHATSAPP_TYPING_EVERY_MS = 20_000;

type TypingState = {
  typing: Map<string, { name: string; until: number; userId?: string }>;
  /** Who on the team has each conversation open now, so two people don't answer the same customer at once. */
  here: Map<string, Map<string, { name: string; until: number }>>;
  whatsappAt: Map<string, number>;
  /** A website visitor typing: what (only where the channel lets the team peek), until when. Never written down. */
  visitor: Map<string, { text: string | null; until: number }>;
  /** When each conversation's "last seen" was last written, and on which page — so a poll every few seconds writes rarely. */
  seenWrites: Map<string, { at: number; page: string | null }>;
  joined: boolean;
};

/**
 * Who on the team is typing in which conversation, for the website bubble's "Rahul is typing…". In memory,
 * on `globalThis` (a route and the actions are bundled apart), and told to the container's other web
 * processes (src/lib/cluster/hub.ts) — the bubble's next poll may land on any of them.
 */
function typingState(): TypingState {
  const g = globalThis as { [key: symbol]: TypingState | undefined };
  const key = Symbol.for("deskzo.inbox-typing");
  g[key] ??= { typing: new Map(), here: new Map(), whatsappAt: new Map(), visitor: new Map(), seenWrites: new Map(), joined: false };
  const state = g[key]!;
  // Made before the team's tools joined it, in a process that stayed up.
  state.here ??= new Map();
  if (!state.joined) {
    state.joined = true;
    onBroadcast("inbox:typing", (p) => {
      const { id, name, until, userId } = p as { id: string; name: string; until: number; userId?: string };
      state.typing.set(id, { name, until, userId });
    });
    onBroadcast("inbox:here", (p) => {
      const { id, userId, name, until } = p as { id: string; userId: string; name: string; until: number };
      hereIn(state, id).set(userId, { name, until });
    });
    onBroadcast("inbox:visitor-typing", (p) => {
      const { id, text, until } = p as { id: string; text: string | null; until: number };
      state.visitor.set(id, { text, until });
    });
  }
  return state;
}

function hereIn(state: TypingState, conversationId: string) {
  let people = state.here.get(conversationId);
  if (!people) state.here.set(conversationId, (people = new Map()));
  return people;
}

/** How long a visitor's "typing…" lasts after their last keystroke reached us. */
const VISITOR_TYPING_MS = 8_000;

/** The first name of whoever on the team is typing in this conversation now, or null. */
export function typingIn(conversationId: string, now = Date.now()): string | null {
  const t = typingState().typing.get(conversationId);
  return t && t.until > now ? t.name : null;
}

// ─── The workspace's WhatsApp webhook settings ───────────────────────────────────────────────────

/** The row, made on first use with a random verify token. */
export async function inboxSettings() {
  const existing = await db.inboxSettings.findUnique({ where: { id: "global" } });
  if (existing) return existing;
  return db.inboxSettings.upsert({ where: { id: "global" }, create: { id: "global", whatsappVerifyToken: randomBytes(18).toString("base64url") }, update: {} });
}

// ─── Customers on file ───────────────────────────────────────────────────────────────────────────

/** The last ten digits, which is how a number is matched however it was typed. */
const lastDigits = (phone: string | null | undefined) => (phone ?? "").replace(/\D/g, "").slice(-10);

/** A name's words, for telling whether two names are the same person's: "Priya Sharma" → priya, sharma. */
const nameWords = (name: string | null | undefined) => new Set((name ?? "").toLowerCase().split(/[^\p{L}]+/u).filter((w) => w.length >= 2));

/**
 * Whether a number typed into a website chat may stand for somebody already known by it (owner, 25 Oct
 * 2026: a visitor was linked to another person's lead by the same number): only when their names share a
 * word, or when the visitor gave neither a name nor an email to tell them apart. A WhatsApp number is
 * WhatsApp's own check of who it is, so it always may.
 */
export function numberMatches(kind: InboxKind, visitor: { name: string | null; email: string | null }, onFile: { name: string | null }): boolean {
  if (kind === "WHATSAPP") return true;
  if (!visitor.name && !visitor.email) return true;
  const theirs = nameWords(onFile.name);
  return [...nameWords(visitor.name)].some((w) => theirs.has(w));
}

/** A company name's own words, without the ones every company has: "Trevento Media Pvt. Ltd." → trevento, media. */
const companyWords = (name: string | null | undefined) =>
  (name ?? "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((w) => w.length > 0 && !/^(pvt|private|ltd|limited|llp|llc|inc|co|corp|company|the|and|india|opc|plc|gmbh)$/.test(w));

/** Whether a company name a customer typed is this company's: "Trevento" is "Trevento Media Pvt Ltd", "Acme" isn't "Acme Foods" and "Acme Steel" both. */
export function sameCompany(typed: string | null | undefined, onFile: string | null | undefined): boolean {
  const a = companyWords(typed);
  const b = companyWords(onFile);
  if (!a.length || !b.length) return false;
  const [shorter, longer] = a.length <= b.length ? [a, new Set(b)] : [b, new Set(a)];
  return shorter.every((w) => longer.has(w));
}

/** Somebody on file a conversation could be: a contact still at their company. */
export type OnFile = { contactId: string; contactName: string; companyId: string; companyName: string };

/**
 * Everybody on file this customer could be: the contacts with their email, else those with the number
 * they gave (a number typed into a website chat only where the name agrees, `numberMatches`). One a
 * company, oldest first — a person can be a contact at two companies with one number.
 */
async function customersOnFile(kind: InboxKind, visitor: { name: string | null; email: string | null; phone: string | null }): Promise<OnFile[]> {
  let rows: OnFile[] = [];
  if (visitor.email) {
    const byEmail = await db.contact.findMany({
      where: { email: { equals: visitor.email, mode: "insensitive" }, leftAt: null },
      select: { id: true, name: true, companyId: true, company: { select: { name: true } } },
      orderBy: { createdAt: "asc" },
      take: 20,
    });
    rows = byEmail.map((r) => ({ contactId: r.id, contactName: r.name, companyId: r.companyId, companyName: r.company.name }));
  }
  const digits = lastDigits(visitor.phone);
  if (!rows.length && digits.length === 10) {
    const byNumber = await db.$queryRaw<{ id: string; companyId: string; name: string; companyName: string }[]>`
      SELECT c.id, c."companyId", c.name, co.name AS "companyName" FROM contacts c JOIN companies co ON co.id = c."companyId"
       WHERE c."leftAt" IS NULL AND right(regexp_replace(coalesce(c.phone, ''), '[^0-9]', '', 'g'), 10) = ${digits}
       ORDER BY c."createdAt" ASC LIMIT 20`;
    rows = byNumber.filter((r) => numberMatches(kind, visitor, r)).map((r) => ({ contactId: r.id, contactName: r.name, companyId: r.companyId, companyName: r.companyName }));
  }
  const seen = new Set<string>();
  return rows.filter((r) => !seen.has(r.companyId) && !!seen.add(r.companyId));
}

/**
 * Which of them it is (owner, 25 Oct 2026: "one customer with two companies and one number"): the only
 * one; or, among several, the one whose company is the company name they gave. Null when that doesn't
 * settle it — the team chooses (`staffLinkCustomer`) rather than the inbox guessing.
 */
export function pickOnFile(candidates: readonly OnFile[], typedCompany: string | null | undefined): OnFile | null {
  if (candidates.length === 1) return candidates[0]!;
  const named = candidates.filter((c) => sameCompany(typedCompany, c.companyName));
  return named.length === 1 ? named[0]! : null;
}

/** A contact's open lead, if they have one. */
async function openLeadOf(contactId: string): Promise<string | null> {
  return (await db.lead.findFirst({ where: { contactId, status: { notIn: [...CLOSED_LEADS] } }, select: { id: true }, orderBy: { updatedAt: "desc" } }))?.id ?? null;
}

/** What's known of the customer, for finding them on file. */
async function visitorOf(conversationId: string) {
  const c = await db.conversation.findUnique({ where: { id: conversationId }, select: { kind: true, contactId: true, leadId: true, customerName: true, customerEmail: true, customerPhone: true } });
  return c ? { ...c, kind: c.kind as InboxKind, company: await customerCompanyOf(conversationId) } : null;
}

/**
 * Security audit, 11 Nov 2026 (SEC-47): the customers on file by what the channel itself vouches for — the
 * number WhatsApp delivered from. An email or number a website visitor typed (or told the bot, or typed into
 * WhatsApp) is only what they typed: anybody can type a customer's email. Those are never linked on their
 * own; they show the team as "could be", unchecked, to confirm (`undecided`, `staffLinkCustomer`).
 */
async function vouchedOnFile(c: { kind: InboxKind; customerName: string | null; customerPhone: string | null }): Promise<OnFile[]> {
  if (c.kind !== "WHATSAPP" || !c.customerPhone) return [];
  return customersOnFile(c.kind, { name: c.customerName, email: null, phone: c.customerPhone });
}

/** Links a conversation to the customer on file, once — never over a link a person made, never by a guess, never on typed details (SEC-47). */
export async function linkCustomer(conversationId: string): Promise<void> {
  const c = await visitorOf(conversationId);
  if (!c || c.contactId) return;
  const found = pickOnFile(await vouchedOnFile(c), c.company);
  if (!found) return;
  await db.conversation.update({ where: { id: conversationId }, data: { contactId: found.contactId, companyId: found.companyId, leadId: c.leadId ?? (await openLeadOf(found.contactId)) } });
}

/**
 * Unlinked, with customers on file it could be: the team chooses, and no lead is made meanwhile. More than one by
 * WhatsApp's number; or any by details the customer only typed (SEC-47) — those are suggestions, never a link.
 */
export async function undecided(conversationId: string): Promise<OnFile[]> {
  const c = await visitorOf(conversationId);
  if (!c || c.contactId) return [];
  const vouched = await vouchedOnFile(c);
  if (vouched.length) return vouched.length > 1 && !pickOnFile(vouched, c.company) ? vouched : [];
  // Typed: the one the company they named picks, else every one it could be — a suggestion either way.
  const typed = await customersOnFile(c.kind, { name: c.customerName, email: c.customerEmail, phone: c.customerPhone });
  const named = typed.length > 1 ? pickOnFile(typed, c.company) : null;
  return named ? [named] : typed;
}

// ─── Leads ───────────────────────────────────────────────────────────────────────────────────────

const KIND_WORD: Record<InboxKind, string> = { WEB: "Website chat", WHATSAPP: "WhatsApp" };

export type LeadMade = { ok: true; leadId: string | null; reference: string | null; contactOnly: boolean } | { ok: false; error: string };

/**
 * A lead for this conversation's customer, through the same intake a website form uses
 * (src/lib/lead-capture/intake.ts): their company and contact found or made, the assignment rules — or
 * `ownerUserId` — deciding whose it is. A conversation that already has one keeps it. Without leads in
 * the plan, the contact is made and linked instead.
 */
export async function makeLead(conversationId: string, by: { ownerUserId: string | null; notify: boolean }): Promise<LeadMade> {
  const c = await db.conversation.findUnique({
    where: { id: conversationId },
    select: { id: true, kind: true, leadId: true, customerName: true, customerEmail: true, customerPhone: true, pageUrl: true, channel: { select: { name: true, createdById: true } }, lead: { select: { leadSeq: true } } },
  });
  if (!c) return { ok: false, error: NOT_FOUND };
  if (c.leadId && c.lead) return { ok: true, leadId: c.leadId, reference: formatLeadId(c.lead.leadSeq), contactOnly: false };
  if (!c.customerEmail && !c.customerPhone) return { ok: false, error: "There's no phone number or email for them yet — ask for one first." };
  const kind = c.kind as InboxKind;
  const name = c.customerName?.trim() || (c.customerPhone ? `${KIND_WORD[kind]} ${c.customerPhone}` : "Website visitor");
  // The lead goes on the company they named; without one, on their own name (owner, 25 Oct 2026).
  const company = (await customerCompanyOf(c.id)) || name;
  const firstWords = await db.conversationMessage.findMany({ where: { conversationId, author: "CUSTOMER" }, orderBy: { createdAt: "asc" }, take: 5, select: { body: true } });
  const payload: LeadPayload = {
    name: name.slice(0, 120),
    company: company.slice(0, 160),
    email: c.customerEmail ?? "",
    phone: (c.customerPhone ?? "").slice(0, 20),
    message: firstWords.map((m) => m.body).join("\n").slice(0, 2000),
    source: kind === "WHATSAPP" ? "WHATSAPP" : "LIVE_CHAT",
    page_url: c.pageUrl && /^https?:\/\//.test(c.pageUrl) ? c.pageUrl.slice(0, 500) : "",
  } as LeadPayload;
  /**
   * Lead limits (owner, 12 Nov 2026 — Phase 4, audit H.6.5): whoever it's for being at their limit leaves the lead with
   * nobody and tells the managers (src/lib/leads/intake-owner.ts). The plan's cap, and a rule that refuses a lead when
   * its people are all full, make nothing — said here in their own words.
   */
  let result: IntakeResult;
  try {
    result = await intakeLead(
      { id: null, name: `${KIND_WORD[kind]} · ${c.channel.name}`, sourceLabel: c.channel.name, createdById: by.ownerUserId ?? c.channel.createdById },
      payload,
      {
        ...(by.ownerUserId ? { ownerUserId: by.ownerUserId } : {}),
        leadTitle: `${KIND_WORD[kind]} — ${company}`.slice(0, 200),
        notifyTitle: `A ${kind === "WHATSAPP" ? "WhatsApp" : "website chat"} lead was assigned to you`,
        notify: by.notify,
        path: "inbox",
      },
    );
  } catch (err) {
    const full = leadCapacityError(err);
    if (full) return { ok: false, error: full.message };
    if (err instanceof LeadRuleRefused) return { ok: false, error: err.message };
    throw err;
  }
  if (result.status === "reseller") return { ok: false, error: "This customer is a reseller's, so the enquiry went to the reseller's account manager instead." };
  if (result.status === "contact") {
    await db.conversation.update({ where: { id: conversationId }, data: { contactId: result.contactId, companyId: result.companyId } });
    return { ok: true, leadId: null, reference: null, contactOnly: true };
  }
  const lead = await db.lead.findUnique({ where: { id: result.leadId }, select: { contactId: true, companyId: true } });
  await db.conversation.update({ where: { id: conversationId }, data: { leadId: result.leadId, contactId: lead?.contactId ?? undefined, companyId: lead?.companyId ?? undefined } });
  return { ok: true, leadId: result.leadId, reference: result.reference, contactOnly: false };
}

/** The company they said they're from — read by name on its own: nothing on a workspace not migrated yet. */
async function customerCompanyOf(conversationId: string): Promise<string | null> {
  return (await db.conversation.findUnique({ where: { id: conversationId }, select: { customerCompany: true } }).catch(() => null))?.customerCompany ?? null;
}

/** Keeps the company they named, once — never over one already there. Never throws. */
async function keepCompany(conversationId: string, company: string | null | undefined): Promise<void> {
  const value = company?.replace(/\s+/g, " ").trim().slice(0, 160);
  if (!value) return;
  await db.conversation.updateMany({ where: { id: conversationId, customerCompany: null }, data: { customerCompany: value } }).catch(() => {});
}

/** The channel's own rule for a new customer: a lead once there's somebody to put it on. Never throws. */
async function autoLead(conversationId: string, settings: ChannelSettings, ownerUserId: string | null): Promise<void> {
  if (!settings.autoLead) return;
  const c = await db.conversation.findUnique({ where: { id: conversationId }, select: { contactId: true, leadId: true, customerName: true, customerEmail: true, customerPhone: true, kind: true } });
  if (!c || c.contactId || c.leadId) return;
  // Once the details the channel waits for are in (Settings › Customer inbox) — and, whatever it says, some way to reach them.
  if (detailsMissing(settings.leadNeeds, { name: c.customerName, company: await customerCompanyOf(conversationId), email: c.customerEmail, phone: c.customerPhone }).length) return;
  if (!c.customerEmail && !c.customerPhone) return;
  // On file for more than one customer and not yet settled: a new lead would make a duplicate — the team chooses first.
  if ((await undecided(conversationId)).length) return;
  await makeLead(conversationId, { ownerUserId, notify: true }).catch((err) => console.error("[inbox] a lead couldn't be made", err instanceof Error ? err.message : err));
}

// ─── Messages ────────────────────────────────────────────────────────────────────────────────────

/** A file kept here from the start — one a website visitor sent, or one the team sent. */
export type KeptFile = { bytes: Buffer; mime: string; name: string | null };

export async function addMessage(
  conversationId: string,
  author: ConversationAuthor,
  body: string,
  extra: { userId?: string | null; externalId?: string | null; templateName?: string | null; delivery?: ConversationDelivery | null; error?: string | null; at?: Date; media?: InboundMedia | null; file?: KeptFile | null } = {},
) {
  // Checked by the caller on the file itself; kept in the storage box when one is set up, the row holding a reference.
  // The callers ask for room first (`roomForFile`); should the workspace's storage fill in between — a WhatsApp file
  // already gone to the customer — the message is still written, without its copy, saying so (src/lib/file-refusal.ts).
  let stored: Uint8Array<ArrayBuffer> | null = null;
  let file = extra.file ?? null;
  if (file) {
    try {
      stored = await keepBytes("inbox-files", file.bytes, file.mime);
    } catch (err) {
      if (!isStorageFull(err)) throw err;
      console.warn(`[inbox] a file in a conversation wasn't kept: ${err.message}`);
      body = `${body} (not kept here — the workspace's storage is full)`;
      file = null;
    }
  }
  return db.conversationMessage.create({
    data: {
      conversationId,
      author,
      body: body.slice(0, INBOX_LIMITS.message * 2),
      userId: extra.userId ?? null,
      externalId: extra.externalId ?? null,
      templateName: extra.templateName ?? null,
      delivery: extra.delivery ?? null,
      error: extra.error ?? null,
      ...(extra.media ? { mediaId: extra.media.id, mediaMime: extra.media.mime, mediaName: extra.media.name } : {}),
      ...(file && stored
        ? { mediaMime: file.mime, mediaName: file.name, file: { create: { mime: file.mime, name: file.name, size: file.bytes.length, bytes: stored } } }
        : {}),
      ...(extra.at ? { createdAt: extra.at } : {}),
    },
    select: { id: true, createdAt: true },
  });
}

const FILES_OFF_FOR_CUSTOMERS = "This chat doesn't take files. Please describe it in a message instead.";

/** Room in the workspace's storage for a file of `size` bytes, or its words why not (src/lib/file-refusal.ts). */
async function roomForFile(size: number): Promise<{ ok: true } | { ok: false; error: string }> {
  const room = await keepOrRefuse(() => assertRoomFor(size));
  return room.ok ? { ok: true } : room;
}
const FILES_OFF_FOR_TEAM = "Sending files is switched off for this channel (Settings › Customer inbox).";

/** A file somebody sent, checked: one of the kinds anybody may send, under 5 MB. The type it goes as, or why not. */
export function checkFile(file: { bytes: Buffer; mime: string; name: string | null }): { ok: true; mime: string; name: string } | { ok: false; error: string } {
  if (!file.bytes.length) return { ok: false, error: "That file is empty." };
  if (file.bytes.length > TEAM_LIMITS.file) return { ok: false, error: "Files can be up to 5 MB." };
  const name = (file.name ?? "").replace(/[\\/\r\n\t"]/g, "_").trim().slice(0, 120) || "file";
  const mime = sendableType(file.mime, name);
  if (!mime) return { ok: false, error: "Send a photo, a PDF, or a Word, Excel or text file." };
  return { ok: true, mime, name };
}

// ─── Workflows, office hours, round-robin ────────────────────────────────────────────────────────

/** For Deskzo Automate: a conversation started, or needs a person (src/lib/automate/triggers.ts). Never throws. */
async function emitConversation(type: "conversation.started" | "conversation.needs_person", conversationId: string): Promise<void> {
  try {
    const c = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { id: true, seq: true, kind: true, customerName: true, customerPhone: true, customerEmail: true, pageUrl: true, assignedToUserId: true, companyId: true, contactId: true, leadId: true, channel: { select: { id: true, name: true } } },
    });
    if (!c) return;
    const first = await db.conversationMessage.findFirst({ where: { conversationId, author: "CUSTOMER" }, orderBy: { createdAt: "asc" }, select: { body: true } });
    await db.$transaction((tx) =>
      emitEvent(tx, {
        type,
        recordType: "conversation",
        recordId: c.id,
        payload: {
          conversation: {
            id: c.id,
            ref: conversationRef(c.seq),
            channel: c.channel.name,
            channelId: c.channel.id,
            kind: c.kind,
            customerName: c.customerName,
            customerPhone: c.customerPhone,
            customerEmail: c.customerEmail,
            firstMessage: first?.body.slice(0, 500) ?? null,
            pageUrl: c.pageUrl,
            assignedToUserId: c.assignedToUserId,
          },
          companyId: c.companyId,
          contactId: c.contactId,
          leadId: c.leadId,
        },
      }),
    );
  } catch (err) {
    console.error(`[inbox] the ${type} event wasn't recorded`, err instanceof Error ? err.message : err);
  }
}

/** Whether the channel's team is in now, by its office hours and the workspace's clock. */
async function teamIn(settings: ChannelSettings, now: Date): Promise<boolean> {
  if (!settings.hours.on) return true;
  return withinHours(settings.hours, (await workspaceClock()).parts(now));
}

const AWAY_EVERY_MS = 12 * 60 * 60 * 1000;

/** In Deskzo within this long counts as here, for round-robin. Every open screen says so every minute or so. */
export const ACTIVE_MS = 10 * 60_000;

/**
 * Of these people, those taking conversations now (owner, 24 Oct 2026): not switched to away, and in
 * Deskzo within the last ten minutes. All of them on a workspace that can't tell yet (not migrated).
 */
export async function availableOf(ids: readonly string[], now = Date.now()): Promise<string[]> {
  const rows = await db.inboxAgentStatus.findMany({ where: { userId: { in: [...ids] } }, select: { userId: true, status: true, lastActiveAt: true } }).catch(() => null);
  if (!rows) return [...ids];
  const here = new Set(rows.filter((r) => r.status === "ONLINE" && now - r.lastActiveAt.getTime() < ACTIVE_MS).map((r) => r.userId));
  return ids.filter((id) => here.has(id));
}

/**
 * The next person in turn for a shared channel set to round-robin: after whoever was given the last one,
 * among the channel's people (or everybody who answers), skipping anybody switched off, without the
 * inbox, away, or not in Deskzo now. Null when there's nobody — it waits in the queue.
 */
async function nextInTurn(channel: { id: string; lastAssignedUserId: string | null }, settings: ChannelSettings): Promise<string | null> {
  const named = settings.assign.people;
  const candidates = await db.user.findMany({ where: { active: true, ...(named.length ? { id: { in: named } } : {}) }, select: { id: true, name: true }, orderBy: [{ name: "asc" }, { id: "asc" }] });
  const ordered = named.length ? named.map((id) => candidates.find((u) => u.id === id)).filter((u): u is { id: string; name: string } => !!u) : candidates;
  const eligible: string[] = [];
  for (const u of ordered) if (await can(u.id, "inbox.view")) eligible.push(u.id);
  const available = new Set(await availableOf(eligible));
  if (!available.size) return null;
  // The turn keeps its order among everybody; whoever isn't here is passed over this time.
  const after = channel.lastAssignedUserId ? eligible.indexOf(channel.lastAssignedUserId) : -1;
  for (let i = 1; i <= eligible.length; i += 1) {
    const next = eligible[(after + i) % eligible.length]!;
    if (available.has(next)) return next;
  }
  return null;
}

/** Gives an unassigned conversation on a round-robin channel to whoever's turn it is, and tells them. */
async function assignInTurn(conversationId: string, channel: InboxChannel, settings: ChannelSettings): Promise<void> {
  if (settings.assign.mode !== "rotate" || channel.ownerUserId) return;
  const c = await db.conversation.findUnique({ where: { id: conversationId }, select: { seq: true, assignedToUserId: true, customerName: true, customerPhone: true } });
  if (!c || c.assignedToUserId) return;
  const fresh = await db.inboxChannel.findUnique({ where: { id: channel.id }, select: { id: true, lastAssignedUserId: true } });
  const next = fresh ? await nextInTurn(fresh, settings) : null;
  if (!next) return;
  // Only if nobody took it meanwhile, and the turn moves on with it.
  const taken = await db.conversation.updateMany({ where: { id: conversationId, assignedToUserId: null }, data: { assignedToUserId: next } });
  if (!taken.count) return;
  await db.inboxChannel.update({ where: { id: channel.id }, data: { lastAssignedUserId: next } });
  const person = await db.user.findUnique({ where: { id: next }, select: { name: true } });
  await addMessage(conversationId, "SYSTEM", `Given to ${person?.name ?? "the next person"} in turn`);
  await notifyUser({
    userId: next,
    type: "INBOX_MESSAGE",
    title: `It's your turn: ${c.customerName || c.customerPhone || "a website visitor"} needs a person`,
    message: conversationRef(c.seq),
    link: `/inbox?c=${conversationRef(c.seq)}`,
  });
}

/** The workspace's name, for the AI to say who it speaks for. */
async function businessName(): Promise<string> {
  try {
    return (await currentTenant()).name || "the business";
  } catch {
    return "the business";
  }
}

/** Sends the bot's words: on WhatsApp through Meta, then kept; on a website, kept for the bubble to fetch. */
async function botSays(conversation: { id: string; kind: InboxKind; waId: string | null }, channel: Pick<InboxChannel, "phoneNumberId">, text: string): Promise<void> {
  if (conversation.kind === "WHATSAPP") {
    const sent = channel.phoneNumberId && conversation.waId ? await sendWhatsApp({ phoneNumberId: channel.phoneNumberId, to: conversation.waId, text }) : { ok: false as const, error: "No number to send from." };
    await addMessage(conversation.id, "BOT", text, sent.ok ? { externalId: sent.id, delivery: "SENT" } : { delivery: "FAILED", error: sent.error });
    return;
  }
  await addMessage(conversation.id, "BOT", text);
}

/**
 * Security audit, 11 Nov 2026 (SEC-46): a website visitor spends the workspace's AI credits each time the bot asks
 * Deskzo AI, so it asks within limits — at most `perConversation` bot messages into one conversation, and
 * `perWorkspacePerDay` AI answers across the workspace (counted in this process, which serves every workspace).
 * Past either, the bot hands over to a person as it does when the AI can't answer.
 */
export const BOT_AI_LIMITS = { perConversation: 20, perWorkspacePerDay: 500 } as const;
const botAiDays = new Map<string, { day: number; count: number }>();

export async function botMayUseAi(conversationId: string, now = Date.now()): Promise<boolean> {
  const said = await db.conversationMessage.count({ where: { conversationId, author: "BOT" } });
  if (said >= BOT_AI_LIMITS.perConversation) return false;
  const workspace = await tenantKey().catch(() => "-");
  const day = Math.floor(now / 86_400_000);
  const used = botAiDays.get(workspace);
  const count = used && used.day === day ? used.count : 0;
  if (count >= BOT_AI_LIMITS.perWorkspacePerDay) return false;
  botAiDays.set(workspace, { day, count: count + 1 });
  return true;
}

/** For the checks: the workspace day counts start again. */
export function resetBotAiDays() {
  botAiDays.clear();
}

/**
 * After a customer's message is kept: the conversation reopens and moves up, the customer is linked to
 * what's on file, the bot takes its turn while it has the conversation (Deskzo AI answering what the set
 * answers don't, where the channel lets it), a lead is made where the channel says so, and — once the
 * customer needs a person — they're told if the team is out, it goes to whoever's turn it is, and the
 * workflows hear of it. Whoever needs telling is told.
 */
async function afterCustomerMessage(conversationId: string, text: string, at: Date, opts: { first: boolean; externalId?: string | null; file?: boolean }): Promise<void> {
  const previous = await db.conversation.findUniqueOrThrow({ where: { id: conversationId }, select: { lastCustomerAt: true } });
  await db.conversation.update({ where: { id: conversationId }, data: { lastMessageAt: at, lastCustomerAt: at, status: "OPEN", closedAt: null } });
  await linkCustomer(conversationId);

  const c = await db.conversation.findUniqueOrThrow({
    where: { id: conversationId },
    select: { id: true, kind: true, waId: true, botActive: true, botState: true, customerName: true, customerEmail: true, customerPhone: true, assignedToUserId: true, awayNoticeAt: true, channel: true },
  });
  const settings = channelSettings(c.channel.settings, c.kind as InboxKind);
  const kind = c.kind as InboxKind;
  const now = new Date();
  // A conversation that starts without the bot needs a person from its first message; one with it, once it hands over.
  let needsPerson = opts.first && !(c.botActive && settings.bot.on);
  let botStillOn = false;

  if (opts.file && c.botActive && settings.bot.on) {
    // A file is for a person to look at: the bot steps aside without a word.
    needsPerson = true;
    await db.conversation.update({ where: { id: c.id }, data: { botActive: false } });
  } else if (c.botActive && settings.bot.on) {
    const known: Known = { name: c.customerName, email: c.customerEmail, phone: c.customerPhone, company: await customerCompanyOf(c.id) };
    const priorState = (c.botState as BotState | null) ?? null;
    // The conversation and how far into it choose the bot's words, so it never says the same line twice running.
    const seed = `${c.id}:${await db.conversationMessage.count({ where: { conversationId: c.id } })}`;
    let turn = botReply({ text, settings, state: priorState, known, kind, seed });
    // No set answer fitted: Deskzo AI answers instead where the channel lets it, and hands over when it can't.
    if (turn.reason === "unknown" && settings.bot.ai.on && (await botMayUseAi(c.id))) {
      const recent = await db.conversationMessage.findMany({ where: { conversationId: c.id, author: { in: THE_CUSTOMERS } }, orderBy: { createdAt: "desc" }, take: 12, select: { author: true, body: true } });
      recent.reverse();
      // What the business's own website and — where the channel ticks "Use AI Knowledge" — its AI Knowledge files say
      // about it (the best 3 chunks): the customer's last two messages are the question. Either failing is nothing found.
      // Only the files ticked "Website chat may use this" are searched — the answer goes to somebody outside the
      // company, and the other files may be internal (security audit, 11 Nov 2026 — SEC-46).
      const question = recent.filter((m) => m.author === "CUSTOMER").slice(-2).map((m) => m.body).join(" ");
      const [knowledge, files] = await Promise.all([
        settings.bot.ai.pages.length ? knowledgeFor(c.channel.id, question).catch(() => []) : [],
        settings.bot.ai.knowledge ? searchKnowledge(question, INBOX_KNOWLEDGE_CHUNKS, { forCustomers: true }).catch(() => []) : [],
      ]);
      const ai = await aiAnswer({ settings, business: await businessName(), messages: recent, customerFirstName: firstNameOf(c.customerName), knowledge, files });
      if ("text" in ai) turn = { replies: [ai.text], state: { step: "chatting", answered: priorState?.answered ?? 0 }, handover: false, learned: turn.learned, reason: "answer" };
    }
    needsPerson = needsPerson || turn.handover;
    botStillOn = !turn.handover;
    // The first WhatsApp message gets the greeting first: a website visitor saw it in the bubble already.
    const replies = opts.first && kind === "WHATSAPP" && botGreeting(settings) ? [botGreeting(settings)!, ...turn.replies] : turn.replies;
    // On WhatsApp the bot reads the message (blue ticks), shows "typing…" and takes a moment, as a person would —
    // at most six seconds in all, so the webhook still answers Meta in good time. The website bubble paces itself.
    let paced = 0;
    for (const reply of replies) {
      if (kind === "WHATSAPP" && opts.externalId && c.channel.phoneNumberId) {
        await markWhatsAppRead({ phoneNumberId: c.channel.phoneNumberId, messageId: opts.externalId, typing: true });
        const wait = Math.min(typingMs(reply), Math.max(0, 6_000 - paced));
        paced += wait;
        await pause(wait);
      }
      await botSays({ id: c.id, kind, waId: c.waId }, c.channel, reply);
    }
    await db.conversation.update({
      where: { id: c.id },
      data: {
        botState: turn.state as Prisma.InputJsonValue,
        botActive: !turn.handover,
        lastMessageAt: new Date(),
        ...(turn.learned.name && !c.customerName ? { customerName: turn.learned.name.slice(0, INBOX_LIMITS.name) } : {}),
        ...(turn.learned.email && !c.customerEmail ? { customerEmail: turn.learned.email.slice(0, 200) } : {}),
        ...(turn.learned.phone && !c.customerPhone ? { customerPhone: turn.learned.phone.slice(0, 20) } : {}),
      },
    });
    if (turn.learned.email || turn.learned.phone) await linkCustomer(c.id);
    await keepCompany(c.id, turn.learned.company);
  }

  await autoLead(c.id, settings, c.channel.ownerUserId);

  // Waiting on a person outside office hours, with nobody from the team in the last half hour: told when
  // they'll hear back — once in twelve hours, not every message.
  if (!botStillOn && !(await teamIn(settings, now)) && (!c.awayNoticeAt || now.getTime() - c.awayNoticeAt.getTime() > AWAY_EVERY_MS)) {
    const recentReply = await db.conversationMessage.findFirst({ where: { conversationId: c.id, author: "AGENT", createdAt: { gt: new Date(now.getTime() - 30 * 60_000) } }, select: { id: true } });
    if (!recentReply) {
      const known = await db.conversation.findUnique({ where: { id: c.id }, select: { customerName: true } });
      await botSays({ id: c.id, kind, waId: c.waId }, c.channel, withName(settings.hours.away, firstNameOf(known?.customerName)));
      await db.conversation.update({ where: { id: c.id }, data: { awayNoticeAt: now } });
    }
  }

  let justAssigned = false;
  if (needsPerson) {
    // When response times start (src/lib/inbox/report.ts). Written on its own: a workspace not migrated yet
    // loses only this, never the message.
    await db.conversation.updateMany({ where: { id: c.id, needsPersonAt: null }, data: { needsPersonAt: at } }).catch(() => {});
    const before = c.assignedToUserId;
    await assignInTurn(c.id, c.channel, settings);
    justAssigned = !before && !!(await db.conversation.findUnique({ where: { id: c.id }, select: { assignedToUserId: true } }))?.assignedToUserId;
  }
  if (opts.first) await emitConversation("conversation.started", c.id);
  if (needsPerson) await emitConversation("conversation.needs_person", c.id);

  // Told: a rep, of a new conversation on their own number; whoever it's assigned to, when it wasn't waiting on them already.
  const ref = await db.conversation.findUniqueOrThrow({ where: { id: c.id }, select: { seq: true, customerName: true, customerPhone: true, assignedToUserId: true } });
  const who = ref.customerName || ref.customerPhone || "A website visitor";
  const link = `/inbox?c=${conversationRef(ref.seq)}`;
  const tell = new Set<string>();
  if (opts.first && c.channel.ownerUserId) tell.add(c.channel.ownerUserId);
  if (ref.assignedToUserId && !opts.first && !justAssigned) {
    const read = await db.conversationRead.findUnique({ where: { conversationId_userId: { conversationId: c.id, userId: ref.assignedToUserId } }, select: { readAt: true } });
    if (!previous.lastCustomerAt || !read || read.readAt >= previous.lastCustomerAt) tell.add(ref.assignedToUserId);
  }
  for (const userId of tell) {
    await notifyUser({ userId, type: "INBOX_MESSAGE", title: `${who} wrote on ${KIND_WORD[kind]}`, message: conversationRef(ref.seq), link });
  }
  await announce(c.id, { started: opts.first });
}

/** Whether a new conversation should chime for this person: one they may see, begun in the last few minutes. */
export async function chimesFor(viewer: InboxViewer, id: string, now = Date.now()): Promise<boolean> {
  const c = await db.conversation.findUnique({ where: { id }, select: { createdAt: true, assignedToUserId: true, channel: { select: { ownerUserId: true } } } });
  return !!c && mayRead(viewer, c) && now - c.createdAt.getTime() < 5 * 60_000;
}

// ─── A website's bubble ──────────────────────────────────────────────────────────────────────────

export type WebMessage = {
  id: string;
  from: "you" | "bot" | "agent";
  name: string | null;
  body: string;
  at: string;
  /** A file in it, fetched by the bubble with the visitor's token (`visitorFile`). */
  file: { name: string | null; mime: string; image: boolean } | null;
};

/** A website channel by its public key, while it's switched on. */
export async function webChannel(publicKey: string) {
  if (!publicKey || publicKey.length > 64) return null;
  return db.inboxChannel.findFirst({ where: { publicKey, kind: "WEB", active: true } });
}

/** The visitor's conversation on this channel, by the token their browser keeps. */
async function visitorConversation(channelId: string, token: string | null | undefined) {
  if (!token || token.length < 20 || token.length > 100) return null;
  return db.conversation.findFirst({ where: { visitorTokenHash: sha256(token), channelId }, select: { id: true } });
}

/**
 * Whether the team blocked this website visitor (by their token's digest) or WhatsApp number: their
 * messages go nowhere. Nobody is, on a workspace not migrated yet.
 */
export async function isBlocked(kind: InboxKind, value: string | null | undefined): Promise<boolean> {
  if (!value) return false;
  return !!(await db.inboxBlock.findUnique({ where: { kind_value: { kind, value } }, select: { id: true } }).catch(() => null));
}

/** The website visitor with this token, blocked by the team. */
export const visitorBlocked = (token: string | null | undefined) => (token && token.length >= 20 && token.length <= 100 ? isBlocked("WEB", sha256(token)) : Promise.resolve(false));

/** A website visitor's message: their conversation found by token, or a new one (and a token for it). */
export async function receiveWebMessage(
  channel: InboxChannel,
  input: { token?: string | null; text: string; name?: string | null; company?: string | null; email?: string | null; phone?: string | null; opener?: string | null; pageUrl?: string | null; visitor?: VisitorInfo },
): Promise<{ token: string; conversationId: string }> {
  const text = input.text.replace(/\r\n?/g, "\n").trim().slice(0, INBOX_LIMITS.message);
  const settings = channelSettings(channel.settings, "WEB");
  const now = new Date();
  let token = input.token ?? null;
  let existing = await visitorConversation(channel.id, token);
  let first = false;
  if (!existing) {
    token = randomBytes(24).toString("base64url");
    const created = await db.conversation.create({
      data: {
        channelId: channel.id,
        kind: "WEB",
        visitorTokenHash: sha256(token),
        botActive: settings.bot.on,
        customerName: input.name?.trim().slice(0, INBOX_LIMITS.name) || null,
        customerEmail: input.email?.trim().toLowerCase().slice(0, 200) || null,
        customerPhone: input.phone?.trim().slice(0, 20) || null,
        pageUrl: input.pageUrl?.slice(0, 500) || null,
        lastMessageAt: now,
      },
      select: { id: true },
    });
    // The company from the form before the chat — written on its own, so an unmigrated workspace loses only this.
    await keepCompany(created.id, input.company);
    const greeting = botGreeting(settings);
    if (greeting) await addMessage(created.id, "BOT", greeting, { at: new Date(now.getTime() - 2) });
    // The message the bubble opened with on its own — one of the channel's, never words the visitor's browser made up.
    const opener = input.opener?.trim();
    if (opener && settings.proactive.some((p) => p.message === opener)) await addMessage(created.id, "BOT", opener, { at: new Date(now.getTime() - 1) });
    existing = created;
    first = true;
  }
  // They've sent it: no longer typing.
  const state = typingState();
  if (state.visitor.has(existing.id)) {
    state.visitor.delete(existing.id);
    broadcast("inbox:visitor-typing", { id: existing.id, text: null, until: 0 });
  }
  const filter = await activeWordFilter("TICKETS");
  await addMessage(existing.id, "CUSTOMER", filter ? filter.mask(text) : text, { at: now });
  await afterCustomerMessage(existing.id, text, now, { first });
  // Where they are and what they're using, the first time; the page they're on, every time.
  state.seenWrites.delete(existing.id);
  await seenConversation(existing.id, { ...input.visitor, page: input.pageUrl ?? input.visitor?.page ?? null }, now);
  return { token: token!, conversationId: existing.id };
}

/** What the bubble shows: the conversation's messages after `after`, without staff's notes to each other. */
export async function webMessages(channelId: string, token: string, after?: string | null): Promise<WebMessage[] | null> {
  const c = await visitorConversation(channelId, token);
  if (!c) return null;
  const since = after ? new Date(after) : null;
  const [rows, channel] = await Promise.all([
    db.conversationMessage.findMany({
      where: { conversationId: c.id, author: { in: THE_CUSTOMERS }, ...(since && !Number.isNaN(since.getTime()) ? { createdAt: { gt: since } } : {}) },
      orderBy: { createdAt: "asc" },
      take: 200,
      select: { id: true, author: true, body: true, createdAt: true, mediaMime: true, mediaName: true, user: { select: { name: true } } },
    }),
    db.inboxChannel.findUnique({ where: { id: channelId }, select: { settings: true } }),
  ]);
  const assistant = channelSettings(channel?.settings, "WEB").bot.name.trim() || null;
  return rows.map((m) => ({
    id: m.id,
    from: m.author === "CUSTOMER" ? "you" : m.author === "BOT" ? "bot" : "agent",
    // A first name only: a visitor learns who is helping them, not the whole team's names. The assistant by its own.
    name: m.author === "AGENT" ? (m.user?.name?.split(/\s+/)[0] ?? null) : m.author === "BOT" ? assistant : null,
    body: m.body,
    at: m.createdAt.toISOString(),
    file: m.mediaMime ? { name: m.mediaName, mime: m.mediaMime, image: m.mediaMime.startsWith("image/") } : null,
  }));
}

/**
 * What the bubble shows besides the messages, as a chat app does: whoever on the team is typing, whether
 * the visitor's last message has been seen by somebody on the team, and — once it's closed — "How did we do?"
 */
export async function webPresence(channelId: string, token: string): Promise<{ typing: string | null; seen: boolean; rate: boolean } | null> {
  const c = await visitorConversation(channelId, token);
  if (!c) return null;
  const row = await db.conversation.findUnique({ where: { id: c.id }, select: { status: true, lastCustomerAt: true, reads: { orderBy: { readAt: "desc" }, take: 1, select: { readAt: true } } } });
  const lastRead = row?.reads[0]?.readAt ?? null;
  // Read by name on its own: a workspace not migrated yet never asks.
  const rating = row?.status === "CLOSED" ? await db.conversation.findUnique({ where: { id: c.id }, select: { ratingAskedAt: true, ratedAt: true } }).catch(() => null) : null;
  return { typing: typingIn(c.id), seen: !!row?.lastCustomerAt && !!lastRead && lastRead >= row.lastCustomerAt, rate: !!rating?.ratingAskedAt && !rating.ratedAt };
}

const REPLY_IN_KEEP_MS = 10 * 60_000;
const replyInCache = new Map<string, { text: string | null; until: number }>();

/**
 * What the bubble says about how soon the team replies ("Usually replies within 15 minutes"), from the
 * channel's first responses in the last fortnight — worked out every ten minutes at most. Null without
 * enough to go on, or on a workspace not migrated yet.
 */
export async function typicalReply(channelId: string, now = Date.now()): Promise<string | null> {
  const key = `${await tenantKey().catch(() => "")}:${channelId}`;
  const kept = replyInCache.get(key);
  if (kept && kept.until > now) return kept.text;
  const rows = await db.conversation
    .findMany({ where: { channelId, needsPersonAt: { gte: new Date(now - 14 * 86_400_000) }, firstResponseAt: { not: null } }, select: { needsPersonAt: true, firstResponseAt: true }, orderBy: { needsPersonAt: "desc" }, take: 500 })
    .catch(() => []);
  const waits = rows.map((r) => Math.max(0, r.firstResponseAt!.getTime() - r.needsPersonAt!.getTime())).sort((a, b) => a - b);
  const text = replyInText(waits.length ? waits[Math.ceil(waits.length / 2) - 1]! : null, waits.length);
  replyInCache.set(key, { text, until: now + REPLY_IN_KEEP_MS });
  return text;
}

const RATING_WORD = { GOOD: "👍 Good", BAD: "👎 Not good" } as const;

/** Keeps the customer's rating — once, after they were asked — and tells the team. */
async function keepRating(conversationId: string, rating: "GOOD" | "BAD", comment: string | null, extra: { externalId?: string | null; at?: Date } = {}): Promise<boolean> {
  const now = extra.at ?? new Date();
  const said = comment?.replace(/\s+/g, " ").trim().slice(0, TEAM_LIMITS.ratingComment) || null;
  const kept = await db.conversation
    .updateMany({ where: { id: conversationId, ratingAskedAt: { not: null }, ratedAt: null }, data: { rating, ratingComment: said, ratedAt: now } })
    .catch(() => ({ count: 0 }));
  if (!kept.count) return false;
  await addMessage(conversationId, "SYSTEM", `They rated it ${RATING_WORD[rating]}${said ? ` — “${said}”` : ""}`, { externalId: extra.externalId ?? null, at: now });
  await announce(conversationId);
  return true;
}

/** A website visitor's answer to "How did we do?" in the bubble. False when they weren't asked, or already said. */
export async function rateWeb(channelId: string, token: string, input: { rating: string; comment?: string | null }): Promise<boolean> {
  if (input.rating !== "GOOD" && input.rating !== "BAD") return false;
  const c = await visitorConversation(channelId, token);
  if (!c) return false;
  return keepRating(c.id, input.rating, input.comment ?? null);
}

/** A file in the visitor's own conversation, for their bubble — theirs or one the team sent them. */
export async function visitorFile(channelId: string, token: string, messageId: string): Promise<{ bytes: Buffer; mime: string; name: string | null } | null> {
  const c = await visitorConversation(channelId, token);
  if (!c || !messageId || messageId.length > 40) return null;
  const m = await db.conversationMessage.findFirst({ where: { id: messageId, conversationId: c.id, author: { in: THE_CUSTOMERS } }, select: { file: { select: { bytes: true, mime: true, name: true } } } });
  if (!m?.file) return null;
  // The bytes in the row, or the file in the storage box it points at — one the box has lost is answered as no file.
  const bytes = await keptBytes(m.file.bytes);
  return bytes ? { bytes, mime: m.file.mime, name: m.file.name } : null;
}

/**
 * A file from a website visitor, in a conversation they've begun: kept here, shown to the team at once,
 * and — while the bot has it — for a person to look at. Null for an unknown token; the reason for a file
 * that can't be taken.
 */
/**
 * Security audit, 11 Nov 2026 (SEC-34): what website visitors may store, in files, over a day — in one
 * conversation, and in the whole workspace. Every file is a row in the workspace's own database.
 */
export const VISITOR_FILE_BUDGET = { perConversationPerDay: 25 * 1024 * 1024, perWorkspacePerDay: 300 * 1024 * 1024 } as const;

/** Why one more visitor file of `size` bytes is refused, or null when it fits both budgets. */
export async function visitorFileBudgetRefusal(conversationId: string, size: number, now = new Date()): Promise<string | null> {
  const since = new Date(now.getTime() - 24 * 60 * 60_000);
  const fromCustomers = { createdAt: { gte: since }, message: { author: "CUSTOMER" as const } };
  const [mine, all] = await Promise.all([
    db.conversationFile.aggregate({ where: { ...fromCustomers, message: { author: "CUSTOMER", conversationId } }, _sum: { size: true } }),
    db.conversationFile.aggregate({ where: fromCustomers, _sum: { size: true } }),
  ]);
  if ((mine._sum.size ?? 0) + size > VISITOR_FILE_BUDGET.perConversationPerDay) return "That's as many files as this chat takes today. Please describe the rest in a message.";
  if ((all._sum.size ?? 0) + size > VISITOR_FILE_BUDGET.perWorkspacePerDay) return "This chat can't take more files just now. Please describe it in a message instead.";
  return null;
}

export async function receiveWebFile(channel: InboxChannel, token: string, input: KeptFile & { caption?: string | null }): Promise<{ ok: true; conversationId: string } | { ok: false; error: string } | null> {
  const c = await visitorConversation(channel.id, token);
  if (!c) return null;
  if (!channelSettings(channel.settings, "WEB").files.customers) return { ok: false, error: FILES_OFF_FOR_CUSTOMERS };
  const checked = checkFile(input);
  if (!checked.ok) return checked;
  const over = await visitorFileBudgetRefusal(c.id, input.bytes.length);
  if (over) return { ok: false, error: over };
  // Out of storage: the visitor is told as they are for the day's allowance — the workspace's billing isn't theirs.
  if (!(await roomForFile(input.bytes.length)).ok) return { ok: false, error: "This chat can't take more files just now. Please describe it in a message instead." };
  const filter = await activeWordFilter("TICKETS");
  const caption = input.caption?.trim().slice(0, 500) || null;
  const text = fileText(checked.mime, checked.name, caption ? (filter ? filter.mask(caption) : caption) : null);
  const now = new Date();
  await addMessage(c.id, "CUSTOMER", text, { at: now, file: { bytes: input.bytes, mime: checked.mime, name: checked.name } });
  await afterCustomerMessage(c.id, text, now, { first: false, file: true });
  return { ok: true, conversationId: c.id };
}

/**
 * A website visitor typing (owner, 24 Oct 2026: "what the customer is typing"): `active` while their keys
 * move, false once they send or clear the box. The draft itself is taken only where the channel lets the
 * team peek, held in memory for a few seconds, and never written down; open screens are told only that
 * something changed, and each asks for it as its own person (`visitorPeek`). False for an unknown token.
 */
export async function visitorTyping(channel: InboxChannel, token: string, input: { active: boolean; text?: string | null }, now = Date.now()): Promise<boolean> {
  const c = await visitorConversation(channel.id, token);
  if (!c) return false;
  const peek = channelSettings(channel.settings, "WEB").peek;
  const entry = { id: c.id, text: input.active && peek && input.text ? input.text.replace(/\s+/g, " ").slice(0, 500) : null, until: input.active ? now + VISITOR_TYPING_MS : 0 };
  typingState().visitor.set(c.id, { text: entry.text, until: entry.until });
  broadcast("inbox:visitor-typing", entry);
  try {
    const tenantId = await tenantKey();
    publishIn(tenantId, listeningIn(tenantId), { type: "inbox-typing", conversationId: c.id });
  } catch {
    // Not live: the screen asks again when it next reloads the conversation.
  }
  return true;
}

/** How long a person counts as having a conversation open after their screen last said so. */
const HERE_MS = 25_000;

export type InboxPeek = {
  /** The customer is typing, and — where the channel lets the team peek — what. */
  typing: boolean;
  text: string | null;
  /** Colleagues with it open now, and whether they're writing a reply (owner, 24 Oct 2026: "Priya is already replying"). */
  others: { name: string; replying: boolean }[];
};

/**
 * What's happening in a conversation this person may see, besides its messages — and that they have it
 * open, for their colleagues' screens. Asked every few seconds while it's open.
 */
export async function visitorPeek(viewer: InboxViewer, id: string, opts: { here?: boolean } = {}, now = Date.now()): Promise<InboxPeek | null> {
  const c = await visibleConversation(viewer, id);
  if (!c) return null;
  const state = typingState();
  const people = hereIn(state, c.id);
  for (const [userId, p] of people) if (p.until <= now) people.delete(userId);
  if (opts.here !== false) {
    const me = await db.user.findUnique({ where: { id: viewer.id }, select: { name: true } });
    const mine = { name: firstNameOf(me?.name) ?? "Somebody", until: now + HERE_MS };
    people.set(viewer.id, mine);
    broadcast("inbox:here", { id: c.id, userId: viewer.id, ...mine });
  }
  const typing = state.typing.get(c.id);
  const replyingId = typing && typing.until > now && typing.userId && typing.userId !== viewer.id ? typing.userId : null;
  const others = [...hereIn(state, c.id).entries()]
    .filter(([userId, p]) => userId !== viewer.id && p.until > now)
    .map(([userId, p]) => ({ name: p.name, replying: userId === replyingId }));
  if (replyingId && !others.some((o) => o.replying)) others.push({ name: typing!.name, replying: true });
  const t = state.visitor.get(c.id);
  return { typing: !!t && t.until > now, text: t && t.until > now ? t.text : null, others };
}

const NEW_VISIT_MS = 30 * 60_000;
const SEEN_WRITE_MS = 30_000;

export type VisitorInfo = { page?: string | null; timezone?: string | null; language?: string | null; device?: string | null; country?: string | null; region?: string | null; city?: string | null };

/**
 * A website visitor's bubble is on their screen: when they were last seen ("online now"), the page they're
 * on, a new visit after half an hour away, and — the first time they're known — where they are and what
 * they're using. Written at most every thirty seconds unless the page changes, and on its own: a
 * workspace not migrated yet loses only this.
 */
export async function visitorSeen(channelId: string, token: string, info: VisitorInfo, now = new Date()): Promise<void> {
  const c = await visitorConversation(channelId, token);
  if (!c) return;
  await seenConversation(c.id, info, now);
}

async function seenConversation(conversationId: string, info: VisitorInfo, now: Date): Promise<void> {
  const state = typingState();
  const page = info.page && /^https?:\/\//.test(info.page) ? info.page.slice(0, 500) : null;
  const wrote = state.seenWrites.get(conversationId);
  if (wrote && now.getTime() - wrote.at < SEEN_WRITE_MS && (!page || page === wrote.page)) return;
  state.seenWrites.set(conversationId, { at: now.getTime(), page: page ?? wrote?.page ?? null });
  try {
    const row = await db.conversation.findUnique({
      where: { id: conversationId },
      select: { lastSeenAt: true, pagesSeen: true, visitorCountry: true, visitorTimezone: true, visitorLanguage: true, visitorDevice: true },
    });
    if (!row) return;
    const newVisit = !!row.lastSeenAt && now.getTime() - row.lastSeenAt.getTime() > NEW_VISIT_MS;
    await db.conversation.update({
      where: { id: conversationId },
      data: {
        lastSeenAt: now,
        ...(newVisit ? { visitCount: { increment: 1 } } : {}),
        ...(page ? { pagesSeen: withPage(row.pagesSeen, page, now) as Prisma.InputJsonValue } : {}),
        ...(!row.visitorCountry && info.country ? { visitorCountry: info.country, visitorRegion: info.region ?? null, visitorCity: info.city ?? null } : {}),
        ...(!row.visitorTimezone && info.timezone ? { visitorTimezone: info.timezone } : {}),
        ...(!row.visitorLanguage && info.language ? { visitorLanguage: info.language } : {}),
        ...(!row.visitorDevice && info.device ? { visitorDevice: info.device } : {}),
      },
      select: { id: true },
    });
  } catch (err) {
    console.warn("[inbox] a visitor's last-seen couldn't be written", err instanceof Error ? err.message : err);
  }
}

// ─── WhatsApp ────────────────────────────────────────────────────────────────────────────────────

/** One message from Meta's webhook. Meta retries, so one already kept is skipped. */
export async function receiveWhatsApp(m: InboundWhatsApp): Promise<"stored" | "duplicate" | "no-channel" | "blocked" | "rated"> {
  const channel = await db.inboxChannel.findFirst({ where: { phoneNumberId: m.phoneNumberId, kind: "WHATSAPP", active: true } });
  if (!channel) return "no-channel";
  if (await db.conversationMessage.findUnique({ where: { externalId: m.id }, select: { id: true } })) return "duplicate";
  // A number the team blocked: Meta is answered, and the message goes nowhere.
  if (await isBlocked("WHATSAPP", m.from)) return "blocked";
  const settings = channelSettings(channel.settings, "WHATSAPP");
  let c = await db.conversation.findFirst({ where: { channelId: channel.id, waId: m.from }, orderBy: { lastMessageAt: "desc" }, select: { id: true, status: true, lastCustomerAt: true } });
  let first = false;
  // "👍" or "2" to "How did we do?" on a closed conversation, within the day: their rating, and it stays closed.
  const rating = c?.status === "CLOSED" && !m.media ? ratingOf(m.text) : null;
  if (c && rating) {
    const asked = await db.conversation.findUnique({ where: { id: c.id }, select: { ratingAskedAt: true, ratedAt: true } }).catch(() => null);
    if (asked?.ratingAskedAt && !asked.ratedAt && m.at.getTime() - asked.ratingAskedAt.getTime() < 24 * 60 * 60_000) {
      try {
        if (await keepRating(c.id, rating, null, { externalId: m.id, at: m.at })) {
          await db.conversation.update({ where: { id: c.id }, data: { lastCustomerAt: m.at } });
          if (channel.phoneNumberId) await botSays({ id: c.id, kind: "WHATSAPP", waId: m.from }, channel, rating === "GOOD" ? "Thank you! 😊" : "Thank you for telling us — we'll do better.");
          return "rated";
        }
      } catch (err) {
        if ((err as { code?: string }).code === "P2002") return "duplicate";
        throw err;
      }
    }
  }
  // A customer back after six hours' quiet is a new visit. Written on its own: unmigrated, only this is lost.
  if (c?.lastCustomerAt && m.at.getTime() - c.lastCustomerAt.getTime() > 6 * 60 * 60_000) {
    await db.conversation.updateMany({ where: { id: c.id }, data: { visitCount: { increment: 1 } } }).catch(() => {});
  }
  if (!c) {
    c = await db.conversation.create({
      data: {
        channelId: channel.id,
        kind: "WHATSAPP",
        waId: m.from,
        customerPhone: `+${m.from}`,
        customerName: m.profileName?.slice(0, INBOX_LIMITS.name) || null,
        botActive: settings.bot.on,
        // A rep's own number: theirs from the start.
        assignedToUserId: channel.ownerUserId,
        lastMessageAt: m.at,
      },
      select: { id: true, status: true, lastCustomerAt: true },
    });
    first = true;
    // The country the number's code belongs to.
    const country = countryOfNumber(m.from);
    if (country) await db.conversation.updateMany({ where: { id: c.id }, data: { visitorCountry: country } }).catch(() => {});
  }
  const filter = await activeWordFilter("TICKETS");
  // Files switched off for customers: WhatsApp still lets them send one, but it's never fetched or kept —
  // the team sees "[Photo]" and what they wrote with it.
  const media = settings.files.customers ? (m.media ?? null) : null;
  try {
    await addMessage(c.id, "CUSTOMER", filter ? filter.mask(m.text) : m.text, { externalId: m.id, at: m.at, media });
  } catch (err) {
    // Two deliveries of the same message at once: the other one kept it.
    if ((err as { code?: string }).code === "P2002") return "duplicate";
    throw err;
  }
  await afterCustomerMessage(c.id, m.text, m.at, { first, externalId: m.id });
  return "stored";
}

const RANK: Record<WhatsAppStatus["status"], number> = { SENT: 1, DELIVERED: 2, READ: 3, FAILED: 4 };

/** A receipt for one of ours: it only moves forward (read never goes back to delivered). */
export async function applyWhatsAppStatus(st: WhatsAppStatus): Promise<void> {
  const row = await db.conversationMessage.findUnique({ where: { externalId: st.id }, select: { id: true, delivery: true, conversationId: true } });
  if (!row) return;
  if (row.delivery && RANK[row.delivery] >= RANK[st.status]) return;
  await db.conversationMessage.update({ where: { id: row.id }, data: { delivery: st.status, ...(st.error ? { error: st.error.slice(0, 300) } : {}) } });
  await announce(row.conversationId);
}

// ─── Staff ───────────────────────────────────────────────────────────────────────────────────────

/** The conversation, if this person may see it — with what the actions below (and src/lib/inbox/team.ts) need. */
export async function visibleConversation(viewer: InboxViewer, id: string) {
  const c = await db.conversation.findUnique({
    where: { id },
    select: {
      id: true,
      seq: true,
      kind: true,
      status: true,
      waId: true,
      visitorTokenHash: true,
      customerName: true,
      customerPhone: true,
      customerEmail: true,
      assignedToUserId: true,
      lastCustomerAt: true,
      firstResponseAt: true,
      companyId: true,
      contactId: true,
      ticketId: true,
      channel: true,
    },
  });
  return c && mayRead(viewer, c) ? c : null;
}

/** The conversation's id from what a page or link names: its id, or CNV-000123. */
export async function conversationIdFrom(ref: string): Promise<string | null> {
  const m = /^CNV-(\d{1,9})$/i.exec(ref.trim());
  if (!m) return ref.trim() || null;
  return (await db.conversation.findUnique({ where: { seq: Number(m[1]) }, select: { id: true } }))?.id ?? null;
}

export type StaffResult<T = null> = { ok: true; data: T } | { ok: false; error: string };

async function markRead(conversationId: string, userId: string, at = new Date()) {
  await db.conversationRead.upsert({ where: { conversationId_userId: { conversationId, userId } }, create: { conversationId, userId, readAt: at }, update: { readAt: at } });
}

/** Words the workspace keeps from customers (the word filter's tickets list), in a staff member's reply. */
async function refusedWords(text: string): Promise<string | null> {
  const filter = await activeWordFilter("TICKETS");
  const found = filter ? [...new Set(filter.find(text))] : [];
  if (!found.length) return null;
  return `Your company doesn't allow ${found.length === 1 ? "this word" : "these words"} with customers: ${found.slice(0, 5).map((w) => `"${w}"`).join(", ")}. Change ${found.length === 1 ? "it" : "them"} and send it again.`;
}

/** After a staff member's message: the bot is done, the first response is timed, and it's theirs if nobody's. */
async function afterStaffMessage(viewer: InboxViewer, c: { id: string; assignedToUserId: string | null; firstResponseAt: Date | null }) {
  const now = new Date();
  await db.conversation.update({
    where: { id: c.id },
    data: { botActive: false, lastMessageAt: now, ...(c.firstResponseAt ? {} : { firstResponseAt: now }), ...(c.assignedToUserId ? {} : { assignedToUserId: viewer.id }) },
  });
  await markRead(c.id, viewer.id, now);
  await announce(c.id);
}

/** A staff member's reply: on WhatsApp within the 24 hours since the customer last wrote; on a website, any time. */
export async function staffReply(viewer: InboxViewer, id: string, raw: string): Promise<StaffResult> {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (!text) return { ok: false, error: "Write something first." };
  if (text.length > INBOX_LIMITS.message) return { ok: false, error: `Keep it under ${INBOX_LIMITS.message.toLocaleString("en-IN")} characters.` };
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  const words = await refusedWords(text);
  if (words) return { ok: false, error: words };
  if (c.kind === "WHATSAPP") {
    if (!whatsappWindowOpen(c.lastCustomerAt)) return { ok: false, error: "It's over 24 hours since they last wrote, so WhatsApp only allows an approved template now." };
    if (!c.channel.phoneNumberId || !c.waId) return { ok: false, error: "This number can't send." };
    const sent = await sendWhatsApp({ phoneNumberId: c.channel.phoneNumberId, to: c.waId, text });
    if (!sent.ok) return { ok: false, error: sent.error };
    await addMessage(c.id, "AGENT", text, { userId: viewer.id, externalId: sent.id, delivery: "SENT" });
  } else {
    await addMessage(c.id, "AGENT", text, { userId: viewer.id });
  }
  await afterStaffMessage(viewer, c);
  if (c.kind === "WEB") await followUp(viewer, c.id, text);
  return { ok: true, data: null };
}

/**
 * Starting a chat with somebody on the website now (owner, 7 Nov 2026 — the inbox's Visitors tab). Only a visitor who
 * agreed to being remembered is here to be chosen, and only one on the site now: their bubble asks every 20 seconds and
 * shows the message beside it, as a chat they can open or dismiss. With an open chat, it goes in that one; a closed one
 * is left closed and this starts afresh, with who they are carried over. Nothing goes to somebody the team blocked.
 */
export async function staffStartVisitorChat(viewer: InboxViewer, visitorId: string, raw: string): Promise<{ ok: true; data: { id: string } } | { ok: false; error: string }> {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (!text) return { ok: false, error: "Write something first." };
  if (text.length > INBOX_LIMITS.message) return { ok: false, error: `Keep it under ${INBOX_LIMITS.message.toLocaleString("en-IN")} characters.` };
  const words = await refusedWords(text);
  if (words) return { ok: false, error: words };
  const v = await db.webVisitor.findUnique({
    where: { id: visitorId },
    select: {
      id: true,
      channelId: true,
      lastSeenAt: true,
      contactId: true,
      city: true,
      region: true,
      country: true,
      browser: true,
      language: true,
      timezone: true,
      channel: { select: { settings: true } },
      contact: { select: { id: true, name: true, email: true, phone: true, companyId: true, company: { select: { name: true } } } },
      conversation: {
        select: {
          id: true,
          status: true,
          contactId: true,
          companyId: true,
          leadId: true,
          customerName: true,
          customerEmail: true,
          customerPhone: true,
          customerCompany: true,
          visitorTokenHash: true,
        },
      },
      pageViews: { orderBy: { at: "desc" }, take: 1, select: { host: true, path: true } },
    },
  });
  if (!v) return { ok: false, error: "That visitor isn't there any more." };
  if (!channelSettings(v.channel.settings, "WEB").activity.on) return { ok: false, error: "Website activity has been switched off for this channel." };
  if (!onSiteNow(v.lastSeenAt)) return { ok: false, error: "They've left the website, so there's nobody to chat with just now." };
  const earlier = v.conversation;
  if (earlier?.visitorTokenHash && (await isBlocked("WEB", earlier.visitorTokenHash))) return { ok: false, error: "The team has blocked this visitor." };
  const now = new Date();

  // A chat already open: this goes in it, and their bubble only has to look.
  if (earlier && earlier.status === "OPEN") {
    const c = await visibleConversation(viewer, earlier.id);
    // Shared channels let anybody reply, in the conversation with it all in front of them; this isn't that.
    if (!c || (c.assignedToUserId && c.assignedToUserId !== viewer.id)) return { ok: false, error: "A colleague is already chatting with them. Open their chat to see it." };
    await addMessage(c.id, "AGENT", text, { userId: viewer.id });
    await afterStaffMessage(viewer, c);
    await db.webVisitor.update({ where: { id: v.id }, data: { inviteAt: now, inviteConversationId: null } });
    return { ok: true, data: { id: c.id } };
  }

  const page = v.pageViews[0];
  const created = await db.conversation.create({
    data: {
      channelId: v.channelId,
      kind: "WEB",
      botActive: false,
      assignedToUserId: viewer.id,
      contactId: v.contactId ?? earlier?.contactId ?? null,
      companyId: v.contact?.companyId ?? earlier?.companyId ?? null,
      leadId: earlier?.leadId ?? (v.contactId ? await openLeadOf(v.contactId) : null),
      customerName: v.contact?.name ?? earlier?.customerName ?? null,
      customerEmail: v.contact?.email ?? earlier?.customerEmail ?? null,
      customerPhone: v.contact?.phone ?? earlier?.customerPhone ?? null,
      customerCompany: v.contact?.company.name ?? earlier?.customerCompany ?? null,
      pageUrl: page ? `https://${page.host}${page.path}`.slice(0, 500) : null,
      visitorCity: v.city,
      visitorRegion: v.region,
      visitorCountry: v.country,
      visitorDevice: v.browser,
      visitorLanguage: v.language,
      visitorTimezone: v.timezone,
      lastSeenAt: now,
      lastMessageAt: now,
    },
    select: { id: true, assignedToUserId: true, firstResponseAt: true },
  });
  await db.conversation.update({ where: { id: created.id }, data: { visitorTokenHash: sha256(await startedChatToken(created.id)) } });
  await addMessage(created.id, "AGENT", text, { userId: viewer.id });
  await afterStaffMessage(viewer, created);
  await db.webVisitor.update({ where: { id: v.id }, data: { conversationId: created.id, inviteConversationId: created.id, inviteAt: now } });
  return { ok: true, data: { id: created.id } };
}

/** A website visitor who has left hears of the reply by email, where the channel says so (src/lib/inbox/follow-up.ts). Never throws. */
async function followUp(viewer: InboxViewer, conversationId: string, text: string): Promise<void> {
  try {
    const sent = await emailFollowUp(conversationId, viewer.id, text);
    if (sent) {
      await addMessage(conversationId, "SYSTEM", `They'd left the website, so it was emailed to ${sent}`);
      await announce(conversationId);
    }
  } catch (err) {
    console.error("[inbox] a follow-up email wasn't sent", err instanceof Error ? err.message : err);
  }
}

/**
 * A file from the team (owner, 24 Oct 2026: "files both ways"): to a website visitor, kept here for their
 * bubble; on WhatsApp, put with Meta and sent as a photo or document — within the 24 hours — and a copy
 * kept so the team can open it.
 */
export async function staffSendFile(viewer: InboxViewer, id: string, input: KeptFile & { caption?: string | null }): Promise<StaffResult> {
  const checked = checkFile(input);
  if (!checked.ok) return checked;
  const caption = input.caption?.replace(/\r\n?/g, "\n").trim().slice(0, 1000) || null;
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  if (!channelSettings(c.channel.settings, c.kind as InboxKind).files.team) return { ok: false, error: FILES_OFF_FOR_TEAM };
  if (caption) {
    const words = await refusedWords(caption);
    if (words) return { ok: false, error: words };
  }
  const file: KeptFile = { bytes: input.bytes, mime: checked.mime, name: checked.name };
  const text = fileText(checked.mime, checked.name, caption);
  // Out of storage, refused before it goes anywhere: a file sent on WhatsApp is kept here too.
  const room = await roomForFile(file.bytes.length);
  if (!room.ok) return room;
  if (c.kind === "WHATSAPP") {
    if (!whatsappWindowOpen(c.lastCustomerAt)) return { ok: false, error: "It's over 24 hours since they last wrote, so WhatsApp only allows an approved template now." };
    if (!c.channel.phoneNumberId || !c.waId) return { ok: false, error: "This number can't send." };
    const sent = await sendWhatsApp({ phoneNumberId: c.channel.phoneNumberId, to: c.waId, media: { bytes: file.bytes, mime: file.mime, name: checked.name, ...(caption ? { caption } : {}) } });
    if (!sent.ok) return { ok: false, error: sent.error };
    await addMessage(c.id, "AGENT", text, { userId: viewer.id, externalId: sent.id, delivery: "SENT", file });
  } else {
    await addMessage(c.id, "AGENT", text, { userId: viewer.id, file });
  }
  await afterStaffMessage(viewer, c);
  if (c.kind === "WEB") await followUp(viewer, c.id, text);
  return { ok: true, data: null };
}

/**
 * A staff member is typing a reply: the website bubble shows "<first name> is typing…" for a few seconds,
 * and on WhatsApp the customer sees "typing…" (asked of Meta no more than every twenty seconds).
 */
export async function staffTyping(viewer: InboxViewer, id: string, now = Date.now()): Promise<StaffResult> {
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  const state = typingState();
  const me = await db.user.findUnique({ where: { id: viewer.id }, select: { name: true } });
  const typing = { id: c.id, name: firstNameOf(me?.name) ?? "Somebody", until: now + TYPING_MS, userId: viewer.id };
  const before = state.typing.get(c.id);
  state.typing.set(c.id, { name: typing.name, until: typing.until, userId: viewer.id });
  broadcast("inbox:typing", typing);
  // Colleagues with it open see "Priya is replying" as soon as she starts — not on every keystroke after.
  if (!before || before.userId !== viewer.id || before.until <= now) {
    try {
      const tenantId = await tenantKey();
      publishIn(tenantId, listeningIn(tenantId), { type: "inbox-typing", conversationId: c.id });
    } catch {
      // Not live: they see it on their next look.
    }
  }
  if (c.kind === "WHATSAPP" && c.channel.phoneNumberId && whatsappWindowOpen(c.lastCustomerAt) && now - (state.whatsappAt.get(c.id) ?? 0) > WHATSAPP_TYPING_EVERY_MS) {
    const last = await db.conversationMessage.findFirst({ where: { conversationId: c.id, author: "CUSTOMER", externalId: { not: null } }, orderBy: { createdAt: "desc" }, select: { externalId: true } });
    if (last?.externalId) {
      state.whatsappAt.set(c.id, now);
      await markWhatsAppRead({ phoneNumberId: c.channel.phoneNumberId, messageId: last.externalId, typing: true });
    }
  }
  return { ok: true, data: null };
}

/**
 * A WhatsApp customer's messages, read by somebody on the team: Meta is told, so they see the blue ticks a
 * person on the phone would give them. The newest unread one is enough — WhatsApp marks the ones before it.
 */
async function sendReadReceipt(conversationId: string): Promise<void> {
  const c = await db.conversation.findUnique({ where: { id: conversationId }, select: { kind: true, channel: { select: { phoneNumberId: true } } } });
  if (c?.kind !== "WHATSAPP" || !c.channel.phoneNumberId) return;
  const last = await db.conversationMessage.findFirst({ where: { conversationId, author: "CUSTOMER", externalId: { not: null } }, orderBy: { createdAt: "desc" }, select: { id: true, externalId: true, delivery: true } });
  if (!last?.externalId || last.delivery === "READ") return;
  if (await markWhatsAppRead({ phoneNumberId: c.channel.phoneNumberId, messageId: last.externalId, typing: false })) {
    await db.conversationMessage.update({ where: { id: last.id }, data: { delivery: "READ" } });
  }
}

/** An approved WhatsApp template — the one way to write once the 24 hours are up. */
export async function staffTemplate(viewer: InboxViewer, id: string, input: { name: string; variables: string[] }): Promise<StaffResult> {
  const name = input.name.trim();
  if (!/^[a-z0-9_]{1,512}$/.test(name)) return { ok: false, error: "Give the template's name as Meta has it: lower case, digits and underscores." };
  const variables = input.variables.map((v) => v.trim());
  if (variables.length > 10) return { ok: false, error: "A template takes at most ten values here." };
  if (variables.some((v) => !v || v.length > 500)) return { ok: false, error: "Fill in every value — WhatsApp drops blanks and shifts the rest." };
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  if (c.kind !== "WHATSAPP" || !c.channel.phoneNumberId || !c.waId) return { ok: false, error: "Templates are for WhatsApp." };
  const words = await refusedWords(variables.join("\n"));
  if (words) return { ok: false, error: words };
  const sent = await sendWhatsApp({ phoneNumberId: c.channel.phoneNumberId, to: c.waId, template: { name, variables } });
  if (!sent.ok) return { ok: false, error: sent.error };
  await addMessage(c.id, "AGENT", `Template “${name}”${variables.length ? `: ${variables.join(" · ")}` : ""}`, { userId: viewer.id, templateName: name, externalId: sent.id, delivery: "SENT" });
  await afterStaffMessage(viewer, c);
  return { ok: true, data: null };
}

/** Whether this person may be given a conversation on this channel. */
async function mayTake(userId: string, channel: { ownerUserId: string | null }): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { active: true } });
  if (!user?.active || !(await can(userId, "inbox.view"))) return false;
  return channel.ownerUserId === null || channel.ownerUserId === userId || (await can(userId, "inbox.viewAll"));
}

export async function assignConversation(viewer: InboxViewer, id: string, toUserId: string | null): Promise<StaffResult> {
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  if (toUserId === c.assignedToUserId) return { ok: true, data: null };
  if (toUserId && !(await mayTake(toUserId, c.channel))) return { ok: false, error: "They can't take customer conversations here." };
  const [me, them] = await Promise.all([
    db.user.findUnique({ where: { id: viewer.id }, select: { name: true } }),
    toUserId ? db.user.findUnique({ where: { id: toUserId }, select: { name: true } }) : null,
  ]);
  await db.conversation.update({ where: { id: c.id }, data: { assignedToUserId: toUserId } });
  await addMessage(c.id, "SYSTEM", toUserId ? (toUserId === viewer.id ? `${me?.name ?? "Somebody"} took it` : `${me?.name ?? "Somebody"} gave it to ${them?.name ?? "somebody"}`) : `${me?.name ?? "Somebody"} put it back in the queue`, { userId: viewer.id });
  if (toUserId && toUserId !== viewer.id) {
    await notifyUser({ userId: toUserId, type: "INBOX_MESSAGE", title: `${me?.name ?? "Somebody"} gave you a customer conversation`, message: conversationRef(c.seq), link: `/inbox?c=${conversationRef(c.seq)}` });
  }
  await announce(c.id);
  return { ok: true, data: null };
}

/**
 * Takes a conversation over from the bot (owner, 19 Nov 2026 — the Team room's "Take over"): it becomes this person's,
 * the bot answers no more, and the conversation says who stepped in. The customer isn't told anything by itself — the
 * person's own first reply is what they see. Its reference comes back, for opening it in the Inbox.
 */
export async function takeOverFromBot(viewer: InboxViewer, id: string): Promise<StaffResult<{ ref: string }>> {
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  if (c.status !== "OPEN") return { ok: false, error: "That conversation is closed." };
  if (!(await mayTake(viewer.id, c.channel))) return { ok: false, error: "You can't take customer conversations here." };
  const now = await db.conversation.findUniqueOrThrow({ where: { id: c.id }, select: { botActive: true, needsPersonAt: true } });
  if (c.assignedToUserId && c.assignedToUserId !== viewer.id && !now.botActive) return { ok: false, error: "Somebody on your team already has this one." };
  const [me, bot] = await Promise.all([db.user.findUnique({ where: { id: viewer.id }, select: { name: true } }), teammate("kabir")]);
  const assistant = channelSettings(c.channel.settings, c.kind as InboxKind).bot.name.trim() || bot.name;
  await db.conversation.update({ where: { id: c.id }, data: { assignedToUserId: viewer.id, botActive: false, ...(now.needsPersonAt ? {} : { needsPersonAt: new Date() }) } });
  await addMessage(c.id, "SYSTEM", `${me?.name ?? "Somebody"} took over from ${assistant}`, { userId: viewer.id });
  await announce(c.id);
  return { ok: true, data: { ref: conversationRef(c.seq) } };
}

export async function setConversationStatus(viewer: InboxViewer, id: string, status: "OPEN" | "CLOSED"): Promise<StaffResult> {
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  if (c.status === status) return { ok: true, data: null };
  const me = await db.user.findUnique({ where: { id: viewer.id }, select: { name: true } });
  await db.conversation.update({ where: { id: c.id }, data: { status, closedAt: status === "CLOSED" ? new Date() : null, ...(status === "CLOSED" ? { botActive: false } : {}) } });
  await addMessage(c.id, "SYSTEM", `${me?.name ?? "Somebody"} ${status === "CLOSED" ? "closed it" : "reopened it"}`, { userId: viewer.id });
  if (status === "CLOSED") await askRating(c);
  await announce(c.id);
  return { ok: true, data: null };
}

const RATING_QUESTION = "How did we do? Reply 👍 if we helped, or 👎 if we didn't.";

/**
 * "How did we do?" once a conversation a person answered is closed (owner, 24 Oct 2026), where the
 * channel asks: the bubble shows 👍 and 👎; on WhatsApp it's asked in words while the 24 hours allow it.
 * Once a conversation — a customer who has said needn't be asked again. Never throws.
 */
async function askRating(c: { id: string; kind: string; waId: string | null; lastCustomerAt: Date | null; firstResponseAt: Date | null; channel: InboxChannel }): Promise<void> {
  try {
    if (!channelSettings(c.channel.settings, c.kind as InboxKind).csat || !c.firstResponseAt) return;
    if (c.kind === "WHATSAPP" && !(c.channel.phoneNumberId && c.waId && whatsappWindowOpen(c.lastCustomerAt))) return;
    const asked = await db.conversation.updateMany({ where: { id: c.id, ratedAt: null }, data: { ratingAskedAt: new Date() } });
    if (asked.count && c.kind === "WHATSAPP") await botSays({ id: c.id, kind: "WHATSAPP", waId: c.waId }, c.channel, RATING_QUESTION);
  } catch (err) {
    console.warn("[inbox] the rating wasn't asked for", err instanceof Error ? err.message : err);
  }
}

/**
 * The customer this conversation is, chosen by a person from those on file it could be (a number or
 * email on file for more than one company) — with their open lead, if they have one.
 */
export async function staffLinkCustomer(viewer: InboxViewer, id: string, contactId: string): Promise<StaffResult> {
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  if (c.contactId) return { ok: false, error: "It's linked to a customer already — unlink it first." };
  const v = await visitorOf(c.id);
  const choice = v ? (await customersOnFile(v.kind, { name: v.customerName, email: v.customerEmail, phone: v.customerPhone })).find((o) => o.contactId === contactId) : null;
  if (!choice) return { ok: false, error: "That isn't one of the customers this could be." };
  const lead = await openLeadOf(choice.contactId);
  await db.conversation.update({ where: { id: c.id }, data: { contactId: choice.contactId, companyId: choice.companyId, ...(lead ? { leadId: lead } : {}) } });
  const me = await db.user.findUnique({ where: { id: viewer.id }, select: { name: true } });
  await addMessage(c.id, "SYSTEM", `${me?.name ?? "Somebody"} linked it to ${choice.contactName} · ${choice.companyName}`, { userId: viewer.id });
  await announce(c.id);
  return { ok: true, data: null };
}

/**
 * Not this customer after all: the link to the contact, their company and the lead it took is undone
 * (the lead itself stays in Leads). Then a lead can be made for who they really are.
 */
export async function staffUnlinkCustomer(viewer: InboxViewer, id: string): Promise<StaffResult> {
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  if (!c.contactId && !c.companyId) return { ok: true, data: null };
  const was = await db.conversation.findUnique({ where: { id: c.id }, select: { contact: { select: { name: true } }, company: { select: { name: true } } } });
  await db.conversation.update({ where: { id: c.id }, data: { contactId: null, companyId: null, leadId: null } });
  const me = await db.user.findUnique({ where: { id: viewer.id }, select: { name: true } });
  await addMessage(c.id, "SYSTEM", `${me?.name ?? "Somebody"} unlinked it from ${[was?.contact?.name, was?.company?.name].filter(Boolean).join(" · ") || "the customer"}`, { userId: viewer.id });
  await announce(c.id);
  return { ok: true, data: null };
}

/** A lead from the conversation, given to whoever has it (or the person asking). */
export async function staffMakeLead(viewer: InboxViewer, id: string): Promise<LeadMade> {
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  const owner = c.assignedToUserId ?? viewer.id;
  const made = await makeLead(c.id, { ownerUserId: owner, notify: owner !== viewer.id });
  if (made.ok) {
    await addMessage(c.id, "SYSTEM", made.contactOnly ? "Saved as a contact" : `Lead ${made.reference} made`, { userId: viewer.id });
    await announce(c.id);
  }
  return made;
}

/** A helpdesk ticket from the conversation, with what was said in it — on the company it's linked to. */
export async function staffMakeTicket(viewer: InboxViewer, id: string, rawTitle: string): Promise<StaffResult<{ ticketSeq: number }>> {
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  if (c.ticketId) return { ok: false, error: "It's a ticket already." };
  if (!c.companyId) return { ok: false, error: "Link it to a customer first — make a lead, or it links itself when their email or number is on file." };
  const title = rawTitle.replace(/\s+/g, " ").trim().slice(0, INBOX_LIMITS.ticketTitle);
  if (title.length < 2) return { ok: false, error: "Give the ticket a title." };
  const said = await db.conversationMessage.findMany({ where: { conversationId: c.id, author: { in: THE_CUSTOMERS } }, orderBy: { createdAt: "desc" }, take: 30, select: { author: true, body: true, createdAt: true } });
  const description = [`From ${conversationRef(c.seq)} (${KIND_WORD[c.kind as InboxKind]}):`, "", ...said.reverse().map((m) => `${m.author === "CUSTOMER" ? "Customer" : m.author === "BOT" ? "Bot" : "Us"}: ${m.body}`)].join("\n").slice(0, 8000);
  const data = { companyId: c.companyId, contactId: c.contactId ?? "", companyProductId: "", title, description, ticketType: "PRODUCT_SUPPORT" as const, priority: "MEDIUM" as const, assignedToUserId: "" };
  const refused = await newTicketRefusal(viewer.id, data);
  if (refused) return { ok: false, error: refused };
  const ticket = await db.$transaction((tx) => writeTicket(tx, viewer.id, data, "inbox"));
  await db.conversation.update({ where: { id: c.id }, data: { ticketId: ticket.id } });
  await addMessage(c.id, "SYSTEM", `Ticket made: ${title}`, { userId: viewer.id });
  await announce(c.id);
  return { ok: true, data: { ticketSeq: ticket.ticketSeq } };
}

// ─── Lists ───────────────────────────────────────────────────────────────────────────────────────

export type InboxView = "mine" | "unassigned" | "open" | "closed";

export type InboxRow = {
  id: string;
  ref: string;
  kind: InboxKind;
  channelName: string;
  status: "OPEN" | "CLOSED";
  customer: string;
  preview: string;
  lastFrom: ConversationAuthor | null;
  lastMessageAt: string;
  assignedTo: { id: string; name: string } | null;
  unread: boolean;
  botActive: boolean;
  /** A website visitor with the bubble on their screen now. */
  online: boolean;
  visits: number;
  tags: string[];
  /** The customer's rating once it closed. */
  rating: "GOOD" | "BAD" | null;
};

const customerLabel = (c: { customerName: string | null; customerPhone: string | null; customerEmail: string | null; kind: string }) =>
  c.customerName || c.customerPhone || c.customerEmail || (c.kind === "WEB" ? "Website visitor" : "WhatsApp customer");

/**
 * A conversation's number and email as this person may see them (owner, 5 Nov 2026 — Phase 3 masking fixes, audit C.2
 * "Inbox / WhatsApp"). Linked to somebody on file, they are that contact's — the conversation linked itself by them —
 * and are shown as the contacts policy shows that contact in a list (src/lib/contacts/masking.ts): a person whose
 * Contacts list masks phones saw the same number whole as the conversation's name and on its Contact card. The
 * conversation itself — the customer's own messages — stays as written, and a reply still goes: it is sent by the
 * server to the conversation's own number (`waId`), never one the screen holds. Not linked, they are a visitor's, as
 * they typed them, and no contact's rules are about them.
 */
function customerAsSeen<T extends { contactId: string | null; customerPhone: string | null; customerEmail: string | null }>(m: ContactMasker, c: T): T & { masked: { phone: boolean; email: boolean } } {
  if (!c.contactId || !m.active) return { ...c, masked: { phone: false, email: false } };
  const customerPhone = c.customerPhone === null ? null : m.present(c.contactId, "phone", c.customerPhone);
  const customerEmail = c.customerEmail === null ? null : m.present(c.contactId, "email", c.customerEmail);
  return { ...c, customerPhone, customerEmail, masked: { phone: customerPhone !== c.customerPhone, email: customerEmail !== c.customerEmail } };
}

export async function listConversations(viewer: InboxViewer, filter: { view: InboxView; channelId?: string | null; q?: string | null; tag?: string | null }): Promise<InboxRow[]> {
  const view: Prisma.ConversationWhereInput =
    filter.view === "mine"
      ? { status: "OPEN", assignedToUserId: viewer.id }
      : filter.view === "unassigned"
        ? { status: "OPEN", assignedToUserId: null }
        : filter.view === "closed"
          ? { status: "CLOSED" }
          : { status: "OPEN" };
  const q = filter.q?.replace(/\s+/g, " ").trim().slice(0, 80);
  const tag = filter.tag?.trim().toLowerCase().slice(0, TEAM_LIMITS.tag) || null;
  // A linked customer's number or email this person sees masked isn't searched (`customerAsSeen`), as the Contacts list
  // doesn't search them: which conversations came back would say what they hold.
  const hidden = q ? await maskedInLists(viewer.id) : { email: false, phone: false };
  const rows = await db.conversation.findMany({
    where: {
      AND: [
        visibleWhere(viewer),
        view,
        ...(filter.channelId ? [{ channelId: filter.channelId }] : []),
        ...(q
          ? [
              {
                OR: [
                  { customerName: { contains: q, mode: "insensitive" as const } },
                  hidden.phone ? { customerPhone: { contains: q }, contactId: null } : { customerPhone: { contains: q } },
                  hidden.email ? { customerEmail: { contains: q, mode: "insensitive" as const }, contactId: null } : { customerEmail: { contains: q, mode: "insensitive" as const } },
                ],
              },
            ]
          : []),
        ...(tag ? [{ tags: { has: tag } }] : []),
      ],
    },
    orderBy: { lastMessageAt: "desc" },
    take: 100,
    select: {
      id: true,
      seq: true,
      kind: true,
      status: true,
      customerName: true,
      customerPhone: true,
      customerEmail: true,
      contactId: true,
      lastMessageAt: true,
      lastCustomerAt: true,
      botActive: true,
      channel: { select: { name: true } },
      assignedTo: { select: { id: true, name: true } },
      messages: { where: { author: { in: THE_CUSTOMERS } }, orderBy: { createdAt: "desc" }, take: 1, select: { body: true, author: true } },
      reads: { where: { userId: viewer.id }, select: { readAt: true } },
    },
  }).catch((err) => {
    // Filtered by a tag on a workspace not migrated yet: nothing has one.
    if (tag) return [];
    throw err;
  });
  const people = await contactMasker(viewer.id, "list", [...new Set(rows.flatMap((c) => c.contactId ?? []))]);
  // Online now, visits, tags and ratings, read by name on their own — nothing on a workspace not migrated yet.
  const now = Date.now();
  const seen = new Map(
    (await db.conversation.findMany({ where: { id: { in: rows.map((c) => c.id) } }, select: { id: true, lastSeenAt: true, visitCount: true, tags: true, rating: true } }).catch(() => [])).map((r) => [r.id, r]),
  );
  return rows.map((c) => ({
    id: c.id,
    ref: conversationRef(c.seq),
    kind: c.kind as InboxKind,
    channelName: c.channel.name,
    status: c.status,
    customer: customerLabel(customerAsSeen(people, c)),
    preview: (c.messages[0]?.body ?? "").slice(0, 140),
    lastFrom: c.messages[0]?.author ?? null,
    lastMessageAt: c.lastMessageAt.toISOString(),
    assignedTo: c.assignedTo,
    unread: !!c.lastCustomerAt && (!c.reads[0] || c.reads[0].readAt < c.lastCustomerAt),
    botActive: c.botActive,
    online: !!seen.get(c.id)?.lastSeenAt && now - seen.get(c.id)!.lastSeenAt!.getTime() < ONLINE_MS,
    visits: seen.get(c.id)?.visitCount ?? 1,
    tags: seen.get(c.id)?.tags ?? [],
    rating: ratingValue(seen.get(c.id)?.rating),
  }));
}

const ratingValue = (v: string | null | undefined): "GOOD" | "BAD" | null => (v === "GOOD" || v === "BAD" ? v : null);

/**
 * Open conversations waiting on this person: theirs, or nobody's, with something unread from the customer
 * — the bot's too (owner, 25 Oct 2026: "unread count of new visitor chat"), so a new chat counts the
 * moment it starts, and stops counting for each person once they've opened it.
 */
export async function unreadCount(viewer: InboxViewer): Promise<number> {
  const rows = await db.conversation.findMany({
    where: { AND: [visibleWhere(viewer), { status: "OPEN", lastCustomerAt: { not: null }, OR: [{ assignedToUserId: viewer.id }, { assignedToUserId: null }] }] },
    select: { lastCustomerAt: true, reads: { where: { userId: viewer.id }, select: { readAt: true } } },
    take: 500,
  });
  return rows.filter((c) => !c.reads[0] || c.reads[0].readAt < c.lastCustomerAt!).length;
}

export type InboxMessage = {
  id: string;
  author: ConversationAuthor;
  userName: string | null;
  body: string;
  templateName: string | null;
  delivery: ConversationDelivery | null;
  error: string | null;
  at: string;
  /** A file in it — the customer's or the team's — opened through /api/inbox/files/<message id>. */
  media: { mime: string | null; name: string | null } | null;
};

export type InboxDetail = InboxRow & {
  channel: { id: string; kind: InboxKind; name: string; displayPhone: string | null; shared: boolean; assistantName: string | null; files: ChannelSettings["files"] };
  customerName: string | null;
  customerEmail: string | null;
  customerPhone: string | null;
  /** Field access masked their number or email for this person (`customerAsSeen`): shown as text, no link to call or write. */
  customerMasked: { email: boolean; phone: boolean };
  /** The company they said they're from. */
  customerCompany: string | null;
  pageUrl: string | null;
  contact: { id: string; name: string } | null;
  company: { id: string; name: string; companySeq: number } | null;
  lead: { id: string; reference: string } | null;
  ticket: { id: string; ticketSeq: number } | null;
  /** WhatsApp: free text may go now; after 24 hours only a template. Always true on a website. */
  windowOpen: boolean;
  firstResponseAt: string | null;
  createdAt: string;
  messages: InboxMessage[];
  /** Who they are, as far as can be told (src/lib/inbox/visitor.ts); null where it can't be read yet. */
  visitor: VisitorPanel | null;
  /** Their earlier conversations — by the contact on file, or the same number or email. */
  previousConversations: number;
  /** A first-timer: one visit, nothing earlier. */
  isNew: boolean;
  /** What they said when they rated it. */
  ratingComment: string | null;
  /** The team blocked this visitor or number. */
  blocked: boolean;
  /** Not linked, and on file for more than one customer: whom it could be, for the team to choose. */
  couldBe: OnFile[];
};

export type VisitorPanel = {
  place: string | null;
  country: string | null;
  timezone: string | null;
  language: string | null;
  device: string | null;
  visits: number;
  lastSeenAt: string | null;
  /** The bubble was on their screen within the last minute. */
  online: boolean;
  currentPage: string | null;
  pages: { path: string; at: string }[];
};

const ONLINE_MS = 60_000;

/** The visitor panel's facts, read by name — empty on a workspace not migrated yet. */
async function visitorPanel(conversationId: string, now = Date.now()): Promise<VisitorPanel | null> {
  const v = await db.conversation
    .findUnique({
      where: { id: conversationId },
      select: { visitorCountry: true, visitorRegion: true, visitorCity: true, visitorTimezone: true, visitorLanguage: true, visitorDevice: true, visitCount: true, lastSeenAt: true, pagesSeen: true },
    })
    .catch(() => null);
  if (!v) return null;
  const pages = pagesOf(v.pagesSeen);
  return {
    place: placeText({ city: v.visitorCity, region: v.visitorRegion, country: v.visitorCountry }),
    country: v.visitorCountry,
    timezone: v.visitorTimezone,
    language: v.visitorLanguage,
    device: v.visitorDevice,
    visits: v.visitCount,
    lastSeenAt: v.lastSeenAt?.toISOString() ?? null,
    online: !!v.lastSeenAt && now - v.lastSeenAt.getTime() < ONLINE_MS,
    currentPage: pages.length ? pagePath(pages[pages.length - 1]!.url) : null,
    pages: pages.slice(-5).reverse().map((p) => ({ path: pagePath(p.url), at: p.at })),
  };
}

/**
 * How many conversations this customer had before this one — by the contact on file, the same WhatsApp
 * number or email, or the same number typed into a website chat by somebody of the same name
 * (`numberMatches`).
 */
async function earlierConversations(
  viewer: InboxViewer,
  c: { id: string; kind: string; createdAt: Date; contactId: string | null; waId: string | null; customerName: string | null; customerEmail: string | null; customerPhone: string | null },
): Promise<number> {
  const before: Prisma.ConversationWhereInput = { AND: [visibleWhere(viewer), { id: { not: c.id }, createdAt: { lt: c.createdAt } }] };
  const same: Prisma.ConversationWhereInput[] = [];
  if (c.contactId) same.push({ contactId: c.contactId });
  if (c.waId) same.push({ waId: c.waId });
  if (c.customerEmail) same.push({ customerEmail: { equals: c.customerEmail, mode: "insensitive" } });
  const ids = new Set(same.length ? (await db.conversation.findMany({ where: { AND: [before, { OR: same }] }, select: { id: true }, take: 500 })).map((r) => r.id) : []);
  if (c.customerPhone) {
    const byNumber = await db.conversation.findMany({ where: { AND: [before, { customerPhone: c.customerPhone }] }, select: { id: true, kind: true, customerName: true }, take: 200 });
    const kind = c.kind as InboxKind;
    for (const r of byNumber) if (numberMatches(kind === "WHATSAPP" && r.kind === "WHATSAPP" ? "WHATSAPP" : "WEB", { name: c.customerName, email: c.customerEmail }, { name: r.customerName })) ids.add(r.id);
  }
  return ids.size;
}

/** One conversation, read — and marked read for this person. */
export async function conversationDetail(viewer: InboxViewer, id: string): Promise<InboxDetail | null> {
  const c = await db.conversation.findUnique({
    where: { id },
    select: {
      id: true,
      seq: true,
      kind: true,
      status: true,
      customerName: true,
      customerPhone: true,
      customerEmail: true,
      pageUrl: true,
      lastMessageAt: true,
      lastCustomerAt: true,
      firstResponseAt: true,
      createdAt: true,
      botActive: true,
      assignedToUserId: true,
      contactId: true,
      waId: true,
      visitorTokenHash: true,
      channel: { select: { id: true, kind: true, name: true, displayPhone: true, ownerUserId: true, settings: true } },
      assignedTo: { select: { id: true, name: true } },
      contact: { select: { id: true, name: true } },
      company: { select: { id: true, name: true, companySeq: true } },
      lead: { select: { id: true, leadSeq: true } },
      ticket: { select: { id: true, ticketSeq: true } },
      messages: {
        orderBy: { createdAt: "desc" },
        take: 300,
        select: { id: true, author: true, body: true, templateName: true, delivery: true, error: true, createdAt: true, mediaId: true, mediaMime: true, mediaName: true, user: { select: { name: true } } },
      },
    },
  });
  if (!c || !mayRead(viewer, c)) return null;
  await markRead(c.id, viewer.id);
  // The customer's blue ticks, without holding up the page.
  void sendReadReceipt(c.id).catch(() => {});
  const last = c.messages.find((m) => THE_CUSTOMERS.includes(m.author));
  const [visitor, earlier, team, blocked, couldBe] = await Promise.all([
    visitorPanel(c.id),
    earlierConversations(viewer, c),
    // Read by name on their own: nothing on a workspace not migrated yet.
    db.conversation.findUnique({ where: { id: c.id }, select: { tags: true, rating: true, ratingComment: true, customerCompany: true } }).catch(() => null),
    c.kind === "WEB" ? isBlocked("WEB", c.visitorTokenHash) : isBlocked("WHATSAPP", c.waId),
    c.contactId ? Promise.resolve([] as OnFile[]) : undecided(c.id),
  ]);
  const seen = customerAsSeen(await contactMasker(viewer.id, "list", c.contactId ? [c.contactId] : []), c);
  return {
    id: c.id,
    ref: conversationRef(c.seq),
    kind: c.kind as InboxKind,
    channelName: c.channel.name,
    status: c.status,
    customer: customerLabel(seen),
    preview: (last?.body ?? "").slice(0, 140),
    lastFrom: last?.author ?? null,
    lastMessageAt: c.lastMessageAt.toISOString(),
    assignedTo: c.assignedTo,
    unread: false,
    botActive: c.botActive,
    online: visitor?.online ?? false,
    visits: visitor?.visits ?? 1,
    tags: team?.tags ?? [],
    rating: ratingValue(team?.rating),
    ratingComment: team?.ratingComment ?? null,
    blocked,
    couldBe,
    channel: {
      id: c.channel.id,
      kind: c.channel.kind as InboxKind,
      name: c.channel.name,
      displayPhone: c.channel.displayPhone,
      shared: c.channel.ownerUserId === null,
      // Unnamed, its bot answers as Kabir, the front desk (src/lib/ai/teammates.ts).
      assistantName: channelSettings(c.channel.settings, c.channel.kind as InboxKind).bot.name.trim() || (await teammate("kabir")).name,
      files: channelSettings(c.channel.settings, c.channel.kind as InboxKind).files,
    },
    customerName: c.customerName,
    customerEmail: seen.customerEmail,
    customerPhone: seen.customerPhone,
    customerMasked: seen.masked,
    customerCompany: team?.customerCompany ?? null,
    pageUrl: c.pageUrl,
    contact: c.contact,
    company: c.company,
    lead: c.lead ? { id: c.lead.id, reference: formatLeadId(c.lead.leadSeq) } : null,
    ticket: c.ticket,
    windowOpen: c.kind === "WEB" || whatsappWindowOpen(c.lastCustomerAt),
    firstResponseAt: c.firstResponseAt?.toISOString() ?? null,
    createdAt: c.createdAt.toISOString(),
    messages: c.messages.reverse().map((m) => ({
      id: m.id,
      author: m.author,
      userName: m.user?.name ?? null,
      body: m.body,
      templateName: m.templateName,
      delivery: m.delivery,
      error: m.error,
      at: m.createdAt.toISOString(),
      media: m.mediaId || m.mediaMime ? { mime: m.mediaMime, name: m.mediaName } : null,
    })),
    visitor,
    previousConversations: earlier,
    isNew: earlier === 0 && (visitor?.visits ?? 1) <= 1,
  };
}

/** A ConversationFile's bytes, from the row or the storage box (src/lib/storage/files.ts); null for one the box has lost. */
async function keptBytes(value: Uint8Array): Promise<Buffer | null> {
  try {
    return Buffer.from(await bytesOf(value));
  } catch (err) {
    if (err instanceof StoredFileMissing) return null;
    throw err;
  }
}

export type InboxFile = { ok: true; bytes: Buffer; mime: string; name: string | null } | { ok: false; status: 404 | 502; error: string };

/**
 * A file in a conversation, for somebody who may read it: one kept here from the start (a website
 * visitor's, or the team's), or a WhatsApp customer's — kept here once fetched from Meta (whose link
 * lasts minutes and whose copy goes after 30 days), fetched the first time it's opened.
 */
export async function conversationFile(viewer: InboxViewer, messageId: string): Promise<InboxFile> {
  const m = await db.conversationMessage.findUnique({
    where: { id: messageId },
    select: { id: true, mediaId: true, mediaMime: true, mediaName: true, conversation: { select: { assignedToUserId: true, channel: { select: { ownerUserId: true } } } }, file: { select: { bytes: true, mime: true, name: true } } },
  });
  if (!m || (!m.mediaId && !m.file) || !mayRead(viewer, m.conversation)) return { ok: false, status: 404, error: "That file isn't there, or isn't yours to see." };
  if (m.file) {
    // The bytes in the row, or the file in the storage box it points at — one the box has lost is a 404.
    const bytes = await keptBytes(m.file.bytes);
    return bytes ? { ok: true, bytes, mime: m.file.mime, name: m.file.name } : { ok: false, status: 404, error: "That file isn't there any more." };
  }
  if (!m.mediaId) return { ok: false, status: 404, error: "That file isn't there, or isn't yours to see." };
  const fetched = await fetchWhatsAppMedia(m.mediaId);
  if (!fetched.ok) return { ok: false, status: 502, error: fetched.error };
  const mime = fetched.mime || m.mediaMime || "application/octet-stream";
  // Kept in the storage box when one is set up, the row holding a reference. With the workspace's storage full it is
  // shown this once and not kept — logged; fetched from Meta again next time while Meta still has it.
  let stored: Uint8Array<ArrayBuffer>;
  try {
    stored = await keepBytes("inbox-files", fetched.bytes, mime);
  } catch (err) {
    if (!isStorageFull(err)) throw err;
    console.warn(`[inbox] a WhatsApp file wasn't kept: ${err.message}`);
    return { ok: true, bytes: fetched.bytes, mime, name: m.mediaName };
  }
  await db.conversationFile
    .create({ data: { messageId: m.id, mime, name: m.mediaName, size: fetched.bytes.length, bytes: stored } })
    .catch((err) => {
      // Opened twice at once: the other request kept it.
      if ((err as { code?: string }).code !== "P2002") throw err;
    });
  return { ok: true, bytes: fetched.bytes, mime, name: m.mediaName };
}

/** The people a conversation on this channel could be given to — for the assign menu. */
export async function assignablePeople(): Promise<{ id: string; name: string }[]> {
  const users = await db.user.findMany({ where: { active: true }, select: { id: true, name: true }, orderBy: { name: "asc" }, take: 300 });
  const allowed = await Promise.all(users.map(async (u) => ((await can(u.id, "inbox.view")) ? u : null)));
  return allowed.filter((u): u is { id: string; name: string } => !!u);
}
