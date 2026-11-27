import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { rightsFor, type ListRights } from "@/lib/smart-lists/access";

/**
 * A Smart List as the person asking may use it (owner, 20 Nov 2026 — src/lib/smart-lists): the list's own rule
 * (getWorkbook in src/actions/workspace.ts), nothing new — open it if it's shared, theirs, or they hold
 * `workspace.manageAny`; shape it (columns, views) if it's theirs or they hold `workspace.manageAny`. Shared by
 * src/actions/smart-list-board.ts (company rows) and src/actions/smart-list-rows.ts (rows of its own). Server only.
 */

export type Opened = {
  userId: string;
  workbook: { id: string; name: string; filters: unknown; ownerUserId: string; mode: string };
  canEdit: boolean;
  isAssignee: boolean;
  /** May fill it in — add rows, change cells (Smart Lists phase 4: a list can be view-only for some). */
  canFill: boolean;
  rights: ListRights;
};

export async function openList(workbookId: unknown): Promise<Opened | null> {
  const user = await requireModuleAccess("workspace");
  if (typeof workbookId !== "string" || !workbookId) return null;
  const workbook = await db.workbook.findUnique({
    where: { id: workbookId },
    select: { id: true, name: true, filters: true, ownerUserId: true, shared: true, mode: true, assignees: { where: { userId: user.id }, select: { userId: true } } },
  });
  if (!workbook) return null;
  const manageAny = workbook.ownerUserId === user.id ? true : await hasEffectivePermission(user.id, "workspace.manageAny");
  // Who may see and fill it in (Smart Lists phase 4 — src/lib/smart-lists/access.ts): private, chosen people, view-only.
  const rights = await rightsFor(user.id, workbook, { manageAny });
  if (!rights.view) return null;
  return {
    userId: user.id,
    workbook: { id: workbook.id, name: workbook.name, filters: workbook.filters, ownerUserId: workbook.ownerUserId, mode: workbook.mode },
    canEdit: rights.shape,
    isAssignee: workbook.assignees.length > 0,
    canFill: rights.fill,
    rights,
  };
}
