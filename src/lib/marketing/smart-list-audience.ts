import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { rightsFor, rightsForMany } from "@/lib/smart-lists/access";
import { notMigratedYet } from "@/lib/not-migrated";
import { DEFAULT_CONTACT_FILTERS, parseCompanyFilters } from "@/lib/marketing/audience";

/**
 * A Smart List as a marketing audience (owner, 16 Nov 2026: "in marketing audience can we use created smart list as
 * audience also? also mail button in created smart list").
 *
 * An audience's company half is already a Smart List's filters (`WorkbookFilters`, the same `buildWhere`), so an
 * audience that follows a list simply carries the list's filters — copied in when it is linked, and again every time
 * the list is saved. Everything that reads an audience (the send pipeline, journeys, reports) keeps reading
 * `companyFilters` and needs no change. A list deleted leaves its audiences with the filters it last had.
 *
 * Only a list the person could open on the Smart Lists page may be picked: shared, their own, or any with
 * `workspace.manageAny` — the rule `getWorkbook` applies.
 *
 * `Audience.smartListId` is read and written by name (NOT_YET_EVERYWHERE): a workspace not migrated yet has no links.
 */

export type SmartListChoice = { id: string; name: string; calling: boolean };

/** The Smart Lists this person may make an audience of. */
export async function smartListsFor(userId: string): Promise<SmartListChoice[]> {
  const any = await can(userId, "workspace.manageAny");
  const rows = await db.workbook.findMany({
    where: any ? {} : { OR: [{ shared: true }, { ownerUserId: userId }] },
    orderBy: { name: "asc" },
    take: 500,
    select: { id: true, name: true, mode: true, shared: true, ownerUserId: true },
  });
  // Only lists the person may see — chosen people and departments too (Smart Lists phase 4).
  const rights = await rightsForMany(userId, rows);
  // A list with rows of its own holds no companies, so it's no audience (src/lib/smart-lists/own-rows.ts).
  return rows.filter((r) => r.mode !== "ROWS" && rights.get(r.id)?.view).map((r) => ({ id: r.id, name: r.name, calling: r.mode === "COLD_CALLING" }));
}

/** One Smart List, if this person may use it: its name and filters. */
export async function smartListFor(userId: string, id: string | null | undefined) {
  if (!id || typeof id !== "string") return null;
  const list = await db.workbook.findUnique({ where: { id }, select: { id: true, name: true, filters: true, shared: true, ownerUserId: true, mode: true } });
  if (!list || list.mode === "ROWS") return null;
  if (!(await rightsFor(userId, list)).view) return null;
  return { id: list.id, name: list.name, filters: parseCompanyFilters(list.filters) };
}

/** Links an audience to a list (or unlinks it, with null). False when the workspace has no column for it yet. */
export async function linkAudience(audienceId: string, smartListId: string | null): Promise<boolean> {
  try {
    await db.audience.update({ where: { id: audienceId }, data: { smartListId }, select: { id: true } });
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

/** Which list each audience follows, by audience id. */
export async function smartListsOfAudiences(audienceIds: string[]): Promise<Map<string, { id: string; name: string }>> {
  const out = new Map<string, { id: string; name: string }>();
  if (audienceIds.length === 0) return out;
  try {
    const rows = await db.audience.findMany({
      where: { id: { in: audienceIds }, smartListId: { not: null } },
      select: { id: true, smartList: { select: { id: true, name: true } } },
    });
    for (const r of rows) if (r.smartList) out.set(r.id, r.smartList);
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  return out;
}

/**
 * The audience that follows this list, made the first time it is needed — for the mass-mail screen and a Smart List's
 * Mail button. Its people are the usual defaults (verified addresses, two per company, primary first); it can be
 * changed like any other audience. Null when the workspace isn't migrated yet.
 */
export async function audienceFollowing(userId: string, list: { id: string; name: string; filters: unknown }): Promise<string | null> {
  try {
    const existing = await db.audience.findFirst({ where: { smartListId: list.id }, orderBy: { createdAt: "asc" }, select: { id: true } });
    if (existing) {
      await db.audience.update({ where: { id: existing.id }, data: { companyFilters: parseCompanyFilters(list.filters) as Prisma.InputJsonValue }, select: { id: true } });
      return existing.id;
    }
    const made = await db.audience.create({
      data: {
        name: `Smart List: ${list.name}`.slice(0, 200),
        description: "Follows the Smart List — change the list and this changes with it.",
        companyFilters: parseCompanyFilters(list.filters) as Prisma.InputJsonValue,
        contactFilters: DEFAULT_CONTACT_FILTERS as Prisma.InputJsonValue,
        smartListId: list.id,
        createdById: userId,
      },
      select: { id: true },
    });
    return made.id;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** A list was saved: every audience following it takes its filters again. */
export async function syncSmartListAudiences(smartListId: string, filters: unknown): Promise<number> {
  try {
    const done = await db.audience.updateMany({ where: { smartListId }, data: { companyFilters: parseCompanyFilters(filters) as Prisma.InputJsonValue } });
    return done.count;
  } catch (err) {
    if (notMigratedYet(err)) return 0;
    throw err;
  }
}

/** The people half of the audience following this list, for a preview that mustn't make one. Null: the defaults. */
export async function contactFiltersFollowing(smartListId: string): Promise<unknown> {
  try {
    const row = await db.audience.findFirst({ where: { smartListId }, orderBy: { createdAt: "asc" }, select: { contactFilters: true } });
    return row?.contactFilters ?? null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}
