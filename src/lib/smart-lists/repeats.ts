import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";
import { tenantKey } from "@/lib/tenancy/cache";
import { recordChanges } from "@/lib/smart-lists/history";
import { emitRowsAdded } from "@/lib/automate/emit-smart-lists";
import { OWN_ROWS, cleanTitle } from "@/lib/smart-lists/own-rows";
import { optionsOf, parseValue, type PropertyKind } from "@/lib/smart-lists/values";
import { EVERY_LABELS, REPEAT_LIMITS, isDay, isEvery, nextAfter, titleFor, type RepeatEvery } from "@/lib/smart-lists/repeat-dates";
import { tidyPublicAnswers } from "@/lib/smart-lists/public-forms";

/**
 * Rows that repeat and rows copied (owner, 20 Nov 2026 — Smart Lists phase 4). A repeat is a row's pattern — its title
 * (with {date}, {month} or {year} for the day it's for) and its cells — and how often: on each of its dates a new row
 * is added, as by whoever set it up, recorded in its history and handed to Deskzo Automate ("added via repeat").
 * One row a date: a date missed while Deskzo was down isn't made up later, past the latest one. Whoever may change
 * the list sets repeats up, stops and deletes them (the caller checks). Server only.
 */

/** What a copy or a repeat carries: what was typed or picked — not files (a cell's own), counts or formulas (worked out). */
const NOT_COPIED: readonly PropertyKind[] = ["FILE", "ROLLUP", "FORMULA"];

export type RepeatCells = Record<string, unknown>;
type RepeatValues = { cells: RepeatCells; startOn: string };

function valuesOf(raw: unknown): RepeatValues {
  const v = (raw && typeof raw === "object" ? raw : {}) as Partial<RepeatValues>;
  return { cells: v.cells && typeof v.cells === "object" ? v.cells : {}, startOn: isDay(v.startOn) ? v.startOn : "" };
}

/** A row's cells to copy: its typed-in ones, read again against the list's columns as they are now. */
export async function copiedCells(workbookId: string, cells: RepeatCells): Promise<{ propertyId: string; value: Prisma.InputJsonValue }[]> {
  const props = await db.workbookProperty.findMany({ where: { workbookId }, select: { id: true, kind: true, options: true } });
  const out: { propertyId: string; value: Prisma.InputJsonValue }[] = [];
  for (const p of props) {
    const kind = p.kind as PropertyKind;
    if (NOT_COPIED.includes(kind) || cells[p.id] === undefined || cells[p.id] === null) continue;
    const parsed = parseValue(kind, cells[p.id], optionsOf(p.options));
    if (!parsed.ok || parsed.value === null) continue;
    if (kind === "PERSON" && !(await db.user.findFirst({ where: { id: String(parsed.value), active: true }, select: { id: true } }))) continue;
    out.push({ propertyId: p.id, value: parsed.value as Prisma.InputJsonValue });
  }
  return out;
}

/** A row's cells as kept — the pattern a repeat or a copy starts from. */
export async function cellsOfRow(rowId: string): Promise<RepeatCells> {
  const values = await db.workbookRowValue.findMany({ where: { rowId }, select: { propertyId: true, value: true } });
  return Object.fromEntries(values.map((v) => [v.propertyId, v.value]));
}

export type RepeatLine = { id: string; title: string; every: RepeatEvery; everyLabel: string; nextOn: string; active: boolean; by: string | null; cells: number };

/** A list's repeats, for whoever may change it. */
export async function repeatsOf(workbookId: string): Promise<RepeatLine[]> {
  const rows = await db.workbookRepeat.findMany({ where: { workbookId }, orderBy: { createdAt: "asc" }, select: { id: true, title: true, every: true, nextOn: true, active: true, values: true, createdByUserId: true } }).catch(() => []);
  const names = new Map((await db.user.findMany({ where: { id: { in: rows.map((r) => r.createdByUserId).filter((x): x is string => !!x) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  return rows
    .filter((r) => isEvery(r.every))
    .map((r) => ({
      id: r.id,
      title: r.title,
      every: r.every as RepeatEvery,
      everyLabel: EVERY_LABELS[r.every as RepeatEvery],
      nextOn: r.nextOn,
      active: r.active,
      by: r.createdByUserId ? (names.get(r.createdByUserId) ?? null) : null,
      cells: Object.keys(valuesOf(r.values).cells).length,
    }));
}

/** Makes the row a repeat is due for — `on` its date. Returns the row's id, or null when the list is full. */
async function makeRow(rep: { id: string; workbookId: string; title: string; values: unknown; every: RepeatEvery; createdByUserId: string | null }, on: string, listName: string): Promise<string | null> {
  if ((await db.workbookRow.count({ where: { workbookId: rep.workbookId } })) >= OWN_ROWS.perList) return null;
  const by = rep.createdByUserId && (await db.user.findFirst({ where: { id: rep.createdByUserId, active: true }, select: { id: true } })) ? rep.createdByUserId : null;
  const cells = await copiedCells(rep.workbookId, valuesOf(rep.values).cells);
  const last = await db.workbookRow.aggregate({ where: { workbookId: rep.workbookId }, _max: { sortOrder: true } });
  const title = cleanTitle(titleFor(rep.title, on)) || "A repeat";
  const row = await db.$transaction(async (tx) => {
    const made = await tx.workbookRow.create({ data: { workbookId: rep.workbookId, title, sortOrder: (last._max.sortOrder ?? 0) + 10, createdByUserId: by, updatedByUserId: by }, select: { id: true, title: true } });
    if (cells.length) await tx.workbookRowValue.createMany({ data: cells.map((c) => ({ workbookId: rep.workbookId, rowId: made.id, propertyId: c.propertyId, value: c.value, updatedByUserId: by })) });
    await emitRowsAdded(tx, [{ workbookId: rep.workbookId, listName, own: true, rowKey: made.id, title: made.title }], "repeat", by);
    return made;
  });
  await recordChanges([{ workbookId: rep.workbookId, rowKey: row.id, kind: "ADDED", after: `a repeat (${EVERY_LABELS[rep.every].toLowerCase()})`, byUserId: by }]);
  return row.id;
}

/** Repeats due on or before `today`: one row each, for its latest date due, and its next date after today. Never throws. */
export async function runDueRepeats(today: string): Promise<number> {
  let made = 0;
  try {
    const due = await db.workbookRepeat.findMany({ where: { active: true, nextOn: { lte: today } }, take: 500, select: { id: true, workbookId: true, title: true, values: true, every: true, nextOn: true, createdByUserId: true, workbook: { select: { name: true, mode: true } } } });
    for (const rep of due) {
      if (!isEvery(rep.every) || !isDay(rep.nextOn)) continue;
      const start = valuesOf(rep.values).startOn || rep.nextOn;
      // The latest date due, and the first one after today.
      let on = rep.nextOn;
      for (let i = 0; i < 4000; i += 1) {
        const n = nextAfter(start, rep.every, on);
        if (n > today) break;
        on = n;
      }
      const next = nextAfter(start, rep.every, today);
      // Claimed first, so two heartbeats can't both make it.
      const claimed = await db.workbookRepeat.updateMany({ where: { id: rep.id, nextOn: rep.nextOn, active: true }, data: { nextOn: next, lastRunAt: new Date() } });
      if (!claimed.count || rep.workbook.mode !== "ROWS") continue;
      if (await makeRow({ ...rep, every: rep.every }, on, rep.workbook.name)) made += 1;
    }
  } catch (err) {
    if (!notMigratedYet(err)) console.error("[smart-lists] repeating rows failed", err instanceof Error ? err.message : err);
  }
  return made;
}

const ranOn = new Map<string, string>();

/** Each morning: rows that repeat, and public answers past keeping — once a day a workspace. From the heartbeat; never throws. */
export async function runSmartListDay(): Promise<number> {
  try {
    const key = await tenantKey().catch(() => "default");
    const today = (await workspaceClock()).today();
    if (ranOn.get(key) === today) return 0;
    ranOn.set(key, today);
    await tidyPublicAnswers();
    return await runDueRepeats(today);
  } catch (err) {
    if (!notMigratedYet(err)) console.error("[smart-lists] the morning's repeats failed", err instanceof Error ? err.message : err);
    return 0;
  }
}

/** A repeat set up or changed. `cells` given (from a row), its pattern too. The caller checks who may. */
export async function saveRepeat(input: { workbookId: string; id?: string | null; title: string; every: unknown; startOn: unknown; active?: boolean; cells?: RepeatCells; userId: string; today: string }): Promise<{ ok: true; id: string; nextOn: string } | { ok: false; error: string }> {
  const title = String(input.title ?? "").replace(/\s+/g, " ").trim().slice(0, REPEAT_LIMITS.title);
  if (!title) return { ok: false, error: "Give the repeat a title — {month} puts the month in it." };
  if (!isEvery(input.every)) return { ok: false, error: "Pick how often it repeats." };
  if (!isDay(input.startOn)) return { ok: false, error: "Pick the first date." };
  const every = input.every;
  const startOn = input.startOn;
  // Its next date: the first, or the first after yesterday — today's comes this morning or at the next run.
  const nextOn = startOn >= input.today ? startOn : nextAfter(startOn, every, addDaysBack(input.today));
  const existing = input.id ? await db.workbookRepeat.findFirst({ where: { id: input.id, workbookId: input.workbookId }, select: { id: true, values: true } }) : null;
  if (input.id && !existing) return { ok: false, error: "That repeat no longer exists." };
  const cells = input.cells ?? (existing ? valuesOf(existing.values).cells : {});
  const values = { cells, startOn } as unknown as Prisma.InputJsonValue;
  if (existing) {
    await db.workbookRepeat.update({ where: { id: existing.id }, data: { title, every, nextOn, values, active: input.active !== false } });
    return { ok: true, id: existing.id, nextOn };
  }
  if ((await db.workbookRepeat.count({ where: { workbookId: input.workbookId } })) >= REPEAT_LIMITS.perList) return { ok: false, error: `A list keeps up to ${REPEAT_LIMITS.perList} repeats.` };
  const made = await db.workbookRepeat.create({ data: { workbookId: input.workbookId, title, every, nextOn, values, active: input.active !== false, createdByUserId: input.userId }, select: { id: true } });
  return { ok: true, id: made.id, nextOn };
}

function addDaysBack(day: string): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
}
