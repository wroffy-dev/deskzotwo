import { randomUUID } from "node:crypto";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { tenantKey } from "@/lib/tenancy/cache";
import { templateOf } from "@/lib/industry-templates/catalogue";
import { cleanChecklist, cleanOptions, LIMITS, optionsOf, readValue, valueText, type ChecklistItem, type PropertyKind, type SelectOption } from "@/lib/smart-lists/values";
import { summariseColumns, type Bar, type ListDashboard } from "@/lib/smart-lists/dashboard";
import { templateOptions, type ListTemplate } from "@/lib/smart-lists/templates";
import { choicesIn, cellValue, IMPORT_LIMITS, type ImportTarget } from "@/lib/smart-lists/own-rows-import";
import { sortOwnRows } from "@/lib/smart-lists/view-query-server";
import { linkLabels, matchLinkNames } from "@/lib/smart-lists/links";
import type { Sort } from "@/lib/smart-lists/view-query";
import { recordChanges } from "@/lib/smart-lists/history";
import { emitRowsAdded } from "@/lib/automate/emit-smart-lists";

/**
 * Smart Lists with rows of their own (owner, 20 Nov 2026: "i want smart list to be used like notion — seo team can also
 * use to store backlinks, article links etc."; then "no automatic link tracker. no Backlink checker! just to keep records
 * and data… let user manually record the status"). A list made this way (`Workbook.mode` ROWS) holds `WorkbookRow`s, not
 * companies: each a title, the list's own columns (the same `WorkbookProperty` kinds, values in `WorkbookRowValue`), and
 * a page of notes and a checklist. It can start from a template (src/lib/smart-lists/templates.ts — the workspace's
 * industry first), be filled in by hand or from a spreadsheet, and be downloaded as Excel.
 *
 * Nothing here looks outside Deskzo: a link is kept as typed. It has no filters, no calling activity, and isn't shared
 * with guests (Deskzo Connect reads company rows only); `listMembersWhere` answers no companies for it. Who may do what
 * is the list's rule (src/lib/smart-lists/open-list.ts); src/actions/smart-list-rows.ts checks it. Server only.
 */

export const OWN_ROWS = { perList: 5000, title: 300, titleName: 60 } as const;

const ready = new Map<string, boolean>();

/** Whether this workspace has the own-row tables yet — asked once a process, remembered once it has. */
export async function ownRowsReady(): Promise<boolean> {
  const key = await tenantKey().catch(() => "default");
  if (ready.get(key)) return true;
  try {
    await db.workbookRow.findFirst({ select: { id: true } });
    await db.workbookRowSettings.findFirst({ select: { workbookId: true } });
    ready.set(key, true);
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

/**
 * The industry this workspace's admin chose (owner: "as per the industry template admin choose"): the last industry
 * template applied — at sign-up, or from Settings › Industry templates — as its audit line records it. Null when none.
 */
export async function workspaceIndustry(): Promise<{ key: string; name: string } | null> {
  const last = await db.auditLog.findFirst({ where: { entityType: "IndustryTemplate" }, orderBy: { createdAt: "desc" }, select: { entityId: true } });
  const template = templateOf(last?.entityId);
  return template ? { key: template.key, name: template.name } : null;
}

/** A row id: unique, and made here so a spreadsheet's rows and their values go in together. */
const newRowId = () => `r${randomUUID().replace(/-/g, "")}`;

export const cleanTitle = (v: unknown) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, OWN_ROWS.title);

/** A new list with rows of its own — empty, or with a template's columns, choices and views. Returns its id. */
export async function createRowList(input: { userId: string; name: string; description: string | null; shared: boolean; template: ListTemplate | null; titleName?: string }): Promise<string> {
  const titleName = cleanTitle(input.titleName || input.template?.titleName || "Name").slice(0, OWN_ROWS.titleName) || "Name";
  return db.$transaction(async (tx) => {
    const wb = await tx.workbook.create({
      data: { name: input.name, description: input.description, filters: {}, shared: input.shared, ownerUserId: input.userId, mode: "ROWS" },
      select: { id: true },
    });
    await tx.workbookRowSettings.create({ data: { workbookId: wb.id, titleName, template: input.template?.key ?? null }, select: { workbookId: true } });
    const ids = new Map<string, string>();
    for (const [i, c] of (input.template?.columns ?? []).slice(0, LIMITS.properties).entries()) {
      const options = c.kind === "SELECT" || c.kind === "MULTI_SELECT" ? cleanOptions(templateOptions(c.options ?? [])) : null;
      const p = await tx.workbookProperty.create({
        data: { workbookId: wb.id, name: c.name, kind: c.kind, options: options ? (options as unknown as Prisma.InputJsonValue) : undefined, sortOrder: (i + 1) * 10 },
        select: { id: true },
      });
      ids.set(c.name, p.id);
    }
    for (const [i, v] of (input.template?.views ?? []).slice(0, LIMITS.views).entries()) {
      const propertyId = v.by ? (ids.get(v.by) ?? null) : null;
      if (v.kind !== "TABLE" && !propertyId) continue;
      await tx.workbookView.create({ data: { workbookId: wb.id, name: v.name, kind: v.kind, propertyId, sortOrder: (i + 1) * 10 }, select: { id: true } });
    }
    return wb.id;
  });
}

/** What the list's title column is called. */
export async function titleNameOf(workbookId: string): Promise<string> {
  const s = await db.workbookRowSettings.findUnique({ where: { workbookId }, select: { titleName: true } });
  return s?.titleName || "Name";
}

export type OwnRow = { id: string; title: string; createdById: string | null; createdBy: string | null; updatedBy: string | null; createdAt: string; updatedAt: string };
type Prop = { id: string; name: string; kind: PropertyKind; options: SelectOption[] };

/** The ids of rows whose title, or any value — a choice by its name, a person by theirs — holds `search`. */
export async function rowsMatching(workbookId: string, search: string, properties: Prop[]): Promise<Prisma.WorkbookRowWhereInput> {
  const q = search.trim().slice(0, 100);
  if (!q) return { workbookId };
  const lower = q.toLowerCase();
  const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
  // A choice's id or a person's id, quoted as it sits in the stored value.
  const optionIds = properties.flatMap((p) => p.options.filter((o) => o.name.toLowerCase().includes(lower)).map((o) => o.id));
  const personIds = properties.some((p) => p.kind === "PERSON") ? (await db.user.findMany({ where: { name: { contains: q, mode: "insensitive" } }, select: { id: true }, take: 50 })).map((u) => u.id) : [];
  const patterns = [like, ...[...optionIds, ...personIds].map((id) => `%"${id}"%`)];
  const hits = await db.$queryRaw<{ rowId: string }[]>`
    SELECT DISTINCT v."rowId" FROM "workbook_row_values" v
    WHERE v."workbookId" = ${workbookId} AND v."value"::text ILIKE ANY (${patterns}::text[])
    LIMIT ${OWN_ROWS.perList}`;
  return { workbookId, OR: [{ title: { contains: q, mode: "insensitive" } }, { id: { in: hits.map((h) => h.rowId) } }] };
}

/** A page of the list's rows (or all of them, for a board or a calendar), in order, with their values. */
/**
 * A page of the list's rows (or all of them, for a board or a calendar), in order, with their values. `filter` is a
 * view's rules (src/lib/smart-lists/view-query-server.ts) and `sort` its order — the whole list is sorted, then paged.
 */
export async function ownRowsPage(
  workbookId: string,
  properties: Prop[],
  opts: { search?: string; skip: number; take: number; filter?: Prisma.WorkbookRowWhereInput | null; sort?: Sort[] },
): Promise<{ rows: OwnRow[]; total: number; values: Record<string, Record<string, unknown>> }> {
  const searched = await rowsMatching(workbookId, opts.search ?? "", properties);
  const where: Prisma.WorkbookRowWhereInput = opts.filter ? { AND: [searched, opts.filter] } : searched;
  const select = { id: true, title: true, createdByUserId: true, updatedByUserId: true, createdAt: true, updatedAt: true } as const;
  let total: number;
  let rows: { id: string; title: string; createdByUserId: string | null; updatedByUserId: string | null; createdAt: Date; updatedAt: Date }[];
  if (opts.sort?.length) {
    // Sorted whole, then paged: a list holds at most OWN_ROWS.perList rows.
    const all = await db.workbookRow.findMany({ where, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], take: OWN_ROWS.perList, select });
    total = all.length;
    rows = (await sortOwnRows(all, opts.sort, properties)).slice(opts.skip, opts.skip + opts.take);
  } else {
    [total, rows] = await Promise.all([db.workbookRow.count({ where }), db.workbookRow.findMany({ where, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], skip: opts.skip, take: opts.take, select })]);
  }
  const byId = new Map(properties.map((p) => [p.id, p]));
  const [cells, people] = await Promise.all([
    rows.length ? db.workbookRowValue.findMany({ where: { rowId: { in: rows.map((r) => r.id) } }, select: { rowId: true, propertyId: true, value: true } }) : Promise.resolve([]),
    namesOf(rows.flatMap((r) => [r.createdByUserId, r.updatedByUserId])),
  ]);
  const values: Record<string, Record<string, unknown>> = {};
  for (const c of cells) {
    const p = byId.get(c.propertyId);
    if (!p) continue;
    const v = readValue(p.kind, c.value, p.options);
    if (v !== null) (values[c.rowId] ??= {})[c.propertyId] = v;
  }
  return {
    total,
    values,
    rows: rows.map((r) => ({
      id: r.id,
      title: r.title,
      createdById: r.createdByUserId,
      createdBy: r.createdByUserId ? (people.get(r.createdByUserId) ?? null) : null,
      updatedBy: r.updatedByUserId ? (people.get(r.updatedByUserId) ?? null) : null,
      createdAt: r.createdAt.toISOString(),
      updatedAt: r.updatedAt.toISOString(),
    })),
  };
}

async function namesOf(ids: (string | null)[]): Promise<Map<string, string>> {
  const wanted = [...new Set(ids.filter((x): x is string => !!x))];
  if (!wanted.length) return new Map();
  return new Map((await db.user.findMany({ where: { id: { in: wanted } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
}

/** The list's properties as the board reads them. */
export async function propsOf(workbookId: string): Promise<Prop[]> {
  const rows = await db.workbookProperty.findMany({ where: { workbookId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, kind: true, options: true } });
  return rows.map((p) => ({ id: p.id, name: p.name, kind: p.kind as PropertyKind, options: optionsOf(p.options) }));
}

/** One row's page: its notes and checklist, and who added and last changed it. */
export async function rowPageOf(rowId: string): Promise<{ notes: string; checklist: ChecklistItem[]; createdBy: string | null; createdAt: string; updatedBy: string | null; updatedAt: string } | null> {
  const row = await db.workbookRow.findUnique({ where: { id: rowId }, select: { notes: true, checklist: true, createdByUserId: true, updatedByUserId: true, createdAt: true, updatedAt: true } });
  if (!row) return null;
  const people = await namesOf([row.createdByUserId, row.updatedByUserId]);
  return {
    notes: row.notes,
    checklist: cleanChecklist(row.checklist),
    createdBy: row.createdByUserId ? (people.get(row.createdByUserId) ?? null) : null,
    createdAt: row.createdAt.toISOString(),
    updatedBy: row.updatedByUserId ? (people.get(row.updatedByUserId) ?? null) : null,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** The list summed up for its Dashboard tab, as a company list's is (src/lib/smart-lists/dashboard.ts). */
export async function ownRowDashboard(workbookId: string, today: string, now = new Date()): Promise<ListDashboard> {
  const props = await db.workbookProperty.findMany({ where: { workbookId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, kind: true, options: true } });
  const counted = props.filter((p) => ["SELECT", "MULTI_SELECT", "NUMBER", "MONEY", "CHECKBOX", "DATE"].includes(p.kind));
  const CAP = 200_000;
  const [total, changedThisWeek, values, adders] = await Promise.all([
    db.workbookRow.count({ where: { workbookId } }),
    db.workbookRowValue.count({ where: { workbookId, updatedAt: { gte: new Date(now.getTime() - 7 * 86_400_000) } } }),
    counted.length ? db.workbookRowValue.findMany({ where: { workbookId, propertyId: { in: counted.map((p) => p.id) } }, select: { propertyId: true, rowId: true, value: true }, take: CAP }) : Promise.resolve([]),
    db.workbookRow.groupBy({ by: ["createdByUserId"], where: { workbookId }, _count: { _all: true } }),
  ]);
  const names = await namesOf(adders.map((a) => a.createdByUserId));
  const owners: Bar[] = adders
    .map((a) => ({ key: a.createdByUserId ?? "", label: a.createdByUserId ? (names.get(a.createdByUserId) ?? "Somebody who left") : "Nobody", count: a._count._all }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);
  return {
    total,
    byHand: 0,
    changedThisWeek,
    ...summariseColumns(props, values, total, today),
    states: null,
    owners,
    guests: null,
    capped: values.length >= CAP,
    own: { rows: "Rows" },
  };
}

/** A copy of an own-row list's shape and rows into `toId` (a duplicate). */
export async function copyRowList(fromId: string, toId: string, userId: string): Promise<void> {
  const [settings, props, views, rows, values] = await Promise.all([
    db.workbookRowSettings.findUnique({ where: { workbookId: fromId }, select: { titleName: true, template: true } }),
    db.workbookProperty.findMany({ where: { workbookId: fromId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, kind: true, options: true, sortOrder: true } }),
    db.workbookView.findMany({ where: { workbookId: fromId }, select: { name: true, kind: true, propertyId: true, sortOrder: true } }),
    db.workbookRow.findMany({ where: { workbookId: fromId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], take: OWN_ROWS.perList, select: { id: true, title: true, sortOrder: true, notes: true, checklist: true } }),
    db.workbookRowValue.findMany({ where: { workbookId: fromId }, select: { rowId: true, propertyId: true, value: true } }),
  ]);
  await db.$transaction(
    async (tx) => {
      await tx.workbookRowSettings.create({ data: { workbookId: toId, titleName: settings?.titleName ?? "Name", template: settings?.template ?? null }, select: { workbookId: true } });
      const propIds = new Map<string, string>();
      for (const p of props) {
        const made = await tx.workbookProperty.create({ data: { workbookId: toId, name: p.name, kind: p.kind, options: p.options ?? undefined, sortOrder: p.sortOrder }, select: { id: true } });
        propIds.set(p.id, made.id);
      }
      for (const v of views) {
        const propertyId = v.propertyId ? (propIds.get(v.propertyId) ?? null) : null;
        await tx.workbookView.create({ data: { workbookId: toId, name: v.name, kind: v.kind, propertyId, sortOrder: v.sortOrder }, select: { id: true } });
      }
      const rowIds = new Map(rows.map((r) => [r.id, newRowId()]));
      if (rows.length) {
        await tx.workbookRow.createMany({
          data: rows.map((r) => ({ id: rowIds.get(r.id)!, workbookId: toId, title: r.title, sortOrder: r.sortOrder, notes: r.notes, checklist: r.checklist ?? [], createdByUserId: userId, updatedByUserId: userId })),
        });
      }
      const cells = values.filter((v) => rowIds.has(v.rowId) && propIds.has(v.propertyId));
      for (let i = 0; i < cells.length; i += 5000) {
        await tx.workbookRowValue.createMany({
          data: cells.slice(i, i + 5000).map((v) => ({ workbookId: toId, rowId: rowIds.get(v.rowId)!, propertyId: propIds.get(v.propertyId)!, value: v.value as Prisma.InputJsonValue, updatedByUserId: userId })),
        });
      }
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
}

/** The list as a sheet for Excel: the title column, then each column — numbers as numbers, days as dates. */
export async function rowListSheet(workbookId: string, userId: string): Promise<{ rows: Record<string, unknown>[]; count: number }> {
  const [titleName, props] = await Promise.all([titleNameOf(workbookId), propsOf(workbookId)]);
  const page = await ownRowsPage(workbookId, props, { skip: 0, take: OWN_ROWS.perList });
  const people = new Map((await db.user.findMany({ where: { id: { in: [...new Set(Object.values(page.values).flatMap((v) => props.filter((p) => p.kind === "PERSON").map((p) => v[p.id])).filter((x): x is string => typeof x === "string"))] } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  // Linked records and files by name — as the person downloading may see them ("Hidden" otherwise).
  const raw = await db.workbookProperty.findMany({ where: { workbookId }, select: { id: true, options: true } });
  const links = await linkLabels(props.map((p) => ({ ...p, options: raw.find((r) => r.id === p.id)?.options })), page.values, userId);
  for (const [id, l] of Object.entries(links)) people.set(id, l.name);
  // Headers unique: a column called like the title column gets a number.
  const headers: string[] = [];
  for (const name of [titleName, ...props.map((p) => p.name), "Added by", "Added on", "Last changed"]) {
    let h = name;
    for (let n = 2; headers.includes(h); n += 1) h = `${name} ${n}`;
    headers.push(h);
  }
  const rows = page.rows.map((r) => {
    const out: Record<string, unknown> = { [headers[0]!]: r.title };
    props.forEach((p, i) => {
      const v = page.values[r.id]?.[p.id] ?? null;
      const key = headers[i + 1]!;
      if (v === null) out[key] = "";
      else if (typeof v === "number") out[key] = v;
      else if (p.kind === "DATE") out[key] = new Date(`${String(v)}T00:00:00Z`);
      else out[key] = valueText(p.kind, v, p.options, people);
    });
    out[headers[props.length + 1]!] = r.createdBy ?? "";
    out[headers[props.length + 2]!] = new Date(r.createdAt);
    out[headers[props.length + 3]!] = new Date(r.updatedAt);
    return out;
  });
  if (rows.length === 0) rows.push(Object.fromEntries(headers.map((h) => [h, ""])));
  return { rows, count: page.rows.length };
}

export type ImportResult = { rows: number; columns: number; noTitle: number; overLimit: number; cellsLeftOut: number };

/**
 * A spreadsheet's rows added to the list (src/lib/smart-lists/own-rows-import.ts decides where each column goes):
 * new columns made first — a select's choices from the file's values — a choice the file names that an existing select
 * lacks added to it, then the rows and their values, all at once or not at all. A row without a title is left out; so
 * is anything past the list's limit, and a cell that isn't what its column keeps.
 */
export async function importRows(input: {
  workbookId: string;
  userId: string;
  headers: string[];
  rows: string[][];
  mapping: ImportTarget[];
}): Promise<{ ok: true; result: ImportResult } | { ok: false; error: string }> {
  const { workbookId, userId } = input;
  const width = input.headers.length;
  if (!width || input.mapping.length !== width) return { ok: false, error: "Choose where each column of the file goes." };
  const titleAt = input.mapping.findIndex((m) => m.to === "title");
  if (titleAt < 0 || input.mapping.filter((m) => m.to === "title").length > 1) return { ok: false, error: "Choose one column of the file as each row's title." };
  const rows = input.rows.slice(0, IMPORT_LIMITS.rows).map((r) => Array.from({ length: width }, (_, i) => String(r?.[i] ?? "").trim().slice(0, IMPORT_LIMITS.cell)));

  const existing = await db.workbookProperty.findMany({ where: { workbookId }, select: { id: true, name: true, kind: true, options: true, sortOrder: true } });
  const known = new Map(existing.map((p) => [p.id, p]));
  const fresh = input.mapping.flatMap((m, i) => (m.to === "new" ? [{ i, name: String(m.name ?? "").replace(/\s+/g, " ").trim().slice(0, LIMITS.propertyName), kind: m.kind }] : []));
  const names = new Set(existing.map((p) => p.name.toLowerCase()));
  for (const f of fresh) {
    if (!f.name) return { ok: false, error: "Every new column needs a name." };
    if (names.has(f.name.toLowerCase())) return { ok: false, error: `This list already has a column called "${f.name}".` };
    names.add(f.name.toLowerCase());
  }
  if (existing.length + fresh.length > LIMITS.properties) return { ok: false, error: `A list holds up to ${LIMITS.properties} columns — leave some of the file's out.` };
  for (const m of input.mapping) if (m.to === "column" && !known.has(m.propertyId)) return { ok: false, error: "A column chosen for the file no longer exists. Open the import again." };

  const [have, people] = await Promise.all([
    db.workbookRow.count({ where: { workbookId } }),
    db.user.findMany({ where: { active: true }, select: { id: true, name: true, email: true } }),
  ]);
  const titled = rows.filter((r) => cleanTitle(r[titleAt]));
  const room = Math.max(0, OWN_ROWS.perList - have);
  const taken = titled.slice(0, room);
  const result: ImportResult = { rows: taken.length, columns: fresh.length, noTitle: rows.length - titled.length, overLimit: titled.length - taken.length, cellsLeftOut: 0 };
  if (taken.length === 0) return room === 0 ? { ok: false, error: `This list already holds ${OWN_ROWS.perList.toLocaleString("en-IN")} rows, its most.` } : { ok: false, error: "No row in the file has a title." };

  const last = await db.workbookRow.aggregate({ where: { workbookId }, _max: { sortOrder: true } });
  let order = last._max.sortOrder ?? 0;
  // A Company, Lead or Contact column matches the file's names among the records the importer may see (Smart Lists phase 3).
  const linkMaps = new Map<number, Map<string, string>>();
  for (const [i, m] of input.mapping.entries()) {
    const kind = m.to === "new" ? m.kind : m.to === "column" ? (known.get(m.propertyId)?.kind as PropertyKind | undefined) : undefined;
    if (kind !== "COMPANY" && kind !== "LEAD" && kind !== "CONTACT") continue;
    linkMaps.set(i, await matchLinkNames(kind, taken.flatMap((r) => (r[i] ?? "").split(/[,;|]/)), userId));
  }
  const addedIds: string[] = [];

  await db.$transaction(
    async (tx) => {
      // Each column of the file → the property it fills, with that property's choices.
      const target = new Map<number, { id: string; kind: PropertyKind; options: SelectOption[] }>();
      let sort = Math.max(0, ...existing.map((p) => p.sortOrder));
      for (const f of fresh) {
        const multi = f.kind === "MULTI_SELECT";
        const options = f.kind === "SELECT" || multi ? cleanOptions(templateOptions(choicesIn(taken.map((r) => r[f.i]!), multi))) : null;
        sort += 10;
        const made = await tx.workbookProperty.create({
          data: { workbookId, name: f.name, kind: f.kind, options: options ? (options as unknown as Prisma.InputJsonValue) : undefined, sortOrder: sort },
          select: { id: true },
        });
        target.set(f.i, { id: made.id, kind: f.kind, options: options ?? [] });
      }
      for (const [i, m] of input.mapping.entries()) {
        if (m.to !== "column") continue;
        const p = known.get(m.propertyId)!;
        const kind = p.kind as PropertyKind;
        let options = optionsOf(p.options);
        if (kind === "SELECT" || kind === "MULTI_SELECT") {
          const missing = choicesIn(taken.map((r) => r[i]!), kind === "MULTI_SELECT").filter((n) => !options.some((o) => o.name.toLowerCase() === n.toLowerCase()));
          if (missing.length) {
            options = cleanOptions([...options, ...templateOptions(missing)]);
            await tx.workbookProperty.update({ where: { id: p.id }, data: { options: options as unknown as Prisma.InputJsonValue }, select: { id: true } });
          }
        }
        target.set(i, { id: p.id, kind, options });
      }

      const made = taken.map((r) => ({ id: newRowId(), title: cleanTitle(r[titleAt]), cells: r }));
      addedIds.push(...made.map((r) => r.id));
      // For Deskzo Automate's "A row is added to a Smart List" — the first 200 of an import (Smart Lists phase 3).
      const listName = (await tx.workbook.findUnique({ where: { id: workbookId }, select: { name: true } }))?.name ?? "";
      await emitRowsAdded(tx, made.map((r) => ({ workbookId, listName, own: true, rowKey: r.id, title: r.title })), "import", userId);
      await tx.workbookRow.createMany({
        data: made.map((r) => {
          order += 10;
          return { id: r.id, workbookId, title: r.title, sortOrder: order, createdByUserId: userId, updatedByUserId: userId };
        }),
      });
      const cells: Prisma.WorkbookRowValueCreateManyInput[] = [];
      for (const r of made) {
        for (const [i, t] of target) {
          const names = linkMaps.get(i);
          if (names) {
            const parts = (r.cells[i] ?? "").split(/[,;|]/).map((s) => s.trim()).filter(Boolean);
            const ids = [...new Set(parts.map((p) => names.get(p.toLowerCase())).filter((x): x is string => !!x))];
            if (ids.length < parts.length) result.cellsLeftOut += 1;
            if (ids.length) cells.push({ workbookId, rowId: r.id, propertyId: t.id, value: ids.slice(0, 20) as Prisma.InputJsonValue, updatedByUserId: userId });
            continue;
          }
          const { value, skipped } = cellValue(t.kind, r.cells[i] ?? "", { options: t.options, people });
          if (skipped) result.cellsLeftOut += 1;
          if (value !== null) cells.push({ workbookId, rowId: r.id, propertyId: t.id, value: value as Prisma.InputJsonValue, updatedByUserId: userId });
        }
      }
      for (let i = 0; i < cells.length; i += 5000) await tx.workbookRowValue.createMany({ data: cells.slice(i, i + 5000) });
    },
    { timeout: 120_000, maxWait: 10_000 },
  );
  await recordChanges(addedIds.map((rowKey) => ({ workbookId, rowKey, kind: "IMPORTED" as const, byUserId: userId })));
  return { ok: true, result };
}
