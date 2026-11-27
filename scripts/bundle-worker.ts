/**
 * Makes or checks one Backup & Restore bundle for the console, in a process that outlives the request which asked:
 *
 *   tsx scripts/bundle-worker.ts build <backup id>
 *   tsx scripts/bundle-worker.ts verify <backup id>
 *
 * Not meant to be run by hand — `npm run bundle` is the command for that. The console's Backups page spawns this,
 * detached (src/lib/bundle/jobs.ts `startWorker`), the way the workspace restore spawns its worker.
 *
 * Its arguments are the job and the row's id, nothing else. The passphrase is not on its command line and not in its
 * environment: it is in a file the console sealed under the platform key for this row and this job, which this reads
 * and deletes before doing anything else (`runBundleJob`). Everything it has to say goes on the PlatformBackup row —
 * progress as it goes, then READY or FAILED with the reason, or the check's answer.
 */
import "dotenv/config";
import { runBundleJob, type BundleJob } from "../src/lib/bundle/jobs";
import { closeControlDb } from "../src/lib/platform/control-db";

async function main() {
  const [job, id] = process.argv.slice(2);
  if ((job !== "build" && job !== "verify") || !id || !/^[A-Za-z0-9_-]{8,64}$/.test(id)) {
    console.error("usage: tsx scripts/bundle-worker.ts (build | verify) <backup id>");
    process.exitCode = 2;
    return;
  }
  await runBundleJob(job as BundleJob, id);
}

main()
  .catch((err) => {
    // The reason is on the row already; this is for whoever runs it by hand. Never the passphrase: no error carries it.
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  })
  .finally(() => closeControlDb());
