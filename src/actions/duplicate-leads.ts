"use server";

import { revalidatePath } from "next/cache";
import { requireUser, refuseWhileViewingAs } from "@/lib/session";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { removeDuplicateLeads, type RemoveResult } from "@/lib/leads/duplicates";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Data › Duplicate leads (src/lib/leads/duplicates.ts): taking away the copies an import made. Deleting
 * leads is the workspace's super admin's alone, acting as themselves, as the single lead delete is
 * (src/actions/super-admin-delete.ts).
 */
export async function removeDuplicateLeadCopies(copyIds: unknown): Promise<ActionResult<RemoveResult>> {
  const user = await requireUser();
  if (!(await actingAsSuperAdmin(user.id))) return { ok: false, error: "Only the workspace's super admin can delete leads." };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!Array.isArray(copyIds) || copyIds.some((id) => typeof id !== "string") || copyIds.length > 5000) return { ok: false, error: "Choose the copies to take away." };
  const result = await removeDuplicateLeads(copyIds as string[], user.id);
  revalidatePath("/settings/data/duplicate-leads");
  revalidatePath("/leads");
  return { ok: true, data: result };
}
