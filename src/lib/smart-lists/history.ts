import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { optionsOf, valueText, isLinkKind, type PropertyKind } from "@/lib/smart-lists/values";

/**
 * A Smart List row's history (owner, 20 Nov 2026 — Smart Lists phase 3: "Status: Pending → Live, by Asha, 20 Nov"):
 * what changed in a row — added, renamed, a cell changed, a file attached, imported, set with others — who changed it
 * and when, for a list of its own rows and a list of companies alike (the row is an own row's id or a company's).
 * Written beside each save, never in its way: a workspace without the table yet records nothing. Server only.
 */

export type ChangeKind = "ADDED" | "TITLE" | "VALUE" | "IMPORTED" | "FILE";
/** `byGuestId`: a Deskzo Connect guest's change (Smart Lists phase 4) — `byUserId` null then. */
export type Change = { workbookId: string; rowKey: string; kind: ChangeKind; propertyId?: string | null; before?: unknown; after?: unknown; byUserId: string | null; byGuestId?: string | null };

const json = (v: unknown): Prisma.InputJsonValue | undefined => (v === null || v === undefined ? undefined : (v as Prisma.InputJsonValue));

/** Changes recorded. Never throws: history is beside a save, not part of it. */
export async function recordChanges(changes: Change[]): Promise<void> {
  const kept = changes.filter((c) => c.kind !== "VALUE" || JSON.stringify(c.before ?? null) !== JSON.stringify(c.after ?? null));
  if (!kept.length) return;
  try {
    for (let i = 0; i < kept.length; i += 2000) {
      await db.workbookRowChange.createMany({
        // A guest's change names them — written by name, as a workspace not migrated yet has no such column (src/lib/tenancy/clients.ts).
        data: kept.slice(i, i + 2000).map((c) => ({ workbookId: c.workbookId, rowKey: c.rowKey, kind: c.kind, propertyId: c.propertyId ?? null, before: json(c.before), after: json(c.after), byUserId: c.byUserId, ...(c.byGuestId ? { byGuestId: c.byGuestId } : {}) })),
      });
    }
  } catch (err) {
    if (!notMigratedYet(err)) console.error("[smart-lists] history not recorded", err instanceof Error ? err.message : err);
  }
  // A changed row's formulas, worked out again (Smart Lists phase 4 — src/lib/smart-lists/formula-server.ts).
  const byList = new Map<string, Set<string>>();
  for (const c of kept) (byList.get(c.workbookId) ?? byList.set(c.workbookId, new Set()).get(c.workbookId)!).add(c.rowKey);
  const { recomputeFormulas } = await import("@/lib/smart-lists/formula-server");
  for (const [workbookId, keys] of byList) await recomputeFormulas(workbookId, [...keys]);
}

export type HistoryLine = { id: string; at: string; by: string | null; text: string };

/** A row's last changes, newest first, in words. Linked records are counted, not named — the row page shows them. */
export async function rowHistory(workbookId: string, rowKey: string, limit = 50): Promise<HistoryLine[]> {
  let rows;
  try {
    rows = await db.workbookRowChange.findMany({
      where: { workbookId, rowKey },
      orderBy: { at: "desc" },
      take: Math.min(200, limit),
      select: { id: true, at: true, kind: true, propertyId: true, before: true, after: true, byUserId: true },
    });
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
  if (!rows.length) return [];
  const [props, users] = await Promise.all([
    db.workbookProperty.findMany({ where: { workbookId }, select: { id: true, name: true, kind: true, options: true } }),
    db.user.findMany({ where: { id: { in: [...new Set(rows.flatMap((r) => [r.byUserId, typeof r.before === "string" ? r.before : null, typeof r.after === "string" ? r.after : null]).filter((x): x is string => !!x))] } }, select: { id: true, name: true } }),
  ]);
  const names = new Map(users.map((u) => [u.id, u.name]));
  const byId = new Map(props.map((p) => [p.id, p]));
  // Changes a Deskzo Connect guest made (phase 4) — none on a workspace not migrated yet.
  const guestChanges = rows.some((r) => !r.byUserId)
    ? await db.workbookRowChange.findMany({ where: { id: { in: rows.filter((r) => !r.byUserId).map((r) => r.id) }, byGuestId: { not: null } }, select: { id: true, byGuestId: true } }).catch(() => [])
    : [];
  const guestOf = new Map(guestChanges.map((g) => [g.id, g.byGuestId as string]));
  const guestNames = guestOf.size ? new Map((await db.guest.findMany({ where: { id: { in: [...new Set(guestOf.values())] } }, select: { id: true, name: true } })).map((g) => [g.id, g.name])) : new Map<string, string>();
  const say = (kind: PropertyKind, v: unknown, options: unknown) => {
    if (v === null || v === undefined) return "empty";
    if (isLinkKind(kind)) return Array.isArray(v) ? `${v.length} linked` : "linked";
    if (kind === "FILE") return Array.isArray(v) ? `${v.length} file${v.length === 1 ? "" : "s"}` : "files";
    const t = valueText(kind, v, optionsOf(options), names);
    return t ? (t.length > 80 ? `${t.slice(0, 79)}…` : t) : "empty";
  };
  return rows.map((r) => {
    const p = r.propertyId ? byId.get(r.propertyId) : undefined;
    let text: string;
    switch (r.kind) {
      case "ADDED":
        text = typeof r.after === "string" && r.after ? `Added the row from ${r.after}` : "Added the row";
        break;
      case "IMPORTED":
        text = "Added from a spreadsheet";
        break;
      case "TITLE":
        text = `Renamed it from "${String(r.before ?? "")}" to "${String(r.after ?? "")}"`;
        break;
      case "FILE":
        text = `Attached ${String(r.after ?? "a file")}${p ? ` in ${p.name}` : ""}`;
        break;
      default:
        text = p ? `${p.name}: ${say(p.kind as PropertyKind, r.before, p.options)} → ${say(p.kind as PropertyKind, r.after, p.options)}` : "Changed a column since deleted";
    }
    const guest = guestOf.get(r.id);
    return { id: r.id, at: r.at.toISOString(), by: r.byUserId ? (names.get(r.byUserId) ?? "Somebody who left") : guest ? `${guestNames.get(guest) ?? "A guest"} (guest)` : null, text };
  });
}
