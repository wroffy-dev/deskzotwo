"use server";

import { requireUser, refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { isModuleEntitled } from "@/lib/modules-access";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { cleanSavedBlocks, listSavedBlocks, storeSavedBlocks, type SavedBlock } from "@/lib/marketing/saved-blocks";
import type { ActionResult } from "@/actions/company";

/**
 * The email builder's saved blocks (owner, 1 Nov 2026 — src/lib/marketing/saved-blocks.ts): saved, listed and deleted by
 * whoever may manage marketing, as the builder itself is.
 */

async function gate(write: boolean): Promise<{ userId: string } | { error: string }> {
  const user = await requireUser();
  if (!(await isModuleEntitled("marketing"))) return { error: "Marketing isn't part of this workspace's plan." };
  if (!(await can(user.id, "marketing.manage"))) return { error: "You can't design marketing emails." };
  if (write) {
    const viewing = await refuseWhileViewingAs();
    if (viewing) return { error: viewing };
  }
  return { userId: user.id };
}

export async function savedBlocks(): Promise<SavedBlock[]> {
  const g = await gate(false);
  return "error" in g ? [] : listSavedBlocks();
}

export async function saveBlocks(input: { name: string; blocks: unknown }): Promise<ActionResult<SavedBlock>> {
  const g = await gate(true);
  if ("error" in g) return { ok: false, error: g.error };
  const cleaned = cleanSavedBlocks(input?.blocks);
  if (!cleaned.ok) return cleaned;
  const saved = await storeSavedBlocks({ userId: g.userId, name: String(input?.name ?? ""), blocks: cleaned.blocks });
  if (!saved.ok) return saved;
  await recordAudit({ userId: g.userId, action: "UPDATE", entityType: "MarketingSavedBlock", entityId: saved.data.id, entityLabel: `Saved block “${saved.data.name}” (${saved.data.blocks.length} block${saved.data.blocks.length === 1 ? "" : "s"})` });
  return saved;
}

export async function deleteSavedBlock(id: string): Promise<ActionResult<null>> {
  const g = await gate(true);
  if ("error" in g) return { ok: false, error: g.error };
  const row = await db.marketingSavedBlock.findUnique({ where: { id: String(id ?? "") }, select: { id: true, name: true } }).catch(() => null);
  if (!row) return { ok: false, error: "That saved block is already gone." };
  await db.marketingSavedBlock.delete({ where: { id: row.id } });
  await recordAudit({ userId: g.userId, action: "DELETE", entityType: "MarketingSavedBlock", entityId: row.id, entityLabel: `Saved block “${row.name}” deleted` });
  return { ok: true, data: null };
}
