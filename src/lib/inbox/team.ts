import type { InboxAvailability } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { notifyUser } from "@/lib/notify";
import { mentionsIn } from "@/lib/chat/rules";
import { conversationRef, type InboxKind } from "@/lib/inbox/settings";
import { TEAM_LIMITS, cleanShortcut, normaliseTags } from "@/lib/inbox/team-rules";
import { NOT_FOUND, addMessage, announce, assignablePeople, visibleConversation, visibleWhere, type InboxViewer, type StaffResult } from "@/lib/inbox/server";

/**
 * The Customer inbox's team tools (owner, 24 Oct 2026): private notes with @mentions, tags, saved
 * replies, blocking a customer, and each person's availability. The conversation rules — who may read
 * which — are src/lib/inbox/server.ts's; whether a person may use the inbox, or change the workspace's
 * settings, is the caller's (src/actions/inbox.ts, src/actions/inbox-admin.ts).
 */

const NOT_READY = "This workspace is still being updated for that — try again in a few minutes.";

// ─── Private notes ───────────────────────────────────────────────────────────────────────────────

/**
 * A note to colleagues in a conversation: never sent, never in the bubble, not a reply (no response time,
 * the bot carries on). "@Priya Sharma" tells Priya — anybody who may read the conversation.
 */
export async function staffNote(viewer: InboxViewer, id: string, raw: string): Promise<StaffResult<{ told: number }>> {
  const text = raw.replace(/\r\n?/g, "\n").trim();
  if (!text) return { ok: false, error: "Write the note first." };
  if (text.length > TEAM_LIMITS.note) return { ok: false, error: `Keep a note under ${TEAM_LIMITS.note.toLocaleString("en-IN")} characters.` };
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  try {
    await addMessage(c.id, "NOTE", text, { userId: viewer.id });
  } catch {
    return { ok: false, error: NOT_READY };
  }
  // Whoever may read it: a shared channel's, everybody with the inbox; a rep's own number's, them, its assignee and those who see everything.
  const people = await assignablePeople();
  const readers: { id: string; name: string }[] = [];
  for (const p of people) {
    if (p.id === viewer.id) continue;
    if (c.channel.ownerUserId === null || p.id === c.channel.ownerUserId || p.id === c.assignedToUserId || (await can(p.id, "inbox.viewAll"))) readers.push(p);
  }
  const mentioned = mentionsIn(text, readers);
  if (mentioned.length) {
    const me = await db.user.findUnique({ where: { id: viewer.id }, select: { name: true } });
    const ref = conversationRef(c.seq);
    for (const userId of mentioned) {
      await notifyUser({ userId, type: "INBOX_MESSAGE", title: `${me?.name ?? "Somebody"} mentioned you in a customer conversation`, message: `${ref}: ${text.slice(0, 140)}`, link: `/inbox?c=${ref}` });
    }
  }
  await announce(c.id);
  return { ok: true, data: { told: mentioned.length } };
}

// ─── Tags ────────────────────────────────────────────────────────────────────────────────────────

/** The conversation's tags, all of them at once ("sales", "complaint"…). */
export async function setConversationTags(viewer: InboxViewer, id: string, input: readonly unknown[]): Promise<StaffResult<{ tags: string[] }>> {
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  const tags = normaliseTags(Array.isArray(input) ? input : []);
  try {
    await db.conversation.update({ where: { id: c.id }, data: { tags }, select: { id: true } });
  } catch {
    return { ok: false, error: NOT_READY };
  }
  await announce(c.id);
  return { ok: true, data: { tags } };
}

/** The tags in use on conversations this person may see, most used first — for the filter and suggestions. */
export async function tagsInUse(viewer: InboxViewer): Promise<string[]> {
  const rows = await db.conversation
    .findMany({ where: { AND: [visibleWhere(viewer), { tags: { isEmpty: false } }] }, select: { tags: true }, orderBy: { lastMessageAt: "desc" }, take: 2000 })
    .catch(() => []);
  const counts = new Map<string, number>();
  for (const r of rows) for (const t of r.tags) counts.set(t, (counts.get(t) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 60).map(([t]) => t);
}

// ─── Saved replies ───────────────────────────────────────────────────────────────────────────────

export type SavedReply = { id: string; shortcut: string; title: string; body: string };

export async function savedReplies(): Promise<SavedReply[]> {
  return db.inboxSavedReply.findMany({ orderBy: { shortcut: "asc" }, select: { id: true, shortcut: true, title: true, body: true }, take: TEAM_LIMITS.replies }).catch(() => []);
}

/** A saved reply, new or changed. Its shortcut is how it's typed after "/" — each one once. */
export async function saveSavedReply(by: { id: string }, input: { id?: string | null; shortcut: unknown; title: unknown; body: unknown }): Promise<StaffResult<SavedReply>> {
  const shortcut = cleanShortcut(input.shortcut);
  if (!shortcut) return { ok: false, error: "Give it a shortcut of letters, digits and hyphens — what you'll type after “/”." };
  const title = String(input.title ?? "").replace(/\s+/g, " ").trim();
  if (!title || title.length > TEAM_LIMITS.replyTitle) return { ok: false, error: `Name it, in under ${TEAM_LIMITS.replyTitle} characters.` };
  const body = String(input.body ?? "").replace(/\r\n?/g, "\n").trim();
  if (!body || body.length > TEAM_LIMITS.replyBody) return { ok: false, error: `Write the reply, in under ${TEAM_LIMITS.replyBody.toLocaleString("en-IN")} characters.` };
  try {
    const taken = await db.inboxSavedReply.findUnique({ where: { shortcut }, select: { id: true } });
    if (taken && taken.id !== input.id) return { ok: false, error: `“/${shortcut}” is another reply's shortcut already.` };
    if (input.id) {
      const row = await db.inboxSavedReply.update({ where: { id: input.id }, data: { shortcut, title, body }, select: { id: true, shortcut: true, title: true, body: true } }).catch(() => null);
      return row ? { ok: true, data: row } : { ok: false, error: "That reply isn't there any more." };
    }
    if ((await db.inboxSavedReply.count()) >= TEAM_LIMITS.replies) return { ok: false, error: `There can be ${TEAM_LIMITS.replies} saved replies — remove one first.` };
    const row = await db.inboxSavedReply.create({ data: { shortcut, title, body, createdById: by.id }, select: { id: true, shortcut: true, title: true, body: true } });
    return { ok: true, data: row };
  } catch (err) {
    if ((err as { code?: string }).code === "P2002") return { ok: false, error: `“/${shortcut}” is another reply's shortcut already.` };
    return { ok: false, error: NOT_READY };
  }
}

export async function deleteSavedReply(id: string): Promise<StaffResult> {
  const gone = await db.inboxSavedReply.deleteMany({ where: { id } }).catch(() => ({ count: 0 }));
  return gone.count ? { ok: true, data: null } : { ok: false, error: "That reply isn't there any more." };
}

// ─── Blocking ────────────────────────────────────────────────────────────────────────────────────

export type BlockRow = { id: string; kind: InboxKind; label: string | null; reason: string | null; createdAt: string; by: string | null };

/**
 * A customer blocked (owner, 24 Oct 2026: "blocking spam visitors"): a website visitor by their browser's
 * token, a WhatsApp number by itself. Their messages go nowhere after this, and the conversation closes.
 * A visitor who clears their browser comes back as a stranger — it stops a nuisance, not a determined one.
 */
export async function blockCustomer(viewer: InboxViewer, id: string, rawReason: string | null): Promise<StaffResult> {
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  const value = c.kind === "WEB" ? c.visitorTokenHash : c.waId;
  if (!value) return { ok: false, error: "There's nothing to block them by." };
  const reason = rawReason?.replace(/\s+/g, " ").trim().slice(0, TEAM_LIMITS.blockReason) || null;
  const label = (c.customerName || c.customerPhone || c.customerEmail || (c.kind === "WEB" ? `Website visitor, ${conversationRef(c.seq)}` : null))?.slice(0, 120) ?? null;
  try {
    await db.inboxBlock.upsert({ where: { kind_value: { kind: c.kind, value } }, create: { kind: c.kind, value, label, reason, createdById: viewer.id }, update: { reason, label } });
  } catch {
    return { ok: false, error: NOT_READY };
  }
  const me = await db.user.findUnique({ where: { id: viewer.id }, select: { name: true } });
  await db.conversation.update({ where: { id: c.id }, data: { status: "CLOSED", closedAt: new Date(), botActive: false } });
  await addMessage(c.id, "SYSTEM", `${me?.name ?? "Somebody"} blocked them${reason ? `: ${reason}` : ""}`, { userId: viewer.id });
  await announce(c.id);
  return { ok: true, data: null };
}

/** The customer in this conversation, unblocked. */
export async function unblockCustomer(viewer: InboxViewer, id: string): Promise<StaffResult> {
  const c = await visibleConversation(viewer, id);
  if (!c) return { ok: false, error: NOT_FOUND };
  const value = c.kind === "WEB" ? c.visitorTokenHash : c.waId;
  if (!value) return { ok: true, data: null };
  const gone = await db.inboxBlock.deleteMany({ where: { kind: c.kind, value } }).catch(() => ({ count: 0 }));
  if (gone.count) {
    const me = await db.user.findUnique({ where: { id: viewer.id }, select: { name: true } });
    await addMessage(c.id, "SYSTEM", `${me?.name ?? "Somebody"} unblocked them`, { userId: viewer.id });
    await announce(c.id);
  }
  return { ok: true, data: null };
}

/** Everybody blocked, newest first — for Settings › Customer inbox. */
export async function blockedCustomers(): Promise<BlockRow[]> {
  const rows = await db.inboxBlock.findMany({ orderBy: { createdAt: "desc" }, take: 500, select: { id: true, kind: true, label: true, reason: true, createdAt: true, createdById: true } }).catch(() => []);
  const ids = [...new Set(rows.map((r) => r.createdById).filter((v): v is string => !!v))];
  const names = new Map((await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return rows.map((r) => ({ id: r.id, kind: r.kind as InboxKind, label: r.label, reason: r.reason, createdAt: r.createdAt.toISOString(), by: r.createdById ? (names.get(r.createdById) ?? null) : null }));
}

/** One block lifted, from the settings list. */
export async function removeBlock(id: string): Promise<StaffResult> {
  const gone = await db.inboxBlock.deleteMany({ where: { id } }).catch(() => ({ count: 0 }));
  return gone.count ? { ok: true, data: null } : { ok: false, error: "That block isn't there any more." };
}

// ─── Availability ────────────────────────────────────────────────────────────────────────────────

/** Asked of the database once a minute at most per person, however often their screens ask. */
const TOUCH_EVERY_MS = 60_000;
const touched = new Map<string, number>();

/**
 * This person is in Deskzo now — every open screen says so as it checks the inbox — so round-robin may
 * give them a conversation (src/lib/inbox/server.ts `availableOf`). Never throws.
 */
export async function touchActive(userId: string, now = Date.now()): Promise<void> {
  if (now - (touched.get(userId) ?? 0) < TOUCH_EVERY_MS) return;
  touched.set(userId, now);
  await db.inboxAgentStatus.upsert({ where: { userId }, create: { userId, lastActiveAt: new Date(now) }, update: { lastActiveAt: new Date(now) } }).catch(() => {});
}

/** Whether this person is taking customer conversations: available unless they said they're away. */
export async function availabilityOf(userId: string): Promise<InboxAvailability> {
  return (await db.inboxAgentStatus.findUnique({ where: { userId }, select: { status: true } }).catch(() => null))?.status ?? "ONLINE";
}

export async function setAvailability(userId: string, status: InboxAvailability): Promise<StaffResult> {
  try {
    await db.inboxAgentStatus.upsert({ where: { userId }, create: { userId, status, lastActiveAt: new Date() }, update: { status, lastActiveAt: new Date() } });
  } catch {
    return { ok: false, error: NOT_READY };
  }
  touched.set(userId, Date.now());
  return { ok: true, data: null };
}
