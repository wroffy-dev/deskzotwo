/**
 * Restores one Backup & Restore bundle for the console, in a process that outlives the request which asked:
 *
 *   tsx scripts/restore-bundle-worker.ts <restore run id>
 *
 * Not meant to be run by hand — `npm run bundle -- restore` is the command for that. The console's Backups page spawns
 * this, detached (src/lib/bundle/jobs.ts `startWorker`), the way it spawns the bundle worker.
 *
 * Its only argument is the RestoreRun's id. The passphrase is not on its command line and not in its environment: it
 * is in a file the console sealed under the platform key for this run, which this reads and deletes before doing
 * anything else (src/lib/bundle/restore.ts `runRestoreJob`). Everything it has to say goes on the RestoreRun row — or,
 * for a full restore, which replaces the control plane, into BACKUP_DIR/platform/restores/<id>.json first and the
 * restored control plane's RestoreRun at the end.
 */
import "dotenv/config";
import { runRestoreJob } from "../src/lib/bundle/restore";
import { closeControlDb } from "../src/lib/platform/control-db";
import { installLogLabels } from "../src/lib/tenancy/log-labels";

installLogLabels();

async function main() {
  const [id] = process.argv.slice(2);
  if (!id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    console.error("usage: tsx scripts/restore-bundle-worker.ts <restore run id>");
    process.exitCode = 2;
    return;
  }
  const outcome = await runRestoreJob(id);
  if (outcome.status !== "SUCCEEDED") process.exitCode = 1;
}

main()
  .catch((err) => {
    // Whatever was known is on the run already; this is for whoever reads the process's output. Never the passphrase.
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeControlDb();
    // Workspace clients, timers: a restore that is finished has nothing left worth waiting for.
    setTimeout(() => process.exit(), 1000).unref();
  });
