import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { optionsOf, parseValue, readValue, type PropertyKind, type SelectOption } from "@/lib/smart-lists/values";
import { recordGuestActivity } from "@/lib/connect/activity";
import { shareOnlyColumn } from "@/lib/connect/row-scope";
import { titleNameOf } from "@/lib/smart-lists/own-rows";
import { recordChanges } from "@/lib/smart-lists/history";
import type { GuestColumn, GuestListView } from "@/lib/connect/guest-lists";
import type { RowComment } from "@/lib/connect/working";

/**
 * Deskzo Connect for a list of its own rows (owner, 20 Nov 2026 — Smart Lists phase 3: "an agency shares its content
 * calendar or backlink tracker with a client, and the client sees only the columns you allow"). The same rules as a list
 * of companies (src/lib/connect/guest-lists.ts), from the guest's id and one of their live shares:
 *
 *   · the list's rows — narrowed by the share's tick column, if it has one; a territory is about companies, so it doesn't
 *     narrow these;
 *   · only the columns marked for guests (and the share's choice of them), never one whose cells are ids of records or
 *     files elsewhere, nor a count through another list;
 *   · a change only to a column marked editable; comments shared with guests — a guest's own team's and the staff's —
 *     never an internal one. No account owner to show, no companies to suggest or correct. Server only.
 */

/** Columns a guest never sees: ids of records or files elsewhere, a count through another list, or a formula — which can
 * work out from columns kept from them. */
export const GUEST_HIDDEN_KINDS: readonly PropertyKind[] = ["COMPANY", "LEAD", "CONTACT", "ROW", "FILE", "ROLLUP", "FORMULA"];

type Share = { id: string; until: Date | null; sharedById: string | null; workbook: { id: string; name: string } };

async function rowsWhere(shareId: string, workbookId: string): Promise<Prisma.WorkbookRowWhereInput> {
  const only = await shareOnlyColumn(shareId);
  return { workbookId, ...(only ? { values: { some: { propertyId: only, value: { equals: true } } } } : {}) };
}

/** Whether one own row is among those a share shows. */
export async function guestSeesOwnRow(shareId: string, workbookId: string, rowId: unknown): Promise<boolean> {
  if (typeof rowId !== "string" || !rowId) return false;
  return (await db.workbookRow.count({ where: { AND: [await rowsWhere(shareId, workbookId), { id: rowId }] } })) > 0;
}

const PAGE = 100;

export async function ownGuestView(guestId: string, share: Share, columns: GuestColumn[], opts: { search?: string; page?: number }): Promise<GuestListView> {
  const wb = share.workbook;
  const search = String(opts.search ?? "").trim().slice(0, 80);
  const where: Prisma.WorkbookRowWhereInput = { AND: [await rowsWhere(share.id, wb.id), ...(search ? [{ title: { contains: search, mode: "insensitive" as const } }] : [])] };
  const page = Math.max(1, Math.floor(Number(opts.page) || 1));
  const [rows, total, titleName] = await Promise.all([
    db.workbookRow.findMany({ where, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], skip: (page - 1) * PAGE, take: PAGE, select: { id: true, title: true } }),
    db.workbookRow.count({ where }),
    titleNameOf(wb.id),
  ]);
  const ids = rows.map((r) => r.id);
  const byId = new Map(columns.map((c) => [c.id, c]));
  const stored = ids.length && columns.length ? await db.workbookRowValue.findMany({ where: { rowId: { in: ids }, propertyId: { in: columns.map((c) => c.id) } }, select: { propertyId: true, rowId: true, value: true } }) : [];
  const values: GuestListView["values"] = {};
  for (const v of stored) {
    const col = byId.get(v.propertyId);
    if (!col) continue;
    const read = readValue(col.kind, v.value, col.options);
    if (read !== null) (values[v.rowId] ??= {})[v.propertyId] = read;
  }
  const named = new Set<string>();
  for (const c of columns.filter((c) => c.kind === "PERSON")) for (const id of ids) if (typeof values[id]?.[c.id] === "string") named.add(values[id]![c.id] as string);
  const anyPersonEditable = columns.some((c) => c.kind === "PERSON" && c.editable);
  const people = named.size || anyPersonEditable ? await db.user.findMany({ where: anyPersonEditable ? { OR: [{ id: { in: [...named] } }, { active: true }] } : { id: { in: [...named] } }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [];
  const sharer = share.sharedById ? await db.user.findUnique({ where: { id: share.sharedById }, select: { name: true } }) : null;
  void guestId;
  return {
    share: { id: share.id, listName: wb.name, until: share.until?.toISOString() ?? null, sharedBy: sharer?.name ?? null },
    columns,
    rows: rows.map((r) => ({ id: r.id, name: r.title, place: "" })),
    values,
    total,
    people,
    contacts: {},
    suggestions: [],
    own: { titleName },
  };
}

/** A guest's change to one cell of an own row — the column already checked as theirs to change. */
export async function setOwnGuestValue(guestId: string, share: { id: string; workbook: { id: string } }, prop: { id: string; kind: string; options: unknown }, rowId: unknown, raw: unknown): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  if (!(await guestSeesOwnRow(share.id, share.workbook.id, rowId))) return { ok: false, error: "That row isn't in this list." };
  const id = rowId as string;
  const kind = prop.kind as PropertyKind;
  const parsed = parseValue(kind, raw, optionsOf(prop.options) as SelectOption[]);
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (kind === "PERSON" && parsed.value !== null && !(await db.user.findFirst({ where: { id: String(parsed.value), active: true }, select: { id: true } }))) return { ok: false, error: "Pick somebody from the list." };
  // What it was, for the row's history (Smart Lists phase 4).
  const held = await db.workbookRowValue.findUnique({ where: { propertyId_rowId: { propertyId: prop.id, rowId: id } }, select: { value: true } });
  if (parsed.value === null) await db.workbookRowValue.deleteMany({ where: { propertyId: prop.id, rowId: id } });
  else {
    const value = parsed.value as Prisma.InputJsonValue;
    await db.workbookRowValue.upsert({
      where: { propertyId_rowId: { propertyId: prop.id, rowId: id } },
      create: { workbookId: share.workbook.id, propertyId: prop.id, rowId: id, value, updatedByUserId: null },
      update: { value, updatedByUserId: null },
      select: { id: true },
    });
  }
  await recordGuestActivity(guestId, "EDIT", share.workbook.id);
  // In the row's history, by the guest's name (Smart Lists phase 4).
  await recordChanges([{ workbookId: share.workbook.id, rowKey: id, kind: "VALUE", propertyId: prop.id, before: held?.value ?? null, after: parsed.value, byUserId: null, byGuestId: guestId }]);
  return { ok: true, value: parsed.value };
}

/** An own row's comments for a guest: shared ones — the staff's, and their own team's guests' — never an internal one. */
export async function ownRowComments(rowId: string, viewer: { connectionId: string }): Promise<RowComment[]> {
  const rows = await db.workbookRowComment.findMany({ where: { rowId, shared: true }, orderBy: { createdAt: "asc" }, take: 200, select: { id: true, body: true, authorUserId: true, authorGuestId: true, audienceConnectionId: true, createdAt: true } }).catch(() => []);
  const guests = new Map(
    (await db.guest.findMany({ where: { id: { in: rows.map((r) => r.authorGuestId).filter((x): x is string => !!x) } }, select: { id: true, name: true, connectionId: true } })).map((g) => [g.id, g]),
  );
  const users = new Map((await db.user.findMany({ where: { id: { in: rows.map((r) => r.authorUserId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return rows
    // The team rules of a company row's comments (src/lib/connect/working.ts): a staff comment to every guest or to their
    // team; a guest's comment to their own team only.
    .filter((r) => (r.authorUserId ? !r.audienceConnectionId || r.audienceConnectionId === viewer.connectionId : !!r.authorGuestId && guests.get(r.authorGuestId)?.connectionId === viewer.connectionId))
    .map((r) => ({
      id: r.id,
      body: r.body,
      author: r.authorUserId ? (users.get(r.authorUserId) ?? "Somebody") : (guests.get(r.authorGuestId!)?.name ?? "A guest"),
      byGuest: !r.authorUserId,
      shared: true,
      at: r.createdAt.toISOString(),
    }));
}

export async function addOwnRowGuestComment(guestId: string, workbookId: string, rowId: string, body: string): Promise<RowComment> {
  const made = await db.workbookRowComment.create({ data: { workbookId, rowId, body, authorGuestId: guestId, shared: true }, select: { id: true, createdAt: true } });
  const g = await db.guest.findUnique({ where: { id: guestId }, select: { name: true } });
  return { id: made.id, body, author: g?.name ?? "You", byGuest: true, shared: true, at: made.createdAt.toISOString() };
}
