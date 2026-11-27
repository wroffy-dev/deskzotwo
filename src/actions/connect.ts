"use server";

import { revalidatePath } from "next/cache";
import type { ConnectionKind } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import type { ActionResult } from "@/actions/company";
import { endGuestSessions, guestMaySignIn, INVITE_DAYS, workEmail } from "@/lib/connect/guest-auth";
import { guestListView, guestShares, type GuestListView, type GuestShare } from "@/lib/connect/guest-lists";
import { guestRowDetail, type GuestRowDetail } from "@/lib/connect/working";
import { mailGuestInvite } from "@/lib/connect/mail";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";
import { allowanceRefusal, guestAllowance, type GuestAllowance } from "@/lib/connect/activity";
import { listEmailsGuests, noticeListShared } from "@/lib/connect/notices";
import { workspacePack } from "@/lib/country-pack";
import { INDIAN_STATES } from "@/lib/geo/india";
import { GUEST_HIDDEN_KINDS } from "@/lib/connect/own-rows";
import type { PropertyKind } from "@/lib/smart-lists/values";

/**
 * Deskzo Connect, the staff side (owner, 20 Nov 2026 — src/lib/connect): the outside companies, their guests invited by
 * work email, and which Smart Lists each guest is open to.
 *
 * Who may: connections and guests are managed by whoever may manage every Smart List (`workspace.manageAny`) — an
 * existing permission, so nothing new to grant until Connect has keys of its own (to agree with Himanshu). A list is
 * shared, and taken back, by whoever may edit it (its builder or `workspace.manageAny`), with guests already invited.
 */

const NOT_YET = "Deskzo Connect arrives with this workspace's next update. Try again in a few minutes.";
const MANAGERS_ONLY = "Inviting and managing guests needs the “Manage any Smart List” permission.";
const KINDS: ConnectionKind[] = ["BRAND", "SUBCONTRACTOR", "CLIENT", "ADVISER", "OTHER"];
const DAY = 86_400_000;

async function ready(): Promise<boolean> {
  try {
    await db.guest.findFirst({ select: { id: true } });
    await db.listShare.findFirst({ select: { id: true } });
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

async function manager() {
  const user = await requireModuleAccess("workspace");
  return (await hasEffectivePermission(user.id, "workspace.manageAny")) ? user : null;
}

const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** A calendar day "YYYY-MM-DD" as the end of that day on the workspace's clock — or null for none; refused when past. */
async function untilOf(v: unknown, now = new Date()): Promise<Date | null | false> {
  if (v === null || v === undefined || v === "") return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(v))) return false;
  const d = (await workspaceClock()).endOfDay(String(v));
  if (!d || d <= now) return false;
  return d;
}

function changed() {
  revalidatePath("/smart-lists/guests");
}

// ─── Connections and guests ───────────────────────────────────────────────────

export type GuestRowView = {
  id: string;
  name: string;
  email: string;
  status: "INVITED" | "ACTIVE" | "SUSPENDED";
  invitedAt: string;
  inviteExpiresAt: string;
  accessUntil: string | null;
  lastSignInAt: string | null;
  lists: { shareId: string; workbookId: string; name: string; until: string | null }[];
  /** The states they see companies in; none — every state. */
  territory: string[];
};
export type ConnectionView = { id: string; name: string; kind: ConnectionKind; guests: GuestRowView[] };

export async function connectOverview(): Promise<{ ready: boolean; manager: boolean; connections: ConnectionView[]; allowance: GuestAllowance; states: string[] }> {
  const user = await requireModuleAccess("workspace");
  const isManager = await hasEffectivePermission(user.id, "workspace.manageAny");
  const none = { limit: null, used: 0 };
  if (!(await ready())) return { ready: false, manager: isManager, connections: [], allowance: none, states: [] };
  if (!isManager) return { ready: true, manager: false, connections: [], allowance: none, states: [] };
  const allowance = await guestAllowance();
  const rows = await db.connection.findMany({
    orderBy: { name: "asc" },
    select: {
      id: true,
      name: true,
      kind: true,
      guests: {
        orderBy: { name: "asc" },
        select: {
          id: true,
          name: true,
          email: true,
          status: true,
          invitedAt: true,
          inviteExpiresAt: true,
          accessUntil: true,
          lastSignInAt: true,
          shares: { where: { revokedAt: null }, select: { id: true, until: true, workbook: { select: { id: true, name: true } } } },
        },
      },
    },
  });
  const territories = await territoriesOf(rows.flatMap((c) => c.guests.map((g) => g.id)));
  return {
    ready: true,
    manager: true,
    allowance,
    states: await territoryChoices(),
    connections: rows.map((c) => ({
      ...c,
      guests: c.guests.map((g) => ({
        id: g.id,
        name: g.name,
        email: g.email,
        status: g.status,
        invitedAt: g.invitedAt.toISOString(),
        inviteExpiresAt: g.inviteExpiresAt.toISOString(),
        accessUntil: g.accessUntil?.toISOString() ?? null,
        lastSignInAt: g.lastSignInAt?.toISOString() ?? null,
        lists: g.shares.map((s) => ({ shareId: s.id, workbookId: s.workbook.id, name: s.workbook.name, until: s.until?.toISOString() ?? null })),
        territory: territories.get(g.id) ?? [],
      })),
    })),
  };
}

export async function addConnection(input: { name: string; kind: string }): Promise<ActionResult<{ id: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: MANAGERS_ONLY };
  if (!(await ready())) return { ok: false, error: NOT_YET };
  const name = clean(input?.name, 120);
  if (!name) return { ok: false, error: "Name the company — Autodesk India, Sharma & Rao…" };
  const kind = KINDS.includes(input?.kind as ConnectionKind) ? (input.kind as ConnectionKind) : "OTHER";
  const clash = await db.connection.findFirst({ where: { name: { equals: name, mode: "insensitive" } }, select: { id: true } });
  if (clash) return { ok: false, error: `There's already a connection called "${name}".` };
  const row = await db.connection.create({ data: { name, kind, createdById: user.id }, select: { id: true } });
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "Connection", entityId: row.id, entityLabel: `Connect: ${name} added` });
  changed();
  return { ok: true, data: row };
}

/** A guest invited by work email, optionally with a list shared at once. The invitation email names no customer. */
export async function inviteGuest(input: { connectionId: string; name: string; email: string; accessUntil?: string | null; workbookId?: string | null }): Promise<ActionResult<{ id: string }>> {
  const user = await manager();
  if (!user) return { ok: false, error: MANAGERS_ONLY };
  if (!(await ready())) return { ok: false, error: NOT_YET };
  const connection = typeof input?.connectionId === "string" ? await db.connection.findUnique({ where: { id: input.connectionId }, select: { id: true, name: true } }) : null;
  if (!connection) return { ok: false, error: "Choose which company they're from." };
  const name = clean(input.name, 120);
  if (!name) return { ok: false, error: "Give their name." };
  const email = workEmail(input.email);
  if (!email.ok) return email;
  const until = await untilOf(input.accessUntil);
  if (until === false) return { ok: false, error: "Access must end on a day still to come." };
  if (await db.guest.findUnique({ where: { email: email.email }, select: { id: true } })) return { ok: false, error: "That address is already a guest here." };
  // The plan's guests (phase 4): 10 a unit of the add-on, 3 on Deskzo One.
  const full = allowanceRefusal(await guestAllowance());
  if (full) return { ok: false, error: full };
  if (await db.user.findFirst({ where: { email: { equals: email.email, mode: "insensitive" } }, select: { id: true } })) return { ok: false, error: "That address belongs to somebody on your own team — they sign in as staff, not as a guest." };
  // A list of companies or of its own rows (Smart Lists phase 3) — never a calling activity.
  const found = input.workbookId ? await db.workbook.findUnique({ where: { id: input.workbookId }, select: { id: true, name: true, mode: true } }) : null;
  const workbook = found && (found.mode === "LIST" || found.mode === "ROWS") ? found : null;
  if (input.workbookId && !workbook) return { ok: false, error: "That list can't be shared — only Smart Lists, not calling activities." };

  const now = new Date();
  const guest = await db.$transaction(async (tx) => {
    const g = await tx.guest.create({
      data: { connectionId: connection.id, name, email: email.email, invitedById: user.id, inviteExpiresAt: new Date(now.getTime() + INVITE_DAYS * DAY), accessUntil: until },
      select: { id: true },
    });
    if (workbook) await tx.listShare.create({ data: { workbookId: workbook.id, guestId: g.id, until, sharedById: user.id } });
    return g;
  });
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "Guest", entityId: guest.id, entityLabel: `Connect: ${name} (${email.email}, ${connection.name}) invited${workbook ? `, ${workbook.name} shared` : ""}` });
  try {
    await mailGuestInvite({ email: email.email, name }, user.name ?? "");
  } catch {
    changed();
    return { ok: false, error: "They're invited, but the email didn't go — use Resend on their row." };
  }
  changed();
  return { ok: true, data: guest };
}

async function guestFor(id: unknown) {
  return typeof id === "string" && id ? db.guest.findUnique({ where: { id }, select: { id: true, name: true, email: true, status: true, lastSignInAt: true } }) : null;
}

/** The invitation again, with seven fresh days — for somebody who hasn't signed in yet. */
export async function resendGuestInvite(guestId: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: MANAGERS_ONLY };
  const guest = await guestFor(guestId);
  if (!guest) return { ok: false, error: "That guest no longer exists." };
  if (guest.status === "SUSPENDED") return { ok: false, error: "They're stopped. Let them back in first." };
  await db.guest.update({ where: { id: guest.id }, data: { inviteExpiresAt: new Date(Date.now() + INVITE_DAYS * DAY) }, select: { id: true } });
  await mailGuestInvite({ email: guest.email, name: guest.name }, user.name ?? "");
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Guest", entityId: guest.id, entityLabel: `Connect: invitation sent again to ${guest.name}` });
  changed();
  return { ok: true, data: null };
}

/** Stopped: signed out everywhere at once, and no code works until let back in. */
export async function suspendGuest(guestId: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: MANAGERS_ONLY };
  const guest = await guestFor(guestId);
  if (!guest) return { ok: false, error: "That guest no longer exists." };
  await db.guest.update({ where: { id: guest.id }, data: { status: "SUSPENDED" }, select: { id: true } });
  await endGuestSessions(guest.id);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Guest", entityId: guest.id, entityLabel: `Connect: ${guest.name} stopped — signed out everywhere` });
  changed();
  return { ok: true, data: null };
}

export async function restoreGuest(guestId: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: MANAGERS_ONLY };
  const guest = await guestFor(guestId);
  if (!guest) return { ok: false, error: "That guest no longer exists." };
  if (guest.status === "SUSPENDED") {
    const full = allowanceRefusal(await guestAllowance());
    if (full) return { ok: false, error: full };
  }
  await db.guest.update({ where: { id: guest.id }, data: { status: guest.lastSignInAt ? "ACTIVE" : "INVITED" }, select: { id: true } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Guest", entityId: guest.id, entityLabel: `Connect: ${guest.name} let back in` });
  changed();
  return { ok: true, data: null };
}

/** The guest gone, with everything shared with them. */
export async function removeGuest(guestId: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return { ok: false, error: MANAGERS_ONLY };
  const guest = await guestFor(guestId);
  if (!guest) return { ok: true, data: null };
  await db.guest.delete({ where: { id: guest.id } });
  await recordAudit({ userId: user.id, action: "DELETE", entityType: "Guest", entityId: guest.id, entityLabel: `Connect: ${guest.name} (${guest.email}) removed, with their shares` });
  changed();
  return { ok: true, data: null };
}

// ─── Sharing a list ───────────────────────────────────────────────────────────

async function editableList(userId: string, workbookId: unknown) {
  if (typeof workbookId !== "string" || !workbookId) return null;
  const wb = await db.workbook.findUnique({ where: { id: workbookId }, select: { id: true, name: true, mode: true, ownerUserId: true } });
  if (!wb) return null;
  const canEdit = wb.ownerUserId === userId || (await hasEffectivePermission(userId, "workspace.manageAny"));
  return canEdit ? wb : null;
}

export type ListSharing = {
  ready: boolean;
  canShare: boolean;
  canInvite: boolean;
  /** The plan's guests and how many count (phase 4). */
  allowance: GuestAllowance;
  /** Whether this list's guests are emailed when something changes — the list's own setting. */
  emailGuests: boolean;
  shares: { id: string; guestId: string; guestName: string; email: string; connection: string; until: string | null; status: string; onlyPropertyId: string | null; territory: string[]; columnIds: string[] | null }[];
  /** The list's columns marked visible to guests — a share may show only some of them. */
  guestColumns: { id: string; name: string }[];
  /** The list's Checkbox columns — a share may show only the rows ticked in one ("Nominated for LC"). */
  tickColumns: { id: string; name: string }[];
  /** A list of its own rows (Smart Lists phase 3): a guest's territory doesn't narrow it. */
  ownRows?: boolean;
  guests: { id: string; name: string; email: string; connection: string }[];
  connections: { id: string; name: string }[];
};

export async function listSharing(workbookId: string): Promise<ListSharing> {
  const user = await requireModuleAccess("workspace");
  const none: ListSharing = { ready: false, canShare: false, canInvite: false, allowance: { limit: null, used: 0 }, emailGuests: true, shares: [], tickColumns: [], guestColumns: [], guests: [], connections: [] };
  if (!(await ready())) return none;
  const wb = await editableList(user.id, workbookId);
  if (!wb || (wb.mode !== "LIST" && wb.mode !== "ROWS")) return { ...none, ready: true };
  const [shares, guests, connections, canInvite] = await Promise.all([
    db.listShare.findMany({ where: { workbookId: wb.id, revokedAt: null }, orderBy: { createdAt: "asc" }, select: { id: true, until: true, guest: { select: { id: true, name: true, email: true, status: true, connection: { select: { name: true } } } } } }),
    db.guest.findMany({ where: { status: { not: "SUSPENDED" } }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true, connection: { select: { name: true } } } }),
    db.connection.findMany({ orderBy: { name: "asc" }, select: { id: true, name: true } }),
    hasEffectivePermission(user.id, "workspace.manageAny"),
  ]);
  const [scopes, territories, tickColumns, guestColumns, chosen] = await Promise.all([
    scopesOf(shares.map((s) => s.id)),
    territoriesOf(shares.map((s) => s.guest.id)),
    db.workbookProperty.findMany({ where: { workbookId: wb.id, kind: "CHECKBOX" }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true } }),
    // Never a column linking to records or files elsewhere, nor a count — guests never see those (src/lib/connect/own-rows.ts).
    db.workbookProperty.findMany({ where: { workbookId: wb.id, guestVisible: true }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, kind: true } }).then((cols) => cols.filter((c) => !GUEST_HIDDEN_KINDS.includes(c.kind as PropertyKind)).map(({ id, name }) => ({ id, name }))),
    columnsOf(shares.map((s) => s.id)),
  ]);
  return {
    ready: true,
    canShare: true,
    canInvite,
    ownRows: wb.mode === "ROWS",
    allowance: await guestAllowance(),
    emailGuests: await listEmailsGuests(wb.id),
    shares: shares.map((s) => ({
      id: s.id,
      guestId: s.guest.id,
      guestName: s.guest.name,
      email: s.guest.email,
      connection: s.guest.connection.name,
      until: s.until?.toISOString() ?? null,
      status: s.guest.status,
      onlyPropertyId: scopes.get(s.id) ?? null,
      territory: territories.get(s.guest.id) ?? [],
      columnIds: chosen.get(s.id) ?? null,
    })),
    tickColumns,
    guestColumns,
    guests: guests.map((g) => ({ id: g.id, name: g.name, email: g.email, connection: g.connection.name })),
    connections,
  };
}

export async function shareListWithGuest(input: { workbookId: string; guestId: string; until?: string | null }): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("workspace");
  if (!(await ready())) return { ok: false, error: NOT_YET };
  const wb = await editableList(user.id, input?.workbookId);
  if (!wb) return { ok: false, error: "Only whoever built this list can share it." };
  // A list of companies, or of its own rows (Smart Lists phase 3 — src/lib/connect/own-rows.ts); never a calling activity.
  if (wb.mode !== "LIST" && wb.mode !== "ROWS") return { ok: false, error: "A calling activity can't be shared — only Smart Lists." };
  const guest = await guestFor(input.guestId);
  if (!guest || guest.status === "SUSPENDED") return { ok: false, error: "Choose a guest who has been invited and isn't stopped." };
  const until = await untilOf(input.until);
  if (until === false) return { ok: false, error: "Sharing must end on a day still to come." };
  // New to them — never shared, or taken back since — and they hear of it; a changed end date alone tells them nothing.
  const before = await db.listShare.findUnique({ where: { workbookId_guestId: { workbookId: wb.id, guestId: guest.id } }, select: { revokedAt: true } });
  const isNew = !before || !!before.revokedAt;
  await db.listShare.upsert({
    where: { workbookId_guestId: { workbookId: wb.id, guestId: guest.id } },
    create: { workbookId: wb.id, guestId: guest.id, until, sharedById: user.id },
    update: { until, revokedAt: null, sharedById: user.id },
    select: { id: true },
  });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Workbook", entityId: wb.id, entityLabel: `${wb.name}: shared with guest ${guest.name} (${guest.email})${until ? ` until ${until.toISOString().slice(0, 10)}` : ""}` });
  if (isNew) await noticeListShared(guest.id, wb.id, user.name ?? "");
  revalidatePath(`/smart-lists/${wb.id}`);
  changed();
  return { ok: true, data: null };
}

/** Taken back at once: the guest's next click shows nothing of the list. */
export async function unshareList(shareId: string): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("workspace");
  if (!(await ready())) return { ok: true, data: null };
  const share = typeof shareId === "string" ? await db.listShare.findUnique({ where: { id: shareId }, select: { id: true, workbookId: true, guest: { select: { name: true } } } }) : null;
  if (!share) return { ok: true, data: null };
  const wb = await editableList(user.id, share.workbookId);
  if (!wb) return { ok: false, error: "Only whoever built this list can take it back." };
  await db.listShare.update({ where: { id: share.id }, data: { revokedAt: new Date() }, select: { id: true } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Workbook", entityId: wb.id, entityLabel: `${wb.name}: taken back from guest ${share.guest.name}` });
  revalidatePath(`/smart-lists/${wb.id}`);
  changed();
  return { ok: true, data: null };
}

// ─── The activity report (phase 4) ────────────────────────────────────────────

export type GuestActivityRow = {
  id: string;
  name: string;
  email: string;
  connection: string;
  status: "INVITED" | "ACTIVE" | "SUSPENDED";
  lastSignInAt: string | null;
  signIns: number;
  edits: number;
  comments: number;
  suggested: number;
  added: number;
  lists: string[];
};
export type ListActivityRow = { id: string; name: string; guests: number; edits: number; comments: number; suggested: number };
export type ActivityReport = { days: number; guests: GuestActivityRow[]; lists: ListActivityRow[]; allowance: GuestAllowance };

/** What guests did over the last `days` (7, 30 or 90): each guest's sign-ins, edits, comments and suggestions, and each list's. */
export async function guestActivityReport(days = 30): Promise<ActivityReport | null> {
  const user = await manager();
  if (!user || !(await ready())) return null;
  const span = [7, 30, 90].includes(days) ? days : 30;
  const since = new Date(Date.now() - span * DAY);
  const [guests, byGuest, byList, suggestions, shares, allowance] = await Promise.all([
    db.guest.findMany({ select: { id: true, name: true, email: true, status: true, lastSignInAt: true, connection: { select: { name: true } } } }),
    db.guestActivity.groupBy({ by: ["guestId", "kind"], where: { at: { gte: since } }, _count: { _all: true } }),
    db.guestActivity.groupBy({ by: ["workbookId", "kind"], where: { at: { gte: since }, workbookId: { not: null } }, _count: { _all: true } }),
    db.listSuggestion.groupBy({ by: ["guestId", "status"], where: { createdAt: { gte: since } }, _count: { _all: true } }),
    db.listShare.findMany({ where: { revokedAt: null }, select: { guestId: true, workbook: { select: { id: true, name: true } } } }),
    guestAllowance(),
  ]);
  const count = (rows: { _count: { _all: number } }[]) => rows.reduce((n, r) => n + r._count._all, 0);
  const guestRows: GuestActivityRow[] = guests.map((g) => {
    const mine = byGuest.filter((r) => r.guestId === g.id);
    const kind = (k: string) => count(mine.filter((r) => r.kind === k));
    const sugg = suggestions.filter((s) => s.guestId === g.id);
    return {
      id: g.id,
      name: g.name,
      email: g.email,
      connection: g.connection.name,
      status: g.status,
      lastSignInAt: g.lastSignInAt?.toISOString() ?? null,
      signIns: kind("SIGN_IN"),
      edits: kind("EDIT"),
      comments: kind("COMMENT"),
      suggested: count(sugg),
      added: count(sugg.filter((s) => s.status === "LINKED" || s.status === "CREATED")),
      lists: shares.filter((s) => s.guestId === g.id).map((s) => s.workbook.name),
    };
  });
  guestRows.sort((a, b) => b.edits + b.comments + b.suggested + b.signIns - (a.edits + a.comments + a.suggested + a.signIns) || a.name.localeCompare(b.name));
  const listIds = [...new Set([...shares.map((s) => s.workbook.id), ...byList.map((r) => r.workbookId!).filter(Boolean)])];
  const listNames = new Map((await db.workbook.findMany({ where: { id: { in: listIds } }, select: { id: true, name: true } })).map((w) => [w.id, w.name]));
  const lists: ListActivityRow[] = listIds
    .filter((id) => listNames.has(id))
    .map((id) => {
      const mine = byList.filter((r) => r.workbookId === id);
      const kind = (k: string) => count(mine.filter((r) => r.kind === k));
      return { id, name: listNames.get(id)!, guests: shares.filter((s) => s.workbook.id === id).length, edits: kind("EDIT"), comments: kind("COMMENT"), suggested: kind("SUGGEST") };
    })
    .sort((a, b) => b.edits + b.comments + b.suggested - (a.edits + a.comments + a.suggested) || a.name.localeCompare(b.name));
  return { days: span, guests: guestRows, lists, allowance };
}

/**
 * Whether this list's guests are emailed when something changes (owner, 20 Nov 2026: "let the person who is managing the
 * smart list decide if guest email notifications allow or not") — whoever may edit the list says. The invitation and
 * sign-in codes go whatever this says.
 */
export async function setListGuestEmails(workbookId: string, on: boolean): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("workspace");
  if (!(await ready())) return { ok: false, error: NOT_YET };
  const wb = await editableList(user.id, workbookId);
  if (!wb) return { ok: false, error: "Only whoever built this list can change this." };
  const emailGuests = on === true;
  try {
    await db.workbookGuestSettings.upsert({ where: { workbookId: wb.id }, create: { workbookId: wb.id, emailGuests, updatedById: user.id }, update: { emailGuests, updatedById: user.id }, select: { workbookId: true } });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_YET };
    throw err;
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Workbook", entityId: wb.id, entityLabel: `${wb.name}: guests ${emailGuests ? "are" : "aren't"} emailed when something changes` });
  revalidatePath(`/smart-lists/${wb.id}`);
  return { ok: true, data: null };
}

// ─── Which rows a guest sees (owner, 20 Nov 2026) ─────────────────────────────
//
// "only accounts nominated by our sales team will be shown to lc team. also external users record view by their
// territory" — src/lib/connect/row-scope.ts narrows every guest read and write by these two.

async function orEmpty<T>(q: Promise<T[]>): Promise<T[]> {
  try {
    return await q;
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

async function scopesOf(shareIds: string[]): Promise<Map<string, string | null>> {
  if (!shareIds.length) return new Map();
  const rows = await orEmpty(db.listShareScope.findMany({ where: { shareId: { in: shareIds } }, select: { shareId: true, onlyPropertyId: true } }));
  return new Map(rows.map((r) => [r.shareId, r.onlyPropertyId]));
}

async function territoriesOf(guestIds: string[]): Promise<Map<string, string[]>> {
  if (!guestIds.length) return new Map();
  const rows = await orEmpty(db.guestTerritory.findMany({ where: { guestId: { in: guestIds } }, select: { guestId: true, states: true } }));
  return new Map(rows.map((r) => [r.guestId, r.states]));
}

async function columnsOf(shareIds: string[]): Promise<Map<string, string[]>> {
  if (!shareIds.length) return new Map();
  const rows = await orEmpty(db.listShareColumns.findMany({ where: { shareId: { in: shareIds } }, select: { shareId: true, columnIds: true } }));
  return new Map(rows.map((r) => [r.shareId, r.columnIds]));
}

/** The states a territory is picked from: the country's own (India's, the UAE's emirates) and any on a company's address. */
async function territoryChoices(): Promise<string[]> {
  const pack = workspacePack();
  const own = pack.india ? INDIAN_STATES.map((s) => s.name) : [];
  const used = await db.companyLocation.findMany({ where: { state: { not: null } }, distinct: ["state"], orderBy: { state: "asc" }, select: { state: true }, take: 300 });
  const seen = new Map<string, string>();
  for (const name of [...own, ...used.map((u) => u.state ?? "")]) {
    const t = name.trim();
    if (t && !seen.has(t.toLowerCase())) seen.set(t.toLowerCase(), t);
  }
  return [...seen.values()].sort((a, b) => a.localeCompare(b));
}

/**
 * A share shows only the rows ticked in one of the list's Checkbox columns — or, with none, every row. Whoever may edit
 * the list says; the sales team then nominates an account by ticking it.
 */
export async function setShareRows(shareId: string, propertyId: string | null): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("workspace");
  if (!(await ready())) return { ok: false, error: NOT_YET };
  const share = typeof shareId === "string" && shareId ? await db.listShare.findUnique({ where: { id: shareId }, select: { id: true, workbookId: true, guest: { select: { name: true } } } }) : null;
  if (!share) return { ok: false, error: "That share no longer exists." };
  const wb = await editableList(user.id, share.workbookId);
  if (!wb) return { ok: false, error: "Only whoever built this list can change this." };
  let column: { id: string; name: string } | null = null;
  if (propertyId) {
    column = await db.workbookProperty.findFirst({ where: { id: String(propertyId), workbookId: wb.id, kind: "CHECKBOX" }, select: { id: true, name: true } });
    if (!column) return { ok: false, error: "Pick one of this list's Checkbox columns." };
  }
  try {
    await db.listShareScope.upsert({
      where: { shareId: share.id },
      create: { shareId: share.id, onlyPropertyId: column?.id ?? null, updatedById: user.id },
      update: { onlyPropertyId: column?.id ?? null, updatedById: user.id },
      select: { shareId: true },
    });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_YET };
    throw err;
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Workbook", entityId: wb.id, entityLabel: `${wb.name}: guest ${share.guest.name} sees ${column ? `only rows ticked in “${column.name}”` : "every row"}` });
  revalidatePath(`/smart-lists/${wb.id}`);
  return { ok: true, data: null };
}

/**
 * Which of the list's guest columns one share shows (owner, 20 Nov 2026) — the LC team their LC columns, the territory
 * reps their sales ones, on the same list. Null: every column marked for guests, as before. Only columns marked visible
 * to guests can be chosen; whoever may edit the list says.
 */
export async function setShareColumns(shareId: string, columnIds: string[] | null): Promise<ActionResult<null>> {
  const user = await requireModuleAccess("workspace");
  if (!(await ready())) return { ok: false, error: NOT_YET };
  const share = typeof shareId === "string" && shareId ? await db.listShare.findUnique({ where: { id: shareId }, select: { id: true, workbookId: true, guest: { select: { name: true } } } }) : null;
  if (!share) return { ok: false, error: "That share no longer exists." };
  const wb = await editableList(user.id, share.workbookId);
  if (!wb) return { ok: false, error: "Only whoever built this list can change this." };
  let names = "every column marked for guests";
  try {
    if (columnIds === null) {
      await db.listShareColumns.deleteMany({ where: { shareId: share.id } });
    } else {
      const asked = [...new Set((Array.isArray(columnIds) ? columnIds : []).filter((x): x is string => typeof x === "string"))];
      const cols = await db.workbookProperty.findMany({ where: { workbookId: wb.id, guestVisible: true, id: { in: asked } }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true } });
      if (cols.length !== asked.length) return { ok: false, error: "Pick from this list's columns marked visible to guests." };
      await db.listShareColumns.upsert({ where: { shareId: share.id }, create: { shareId: share.id, columnIds: cols.map((c) => c.id), updatedById: user.id }, update: { columnIds: cols.map((c) => c.id), updatedById: user.id }, select: { shareId: true } });
      names = cols.length ? cols.map((c) => `“${c.name}”`).join(", ") : "no columns of the list's own";
    }
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_YET };
    throw err;
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Workbook", entityId: wb.id, entityLabel: `${wb.name}: guest ${share.guest.name} sees ${names}` });
  revalidatePath(`/smart-lists/${wb.id}`);
  return { ok: true, data: null };
}

/** A guest's territory: the states they see companies in, in every list shared with them. None — every state. */
export async function setGuestTerritory(guestId: string, states: string[]): Promise<ActionResult<{ states: string[] }>> {
  const user = await manager();
  if (!user) return { ok: false, error: MANAGERS_ONLY };
  if (!(await ready())) return { ok: false, error: NOT_YET };
  const guest = await guestFor(guestId);
  if (!guest) return { ok: false, error: "That guest no longer exists." };
  const picked = [...new Map((Array.isArray(states) ? states : []).map((v) => clean(v, 80)).filter(Boolean).map((v) => [v.toLowerCase(), v])).values()].slice(0, 60);
  try {
    await db.guestTerritory.upsert({ where: { guestId: guest.id }, create: { guestId: guest.id, states: picked, updatedById: user.id }, update: { states: picked, updatedById: user.id }, select: { guestId: true } });
  } catch (err) {
    if (notMigratedYet(err)) return { ok: false, error: NOT_YET };
    throw err;
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Guest", entityId: guest.id, entityLabel: `${guest.name} (${guest.email}): territory ${picked.length ? picked.join(", ") : "every state"}` });
  changed();
  return { ok: true, data: { states: picked } };
}


// ─── Seeing what a guest sees (owner, 20 Nov 2026) ────────────────────────────
//
// "let admin see the view of each guest just like admin can see the other users" — for whoever manages guests: the
// guest's own pages, read through the very functions the guest's are (src/lib/connect/guest-lists.ts, working.ts), so
// what shows is exactly what they get — the list narrowed to their ticked rows and territory, the columns marked for
// them. Nothing is changed from here: no cell, comment or suggestion; and the guest's activity report isn't touched.

export type GuestPreview = { id: string; name: string; email: string; connection: string; canSignIn: boolean; status: "INVITED" | "ACTIVE" | "SUSPENDED"; territory: string[]; shares: GuestShare[] };

/** The guest and what is shared with them now — or null for somebody who doesn't manage guests, or no such guest. */
export async function previewGuest(guestId: string): Promise<GuestPreview | null> {
  if (!(await manager()) || !(await ready()) || typeof guestId !== "string" || !guestId) return null;
  const g = await db.guest.findUnique({ where: { id: guestId }, select: { id: true, name: true, email: true, status: true, inviteExpiresAt: true, accessUntil: true, connection: { select: { name: true } } } });
  if (!g) return null;
  const [shares, territory] = await Promise.all([guestShares(g.id), territoriesOf([g.id])]);
  return { id: g.id, name: g.name, email: g.email, connection: g.connection.name, status: g.status, canSignIn: guestMaySignIn(g), territory: territory.get(g.id) ?? [], shares };
}

/** One of their lists as they see it. */
export async function previewGuestList(guestId: string, shareId: string, opts: { search?: string; page?: number } = {}): Promise<GuestListView | null> {
  if (!(await manager()) || !(await ready()) || typeof guestId !== "string" || !guestId) return null;
  return guestListView(guestId, shareId, opts);
}

/** A row's page as they see it: their contact and the shared comments — never an internal one. */
export async function previewGuestRow(guestId: string, shareId: string, companyId: string): Promise<GuestRowDetail | null> {
  if (!(await manager()) || !(await ready()) || typeof guestId !== "string" || !guestId) return null;
  return guestRowDetail(guestId, shareId, companyId);
}
