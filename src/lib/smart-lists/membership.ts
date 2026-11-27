import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { companyScope } from "@/lib/authz/company-scope";
import { companyMasker } from "@/lib/companies/masking";
import { buildWhere, withoutMaskedFilters, type WorkbookFilters } from "@/lib/workspace/filters";
import { workspaceClock } from "@/lib/time/workspace";
import { notMigratedYet } from "@/lib/not-migrated";
import { tenantKey } from "@/lib/tenancy/cache";

/**
 * Which companies are in a Smart List for somebody (owner, 20 Nov 2026 — src/lib/smart-lists): those its filters bring,
 * and those added to it by hand (`WorkbookPinnedRow`) — always within the companies that person may see
 * (`companyScope`), so a hand-added company never shows to somebody it isn't theirs to see. Server only.
 */

const ready = new Map<string, boolean>();

/** Whether this workspace has the Notion-style tables yet — asked once a process, remembered once it has. */
export async function smartListsReady(): Promise<boolean> {
  const key = await tenantKey().catch(() => "default");
  if (ready.get(key)) return true;
  try {
    await db.workbookPinnedRow.findFirst({ select: { workbookId: true } });
    await db.workbookRowPage.findFirst({ select: { id: true } });
    ready.set(key, true);
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

/** The companies in the list for `userId`, as a where — its filters OR added by hand, inside their scope. */
export async function listMembersWhere(userId: string, workbookId: string | null, filters: WorkbookFilters): Promise<Prisma.CompanyWhereInput> {
  // A list with rows of its own holds no companies (src/lib/smart-lists/own-rows.ts): its empty filters would otherwise
  // read as every company — for its values, row pages, dashboard, guests and comments alike.
  if (workbookId && (await db.workbook.findUnique({ where: { id: workbookId }, select: { mode: true } }))?.mode === "ROWS") return { id: { in: [] } };
  // A filter on a field the list masks for this person is dropped (R3-21, as runWorkbook does).
  const shown = await companyMasker(userId, "list");
  const byFilters = buildWhere(withoutMaskedFilters(filters ?? {}, shown), await workspaceClock());
  const pinned = workbookId && (await smartListsReady()) ? [{ smartListPins: { some: { workbookId } } }] : [];
  return { AND: [await companyScope(userId), pinned.length ? { OR: [byFilters, ...pinned] } : byFilters] };
}

/** Whether `companyId` is in the list for `userId` right now. */
export async function companyInList(userId: string, workbook: { id: string; filters: unknown }, companyId: string): Promise<boolean> {
  if (typeof companyId !== "string" || !companyId) return false;
  const where = await listMembersWhere(userId, workbook.id, (workbook.filters ?? {}) as WorkbookFilters);
  return (await db.company.count({ where: { AND: [where, { id: companyId }] } })) > 0;
}
