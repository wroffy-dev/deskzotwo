import { parseEntitlements } from "@/lib/entitlements";
import { controlDb } from "@/lib/platform/control-db";
import { fileColumnCounts } from "@/lib/storage/maintenance";
import { activeTenants } from "@/lib/tenancy/registry";
import { runAsTenant } from "@/lib/tenancy/resolve";

/**
 * The storage box's summary for the console (owner, 24 Nov 2026: "whi pe dekh paye kitni files gai kitni pending h proper
 * summary ke sath"): for every open workspace, how many of its files are in the box and how many still in its own
 * database waiting to be moved (`npm run storage -- move`), with the storage it uses as last measured against its
 * plan's limit; and the totals. Read from each workspace's database — the counts only, never a file.
 */

export type StorageSummaryRow = {
  id: string;
  slug: string;
  name: string;
  inBox: number;
  pending: number;
  pendingBytes: number;
  /** As last measured (src/lib/storage/quota.ts) — the box and the database together. */
  usedBytes: number;
  limitMb: number | null;
  measuredAt: Date | null;
  /** By kind of file: in the box, and still in the database. */
  kinds: { model: string; inBox: number; pending: number; pendingBytes: number }[];
  /** The workspace's database couldn't be read. */
  error: string | null;
};

export type StorageSummary = {
  rows: StorageSummaryRow[];
  totals: { workspaces: number; inBox: number; pending: number; pendingBytes: number; usedBytes: number; unreadable: number };
};

export async function storageSummary(): Promise<StorageSummary> {
  const tenants = await activeTenants();
  const control = controlDb();
  const usage = new Map(
    (
      await control.tenant.findMany({
        where: { id: { in: tenants.map((t) => t.id) } },
        select: { id: true, storageUsedBytes: true, storageMeasuredAt: true, entitlements: true },
      })
    ).map((r) => [r.id, r]),
  );
  const rows: StorageSummaryRow[] = [];
  for (const tenant of tenants) {
    const u = usage.get(tenant.id);
    const limit = u ? parseEntitlements(u.entitlements).storageMb : undefined;
    const base = {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      usedBytes: Number(u?.storageUsedBytes ?? 0),
      limitMb: typeof limit === "number" ? limit : null,
      measuredAt: u?.storageMeasuredAt ?? null,
    };
    try {
      const counts = await runAsTenant(tenant, () => fileColumnCounts());
      const kinds = counts.filter((c) => c.inBox || c.inDatabase).map((c) => ({ model: c.model, inBox: c.inBox, pending: c.inDatabase, pendingBytes: c.databaseBytes }));
      rows.push({
        ...base,
        inBox: kinds.reduce((n, k) => n + k.inBox, 0),
        pending: kinds.reduce((n, k) => n + k.pending, 0),
        pendingBytes: kinds.reduce((n, k) => n + k.pendingBytes, 0),
        kinds,
        error: null,
      });
    } catch (err) {
      rows.push({ ...base, inBox: 0, pending: 0, pendingBytes: 0, kinds: [], error: err instanceof Error ? (err.message.split("\n").filter(Boolean).pop() ?? err.name) : String(err) });
    }
  }
  // What is still waiting first, then the biggest users.
  rows.sort((a, b) => b.pending - a.pending || b.usedBytes - a.usedBytes || a.slug.localeCompare(b.slug));
  return {
    rows,
    totals: {
      workspaces: rows.length,
      inBox: rows.reduce((n, r) => n + r.inBox, 0),
      pending: rows.reduce((n, r) => n + r.pending, 0),
      pendingBytes: rows.reduce((n, r) => n + r.pendingBytes, 0),
      usedBytes: rows.reduce((n, r) => n + r.usedBytes, 0),
      unreadable: rows.filter((r) => r.error).length,
    },
  };
}
