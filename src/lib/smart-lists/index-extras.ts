import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * What the Smart Lists page shows beside each list's name (owner, 20 Nov 2026: "this screen also requires upgrade"): its
 * own columns, its saved views by kind, the guests it is shared with now (Deskzo Connect), and a calling activity's
 * progress. Counted in a few grouped queries for every list at once; a workspace without the newer tables shows none of
 * those counts rather than failing. Server only.
 */

export type ListExtras = { columns: number; views: ("TABLE" | "BOARD" | "CALENDAR" | "GALLERY" | "TIMELINE")[]; guests: number; done: number; rows: number };

async function orEmpty<T>(q: Promise<T[]>): Promise<T[]> {
  try {
    return await q;
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

export async function listExtras(ids: string[], now = new Date()): Promise<Record<string, ListExtras>> {
  if (ids.length === 0) return {};
  const [columns, views, shares, done, own] = await Promise.all([
    orEmpty(db.workbookProperty.groupBy({ by: ["workbookId"], where: { workbookId: { in: ids } }, _count: { _all: true } })),
    orEmpty(db.workbookView.findMany({ where: { workbookId: { in: ids } }, orderBy: { sortOrder: "asc" }, select: { workbookId: true, kind: true } })),
    orEmpty(db.listShare.groupBy({ by: ["workbookId"], where: { workbookId: { in: ids }, revokedAt: null, OR: [{ until: null }, { until: { gt: now } }] }, _count: { _all: true } })),
    orEmpty(db.workbookRecord.groupBy({ by: ["workbookId"], where: { workbookId: { in: ids }, status: { in: ["DONE", "SKIPPED"] } }, _count: { _all: true } })),
    // A list with rows of its own: how many (src/lib/smart-lists/own-rows.ts).
    orEmpty(db.workbookRow.groupBy({ by: ["workbookId"], where: { workbookId: { in: ids } }, _count: { _all: true } })),
  ]);
  const out: Record<string, ListExtras> = {};
  for (const id of ids) {
    out[id] = {
      columns: columns.find((c) => c.workbookId === id)?._count._all ?? 0,
      views: views.filter((v) => v.workbookId === id).map((v) => v.kind as ListExtras["views"][number]),
      guests: shares.find((s) => s.workbookId === id)?._count._all ?? 0,
      done: done.find((d) => d.workbookId === id)?._count._all ?? 0,
      rows: own.find((r) => r.workbookId === id)?._count._all ?? 0,
    };
  }
  return out;
}
