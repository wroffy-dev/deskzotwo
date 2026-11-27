import { db } from "@/lib/db";
import { optionsOf, parseValue, readValue, type PropertyKind, type SelectOption } from "@/lib/smart-lists/values";
import { guestSuggestionsFor, ownerContacts, type GuestSuggestion } from "@/lib/connect/working";
import { recordGuestActivity } from "@/lib/connect/activity";
import { recordChanges } from "@/lib/smart-lists/history";
import { guestRowsWhere, guestSeesRow, shareColumns } from "@/lib/connect/row-scope";
import { ownGuestView, setOwnGuestValue, GUEST_HIDDEN_KINDS } from "@/lib/connect/own-rows";

/**
 * Deskzo Connect — what a signed-in guest sees (owner, 20 Nov 2026: "in any scenario or case the outsider can not go
 * outside this list"). Everything here starts from the guest's id, never from anything a page sent alone:
 *
 *   · **Their shares only**: not revoked, not past its date, of a list (not a calling activity). A share id from
 *     anywhere else answers nothing.
 *   · **The list's rows as its builder sees them**: the list's filters and companies added by hand, inside the builder's
 *     own company scope (src/lib/smart-lists/membership.ts) — the builder chose to share them.
 *   · **Narrowed for them** (src/lib/connect/row-scope.ts): only rows ticked in the share's Checkbox column, if it has
 *     one, and only companies in the guest's territory, if they have one.
 *   · **Only columns marked for guests** — and, where the share chose some, only those (row-scope.ts `shareColumns`), and only those marked editable take a guest's change. A company's own record
 *     — notes, contacts, amounts, other lists — is never read here.
 *
 * Server only; src/actions/connect-public.ts is the door, and it signs the guest in first.
 */

export type GuestShare = { id: string; listName: string; until: string | null; sharedBy: string | null };
export type GuestColumn = { id: string; name: string; kind: PropertyKind; options: SelectOption[]; editable: boolean };
export type GuestRow = { id: string; name: string; place: string };
export type GuestListView = {
  share: GuestShare;
  columns: GuestColumn[];
  rows: GuestRow[];
  values: Record<string, Record<string, unknown>>;
  total: number;
  /** Who a Person column may name — their names only. */
  people: { id: string; name: string }[];
  /** Each row's account owner, by name — the guest's contact (phase 3; the row page shows how to reach them). */
  contacts: Record<string, string>;
  /** What this guest suggested for the list, and what became of it. */
  suggestions: GuestSuggestion[];
  /** A list of its own rows (Smart Lists phase 3): what its title column is called — no places, contacts or suggestions. */
  own?: { titleName: string } | null;
};

// A list of companies, or of its own rows (Smart Lists phase 3) — never a calling activity. Asked as "not a calling
// activity", so a workspace not yet migrated to know ROWS still answers.
const live = (now: Date) => ({ revokedAt: null, OR: [{ until: null }, { until: { gt: now } }], workbook: { mode: { not: "COLD_CALLING" as const } } });

export async function guestShares(guestId: string, now = new Date()): Promise<GuestShare[]> {
  const rows = await db.listShare.findMany({
    where: { guestId, ...live(now) },
    orderBy: { createdAt: "asc" },
    select: { id: true, until: true, sharedById: true, workbook: { select: { name: true } } },
  });
  const sharers = await db.user.findMany({ where: { id: { in: rows.map((r) => r.sharedById).filter((x): x is string => !!x) } }, select: { id: true, name: true } });
  const by = new Map(sharers.map((u) => [u.id, u.name]));
  return rows.map((r) => ({ id: r.id, listName: r.workbook.name, until: r.until?.toISOString() ?? null, sharedBy: r.sharedById ? (by.get(r.sharedById) ?? null) : null }));
}

/** One live share of this guest's, with its list — or null. */
async function openShare(guestId: string, shareId: unknown, now: Date) {
  if (typeof shareId !== "string" || !shareId) return null;
  return db.listShare.findFirst({
    where: { id: shareId, guestId, ...live(now) },
    select: { id: true, until: true, sharedById: true, workbook: { select: { id: true, name: true, filters: true, ownerUserId: true, mode: true } } },
  });
}

async function guestColumns(workbookId: string, shareId: string): Promise<GuestColumn[]> {
  const only = await shareColumns(shareId);
  const props = await db.workbookProperty.findMany({
    where: { workbookId, guestVisible: true, ...(only ? { id: { in: only } } : {}) },
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
    select: { id: true, name: true, kind: true, options: true, guestEditable: true },
  });
  // Never a column whose cells are ids of records or files elsewhere, nor a count through another list — a guest would see
  // what their staff can't (Smart Lists phases 2 and 3).
  return props.filter((p) => !GUEST_HIDDEN_KINDS.includes(p.kind as PropertyKind)).map((p) => ({ id: p.id, name: p.name, kind: p.kind as PropertyKind, options: optionsOf(p.options), editable: p.guestEditable }));
}

const PAGE = 100;

export async function guestListView(guestId: string, shareId: unknown, opts: { search?: string; page?: number } = {}, now = new Date()): Promise<GuestListView | null> {
  const share = await openShare(guestId, shareId, now);
  if (!share) return null;
  const wb = share.workbook;
  if (wb.mode === "ROWS") return ownGuestView(guestId, share, await guestColumns(wb.id, share.id), opts);
  const members = await guestRowsWhere(guestId, share.id, wb);
  const search = String(opts.search ?? "").trim().slice(0, 80);
  const where = { AND: [members, ...(search ? [{ name: { contains: search, mode: "insensitive" as const } }] : [])] };
  const page = Math.max(1, Math.floor(Number(opts.page) || 1));
  const [companies, total, columns] = await Promise.all([
    db.company.findMany({
      where,
      orderBy: { name: "asc" },
      skip: (page - 1) * PAGE,
      take: PAGE,
      select: { id: true, name: true, locations: { orderBy: { isPrimary: "desc" }, take: 1, select: { city: true, state: true } } },
    }),
    db.company.count({ where }),
    guestColumns(wb.id, share.id),
  ]);
  const ids = companies.map((c) => c.id);
  const byId = new Map(columns.map((c) => [c.id, c]));
  const stored = ids.length && columns.length ? await db.workbookValue.findMany({ where: { workbookId: wb.id, companyId: { in: ids }, propertyId: { in: columns.map((c) => c.id) } }, select: { propertyId: true, companyId: true, value: true } }) : [];
  const values: GuestListView["values"] = {};
  for (const v of stored) {
    const col = byId.get(v.propertyId);
    if (!col) continue;
    const read = readValue(col.kind, v.value, col.options);
    if (read !== null) (values[v.companyId] ??= {})[v.propertyId] = read;
  }
  // A Person column shows names only — of the people its cells name, and, where a guest may set it, the active staff.
  const named = new Set<string>();
  for (const c of columns.filter((c) => c.kind === "PERSON")) for (const id of ids) if (typeof values[id]?.[c.id] === "string") named.add(values[id]![c.id] as string);
  const anyPersonEditable = columns.some((c) => c.kind === "PERSON" && c.editable);
  const people = named.size || anyPersonEditable ? await db.user.findMany({ where: anyPersonEditable ? { OR: [{ id: { in: [...named] } }, { active: true }] } : { id: { in: [...named] } }, orderBy: { name: "asc" }, select: { id: true, name: true } }) : [];
  const sharer = share.sharedById ? await db.user.findUnique({ where: { id: share.sharedById }, select: { name: true } }) : null;
  const [contacts, suggestions] = await Promise.all([ownerContacts(ids), guestSuggestionsFor(guestId, wb.id)]);
  return {
    share: { id: share.id, listName: wb.name, until: share.until?.toISOString() ?? null, sharedBy: sharer?.name ?? null },
    columns,
    rows: companies.map((c) => ({ id: c.id, name: c.name, place: [c.locations[0]?.city, c.locations[0]?.state].filter(Boolean).join(", ") })),
    values,
    total,
    people,
    contacts: Object.fromEntries([...contacts].map(([id, c]) => [id, c.name])),
    suggestions,
  };
}

/** A guest's change to one cell: a column marked editable for guests, of a company in the shared list. */
export async function setGuestValue(guestId: string, input: { shareId: unknown; propertyId: unknown; companyId: unknown; value: unknown }, now = new Date()): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  const share = await openShare(guestId, input.shareId, now);
  if (!share) return { ok: false, error: "This list isn't shared with you any more." };
  const wb = share.workbook;
  const only = await shareColumns(share.id);
  const found = typeof input.propertyId === "string" && (!only || only.includes(input.propertyId)) ? await db.workbookProperty.findFirst({ where: { id: input.propertyId, workbookId: wb.id, guestVisible: true, guestEditable: true }, select: { id: true, kind: true, options: true } }) : null;
  const prop = found && !GUEST_HIDDEN_KINDS.includes(found.kind as PropertyKind) ? found : null;
  if (!prop) return { ok: false, error: "That column isn't one you can change." };
  // A row of a list of its own (Smart Lists phase 3).
  if (wb.mode === "ROWS") return setOwnGuestValue(guestId, share, prop, input.companyId, input.value);
  const companyId = typeof input.companyId === "string" ? input.companyId : "";
  if (!(await guestSeesRow(guestId, share.id, wb, companyId))) return { ok: false, error: "That company isn't in this list." };
  const kind = prop.kind as PropertyKind;
  const parsed = parseValue(kind, input.value, optionsOf(prop.options));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (kind === "PERSON" && parsed.value !== null && !(await db.user.findFirst({ where: { id: String(parsed.value), active: true }, select: { id: true } }))) return { ok: false, error: "Pick somebody from the list." };
  // What it was, for the row's history (Smart Lists phase 4).
  const held = await db.workbookValue.findUnique({ where: { propertyId_companyId: { propertyId: prop.id, companyId } }, select: { value: true } });
  if (parsed.value === null) {
    await db.workbookValue.deleteMany({ where: { propertyId: prop.id, companyId } });
  } else {
    const value = parsed.value as object;
    await db.workbookValue.upsert({
      where: { propertyId_companyId: { propertyId: prop.id, companyId } },
      create: { workbookId: wb.id, propertyId: prop.id, companyId, value, updatedByUserId: null },
      update: { value, updatedByUserId: null },
      select: { id: true },
    });
  }
  await recordGuestActivity(guestId, "EDIT", wb.id);
  // In the row's history, by the guest's name (Smart Lists phase 4).
  await recordChanges([{ workbookId: wb.id, rowKey: companyId, kind: "VALUE", propertyId: prop.id, before: held?.value ?? null, after: parsed.value, byUserId: null, byGuestId: guestId }]);
  return { ok: true, value: parsed.value };
}
