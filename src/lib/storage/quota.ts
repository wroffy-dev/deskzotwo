import { consoleClock } from "@/lib/platform/console-clock";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { usageDay } from "@/lib/copilot/settings";
import { storageBox, workspaceBox } from "@/lib/storage/box";
import { fileColumnCounts, referencedKeys } from "@/lib/storage/maintenance";
import { FILE_COLUMNS } from "@/lib/storage/registry";
import { limitBytesOf } from "@/lib/storage/allowance";
import { currentTenant } from "@/lib/tenancy/resolve";
import type { Tenant } from "@/lib/tenancy/state";

export { MB, WARN_AT, StorageFull, gb, limitBytesOf, assertRoomFor, noteStored } from "@/lib/storage/allowance";

/**
 * Storage in the plans (owner, 20 Nov 2026): "base plan mein 2 GB storage hai, bharne ke baad upgrade kr skte hai same
 * plan mein rhekr" — and "per workspace hai ye per seat nhi". A workspace's limit is its entitlements' `storageMb` (the
 * edition's, with Extra storage packs on top, or a staff override — src/lib/platform/entitlements.ts `storageFrom`).
 *
 * What it uses is kept on its control-plane row (`Tenant.storageUsedBytes`): measured each night — its files and call
 * recordings in the storage box, and the files still kept in its database — and added to as each file is saved in
 * between, so a day's uploads can't run past the limit unseen.
 *
 * At the limit a new file is refused (`StorageFull`), with a message saying so; nothing already saved is touched, and
 * reading never stops. Backups, logs and support files are the platform's, never counted against a workspace.
 *
 * No control plane (one installation from the environment) or no limit: nothing is counted against anything.
 */

export type StorageStatus = {
  usedBytes: number;
  limitBytes: number | null;
  /** used ÷ limit, null without a limit. */
  share: number | null;
  measuredAt: Date | null;
  /** By kind of file, as last measured: "archived-documents", "user-photos", "recordings", … */
  breakdown: Record<string, number>;
};

/** A workspace's storage as the control plane has it. Null without a control plane. */
export async function storageStatus(tenant: Pick<Tenant, "id" | "entitlements">): Promise<StorageStatus | null> {
  if (!controlConfigured()) return null;
  const row = await controlDb().tenant.findUnique({ where: { id: tenant.id }, select: { storageUsedBytes: true, storageMeasuredAt: true, storageBreakdown: true } });
  if (!row) return null;
  const usedBytes = Number(row.storageUsedBytes);
  const limitBytes = limitBytesOf(tenant);
  const raw = row.storageBreakdown && typeof row.storageBreakdown === "object" && !Array.isArray(row.storageBreakdown) ? (row.storageBreakdown as Record<string, unknown>) : {};
  const breakdown = Object.fromEntries(Object.entries(raw).filter((e): e is [string, number] => typeof e[1] === "number"));
  return { usedBytes, limitBytes, share: limitBytes === null ? null : limitBytes === 0 ? 1 : usedBytes / limitBytes, measuredAt: row.storageMeasuredAt, breakdown };
}

export type StorageMeasure = { usedBytes: number; breakdown: Record<string, number> };

/**
 * What the current workspace's files take now: the files its rows point at in its part of the box (by kind), its call
 * recordings there, and the files still kept in its database, by the kind each column's files go to.
 */
export async function measureWorkspaceStorage(): Promise<StorageMeasure> {
  const tenant = await currentTenant();
  const breakdown: Record<string, number> = {};
  const add = (kind: string, bytes: number) => {
    if (bytes > 0) breakdown[kind] = (breakdown[kind] ?? 0) + bytes;
  };
  const box = (await storageBox());
  if (box) {
    // Only files a row points at: a deleted document's file waits weeks for the sweep (backups may still need it), and
    // the space it took is the customer's again at once.
    const [{ objects }, referenced] = await Promise.all([workspaceBox(box, tenant.id, "files").list(""), referencedKeys()]);
    for (const o of objects) if (referenced.has(o.key)) add(o.key.split("/")[0] || "other", o.size);
    const recordings = await workspaceBox(box, tenant.id, "recordings").list("");
    for (const o of recordings.objects) add("recordings", o.size);
  }
  const kindOf = new Map(FILE_COLUMNS.map((c) => [`${c.model}.${c.column}`, c.kind]));
  for (const c of await fileColumnCounts()) add(kindOf.get(`${c.model}.${c.column}`) ?? "other", c.databaseBytes);
  return { usedBytes: Object.values(breakdown).reduce((n, b) => n + b, 0), breakdown };
}

/**
 * The current workspace measured and written down: its control-plane row (what the limit is checked against, and the
 * console shows) and tonight's usage snapshot, when the day's snapshot is there already. Null without a control plane.
 */
export async function recordWorkspaceStorage(now: Date = new Date()): Promise<StorageMeasure | null> {
  if (!controlConfigured()) return null;
  const tenant = await currentTenant();
  const measured = await measureWorkspaceStorage();
  const control = controlDb();
  await control.tenant.update({
    where: { id: tenant.id },
    data: { storageUsedBytes: BigInt(measured.usedBytes), storageMeasuredAt: now, storageBreakdown: measured.breakdown },
    select: { id: true },
  });
  const day = usageDay(now, await consoleClock());
  const limit = tenant.entitlements?.storageMb;
  await control.tenantUsage.updateMany({
    where: { tenantId: tenant.id, day },
    data: { storageBytes: BigInt(measured.usedBytes), storageLimitMb: typeof limit === "number" ? limit : null },
  });
  return measured;
}
