"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser, refuseWhileViewingAs } from "@/lib/session";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { backupBeforeDeletingLeads, CONFIRM_WORDS, countLeads, deleteLeadBatch } from "@/lib/leads/delete-all";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Data › Delete all leads (src/lib/leads/delete-all.ts). Deleting leads is the workspace's super admin's
 * alone, acting as themselves (src/actions/super-admin-delete.ts); the words typed, every call; a backup first.
 */
async function gate(confirm: unknown): Promise<{ userId: string } | { error: string }> {
  const user = await requireUser();
  if (!(await actingAsSuperAdmin(user.id))) return { error: "Only the workspace's super admin can delete leads." };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { error: viewingAs };
  if (confirm !== CONFIRM_WORDS) return { error: `Type ${CONFIRM_WORDS} to confirm.` };
  return { userId: user.id };
}

/** The backup, before anything goes. */
export async function startDeletingAllLeads(confirm: string): Promise<ActionResult<{ backupId: string; total: number }>> {
  const allowed = await gate(confirm);
  if ("error" in allowed) return { ok: false, error: allowed.error };
  const backup = await backupBeforeDeletingLeads(allowed.userId);
  if (!backup.ok) return { ok: false, error: backup.error };
  return { ok: true, data: { backupId: backup.backupId, total: await countLeads() } };
}

/** One batch; the browser calls again until none are left. Only after a backup taken for this in the last day. */
export async function deleteNextLeads(input: { confirm: string; backupId: string }): Promise<ActionResult<{ deleted: number; left: number }>> {
  const allowed = await gate(input?.confirm);
  if ("error" in allowed) return { ok: false, error: allowed.error };
  const backup = typeof input?.backupId === "string" ? await db.backup.findUnique({ where: { id: input.backupId }, select: { status: true, startedAt: true } }).catch(() => null) : null;
  if (!backup || backup.status !== "SUCCEEDED" || Date.now() - backup.startedAt.getTime() > 86_400_000) {
    return { ok: false, error: "Start again: the safety backup for this isn't there." };
  }
  const result = await deleteLeadBatch(allowed.userId);
  if (result.left === 0) {
    revalidatePath("/leads");
    revalidatePath("/settings/data/delete-leads");
  }
  return { ok: true, data: result };
}
