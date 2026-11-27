import { db } from "@/lib/db";
import { viewersAmong } from "@/lib/smart-lists/access";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/not-migrated";
import { mentionsIn } from "@/lib/chat/rules";

/**
 * Comments on a row of a list of its own (owner, 20 Nov 2026 — Smart Lists phase 3: "Comments on lists with rows of
 * their own; you can @mention someone, and they're notified"). A mention is "@Full Name" in the text — chat's rule
 * (src/lib/chat/rules.ts `mentionsIn`) — matched only against the people who may open the list, so nobody is
 * mentioned into a list they can't see. A mentioned person is told who and where, never the comment itself
 * (SMART_LIST_MENTION). Comments on a list of companies stay Deskzo Connect's (src/lib/connect/working.ts). Server only.
 */

export const COMMENT_MAX = 2000;

/** `team`: a guest author's team, or the one team a shared staff comment went to (Deskzo Connect). */
export type OwnRowComment = { id: string; body: string; author: string | null; mine: boolean; byGuest: boolean; shared: boolean; at: string; team?: string | null };

/** The teams of guests a list is shared with now — who a shared comment can be meant for. */
export async function listTeams(workbookId: string, now = new Date()): Promise<{ id: string; name: string }[]> {
  const shares = await db.listShare.findMany({ where: { workbookId, revokedAt: null, OR: [{ until: null }, { until: { gt: now } }] }, select: { guest: { select: { connection: { select: { id: true, name: true } } } } } }).catch(() => []);
  const seen = new Map(shares.map((s) => [s.guest.connection.id, s.guest.connection.name]));
  return [...seen].map(([id, name]) => ({ id, name })).sort((a, b) => a.name.localeCompare(b.name));
}

/** Who may open the list — the people a comment on it can mention: everyone active when it's shared; else its builder and whoever may manage every list. */
export async function listReaders(workbookId: string): Promise<{ id: string; name: string }[]> {
  const wb = await db.workbook.findUnique({ where: { id: workbookId }, select: { id: true, shared: true, ownerUserId: true } });
  if (!wb) return [];
  const people = await db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } });
  // Whoever may see it — chosen people and departments too (Smart Lists phase 4 — src/lib/smart-lists/access.ts).
  const ok = await viewersAmong(wb, people.map((p) => p.id));
  return people.filter((p) => ok.has(p.id));
}

export async function commentsOnRow(rowId: string, viewerId: string): Promise<OwnRowComment[]> {
  try {
    const rows = await db.workbookRowComment.findMany({ where: { rowId }, orderBy: { createdAt: "asc" }, take: 200, select: { id: true, body: true, authorUserId: true, authorGuestId: true, shared: true, audienceConnectionId: true, createdAt: true } });
    const users = new Map((await db.user.findMany({ where: { id: { in: rows.map((r) => r.authorUserId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
    const guests = new Map(
      (await db.guest.findMany({ where: { id: { in: rows.map((r) => r.authorGuestId).filter((x): x is string => !!x) } }, select: { id: true, name: true, connection: { select: { name: true } } } }).catch(() => [])).map((g) => [g.id, g]),
    );
    const teams = new Map(
      (await db.connection.findMany({ where: { id: { in: rows.map((r) => r.audienceConnectionId).filter((x): x is string => !!x) } }, select: { id: true, name: true } }).catch(() => [])).map((c) => [c.id, c.name]),
    );
    return rows.map((r) => ({
      id: r.id,
      body: r.body,
      author: r.authorUserId ? (users.get(r.authorUserId) ?? "Somebody who left") : r.authorGuestId ? (guests.get(r.authorGuestId)?.name ?? "A guest") : null,
      mine: r.authorUserId === viewerId,
      byGuest: !!r.authorGuestId,
      shared: r.shared,
      at: r.createdAt.toISOString(),
      team: r.authorGuestId ? (guests.get(r.authorGuestId)?.connection.name ?? null) : r.audienceConnectionId ? (teams.get(r.audienceConnectionId) ?? null) : null,
    }));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** A comment added by a member of staff; whoever it @mentions is told. Returns it, and how many were told. */
export async function addCommentOnRow(input: { workbookId: string; workbookName: string; rowId: string; rowTitle: string; body: string; userId: string; userName: string; shared?: boolean; team?: { id: string; name: string } | null }): Promise<{ comment: OwnRowComment; told: number }> {
  const body = input.body.replace(/\r\n/g, "\n").trim().slice(0, COMMENT_MAX);
  // Shared: the list's guests see it too (Deskzo Connect) — every one of them, or one team only; otherwise only staff.
  const made = await db.workbookRowComment.create({
    data: { workbookId: input.workbookId, rowId: input.rowId, body, authorUserId: input.userId, shared: input.shared === true, audienceConnectionId: input.shared && input.team ? input.team.id : null },
    select: { id: true, createdAt: true },
  });
  const readers = await listReaders(input.workbookId);
  const mentioned = mentionsIn(body, readers).filter((id) => id !== input.userId);
  for (const userId of mentioned) {
    await notifyUser({
      userId,
      type: "SMART_LIST_MENTION",
      title: `${input.userName} mentioned you on "${input.rowTitle}"`.slice(0, 200),
      message: `In the Smart List "${input.workbookName}".`,
      link: `/smart-lists/${input.workbookId}?q=${encodeURIComponent(input.rowTitle)}`,
    });
  }
  // Shared with the list's guests: those whose share shows this row are emailed — the list and who wrote, never the row (phase 4).
  if (input.shared === true) {
    const { noticeComment } = await import("@/lib/connect/notices");
    await noticeComment(input.workbookId, input.userName, undefined, undefined, input.rowId, input.team?.id ?? null, true);
  }
  return { comment: { id: made.id, body, author: input.userName, mine: true, byGuest: false, shared: input.shared === true, at: made.createdAt.toISOString(), team: input.shared && input.team ? input.team.name : null }, told: mentioned.length };
}
