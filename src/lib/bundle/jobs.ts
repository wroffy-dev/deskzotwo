import { spawn } from "node:child_process";
import { mkdir, readFile, readdir, rm, stat, statfs, writeFile } from "node:fs/promises";
import path from "node:path";
import { passphraseProblem } from "@/lib/backup/archive-format";
import { bundleDir, buildFullBundle, buildWorkspaceBundle } from "@/lib/bundle/build";
import { BUNDLE_EXTENSION, verifyBundle } from "@/lib/bundle/format";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { openForPlatform, sealForPlatform } from "@/lib/platform/kek";
import { directClient } from "@/lib/tenancy/direct-client";
import { tenantById, tenantsForBackup } from "@/lib/tenancy/registry";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * The console's Backup & Restore work that runs outside a request (owner, 26 Nov 2026 — the page is
 * src/app/platform-console/(console)/backups, the format src/lib/bundle/format.ts, the builder build.ts):
 *
 *   build    a bundle of the whole installation or one workspace, into BACKUP_DIR/platform/bundles/
 *   verify   one READY bundle read through with its passphrase, the answer written on its row
 *
 * Each is a detached worker (scripts/bundle-worker.ts), spawned the way the workspace restore's is — Node running
 * tsx's entry point, no shell, `detached` and `unref`ed, output ignored — because a full bundle of gigabytes takes
 * far longer than any request may, and must not die with the web process. Everything worth knowing goes on the
 * PlatformBackup row: progress while it runs, then READY with size and sha256, or FAILED with the reason.
 *
 * ## The passphrase
 *
 * Never on the worker's command line (`ps` shows it to every user on the box) and never in its environment
 * (`/proc/<pid>/environ`). The action seals it under the platform key, bound to the row and the job, into a file
 * of its own (0600, in a 0700 folder) that the worker reads and deletes before it does anything else — and
 * refuses when it is more than a quarter of an hour old. It is never written to the row, the audit log or a log.
 *
 * ## Settling
 *
 * `settleBackups` — on every load of the page and in the platform tick's daily run — removes files past their
 * `expiresAt` (EXPIRED), and gives up on a build or a check whose worker died: nothing heard from it for half an
 * hour (the builder writes progress as it goes, and the worker a heartbeat every minute besides).
 */

/** "restore": a restore from a bundle (src/lib/bundle/restore.ts) — keyed by its RestoreRun's id, not a backup's. */
export type BundleJob = "build" | "verify" | "restore";

/** A build or a check not heard from for this long has lost its worker. */
export const DEAD_AFTER_MS = 30 * 60_000;
export const BUILD_STOPPED = "stopped — the server restarted while it was being made";
export const VERIFY_STOPPED = "stopped — the server restarted while it was being read";
/** How long a sealed passphrase waits for its worker. */
const HANDOFF_MAX_AGE_MS = 15 * 60_000;
/** What a build needs beyond its own estimate: the builder copies each box file through a temporary file. */
const HEADROOM_BYTES = 64 * 1024 * 1024;

/** A bundle's file in BACKUP_DIR/platform/bundles/, from its row's name — or null for a name that isn't one of ours. */
export function bundlePath(fileName: string): string | null {
  if (typeof fileName !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(fileName) || fileName.includes("..")) return null;
  return path.join(bundleDir(), fileName);
}

const jobsDir = () => path.join(bundleDir(), ".jobs");
const handoffFile = (id: string, job: BundleJob) => path.join(jobsDir(), `${id}.${job}.key`);
const validRowId = (id: string) => /^[A-Za-z0-9_-]{8,64}$/.test(id);

// ─── Free space ──────────────────────────────────────────────────────────────────────────────────

type FreeSpaceProbe = (dir: string) => Promise<number>;

/** Free bytes for this process's user on the disk holding `dir` (the nearest folder that exists). */
const realProbe: FreeSpaceProbe = async (dir) => {
  let at = path.resolve(dir);
  for (;;) {
    const info = await stat(at).catch(() => null);
    if (info?.isDirectory()) break;
    const up = path.dirname(at);
    if (up === at) break;
    at = up;
  }
  const s = await statfs(at);
  return Number(s.bavail) * Number(s.bsize);
};
let probe: FreeSpaceProbe = realProbe;

/** For the checks: what the disk says is free. Null puts the real one back. */
export function setFreeSpaceProbeForChecks(fake: FreeSpaceProbe | null): void {
  probe = fake ?? realProbe;
}

export async function freeSpace(dir: string = bundleDir()): Promise<number> {
  return probe(dir);
}

// ─── The estimate ────────────────────────────────────────────────────────────────────────────────

export type BundleEstimate = {
  /** What the bundle is expected to come to, at most. */
  bytes: number;
  /** Free on the disk the bundle is written to. */
  free: number;
  fits: boolean;
  parts: { label: string; bytes: number }[];
};

async function databaseBytes(url: string): Promise<number> {
  const client = directClient(url, { max: 1 });
  try {
    const rows = await client.$queryRawUnsafe<{ n: bigint | number }[]>(`SELECT pg_database_size(current_database())::bigint AS n`);
    return Number(rows[0]?.n ?? 0);
  } catch {
    return 0;
  } finally {
    await client.$disconnect().catch(() => {});
  }
}

/**
 * An upper estimate of a bundle's size, from what is known without reading anything: each workspace's database
 * (`pg_database_size`, which a compressed dump comes well under) and its files as last measured
 * (Tenant.storageUsedBytes), and for a full bundle the control plane's database too — against the disk's free space.
 */
export async function estimateBundle(kind: "full" | "workspace", tenant: Tenant | null): Promise<BundleEstimate> {
  const tenants = kind === "full" ? await tenantsForBackup() : tenant ? [tenant] : [];
  const parts: BundleEstimate["parts"] = [];
  const used = controlConfigured()
    ? new Map(
        (await controlDb().tenant.findMany({ where: { id: { in: tenants.map((t) => t.id) } }, select: { id: true, storageUsedBytes: true } })).map((r) => [r.id, Number(r.storageUsedBytes ?? 0)]),
      )
    : new Map<string, number>();
  if (kind === "full" && controlConfigured()) {
    const rows = await controlDb()
      .$queryRawUnsafe<{ n: bigint | number }[]>(`SELECT pg_database_size(current_database())::bigint AS n`)
      .catch(() => [{ n: 0 }]);
    parts.push({ label: "The control plane's database", bytes: Number(rows[0]?.n ?? 0) });
  }
  for (const t of tenants) {
    const db = t.dbUrl ? await databaseBytes(t.dbUrl) : 0;
    parts.push({ label: `${t.slug}: database and files`, bytes: db + (used.get(t.id) ?? 0) });
  }
  const bytes = parts.reduce((n, p) => n + p.bytes, 0);
  const free = await freeSpace(bundleDir());
  return { bytes, free, fits: free >= bytes + HEADROOM_BYTES, parts };
}

// ─── The passphrase's way to the worker ──────────────────────────────────────────────────────────

/** Seals the passphrase for one row's one job into a 0600 file the worker takes. Never logged, never on the row. */
export async function handPassphrase(id: string, job: BundleJob, passphrase: string): Promise<void> {
  if (!validRowId(id)) throw new Error("Not a backup's id.");
  await mkdir(jobsDir(), { recursive: true, mode: 0o700 });
  const file = handoffFile(id, job);
  await rm(file, { force: true });
  const sealed = sealForPlatform("bundle-passphrase", JSON.stringify({ id, job, passphrase, at: Date.now() }));
  await writeFile(file, sealed, { mode: 0o600, flag: "wx" });
}

/** The passphrase handed for this job — the file deleted as it is read, whatever it holds. Null when there is none. */
export async function takePassphrase(id: string, job: BundleJob): Promise<string | null> {
  if (!validRowId(id)) return null;
  const file = handoffFile(id, job);
  let sealed: string | null = null;
  try {
    sealed = await readFile(file, "utf8").catch(() => null);
  } finally {
    await rm(file, { force: true }).catch(() => {});
  }
  if (!sealed) return null;
  try {
    const opened = JSON.parse(openForPlatform("bundle-passphrase", sealed)) as { id?: unknown; job?: unknown; passphrase?: unknown; at?: unknown };
    if (opened.id !== id || opened.job !== job || typeof opened.passphrase !== "string" || typeof opened.at !== "number") return null;
    if (Date.now() - opened.at > HANDOFF_MAX_AGE_MS) return null;
    return opened.passphrase;
  } catch {
    return null;
  }
}

/** Whether a handed passphrase is still waiting — the checks look that it is gone. */
export async function passphraseWaiting(id: string, job: BundleJob): Promise<boolean> {
  return stat(handoffFile(id, job)).then(
    () => true,
    () => false,
  );
}

// ─── Starting the worker ─────────────────────────────────────────────────────────────────────────

/**
 * Resolved from the working directory, as the restore's are (src/app/api/backups/restore/route.ts): tsx is a
 * devDependency and the worker a script outside the Next build.
 */
const TSX_CLI = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
const WORKER_SCRIPT = path.join(process.cwd(), "scripts", "bundle-worker.ts");
const RESTORE_WORKER_SCRIPT = path.join(process.cwd(), "scripts", "restore-bundle-worker.ts");

export type WorkerSpawner = (command: string, args: string[], env: NodeJS.ProcessEnv, onError: (err: Error) => void) => void;

const realSpawner: WorkerSpawner = (command, args, env, onError) => {
  const child = spawn(command, args, { cwd: process.cwd(), detached: true, stdio: "ignore", env });
  child.once("error", onError);
  child.unref();
};
let spawner: WorkerSpawner = realSpawner;

/** For the checks: see what would be started (and start it in-process instead). Null puts the real one back. */
export function setWorkerSpawnerForChecks(fake: WorkerSpawner | null): void {
  spawner = fake ?? realSpawner;
}

/**
 * The worker for one job on one row, detached. Its arguments are the job and the row's id — nothing else. A restore's
 * worker is scripts/restore-bundle-worker.ts, given the RestoreRun's id; `onFailedStart` is what a restore does when
 * its process could not be started at all (a full restore keeps its account in a file, not on a row).
 */
export function startWorker(job: BundleJob, id: string, onFailedStart?: (message: string) => Promise<void>): void {
  if (!validRowId(id)) throw new Error("Not a backup's id.");
  const args = job === "restore" ? [TSX_CLI, RESTORE_WORKER_SCRIPT, id] : [TSX_CLI, WORKER_SCRIPT, job, id];
  spawner(process.execPath, args, { ...process.env }, (err) => {
    // The process could not be started at all (no Node, no tsx): said on the row, rather than waiting half an hour.
    const message = `The worker could not be started: ${err.message}`;
    void (
      job === "build"
        ? controlDb().platformBackup.updateMany({ where: { id, status: "RUNNING" }, data: { status: "FAILED", finishedAt: new Date(), error: message } })
        : job === "verify"
          ? controlDb().platformBackup.updateMany({ where: { id }, data: { verifyProgress: { state: "failed", at: new Date().toISOString(), error: message } } })
          : (onFailedStart?.(message) ?? controlDb().restoreRun.updateMany({ where: { id, status: "RUNNING" }, data: { status: "FAILED", finishedAt: new Date(), error: message } }))
    ).catch(() => {});
    void takePassphrase(id, job).catch(() => {});
  });
}

// ─── The worker's work ───────────────────────────────────────────────────────────────────────────

async function heartbeat(id: string, field: "progress" | "verifyProgress"): Promise<void> {
  const now = JSON.stringify(new Date().toISOString());
  const where = field === "progress" ? `status = 'RUNNING'` : `"verifyProgress"->>'state' = 'running'`;
  await controlDb()
    .$executeRawUnsafe(`UPDATE "platform_backups" SET "${field}" = jsonb_set(COALESCE("${field}", '{}'::jsonb), '{at}', $2::jsonb) WHERE id = $1 AND ${where}`, id, now)
    .catch(() => {});
}

/** Builds or verifies one row's bundle: what scripts/bundle-worker.ts runs, and what the checks run in-process. */
export async function runBundleJob(job: BundleJob, id: string): Promise<void> {
  // First, before anything can fail: the passphrase's file is read and gone.
  const passphrase = await takePassphrase(id, job);
  if (!controlConfigured()) throw new Error("No control plane: CONTROL_DATABASE_URL is not set.");
  if (job === "restore") throw new Error("A restore runs in scripts/restore-bundle-worker.ts (src/lib/bundle/restore.ts runRestoreJob).");
  return job === "build" ? runBuild(id, passphrase) : runVerify(id, passphrase);
}

async function runBuild(id: string, passphrase: string | null): Promise<void> {
  const control = controlDb();
  const row = await control.platformBackup.findUnique({ where: { id } });
  if (!row || row.status !== "RUNNING" || row.source !== "CREATED") return;
  const fail = async (message: string) => {
    await control.platformBackup.updateMany({ where: { id, status: "RUNNING" }, data: { status: "FAILED", finishedAt: new Date(), error: message } });
  };
  if (!passphrase || passphraseProblem(passphrase)) return fail("The passphrase did not reach the worker — it is only kept for a few minutes. Start the backup again.");
  const out = bundlePath(row.fileName);
  if (!out) return fail("Its file name is not one this server writes.");

  const beat = setInterval(() => void heartbeat(id, "progress"), 60_000);
  beat.unref?.();
  try {
    const expected = (row.progress as { expectedBytes?: unknown } | null)?.expectedBytes;
    const options = {
      out,
      passphrase,
      createdBy: row.startedById ? `staff:${row.startedById}` : "console",
      startedById: row.startedById,
      backupId: id,
      countEntries: true,
      expectedBytes: typeof expected === "number" ? expected : null,
    };
    if (row.kind === "FULL") {
      await buildFullBundle(options);
    } else {
      const tenant = row.tenantId ? await tenantById(row.tenantId) : null;
      if (!tenant || tenant.status === "DEPROVISIONED") return await fail(`The workspace ${row.tenantSlug ?? ""} is closed or gone; there is nothing of it to put in a bundle.`);
      await buildWorkspaceBundle(tenant, options);
    }
  } catch (err) {
    // The builder has marked the row FAILED with its reason already; this covers a failure before it could.
    await fail(err instanceof Error ? err.message : String(err)).catch(() => {});
  } finally {
    clearInterval(beat);
  }
}

async function runVerify(id: string, passphrase: string | null): Promise<void> {
  const control = controlDb();
  const row = await control.platformBackup.findUnique({ where: { id } });
  const running = (row?.verifyProgress as { state?: string } | null)?.state === "running";
  if (!row || !running) return;
  const progress = row.verifyProgress as Record<string, unknown>;
  const finish = async (ok: boolean, problems: string[]) => {
    await control.platformBackup.update({ where: { id }, data: { verifiedAt: new Date(), verifyOk: ok, verifyProblems: problems, verifyProgress: { ...progress, state: "done", at: new Date().toISOString() } } });
  };
  if (!passphrase) {
    await control.platformBackup.update({ where: { id }, data: { verifyProgress: { ...progress, state: "failed", at: new Date().toISOString(), error: "The passphrase did not reach the worker — it is only kept for a few minutes. Verify it again." } } });
    return;
  }
  const file = bundlePath(row.fileName);
  const info = file ? await stat(file).catch(() => null) : null;
  if (!file || !info?.isFile()) return finish(false, ["The file is no longer on the server."]);

  const beat = setInterval(() => void heartbeat(id, "verifyProgress"), 60_000);
  beat.unref?.();
  let bytes = 0;
  let saved = 0;
  try {
    const result = await verifyBundle(file, passphrase, {
      onBytes: (n) => {
        bytes += n;
        if (Date.now() - saved < 2000) return;
        saved = Date.now();
        void control.platformBackup
          .updateMany({ where: { id }, data: { verifyProgress: { ...progress, state: "running", bytes, at: new Date().toISOString() } } })
          .catch(() => {});
      },
    });
    await finish(result.ok, result.problems);
  } catch (err) {
    await finish(false, [err instanceof Error ? err.message : String(err)]);
  } finally {
    clearInterval(beat);
  }
}

// ─── Settling ────────────────────────────────────────────────────────────────────────────────────

export type Settled = { expired: number; stopped: number; checksStopped: number; uploads: number };

/** Removes a dead build's leftovers: its `.part` and its work folders beside it. */
async function removeLeftovers(fileName: string): Promise<void> {
  const file = bundlePath(fileName);
  if (!file) return;
  await rm(`${file}.part`, { force: true }).catch(() => {});
  const base = path.basename(file);
  for (const name of await readdir(path.dirname(file)).catch(() => [] as string[])) {
    if (name.startsWith(`${base}.work-`)) await rm(path.join(path.dirname(file), name), { recursive: true, force: true }).catch(() => {});
  }
}

const lastHeard = (progress: unknown, fallback: Date): number => {
  const at = (progress as { at?: unknown } | null)?.at;
  const t = typeof at === "string" ? Date.parse(at) : NaN;
  return Number.isFinite(t) ? Math.max(t, fallback.getTime()) : fallback.getTime();
};

/**
 * Files past their `expiresAt` deleted and their rows EXPIRED; builds and checks whose worker died settled; uploads
 * abandoned for a day cleared (src/lib/bundle/upload.ts); passphrase files nobody took removed. Never throws.
 */
export async function settleBackups(now: Date = new Date(), cleanUploads?: (now: Date) => Promise<number>): Promise<Settled> {
  const settled: Settled = { expired: 0, stopped: 0, checksStopped: 0, uploads: 0 };
  if (!controlConfigured()) return settled;
  const control = controlDb();
  try {
    const due = await control.platformBackup.findMany({ where: { status: "READY", expiresAt: { lte: now } }, select: { id: true, fileName: true, verifyProgress: true } });
    for (const row of due) {
      // Not from under a check that is reading it; the next settle takes it.
      if ((row.verifyProgress as { state?: string } | null)?.state === "running" && now.getTime() - lastHeard(row.verifyProgress, new Date(0)) < DEAD_AFTER_MS) continue;
      const file = bundlePath(row.fileName);
      if (file) await rm(file, { force: true });
      const done = await control.platformBackup.updateMany({ where: { id: row.id, status: "READY" }, data: { status: "EXPIRED" } });
      settled.expired += done.count;
    }

    const running = await control.platformBackup.findMany({ where: { status: "RUNNING" }, select: { id: true, fileName: true, progress: true, startedAt: true } });
    for (const row of running) {
      if (now.getTime() - lastHeard(row.progress, row.startedAt) <= DEAD_AFTER_MS) continue;
      const done = await control.platformBackup.updateMany({ where: { id: row.id, status: "RUNNING" }, data: { status: "FAILED", finishedAt: now, error: BUILD_STOPPED } });
      if (done.count) await removeLeftovers(row.fileName);
      settled.stopped += done.count;
    }

    const checking = await control.$queryRawUnsafe<{ id: string; verifyProgress: unknown; startedAt: Date }[]>(
      `SELECT id, "verifyProgress", "startedAt" FROM "platform_backups" WHERE "verifyProgress"->>'state' = 'running'`,
    );
    for (const row of checking) {
      if (now.getTime() - lastHeard(row.verifyProgress, new Date(0)) <= DEAD_AFTER_MS) continue;
      await control.platformBackup.update({ where: { id: row.id }, data: { verifyProgress: { ...(row.verifyProgress as Record<string, unknown>), state: "stopped", error: VERIFY_STOPPED } } });
      settled.checksStopped += 1;
    }

    for (const name of await readdir(jobsDir()).catch(() => [] as string[])) {
      const info = await stat(path.join(jobsDir(), name)).catch(() => null);
      if (info && now.getTime() - info.mtimeMs > HANDOFF_MAX_AGE_MS) await rm(path.join(jobsDir(), name), { force: true }).catch(() => {});
    }
    if (cleanUploads) settled.uploads = await cleanUploads(now);
  } catch (err) {
    console.error(`[backups] settling: ${err instanceof Error ? err.name : "error"}`);
  }
  return settled;
}

// ─── Names ───────────────────────────────────────────────────────────────────────────────────────

/** What a download is called: `deskzo-full-2026-11-26T1015Z.dzbk`, `deskzo-<slug>-2026-11-26T1015Z.dzbk`. */
export function downloadName(row: { kind: "FULL" | "WORKSPACE"; tenantSlug: string | null; startedAt: Date; header?: unknown }): string {
  const created = (row.header as { createdAt?: unknown } | null)?.createdAt;
  const at = typeof created === "string" && Number.isFinite(Date.parse(created)) ? new Date(created) : row.startedAt;
  const iso = at.toISOString();
  const stamp = `${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z`;
  const what = row.kind === "FULL" ? "full" : (row.tenantSlug ?? "workspace").replace(/[^a-z0-9-]/gi, "-").slice(0, 63);
  return `deskzo-${what}-${stamp}${BUNDLE_EXTENSION}`;
}

/**
 * The workspace an audit entry names, when it is one on this server: an uploaded bundle can name a workspace this
 * server never had, and the audit log's workspace is a relation.
 */
export async function auditTenantId(tenantId: string | null): Promise<string | null> {
  if (!tenantId || !controlConfigured()) return null;
  const found = await controlDb().tenant.findUnique({ where: { id: tenantId }, select: { id: true } }).catch(() => null);
  return found?.id ?? null;
}
