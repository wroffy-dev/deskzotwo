import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { moduleAccessFor } from "@/lib/modules-access";
import { notMigratedYet } from "@/lib/not-migrated";
import { listConversations, visibleWhere, type InboxViewer } from "@/lib/inbox/server";

/**
 * Kabir, the front desk, seen working (owner, 19 Nov 2026 — phase 3): the customer conversations the inbox's bot is
 * answering right now, and how many it answered and handed to a person today. Read from the Customer inbox's own rows,
 * through its own rule for who sees which conversation (`visibleWhere`) — so the Team room shows a person exactly the
 * chats their Inbox would, and nothing to somebody the inbox isn't open to.
 */

/** A chat counts as going while the bot has it and something was said this recently, or the visitor is on the page. */
const LIVE_MS = 15 * 60_000;

export type KabirChat = {
  id: string;
  /** The conversation's own reference, for /inbox?c=. */
  ref: string;
  channel: string;
  customer: string;
  preview: string;
  /** The customer spoke last: the bot is answering. */
  answering: boolean;
  online: boolean;
  at: string;
};

export type KabirLive = { chats: KabirChat[]; answeredToday: number; handedToday: number };

/** The person as the inbox sees them, or null when it isn't theirs to use. */
export async function inboxViewerFor(userId: string): Promise<InboxViewer | null> {
  if ((await moduleAccessFor(userId, "inbox")) !== "available") return null;
  if (!(await can(userId, "inbox.view"))) return null;
  return { id: userId, viewAll: await can(userId, "inbox.viewAll") };
}

export async function kabirLiveFor(userId: string, since: Date, now = new Date()): Promise<KabirLive | null> {
  try {
    const viewer = await inboxViewerFor(userId);
    if (!viewer) return null;
    const [open, answered] = await Promise.all([
      listConversations(viewer, { view: "open" }),
      db.conversation.findMany({ where: { AND: [visibleWhere(viewer), { messages: { some: { author: "BOT", createdAt: { gte: since } } } }] }, select: { botActive: true }, take: 2000 }),
    ]);
    const chats = open
      .filter((c) => c.botActive && (c.online || now.getTime() - new Date(c.lastMessageAt).getTime() < LIVE_MS))
      .slice(0, 5)
      .map((c) => ({ id: c.id, ref: c.ref, channel: c.channelName, customer: c.customer, preview: c.preview.slice(0, 140), answering: c.lastFrom === "CUSTOMER", online: c.online, at: c.lastMessageAt }));
    return { chats, answeredToday: answered.length, handedToday: answered.filter((c) => !c.botActive).length };
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}
