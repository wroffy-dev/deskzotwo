"use server";

import { revalidatePath } from "next/cache";
import type { ListPropertyKind, ListViewKind, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { openList } from "@/lib/smart-lists/open-list";
import { companyScope } from "@/lib/authz/company-scope";
import { searchCompanyOptions } from "@/actions/company-options";
import type { ActionResult } from "@/actions/company";
import { companyInList, listMembersWhere, smartListsReady } from "@/lib/smart-lists/membership";
import { listDashboard, type ListDashboard } from "@/lib/smart-lists/dashboard";
import { workspaceClock } from "@/lib/time/workspace";
import type { WorkbookFilters } from "@/lib/workspace/filters";
import { checkedCellValue, mayOpenList } from "@/lib/smart-lists/links";
import { dropFilesNotIn } from "@/lib/smart-lists/files";
import { recordChanges } from "@/lib/smart-lists/history";
import { mayChangeRow, ROW_NOT_YOURS, VIEW_ONLY } from "@/lib/smart-lists/access";
import { checkRollup } from "@/lib/smart-lists/rollups";
import { FORMULA_FORMATS, compileFormula, formulaOf, type Formula } from "@/lib/smart-lists/formulas";
import { recomputeFormulas } from "@/lib/smart-lists/formula-server";
import { emitValuesChanged } from "@/lib/automate/emit-smart-lists";
import {
  LIMITS,
  cleanChecklist,
  cleanOptions,
  isLinkKind,
  isPropertyKind,
  isViewKind,
  linkTargetOf,
  optionsOf,
  rollupOf,
  type Rollup,
  parseValue,
  readValue,
  type ChecklistItem,
  type PropertyKind,
  type SelectOption,
  type ViewKind,
} from "@/lib/smart-lists/values";

/**
 * Smart Lists, Notion-style (owner, 20 Nov 2026 — src/lib/smart-lists): a list's own columns and their values, its saved
 * views (table, board, calendar), a page per row, and companies added by hand.
 *
 * Who may do what — the list's own rule (getWorkbook in src/actions/workspace.ts), nothing new:
 *   · open it (see its columns, values, views and row pages): whoever may open the list;
 *   · fill it in (values, row pages): the same people — a shared list is worked by a team — and only for a company that
 *     is in the list for them and theirs to see;
 *   · shape it (columns, views) and add or remove companies by hand: whoever may edit the list (its builder, or
 *     `workspace.manageAny`), and the people it is assigned to may add and remove companies too.
 */

const NOT_YET = "This workspace is still being updated. Try again in a few minutes.";

const GONE = "That list no longer exists.";
const SHAPE_ONLY = "Only whoever built this list can change its columns and views. Duplicate it to make your own version.";

function changed(workbookId: string) {
  revalidatePath(`/smart-lists/${workbookId}`);
}

// ─── Reading ──────────────────────────────────────────────────────────────────

export type BoardProperty = {
  id: string;
  name: string;
  kind: PropertyKind;
  options: SelectOption[];
  guestVisible?: boolean;
  guestEditable?: boolean;
  /** A "Row of another list" column's list (Smart Lists phase 2). */
  target?: string | null;
  /** A count column's set-up (Smart Lists phase 3). */
  rollup?: Rollup | null;
  /** A formula column's expression and what it works out (Smart Lists phase 4). */
  formula?: Formula | null;
};
/** `options`: a view's own settings — a timeline's end column and scale (Smart Lists phase 4). */
export type BoardView = { id: string; name: string; kind: ViewKind; propertyId: string | null; options?: { endPropertyId?: string | null; scale?: "week" | "month" } | null };
export type ListBoard = {
  ready: boolean;
  canEdit: boolean;
  canAddRows: boolean;
  /** May fill it in — not a view-only person (Smart Lists phase 4). */
  canFill?: boolean;
  properties: BoardProperty[];
  views: BoardView[];
  /** companyId → propertyId → value, for the companies asked about. */
  values: Record<string, Record<string, unknown>>;
  /** Companies added by hand, among those asked about. */
  pinned: string[];
  /** Who a Person column may name. */
  people: { id: string; name: string }[];
};

/** The list's columns, views and the values of `companyIds` — only those of them this person may see. */
export async function getListBoard(workbookId: string, companyIds: string[]): Promise<ListBoard | null> {
  const opened = await openList(workbookId);
  if (!opened) return null;
  const empty: ListBoard = { ready: false, canEdit: opened.canEdit, canFill: opened.canFill, canAddRows: opened.canEdit || opened.isAssignee, properties: [], views: [], values: {}, pinned: [], people: [] };
  if (!(await smartListsReady())) return empty;

  const asked = [...new Set((Array.isArray(companyIds) ? companyIds : []).filter((id) => typeof id === "string" && id))].slice(0, 1000);
  const [props, views, seen, people] = await Promise.all([
    db.workbookProperty.findMany({ where: { workbookId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, kind: true, options: true, guestVisible: true, guestEditable: true } }),
    db.workbookView.findMany({ where: { workbookId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, kind: true, propertyId: true } }),
    // Only companies this person may see: an id asked for from anywhere else answers nothing.
    asked.length ? db.company.findMany({ where: { AND: [await companyScope(opened.userId), { id: { in: asked } }] }, select: { id: true } }) : Promise.resolve([]),
    db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  const ids = seen.map((c) => c.id);
  const properties: BoardProperty[] = props.map((p) => ({
    id: p.id,
    name: p.name,
    kind: p.kind as PropertyKind,
    options: optionsOf(p.options),
    guestVisible: p.guestVisible,
    guestEditable: p.guestEditable,
    ...(p.kind === "ROW" ? { target: linkTargetOf(p.options) } : {}),
    ...(p.kind === "ROLLUP" ? { rollup: rollupOf(p.options) } : {}),
    ...(p.kind === "FORMULA" ? { formula: formulaOf(p.options) } : {}),
  }));
  const byId = new Map(properties.map((p) => [p.id, p]));
  const [rows, pins] = ids.length
    ? await Promise.all([
        db.workbookValue.findMany({ where: { workbookId, companyId: { in: ids } }, select: { propertyId: true, companyId: true, value: true } }),
        db.workbookPinnedRow.findMany({ where: { workbookId, companyId: { in: ids } }, select: { companyId: true } }),
      ])
    : [[], []];
  const values: ListBoard["values"] = {};
  for (const r of rows) {
    const p = byId.get(r.propertyId);
    if (!p) continue;
    const v = readValue(p.kind, r.value, p.options);
    if (v === null) continue;
    (values[r.companyId] ??= {})[r.propertyId] = v;
  }
  // A view's own settings (phase 4) — none on a workspace not migrated yet.
  const viewOptions = new Map(
    (await db.workbookViewOptions.findMany({ where: { viewId: { in: views.map((v) => v.id) } }, select: { viewId: true, options: true } }).catch(() => [])).map((o) => [o.viewId, o.options as BoardView["options"]]),
  );
  return { ...empty, ready: true, properties, views: views.map((v) => ({ ...v, kind: v.kind as ViewKind, options: viewOptions.get(v.id) ?? null })), values, pinned: pins.map((p) => p.companyId), people };
}

/** Only the values and hand-added marks of `companyIds` — for the rows a page shows, once its view is known. */
export async function getListValues(workbookId: string, companyIds: string[]): Promise<Pick<ListBoard, "values" | "pinned">> {
  const board = await getListBoard(workbookId, companyIds);
  return { values: board?.values ?? {}, pinned: board?.pinned ?? [] };
}

// ─── Columns ──────────────────────────────────────────────────────────────────

const cleanName = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

export async function addListProperty(input: { workbookId: string; name: string; kind: string; options?: unknown }): Promise<ActionResult<{ id: string }>> {
  const opened = await openList(input?.workbookId);
  if (!opened) return { ok: false, error: GONE };
  if (!opened.canEdit) return { ok: false, error: SHAPE_ONLY };
  if (!(await smartListsReady())) return { ok: false, error: NOT_YET };
  const name = cleanName(input.name, LIMITS.propertyName);
  if (!name) return { ok: false, error: "Give the column a name." };
  if (!isPropertyKind(input.kind)) return { ok: false, error: "Choose what kind of column it is." };
  const workbookId = opened.workbook.id;
  const existing = await db.workbookProperty.findMany({ where: { workbookId }, select: { name: true, sortOrder: true } });
  if (existing.length >= LIMITS.properties) return { ok: false, error: `A list holds up to ${LIMITS.properties} columns of its own.` };
  if (existing.some((p) => p.name.toLowerCase() === name.toLowerCase())) return { ok: false, error: `This list already has a column called "${name}".` };
  const options = input.kind === "SELECT" || input.kind === "MULTI_SELECT" ? cleanOptions(input.options) : null;
  // A "Row of another list" column names the list it links to — one with rows of its own the builder may open
  // (Smart Lists phase 2, src/lib/smart-lists/links.ts).
  let target: { listId: string } | null = null;
  if (input.kind === "ROW") {
    const listId = linkTargetOf(input.options);
    const list = listId ? await db.workbook.findFirst({ where: { id: listId, mode: "ROWS" }, select: { id: true } }).catch(() => null) : null;
    if (!list || !(await mayOpenList(opened.userId, list.id))) return { ok: false, error: "Choose the list whose rows it links to." };
    target = { listId: list.id };
  }
  // A count column looks through another list whose rows link here (Smart Lists phase 3, src/lib/smart-lists/rollups.ts).
  let rollup: Rollup | null = null;
  if (input.kind === "ROLLUP") {
    const checked = await checkRollup(opened.workbook.id, opened.userId, input.options);
    if ("error" in checked) return { ok: false, error: checked.error };
    rollup = checked;
  }
  // A formula over the list's columns (Smart Lists phase 4 — src/lib/smart-lists/formulas.ts).
  let formula: Formula | null = null;
  if (input.kind === "FORMULA") {
    const f = formulaOf(input.options);
    if (!f) return { ok: false, error: "Write the formula." };
    const all = await db.workbookProperty.findMany({ where: { workbookId: opened.workbook.id }, select: { id: true, name: true } });
    const c = compileFormula(f.expr, all);
    if (!c.ok) return { ok: false, error: c.error };
    formula = f;
  }
  const row = await db.workbookProperty.create({
    data: {
      workbookId,
      name,
      kind: input.kind as ListPropertyKind,
      options: options ? (options as unknown as Prisma.InputJsonValue) : target ? (target as Prisma.InputJsonValue) : rollup ? (rollup as unknown as Prisma.InputJsonValue) : formula ? (formula as unknown as Prisma.InputJsonValue) : undefined,
      sortOrder: Math.max(0, ...existing.map((p) => p.sortOrder)) + 10,
    },
    select: { id: true },
  });
  await recordAudit({ userId: opened.userId, action: "UPDATE", entityType: "Workbook", entityId: workbookId, entityLabel: `${opened.workbook.name}: column "${name}" added` });
  if (formula) await recomputeFormulas(workbookId);
  changed(workbookId);
  return { ok: true, data: { id: row.id } };
}

async function openProperty(id: unknown) {
  if (typeof id !== "string" || !id) return null;
  if (!(await smartListsReady())) return null;
  const prop = await db.workbookProperty.findUnique({ where: { id }, select: { id: true, workbookId: true, name: true, kind: true, options: true } });
  if (!prop) return null;
  const opened = await openList(prop.workbookId);
  return opened ? { opened, prop: { ...prop, kind: prop.kind as PropertyKind } } : null;
}

/** A column renamed, or a select's choices changed. A choice taken away leaves its rows empty for it. */
export async function updateListProperty(input: { id: string; name?: string; options?: unknown; guestVisible?: boolean; guestEditable?: boolean; formula?: { expr: string; format: string } }): Promise<ActionResult<null>> {
  const found = await openProperty(input?.id);
  if (!found) return { ok: false, error: "That column no longer exists." };
  const { opened, prop } = found;
  if (!opened.canEdit) return { ok: false, error: SHAPE_ONLY };
  const data: Prisma.WorkbookPropertyUpdateInput = {};
  if (input.name !== undefined) {
    const name = cleanName(input.name, LIMITS.propertyName);
    if (!name) return { ok: false, error: "A column needs a name." };
    if (name !== prop.name) {
      const clash = await db.workbookProperty.findFirst({ where: { workbookId: prop.workbookId, id: { not: prop.id }, name: { equals: name, mode: "insensitive" } }, select: { id: true } });
      if (clash) return { ok: false, error: `This list already has a column called "${name}".` };
      data.name = name;
    }
  }
  if (input.options !== undefined && (prop.kind === "SELECT" || prop.kind === "MULTI_SELECT")) {
    data.options = cleanOptions(input.options) as unknown as Prisma.InputJsonValue;
  }
  // A formula's expression or what it works out, changed — checked, then worked out again for every row (phase 4).
  let reformulated = false;
  if (input.formula !== undefined && prop.kind === "FORMULA") {
    const f = formulaOf({ expr: input.formula.expr, format: (FORMULA_FORMATS as readonly string[]).includes(input.formula.format) ? input.formula.format : "number" });
    if (!f) return { ok: false, error: "Write the formula." };
    const all = await db.workbookProperty.findMany({ where: { workbookId: prop.workbookId }, select: { id: true, name: true } });
    const c = compileFormula(f.expr, all, prop.id);
    if (!c.ok) return { ok: false, error: c.error };
    data.options = f as unknown as Prisma.InputJsonValue;
    reformulated = true;
  }
  // For Deskzo Connect: shown to guests the list is shared with, and editable by them — editable means shown.
  if (typeof input.guestVisible === "boolean") data.guestVisible = input.guestVisible;
  if (typeof input.guestEditable === "boolean") data.guestEditable = input.guestEditable;
  if (data.guestEditable === true) data.guestVisible = true;
  if (data.guestVisible === false) data.guestEditable = false;
  if (Object.keys(data).length === 0) return { ok: true, data: null };
  await db.workbookProperty.update({ where: { id: prop.id }, data, select: { id: true } });
  await recordAudit({ userId: opened.userId, action: "UPDATE", entityType: "Workbook", entityId: prop.workbookId, entityLabel: `${opened.workbook.name}: column "${prop.name}" changed` });
  // A renamed column: the list's formulas that name it say its new name (phase 4).
  if (typeof data.name === "string") {
    const said = new RegExp(`\\{\\s*${prop.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\}`, "gi");
    const others = (await db.workbookProperty.findMany({ where: { workbookId: prop.workbookId, id: { not: prop.id } }, select: { id: true, kind: true, options: true } })).filter((p) => p.kind === "FORMULA");
    for (const p of others) {
      const f = formulaOf(p.options);
      if (!f || !said.test(f.expr)) continue;
      said.lastIndex = 0;
      const expr = f.expr.replace(said, `{${data.name}}`);
      await db.workbookProperty.update({ where: { id: p.id }, data: { options: { ...f, expr } as unknown as Prisma.InputJsonValue }, select: { id: true } });
    }
  }
  // A renamed column a formula names, or a changed formula: work them out again.
  if (reformulated || data.name !== undefined) await recomputeFormulas(prop.workbookId);
  changed(prop.workbookId);
  return { ok: true, data: null };
}

export async function moveListProperty(id: string, direction: "left" | "right"): Promise<ActionResult<null>> {
  const found = await openProperty(id);
  if (!found) return { ok: false, error: "That column no longer exists." };
  if (!found.opened.canEdit) return { ok: false, error: SHAPE_ONLY };
  const list = await db.workbookProperty.findMany({ where: { workbookId: found.prop.workbookId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true } });
  const at = list.findIndex((p) => p.id === id);
  const to = direction === "left" ? at - 1 : at + 1;
  if (at < 0 || to < 0 || to >= list.length) return { ok: true, data: null };
  const order = list.map((p) => p.id);
  [order[at], order[to]] = [order[to]!, order[at]!];
  await db.$transaction(async (tx) => {
    for (const [i, pid] of order.entries()) await tx.workbookProperty.update({ where: { id: pid }, data: { sortOrder: (i + 1) * 10 }, select: { id: true } });
  });
  changed(found.prop.workbookId);
  return { ok: true, data: null };
}

/** A column and every value in it. A view that used it falls back to a plain table. */
export async function deleteListProperty(id: string): Promise<ActionResult<null>> {
  const found = await openProperty(id);
  if (!found) return { ok: true, data: null };
  const { opened, prop } = found;
  if (!opened.canEdit) return { ok: false, error: SHAPE_ONLY };
  await db.$transaction(async (tx) => {
    await tx.workbookView.updateMany({ where: { workbookId: prop.workbookId, propertyId: prop.id }, data: { propertyId: null } });
    await tx.workbookProperty.delete({ where: { id: prop.id } });
  });
  await recordAudit({ userId: opened.userId, action: "UPDATE", entityType: "Workbook", entityId: prop.workbookId, entityLabel: `${opened.workbook.name}: column "${prop.name}" deleted, with its values` });
  // A formula that used it works out empty now (phase 4).
  await recomputeFormulas(prop.workbookId);
  changed(prop.workbookId);
  return { ok: true, data: null };
}

// ─── Values ───────────────────────────────────────────────────────────────────

/** One cell: a company's value in one of the list's columns. Empty removes it. */
export async function setListValue(input: { propertyId: string; companyId: string; value: unknown }): Promise<ActionResult<{ value: unknown | null }>> {
  const found = await openProperty(input?.propertyId);
  if (!found) return { ok: false, error: "That column no longer exists." };
  const { opened, prop } = found;
  if (!(await companyInList(opened.userId, opened.workbook, input.companyId))) return { ok: false, error: "That company isn't in this list for you." };
  // View-only, or another person's row under the own-rows rule (Smart Lists phase 4 — src/lib/smart-lists/access.ts).
  if (!(await mayChangeRow(opened.rights, opened.userId, prop.workbookId, false, input.companyId))) return { ok: false, error: opened.canFill ? ROW_NOT_YOURS : VIEW_ONLY };
  const parsed = parseValue(prop.kind, input.value, optionsOf(prop.options));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (prop.kind === "PERSON" && parsed.value !== null) {
    const person = await db.user.findFirst({ where: { id: String(parsed.value), active: true }, select: { id: true } });
    if (!person) return { ok: false, error: "Pick somebody from the list." };
  }
  const where = { propertyId_companyId: { propertyId: prop.id, companyId: input.companyId } };
  // A link keeps only records the person may link (and any already there they can't see); a file only this cell's own
  // (src/lib/smart-lists/links.ts — Smart Lists phase 2).
  let kept = parsed.value;
  const held = await db.workbookValue.findUnique({ where, select: { value: true } });
  if (Array.isArray(kept) && (isLinkKind(prop.kind) || prop.kind === "FILE")) {
    const checked = await checkedCellValue(prop.kind, prop.id, prop.options, input.companyId, kept as string[], held?.value, opened.userId);
    if (!Array.isArray(checked)) return { ok: false, error: checked.error };
    kept = checked.length ? checked : null;
  }
  const companyName = (await db.company.findUnique({ where: { id: input.companyId }, select: { name: true } }))?.name ?? "";
  await db.$transaction(async (tx) => {
    if (kept === null) {
      await tx.workbookValue.deleteMany({ where: { propertyId: prop.id, companyId: input.companyId } });
    } else {
      const value = kept as Prisma.InputJsonValue;
      await tx.workbookValue.upsert({
        where,
        create: { workbookId: prop.workbookId, propertyId: prop.id, companyId: input.companyId, value, updatedByUserId: opened.userId },
        update: { value, updatedByUserId: opened.userId },
        select: { id: true },
      });
    }
    // For Deskzo Automate's "A column changes on a Smart List row" (Smart Lists phase 3).
    await emitValuesChanged(tx, {
      rows: [{ workbookId: prop.workbookId, listName: opened.workbook.name, own: false, rowKey: input.companyId, title: companyName, before: held?.value ?? null }],
      column: { id: prop.id, name: prop.name, kind: prop.kind, options: prop.options },
      after: kept,
      actorUserId: opened.userId,
    });
  });
  if (prop.kind === "FILE") await dropFilesNotIn(prop.id, input.companyId, Array.isArray(kept) ? (kept as string[]) : []);
  // Its history (Smart Lists phase 3): what it was, what it is, who.
  await recordChanges([{ workbookId: prop.workbookId, rowKey: input.companyId, kind: "VALUE", propertyId: prop.id, before: held?.value ?? null, after: kept, byUserId: opened.userId }]);
  return { ok: true, data: { value: kept } };
}

// ─── Views ────────────────────────────────────────────────────────────────────

async function viewPropertyOk(workbookId: string, kind: ViewKind, propertyId: unknown): Promise<string | null | false> {
  // A table and a gallery (Smart Lists phase 3) lay out every column; a board and a calendar need one.
  if (kind === "TABLE" || kind === "GALLERY") return null;
  if (typeof propertyId !== "string" || !propertyId) return false;
  const p = await db.workbookProperty.findFirst({ where: { id: propertyId, workbookId }, select: { kind: true } });
  if (!p) return false;
  if (kind === "BOARD" && p.kind !== "SELECT") return false;
  if ((kind === "CALENDAR" || kind === "TIMELINE") && p.kind !== "DATE") return false;
  return propertyId;
}

export async function addListView(input: { workbookId: string; name: string; kind: string; propertyId?: string | null }): Promise<ActionResult<{ id: string }>> {
  const opened = await openList(input?.workbookId);
  if (!opened) return { ok: false, error: GONE };
  if (!opened.canEdit) return { ok: false, error: SHAPE_ONLY };
  if (!(await smartListsReady())) return { ok: false, error: NOT_YET };
  if (!isViewKind(input.kind)) return { ok: false, error: "Choose a table, a board or a calendar." };
  const name = cleanName(input.name, LIMITS.viewName) || (input.kind === "BOARD" ? "Board" : input.kind === "CALENDAR" ? "Calendar" : input.kind === "GALLERY" ? "Gallery" : input.kind === "TIMELINE" ? "Timeline" : "Table");
  const workbookId = opened.workbook.id;
  const propertyId = await viewPropertyOk(workbookId, input.kind, input.propertyId);
  if (propertyId === false) return { ok: false, error: input.kind === "BOARD" ? "A board groups by a Select column — add one first." : input.kind === "TIMELINE" ? "A timeline draws rows from a Date column — add one first." : "A calendar places rows by a Date column — add one first." };
  const existing = await db.workbookView.findMany({ where: { workbookId }, select: { sortOrder: true } });
  if (existing.length >= LIMITS.views) return { ok: false, error: `A list keeps up to ${LIMITS.views} views.` };
  const row = await db.workbookView.create({
    data: { workbookId, name, kind: input.kind as ListViewKind, propertyId, sortOrder: Math.max(0, ...existing.map((v) => v.sortOrder)) + 10 },
    select: { id: true },
  });
  changed(workbookId);
  return { ok: true, data: { id: row.id } };
}

export async function updateListView(input: { id: string; name?: string; propertyId?: string | null }): Promise<ActionResult<null>> {
  if (!(await smartListsReady())) return { ok: false, error: NOT_YET };
  const view = typeof input?.id === "string" ? await db.workbookView.findUnique({ where: { id: input.id }, select: { id: true, workbookId: true, kind: true } }) : null;
  const opened = view ? await openList(view.workbookId) : null;
  if (!view || !opened) return { ok: false, error: "That view no longer exists." };
  if (!opened.canEdit) return { ok: false, error: SHAPE_ONLY };
  const data: Prisma.WorkbookViewUpdateInput = {};
  if (input.name !== undefined) {
    const name = cleanName(input.name, LIMITS.viewName);
    if (!name) return { ok: false, error: "A view needs a name." };
    data.name = name;
  }
  if (input.propertyId !== undefined) {
    const ok = await viewPropertyOk(view.workbookId, view.kind as ViewKind, input.propertyId);
    if (ok === false) return { ok: false, error: view.kind === "BOARD" ? "A board groups by a Select column." : "A calendar places rows by a Date column." };
    data.propertyId = ok;
  }
  if (Object.keys(data).length) await db.workbookView.update({ where: { id: view.id }, data, select: { id: true } });
  changed(view.workbookId);
  return { ok: true, data: null };
}

export async function deleteListView(id: string): Promise<ActionResult<null>> {
  if (!(await smartListsReady())) return { ok: true, data: null };
  const view = typeof id === "string" ? await db.workbookView.findUnique({ where: { id }, select: { id: true, workbookId: true } }) : null;
  const opened = view ? await openList(view.workbookId) : null;
  if (!view || !opened) return { ok: true, data: null };
  if (!opened.canEdit) return { ok: false, error: SHAPE_ONLY };
  await db.workbookView.delete({ where: { id: view.id } });
  changed(view.workbookId);
  return { ok: true, data: null };
}

// ─── Row pages ────────────────────────────────────────────────────────────────

export type RowPage = { notes: string; checklist: ChecklistItem[]; updatedAt: string | null };

export async function getRowPage(workbookId: string, companyId: string): Promise<RowPage | null> {
  const opened = await openList(workbookId);
  if (!opened || !(await smartListsReady())) return null;
  if (!(await companyInList(opened.userId, opened.workbook, companyId))) return null;
  const page = await db.workbookRowPage.findUnique({ where: { workbookId_companyId: { workbookId: opened.workbook.id, companyId } }, select: { notes: true, checklist: true, updatedAt: true } });
  return { notes: page?.notes ?? "", checklist: cleanChecklist(page?.checklist), updatedAt: page?.updatedAt.toISOString() ?? null };
}

export async function saveRowPage(input: { workbookId: string; companyId: string; notes?: string; checklist?: unknown }): Promise<ActionResult<RowPage>> {
  const opened = await openList(input?.workbookId);
  if (!opened) return { ok: false, error: GONE };
  if (!(await smartListsReady())) return { ok: false, error: NOT_YET };
  if (!(await companyInList(opened.userId, opened.workbook, input.companyId))) return { ok: false, error: "That company isn't in this list for you." };
  if (!(await mayChangeRow(opened.rights, opened.userId, opened.workbook.id, false, input.companyId))) return { ok: false, error: opened.canFill ? ROW_NOT_YOURS : VIEW_ONLY };
  const data: { notes?: string; checklist?: Prisma.InputJsonValue } = {};
  if (input.notes !== undefined) data.notes = String(input.notes ?? "").slice(0, LIMITS.notes);
  if (input.checklist !== undefined) data.checklist = cleanChecklist(input.checklist) as unknown as Prisma.InputJsonValue;
  const key = { workbookId: opened.workbook.id, companyId: input.companyId };
  const saved = await db.workbookRowPage.upsert({
    where: { workbookId_companyId: key },
    create: { ...key, ...data, updatedByUserId: opened.userId },
    update: { ...data, updatedByUserId: opened.userId },
    select: { notes: true, checklist: true, updatedAt: true },
  });
  return { ok: true, data: { notes: saved.notes, checklist: cleanChecklist(saved.checklist), updatedAt: saved.updatedAt.toISOString() } };
}

// ─── Companies added by hand ──────────────────────────────────────────────────

/** Companies this person may see whose name holds `query`, each marked when already in the list. */
export async function searchCompaniesForList(workbookId: string, query: string): Promise<{ id: string; name: string; inList: boolean }[]> {
  const opened = await openList(workbookId);
  if (!opened) return [];
  const found = await searchCompanyOptions(query);
  const inList = await Promise.all(found.map((c) => companyInList(opened.userId, opened.workbook, c.id)));
  return found.map((c, i) => ({ id: c.id, name: c.name, inList: inList[i]! }));
}

export async function pinListRow(workbookId: string, companyId: string): Promise<ActionResult<null>> {
  const opened = await openList(workbookId);
  if (!opened) return { ok: false, error: GONE };
  if (!opened.canEdit && !opened.isAssignee) return { ok: false, error: "Only whoever built this list, or somebody it is assigned to, can add companies to it." };
  if (!(await smartListsReady())) return { ok: false, error: NOT_YET };
  if (opened.workbook.mode !== "LIST") return { ok: false, error: "A calling activity's companies are fixed when it starts." };
  const seen = typeof companyId === "string" && companyId ? await db.company.findFirst({ where: { AND: [await companyScope(opened.userId), { id: companyId }] }, select: { id: true, name: true } }) : null;
  if (!seen) return { ok: false, error: "That company isn't one you can see." };
  await db.workbookPinnedRow.upsert({
    where: { workbookId_companyId: { workbookId: opened.workbook.id, companyId: seen.id } },
    create: { workbookId: opened.workbook.id, companyId: seen.id, addedByUserId: opened.userId },
    update: {},
    select: { workbookId: true },
  });
  await recordAudit({ userId: opened.userId, action: "UPDATE", entityType: "Workbook", entityId: opened.workbook.id, entityLabel: `${opened.workbook.name}: ${seen.name} added by hand` });
  changed(opened.workbook.id);
  return { ok: true, data: null };
}

/** Takes away a company added by hand. One the filters bring stays — change the filters for that. */
export async function unpinListRow(workbookId: string, companyId: string): Promise<ActionResult<null>> {
  const opened = await openList(workbookId);
  if (!opened) return { ok: false, error: GONE };
  if (!opened.canEdit && !opened.isAssignee) return { ok: false, error: "Only whoever built this list, or somebody it is assigned to, can take companies off it." };
  if (!(await smartListsReady())) return { ok: true, data: null };
  const { count } = await db.workbookPinnedRow.deleteMany({ where: { workbookId: opened.workbook.id, companyId } });
  if (count) {
    await recordAudit({ userId: opened.userId, action: "UPDATE", entityType: "Workbook", entityId: opened.workbook.id, entityLabel: `${opened.workbook.name}: a company added by hand taken off` });
    changed(opened.workbook.id);
  }
  return { ok: true, data: null };
}

// ─── The dashboard (owner, 20 Nov 2026) ───────────────────────────────────────

/** The whole list summed up for whoever may open it — the rows they see, never more (src/lib/smart-lists/dashboard.ts). */
export async function getListDashboard(workbookId: string): Promise<ListDashboard | null> {
  const opened = await openList(workbookId);
  if (!opened || opened.workbook.mode !== "LIST" || !(await smartListsReady())) return null;
  const members = await listMembersWhere(opened.userId, opened.workbook.id, (opened.workbook.filters ?? {}) as WorkbookFilters);
  return listDashboard({ userId: opened.userId, workbookId: opened.workbook.id, members, today: (await workspaceClock()).today() });
}
