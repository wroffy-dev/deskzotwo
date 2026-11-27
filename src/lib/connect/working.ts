import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { guestSeesRow } from "@/lib/connect/row-scope";
import { recordGuestActivity } from "@/lib/connect/activity";
import { guestSeesOwnRow, ownRowComments, addOwnRowGuestComment } from "@/lib/connect/own-rows";

/**
 * Deskzo Connect, working together (owner, 20 Nov 2026 — phase 3): a row's account owner as the guest's contact,
 * comments on a row — shared with the list's guests or internal — and what guests suggest: a company for the list, or a
 * correction to one. A suggestion is never a company by itself; somebody at the workspace decides (src/actions/connect-
 * review.ts). Server only; every guest function starts from the guest's id and one of their live shares.
 */

export const CONTACT_MODES = ["NAME", "NAME_EMAIL", "ALL"] as const;
export type ContactMode = (typeof CONTACT_MODES)[number];
export const LIMITS = { comment: 2000, note: 1000, field: 200, pendingPerGuest: 50 } as const;

export async function contactMode(): Promise<ContactMode> {
  try {
    const row = await db.connectSettings.findUnique({ where: { id: "global" }, select: { ownerContact: true } });
    return (CONTACT_MODES as readonly string[]).includes(row?.ownerContact ?? "") ? (row!.ownerContact as ContactMode) : "NAME_EMAIL";
  } catch (err) {
    if (notMigratedYet(err)) return "NAME_EMAIL";
    throw err;
  }
}

export type OwnerContact = { name: string; email: string | null; phone: string | null };

/** Each company's account owner as guests may see them — the workspace's setting decides how much; a person who left, nobody. */
export async function ownerContacts(companyIds: string[]): Promise<Map<string, OwnerContact>> {
  if (companyIds.length === 0) return new Map();
  const [mode, rows] = await Promise.all([
    contactMode(),
    db.company.findMany({ where: { id: { in: companyIds } }, select: { id: true, owner: { select: { name: true, email: true, phone: true, active: true } } } }),
  ]);
  const out = new Map<string, OwnerContact>();
  for (const r of rows) {
    if (!r.owner?.active) continue;
    out.set(r.id, { name: r.owner.name, email: mode === "NAME" ? null : r.owner.email, phone: mode === "ALL" ? (r.owner.phone ?? null) : null });
  }
  return out;
}

// A list of companies, or of its own rows (Smart Lists phase 3) — never a calling activity. Asked as "not a calling
// activity", so a workspace not yet migrated to know ROWS still answers.
const live = (now: Date) => ({ revokedAt: null, OR: [{ until: null }, { until: { gt: now } }], workbook: { mode: { not: "COLD_CALLING" as const } } });

/** A live share of this guest's and its list — or null. */
export async function guestShareFor(guestId: string, shareId: unknown, now = new Date()) {
  if (typeof shareId !== "string" || !shareId) return null;
  return db.listShare.findFirst({ where: { id: shareId, guestId, ...live(now) }, select: { id: true, workbook: { select: { id: true, name: true, filters: true, ownerUserId: true, mode: true } } } });
}

/** One of the rows this guest sees in the share — the list's, ticked for them and in their territory (row-scope.ts). */
function inSharedList(guestId: string, share: { id: string; workbook: { id: string; filters: unknown; ownerUserId: string; mode: string } }, companyId: unknown): Promise<boolean> {
  // A row of a list of its own: the list's, ticked for them (src/lib/connect/own-rows.ts).
  if (share.workbook.mode === "ROWS") return guestSeesOwnRow(share.id, share.workbook.id, companyId);
  return guestSeesRow(guestId, share.id, share.workbook, companyId);
}

/** `team`: a guest author's team, or the one team a staff comment went to — for staff to read; never sent to a guest of another. */
export type RowComment = { id: string; body: string; author: string; byGuest: boolean; shared: boolean; at: string; team?: string | null };

/**
 * A row's comments. For a guest (`connectionId`): only shared ones meant for them (owner, 20 Nov 2026 — one list worked by
 * two teams of one brand): a staff comment to every guest or to their team, and guests' comments from their own team —
 * never another team's. For staff (`null`): all of them, internal too, with whose team each is.
 */
async function commentsOf(workbookId: string, companyId: string, viewer: { connectionId: string } | null): Promise<RowComment[]> {
  const select = { id: true, body: true, shared: true, createdAt: true, authorUserId: true, authorGuest: { select: { name: true, connectionId: true, connection: { select: { name: true } } } } } as const;
  let rows: ({ audience?: { connectionId: string; connection: { name: string } } | null } & Awaited<ReturnType<typeof db.listRowComment.findMany<{ select: typeof select }>>>[number])[];
  try {
    rows = await db.listRowComment.findMany({
      where: { workbookId, companyId, ...(viewer ? { shared: true } : {}) },
      orderBy: { createdAt: "asc" },
      take: 200,
      select: { ...select, audience: { select: { connectionId: true, connection: { select: { name: true } } } } },
    });
  } catch (err) {
    // Before the audiences table: every shared comment to every guest, as it was.
    if (!notMigratedYet(err)) throw err;
    rows = await db.listRowComment.findMany({ where: { workbookId, companyId, ...(viewer ? { shared: true } : {}) }, orderBy: { createdAt: "asc" }, take: 200, select });
  }
  const meant = viewer
    ? rows.filter((r) => {
        if (r.authorUserId) return !r.audience || r.audience.connectionId === viewer.connectionId;
        if (r.authorGuest) return r.authorGuest.connectionId === viewer.connectionId;
        return true; // a guest since removed — their team unknown; as it always was
      })
    : rows;
  const users = await db.user.findMany({ where: { id: { in: meant.map((r) => r.authorUserId).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const names = new Map(users.map((u) => [u.id, u.name]));
  return meant.map((r) => ({
    id: r.id,
    body: r.body,
    author: r.authorGuest?.name ?? (r.authorUserId ? (names.get(r.authorUserId) ?? "Somebody") : "A guest who has left"),
    byGuest: !r.authorUserId,
    shared: r.shared,
    at: r.createdAt.toISOString(),
    ...(viewer ? {} : { team: r.authorGuest?.connection.name ?? r.audience?.connection.name ?? null }),
  }));
}

// ─── Guests ───────────────────────────────────────────────────────────────────

/** `own`: a row of a list of its own (Smart Lists phase 3) — no account owner, nothing to correct. */
export type GuestRowDetail = { contact: OwnerContact | null; comments: RowComment[]; own?: boolean };

/** A row's page for a guest: their contact, and the shared comments — never an internal one. */
export async function guestRowDetail(guestId: string, shareId: unknown, companyId: unknown, now = new Date()): Promise<GuestRowDetail | null> {
  const share = await guestShareFor(guestId, shareId, now);
  if (!share || !(await inSharedList(guestId, share, companyId))) return null;
  const id = companyId as string;
  const g = await db.guest.findUnique({ where: { id: guestId }, select: { connectionId: true } });
  if (!g) return null;
  if (share.workbook.mode === "ROWS") return { contact: null, comments: await ownRowComments(id, { connectionId: g.connectionId }), own: true };
  const [contacts, comments] = await Promise.all([ownerContacts([id]), commentsOf(share.workbook.id, id, { connectionId: g.connectionId })]);
  return { contact: contacts.get(id) ?? null, comments };
}

export async function guestAddComment(guestId: string, input: { shareId: unknown; companyId: unknown; body: unknown }, now = new Date()): Promise<{ ok: true; comment: RowComment } | { ok: false; error: string }> {
  const share = await guestShareFor(guestId, input.shareId, now);
  if (!share) return { ok: false, error: "This list isn't shared with you any more." };
  if (!(await inSharedList(guestId, share, input.companyId))) return { ok: false, error: "That company isn't in this list." };
  const body = String(input.body ?? "").trim().slice(0, LIMITS.comment);
  if (!body) return { ok: false, error: "Write something first." };
  if (share.workbook.mode === "ROWS") {
    const made = await addOwnRowGuestComment(guestId, share.workbook.id, input.companyId as string, body);
    await recordGuestActivity(guestId, "COMMENT", share.workbook.id);
    await tellListOwner(share.workbook, "TASK_ASSIGNED", `A guest commented on ${share.workbook.name}`, `${made.author}: ${body.slice(0, 140)}`);
    return { ok: true, comment: made };
  }
  const row = await db.listRowComment.create({
    data: { workbookId: share.workbook.id, companyId: input.companyId as string, body, authorGuestId: guestId, shared: true },
    select: { id: true, createdAt: true, authorGuest: { select: { name: true } } },
  });
  await recordGuestActivity(guestId, "COMMENT", share.workbook.id);
  await tellListOwner(share.workbook, "TASK_ASSIGNED", `A guest commented on ${share.workbook.name}`, `${row.authorGuest?.name ?? "A guest"}: ${body.slice(0, 140)}`);
  return { ok: true, comment: { id: row.id, body, author: row.authorGuest?.name ?? "You", byGuest: true, shared: true, at: row.createdAt.toISOString() } };
}

const field = (v: unknown) => {
  const s = String(v ?? "").replace(/\s+/g, " ").trim().slice(0, LIMITS.field);
  return s || null;
};

async function tellListOwner(wb: { id: string; ownerUserId: string }, type: "TASK_ASSIGNED", title: string, message: string) {
  const { notifyUser } = await import("@/lib/notify");
  await notifyUser({ userId: wb.ownerUserId, type, title, message, link: `/smart-lists/${wb.id}` }).catch(() => undefined);
}

export type GuestSuggestion = { id: string; kind: "NEW_COMPANY" | "CORRECTION"; name: string | null; companyId: string | null; note: string; status: string; declineReason: string | null; at: string };

/** A company the guest proposes for the list — waiting for the workspace, in no list or report until then. */
export async function guestSuggestCompany(
  guestId: string,
  input: { shareId: unknown; name: unknown; city?: unknown; website?: unknown; gstin?: unknown; contactName?: unknown; note: unknown },
  now = new Date(),
): Promise<{ ok: true } | { ok: false; error: string }> {
  const share = await guestShareFor(guestId, input.shareId, now);
  if (!share) return { ok: false, error: "This list isn't shared with you any more." };
  if (share.workbook.mode === "ROWS") return { ok: false, error: "This list doesn't take company suggestions — comment on a row instead." };
  const name = field(input.name);
  if (!name || name.length < 2) return { ok: false, error: "Give the company's name." };
  const note = String(input.note ?? "").trim().slice(0, LIMITS.note);
  if (!note) return { ok: false, error: "Say in a line why it fits — who you met, what they need." };
  if ((await db.listSuggestion.count({ where: { guestId, status: "PENDING" } })) >= LIMITS.pendingPerGuest) return { ok: false, error: "You have a lot waiting already — give the workspace a moment to go through them." };
  await db.listSuggestion.create({
    data: { workbookId: share.workbook.id, guestId, kind: "NEW_COMPANY", name, city: field(input.city), website: field(input.website), gstin: field(input.gstin)?.toUpperCase() ?? null, contactName: field(input.contactName), note },
    select: { id: true },
  });
  await recordGuestActivity(guestId, "SUGGEST", share.workbook.id);
  await tellListOwner(share.workbook, "TASK_ASSIGNED", `A guest suggested a company for ${share.workbook.name}`, `${name} — review it under Smart Lists › Guests › Suggestions.`);
  return { ok: true };
}

/** A correction to one of the list's companies — the guest never edits a company's own details. */
export async function guestSuggestCorrection(guestId: string, input: { shareId: unknown; companyId: unknown; note: unknown }, now = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  const share = await guestShareFor(guestId, input.shareId, now);
  if (!share) return { ok: false, error: "This list isn't shared with you any more." };
  if (share.workbook.mode === "ROWS") return { ok: false, error: "Corrections are for companies — comment on the row instead." };
  if (!(await inSharedList(guestId, share, input.companyId))) return { ok: false, error: "That company isn't in this list." };
  const note = String(input.note ?? "").trim().slice(0, LIMITS.note);
  if (!note) return { ok: false, error: "Say what should change." };
  if ((await db.listSuggestion.count({ where: { guestId, status: "PENDING" } })) >= LIMITS.pendingPerGuest) return { ok: false, error: "You have a lot waiting already — give the workspace a moment to go through them." };
  await db.listSuggestion.create({ data: { workbookId: share.workbook.id, guestId, kind: "CORRECTION", companyId: input.companyId as string, note }, select: { id: true } });
  await recordGuestActivity(guestId, "SUGGEST", share.workbook.id);
  await tellListOwner(share.workbook, "TASK_ASSIGNED", `A guest suggested a correction in ${share.workbook.name}`, note.slice(0, 160));
  return { ok: true };
}

/** This guest's own suggestions for the list — the grey rows, and what became of them. */
export async function guestSuggestionsFor(guestId: string, workbookId: string): Promise<GuestSuggestion[]> {
  const rows = await db.listSuggestion.findMany({
    where: { guestId, workbookId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: { id: true, kind: true, name: true, companyId: true, note: true, status: true, declineReason: true, createdAt: true },
  });
  return rows.map((r) => ({ ...r, at: r.createdAt.toISOString() }));
}

// ─── Staff ────────────────────────────────────────────────────────────────────

/** A row's comments for staff — shared and internal. The caller has checked the person may open the list and see the company. */
export async function staffComments(workbookId: string, companyId: string): Promise<RowComment[]> {
  return commentsOf(workbookId, companyId, null);
}
