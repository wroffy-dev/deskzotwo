import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { listMembersWhere } from "@/lib/smart-lists/membership";
import { notMigratedYet } from "@/lib/not-migrated";
import type { WorkbookFilters } from "@/lib/workspace/filters";

/**
 * Which of a shared list's rows a guest sees (owner, 20 Nov 2026: "lets work in the smart list only … where only accounts
 * nominated by our sales team will be shown to lc team. also external users record view by their territory"). The list's
 * own rows, then narrowed by two things, each only ever narrowing:
 *
 *   · **The share's tick column** (`ListShareScope.onlyPropertyId`): a Checkbox column of the list — "Nominated for LC" —
 *     and the guest sees only the rows ticked in it. The sales team nominates by ticking; the column need not be visible
 *     to the guest. A column since deleted shows nothing, never everything.
 *   · **The guest's territory** (`GuestTerritory.states`): only companies with an address in one of those states.
 *     No territory: every state.
 *
 * Every guest read and write goes through `guestRowsWhere`, so a row outside either is as absent as one outside the list.
 *
 * And which columns (`shareColumns`, 20 Nov 2026): a share may show only some of the columns marked visible to guests —
 * the LC team their LC columns, the territory reps their sales ones, on one list. No choice made: all of them.
 * Server only.
 */

type SharedList = { id: string; filters: unknown; ownerUserId: string };

async function orNull<T>(q: Promise<T>): Promise<T | null> {
  try {
    return await q;
  } catch (err) {
    // Before the tables arrive nothing can have been narrowed — there was no way to set it.
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

export async function shareOnlyColumn(shareId: string): Promise<string | null> {
  return (await orNull(db.listShareScope.findUnique({ where: { shareId }, select: { onlyPropertyId: true } })))?.onlyPropertyId ?? null;
}

export async function guestStates(guestId: string): Promise<string[]> {
  return (await orNull(db.guestTerritory.findUnique({ where: { guestId }, select: { states: true } })))?.states ?? [];
}

/** The narrowing alone — a tick column and a territory — for a share of a guest's. */
export async function narrowing(guestId: string, shareId: string): Promise<Prisma.CompanyWhereInput[]> {
  const [only, states] = await Promise.all([shareOnlyColumn(shareId), guestStates(guestId)]);
  const and: Prisma.CompanyWhereInput[] = [];
  if (only) and.push({ smartListValues: { some: { propertyId: only, value: { equals: true } } } });
  if (states.length) and.push({ locations: { some: { state: { in: states, mode: "insensitive" } } } });
  return and;
}

/** The companies of a shared list this guest may see — the list's rows, ticked for them and in their territory. */
export async function guestRowsWhere(guestId: string, shareId: string, wb: SharedList): Promise<Prisma.CompanyWhereInput> {
  const [members, narrow] = await Promise.all([listMembersWhere(wb.ownerUserId, wb.id, (wb.filters ?? {}) as WorkbookFilters), narrowing(guestId, shareId)]);
  return { AND: [members, ...narrow] };
}

/** Whether one company is among them. */
export async function guestSeesRow(guestId: string, shareId: string, wb: SharedList, companyId: unknown): Promise<boolean> {
  if (typeof companyId !== "string" || !companyId) return false;
  return (await db.company.count({ where: { AND: [await guestRowsWhere(guestId, shareId, wb), { id: companyId }] } })) > 0;
}

/** The columns this share is limited to, or null — every column marked for guests. */
export async function shareColumns(shareId: string): Promise<string[] | null> {
  return (await orNull(db.listShareColumns.findUnique({ where: { shareId }, select: { columnIds: true } })))?.columnIds ?? null;
}
