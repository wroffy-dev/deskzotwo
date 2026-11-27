/**
 * check:restore-roundtrip — a backup really put back (owner, 18 Nov 2026: "check the backup and restore feature again -
 * test it properly"). The other backup checks prove the parts — retention, the chunk store, encryption at rest, the
 * off-site copy. This one takes a whole workspace's database, changes it, and puts it back with the real tools, the way
 * a bad day would:
 *
 *   · a scratch workspace made as provisioning makes one — its own database and role, migrated, its own keys, in the
 *     control plane — with a few records and a value encrypted under its keys;
 *   · `npm run db:backup -- --workspace` from the command line, and a full and a pieces (INCREMENTAL) backup in-process;
 *   · `npm run db:restore`: refused without the confirmation, then the full backup put back — the records as they were,
 *     the encrypted value readable, the schema at this version;
 *   · the Restore button's worker (scripts/restore-worker.ts, spawned as the route spawns it) from the pieces backup:
 *     done, the records back, a safety copy taken first and kept 30 days, the lock released;
 *   · a restore that fails after the database is cleared: put back from the safety copy by itself — nothing lost;
 *   · a staged file that isn't a backup: refused before anything is touched;
 *   · a backup taken under other keys — a new server after a disaster: put back without its keys, the data is there and
 *     its secrets unreadable (why the keys travel with an archive); with them staged, as the route stages an archive's,
 *     the worker installs them and the secrets read again;
 *   · files in the storage box (src/lib/storage): a database backup holds only a reference to each, so a record deleted
 *     and then restored must point at a file the box still has — deleting a record never deletes its file.
 *
 * Nothing here touches any workspace but the scratch one, which is dropped, with its backups and its control-plane row,
 * in a finally.
 *
 *   npm run check:restore-roundtrip
 */
import "dotenv/config";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { copyFile, open, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

const TSX = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
/** A script run as a person would run it, in its own process; its output for the report. */
function runScript(script: string, args: string[], env: Record<string, string> = {}) {
  const r = spawnSync(process.execPath, [TSX, script, ...args], { cwd: process.cwd(), env: { ...process.env, ...env }, encoding: "utf8", timeout: 15 * 60_000 });
  return { code: r.status ?? -1, out: `${r.stdout ?? ""}${r.stderr ?? ""}` };
}

async function main() {
  const provisioner = await import("../src/lib/platform/provisioner");
  const { migrateDeploy, latestMigrationName } = await import("../src/lib/platform/migrate");
  const { sealKeyBundle, newKeyBundle } = await import("../src/lib/tenancy/keys");
  const { sealForTenant } = await import("../src/lib/platform/kek");
  const { controlDb } = await import("../src/lib/platform/control-db");
  const { tenantBySlug, forgetRegistry } = await import("../src/lib/tenancy/registry");
  const { runAsTenant } = await import("../src/lib/tenancy/resolve");
  const { db } = await import("../src/lib/db");
  const { encryptSecret, decryptSecret } = await import("../src/lib/crypto");
  const { runBackup } = await import("../src/lib/backup/run");
  const { backupRoot, readRestoreStatus, restoreInProgress, stagingPath, takeLock, writeRestoreStatus, writeStagedMeta, clearStaged, restoreDir } = await import(
    "../src/lib/backup/maintenance"
  );
  const { openBackupFileTo } = await import("../src/lib/backup/at-rest");
  const { readManifest, reassemble } = await import("../src/lib/backup/chunks");
  const { keepDataUrl, storedFile } = await import("../src/lib/storage/files");

  const control = controlDb();
  const firstKeys = newKeyBundle();
  const slug = `zz-restore-${Date.now().toString(36)}`;
  const tenantId = randomUUID();
  let made: { dbName: string; dbRole: string; url: string } | null = null;
  let folder: string | null = null;
  const boxDir = path.join(os.tmpdir(), `zz-restore-box-${Date.now()}`);
  try {
    section("A scratch workspace, made as provisioning makes one");
    made = await provisioner.createWorkspaceDatabase();
    await migrateDeploy(made.url);
    await control.tenant.create({
      data: {
        id: tenantId,
        slug,
        name: "ZZ Restore Drill",
        status: "ACTIVE",
        keyBundleCipher: sealKeyBundle(tenantId, firstKeys),
        dbName: made.dbName,
        dbRole: made.dbRole,
        dbUrlCipher: sealForTenant(tenantId, "db-url", made.url),
        schemaVersion: latestMigrationName(),
      },
    });
    const loaded = await tenantBySlug(slug);
    if (!loaded) throw new Error("the scratch workspace isn't in the registry");
    ok("its own database, migrated, with its own keys, in the control plane", loaded.id === tenantId);
    // Read again whenever its keys change: the keys come with the workspace's record.
    let tenant = loaded;
    const reload = async () => {
      forgetRegistry();
      const again = await tenantBySlug(slug);
      if (!again) throw new Error("the scratch workspace went missing");
      tenant = again;
    };
    const inIt = <T>(work: () => Promise<T>) => runAsTenant(tenant, work);
    folder = await inIt(() => backupRoot());

    /** What the workspace holds that a restore must bring back exactly. */
    const snapshot = () =>
      inIt(async () => {
        const companies = (await db.company.findMany({ select: { name: true }, orderBy: { name: "asc" } })).map((c) => c.name);
        const people = (await db.user.findMany({ select: { name: true }, orderBy: { name: "asc" } })).map((u) => u.name);
        const sealed = companies.find((n) => n.startsWith("ZZSEALED:"));
        const secret = sealed ? await decryptSecret(sealed.slice("ZZSEALED:".length)).catch(() => "unreadable") : null;
        const migrations = await db.$queryRawUnsafe<{ n: string }[]>(`SELECT migration_name AS n FROM _prisma_migrations WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 1`);
        return { companies: companies.filter((n) => !n.startsWith("ZZSEALED:")), people, secret, migration: migrations[0]?.n ?? null };
      });
    const company = (name: string, by: string) => inIt(() => db.company.create({ data: { name, normalizedName: name.toLowerCase(), createdById: by, ownerUserId: by, relationshipType: "CLIENT" } as never }));

    const owner = await inIt(() => db.user.create({ data: { email: `owner@${slug}.invalid`, name: "Asha Owner", role: "ADMIN", passwordHash: "!" } as never, select: { id: true } }));
    await company("Alpha Traders", owner.id);
    await company("Bravo Foods", owner.id);
    const cipher = await inIt(() => encryptSecret("vault-password-123"));
    await company(`ZZSEALED:${cipher}`, owner.id);
    const stateA = await snapshot();
    ok("its records, and a value encrypted under its keys", stateA.companies.join() === "Alpha Traders,Bravo Foods" && stateA.secret === "vault-password-123", stateA);

    section("Backups");
    const cli = runScript("scripts/backup.ts", ["--workspace", slug]);
    ok("npm run db:backup -- --workspace: exits 0", cli.code === 0, cli.out.slice(-600));
    const full = await inIt(() => runBackup({ kind: "FULL" }));
    ok("a full backup", full.ok, full);
    const pieces = await inIt(() => runBackup({ kind: "INCREMENTAL" }));
    ok("a pieces backup (INCREMENTAL)", pieces.ok, pieces);
    const rows = await inIt(() => db.backup.findMany({ orderBy: { startedAt: "asc" }, select: { id: true, kind: true, status: true, filename: true } }));
    ok("three in its backup list, all succeeded", rows.length === 3 && rows.every((r) => r.status === "SUCCEEDED"), rows);
    if (!full.ok || !pieces.ok) throw new Error("no backups to restore from");
    const fullPath = path.join(folder!, full.filename);
    const fileHead = async (file: string) => {
      const h = await open(file, "r");
      try {
        const b = Buffer.alloc(8);
        await h.read(b, 0, 8, 0);
        return b.toString("latin1");
      } finally {
        await h.close();
      }
    };
    ok("the full backup is encrypted at rest on disk — not a readable dump", (await fileHead(fullPath)) !== "PGDMP\u0001\u000e\u0000".slice(0, 8) && !(await fileHead(fullPath)).startsWith("PGDMP"), await fileHead(fullPath));

    section("npm run db:restore");
    await company("Charlie After Backup", owner.id);
    await inIt(() => db.company.deleteMany({ where: { name: "Alpha Traders" } }));
    const stateB = await snapshot();
    ok("changed after the backup: Alpha gone, Charlie added", stateB.companies.join() === "Bravo Foods,Charlie After Backup", stateB.companies);
    const refused = runScript("scripts/restore.ts", [fullPath, "--workspace", slug]);
    ok("without the confirmation: refused", refused.code !== 0 && /i-understand-this-replaces-everything/.test(refused.out), refused.out.slice(-400));
    ok("  and nothing changed", (await snapshot()).companies.join() === stateB.companies.join());
    const restored = runScript("scripts/restore.ts", [fullPath, "--workspace", slug, "--i-understand-this-replaces-everything"]);
    ok("with it: exits 0", restored.code === 0, restored.out.slice(-800));
    const afterCli = await snapshot();
    ok("  the records as they were at the backup — Alpha back, Charlie gone", afterCli.companies.join() === stateA.companies.join() && afterCli.people.join() === stateA.people.join(), afterCli);
    ok("  the encrypted value readable under the workspace's keys", afterCli.secret === "vault-password-123", afterCli.secret);
    ok("  the schema at this version", afterCli.migration === latestMigrationName(), { got: afterCli.migration, want: latestMigrationName() });

    /** Stages a dump as the Restore button's route does, then runs the worker as it spawns it; the final status. */
    const viaWorker = async (stage: (dumpPath: string) => Promise<void>, archiveName: string, keys?: string) => {
      const id = randomUUID().replace(/-/g, "").slice(0, 24);
      await inIt(async () => {
        const dumpPath = await stagingPath(id, ".dump");
        await stage(dumpPath);
        if (keys) await writeFile(await stagingPath(id, ".keys"), keys, { mode: 0o600 });
        await writeStagedMeta(id, { takenAt: new Date().toISOString(), schemaVersion: latestMigrationName(), secretFingerprint: null, source: archiveName });
        const startedAt = new Date();
        await takeLock(id, startedAt);
        await writeRestoreStatus({ id, phase: "staged", message: "Starting…", startedAt: startedAt.toISOString(), finishedAt: null, archiveName, takenAt: null, secretHandoffPath: null, keysFromBackup: false, requestedById: owner.id, error: null });
      });
      const run = runScript("scripts/restore-worker.ts", [id], { DESKZO_TENANT_ID: tenantId });
      const status = await inIt(() => readRestoreStatus());
      const locked = await inIt(() => restoreInProgress());
      await inIt(() => clearStaged(id)).catch(() => {});
      return { status, locked, out: run.out, code: run.code };
    };

    section("The Restore button's worker, from the pieces backup");
    await company("Delta After Restore", owner.id);
    await inIt(() => db.company.deleteMany({ where: { name: "Bravo Foods" } }));
    const stateC = await snapshot();
    const before = await inIt(() => db.backup.count());
    const fromPieces = await viaWorker(async (dumpPath) => {
      const manifest = await readManifest(folder!, pieces.id);
      if (!manifest) throw new Error("no manifest for the pieces backup");
      await reassemble(folder!, manifest, dumpPath, tenantId);
    }, pieces.filename);
    ok("done", fromPieces.status?.phase === "done" && fromPieces.code === 0, { status: fromPieces.status, out: fromPieces.out.slice(-600) });
    const afterWorker = await snapshot();
    ok("  the records as they were at the pieces backup", afterWorker.companies.join() === stateA.companies.join(), { was: stateC.companies, now: afterWorker.companies });
    ok("  the encrypted value readable", afterWorker.secret === "vault-password-123");
    ok("  the schema at this version", afterWorker.migration === latestMigrationName(), afterWorker.migration);
    const safety = fromPieces.status?.safetyCopy ?? null;
    const safetyRow = safety ? await inIt(() => db.backup.findFirst({ where: { filename: safety }, select: { reason: true, keepUntil: true, status: true } })) : null;
    ok("  a safety copy was taken first, kept about 30 days, and is in the backup list", !!safetyRow && /Before restoring/.test(safetyRow.reason ?? "") && !!safetyRow.keepUntil && safetyRow.keepUntil.getTime() > Date.now() + 29 * 86_400_000, safetyRow);
    ok("  the backup list was rebuilt with every backup and the safety copy", (await inIt(() => db.backup.count())) >= before + 1, { before, after: await inIt(() => db.backup.count()) });
    ok("  the lock is released — the workspace is out of maintenance", !fromPieces.locked);

    section("A restore that fails after the database is cleared");
    await company("Echo Before Failed Restore", owner.id);
    const stateD = await snapshot();
    const broken = await viaWorker(async (dumpPath) => {
      // A real dump cut short: it passes the header check, then pg_restore fails half way through.
      const plain = path.join(await inIt(() => restoreDir()), `zz-plain-${Date.now()}.dump`);
      await openBackupFileTo(tenantId, fullPath, plain);
      const size = (await stat(plain)).size;
      const h = await open(plain, "r");
      const part = Buffer.alloc(Math.min(size, Math.max(4096, Math.floor(size / 3))));
      try {
        await h.read(part, 0, part.length, 0);
      } finally {
        await h.close();
      }
      await writeFile(dumpPath, part);
      await rm(plain, { force: true });
    }, "a cut-short backup");
    ok("failed, and said so", broken.status?.phase === "failed", broken.status);
    ok("  put back from the safety copy by itself", broken.status?.rolledBack === true, broken.status?.error);
    const afterFail = await snapshot();
    ok("  nothing lost — the records as they were just before", afterFail.companies.join() === stateD.companies.join() && afterFail.secret === "vault-password-123", { want: stateD.companies, got: afterFail.companies });
    ok("  the lock is released", !broken.locked);

    section("A staged file that isn't a backup");
    const beforeBad = await inIt(() => db.backup.count());
    const notADump = await viaWorker(async (dumpPath) => {
      await writeFile(dumpPath, "id,name\n1,not a database\n");
    }, "a spreadsheet");
    ok("refused before anything is touched", notADump.status?.phase === "failed" && /Nothing has been changed/.test(notADump.status?.error ?? ""), notADump.status);
    ok("  no safety copy was needed — nothing was taken", (await inIt(() => db.backup.count())) === beforeBad);
    ok("  the records untouched", (await snapshot()).companies.join() === stateD.companies.join());
    ok("  the lock is released", !notADump.locked);

    section("A backup taken under other keys — a new server after a disaster");
    const underFirst = await inIt(() => runBackup({ kind: "FULL" }));
    ok("a backup under the workspace's first keys", underFirst.ok, underFirst);
    if (!underFirst.ok) throw new Error("no backup under the first keys");
    const otherKeys = newKeyBundle();
    await control.tenant.update({ where: { id: tenantId }, data: { keyBundleCipher: sealKeyBundle(tenantId, otherKeys) } });
    await reload();
    ok("the workspace now runs under other keys: its secret no longer opens", (await snapshot()).secret === "unreadable");
    const stageFirst = async (dumpPath: string) => openBackupFileTo(tenantId, path.join(folder!, underFirst.filename), dumpPath);
    const withoutKeys = await viaWorker(stageFirst, underFirst.filename);
    await reload();
    const afterWithout = await snapshot();
    ok("put back without the backup's keys: the records are there", withoutKeys.status?.phase === "done" && afterWithout.companies.join() === stateD.companies.join(), withoutKeys.status);
    ok("  but its secrets don't open — why an archive carries its keys", afterWithout.secret === "unreadable" && withoutKeys.status?.keysFromBackup === false, afterWithout.secret);
    // The keys as the restore route stages an archive's: the backup's, with this workspace's own session secret.
    const staged = sealKeyBundle(tenantId, { ...firstKeys, session: otherKeys.session });
    const withKeys = await viaWorker(stageFirst, underFirst.filename, staged);
    await reload();
    const afterWith = await snapshot();
    ok("put back with them staged: done, and the backup's keys installed", withKeys.status?.phase === "done" && withKeys.status?.keysFromBackup === true, withKeys.status);
    ok("  its secrets open again", afterWith.secret === "vault-password-123", afterWith.secret);
    const audit = await control.platformAuditLog.findFirst({ where: { tenantId, action: "tenant.keys.from-backup" }, select: { id: true } });
    ok("  and the key change is in the platform's audit log", !!audit);

    section("Files in the storage box — what a database backup points at");
    // A folder box for this run (STORAGE_DIR): the same code as the Azure container, read on every use.
    process.env.STORAGE_DIR = boxDir;
    const letter = "Offer letter, signed — sample";
    const ref = await inIt(() => keepDataUrl("documents", `data:text/plain;base64,${Buffer.from(letter).toString("base64")}`));
    ok("a file goes to the box; its record keeps only a reference", ref.startsWith("dzblob:"), ref.slice(0, 20));
    await company(`ZZFILE:${ref}`, owner.id);
    const withFile = await inIt(() => runBackup({ kind: "FULL" }));
    ok("a backup with the record in it", withFile.ok, withFile);
    if (!withFile.ok) throw new Error("no backup with the file's record");
    await inIt(() => db.company.deleteMany({ where: { name: { startsWith: "ZZFILE:" } } }));
    ok("the record deleted", (await inIt(() => db.company.count({ where: { name: { startsWith: "ZZFILE:" } } }))) === 0);
    const fileBack = await viaWorker(async (dumpPath) => openBackupFileTo(tenantId, path.join(folder!, withFile.filename), dumpPath), withFile.filename);
    await reload();
    const row = await inIt(() => db.company.findFirst({ where: { name: { startsWith: "ZZFILE:" } }, select: { name: true } }));
    const file = row ? await inIt(() => storedFile(row.name.slice("ZZFILE:".length))).catch((e: Error) => e) : null;
    ok("restored: the record is back, pointing at the file", fileBack.status?.phase === "done" && !!row, fileBack.status);
    ok("  and the box still has the file — deleting the record never deleted it", !(file instanceof Error) && file?.bytes.toString("utf8") === letter, file instanceof Error ? file.message : file?.bytes.toString("utf8"));
    void copyFile;
  } finally {
    await db.$disconnect().catch(() => {});
    delete process.env.STORAGE_DIR;
    await rm(boxDir, { recursive: true, force: true }).catch(() => {});
    if (folder) await rm(folder, { recursive: true, force: true }).catch(() => {});
    await control.platformAuditLog.deleteMany({ where: { tenantId } }).catch(() => {});
    await control.tenant.deleteMany({ where: { id: tenantId } }).catch(() => {});
    if (made) await provisioner.dropWorkspaceDatabase(made.dbName, made.dbRole).catch((e: Error) => console.log(`(could not drop ${made?.dbName}: ${e.message})`));
    const left = folder ? await readdir(folder).catch(() => null) : null;
    ok("the scratch workspace is gone — its database, its backups and its control-plane row", left === null && (await control.tenant.count({ where: { id: tenantId } })) === 0);
  }
}

main()
  .then(() => {
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
