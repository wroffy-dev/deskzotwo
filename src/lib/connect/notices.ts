import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { guestMaySignIn } from "@/lib/connect/guest-auth";
import { connectInPlan } from "@/lib/connect/activity";
import { mailGuestComments, mailGuestListShared, mailGuestSuggestionDecided } from "@/lib/connect/mail";
import { guestSeesRow } from "@/lib/connect/row-scope";
import { guestSeesOwnRow } from "@/lib/connect/own-rows";

/**
 * Deskzo Connect's guests told when something changes for them (owner, 20 Nov 2026: "start with guest email
 * notifications"): a list shared with them, a comment written to them, a suggestion of theirs decided. Each says what
 * and where, never which customer — the guest signs in to read it.
 *
 *   · Only a guest who could act on it: not stopped, access not over, an invitation still able to be used, and Connect
 *     still in the plan; for a list, only while it is shared with them.
 *   · Comments mail a guest at most once a list an hour (`GuestNotice`), however many are written.
 *   · Never in the way: a mail that fails is let go, and the change it was about stands.
 *   · The list's own say (owner, 20 Nov 2026: "let the person who is managing the smart list decide"): a list whose
 *     guest emails are off (WorkbookGuestSettings.emailGuests) sends none of these. The invitation and codes still go.
 *
 * `send` stands in for the mailers in a check; it is the real ones otherwise.
 */

export type Mailers = {
  listShared: typeof mailGuestListShared;
  comments: typeof mailGuestComments;
  decided: typeof mailGuestSuggestionDecided;
};
const REAL: Mailers = { listShared: mailGuestListShared, comments: mailGuestComments, decided: mailGuestSuggestionDecided };
const HOUR = 3_600_000;

type Reachable = { id: string; name: string; email: string };

async function reachable(guestId: string, now: Date): Promise<Reachable | null> {
  const g = await db.guest.findUnique({ where: { id: guestId }, select: { id: true, name: true, email: true, status: true, inviteExpiresAt: true, accessUntil: true } });
  if (!g || !guestMaySignIn(g, now)) return null;
  return g;
}

/** This guest's share of the list, live now. */
async function stillShared(guestId: string, workbookId: string, now: Date): Promise<boolean> {
  return (await db.listShare.count({ where: { guestId, workbookId, revokedAt: null, OR: [{ until: null }, { until: { gt: now } }] } })) > 0;
}

/** Whether this list's guests are emailed — on unless whoever manages it turned it off; on before the table exists. */
export async function listEmailsGuests(workbookId: string): Promise<boolean> {
  try {
    const row = await db.workbookGuestSettings.findUnique({ where: { workbookId }, select: { emailGuests: true } });
    return row?.emailGuests ?? true;
  } catch (err) {
    if (notMigratedYet(err)) return true;
    throw err;
  }
}

async function record(guestId: string, kind: string, workbookId: string | null) {
  await db.guestNotice.create({ data: { guestId, kind, workbookId }, select: { id: true } });
}

async function safely(what: string, fn: () => Promise<void>) {
  try {
    await fn();
  } catch (err) {
    if (!notMigratedYet(err)) console.error(`[connect] ${what} not sent`, err);
  }
}

/** A list newly shared with a guest — not the one their invitation already named. */
export async function noticeListShared(guestId: string, workbookId: string, sharer: string, send: Mailers = REAL, now = new Date()): Promise<boolean> {
  let sent = false;
  await safely("list-shared notice", async () => {
    if (!(await connectInPlan()) || !(await listEmailsGuests(workbookId))) return;
    const g = await reachable(guestId, now);
    const wb = await db.workbook.findUnique({ where: { id: workbookId }, select: { name: true } });
    if (!g || !wb || !(await stillShared(g.id, workbookId, now))) return;
    await send.listShared(g, wb.name, sharer);
    await record(g.id, "LIST_SHARED", workbookId);
    sent = true;
  });
  return sent;
}

/**
 * A comment shared with a list's guests: each one it reaches, at most once an hour for this list. `ownRow`: `companyId`
 * is a row of a list of its own (Smart Lists phase 4) — a guest hears of it only when their share shows that row. The
 * email names the list and who wrote, never the row.
 */
export async function noticeComment(workbookId: string, author: string, send: Mailers = REAL, now = new Date(), companyId?: string, connectionId?: string | null, ownRow = false): Promise<number> {
  let sent = 0;
  await safely("comment notice", async () => {
    if (!(await connectInPlan()) || !(await listEmailsGuests(workbookId))) return;
    const wb = await db.workbook.findUnique({ where: { id: workbookId }, select: { id: true, name: true, filters: true, ownerUserId: true } });
    if (!wb) return;
    const shares = await db.listShare.findMany({ where: { workbookId, revokedAt: null, OR: [{ until: null }, { until: { gt: now } }] }, select: { id: true, guestId: true, guest: { select: { connectionId: true } } } });
    for (const { id: shareId, guestId, guest } of shares) {
      // A comment to one team: only that team hears of it.
      if (connectionId && guest.connectionId !== connectionId) continue;
      const g = await reachable(guestId, now);
      if (!g) continue;
      // Not about a row they can't see — outside their territory, or not ticked for them.
      if (companyId && !(ownRow ? await guestSeesOwnRow(shareId, workbookId, companyId) : await guestSeesRow(guestId, shareId, wb, companyId))) continue;
      const recent = await db.guestNotice.count({ where: { guestId, kind: "COMMENTS", workbookId, sentAt: { gt: new Date(now.getTime() - HOUR) } } });
      if (recent) continue;
      await send.comments(g, wb.name, author);
      await record(g.id, "COMMENTS", workbookId);
      sent += 1;
    }
  });
  return sent;
}

const OUTCOME: Record<string, string> = {
  LINKED: "was added to the list",
  CREATED: "was added to the list",
  ACCEPTED: "was taken on board",
  DECLINED: "wasn't added",
};

/** A suggestion of the guest's decided — added, not added, or a correction made. */
export async function noticeSuggestionDecided(suggestionId: string, send: Mailers = REAL, now = new Date()): Promise<boolean> {
  let sent = false;
  await safely("suggestion notice", async () => {
    if (!(await connectInPlan())) return;
    const s = await db.listSuggestion.findUnique({ where: { id: suggestionId }, select: { guestId: true, status: true, workbookId: true, workbook: { select: { name: true } } } });
    const outcome = s ? OUTCOME[s.status] : undefined;
    if (!s || !outcome || !(await listEmailsGuests(s.workbookId))) return;
    const g = await reachable(s.guestId, now);
    if (!g || !(await stillShared(g.id, s.workbookId, now))) return;
    await send.decided(g, s.workbook.name, outcome);
    await record(g.id, "SUGGESTION_DECIDED", s.workbookId);
    sent = true;
  });
  return sent;
}
