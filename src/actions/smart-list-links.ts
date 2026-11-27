"use server";

import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { requireModuleAccess } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import type { ActionResult } from "@/actions/company";
import { openList } from "@/lib/smart-lists/open-list";
import { companyInList, listMembersWhere } from "@/lib/smart-lists/membership";
import { ownRowsReady } from "@/lib/smart-lists/own-rows";
import { cleanQuery, isEmptyQuery, type ViewQuery } from "@/lib/smart-lists/view-query";
import { searchLinkable, linkableIds, linkLabels } from "@/lib/smart-lists/links";
import { can } from "@/lib/authz/resolve";
import { logActivity } from "@/lib/activity";
import { toWorkbookBuffer } from "@/lib/portability/export";
import { workspaceClock } from "@/lib/time/workspace";
import type { WorkbookFilters } from "@/lib/workspace/filters";
import { keepListFile } from "@/lib/smart-lists/files";
import { recordChanges } from "@/lib/smart-lists/history";
import { mayChangeRow, ROW_NOT_YOURS, VIEW_ONLY } from "@/lib/smart-lists/access";
import { rollupSources } from "@/lib/smart-lists/rollups";
import { emitValuesChanged } from "@/lib/automate/emit-smart-lists";
import { MAX_DAYS_BEFORE, NOTIFY_WHO, type NotifyWho } from "@/lib/smart-lists/reminders";
import { LIMITS, isLinkKind, linkTargetOf, optionsOf, parseValue, readValue, valueText, type PropertyKind } from "@/lib/smart-lists/values";

/**
 * Smart Lists phase 2 (owner, 20 Nov 2026): a view's saved filters and sort, a Date column's reminder, columns that
 * link to companies, leads, contacts or another list's rows, a Files column, and changing many rows at once. For a list
 * of companies and a list of its own rows alike.
 *
 * Who may do what — the list's own rule (src/lib/smart-lists/open-list.ts), nothing new:
 *   · save a view's filters, set a reminder: whoever may change the list's columns and views;
 *   · link records, attach files, change rows in bulk: whoever may fill the list in — and only records and rows that
 *     are theirs to see (src/lib/smart-lists/links.ts);
 *   · trying filters without saving them needs nothing: they live in the address bar.
 */

const NOT_YET = "This workspace is still being updated. Try again in a few minutes.";
const SHAPE_ONLY = "Only whoever built this list can change its views and columns. Duplicate it to make your own version.";
const changed = (workbookId: string) => revalidatePath(`/smart-lists/${workbookId}`);

async function propsFor(workbookId: string) {
  const rows = await db.workbookProperty.findMany({ where: { workbookId }, select: { id: true, name: true, kind: true, options: true } });
  return rows.map((p) => ({ id: p.id, name: p.name, kind: p.kind as PropertyKind, options: optionsOf(p.options), raw: p.options }));
}

async function openProperty(propertyId: unknown) {
  if (typeof propertyId !== "string" || !propertyId) return null;
  const prop = await db.workbookProperty.findUnique({ where: { id: propertyId }, select: { id: true, workbookId: true, name: true, kind: true, options: true } });
  if (!prop) return null;
  const opened = await openList(prop.workbookId);
  return opened ? { opened, prop: { ...prop, kind: prop.kind as PropertyKind } } : null;
}

/** Whether `rowKey` is a row of this list for this person: an own row of it, or a company in it for them. */
async function rowOfList(opened: NonNullable<Awaited<ReturnType<typeof openList>>>, rowKey: unknown): Promise<boolean> {
  if (typeof rowKey !== "string" || !rowKey) return false;
  if (opened.workbook.mode === "ROWS") return (await db.workbookRow.count({ where: { id: rowKey, workbookId: opened.workbook.id } })) > 0;
  return companyInList(opened.userId, opened.workbook, rowKey);
}

// ─── A view's filters and sort ────────────────────────────────────────────────

/** A saved view's filters and sort, for everyone — empty takes them away. */
export async function saveViewQuery(input: { viewId: string; query: unknown }): Promise<ActionResult<ViewQuery>> {
  const view = typeof input?.viewId === "string" ? await db.workbookView.findUnique({ where: { id: input.viewId }, select: { id: true, workbookId: true } }) : null;
  const opened = view ? await openList(view.workbookId) : null;
  if (!view || !opened) return { ok: false, error: "That view no longer exists." };
  if (!opened.canEdit) return { ok: false, error: SHAPE_ONLY };
  const query = cleanQuery(input.query, await propsFor(view.workbookId), opened.workbook.mode === "ROWS");
  try {
    if (isEmptyQuery(query)) await db.workbookViewQuery.deleteMany({ where: { viewId: view.id } });
    else
      await db.workbookViewQuery.upsert({
        where: { viewId: view.id },
        create: { viewId: view.id, workbookId: view.workbookId, query: query as unknown as Prisma.InputJsonValue },
        update: { query: query as unknown as Prisma.InputJsonValue },
        select: { viewId: true },
      });
  } catch {
    return { ok: false, error: NOT_YET };
  }
  changed(view.workbookId);
  return { ok: true, data: query };
}

// ─── A Date column's reminder ─────────────────────────────────────────────────

export type ColumnReminder = { daysBefore: number; notify: NotifyWho; personPropertyId: string | null } | null;

export async function columnReminder(propertyId: string): Promise<ColumnReminder> {
  const found = await openProperty(propertyId);
  if (!found || found.prop.kind !== "DATE") return null;
  const r = await db.workbookReminder.findUnique({ where: { propertyId: found.prop.id }, select: { daysBefore: true, notify: true, personPropertyId: true } }).catch(() => null);
  return r ? { daysBefore: r.daysBefore, notify: r.notify as NotifyWho, personPropertyId: r.personPropertyId } : null;
}

/** A Date column's reminder set, changed or (with null) taken away. */
export async function setColumnReminder(input: { propertyId: string; reminder: { daysBefore: number; notify: string; personPropertyId?: string | null } | null }): Promise<ActionResult<ColumnReminder>> {
  const found = await openProperty(input?.propertyId);
  if (!found) return { ok: false, error: "That column no longer exists." };
  const { opened, prop } = found;
  if (!opened.canEdit) return { ok: false, error: SHAPE_ONLY };
  if (prop.kind !== "DATE") return { ok: false, error: "Only a Date column can remind." };
  try {
    if (!input.reminder) {
      await db.workbookReminder.deleteMany({ where: { propertyId: prop.id } });
      changed(prop.workbookId);
      return { ok: true, data: null };
    }
    const days = Math.round(Number(input.reminder.daysBefore));
    if (!Number.isFinite(days) || days < 0 || days > MAX_DAYS_BEFORE) return { ok: false, error: `Remind 0 to ${MAX_DAYS_BEFORE} days before.` };
    const notify = input.reminder.notify as NotifyWho;
    if (!(NOTIFY_WHO as readonly string[]).includes(notify)) return { ok: false, error: "Choose who is reminded." };
    const own = opened.workbook.mode === "ROWS";
    if (notify === "ADDER" && !own) return { ok: false, error: "A list of companies has no 'who added it' — choose another." };
    if (notify === "ACCOUNT_OWNER" && own) return { ok: false, error: "These rows aren't companies — choose another." };
    let personPropertyId: string | null = null;
    if (notify === "PERSON") {
      const person = await db.workbookProperty.findFirst({ where: { id: String(input.reminder.personPropertyId ?? ""), workbookId: prop.workbookId, kind: "PERSON" }, select: { id: true } });
      if (!person) return { ok: false, error: "Choose the Person column whose person is reminded." };
      personPropertyId = person.id;
    }
    const data = { daysBefore: days, notify, personPropertyId };
    await db.workbookReminder.upsert({ where: { propertyId: prop.id }, create: { propertyId: prop.id, workbookId: prop.workbookId, createdByUserId: opened.userId, ...data }, update: data, select: { propertyId: true } });
    await recordAudit({ userId: opened.userId, action: "UPDATE", entityType: "Workbook", entityId: prop.workbookId, entityLabel: `${opened.workbook.name}: "${prop.name}" reminds ${days} day(s) before` });
    changed(prop.workbookId);
    return { ok: true, data };
  } catch {
    return { ok: false, error: NOT_YET };
  }
}

// ─── Link and file cells ──────────────────────────────────────────────────────

/** Records a link column may name whose name holds `query` — only what the person may see. */
export async function searchLinkTargets(input: { propertyId: string; query: string }): Promise<{ id: string; name: string; sub: string | null }[]> {
  const found = await openProperty(input?.propertyId);
  if (!found || !isLinkKind(found.prop.kind)) return [];
  return searchLinkable(found.prop.kind, String(input.query ?? ""), found.opened.userId, linkTargetOf(found.prop.options));
}

/** A file attached to a cell — kept, and added to the cell's value. */
export async function attachListFile(formData: FormData): Promise<ActionResult<{ value: string[]; name: string }>> {
  const found = await openProperty(formData.get("propertyId"));
  if (!found) return { ok: false, error: "That column no longer exists." };
  const { opened, prop } = found;
  if (prop.kind !== "FILE") return { ok: false, error: "That column doesn't hold files." };
  const rowKey = String(formData.get("rowKey") ?? "");
  if (!(await rowOfList(opened, rowKey))) return { ok: false, error: "That row isn't in this list for you." };
  const own = opened.workbook.mode === "ROWS";
  if (!(await mayChangeRow(opened.rights, opened.userId, prop.workbookId, own, rowKey))) return { ok: false, error: opened.canFill ? ROW_NOT_YOURS : VIEW_ONLY };
  if (own && !(await ownRowsReady())) return { ok: false, error: NOT_YET };
  const file = formData.get("file");
  if (!(file instanceof File)) return { ok: false, error: "Choose a file." };
  const held = own
    ? await db.workbookRowValue.findUnique({ where: { propertyId_rowId: { propertyId: prop.id, rowId: rowKey } }, select: { value: true } })
    : await db.workbookValue.findUnique({ where: { propertyId_companyId: { propertyId: prop.id, companyId: rowKey } }, select: { value: true } });
  const before = Array.isArray(held?.value) ? (held.value as unknown[]).map(String) : [];
  if (before.length >= LIMITS.files) return { ok: false, error: `A cell holds up to ${LIMITS.files} files — take one away first.` };
  const kept = await keepListFile({ workbookId: prop.workbookId, propertyId: prop.id, rowKey, name: file.name, bytes: Buffer.from(await file.arrayBuffer()), userId: opened.userId });
  if (!kept.ok) return kept;
  const value = [...before, kept.id] as Prisma.InputJsonValue;
  if (own) {
    await db.workbookRowValue.upsert({
      where: { propertyId_rowId: { propertyId: prop.id, rowId: rowKey } },
      create: { workbookId: prop.workbookId, propertyId: prop.id, rowId: rowKey, value, updatedByUserId: opened.userId },
      update: { value, updatedByUserId: opened.userId },
      select: { id: true },
    });
    await db.workbookRow.update({ where: { id: rowKey }, data: { updatedByUserId: opened.userId }, select: { id: true } });
  } else {
    await db.workbookValue.upsert({
      where: { propertyId_companyId: { propertyId: prop.id, companyId: rowKey } },
      create: { workbookId: prop.workbookId, propertyId: prop.id, companyId: rowKey, value, updatedByUserId: opened.userId },
      update: { value, updatedByUserId: opened.userId },
      select: { id: true },
    });
  }
  await recordChanges([{ workbookId: prop.workbookId, rowKey, kind: "FILE", propertyId: prop.id, after: kept.name, byUserId: opened.userId }]);
  return { ok: true, data: { value: [...before, kept.id], name: kept.name } };
}

// ─── Many rows at once ────────────────────────────────────────────────────────

/** One column set to the same value on many rows — the ones of this list the person may fill in. */
export async function setManyValues(input: { workbookId: string; propertyId: string; rowKeys: string[]; value: unknown }): Promise<ActionResult<{ changed: number }>> {
  const opened = await openList(input?.workbookId);
  if (!opened) return { ok: false, error: "That list no longer exists." };
  if (!opened.canFill) return { ok: false, error: VIEW_ONLY };
  const prop = await db.workbookProperty.findFirst({ where: { id: String(input.propertyId ?? ""), workbookId: opened.workbook.id }, select: { id: true, kind: true, options: true, name: true } });
  if (!prop) return { ok: false, error: "That column no longer exists." };
  const kind = prop.kind as PropertyKind;
  if (kind === "FILE") return { ok: false, error: "Files are attached one row at a time." };
  const parsed = parseValue(kind, input.value, optionsOf(prop.options));
  if (!parsed.ok) return { ok: false, error: parsed.error };
  if (kind === "PERSON" && parsed.value !== null && !(await db.user.findFirst({ where: { id: String(parsed.value), active: true }, select: { id: true } }))) return { ok: false, error: "Pick somebody from the list." };
  if (isLinkKind(kind) && Array.isArray(parsed.value)) {
    const ok = await linkableIds(kind, parsed.value as string[], opened.userId, linkTargetOf(prop.options));
    if (ok.size < (parsed.value as string[]).length) return { ok: false, error: "One of those isn't yours to link." };
  }
  const asked = [...new Set((Array.isArray(input.rowKeys) ? input.rowKeys : []).filter((k) => typeof k === "string" && k))].slice(0, 500);
  const own = opened.workbook.mode === "ROWS";
  const inList = own
    ? (await db.workbookRow.findMany({ where: { workbookId: opened.workbook.id, id: { in: asked } }, select: { id: true } })).map((r) => r.id)
    : (await Promise.all(asked.map(async (k) => ((await companyInList(opened.userId, opened.workbook, k)) ? k : null)))).filter((k): k is string => !!k);
  // Under the own-rows rule, only this person's rows (Smart Lists phase 4).
  const keys = opened.rights.rowRule === "OWN" && !opened.canEdit ? (await Promise.all(inList.map(async (k) => ((await mayChangeRow(opened.rights, opened.userId, opened.workbook.id, own, k)) ? k : null)))).filter((k): k is string => !!k) : inList;
  if (!keys.length) return { ok: true, data: { changed: 0 } };
  const by = opened.userId;
  // What each row had, for its history (Smart Lists phase 3).
  const had = new Map(
    own
      ? (await db.workbookRowValue.findMany({ where: { propertyId: prop.id, rowId: { in: keys } }, select: { rowId: true, value: true } })).map((v) => [v.rowId, v.value as unknown])
      : (await db.workbookValue.findMany({ where: { propertyId: prop.id, companyId: { in: keys } }, select: { companyId: true, value: true } })).map((v) => [v.companyId, v.value as unknown]),
  );
  const titles = new Map(
    own
      ? (await db.workbookRow.findMany({ where: { id: { in: keys } }, select: { id: true, title: true } })).map((r) => [r.id, r.title])
      : (await db.company.findMany({ where: { id: { in: keys } }, select: { id: true, name: true } })).map((c) => [c.id, c.name]),
  );
  await db.$transaction(
    async (tx) => {
      // For Deskzo Automate's "A column changes on a Smart List row" (Smart Lists phase 3).
      await emitValuesChanged(tx, {
        rows: keys.map((rowKey) => ({ workbookId: opened.workbook.id, listName: opened.workbook.name, own, rowKey, title: titles.get(rowKey) ?? "", before: had.get(rowKey) ?? null })),
        column: { id: prop.id, name: prop.name, kind, options: prop.options },
        after: parsed.value,
        actorUserId: by,
      });
      if (own) {
        await tx.workbookRowValue.deleteMany({ where: { propertyId: prop.id, rowId: { in: keys } } });
        if (parsed.value !== null) await tx.workbookRowValue.createMany({ data: keys.map((rowId) => ({ workbookId: opened.workbook.id, propertyId: prop.id, rowId, value: parsed.value as Prisma.InputJsonValue, updatedByUserId: by })) });
        await tx.workbookRow.updateMany({ where: { id: { in: keys } }, data: { updatedByUserId: by } });
      } else {
        await tx.workbookValue.deleteMany({ where: { propertyId: prop.id, companyId: { in: keys } } });
        if (parsed.value !== null) await tx.workbookValue.createMany({ data: keys.map((companyId) => ({ workbookId: opened.workbook.id, propertyId: prop.id, companyId, value: parsed.value as Prisma.InputJsonValue, updatedByUserId: by })) });
      }
    },
    { timeout: 60_000 },
  );
  await recordChanges(keys.map((rowKey) => ({ workbookId: opened.workbook.id, rowKey, kind: "VALUE" as const, propertyId: prop.id, before: had.get(rowKey) ?? null, after: parsed.value, byUserId: by })));
  await recordAudit({ userId: by, action: "UPDATE", entityType: "Workbook", entityId: opened.workbook.id, entityLabel: `${opened.workbook.name}: "${prop.name}" set on ${keys.length} row(s)` });
  changed(opened.workbook.id);
  return { ok: true, data: { changed: keys.length } };
}

// ─── Lists a column can link to ───────────────────────────────────────────────

/** Lists with rows of their own the person may open — what a "Row of another list" column can point at. */
export async function linkableLists(): Promise<{ id: string; name: string }[]> {
  const user = await requireModuleAccess("workspace");
  const any = await hasEffectivePermission(user.id, "workspace.manageAny");
  try {
    return await db.workbook.findMany({ where: { mode: "ROWS", ...(any ? {} : { OR: [{ shared: true }, { ownerUserId: user.id }] }) }, orderBy: { name: "asc" }, take: 300, select: { id: true, name: true } });
  } catch {
    return [];
  }
}

// ─── Count columns ────────────────────────────────────────────────────────────

/** Lists whose rows link to this one, with what a count column could count or add up there (Smart Lists phase 3). */
export async function countSources(workbookId: string) {
  const opened = await openList(workbookId);
  if (!opened || !opened.canEdit) return [];
  return rollupSources(opened.workbook.id, opened.userId);
}

// ─── A list of companies as Excel ─────────────────────────────────────────────

/**
 * A list of companies downloaded as Excel (Smart Lists phase 3): each company in it for this person — its name and
 * account owner, no address — and the list's own columns, linked records by name as they may see them. For whoever may
 * export CRM data (`data.exportCrm`, the permission Settings › Data's export asks); logged as every download is.
 */
export async function exportCompanyList(workbookId: string): Promise<ActionResult<{ filename: string; contentType: string; base64: string; rows: number }>> {
  const opened = await openList(workbookId);
  if (!opened || opened.workbook.mode !== "LIST") return { ok: false, error: "That list no longer exists." };
  const user = await requireModuleAccess("workspace");
  if (!(await can(user.id, "data.exportCrm"))) return { ok: false, error: "Downloading companies needs the permission to export CRM data." };
  const members = await listMembersWhere(user.id, opened.workbook.id, (opened.workbook.filters ?? {}) as WorkbookFilters);
  const [companies, props] = await Promise.all([
    db.company.findMany({ where: members, orderBy: { name: "asc" }, take: 5000, select: { id: true, name: true, owner: { select: { name: true } } } }),
    db.workbookProperty.findMany({ where: { workbookId: opened.workbook.id }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, kind: true, options: true } }),
  ]);
  const ids = companies.map((c) => c.id);
  const cells = ids.length ? await db.workbookValue.findMany({ where: { workbookId: opened.workbook.id, companyId: { in: ids } }, select: { companyId: true, propertyId: true, value: true } }) : [];
  const values: Record<string, Record<string, unknown>> = {};
  for (const c of cells) (values[c.companyId] ??= {})[c.propertyId] = c.value;
  const typed = props.map((p) => ({ id: p.id, name: p.name, kind: p.kind as PropertyKind, options: p.options }));
  const labels = await linkLabels(typed, values, user.id);
  const personIds = [...new Set(cells.filter((c) => typed.find((p) => p.id === c.propertyId)?.kind === "PERSON").map((c) => String(c.value)))];
  const names = new Map<string, string>([
    ...(personIds.length ? (await db.user.findMany({ where: { id: { in: personIds } }, select: { id: true, name: true } })).map((u) => [u.id, u.name] as [string, string]) : []),
    ...Object.entries(labels).map(([id, l]) => [id, l.name] as [string, string]),
  ]);
  const headers: string[] = [];
  for (const n of ["Company", "Account owner", ...typed.map((p) => p.name)]) {
    let h = n;
    for (let i = 2; headers.includes(h); i += 1) h = `${n} ${i}`;
    headers.push(h);
  }
  const rows = companies.map((c) => {
    const out: Record<string, unknown> = { [headers[0]!]: c.name, [headers[1]!]: c.owner?.name ?? "" };
    typed.forEach((p, i) => {
      const v = readValue(p.kind, values[c.id]?.[p.id] ?? null, optionsOf(p.options));
      out[headers[i + 2]!] = v === null ? "" : typeof v === "number" ? v : p.kind === "DATE" ? new Date(`${String(v)}T00:00:00Z`) : valueText(p.kind, v, optionsOf(p.options), names);
    });
    return out;
  });
  if (!rows.length) rows.push(Object.fromEntries(headers.map((h) => [h, ""])));
  const buffer = await toWorkbookBuffer([{ name: opened.workbook.name.slice(0, 31).replace(/[\/?*[\]:]/g, " ") || "List", rows }], { title: opened.workbook.name, by: `${user.name} <${user.email}>`, generatedAt: new Date() });
  await logActivity({ kind: "EXPORT", severity: "NOTICE", summary: `${user.name} downloaded ${companies.length} compan${companies.length === 1 ? "y" : "ies"} of the Smart List ${opened.workbook.name}`, metadata: { report: "smart-list", workbookId: opened.workbook.id, rows: companies.length } });
  const today = (await workspaceClock()).today();
  const slug = opened.workbook.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 40) || "list";
  return { ok: true, data: { filename: `${slug}-${today}.xlsx`, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", base64: buffer.toString("base64"), rows: companies.length } };
}

// ─── A view's own settings (Smart Lists phase 4) ──────────────────────────────

/** A timeline's end column (a Date column, or none — one day each) and its scale, for whoever may shape the list. */
export async function setTimelineOptions(input: { viewId: string; endPropertyId?: string | null; scale?: string }): Promise<ActionResult<null>> {
  const view = typeof input?.viewId === "string" ? await db.workbookView.findUnique({ where: { id: input.viewId }, select: { id: true, workbookId: true, kind: true } }) : null;
  const opened = view ? await openList(view.workbookId) : null;
  if (!view || !opened) return { ok: false, error: "That view no longer exists." };
  if (!opened.canEdit) return { ok: false, error: SHAPE_ONLY };
  let endPropertyId: string | null = null;
  if (input.endPropertyId) {
    const p = await db.workbookProperty.findFirst({ where: { id: input.endPropertyId, workbookId: view.workbookId }, select: { id: true, kind: true } });
    if (!p || p.kind !== "DATE") return { ok: false, error: "A timeline ends on a Date column." };
    endPropertyId = p.id;
  }
  const options = { endPropertyId, scale: input.scale === "month" ? "month" : "week" } as Prisma.InputJsonValue;
  try {
    await db.workbookViewOptions.upsert({ where: { viewId: view.id }, create: { viewId: view.id, options }, update: { options }, select: { viewId: true } });
  } catch {
    return { ok: false, error: NOT_YET };
  }
  changed(view.workbookId);
  return { ok: true, data: null };
}
