import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { currentTenant } from "@/lib/tenancy/resolve";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * A workspace's storage limit at the moment a file is saved (src/lib/storage/quota.ts says what is counted and how).
 * Kept apart from the measuring, which reads the file columns: src/lib/storage/files.ts calls these on every save, and
 * must not import what imports it.
 */

export const MB = 1024 * 1024;
/** From here on the workspace's administrators are warned (owner's choice, 20 Nov 2026: 80%). */
export const WARN_AT = 0.8;

export class StorageFull extends Error {
  constructor(
    readonly usedBytes: number,
    readonly limitBytes: number,
  ) {
    super(`Your workspace's storage is full (${gb(usedBytes)} of ${gb(limitBytes)} used), so this file can't be saved. An administrator can add storage in Settings › Billing.`);
    this.name = "StorageFull";
  }
}

/** "1.4 GB", "350 MB" — for messages and screens. */
export function gb(bytes: number): string {
  if (bytes >= 1024 * MB) return `${(bytes / (1024 * MB)).toFixed(bytes >= 100 * 1024 * MB ? 0 : 1)} GB`;
  const mb = Math.max(0, bytes / MB);
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

/** The limit in bytes from entitlements; null: none (no limit, or worked out before storage was in the plans). */
export function limitBytesOf(tenant: Pick<Tenant, "entitlements">): number | null {
  const mb = tenant.entitlements?.storageMb;
  return typeof mb === "number" ? mb * MB : null;
}

/**
 * Refuses a file of `bytes` that would take the current workspace past its limit (`StorageFull`). Every writer of a
 * workspace file calls this first — src/lib/storage/files.ts `keepDataUrl`/`keepBytes`, and the call recordings.
 */
export async function assertRoomFor(bytes: number): Promise<void> {
  if (!controlConfigured()) return;
  const tenant = await currentTenant();
  const limit = limitBytesOf(tenant);
  if (limit === null) return;
  const row = await controlDb().tenant.findUnique({ where: { id: tenant.id }, select: { storageUsedBytes: true } });
  const used = Number(row?.storageUsedBytes ?? 0);
  if (used + bytes > limit) throw new StorageFull(used, limit);
}

/** A file of `bytes` was just saved for the current workspace: added to what it uses. Never fails the save. */
export async function noteStored(bytes: number): Promise<void> {
  if (!controlConfigured() || bytes <= 0) return;
  try {
    const tenant = await currentTenant();
    await controlDb().tenant.update({ where: { id: tenant.id }, data: { storageUsedBytes: { increment: BigInt(Math.round(bytes)) } }, select: { id: true } });
  } catch (err) {
    console.warn(`[storage] couldn't count a saved file: ${err instanceof Error ? err.message.split("\n").pop() : String(err)}`);
  }
}

