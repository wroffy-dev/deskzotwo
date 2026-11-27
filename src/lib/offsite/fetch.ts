import { randomUUID } from "node:crypto";
import { rm, stat } from "node:fs/promises";
import path from "node:path";
import type { BackupKind } from "@prisma/client";
import { parseManifest } from "@/lib/offsite/backups";
import { currentStore } from "@/lib/offsite/config";
import { fetchBackup, type OffsiteBackup } from "@/lib/offsite/drill";

/**
 * A backup whose copy on this server has gone because it is off-site (src/lib/offsite/backups.ts trimLocalCopies),
 * fetched back for the Backups screen's Download and Restore (src/app/api/backups/[id]/…).
 *
 * The same path a restore drill takes (src/lib/offsite/drill.ts fetchBackup): a chunked backup's manifest and every
 * piece downloaded as they are kept there — sealed — into a scratch folder, then reassembled and checked against the
 * checksum recorded when it was taken; a full one downloaded sealed and opened. What comes out is the plain dump the
 * route would otherwise have built from the copy here, at `out`, and the route's own clean-up removes it as it always
 * did. The scratch folder goes before this returns, whatever happens.
 */

export class OffsiteFetchFailed extends Error {
  constructor(message: string) {
    super(message);
    this.name = "OffsiteFetchFailed";
  }
}

/**
 * The backup in `row` as a plain dump at `out`, fetched from the store in use; null when there is no copy there to
 * fetch (no store, or not there) — the caller answers as it did before. Throws `OffsiteFetchFailed` with why when
 * there is one and it couldn't be brought back.
 */
export async function fetchFromOffsite(
  tenantId: string,
  row: { id: string; filename: string; kind: BackupKind },
  out: string,
  scratchParent: string,
): Promise<{ bytes: number } | null> {
  const found = await currentStore().catch(() => null);
  if (!found) return null;
  const prefix = `backups/workspaces/${tenantId}/`;
  const work = path.join(scratchParent, `.offsite-${randomUUID()}`);
  try {
    let backup: OffsiteBackup;
    if (row.kind === "INCREMENTAL") {
      const key = `${prefix}manifests/${row.id}.json`;
      if (!/^[A-Za-z0-9._-]+$/.test(row.id)) return null;
      const manifest = parseManifest(await found.store.get(key));
      if (!manifest) return null;
      backup = { kind: "manifest", key, manifest, takenAt: new Date(manifest.takenAt ?? 0) };
    } else {
      // Only a plain name, as the backup was written (security audit, 11 Nov 2026, SEC-59).
      if (!row.filename || row.filename !== path.basename(row.filename) || row.filename.startsWith(".") || !row.filename.endsWith(".dump")) return null;
      const key = `${prefix}dumps/${row.filename}`;
      const { objects } = await found.store.list(key);
      if (!objects.some((o) => o.key === key)) return null;
      backup = { kind: "dump", key, takenAt: new Date(0) };
    }
    await fetchBackup(found.store, tenantId, backup, work, out);
    return { bytes: (await stat(out)).size };
  } catch (err) {
    await rm(out, { force: true }).catch(() => {});
    throw new OffsiteFetchFailed(`This backup is kept off-site, and fetching it back failed: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => {});
  }
}
