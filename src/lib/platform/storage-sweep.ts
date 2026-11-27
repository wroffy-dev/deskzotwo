import { forEachTenant } from "@/lib/platform/fanout";
import { storageBoxState } from "@/lib/storage/box";
import { sweepStoredFiles } from "@/lib/storage/maintenance";
import { recordWorkspaceStorage } from "@/lib/storage/quota";
import { controlConfigured } from "@/lib/platform/control-db";
import { activeTenants } from "@/lib/tenancy/registry";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * The storage box's nightly sweep (src/lib/storage/maintenance.ts `sweepStoredFiles`), from the platform tick's
 * daily chores: for every active workspace, as that workspace, the files in its part of the box that no row has
 * pointed at for longer than backups are kept are deleted. Rows never delete their files themselves — a workspace
 * restored from last month's backup points at files that must still be there — so this is how a deleted
 * document's file finally goes.
 *
 * And each workspace's storage is measured and written on its control-plane row (src/lib/storage/quota.ts), what its plan's
 * storage limit is checked against. Nothing at all without a box or a control plane. Each workspace on its own (src/lib/platform/fanout.ts): one that fails is named
 * in the result, and the others are swept all the same. `npm run storage -- sweep` does the same by hand.
 */

export type StorageSweep = { workspaces: number; checked: number; removed: number; kept: number; failed: string[]; measured?: number };

const SWEEP_TIMEOUT_MS = 30 * 60_000;

/** Null when the server has no storage box. Never throws: a failure is in `failed`. */
export async function sweepStorageBox(now: Date = new Date(), tenants?: Tenant[]): Promise<StorageSweep | null> {
  const state = (await storageBoxState());
  // Each workspace's storage is measured too (src/lib/storage/quota.ts) — its files in the box, and those still in its
  // database — wherever there is a control plane to write it on, box or none.
  const measuring = controlConfigured();
  if (!state.configured && !state.error && !measuring) return null;
  const result: StorageSweep = { workspaces: 0, checked: 0, removed: 0, kept: 0, failed: [], measured: 0 };
  if (state.error) {
    result.failed.push(`the storage box is set up wrongly: ${state.error}`);
    return result;
  }
  let list: Tenant[];
  try {
    list = tenants ?? (await activeTenants());
  } catch (err) {
    result.failed.push(err instanceof Error ? err.message : String(err));
    return result;
  }
  const outcomes = await forEachTenant(
    "storage-sweep",
    list,
    async () => {
      const swept = await sweepStoredFiles(now);
      // After the sweep, so what is measured is what is kept; a measurement that fails fails this workspace alone.
      const measured = measuring ? await recordWorkspaceStorage(now) : null;
      return { swept, measured: measured !== null };
    },
    { concurrency: 2, timeoutMs: SWEEP_TIMEOUT_MS },
  );
  for (const o of outcomes) {
    if ("skipped" in o) continue;
    if (!o.ok) {
      result.failed.push(`${o.slug}: ${o.error}`);
      continue;
    }
    result.workspaces += 1;
    if (o.value.measured) result.measured = (result.measured ?? 0) + 1;
    if (!o.value.swept) continue;
    result.checked += o.value.swept.checked;
    result.removed += o.value.swept.removed;
    result.kept += o.value.swept.kept;
  }
  if (result.removed || result.failed.length) {
    console.log(`[storage] nightly sweep: ${result.workspaces} workspace(s), ${result.removed} unreferenced file(s) removed, ${result.kept} kept for now${result.failed.length ? `, ${result.failed.length} failed` : ""}`);
  }
  return result;
}
