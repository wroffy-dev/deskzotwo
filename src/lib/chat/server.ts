import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { tenantKey } from "@/lib/tenancy/cache";
import { isListening, publish } from "@/lib/chat/bus";
import { isMuted, previewOf } from "@/lib/chat/rules";
import type { ChatMemberView, ChatMessageView, ChatPinView, ChatReactionView, ChatSummary } from "@/lib/chat/types";

/**
 * Team chat's reads and writes that the actions, the live stream and the files route share. Server
 * only — never exported from a "use server" file.
 *
 * ## Who reads a chat
 *
 * Its members, and nobody else (owner, 15 Oct 2026). There is no admin view of other people's chats:
 * the super admin may export one named chat, which is recorded (src/app/api/chat/export). A member
 * reads from the moment they joined; one who left or was removed keeps what was said up to then.
 */

// ─── Settings ─────────────────────────────────────────────────────────────────────────────────────

export type ChatSettingsShape = {
  attachmentsAllowed: boolean;
  emojiAllowed: boolean;
  reactionsAllowed: boolean;
  importantAllowed: boolean;
  attachmentsViewOnly: boolean;
  retentionDays: number | null;
};
export const CHAT_SETTINGS_DEFAULTS: ChatSettingsShape = {
  attachmentsAllowed: true,
  emojiAllowed: true,
  reactionsAllowed: true,
  importantAllowed: true,
  attachmentsViewOnly: false,
  retentionDays: null,
};

/** The workspace's chat rules; the defaults when none were saved, or before the table exists. */
export async function chatSettings(): Promise<ChatSettingsShape> {
  try {
    const row = await db.chatSettings.findUnique({ where: { id: "global" } });
    return row
      ? {
          attachmentsAllowed: row.attachmentsAllowed,
          emojiAllowed: row.emojiAllowed,
          reactionsAllowed: row.reactionsAllowed,
          importantAllowed: row.importantAllowed,
          attachmentsViewOnly: row.attachmentsViewOnly,
          retentionDays: row.retentionDays,
        }
      : { ...CHAT_SETTINGS_DEFAULTS };
  } catch (err) {
    if (notMigratedYet(err)) return { ...CHAT_SETTINGS_DEFAULTS };
    throw err;
  }
}

// ─── Membership ───────────────────────────────────────────────────────────────────────────────────

export type Membership = Prisma.ChatMemberGetPayload<{ include: { chat: true } }>;

/** This person's place in a chat — current or past — or null when they were never in it. */
export async function membershipOf(chatId: string, userId: string): Promise<Membership | null> {
  if (!chatId) return null;
  return db.chatMember.findUnique({ where: { chatId_userId: { chatId, userId } }, include: { chat: true } });
}

/** The part of a chat a member may read: from joining, up to leaving. */
export function visibleTo(member: { joinedAt: Date; leftAt: Date | null }): Prisma.ChatMessageWhereInput {
  return { createdAt: member.leftAt ? { gte: member.joinedAt, lte: member.leftAt } : { gte: member.joinedAt } };
}

/** The people still in a chat. */
export async function currentMemberIds(chatId: string): Promise<string[]> {
  const rows = await db.chatMember.findMany({ where: { chatId, leftAt: null }, select: { userId: true } });
  return rows.map((r) => r.userId);
}

// ─── Views ────────────────────────────────────────────────────────────────────────────────────────

export const messageInclude = {
  sender: { select: { name: true } },
  attachments: { select: { id: true, fileName: true, mimeType: true, size: true }, orderBy: { createdAt: "asc" } },
  replyTo: { select: { id: true, body: true, createdAt: true, deletedAt: true, sender: { select: { name: true } }, _count: { select: { attachments: true } } } },
} satisfies Prisma.ChatMessageInclude;

export type MessageRow = Prisma.ChatMessageGetPayload<{ include: typeof messageInclude }>;

/** The part of a chat one member may read: from joining, up to leaving (as `visibleTo`). */
export type ReaderWindow = { joinedAt: Date; leftAt: Date | null };

function insideWindow(at: Date, reader: ReaderWindow): boolean {
  return at >= reader.joinedAt && (!reader.leftAt || at <= reader.leftAt);
}

/**
 * The quoted message on a reply, as this reader may see it. Security audit round two, 13 Nov 2026 (low, chat): a reply
 * to something said before the reader joined (or after they left) showed up to 200 characters of it, though the
 * message itself is outside what they may read. Such a quote is now blank — no text, no name, no file count. With no
 * reader known (null), the quote is blank too.
 */
function quoteOf(row: MessageRow, reader: ReaderWindow | null): ChatMessageView["replyTo"] {
  if (!row.replyTo) return null;
  if (!reader || !insideWindow(row.replyTo.createdAt, reader)) {
    return { id: row.replyTo.id, senderName: null, body: "", deleted: false, attachmentCount: 0 };
  }
  return {
    id: row.replyTo.id,
    senderName: row.replyTo.sender?.name ?? null,
    body: row.replyTo.deletedAt ? "" : row.replyTo.body.slice(0, 200),
    deleted: !!row.replyTo.deletedAt,
    attachmentCount: row.replyTo._count.attachments,
  };
}

/** The same message as another reader sees it: only the quote can differ. For live events built per recipient. */
export function viewFor(view: ChatMessageView, row: MessageRow, reader: ReaderWindow | null): ChatMessageView {
  return { ...view, replyTo: quoteOf(row, reader) };
}

/** A message as `reader` sees it — the member whose screen it is going to (see `quoteOf`). */
export function toMessageView(row: MessageRow, reader: ReaderWindow | null): ChatMessageView {
  const deleted = !!row.deletedAt;
  return {
    id: row.id,
    chatId: row.chatId,
    kind: row.kind,
    senderId: row.senderId,
    senderName: row.sender?.name ?? null,
    body: deleted ? "" : row.body,
    replyTo: quoteOf(row, reader),
    attachments: deleted ? [] : row.attachments,
    mentionIds: row.mentionIds,
    reactions: [],
    editedAt: row.editedAt?.toISOString() ?? null,
    deletedAt: row.deletedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function messageView(id: string, reader: ReaderWindow | null): Promise<ChatMessageView | null> {
  const row = await db.chatMessage.findUnique({ where: { id }, include: messageInclude });
  return row ? (await withReactions([toMessageView(row, reader)]))[0]! : null;
}

// ─── Reactions and pins ───────────────────────────────────────────────────────────────────────────
// Read apart from the messages, in their own tables: a workspace whose database hasn't reached them
// yet (Coolify migrates after a deploy) still chats, just without them.

/** Each message's reactions, grouped by emoji in the order first chosen. */
export async function reactionsOf(messageIds: string[]): Promise<Map<string, ChatReactionView[]>> {
  const out = new Map<string, ChatReactionView[]>();
  if (messageIds.length === 0) return out;
  try {
    const rows = await db.chatReaction.findMany({ where: { messageId: { in: messageIds } }, orderBy: { createdAt: "asc" }, select: { messageId: true, userId: true, emoji: true } });
    for (const r of rows) {
      const list = out.get(r.messageId) ?? [];
      const group = list.find((g) => g.emoji === r.emoji);
      if (group) group.userIds.push(r.userId);
      else list.push({ emoji: r.emoji, userIds: [r.userId] });
      out.set(r.messageId, list);
    }
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  return out;
}

/** These messages, with their reactions. */
export async function withReactions(views: ChatMessageView[]): Promise<ChatMessageView[]> {
  const byMessage = await reactionsOf(views.filter((v) => !v.deletedAt).map((v) => v.id));
  return views.map((v) => ({ ...v, reactions: byMessage.get(v.id) ?? [] }));
}

/** A chat's pins that this member can read — newest pinned first. */
export async function pinsOf(chatId: string, member: { joinedAt: Date; leftAt: Date | null }): Promise<ChatPinView[]> {
  try {
    const rows = await db.chatPin.findMany({
      where: { chatId, message: { deletedAt: null, ...visibleTo(member) } },
      orderBy: { pinnedAt: "desc" },
      select: {
        messageId: true,
        pinnedAt: true,
        pinnedBy: { select: { name: true } },
        message: { select: { body: true, createdAt: true, sender: { select: { name: true } }, _count: { select: { attachments: true } } } },
      },
    });
    return rows.map((r) => ({
      messageId: r.messageId,
      pinnedAt: r.pinnedAt.toISOString(),
      pinnedByName: r.pinnedBy?.name ?? null,
      senderName: r.message.sender?.name ?? null,
      body: r.message.body.slice(0, 200),
      attachmentCount: r.message._count.attachments,
      createdAt: r.message.createdAt.toISOString(),
    }));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** Everyone who is or was in a chat, with their reading positions — what the ticks are worked out from. */
export async function membersView(chatId: string): Promise<ChatMemberView[]> {
  const rows = await db.chatMember.findMany({
    where: { chatId },
    select: {
      userId: true,
      isAdmin: true,
      joinedAt: true,
      leftAt: true,
      lastDeliveredAt: true,
      lastReadAt: true,
      user: { select: { name: true, photoUpdatedAt: true } },
    },
    orderBy: { joinedAt: "asc" },
  });
  return rows.map((r) => ({
    userId: r.userId,
    name: r.user.name,
    photoUpdatedAt: r.user.photoUpdatedAt?.toISOString() ?? null,
    isAdmin: r.isAdmin,
    joinedAt: r.joinedAt.toISOString(),
    leftAt: r.leftAt?.toISOString() ?? null,
    lastDeliveredAt: r.lastDeliveredAt?.toISOString() ?? null,
    lastReadAt: r.lastReadAt?.toISOString() ?? null,
  }));
}

// ─── The list ─────────────────────────────────────────────────────────────────────────────────────

type LastRow = { chatId: string; kind: string; body: string; deletedAt: Date | null; senderId: string | null; senderName: string | null; attachmentCount: number };
type UnreadRow = { chatId: string; unread: number; mentioned: boolean };

/**
 * A person's chats, newest first — or just these chats. A direct chat nobody has written in yet is
 * listed only for whoever opened it, so the other person never finds an empty conversation.
 */
/**
 * When each group's picture was last set (owner, 26 Oct 2026), by chat — read beside the list, never joined into
 * it, and any failure (a workspace not migrated yet) is no pictures: initials, never a chat list that fails.
 */
export async function groupIconStamps(chatIds: string[]): Promise<Map<string, string>> {
  if (chatIds.length === 0) return new Map();
  try {
    const rows = await db.chatIcon.findMany({ where: { chatId: { in: chatIds } }, select: { chatId: true, updatedAt: true } });
    return new Map(rows.map((r) => [r.chatId, r.updatedAt.toISOString()]));
  } catch (err) {
    if (!notMigratedYet(err)) console.error("chat: couldn't read the groups' pictures", err);
    return new Map();
  }
}

export async function summariesFor(userId: string, onlyChatIds?: string[]): Promise<ChatSummary[]> {
  const memberships = await db.chatMember.findMany({
    where: { userId, ...(onlyChatIds ? { chatId: { in: onlyChatIds } } : {}) },
    select: {
      chatId: true,
      isAdmin: true,
      leftAt: true,
      mutedUntil: true,
      chat: {
        select: {
          kind: true,
          name: true,
          createdById: true,
          lastMessageAt: true,
          createdAt: true,
          members: {
            where: { leftAt: null },
            select: { userId: true, user: { select: { name: true, photoUpdatedAt: true, active: true } } },
          },
        },
      },
    },
  });
  const listed = memberships.filter((m) => m.chat.kind === "GROUP" || m.chat.lastMessageAt || m.chat.createdById === userId);
  if (listed.length === 0) return [];
  const chatIds = listed.map((m) => m.chatId);

  const [lastRows, unreadRows, icons] = await Promise.all([
    db.$queryRaw<LastRow[]>`
      select m."chatId", last.kind, last.body, last."deletedAt", last."senderId", last."senderName", last."attachmentCount"
      from chat_members m
      cross join lateral (
        select msg.kind::text as kind, msg.body, msg."deletedAt", msg."senderId", u.name::text as "senderName",
          (select count(*)::int from chat_attachments a where a."messageId" = msg.id) as "attachmentCount"
        from chat_messages msg
        left join users u on u.id = msg."senderId"
        where msg."chatId" = m."chatId" and msg."createdAt" >= m."joinedAt" and (m."leftAt" is null or msg."createdAt" <= m."leftAt")
        order by msg."createdAt" desc
        limit 1
      ) last
      where m."userId" = ${userId} and m."chatId" in (${Prisma.join(chatIds)})`,
    unreadFor(userId, chatIds),
    groupIconStamps(listed.filter((m) => m.chat.kind === "GROUP").map((m) => m.chatId)),
  ]);
  const lastBy = new Map(lastRows.map((r) => [r.chatId, r]));
  const unreadBy = new Map(unreadRows.map((r) => [r.chatId, r]));

  return listed
    .map((m): ChatSummary => {
      const other = m.chat.kind === "DIRECT" ? m.chat.members.find((x) => x.userId !== userId) ?? null : null;
      const last = lastBy.get(m.chatId) ?? null;
      const unread = unreadBy.get(m.chatId);
      return {
        id: m.chatId,
        kind: m.chat.kind,
        title: m.chat.kind === "GROUP" ? m.chat.name ?? "Group" : other?.user.name ?? "Former colleague",
        otherUserId: other?.userId ?? null,
        otherPhotoUpdatedAt: other?.user.photoUpdatedAt?.toISOString() ?? null,
        iconUpdatedAt: icons.get(m.chatId) ?? null,
        otherActive: other?.user.active ?? false,
        memberCount: m.chat.members.length,
        preview: previewOf(last, { group: m.chat.kind === "GROUP", mine: !!last && last.senderId === userId }),
        lastMessageAt: (m.chat.lastMessageAt ?? m.chat.createdAt).toISOString(),
        unread: unread?.unread ?? 0,
        mentioned: unread?.mentioned ?? false,
        mutedUntil: m.mutedUntil?.toISOString() ?? null,
        isAdmin: m.isAdmin,
        left: !!m.leftAt,
      };
    })
    .sort((a, b) => (b.lastMessageAt ?? "").localeCompare(a.lastMessageAt ?? ""));
}

/** Unread messages per chat — other people's, since this person last read it — and whether any @mentions them. */
async function unreadFor(userId: string, chatIds?: string[]): Promise<UnreadRow[]> {
  const only = chatIds ? Prisma.sql`and m."chatId" in (${Prisma.join(chatIds)})` : Prisma.empty;
  return db.$queryRaw<UnreadRow[]>`
    select m."chatId", count(msg.id)::int as unread, coalesce(bool_or(${userId} = any(msg."mentionIds")), false) as mentioned
    from chat_members m
    join chat_messages msg on msg."chatId" = m."chatId"
    where m."userId" = ${userId} ${only}
      and msg."createdAt" > coalesce(m."lastReadAt", m."joinedAt")
      and msg."createdAt" >= m."joinedAt"
      and (m."leftAt" is null or msg."createdAt" <= m."leftAt")
      and msg.kind = 'TEXT'
      and msg."deletedAt" is null
      and (msg."senderId" is null or msg."senderId" <> ${userId})
    group by m."chatId"`;
}

/**
 * The number on the chat button: unread messages in chats that aren't muted, and in muted ones only
 * those that @mention this person. Zero, never an error, before the tables exist.
 */
export async function unreadTotal(userId: string): Promise<number> {
  try {
    const [rows, muted] = await Promise.all([
      unreadFor(userId),
      db.chatMember.findMany({ where: { userId, mutedUntil: { gt: new Date() } }, select: { chatId: true } }),
    ]);
    const mutedIds = new Set(muted.map((m) => m.chatId));
    return rows.reduce((t, r) => t + (mutedIds.has(r.chatId) ? (r.mentioned ? 1 : 0) : r.unread), 0);
  } catch (err) {
    if (notMigratedYet(err)) return 0;
    throw err;
  }
}

// ─── Delivery and reading ─────────────────────────────────────────────────────────────────────────

/** Tells a chat's members that one of them has got further through it. */
export async function announceReceipt(chatId: string, member: { userId: string; lastDeliveredAt: Date | null; lastReadAt: Date | null }) {
  await publish(await currentMemberIds(chatId), {
    type: "receipt",
    chatId,
    userId: member.userId,
    lastDeliveredAt: member.lastDeliveredAt?.toISOString() ?? null,
    lastReadAt: member.lastReadAt?.toISOString() ?? null,
  });
}

/**
 * Chat opened somewhere (a tab, the rail): everything sent to this person while they were away has now
 * reached them — the second grey tick on the sender's side.
 */
export async function deliverPending(userId: string): Promise<void> {
  const rows = await db.chatMember.findMany({
    where: { userId, leftAt: null, chat: { lastMessageAt: { not: null } } },
    select: { chatId: true, lastDeliveredAt: true, lastReadAt: true, chat: { select: { lastMessageAt: true } } },
  });
  const behind = rows.filter((r) => !r.lastDeliveredAt || r.lastDeliveredAt < r.chat.lastMessageAt!);
  if (behind.length === 0) return;
  const now = new Date();
  await db.chatMember.updateMany({ where: { userId, chatId: { in: behind.map((b) => b.chatId) } }, data: { lastDeliveredAt: now } });
  for (const b of behind) await announceReceipt(b.chatId, { userId, lastDeliveredAt: now, lastReadAt: b.lastReadAt });
}

/** A message just sent has reached everyone in the chat who has it open: their delivery moves to now. */
export async function deliverToListening(chatId: string, memberIds: string[], senderId: string): Promise<void> {
  const tenantId = await tenantKey();
  const listening = memberIds.filter((id) => id !== senderId && isListening(tenantId, id));
  if (listening.length === 0) return;
  const now = new Date();
  await db.chatMember.updateMany({ where: { chatId, userId: { in: listening } }, data: { lastDeliveredAt: now } });
  const rows = await db.chatMember.findMany({ where: { chatId, userId: { in: listening } }, select: { userId: true, lastDeliveredAt: true, lastReadAt: true } });
  for (const r of rows) await announceReceipt(chatId, r);
}

/** "Last seen" for somebody who has just closed their last chat window. Never throws. */
export async function recordLastSeen(userId: string, at: Date): Promise<void> {
  try {
    await db.chatPresence.upsert({ where: { userId }, create: { userId, lastSeenAt: at }, update: { lastSeenAt: at } });
  } catch {
    // Only "last seen" is lost.
  }
}

/** When each of these people last had chat open, for those not online now. */
export async function lastSeenOf(userIds: string[]): Promise<Record<string, string>> {
  if (userIds.length === 0) return {};
  try {
    const rows = await db.chatPresence.findMany({ where: { userId: { in: userIds } } });
    return Object.fromEntries(rows.map((r) => [r.userId, r.lastSeenAt.toISOString()]));
  } catch (err) {
    if (notMigratedYet(err)) return {};
    throw err;
  }
}

// ─── Lines the app writes ─────────────────────────────────────────────────────────────────────────

/** "Asha added Ravi": a line in the chat from the app itself, sent to its members like any message. */
export async function postSystemLine(chatId: string, text: string, extraRecipients: string[] = []): Promise<void> {
  const row = await db.chatMessage.create({ data: { chatId, kind: "SYSTEM", body: text }, include: messageInclude });
  await db.chat.update({ where: { id: chatId }, data: { lastMessageAt: row.createdAt } });
  // A line the app writes quotes nothing, so there is no quote to show or hide.
  const message = toMessageView(row, null);
  const members = await currentMemberIds(chatId);
  await publish([...members, ...extraRecipients], { type: "message", message, muted: true, mentioned: false });
}

/** Whether a chat is muted for this member now (an @mention still counts). */
export function mutedFor(member: { mutedUntil: Date | null }): boolean {
  return isMuted(member.mutedUntil);
}
