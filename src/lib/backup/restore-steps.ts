import { afterRestore } from "@/lib/automate/restore";
import { alertHolders } from "@/lib/access/gate";
import { backupRoot } from "@/lib/backup/maintenance";
import { relistBackups } from "@/lib/backup/relist";
import { runRestore, stageForTool } from "@/lib/backup/restore-tool";
import type { DumpTool } from "@/lib/backup/run";
import { resyncDeviceRoutes } from "@/lib/platform/device-routes";
import { reindexCurrentWorkspace } from "@/lib/platform/email-index";
import { REFERENCE_TABLES } from "@/lib/reference-data";
import { seatsInUse } from "@/lib/seats";
import { currentTenant } from "@/lib/tenancy/resolve";

/**
 * The steps every restore of a workspace's database takes, whichever file it comes from — a workspace backup put back
 * by the Restore button (scripts/restore-worker.ts) or a Backup & Restore bundle (src/lib/bundle/restore.ts). Kept in
 * one place so the two can't drift: a fix to how a schema is cleared, or to what is put right after the data is back,
 * reaches both.
 *
 * Each takes the client it works through (anything with `$executeRawUnsafe`), so the caller decides whose connection
 * it is: the workspace's own `db` inside `runAsTenant`, or a direct client to a database that has no workspace yet.
 */

type RawClient = {
  $executeRawUnsafe(query: string, ...values: unknown[]): Promise<unknown>;
};
type Connection = {
  host: string;
  port: string;
  user: string;
  password: string;
  database: string;
};

/**
 * Every other connection to the database closed, then its schema dropped and made again — empty.
 *
 * The connections go first, and this is not politeness: `DROP SCHEMA public CASCADE` waits for a lock on every table
 * in it, and one pooled connection sitting idle inside a transaction is enough to make the drop hang. Ending them may
 * not be allowed (a role without the privilege); then the drop's own error is the one worth reporting.
 */
export async function clearSchema(client: RawClient): Promise<void> {
  try {
    await client.$executeRawUnsafe(`SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = current_database() AND pid <> pg_backend_pid()`);
  } catch {
    // Not fatal — see above.
  }
  await client.$executeRawUnsafe("DROP SCHEMA public CASCADE");
  await client.$executeRawUnsafe("CREATE SCHEMA public");
}

/** A dump file into a database with pg_restore, staged where the tool can seek in it and cleaned up after. */
export async function restoreDumpFile(tool: DumpTool, file: string, connection: Connection): Promise<void> {
  const staged = await stageForTool(tool, file);
  try {
    await runRestore(tool, staged.pathForTool, connection);
  } finally {
    await staged.cleanup();
  }
}

/**
 * A backup from before the shared reference database carries its own copy of the PIN directory and world places. The
 * shared copy (prisma/reference) is the one that counts, so this one is emptied — otherwise the migration that retires
 * these tables refuses to run. A newer backup has no such tables and nothing happens.
 */
export async function clearOwnReferenceCopy(client: RawClient): Promise<void> {
  await client.$executeRawUnsafe(
    `DO $$ DECLARE t text; BEGIN FOREACH t IN ARRAY ARRAY[${REFERENCE_TABLES.map((r) => `'${r.table}'`).join(", ")}] LOOP IF to_regclass(t) IS NOT NULL THEN EXECUTE format('TRUNCATE %I', t); END IF; END LOOP; END $$;`,
  );
}

/**
 * Every sign-in the backup carried ends (security audit, Nov 2026). The restored rows are as they were when the backup
 * was taken, so a session ended since then — signed out, revoked, its device blocked — would be open again, and its
 * cookie would work. Sessions begun since have no row and the gate ends them. So everybody signs in again.
 */
export async function endEverySignIn(client: RawClient): Promise<void> {
  await client.$executeRawUnsafe(`UPDATE "sign_ins" SET "endedAt" = now() WHERE "endedAt" IS NULL`);
}

/**
 * What lives beside a workspace's database, brought in line with what came back (owner, 22 Oct 2026) — run as the
 * workspace (inside `runAsTenant`): the backup list (the restored log is the old one, missing every backup taken
 * since, the safety copy too), the "Find my workspaces" index, the biometric terminals' routes, Automate's runs held
 * by a worker when the backup was taken, and the seat count. None is worth failing a finished restore over — the
 * nightly reconcile and the next registration put them right anyway — so each failure is said, and returned.
 */
export async function afterRestoreChores(log: (message: string) => void = (m) => console.warn(`[restore] ${m}`)): Promise<string[]> {
  const problems: string[] = [];
  const said = (what: string, err: unknown) => {
    const line = `${what}: ${err instanceof Error ? err.message : String(err)}`;
    problems.push(line);
    log(line);
  };
  try {
    await relistBackups(await backupRoot());
  } catch (err) {
    said("The backup list could not be rebuilt", err);
  }
  try {
    await reindexCurrentWorkspace();
  } catch (err) {
    said("The sign-in index could not be rebuilt", err);
  }
  try {
    const routes = await resyncDeviceRoutes();
    if (routes.elsewhere.length) log(`Terminals now registered to another workspace: ${routes.elsewhere.join(", ")}`);
  } catch (err) {
    said("The device routes could not be brought in line", err);
  }
  try {
    await afterRestore();
  } catch (err) {
    said("Automate's runs could not be let go", err);
  }
  // More people switched on than the plan has seats: a backup from before some were switched off brings them back
  // (security review, 23 Oct 2026). Nobody is switched off for it — whoever manages billing is told, and it is logged.
  try {
    const seats = (await currentTenant()).entitlements.seats;
    const used = await seatsInUse();
    if (seats !== null && used > seats) {
      log(`${used} people switched on for ${seats} seats`);
      await alertHolders("billing.manage", {
        title: "More people are switched on than your plan has seats",
        message: `The restore brought back ${used} people switched on; your plan includes ${seats}. Switch some off, or add seats in Settings › Plan & billing.`,
        link: "/settings/users",
      });
    }
  } catch (err) {
    said("The seats could not be checked", err);
  }
  return problems;
}
