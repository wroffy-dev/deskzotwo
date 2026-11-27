import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { changeRows } from "@/lib/copilot/lead-update";
import type { DisplayBlock, ProposalBlock } from "@/lib/copilot/types";

/**
 * Deskzo AI's chats as history (owner, 23 Nov 2026 — "proper history: the tenant admin can see all the chats, and each
 * employee's usage"). A person sees their own chats; deleting one hides it from them and keeps it for whoever holds
 * `copilot.review` (admins, by default), who read it on Settings › AI activity. Every such reading is recorded
 * (`copilot_reviews`) and listed on the same page. Before a workspace has 20261225200000_copilot_review, a deleted
 * chat is deleted outright, as it was, and nothing is recorded. Server only — no permission is checked here.
 */

export type ChatSegment = { kind: "text"; text: string } | { kind: "block"; block: DisplayBlock };
export type ChatItem = { role: "user"; text: string } | { role: "assistant"; segments: ChatSegment[] } | { role: "note"; text: string };

/** `work` with the hidden-chat column, or `fallback` in a workspace that hasn't had the migration yet. */
async function withHidden<T>(work: () => Promise<T>, fallback: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (notMigratedYet(err)) return fallback();
    throw err;
  }
}

/** A person's own chats, newest first — those they deleted left out. */
export function ownConversations(userId: string, take = 30) {
  const select = { id: true, title: true, updatedAt: true } as const;
  const orderBy = { updatedAt: "desc" } as const;
  return withHidden(
    () => db.copilotConversation.findMany({ where: { userId, hiddenAt: null }, orderBy, take, select }),
    () => db.copilotConversation.findMany({ where: { userId }, orderBy, take, select }),
  );
}

/** One of a person's own chats they haven't deleted, or null. */
export function ownConversation(id: string, userId: string) {
  const select = { id: true, title: true } as const;
  return withHidden(
    () => db.copilotConversation.findFirst({ where: { id, userId, hiddenAt: null }, select }),
    () => db.copilotConversation.findFirst({ where: { id, userId }, select }),
  );
}

/** A person deleting their own chat: hidden from them, kept for review. */
export async function hideConversation(id: string, userId: string): Promise<void> {
  await withHidden(
    () => db.copilotConversation.updateMany({ where: { id, userId, hiddenAt: null }, data: { hiddenAt: new Date() } }),
    () => db.copilotConversation.deleteMany({ where: { id, userId } }),
  );
}

/** A conversation as the chat shows it, its confirmation cards in their current state. `ownerId`: whose it is. */
export async function chatItemsOf(conversationId: string, ownerId: string): Promise<ChatItem[]> {
  const [messages, proposals] = await Promise.all([
    db.copilotMessage.findMany({ where: { conversationId }, orderBy: { createdAt: "asc" }, select: { role: true, content: true } }),
    db.copilotProposal.findMany({ where: { conversationId, userId: ownerId }, select: { id: true, kind: true, status: true, error: true, payload: true } }),
  ]);
  const state = new Map(proposals.map((p) => [p.id, p]));
  // Security audit, 13 Nov 2026 (A4): each card shows what will really be saved — read from the proposal itself, the
  // row Create acts on, so a card drawn before the fix shows it too.
  const assigneeIds = [...new Set(proposals.filter((p) => p.kind === "TASK").map((p) => String((p.payload as Record<string, unknown>)?.assignedToUserId ?? "")).filter(Boolean))];
  const names = new Map((assigneeIds.length ? await db.user.findMany({ where: { id: { in: assigneeIds } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u.name]));
  const detailsOf = (p: (typeof proposals)[number] | undefined): Pick<ProposalBlock, "details" | "assignee" | "changes"> => {
    if (!p) return {};
    if (p.kind === "LEAD_UPDATE") return { changes: changeRows(p.payload), assignee: null };
    const payload = (p.payload ?? {}) as Record<string, unknown>;
    if (p.kind === "LEAD") return { details: String(payload.card ?? ""), assignee: null };
    if (p.kind !== "TASK") return { details: String(payload.body ?? ""), assignee: null };
    const to = String(payload.assignedToUserId ?? "");
    return { details: String(payload.description ?? ""), assignee: { name: names.get(to) ?? "Somebody no longer here", other: to !== ownerId } };
  };
  const items: ChatItem[] = [];
  const reply = (): Extract<ChatItem, { role: "assistant" }> => {
    const last = items.at(-1);
    if (last?.role === "assistant") return last;
    const fresh = { role: "assistant" as const, segments: [] as ChatSegment[] };
    items.push(fresh);
    return fresh;
  };
  for (const m of messages) {
    const c = (m.content ?? {}) as Record<string, unknown>;
    if (m.role === "user") items.push({ role: "user", text: String(c.text ?? "") });
    else if (m.role === "note") items.push({ role: "note", text: String(c.text ?? "") });
    else if (m.role === "assistant" && String(c.text ?? "").trim()) reply().segments.push({ kind: "text", text: String(c.text) });
    else if (m.role === "tool") {
      for (const block of (c.blocks as DisplayBlock[]) ?? []) {
        if (block.type === "proposal") {
          const p = state.get(block.id);
          reply().segments.push({ kind: "block", block: { ...block, ...detailsOf(p), status: p?.status ?? "CANCELLED", error: p?.error ?? null } satisfies ProposalBlock });
        } else reply().segments.push({ kind: "block", block });
      }
    }
  }
  return items;
}

// ─── Review ──────────────────────────────────────────────────────────────────────────────────────

export type ReviewedChat = { id: string; title: string; createdAt: string; updatedAt: string; questions: number; deleted: boolean };

/** Every chat of `ownerId`'s, deleted ones too, newest first. */
export async function chatsOf(ownerId: string, take = 200): Promise<ReviewedChat[]> {
  const select = { id: true, title: true, createdAt: true, updatedAt: true, _count: { select: { messages: { where: { role: "user" } } } } } as const;
  const rows = await withHidden(
    async () => {
      const found = await db.copilotConversation.findMany({ where: { userId: ownerId }, orderBy: { updatedAt: "desc" }, take, select: { ...select, hiddenAt: true } });
      return found.map((r) => ({ ...r, deleted: r.hiddenAt !== null }));
    },
    async () => (await db.copilotConversation.findMany({ where: { userId: ownerId }, orderBy: { updatedAt: "desc" }, take, select })).map((r) => ({ ...r, deleted: false })),
  );
  return rows.map((r) => ({ id: r.id, title: r.title, createdAt: r.createdAt.toISOString(), updatedAt: r.updatedAt.toISOString(), questions: r._count.messages, deleted: r.deleted }));
}

/** A chat, read by an admin — recorded, unless it's their own. Null when it isn't there. */
export async function reviewChat(conversationId: string, reviewerId: string): Promise<{ id: string; title: string; ownerId: string; ownerName: string; deleted: boolean; items: ChatItem[] } | null> {
  const chat = await db.copilotConversation.findUnique({ where: { id: conversationId }, select: { id: true, title: true, userId: true, user: { select: { name: true } } } });
  if (!chat) return null;
  const deleted = await withHidden(
    async () => (await db.copilotConversation.findUnique({ where: { id: conversationId }, select: { hiddenAt: true } }))?.hiddenAt != null,
    async () => false,
  );
  if (chat.userId !== reviewerId) {
    await db.copilotReview.create({ data: { conversationId, ownerId: chat.userId, reviewerId } }).catch((err) => {
      if (!notMigratedYet(err)) throw err;
    });
  }
  return { id: chat.id, title: chat.title, ownerId: chat.userId, ownerName: chat.user.name, deleted, items: await chatItemsOf(chat.id, chat.userId) };
}

export type ReviewLogRow = { at: string; reviewer: string; owner: string; title: string };

/** Who read whose chats lately. */
export async function recentReviews(take = 25): Promise<ReviewLogRow[]> {
  let rows: { conversationId: string; ownerId: string; reviewerId: string; createdAt: Date }[];
  try {
    rows = await db.copilotReview.findMany({ orderBy: { createdAt: "desc" }, take, select: { conversationId: true, ownerId: true, reviewerId: true, createdAt: true } });
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
  if (!rows.length) return [];
  const [people, chats] = await Promise.all([
    db.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.ownerId, r.reviewerId]))] } }, select: { id: true, name: true } }),
    db.copilotConversation.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.conversationId))] } }, select: { id: true, title: true } }),
  ]);
  const name = new Map(people.map((p) => [p.id, p.name]));
  const title = new Map(chats.map((c) => [c.id, c.title]));
  return rows.map((r) => ({ at: r.createdAt.toISOString(), reviewer: name.get(r.reviewerId) ?? "Somebody no longer here", owner: name.get(r.ownerId) ?? "Somebody no longer here", title: title.get(r.conversationId) ?? "(chat removed)" }));
}

/** Per person since `from`: chats they had and questions they asked — from the chats themselves. */
export async function chatCounts(from: Date): Promise<Map<string, { chats: number; questions: number; lastAt: Date }>> {
  const rows = await db.copilotConversation.findMany({
    where: { updatedAt: { gte: from } },
    take: 20_000,
    select: { userId: true, updatedAt: true, _count: { select: { messages: { where: { role: "user", createdAt: { gte: from } } } } } },
  });
  const out = new Map<string, { chats: number; questions: number; lastAt: Date }>();
  for (const r of rows) {
    const u = out.get(r.userId) ?? { chats: 0, questions: 0, lastAt: r.updatedAt };
    u.chats += 1;
    u.questions += r._count.messages;
    if (r.updatedAt > u.lastAt) u.lastAt = r.updatedAt;
    out.set(r.userId, u);
  }
  return out;
}
