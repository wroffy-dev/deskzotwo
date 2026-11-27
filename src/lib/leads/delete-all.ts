import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { runBackup } from "@/lib/backup/run";

/**
 * Deleting every lead, to import them again from a clean file (owner, 30 Oct 2026: "lets delete the all previous leads
 * and import fresh" — the old CRM's leads had come in twice and with phones Excel had shortened).
 *
 *   · **What goes** is what a single lead delete takes (src/actions/super-admin-delete.ts): each lead with its
 *     activities, tasks, requirements, proposals, notes and who it was with, which the database cascades. Quotations,
 *     calls, visits, expenses, bookings and form entries stay, no longer pointing at a lead. Companies and contacts
 *     stay — the fresh import finds them by name and email.
 *   · **A backup first**, kept 30 days: no backup, nothing deleted. Restoring it from Settings › Backups undoes this.
 *   · **In batches** the browser asks for one after another, so no single request outlives Cloudflare's 100 seconds.
 *     Each batch is one audit entry with its count; the lead numbers are not reused.
 */

export const BATCH = 500;

/** Typed, so a click on its own can't do it. */
export const CONFIRM_WORDS = "DELETE ALL LEADS";

export async function countLeads(): Promise<number> {
  return db.lead.count();
}

export async function backupBeforeDeletingLeads(actorId: string): Promise<{ ok: true; backupId: string } | { ok: false; error: string }> {
  const backup = await runBackup({
    kind: "FULL",
    triggeredById: actorId,
    reason: "Before deleting every lead",
    keepUntil: new Date(Date.now() + 30 * 86_400_000),
  });
  if (!backup.ok) return { ok: false, error: `The safety backup couldn't be taken, so nothing was deleted: ${backup.error ?? "unknown error"}` };
  await recordAudit({ userId: actorId, action: "CREATE", entityType: "Backup", entityId: backup.id, entityLabel: "Backup taken before deleting every lead" });
  return { ok: true, backupId: backup.id };
}

/**
 * Deletes up to `size` leads, oldest first; how many went and how many are left. `only` keeps to those leads — a check
 * suite's own fixture, so a run never touches the workspace's real ones.
 */
export async function deleteLeadBatch(actorId: string, size = BATCH, only?: string[]): Promise<{ deleted: number; left: number }> {
  const scope = only ? { id: { in: only } } : {};
  const ids = (await db.lead.findMany({ where: scope, select: { id: true }, orderBy: { leadSeq: "asc" }, take: size })).map((l) => l.id);
  let deleted = 0;
  if (ids.length) {
    deleted = (await db.lead.deleteMany({ where: { id: { in: ids } } })).count;
    await recordAudit({ userId: actorId, action: "DELETE", entityType: "Lead", entityId: "all-leads", entityLabel: `Deleted ${deleted} lead(s) — deleting every lead to import them again` });
  }
  return { deleted, left: only ? await db.lead.count({ where: scope }) : await countLeads() };
}
