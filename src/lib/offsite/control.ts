import { mkdir, readdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import { backupBase } from "@/lib/backup/maintenance";
import { parseDatabaseUrl, prunable } from "@/lib/backup/policy";
import { dump, resolveDumpTool } from "@/lib/backup/run";
import { localBackupKeep } from "@/lib/offsite/backups";
import { OFFSITE_KEEP_MINIMUM, type OffsiteSetup } from "@/lib/offsite/config";
import { KeptByStore, type OffsiteStore } from "@/lib/offsite/store";

/**
 * The control plane's nightly dump (docs/runbook.md §4: "a nightly pg_dump kept off the server").
 *
 * It holds every workspace's sealed database address and key bundle, so without it no workspace backup
 * can be put back on another server — the one thing that must survive losing this one. Dumped with
 * pg_dump like a workspace, sealed as it is written under a key of its own ("platform-control", from
 * PLATFORM_MASTER_KEY), kept a week here and as long as the backups off-site:
 *
 *   BACKUP_DIR/platform/control/deskzo-control-YYYY-MM-DD-HHMMSS.dump   the newest 7 (the time in UTC); with a store
 *                                                                        in use, only the newest BACKUP_LOCAL_KEEP (1)
 *                                                                        and any not yet there
 *   backups/control/deskzo-control-YYYY-MM-DD-HHMMSS.dump                offsite.backupKeepDays, 3 at least
 *
 * Restored with `npm run offsite -- fetch backups/control/<file> <out>` and pg_restore
 * (docs/runbook.md §5.3).
 */

export const CONTROL_SEAL = "platform-control";
const KEEP_HERE = 7;

export const controlDumpDir = () => path.join(backupBase(), "platform", "control");

const STAMP = /deskzo-control-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})\.dump$/;

export function controlDumpTakenAt(name: string): Date | null {
  const m = STAMP.exec(name);
  return m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +m[6])) : null;
}

export type ControlDump = { filename: string; sizeBytes: number; sent: boolean; prunedHere: number; prunedThere: number; kept: number };

export async function dumpControlPlane(store: OffsiteStore | null, setup: OffsiteSetup | null, now = new Date()): Promise<ControlDump> {
  const url = process.env.CONTROL_DATABASE_URL?.trim();
  const connection = url ? parseDatabaseUrl(url) : null;
  if (!connection) throw new Error("CONTROL_DATABASE_URL is not set to a Postgres address.");
  const tool = await resolveDumpTool("pg_dump");
  if (!tool) throw new Error("pg_dump could not be found — not on the PATH, not at PG_DUMP_PATH, and not in the database container.");

  const dir = controlDumpDir();
  await mkdir(dir, { recursive: true });
  // In UTC, whatever the server's own zone: the name is how it is pruned.
  const iso = now.toISOString();
  const filename = `deskzo-control-${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, "")}.dump`;
  const file = path.join(dir, filename);
  try {
    await dump(tool, connection, file, 6, CONTROL_SEAL);
    const { size } = await stat(file);
    if (size < 1024) throw new Error(`The dump is only ${size} bytes, which cannot be the whole control plane.`);
  } catch (err) {
    await rm(file, { force: true }).catch(() => {});
    throw err;
  }
  const { size } = await stat(file);

  let sent = false;
  if (store) {
    await store.putFile(`backups/control/${filename}`, file);
    sent = true;
  }

  // What the store holds now — asked after this dump went, so it is among them.
  const offsite = store ? (await store.list("backups/control/")).objects : [];
  const there = new Set(offsite.map((o) => o.key));

  // Here: the newest week — or, with a store in use, the newest BACKUP_LOCAL_KEEP (owner, 13 Nov 2026: off the VM),
  // an older one going only once the store has it; one that never went (taken before there was a store) stays its week.
  const here = (await readdir(dir)).filter((f) => STAMP.test(f)).sort().reverse();
  const keepHere = store ? Math.min(KEEP_HERE, localBackupKeep()) : KEEP_HERE;
  let prunedHere = 0;
  for (const [i, old] of here.entries()) {
    if (i < keepHere) continue;
    if (i < KEEP_HERE && !there.has(`backups/control/${old}`)) continue;
    await rm(path.join(dir, old), { force: true });
    prunedHere += 1;
  }

  // There: by age, keeping three.
  let prunedThere = 0;
  let kept = 0;
  if (store && setup) {
    const objects = offsite;
    const items = objects.flatMap((o) => {
      const takenAt = controlDumpTakenAt(o.key);
      return takenAt ? [{ filename: o.key, takenAt, keep: false }] : [];
    });
    for (const doomed of prunable(items, now, { keepDays: setup.backupKeepDays, keepMinimum: OFFSITE_KEEP_MINIMUM })) {
      try {
        await store.remove(doomed.filename);
        prunedThere += 1;
      } catch (err) {
        if (!(err instanceof KeptByStore)) throw err;
        kept += 1;
      }
    }
  }
  return { filename, sizeBytes: size, sent, prunedHere, prunedThere, kept };
}
