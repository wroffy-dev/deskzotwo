"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { recordAudit } from "@/lib/audit";
import { logActivity } from "@/lib/activity";
import type { ActionResult } from "@/actions/company";
import { openList } from "@/lib/smart-lists/open-list";
import { workspaceClock } from "@/lib/time/workspace";
import { toWorkbookBuffer } from "@/lib/portability/export";
import { loadWorkbook } from "@/lib/portability/workbook";
import { LIMITS, cleanChecklist, isLinkKind, optionsOf, parseValue, type ChecklistItem, type PropertyKind } from "@/lib/smart-lists/values";
import { checkedCellValue } from "@/lib/smart-lists/links";
import { dropFilesNotIn, dropFilesOfRows } from "@/lib/smart-lists/files";
import { recordChanges } from "@/lib/smart-lists/history";
import { mayChangeRow, ROW_NOT_YOURS, VIEW_ONLY } from "@/lib/smart-lists/access";
import { emitRowsAdded, emitValuesChanged } from "@/lib/automate/emit-smart-lists";
import { templateByKey } from "@/lib/smart-lists/templates";
import { companyTemplateByKey } from "@/lib/smart-lists/company-templates";
import { IMPORT_LIMITS, parseCsv, suggestMapping, tidyTable, type ImportTarget } from "@/lib/smart-lists/own-rows-import";
import { OWN_ROWS, cleanTitle, createRowList, importRows, ownRowsReady, propsOf, rowListSheet, rowPageOf, titleNameOf, type ImportResult } from "@/lib/smart-lists/own-rows";
import { TEXT_MAX, clip, clipOrNull } from "@/lib/text/bounded";
import { cellsOfRow, copiedCells, repeatsOf, runDueRepeats, saveRepeat, type RepeatLine } from "@/lib/smart-lists/repeats";

/**
 * Smart Lists with rows of their own (owner, 20 Nov 2026 — src/lib/smart-lists/own-rows.ts): making one (empty or from
 * a template), its rows, their cells and pages, and a spreadsheet in or out. Records only — nothing is checked outside
 * Deskzo.
 *
 * Who may do what — the list's own rule (src/lib/smart-lists/open-list.ts), as a company list's columns follow it:
 *   · make one: whoever may use Smart Lists;
 *   · open it, add rows, fill them in, write a row's page, download it: whoever may open the list — a shared list is a
 *     team's table;
 *   · delete a row: whoever added it, or whoever may edit the list;
 *   · import a spreadsheet, rename the title column: whoever may edit the list (an import can make columns).
 */

const NOT_YET = "This workspace is still being updated. Try again in a few minutes.";
const GONE = "That list no longer exists.";

async function openRowList(workbookId: unknown) {
  const opened = await openList(workbookId);
  if (!opened || opened.workbook.mode !== "ROWS") return null;
  return opened;
}

async function openRow(rowId: unknown) {
  if (typeof rowId !== "string" || !rowId || !(await ownRowsReady())) return null;
  const row = await db.workbookRow.findUnique({ where: { id: rowId }, select: { id: true, workbookId: true, title: true, createdByUserId: true } });
  if (!row) return null;
  const opened = await openRowList(row.workbookId);
  return opened ? { opened, row } : null;
}

const changed = (workbookId: string) => revalidatePath(`/smart-lists/${workbookId}`);

// ─── Making one ───────────────────────────────────────────────────────────────

export async function createOwnRowList(input: { name: string; description?: string; shared?: boolean; template?: string | null }): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleAccess("workspace");
  if (!(await ownRowsReady())) return { ok: false, error: NOT_YET };
  // Deskzo's own templates, or the company's ("custom:<id>" — Smart Lists phase 3).
  const template = input?.template ? (templateByKey(input.template) ?? (await companyTemplateByKey(input.template))) : null;
  if (input?.template && !template) return { ok: false, error: "That template isn't one Deskzo offers." };
  const name = clip(input?.name, TEXT_MAX.name) || template?.name || "";
  if (!name) return { ok: false, error: "Give the list a name — it's how anyone finds it again." };
  const id = await createRowList({
    userId: user.id,
    name,
    description: clipOrNull(input.description ?? template?.description ?? null, TEXT_MAX.paragraph),
    shared: input.shared ?? true,
    template,
  });
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "Workbook", entityId: id, entityLabel: template ? `${name} (from the ${template.name} template)` : name });
  revalidatePath("/smart-lists");
  return { ok: true, data: { id } };
}

/** The title column renamed — "Linking page", "Unit". */
export async function renameTitleColumn(input: { workbookId: string; name: string }): Promise<ActionResult<null>> {
  const opened = await openRowList(input?.workbookId);
  if (!opened) return { ok: false, error: GONE };
  if (!opened.canEdit) return { ok: false, error: "Only whoever built this list can rename its columns." };
  const name = cleanTitle(input.name).slice(0, OWN_ROWS.titleName);
  if (!name) return { ok: false, error: "A column needs a name." };
  await db.workbookRowSettings.upsert({ where: { workbookId: opened.workbook.id }, create: { workbookId: opened.workbook.id, titleName: name }, update: { titleName: name }, select: { workbookId: true } });
  changed(opened.workbook.id);
  return { ok: true, data: null };
}

// ─── Rows ─────────────────────────────────────────────────────────────────────

export async function addOwnRow(input: { workbookId: string; title: string }): Promise<ActionResult<{ id: string; title: string; createdAt: string }>> {
  const opened = await openRowList(input?.workbookId);
  if (!opened) return { ok: false, error: GONE };
  if (!opened.canFill) return { ok: false, error: VIEW_ONLY };
  if (!(await ownRowsReady())) return { ok: false, error: NOT_YET };
  const title = cleanTitle(input.title);
  if (!title) return { ok: false, error: "Give the row a title." };
  const workbookId = opened.workbook.id;
  const [count, last] = await Promise.all([db.workbookRow.count({ where: { workbookId } }), db.workbookRow.aggregate({ where: { workbookId }, _max: { sortOrder: true } })]);
  if (count >= OWN_ROWS.perList) return { ok: false, error: `A list holds up to ${OWN_ROWS.perList.toLocaleString("en-IN")} rows.` };
  const row = await db.$transaction(async (tx) => {
    const made = await tx.workbookRow.create({
      data: { workbookId, title, sortOrder: (last._max.sortOrder ?? 0) + 10, createdByUserId: opened.userId, updatedByUserId: opened.userId },
      select: { id: true, title: true, createdAt: true },
    });
    // For Deskzo Automate's "A row is added to a Smart List" (Smart Lists phase 3).
    await emitRowsAdded(tx, [{ workbookId, listName: opened.workbook.name, own: true, rowKey: made.id, title: made.title }], "hand", opened.userId);
    return made;
  });
  await recordChanges([{ workbookId, rowKey: row.id, kind: "ADDED", byUserId: opened.userId }]);
  changed(workbookId);
  return { ok: true, data: { id: row.id, title: row.title, createdAt: row.createdAt.toISOString() } };
}

export async function renameOwnRow(input: { rowId: string; title: string }): Promise<ActionResult<{ title: string }>> {
  const found = await openRow(input?.rowId);
  if (!found) return { ok: false, error: "That row no longer exists." };
  const title = cleanTitle(input.title);
  if (!title) return { ok: false, error: "A row needs a title." };
  if (!(await mayChangeRow(found.opened.rights, found.opened.userId, found.row.workbookId, true, found.row.id))) return { ok: false, error: found.opened.canFill ? ROW_NOT_YOURS : VIEW_ONLY };
  await db.workbookRow.update({ where: { id: found.row.id }, data: { title, updatedByUserId: found.opened.userId }, select: { id: true } });
  if (title !== found.row.title) await recordChanges([{ workbookId: found.row.workbookId, rowKey: found.row.id, kind: "TITLE", before: found.row.title, after: title, byUserId: found.opened.userId }]);
  return { ok: true, data: { title } };
}

/** Rows deleted, with their values and pages — each one this person added, or all of them if they may edit the list. */
export async function deleteOwnRows(input: { workbookId: string; rowIds: string[] }): Promise<ActionResult<{ deleted: number }>> {
  const opened = await openRowList(input?.workbookId);
  if (!opened) return { ok: false, error: GONE };
  if (!opened.canFill) return { ok: false, error: VIEW_ONLY };
  if (!(await ownRowsReady())) return { ok: false, error: NOT_YET };
  const ids = [...new Set((Array.isArray(input.rowIds) ? input.rowIds : []).filter((x) => typeof x === "string" && x))].slice(0, 500);
  const rows = await db.workbookRow.findMany({ where: { workbookId: opened.workbook.id, id: { in: ids } }, select: { id: true, createdByUserId: true } });
  const allowed = rows.filter((r) => opened.canEdit || r.createdByUserId === opened.userId);
  if (rows.length && !allowed.length) return { ok: false, error: "Only whoever added a row, or whoever built the list, can delete it." };
  const { count } = await db.workbookRow.deleteMany({ where: { id: { in: allowed.map((r) => r.id) } } });
  await dropFilesOfRows(opened.workbook.id, allowed.map((r) => r.id));
  if (count) {
    await recordAudit({ userId: opened.userId, action: "UPDATE", entityType: "Workbook", entityId: opened.workbook.id, entityLabel: `${opened.workbook.name}: ${count} row(s) deleted` });
    changed(opened.workbook.id);
  }
  return { ok: true, data: { deleted: count } };
}

/**
 * A copy of a row, just below it (Smart Lists phase 4): its title, what was typed or picked in it, its notes and its
 * checklist — not its files (a cell's own) or its comments. The copy is this person's. Under the own-rows rule its
 * Person column says them, so the copy is theirs to change.
 */
export async function duplicateOwnRow(input: { rowId: string }): Promise<ActionResult<{ id: string; title: string }>> {
  const found = await openRow(input?.rowId);
  if (!found) return { ok: false, error: "That row no longer exists." };
  const { opened, row } = found;
  if (!opened.canFill) return { ok: false, error: VIEW_ONLY };
  const workbookId = row.workbookId;
  if ((await db.workbookRow.count({ where: { workbookId } })) >= OWN_ROWS.perList) return { ok: false, error: `A list holds up to ${OWN_ROWS.perList.toLocaleString("en-IN")} rows.` };
  const source = await db.workbookRow.findUnique({ where: { id: row.id }, select: { sortOrder: true, notes: true, checklist: true } });
  if (!source) return { ok: false, error: "That row no longer exists." };
  const cells = (await copiedCells(workbookId, await cellsOfRow(row.id))).filter((c) => c.propertyId !== opened.rights.ownerPropertyId);
  if (opened.rights.rowRule === "OWN" && opened.rights.ownerPropertyId) cells.push({ propertyId: opened.rights.ownerPropertyId, value: opened.userId });
  const title = cleanTitle(row.title);
  const copy = await db.$transaction(async (tx) => {
    // Just below the original: the rows after it move down one place.
    await tx.workbookRow.updateMany({ where: { workbookId, sortOrder: { gt: source.sortOrder } }, data: { sortOrder: { increment: 10 } } });
    const made = await tx.workbookRow.create({
      data: { workbookId, title, sortOrder: source.sortOrder + 5, notes: source.notes, checklist: source.checklist as Prisma.InputJsonValue, createdByUserId: opened.userId, updatedByUserId: opened.userId },
      select: { id: true, title: true },
    });
    if (cells.length) await tx.workbookRowValue.createMany({ data: cells.map((c) => ({ workbookId, rowId: made.id, propertyId: c.propertyId, value: c.value, updatedByUserId: opened.userId })) });
    await emitRowsAdded(tx, [{ workbookId, listName: opened.workbook.name, own: true, rowKey: made.id, title: made.title }], "hand", opened.userId);
    return made;
  });
  await recordChanges([{ workbookId, rowKey: copy.id, kind: "ADDED", after: `a copy of "${row.title}"`, byUserId: opened.userId }]);
  changed(workbookId);
  return { ok: true, data: copy };
}

/**
 * A row moved — dragged above or below another (Smart Lists phase 4). The order is the list's, for everybody who
 * opens it without a sort, so whoever may fill the list in may move its rows.
 */
export async function moveOwnRow(input: { rowId: string; targetRowId: string; place: "before" | "after" }): Promise<ActionResult<null>> {
  const found = await openRow(input?.rowId);
  if (!found) return { ok: false, error: "That row no longer exists." };
  const { opened, row } = found;
  if (!opened.canFill) return { ok: false, error: VIEW_ONLY };
  const workbookId = row.workbookId;
  if (typeof input.targetRowId !== "string" || input.targetRowId === row.id) return { ok: true, data: null };
  const target = await db.workbookRow.findFirst({ where: { id: input.targetRowId, workbookId }, select: { id: true } });
  if (!target) return { ok: false, error: "That row no longer exists." };
  // Numbered again in tens, in order, with the moved row placed beside its target.
  const all = await db.workbookRow.findMany({ where: { workbookId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, sortOrder: true } });
  const order = all.map((r) => r.id).filter((id) => id !== row.id);
  const at = order.indexOf(target.id);
  order.splice(input.place === "after" ? at + 1 : at, 0, row.id);
  const was = new Map(all.map((r) => [r.id, r.sortOrder]));
  const moves = order.map((id, i) => ({ id, sortOrder: (i + 1) * 10 })).filter((m) => was.get(m.id) !== m.sortOrder);
  await db.$transaction(async (tx) => {
    for (let i = 0; i < moves.length; i += 500) {
      const chunk = moves.slice(i, i + 500);
      await tx.$executeRawUnsafe(
        `UPDATE "workbook_rows" AS r SET "sortOrder" = v.n FROM (SELECT * FROM unnest($1::text[], $2::int[]) AS t(id, n)) AS v WHERE r."id" = v.id AND r."workbookId" = $3`,
        chunk.map((m) => m.id),
        chunk.map((m) => m.sortOrder),
        workbookId,
      );
    }
  });
  changed(workbookId);
  return { ok: true, data: null };
}

// ─── Repeating rows (Smart Lists phase 4) ─────────────────────────────────────

/** A list's repeats — for whoever may change it. */
export async function listRepeats(workbookId: string): Promise<RepeatLine[] | null> {
  const opened = await openRowList(workbookId);
  if (!opened || !opened.canEdit) return null;
  return repeatsOf(opened.workbook.id);
}

/** A repeat set up — from a row (its title and cells the pattern) — or changed: its title, how often, its first date. */
export async function saveListRepeat(input: { workbookId: string; id?: string | null; fromRowId?: string | null; title: string; every: string; startOn: string; active?: boolean }): Promise<ActionResult<{ id: string; nextOn: string }>> {
  const opened = await openRowList(input?.workbookId);
  if (!opened) return { ok: false, error: GONE };
  if (!opened.canEdit) return { ok: false, error: "Only whoever may change this list can make rows repeat." };
  const from = input.fromRowId ? await db.workbookRow.findFirst({ where: { id: input.fromRowId, workbookId: opened.workbook.id }, select: { id: true } }) : null;
  if (input.fromRowId && !from) return { ok: false, error: "That row no longer exists." };
  const today = (await workspaceClock()).today();
  try {
    const saved = await saveRepeat({ workbookId: opened.workbook.id, id: input.id ?? null, title: input.title, every: input.every, startOn: input.startOn, active: input.active, cells: from ? await cellsOfRow(from.id) : undefined, userId: opened.userId, today });
    if (!saved.ok) return saved;
    await recordAudit({ userId: opened.userId, action: input.id ? "UPDATE" : "CREATE", entityType: "Workbook", entityId: opened.workbook.id, entityLabel: `${opened.workbook.name}: the repeat "${input.title}"${input.active === false ? " (stopped)" : ""}` });
    // One due today comes now, not tomorrow morning.
    if (saved.nextOn <= today && input.active !== false) await runDueRepeats(today);
    changed(opened.workbook.id);
    return { ok: true, data: { id: saved.id, nextOn: saved.nextOn } };
  } catch {
    return { ok: false, error: NOT_YET };
  }
}

export async function deleteListRepeat(input: { workbookId: string; id: string }): Promise<ActionResult<null>> {
  const opened = await openRowList(input?.workbookId);
  if (!opened) return { ok: false, error: GONE };
  if (!opened.canEdit) return { ok: false, error: "Only whoever may change this list can delete its repeats." };
  const rep = typeof input.id === "string" ? await db.workbookRepeat.findFirst({ where: { id: input.id, workbookId: opened.workbook.id }, select: { id: true, title: true } }).catch(() => null) : null;
  if (!rep) return { ok: true, data: null };
  await db.workbookRepeat.delete({ where: { id: rep.id } });
  await recordAudit({ userId: opened.userId, action: "UPDATE", entityType: "Workbook", entityId: opened.workbook.id, entityLabel: `${opened.workbook.name}: the repeat "${rep.title}" deleted — rows it added stay` });
  return { ok: true, data: null };
}

/** One cell of an own row. Empty removes it. */
export async function setOwnRowValue(input: { propertyId: string; rowId: string; value: unknown }): Promise<ActionResult<{ value: unknown | null }>> {
  const found = await openRow(input?.rowId);
  if (!found) return { ok: false, error: "That row no longer exists." };
  const prop = typeof input.propertyId === "string" ? await db.workbookProperty.findFirst({ where: { id: input.propertyId, workbookId: found.row.workbookId }, select: { id: true, name: true, kind: true, options: true } }) : null;
  if (!prop) return { ok: false, error: "That column no longer exists." };
  // View-only, or another person's row under the own-rows rule (Smart Lists phase 4 — src/lib/smart-lists/access.ts).
  if (!(await mayChangeRow(found.opened.rights, found.opened.userId, found.row.workbookId, true, found.row.id))) return { ok: false, error: found.opened.canFill ? ROW_NOT_YOURS : VIEW_ONLY };
  const kind = prop.kind as PropertyKind;
  const parsed = parseValue(kind, input.value, optionsOf(prop.options));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (kind === "PERSON" && parsed.value !== null) {
    const person = await db.user.findFirst({ where: { id: String(parsed.value), active: true }, select: { id: true } });
    if (!person) return { ok: false, error: "Pick somebody from the list." };
  }
  // A link keeps only records the person may link (and any already there they can't see); a file only this cell's own
  // (src/lib/smart-lists/links.ts — Smart Lists phase 2).
  let kept = parsed.value;
  const held = await db.workbookRowValue.findUnique({ where: { propertyId_rowId: { propertyId: prop.id, rowId: found.row.id } }, select: { value: true } });
  if (Array.isArray(kept) && (isLinkKind(kind) || kind === "FILE")) {
    const checked = await checkedCellValue(kind, prop.id, prop.options, found.row.id, kept as string[], held?.value, found.opened.userId);
    if (!Array.isArray(checked)) return { ok: false, error: checked.error };
    kept = checked.length ? checked : null;
  }
  const by = found.opened.userId;
  await db.$transaction(async (tx) => {
    if (kept === null) {
      await tx.workbookRowValue.deleteMany({ where: { propertyId: prop.id, rowId: found.row.id } });
    } else {
      const value = kept as Prisma.InputJsonValue;
      await tx.workbookRowValue.upsert({
        where: { propertyId_rowId: { propertyId: prop.id, rowId: found.row.id } },
        create: { workbookId: found.row.workbookId, propertyId: prop.id, rowId: found.row.id, value, updatedByUserId: by },
        update: { value, updatedByUserId: by },
        select: { id: true },
      });
    }
    // The row was changed, by whom — its "last changed".
    await tx.workbookRow.update({ where: { id: found.row.id }, data: { updatedByUserId: by }, select: { id: true } });
    // For Deskzo Automate's "A column changes on a Smart List row" (Smart Lists phase 3).
    await emitValuesChanged(tx, {
      rows: [{ workbookId: found.row.workbookId, listName: found.opened.workbook.name, own: true, rowKey: found.row.id, title: found.row.title, before: held?.value ?? null }],
      column: { id: prop.id, name: prop.name, kind, options: prop.options },
      after: kept,
      actorUserId: by,
    });
  });
  // A file taken out of its cell goes.
  if (kind === "FILE") await dropFilesNotIn(prop.id, found.row.id, Array.isArray(kept) ? (kept as string[]) : []);
  // Its history (Smart Lists phase 3): what it was, what it is, who.
  await recordChanges([{ workbookId: found.row.workbookId, rowKey: found.row.id, kind: "VALUE", propertyId: prop.id, before: held?.value ?? null, after: kept, byUserId: by }]);
  return { ok: true, data: { value: kept } };
}

// ─── A row's page ─────────────────────────────────────────────────────────────

export type OwnRowPage = { notes: string; checklist: ChecklistItem[]; createdBy: string | null; createdAt: string; updatedBy: string | null; updatedAt: string };

export async function getOwnRowPage(rowId: string): Promise<OwnRowPage | null> {
  const found = await openRow(rowId);
  return found ? rowPageOf(found.row.id) : null;
}

export async function saveOwnRowPage(input: { rowId: string; notes?: string; checklist?: unknown }): Promise<ActionResult<{ updatedAt: string }>> {
  const found = await openRow(input?.rowId);
  if (!found) return { ok: false, error: "That row no longer exists." };
  if (!(await mayChangeRow(found.opened.rights, found.opened.userId, found.row.workbookId, true, found.row.id))) return { ok: false, error: found.opened.canFill ? ROW_NOT_YOURS : VIEW_ONLY };
  const data: { notes?: string; checklist?: Prisma.InputJsonValue; updatedByUserId: string } = { updatedByUserId: found.opened.userId };
  if (input.notes !== undefined) data.notes = String(input.notes ?? "").slice(0, LIMITS.notes);
  if (input.checklist !== undefined) data.checklist = cleanChecklist(input.checklist) as unknown as Prisma.InputJsonValue;
  const saved = await db.workbookRow.update({ where: { id: found.row.id }, data, select: { updatedAt: true } });
  return { ok: true, data: { updatedAt: saved.updatedAt.toISOString() } };
}

// ─── A spreadsheet in ─────────────────────────────────────────────────────────

export type ImportPreview = { headers: string[]; rows: string[][]; cut: number; mapping: ImportTarget[]; titleName: string; columns: { id: string; name: string; kind: PropertyKind }[] };

const MAX_FILE = 4 * 1024 * 1024;

/** A CSV or Excel file read for the import dialog: its rows, and where each column would go. Nothing is saved. */
export async function readImportFile(formData: FormData): Promise<ActionResult<ImportPreview>> {
  const opened = await openRowList(formData.get("workbookId"));
  if (!opened) return { ok: false, error: GONE };
  if (!opened.canEdit) return { ok: false, error: "Only whoever built this list can import into it." };
  if (!(await ownRowsReady())) return { ok: false, error: NOT_YET };
  const file = formData.get("file");
  if (!(file instanceof File) || file.size === 0) return { ok: false, error: "Choose a CSV or Excel file." };
  if (file.size > MAX_FILE) return { ok: false, error: "That file is larger than 4 MB. Split it, or keep the columns you need." };
  const lower = file.name.toLowerCase();
  let table: string[][];
  try {
    if (lower.endsWith(".csv") || lower.endsWith(".txt") || file.type === "text/csv") {
      table = parseCsv(new TextDecoder("utf-8").decode(await file.arrayBuffer()));
    } else if (lower.endsWith(".xlsx")) {
      const wb = await loadWorkbook(new Uint8Array(await file.arrayBuffer()), file.name);
      // A Deskzo download opens with its cover sheet; the rows are on the sheet after it.
      const ws = wb.worksheets.find((w) => w.name !== "About this export") ?? wb.worksheets[0];
      table = [];
      ws?.eachRow({ includeEmpty: false }, (row) => {
        const cells: string[] = [];
        row.eachCell({ includeEmpty: true }, (cell, col) => {
          const v = cell.value as unknown;
          cells[col - 1] =
            v instanceof Date
              ? v.toISOString().slice(0, 10)
              : v && typeof v === "object" && "text" in (v as object)
                ? String((v as { text: unknown }).text ?? "")
                : v && typeof v === "object" && "result" in (v as object)
                  ? String((v as { result: unknown }).result ?? "")
                  : v && typeof v === "object" && "richText" in (v as object)
                    ? ((v as { richText: { text: string }[] }).richText ?? []).map((t) => t.text).join("")
                    : String(v ?? "");
        });
        table.push(Array.from({ length: cells.length }, (_, i) => cells[i] ?? ""));
      });
    } else {
      return { ok: false, error: "Choose a .csv or .xlsx file." };
    }
  } catch (err) {
    return { ok: false, error: err instanceof Error && /at most|larger|columns|rows/i.test(err.message) ? err.message : "That file couldn't be read. Save it as CSV or .xlsx and try again." };
  }
  const { headers, rows, cut } = tidyTable(table);
  if (!headers.some(Boolean) || rows.length === 0) return { ok: false, error: "The file needs a header row and at least one row under it." };
  const [titleName, props] = await Promise.all([titleNameOf(opened.workbook.id), propsOf(opened.workbook.id)]);
  return {
    ok: true,
    data: { headers, rows, cut, titleName, columns: props.map((p) => ({ id: p.id, name: p.name, kind: p.kind })), mapping: suggestMapping(headers, rows, props, titleName) },
  };
}

/** The rows read, added to the list where the person chose. */
export async function importOwnRows(input: { workbookId: string; headers: string[]; rows: string[][]; mapping: ImportTarget[] }): Promise<ActionResult<ImportResult>> {
  const opened = await openRowList(input?.workbookId);
  if (!opened) return { ok: false, error: GONE };
  if (!opened.canEdit) return { ok: false, error: "Only whoever built this list can import into it." };
  if (!(await ownRowsReady())) return { ok: false, error: NOT_YET };
  if (!Array.isArray(input.headers) || !Array.isArray(input.rows) || !Array.isArray(input.mapping)) return { ok: false, error: "Open the import again." };
  if (input.headers.length > IMPORT_LIMITS.columns + 1) return { ok: false, error: `A file can bring up to ${IMPORT_LIMITS.columns} columns.` };
  const mapping = input.mapping.map((m): ImportTarget => {
    if (m?.to === "title") return { to: "title" };
    if (m?.to === "column" && typeof m.propertyId === "string") return { to: "column", propertyId: m.propertyId };
    if (m?.to === "new" && typeof m.name === "string" && (["TEXT", "NUMBER", "MONEY", "DATE", "SELECT", "MULTI_SELECT", "CHECKBOX", "LINK", "RATING", "EMAIL", "PHONE", "COMPANY", "LEAD", "CONTACT"] as string[]).includes(m.kind)) return { to: "new", kind: m.kind, name: m.name };
    return { to: "skip" };
  });
  const done = await importRows({ workbookId: opened.workbook.id, userId: opened.userId, headers: input.headers.map((h) => String(h ?? "")), rows: input.rows, mapping });
  if (!done.ok) return done;
  await recordAudit({ userId: opened.userId, action: "UPDATE", entityType: "Workbook", entityId: opened.workbook.id, entityLabel: `${opened.workbook.name}: ${done.result.rows} row(s) imported${done.result.columns ? `, ${done.result.columns} column(s) added` : ""}` });
  changed(opened.workbook.id);
  return { ok: true, data: done.result };
}

// ─── Excel out ────────────────────────────────────────────────────────────────

/** The whole list as an Excel file, for whoever may open it — logged, as every download is. */
export async function exportOwnRows(workbookId: string): Promise<ActionResult<{ filename: string; contentType: string; base64: string; rows: number }>> {
  const opened = await openRowList(workbookId);
  if (!opened) return { ok: false, error: GONE };
  if (!(await ownRowsReady())) return { ok: false, error: NOT_YET };
  const user = await requireModuleAccess("workspace");
  const sheet = await rowListSheet(opened.workbook.id, opened.userId);
  const buffer = await toWorkbookBuffer([{ name: opened.workbook.name.slice(0, 31).replace(/[\\/?*[\]:]/g, " ") || "List", rows: sheet.rows }], { title: opened.workbook.name, by: `${user.name} <${user.email}>`, generatedAt: new Date() });
  await logActivity({ kind: "EXPORT", severity: "NOTICE", summary: `${user.name} downloaded ${sheet.count} row(s) of the Smart List ${opened.workbook.name}`, metadata: { report: "smart-list", workbookId: opened.workbook.id, rows: sheet.count } });
  const today = (await workspaceClock()).today();
  const slug = opened.workbook.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "list";
  return { ok: true, data: { filename: `${slug}-${today}.xlsx`, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64: buffer.toString("base64"), rows: sheet.count } };
}
