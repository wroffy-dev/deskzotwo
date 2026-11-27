import { db } from "@/lib/db";
import { mayOpenList } from "@/lib/smart-lists/links";
import { linkTargetOf, optionsOf, rollupOf, type PropertyKind, type Rollup } from "@/lib/smart-lists/values";

/**
 * Count and sum columns (owner, 20 Nov 2026 — Smart Lists phase 3: an article in the Content calendar showing
 * "Backlinks: 12 · Live: 9 · Cost ₹18,000", counted from the Backlink tracker rows that link to it). A ROLLUP column
 * looks at another list whose rows link to this one — through a "Row of another list" column pointing here, or, on a
 * list of companies, a Company column — and counts those rows, counts those with a choice, or adds up a Number or
 * Money column of theirs. Worked out each time it's shown, never typed in; somebody who may not open the other list
 * sees nothing in it. Server only.
 */

/** The lists and columns a count column on `workbookId` can look through — for its dialog. */
export async function rollupSources(workbookId: string, userId: string): Promise<{
  listId: string;
  listName: string;
  via: { id: string; name: string }[];
  selects: { id: string; name: string; options: { id: string; name: string }[] }[];
  numbers: { id: string; name: string; money: boolean }[];
}[]> {
  const here = await db.workbook.findUnique({ where: { id: workbookId }, select: { mode: true } });
  if (!here) return [];
  const linkKind: PropertyKind = here.mode === "ROWS" ? "ROW" : "COMPANY";
  const candidates = await db.workbookProperty.findMany({ where: { kind: linkKind, workbook: { mode: "ROWS" } }, select: { id: true, name: true, workbookId: true, options: true } });
  const pointing = candidates.filter((c) => (linkKind === "ROW" ? linkTargetOf(c.options) === workbookId : true));
  const lists = [...new Set(pointing.map((c) => c.workbookId))];
  const out = [];
  for (const listId of lists) {
    if (!(await mayOpenList(userId, listId))) continue;
    const [wb, cols] = await Promise.all([
      db.workbook.findUnique({ where: { id: listId }, select: { name: true } }),
      db.workbookProperty.findMany({ where: { workbookId: listId }, orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }], select: { id: true, name: true, kind: true, options: true } }),
    ]);
    if (!wb) continue;
    out.push({
      listId,
      listName: wb.name,
      via: pointing.filter((c) => c.workbookId === listId).map((c) => ({ id: c.id, name: c.name })),
      selects: cols.filter((c) => c.kind === "SELECT").map((c) => ({ id: c.id, name: c.name, options: optionsOf(c.options).map((o) => ({ id: o.id, name: o.name })) })),
      numbers: cols.filter((c) => c.kind === "NUMBER" || c.kind === "MONEY").map((c) => ({ id: c.id, name: c.name, money: c.kind === "MONEY" })),
    });
  }
  return out.sort((a, b) => a.listName.localeCompare(b.listName));
}

/** A count column's set-up, checked: the other list, a link column of it pointing here, and what to count or add up. */
export async function checkRollup(workbookId: string, userId: string, raw: unknown): Promise<Rollup | { error: string }> {
  const r = rollupOf(raw);
  if (!r) return { error: "Choose the list whose rows link here, and what to count." };
  const sources = await rollupSources(workbookId, userId);
  const src = sources.find((s) => s.listId === r.list);
  if (!src || !src.via.some((v) => v.id === r.via)) return { error: "Choose a list whose rows link here, through one of its columns." };
  if (r.fn === "sum") {
    const n = src.numbers.find((x) => x.id === r.field);
    if (!n) return { error: "Choose the Number or Money column to add up." };
    return { ...r, where: null, money: n.money };
  }
  if (r.where) {
    const s = src.selects.find((x) => x.id === r.where!.propertyId);
    if (!s || !s.options.some((o) => o.id === r.where!.optionId)) return { error: "Choose the choice to count." };
  }
  return { ...r, field: null, money: false };
}

/**
 * The count columns' values for the rows on screen: rowKey → propertyId → number. Rows of the other list are counted
 * only for somebody who may open it.
 */
export async function rollupValues(props: { id: string; kind: PropertyKind; rollup?: Rollup | null }[], rowKeys: string[], userId: string): Promise<Record<string, Record<string, number>>> {
  const out: Record<string, Record<string, number>> = {};
  const wanted = new Set(rowKeys);
  if (!wanted.size) return out;
  for (const p of props) {
    const r = p.kind === "ROLLUP" ? p.rollup : null;
    if (!r || !(await mayOpenList(userId, r.list))) continue;
    // Every row of the other list that links to one of these, by the link column.
    const links = await db.workbookRowValue.findMany({ where: { workbookId: r.list, propertyId: r.via }, select: { rowId: true, value: true }, take: 20_000 });
    const linkedTo = new Map<string, string[]>();
    for (const l of links) for (const key of Array.isArray(l.value) ? l.value.map(String) : []) if (wanted.has(key)) (linkedTo.get(key) ?? linkedTo.set(key, []).get(key)!).push(l.rowId);
    if (!linkedTo.size) {
      for (const key of rowKeys) (out[key] ??= {})[p.id] = 0;
      continue;
    }
    const sources = [...new Set([...linkedTo.values()].flat())];
    let weight: Map<string, number> | null = null;
    if (r.fn === "sum" && r.field) {
      const cells = await db.workbookRowValue.findMany({ where: { propertyId: r.field, rowId: { in: sources } }, select: { rowId: true, value: true } });
      weight = new Map(cells.filter((c) => typeof c.value === "number").map((c) => [c.rowId, c.value as number]));
    } else if (r.where) {
      const cells = await db.workbookRowValue.findMany({ where: { propertyId: r.where.propertyId, rowId: { in: sources }, value: { equals: r.where.optionId } }, select: { rowId: true } });
      weight = new Map(cells.map((c) => [c.rowId, 1]));
    }
    for (const key of rowKeys) {
      const from = linkedTo.get(key) ?? [];
      const n = weight ? from.reduce((s, id) => s + (weight!.get(id) ?? 0), 0) : from.length;
      (out[key] ??= {})[p.id] = Math.round(n * 100) / 100;
    }
  }
  return out;
}
