"use server";

import { db } from "@/lib/db";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { toPlain } from "@/lib/serialize";
import { featureLabel } from "@/lib/ai/catalogue";
import { monthOf, usageBreakdown, type UsageRow } from "@/lib/ai/credits";
import { chatCounts, chatsOf, recentReviews, reviewChat, type ChatItem, type ReviewLogRow, type ReviewedChat } from "@/lib/copilot/review";
import { currentTenant } from "@/lib/tenancy/resolve";
import { workspaceClock } from "@/lib/time/workspace";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › AI activity (owner, 23 Nov 2026 — "the tenant admin can see all the chats, and each employee's usage, on a
 * proper dashboard"): for whoever holds `copilot.review` — admins and the super admin by default. Never while viewing
 * as somebody: a review is made, and recorded, as yourself.
 */

async function reviewer() {
  const user = await requireUser();
  if (await refuseWhileViewingAs()) return null;
  return (await can(user.id, "copilot.review")) ? user : null;
}

export type AiActivityPerson = { userId: string; name: string; questions: number; chats: number; credits: number; today: number; lastAt: string | null };

export type AiActivity = {
  /** "November 2026" — the workspace's month so far. */
  month: string;
  totals: { credits: number; questions: number; people: number; chats: number };
  people: AiActivityPerson[];
  /** Credits by what Deskzo AI did — chat, research, emails… */
  features: { label: string; credits: number; turns: number }[];
  reviews: ReviewLogRow[];
};

export async function getAiActivity(): Promise<AiActivity | null> {
  const user = await reviewer();
  if (!user) return null;
  const tenant = await currentTenant();
  const now = new Date();
  const month = monthOf(tenant, now);
  const clock = await workspaceClock();
  const todayFrom = clock.startOfDay(clock.dateKey(now))!;
  // The credit ledger is the console's; a workspace without one shows its chats alone.
  const ledger = (from: Date): Promise<UsageRow[]> => usageBreakdown(tenant.id, from, month.to).catch(() => []);
  const [monthRows, todayRows, counts, reviews] = await Promise.all([ledger(month.from), ledger(todayFrom), chatCounts(month.from), recentReviews()]);

  const people = new Map<string, AiActivityPerson>();
  const person = (userId: string) => {
    let p = people.get(userId);
    if (!p) people.set(userId, (p = { userId, name: "", questions: 0, chats: 0, credits: 0, today: 0, lastAt: null }));
    return p;
  };
  const features = new Map<string, { label: string; credits: number; turns: number }>();
  for (const r of monthRows) {
    person(r.userId).credits += r.credits;
    const f = features.get(r.feature) ?? { label: featureLabel(r.feature), credits: 0, turns: 0 };
    f.credits += r.credits;
    f.turns += r.turns;
    features.set(r.feature, f);
  }
  for (const r of todayRows) person(r.userId).today += r.credits;
  for (const [userId, c] of counts) {
    const p = person(userId);
    p.chats = c.chats;
    p.questions = c.questions;
    p.lastAt = c.lastAt.toISOString();
  }
  const names = people.size ? await db.user.findMany({ where: { id: { in: [...people.keys()] } }, select: { id: true, name: true } }) : [];
  for (const n of names) person(n.id).name = n.name;
  const list = [...people.values()].map((p) => ({ ...p, name: p.name || "Somebody no longer here" })).sort((a, b) => b.credits - a.credits || b.questions - a.questions);

  return toPlain({
    month: new Intl.DateTimeFormat("en-IN", { month: "long", year: "numeric", timeZone: clock.zone }).format(now),
    totals: {
      credits: list.reduce((s, p) => s + p.credits, 0),
      questions: list.reduce((s, p) => s + p.questions, 0),
      people: list.filter((p) => p.questions > 0 || p.credits > 0).length,
      chats: list.reduce((s, p) => s + p.chats, 0),
    },
    people: list,
    features: [...features.values()].sort((a, b) => b.credits - a.credits),
    reviews,
  });
}

/** Every chat of one person's, deleted ones too. */
export async function getChatsOf(userId: string): Promise<ActionResult<ReviewedChat[]>> {
  if (!(await reviewer())) return { ok: false, error: "You can't review Deskzo AI's chats." };
  if (typeof userId !== "string" || !userId) return { ok: false, error: "Choose a person." };
  return { ok: true, data: toPlain(await chatsOf(userId)) };
}

/** One chat, read in full — and recorded as read by you. */
export async function openReviewedChat(conversationId: string): Promise<ActionResult<{ id: string; title: string; ownerName: string; deleted: boolean; items: ChatItem[] }>> {
  const user = await reviewer();
  if (!user) return { ok: false, error: "You can't review Deskzo AI's chats." };
  if (typeof conversationId !== "string" || !conversationId) return { ok: false, error: "That chat isn't there any more." };
  const chat = await reviewChat(conversationId, user.id);
  if (!chat) return { ok: false, error: "That chat isn't there any more." };
  return { ok: true, data: toPlain({ id: chat.id, title: chat.title, ownerName: chat.ownerName, deleted: chat.deleted, items: chat.items }) };
}
