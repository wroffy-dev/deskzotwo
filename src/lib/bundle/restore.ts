import { createHash } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Transform, type Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { openBackupFileTo, openBuffer, sealBuffer } from "@/lib/backup/at-rest";
import { backupRoot, holdLock, releaseLock, restoreInProgressFor, takeLock } from "@/lib/backup/maintenance";
import { parseDatabaseUrl } from "@/lib/backup/policy";
import { afterRestoreChores, clearOwnReferenceCopy, clearSchema, endEverySignIn, restoreDumpFile } from "@/lib/backup/restore-steps";
import { dump, resolveDumpTool, runBackup, type DumpTool } from "@/lib/backup/run";
import { describeWriteError, insertWorkspaceRows, putBackSnapshot, removeInserted, upsertWorkspaceRows, type AppliedRow } from "@/lib/bundle/control-apply";
import { controlRowsJson, decodeControlRows, type ControlRowsFile } from "@/lib/bundle/control-rows";
import { serverFacts } from "@/lib/bundle/console-data";
import { BundleFormatError, bundlePassphraseOpens, readBundle, readBundleHeader, type BundleHeader, type BundleManifest, type ManifestEntry } from "@/lib/bundle/format";
import { bundlePath, freeSpace, takePassphrase } from "@/lib/bundle/jobs";
import {
  RESTORE_HEARTBEAT_MS,
  RESTORE_STALE_AFTER_MS,
  activeFilePath,
  activeFullRestore,
  platformRestoreDir,
  runFilePath,
  type FullRestoreFile,
  type FullRestoreState,
  type FullRestoreStep,
  type RestoreLogLine,
} from "@/lib/bundle/restore-status";
import { rawRecordingStoreFor } from "@/lib/calls/recordings";
import { compatibilityOf, headerSummary, sizeText } from "@/lib/console-shared/backups";
import { db } from "@/lib/db";
import { CONTROL_SEAL } from "@/lib/offsite/control";
import type { OffsiteStore } from "@/lib/offsite/store";
import { closeControlDb, controlConfigured, controlDb } from "@/lib/platform/control-db";
import { refreshEntitlements } from "@/lib/platform/entitlements";
import { platformKeyFingerprint, sealForTenant } from "@/lib/platform/kek";
import { latestMigrationName, migrateDeploy } from "@/lib/platform/migrate";
import { createWorkspaceDatabase, dropWorkspaceDatabase, withoutRoleLimits, type WorkspaceDatabase } from "@/lib/platform/provisioner";
import { forgetStorageBoxSettings, storageBox } from "@/lib/storage/box";
import { forgetRememberedFiles } from "@/lib/storage/files";
import { supportDir, validId } from "@/lib/support/storage";
import { directClient } from "@/lib/tenancy/direct-client";
import { forgetRegistry, tenantById } from "@/lib/tenancy/registry";
import { runAsTenant } from "@/lib/tenancy/resolve";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * Restoring a Backup & Restore bundle (owner, 26 Nov 2026 — part C; the format is src/lib/bundle/format.ts, the
 * builder build.ts). Three ways, decided by the bundle and this server, never by guesswork:
 *
 *   IN_PLACE  a workspace bundle whose workspace (same id) is on this server: put back over it
 *   AS_NEW    a workspace bundle whose workspace isn't here (a fresh install, another server): added as a new one
 *   FULL      a full bundle: the whole application — the control plane replaced, every workspace a new database
 *
 * Run outside any request — scripts/restore-bundle-worker.ts, spawned by the console (src/actions/platform/console-
 * backups.ts), or `npm run bundle -- restore` from a terminal; both run `runRestoreJob` / `restoreFromFile` here.
 *
 * ## Refuse before touching anything (`precheck`)
 *
 * The file there and READY; its sha256 the one its row recorded; read through once with the passphrase — every frame
 * authenticated, every entry against the manifest (format.ts `readBundle`, the read `verifyBundle` makes; re-run every
 * time rather than trusting an older Verify); the kind the one asked for; made under this server's PLATFORM_MASTER_KEY
 * (by fingerprint — the key itself never travels); no schema newer than this server's (`compatibilityOf` "blocked");
 * the passphrase opening it; the storage box set up here when the bundle carries files for it; room on the disk for
 * the largest dump, the largest file and the safety copy; no other restore running; for AS_NEW no other workspace here
 * with its address name or any of its domains. Any of these fails: a RestoreRun FAILED saying which, in plain words,
 * and nothing changed.
 *
 * ## Then
 *
 * Every entry is hashed again as it is used and checked against the manifest the precheck read, so a file swapped
 * between the two reads is refused at its first entry. Each way keeps a safety copy before the first change and puts
 * everything back from it on any failure after (ROLLED_BACK); a rollback that fails too is FAILED, saying exactly
 * what is left and how to recover, and the workspace (or the whole application) is left closed.
 *
 * Steps a check can make fail on purpose: `setRestoreFaultForChecks`.
 */

export type RestoreMode = "IN_PLACE" | "AS_NEW" | "FULL";
export type RestoreKind = "full" | "workspace";
export type RestoreStatusValue = "RUNNING" | "SUCCEEDED" | "FAILED" | "ROLLED_BACK";

export class RestoreRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RestoreRefused";
  }
}

/** The typed confirmation for a full restore. A workspace restore is confirmed with the workspace's slug. */
export const FULL_CONFIRMATION = "RESTORE EVERYTHING";
/** How long a safety copy of a workspace is kept, whatever the retention says — as the Restore button's. */
const SAFETY_COPY_DAYS = 30;
/** What a restore needs on disk beyond its largest dump, largest file and safety copy. */
const HEADROOM_BYTES = 64 * 1024 * 1024;
/** Settings that belong to the server, not the data: kept from this server over a full restore. */
const SERVER_SETTINGS = ["storage.connection", "storage.container", "offsite.provider", "offsite.config", "offsite.secret"] as const;

export type RestoreSource = {
  /** The bundle's file on this server. */
  file: string;
  /** Its PlatformBackup row, when it has one (the console's); a script's file has none. */
  backupId: string | null;
  /** The sha256 its row recorded when it was made or uploaded: the file must still be that file. */
  expectedSha256: string | null;
  /** For the log: its download name, or the path the script was given. */
  label: string;
};

export type RestoreOptions = { putBackControlRows?: boolean };

export type RestoreOutcome = {
  status: RestoreStatusValue;
  error: string | null;
  mode: RestoreMode | null;
  log: RestoreLogLine[];
};

// ─── For the checks ──────────────────────────────────────────────────────────────────────────────

let fault: string | null = null;
/**
 * For the checks: makes a restore fail at a named step, as a real failure there would — "workspace:after-restore"
 * (pg_restore), "workspace:after-migrate", "workspace:after-files", "workspace:after-keys",
 * "workspace:after-control-rows", "as-new:after-control-rows", "full:after-control-restore", "full:after-settings",
 * "full:workspace:<slug>", "full:before-finish". Null for none.
 */
export function setRestoreFaultForChecks(point: string | null): void {
  fault = point;
}
function faultAt(point: string): void {
  if (fault && fault === point) throw new Error(`A failure made on purpose by a check, at ${point}.`);
}

// ─── The log ─────────────────────────────────────────────────────────────────────────────────────

export type RestoreLog = {
  lines: RestoreLogLine[];
  say(step: string, message: string): Promise<void>;
};
type Log = RestoreLog;

/** A workspace restore's log, on its RestoreRun row as it goes. */
function rowLog(runId: string, initial: RestoreLogLine[] = []): Log {
  const lines = [...initial];
  return {
    lines,
    async say(step, message) {
      lines.push({ at: new Date().toISOString(), step, message });
      await controlDb()
        .restoreRun.update({
          where: { id: runId },
          data: { log: lines, beatAt: new Date() },
        })
        .catch(() => {});
    },
  };
}

async function writeAtomic(file: string, text: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, text, { mode: 0o600 });
  await rename(temp, file);
}

/** A full restore's log, in its file (src/lib/bundle/restore-status.ts) — the control plane is what it replaces. */
function fileLog(run: FullRestoreFile): Log & {
  run: FullRestoreFile;
  save(): Promise<void>;
  step(step: FullRestoreStep): Promise<void>;
} {
  const save = () => writeAtomic(runFilePath(run.id), JSON.stringify(run, null, 2));
  return {
    run,
    lines: run.log,
    save,
    async step(step) {
      run.step = step;
      await save();
    },
    async say(step, message) {
      run.log.push({ at: new Date().toISOString(), step, message });
      await save().catch(() => {});
    },
  };
}

async function writeActive(runId: string, startedAt: string, held = false): Promise<void> {
  await writeAtomic(
    activeFilePath(),
    JSON.stringify({
      runId,
      startedAt,
      beatAt: new Date().toISOString(),
      held,
    }),
  );
}

async function clearActive(runId: string): Promise<void> {
  const active = activeFullRestore(Date.now());
  if (!active || active.runId === runId) await rm(activeFilePath(), { force: true }).catch(() => {});
}

// ─── Entries ─────────────────────────────────────────────────────────────────────────────────────

const boxId = (tenantId: string) => tenantId.replace(/[^A-Za-z0-9._-]/g, "-");

/** An entry written to `target`, hashed as it goes, and refused unless it is exactly what the checked manifest says. */
async function writeEntry(name: string, content: Readable, target: string, expected: ManifestEntry | undefined): Promise<void> {
  if (!expected) throw new BundleFormatError(`${name} is not in the manifest that was checked — the file changed since.`);
  const hash = createHash("sha256");
  let size = 0;
  const counting = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      size += chunk.length;
      done(null, chunk);
    },
  });
  await mkdir(path.dirname(target), { recursive: true });
  await pipeline(content, counting, createWriteStream(target, { mode: 0o600 }));
  if (size !== expected.size || hash.digest("hex") !== expected.sha256) {
    await rm(target, { force: true }).catch(() => {});
    throw new BundleFormatError(`${name} is not what the backup held when it was checked — the file was changed since. Nothing more was taken from it.`);
  }
}

/** An entry into a store under `key`, through a temporary file in `work` (stores take files, never a stream). */
async function putEntry(store: OffsiteStore, key: string, name: string, content: Readable, expected: ManifestEntry | undefined, work: string): Promise<void> {
  const temp = path.join(work, `put-${process.pid}-${createHash("sha1").update(name).digest("hex").slice(0, 16)}`);
  try {
    await writeEntry(name, content, temp, expected);
    await store.putFile(key, temp);
  } finally {
    await rm(temp, { force: true }).catch(() => {});
  }
}

type WorkspaceEntry =
  | { what: "db" }
  | { what: "control" }
  | { what: "box"; key: string }
  | { what: "support-box"; key: string }
  | { what: "support-disk"; rel: string }
  | { what: "recording"; key: string }
  | { what: "other" };

/** What an entry of `workspaces/<id>/…` is, and where it goes on this server. */
function classify(name: string, tenantId: string): WorkspaceEntry | null {
  const base = `workspaces/${tenantId}/`;
  if (!name.startsWith(base)) return null;
  const rel = name.slice(base.length);
  if (rel === "db.dump") return { what: "db" };
  if (rel === "control.json") return { what: "control" };
  if (rel.startsWith("box/"))
    return {
      what: "box",
      key: `workspaces/${boxId(tenantId)}/${rel.slice(4)}`,
    };
  if (rel.startsWith("support/box/")) return { what: "support-box", key: `support/${tenantId}/${rel.slice(12)}` };
  if (rel.startsWith("support/disk/")) return { what: "support-disk", rel: rel.slice(13) };
  if (rel.startsWith("recordings-store/")) return { what: "recording", key: rel.slice(17) };
  return { what: "other" };
}

/** A support attachment kept on disk, written where the support pages look: SUPPORT_DIR/<id>/<request>/<file>. */
async function writeSupportFile(tenantId: string, rel: string, name: string, content: Readable, expected: ManifestEntry | undefined): Promise<string> {
  const root = supportDir();
  const parts = rel.split("/");
  if (!validId(tenantId) || parts.length === 0 || parts[0] === "staging") throw new BundleFormatError(`${name} is not a support attachment this server keeps.`);
  const target = path.resolve(root, tenantId, ...parts);
  const inside = path.relative(path.join(root, tenantId), target);
  if (!inside || inside.startsWith("..") || path.isAbsolute(inside)) throw new BundleFormatError(`${name} would land outside the support folder.`);
  const temp = `${target}.${process.pid}.restoring`;
  await writeEntry(name, content, temp, expected);
  await rename(temp, target);
  return target;
}

/** Files written into a workspace's part of this server, for an AS_NEW rollback to take away again. */
type Written = { store: OffsiteStore; key: string }[];

/** One workspace's files, as they come out of the bundle: written back, never deleting what is there and not in it. */
async function writeWorkspaceFile(
  entry: WorkspaceEntry,
  tenantId: string,
  name: string,
  content: Readable,
  expected: ManifestEntry | undefined,
  work: string,
  written: Written | null,
  disk: string[] | null,
): Promise<boolean> {
  if (entry.what === "box" || entry.what === "support-box") {
    const box = await storageBox();
    if (!box) throw new RestoreRefused("The storage box is not set up on this server — set up the storage box first.");
    await putEntry(box, entry.key, name, content, expected, work);
    written?.push({ store: box, key: entry.key });
    return true;
  }
  if (entry.what === "recording") {
    const store = await rawRecordingStoreFor(tenantId);
    if (!store) throw new RestoreRefused("This server has nowhere to keep call recordings — set up the storage box first.");
    await putEntry(store, entry.key, name, content, expected, work);
    written?.push({ store, key: entry.key });
    return true;
  }
  if (entry.what === "support-disk") {
    const file = await writeSupportFile(tenantId, entry.rel, name, content, expected);
    disk?.push(file);
    return true;
  }
  return false;
}

// ─── Prechecks ───────────────────────────────────────────────────────────────────────────────────

export type Checked = {
  header: BundleHeader;
  manifest: BundleManifest;
  sha256: string;
  mode: RestoreMode;
  /** For a workspace restore: its id and slug, and its control.json as the bundle has it. */
  tenantId: string | null;
  slug: string | null;
  control: ControlRowsFile | null;
  /** This server's workspace of that id (IN_PLACE). */
  here: Tenant | null;
  /** For a full restore: whether this server holds workspaces already (it is not a fresh install). */
  existing: {
    id: string;
    slug: string;
    status: string;
    dbName: string | null;
  }[];
};

/** The bundle read start to end once: its sha256, every frame and entry checked (as `verifyBundle` does), control.json kept. */
async function readThrough(
  file: string,
  passphrase: string,
  keep: (name: string) => boolean,
): Promise<{
  manifest: BundleManifest;
  sha256: string;
  kept: Map<string, Buffer>;
}> {
  const hash = createHash("sha256");
  const source = createReadStream(file, { highWaterMark: 1024 * 1024 });
  const hashing = new Transform({
    transform(chunk: Buffer, _enc, done) {
      hash.update(chunk);
      done(null, chunk);
    },
  });
  source.on("error", (err) => hashing.destroy(err));
  source.pipe(hashing);
  const kept = new Map<string, Buffer>();
  try {
    const { manifest } = await readBundle(hashing, passphrase, async (name, content) => {
      if (!keep(name)) return;
      const chunks: Buffer[] = [];
      for await (const chunk of content) chunks.push(chunk as Buffer);
      kept.set(name, Buffer.concat(chunks));
    });
    return { manifest, sha256: hash.digest("hex"), kept };
  } finally {
    source.destroy();
    hashing.destroy();
  }
}

async function databaseBytes(url: string | null | undefined): Promise<number> {
  if (!url) return 0;
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

/** Whether the database's user may drop and make again its `public` schema — a superuser, or a member of its owner. */
async function canReplaceSchema(url: string): Promise<boolean> {
  const client = directClient(url, { max: 1 });
  try {
    const rows = await client.$queryRawUnsafe<{ ok: boolean }[]>(
      `SELECT ((SELECT rolsuper FROM pg_roles WHERE rolname = current_user) OR pg_has_role(current_user, n.nspowner, 'MEMBER')) AS ok FROM pg_namespace n WHERE n.nspname = 'public'`,
    );
    return rows[0]?.ok === true;
  } catch {
    return false;
  } finally {
    await client.$disconnect().catch(() => {});
  }
}

/** Whether another restore is going on, by RestoreRun rows whose worker is still heard from. */
async function otherRestoreRunning(runId: string | null, tenantId: string | null): Promise<string | null> {
  const fresh = new Date(Date.now() - RESTORE_STALE_AFTER_MS);
  const running = await controlDb().restoreRun.findMany({
    where: { status: "RUNNING", ...(runId ? { NOT: { id: runId } } : {}) },
    select: {
      id: true,
      kind: true,
      tenantId: true,
      tenantSlug: true,
      beatAt: true,
      startedAt: true,
    },
  });
  for (const r of running) {
    if ((r.beatAt ?? r.startedAt) < fresh) continue;
    if (r.kind === "FULL") return "A restore of the whole application is running — wait for it to finish.";
    if (!tenantId || r.tenantId === tenantId)
      return tenantId
        ? `${r.tenantSlug ?? "This workspace"} is being restored already — wait for it to finish.`
        : `A restore of ${r.tenantSlug ?? "a workspace"} is running — wait for it to finish before restoring everything.`;
  }
  return null;
}

export type Quick = Pick<Checked, "header" | "mode" | "tenantId" | "slug" | "here" | "existing">;

/**
 * The checks that take a moment — the file, its header, the kind, the platform key, the schemas, the passphrase, no
 * other restore running — and the mode decided. What the console runs before it starts the worker, so a refusal is
 * said at once; the worker runs them again as the first part of `precheck`. Throws `RestoreRefused`.
 */
export async function quickChecks(kind: RestoreKind, source: RestoreSource, passphrase: string, runId: string | null): Promise<Quick> {
  if (!controlConfigured()) throw new RestoreRefused("This server has no control plane (CONTROL_DATABASE_URL), so it can't take a restore. Set one up first.");
  const info = await stat(source.file).catch(() => null);
  if (!info?.isFile()) throw new RestoreRefused("The backup's file is no longer on this server — upload it again.");
  let header: BundleHeader;
  try {
    header = await readBundleHeader(source.file);
  } catch (err) {
    throw new RestoreRefused(`The file can't be read as a backup: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (header.kind !== kind) {
    throw new RestoreRefused(
      header.kind === "full"
        ? "That is a backup of the whole application; restore it with “Restore everything”, not as one workspace."
        : "That is a backup of one workspace; restore it as a workspace, not as the whole application.",
    );
  }

  // The platform key, by fingerprint: the key itself never travels, and this server must have the same one.
  const here = platformKeyFingerprint();
  if (!here)
    throw new RestoreRefused(
      "This server has no PLATFORM_MASTER_KEY. Set the one the backup was made with (the same value as on the server it came from), restart, and restore again. Nothing has been changed.",
    );
  if (header.keyFingerprint !== here) {
    throw new RestoreRefused(
      header.keyFingerprint
        ? "This backup was made with a different PLATFORM_MASTER_KEY. Set that key on this server — the same value as on the server it came from — and restore again. Nothing has been changed."
        : "This backup was made where no PLATFORM_MASTER_KEY was set; this server's key can't open what it holds. Nothing has been changed.",
    );
  }

  const summary = headerSummary(header);
  const compat = summary ? compatibilityOf(summary, await serverFacts()) : null;
  if (!compat || compat.verdict === "blocked") {
    const why = compat ? compat.lines.filter((l) => l.tone === "danger").map((l) => l.text) : ["Its header can't be read."];
    throw new RestoreRefused(`This backup can't be restored on this server: ${why.join(" ")} Nothing has been changed.`);
  }
  if (!bundlePassphraseOpens(header, passphrase)) throw new RestoreRefused("That passphrase doesn't open this backup. Nothing has been changed.");

  let mode: RestoreMode = "FULL";
  let tenantId: string | null = null;
  let slug: string | null = null;
  let hereTenant: Tenant | null = null;
  const existing: Checked["existing"] = [];
  if (kind === "workspace") {
    if (header.workspaces.length !== 1) throw new RestoreRefused("This workspace backup doesn't name exactly one workspace — it can't be restored.");
    tenantId = header.workspaces[0]!.id;
    slug = header.workspaces[0]!.slug;
    const row = await controlDb().tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, slug: true, status: true, dbUrlCipher: true },
    });
    if (row?.status === "DEPROVISIONED")
      throw new RestoreRefused(
        `${row.slug} was closed on this server and its record is still here under the same id, so it can't be restored as a new workspace or over the old one. Nothing has been changed.`,
      );
    if (row) {
      forgetRegistry();
      hereTenant = await tenantById(row.id);
      if (!hereTenant?.dbUrl) throw new RestoreRefused(`${row.slug} is on this server but has no database yet (${row.status.toLowerCase()}) — it can't be restored over. Nothing has been changed.`);
      if (restoreInProgressFor(hereTenant)) throw new RestoreRefused(`${row.slug} is being restored already — wait for it to finish.`);
      mode = "IN_PLACE";
    } else {
      mode = "AS_NEW";
    }
  } else {
    if (!header.control) throw new RestoreRefused("This full backup has no control plane in it, so it can't restore the whole application.");
    for (const t of await controlDb().tenant.findMany({
      where: { status: { not: "DEPROVISIONED" } },
      select: { id: true, slug: true, status: true, dbName: true },
      orderBy: { createdAt: "asc" },
    }))
      existing.push(t);
  }
  const busy = await otherRestoreRunning(runId, tenantId);
  if (busy) throw new RestoreRefused(busy);
  return { header, mode, tenantId, slug, here: hereTenant, existing };
}

/**
 * Everything checked before anything is touched — and the mode decided. Throws `RestoreRefused` saying what is wrong
 * in words a person can act on; the caller records it. `runId`: the run asking (left out of "another is running").
 */
export async function precheck(kind: RestoreKind, source: RestoreSource, passphrase: string, runId: string | null, say: (message: string) => Promise<void> = async () => {}): Promise<Checked> {
  const { header, mode, tenantId, slug, here: hereTenant, existing } = await quickChecks(kind, source, passphrase, runId);
  // The whole file, read once: its sha256, every frame and entry against the manifest, and control.json kept.
  await say("Reading the whole backup through once to check it before anything is changed…");
  let read: Awaited<ReturnType<typeof readThrough>>;
  try {
    read = await readThrough(source.file, passphrase, (name) => kind === "workspace" && name === `workspaces/${tenantId}/control.json`);
  } catch (err) {
    throw new RestoreRefused(`The backup is damaged or was altered, so nothing was restored: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (source.expectedSha256 && read.sha256 !== source.expectedSha256) {
    throw new RestoreRefused("The file on this server is not the one that was made or uploaded — its checksum is different. Upload it again. Nothing has been changed.");
  }
  const { manifest } = read;
  const entries = manifest.entries;
  const has = (name: string) => entries.some((e) => e.name === name);

  // What it needs on this server.
  if (kind === "full" && !has("control/control.dump")) throw new RestoreRefused("This full backup has no control-plane dump in it, so it can't restore the whole application.");
  if (kind === "workspace" && !has(`workspaces/${tenantId}/db.dump`))
    throw new RestoreRefused(`This backup has no database for ${slug} (the workspace had none when it was made), so there is nothing to restore.`);
  const needsStore = entries.some((e) => /^workspaces\/[^/]+\/(box|support\/box|recordings-store)\//.test(e.name));
  if (needsStore) {
    let box: OffsiteStore | null = null;
    try {
      box = await storageBox();
    } catch (err) {
      throw new RestoreRefused(
        `The storage box on this server is set up wrongly (${err instanceof Error ? err.message : String(err)}). Put it right in Settings › Backups & logs › Storage box, then restore. Nothing has been changed.`,
      );
    }
    const recordingsElsewhere = !!(process.env.RECORDINGS_AZURE_CONTAINER_URL?.trim() || process.env.RECORDINGS_DIR?.trim());
    const boxNeeded = entries.some((e) => /^workspaces\/[^/]+\/(box|support\/box)\//.test(e.name)) || (!recordingsElsewhere && entries.some((e) => /\/recordings-store\//.test(e.name)));
    if (boxNeeded && !box) {
      throw new RestoreRefused(
        "This backup holds files for the storage box, and this server has no storage box set up — set up the storage box first (Settings › Backups & logs › Storage box), then restore. Nothing has been changed.",
      );
    }
  }

  let control: ControlRowsFile | null = null;
  if (kind === "workspace") {
    const raw = read.kept.get(`workspaces/${tenantId}/control.json`);
    try {
      control = raw ? decodeControlRows(raw) : null;
    } catch (err) {
      throw new RestoreRefused(`The workspace's records in the backup can't be read on this server: ${err instanceof Error ? err.message : String(err)}`);
    }
    const tenantRow = control?.models?.Tenant?.[0] ?? null;
    if (mode === "AS_NEW") {
      if (!tenantRow)
        throw new RestoreRefused(`This backup was made where ${slug} had no record in a control plane, so it can only be restored over the same workspace — and it isn't on this server.`);
      const clash = await controlDb().tenant.findFirst({
        where: { slug: String(tenantRow.slug), NOT: { id: tenantId! } },
        select: { slug: true, name: true },
      });
      if (clash) throw new RestoreRefused(`Its address name “${clash.slug}” is already used on this server by the workspace ${clash.name}. Nothing has been changed.`);
      const hosts = (control?.models?.TenantDomain ?? []).map((d) => String(d.host));
      if (hosts.length) {
        const taken = await controlDb().tenantDomain.findFirst({
          where: { host: { in: hosts }, NOT: { tenantId: tenantId! } },
          select: { host: true, tenant: { select: { slug: true } } },
        });
        if (taken) throw new RestoreRefused(`Its domain ${taken.host} already belongs to the workspace ${taken.tenant.slug} on this server. Nothing has been changed.`);
      }
    }
  }

  // The database it replaces must be one this server's user may clear — found out now, not half way through.
  const replacing = mode === "IN_PLACE" ? hereTenant?.dbUrl : mode === "FULL" ? process.env.CONTROL_DATABASE_URL?.trim() : null;
  if (replacing && !(await canReplaceSchema(replacing))) {
    throw new RestoreRefused(
      `The ${mode === "FULL" ? "control plane's" : "workspace's"} database user may not drop and remake its schema, so it can't be restored over. Give that user ownership of the database, then restore. Nothing has been changed.`,
    );
  }

  // Room on the disk: the largest dump and the largest file staged at once, and the safety copy.
  const largest = (match: (e: ManifestEntry) => boolean) => entries.filter(match).reduce((n, e) => Math.max(n, e.size), 0);
  const dumpBytes = largest((e) => e.name.endsWith(".dump"));
  const fileBytes = largest((e) => !e.name.endsWith(".dump"));
  const safetyBytes = mode === "IN_PLACE" ? await databaseBytes(hereTenant?.dbUrl) : mode === "FULL" ? await databaseBytes(process.env.CONTROL_DATABASE_URL) : 0;
  const needed = dumpBytes + fileBytes + safetyBytes + HEADROOM_BYTES;
  const free = await freeSpace(platformRestoreDir());
  if (free < needed) {
    throw new RestoreRefused(
      `Not enough disk: restoring this needs about ${sizeText(needed)} free where backups are kept (the largest database dump, the largest file and a safety copy), and there is ${sizeText(free)}. Make room in BACKUP_DIR, then restore. Nothing has been changed.`,
    );
  }

  return {
    header,
    manifest,
    sha256: read.sha256,
    mode,
    tenantId,
    slug,
    control,
    here: hereTenant,
    existing,
  };
}

// ─── The run's row ───────────────────────────────────────────────────────────────────────────────

/** A refusal recorded as it must be: a RestoreRun FAILED, saying why, nothing changed. */
export async function recordRefusal(input: {
  kind: "FULL" | "WORKSPACE";
  tenantId?: string | null;
  tenantSlug?: string | null;
  backupId?: string | null;
  startedById?: string | null;
  message: string;
}): Promise<string | null> {
  if (!controlConfigured()) return null;
  const now = new Date();
  const row = await controlDb()
    .restoreRun.create({
      data: {
        kind: input.kind,
        tenantId: input.tenantId ?? null,
        tenantSlug: input.tenantSlug ?? null,
        backupId: input.backupId ?? null,
        status: "FAILED",
        log: [
          {
            at: now.toISOString(),
            step: "checks",
            message: `Refused: ${input.message}`,
          },
        ],
        startedById: input.startedById ?? null,
        startedAt: now,
        finishedAt: now,
        error: input.message,
      },
      select: { id: true },
    })
    .catch(() => null);
  return row?.id ?? null;
}

async function finishRow(
  runId: string,
  status: RestoreStatusValue,
  log: Log,
  extra: {
    error?: string | null;
    safetyBackupId?: string | null;
    safetyPath?: string | null;
    outcomes?: unknown;
  } = {},
): Promise<void> {
  await controlDb().restoreRun.update({
    where: { id: runId },
    data: {
      status,
      log: log.lines,
      finishedAt: new Date(),
      error: extra.error ?? null,
      ...(extra.safetyBackupId !== undefined ? { safetyBackupId: extra.safetyBackupId } : {}),
      ...(extra.safetyPath !== undefined ? { safetyPath: extra.safetyPath } : {}),
      ...(extra.outcomes !== undefined ? { outcomes: extra.outcomes as object } : {}),
    },
  });
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

// ─── A workspace, over the one this server has ───────────────────────────────────────────────────

async function sealedSnapshot(tenantId: string): Promise<Buffer> {
  const parts: string[] = [];
  for await (const part of controlRowsJson(tenantId)) parts.push(part);
  return sealBuffer(tenantId, Buffer.from(parts.join(""), "utf8"), "file");
}

async function restoreInPlace(runId: string, source: RestoreSource, passphrase: string, checked: Checked, options: RestoreOptions, log: Log): Promise<RestoreOutcome> {
  const tenant = checked.here!;
  const base = `workspaces/${tenant.id}/`;
  const expected = new Map(checked.manifest.entries.map((e) => [e.name, e]));
  const connection = parseDatabaseUrl(tenant.dbUrl);
  const tool = await resolveDumpTool("pg_restore");
  if (!connection) return refuseRun(runId, log, "This workspace's database address is not a Postgres URL. Nothing has been changed.");
  if (!tool) return refuseRun(runId, log, "pg_restore could not be found. Install the Postgres client tools or set PG_DUMP_PATH. Nothing has been changed.");
  if (options.putBackControlRows && !checked.control?.models?.Tenant?.length)
    return refuseRun(
      runId,
      log,
      "The backup has no control-plane records for this workspace, so its plan, billing and settings can't be put back from it. Restore it without that option. Nothing has been changed.",
    );
  const role = decodeURIComponent(new URL(tenant.dbUrl).username) || null;
  const work = path.join(platformRestoreDir(), runId);
  await mkdir(work, { recursive: true, mode: 0o700 });

  return runAsTenant(tenant, async () => {
    // 1. Locked: its users see the maintenance page from now on (src/proxy.ts).
    await takeLock(runId);
    // The lock's time renewed (a long restore outlives LOCK_STALE_AFTER_MS) and the run's heartbeat. The last renewal is
    // awaited before the lock is released or held, so a late one can never put back a lock just taken away.
    let beating: Promise<unknown> = Promise.resolve();
    const beat = setInterval(() => {
      beating = Promise.all([takeLock(runId).catch(() => {}), controlDb().restoreRun.update({ where: { id: runId }, data: { beatAt: new Date() } }).catch(() => {})]);
    }, RESTORE_HEARTBEAT_MS);
    const stopBeating = async () => {
      clearInterval(beat);
      await beating;
    };
    beat.unref?.();
    await log.say("lock", `${tenant.slug} is closed to its users while it is restored (they see the maintenance page).`);

    let safety: { id: string; file: string; snapshot: string } | null = null;
    const state = { changed: false };
    const done: { keys: string | null; rows: AppliedRow[] | null } = {
      keys: null,
      rows: null,
    };
    try {
      // 2. The safety copy — no copy, no restore.
      await log.say("safety", "Taking a safety copy of the workspace as it is now…");
      const copy = await runBackup({
        kind: "FULL",
        triggeredById: null,
        reason: `Before restoring ${source.label}`,
        keepUntil: new Date(Date.now() + SAFETY_COPY_DAYS * 86_400_000),
      });
      if (!copy.ok) throw new RestoreRefused(`A safety copy of the workspace couldn't be taken, so nothing was restored and nothing has been changed: ${copy.error}`);
      const file = path.join(await backupRoot(), copy.filename);
      const snapshot = `${file}.control.json`;
      try {
        await writeFile(snapshot, await sealedSnapshot(tenant.id), {
          mode: 0o600,
        });
      } catch (err) {
        throw new RestoreRefused(`The workspace's control-plane records couldn't be saved beside the safety copy, so nothing was restored and nothing has been changed: ${message(err)}`);
      }
      safety = { id: copy.id, file, snapshot };
      await controlDb().restoreRun.update({
        where: { id: runId },
        data: { safetyBackupId: copy.id, safetyPath: file },
      });
      await log.say("safety", `Safety copy taken: ${copy.filename} (kept ${SAFETY_COPY_DAYS} days), with its control-plane records beside it (${path.basename(snapshot)}).`);
      const oldKeys =
        (
          await controlDb().tenant.findUnique({
            where: { id: tenant.id },
            select: { keyBundleCipher: true },
          })
        )?.keyBundleCipher ?? null;

      // 3 and 4. The database, then the files, as they come out of the bundle.
      const got: { control: Buffer | null } = { control: null };
      let files = 0;
      await readBundle(source.file, passphrase, async (name, content) => {
        const entry = name.startsWith(base) ? classify(name, tenant.id) : null;
        if (!entry) return;
        if (entry.what === "db") {
          const staged = path.join(work, "db.dump");
          await log.say("database", "Taking the database out of the backup and checking it against its manifest…");
          await writeEntry(name, content, staged, expected.get(name));
          await log.say("database", "Clearing the current database and putting the backup's in its place…");
          state.changed = true;
          await clearSchema(db);
          await db.$disconnect().catch(() => {});
          await withoutRoleLimits(role, () => restoreDumpFile(tool, staged, connection));
          await rm(staged, { force: true });
          faultAt("workspace:after-restore");
          await clearOwnReferenceCopy(db);
          await log.say("database", "Bringing the database up to this version…");
          await migrateDeploy(tenant.dbUrl);
          faultAt("workspace:after-migrate");
          await endEverySignIn(db);
          await log.say("database", "Database restored and migrated; every sign-in it carried has ended.");
          return;
        }
        if (entry.what === "control") {
          const chunks: Buffer[] = [];
          const hash = createHash("sha256");
          for await (const c of content) {
            chunks.push(c as Buffer);
            hash.update(c as Buffer);
          }
          got.control = Buffer.concat(chunks);
          if (hash.digest("hex") !== expected.get(name)?.sha256) throw new BundleFormatError(`${name} is not what the backup held when it was checked.`);
          return;
        }
        if (!state.changed) throw new BundleFormatError("The backup's files come before its database — it was not made by this app.");
        if (await writeWorkspaceFile(entry, tenant.id, name, content, expected.get(name), work, null, null)) files += 1;
      });
      if (!state.changed) throw new RestoreRefused("The backup's database never came — nothing was changed.");
      forgetRememberedFiles();
      await log.say("files", `${files} file${files === 1 ? "" : "s"} written back (files already there and not in the backup are kept).`);
      faultAt("workspace:after-files");

      // 5. Its keys: the restored data was written under the backup's.
      const bundleTenant = checked.control?.models?.Tenant?.[0] ?? null;
      const bundleKeys = typeof bundleTenant?.keyBundleCipher === "string" ? bundleTenant.keyBundleCipher : null;
      if (bundleKeys && bundleKeys !== oldKeys) {
        await controlDb().$transaction(async (tx) => {
          await tx.tenant.update({
            where: { id: tenant.id },
            data: { keyBundleCipher: bundleKeys },
          });
          await tx.platformAuditLog.create({
            data: {
              actorKind: "SYSTEM",
              actor: "restore",
              action: "tenant.keys.from-backup",
              tenantId: tenant.id,
              detail: { restoreRunId: runId },
            },
          });
        });
        done.keys = oldKeys;
        forgetRegistry();
        await log.say("keys", "The backup was made under different keys for this workspace; its keys were installed (audited).");
      } else {
        await log.say("keys", "The workspace's keys are the backup's already.");
      }
      faultAt("workspace:after-keys");

      // 6. Its plan, billing and settings records — only when asked: on this server they are live.
      if (options.putBackControlRows) {
        if (!got.control || !checked.control) throw new RestoreRefused("The backup has no control-plane records for this workspace to put back.");
        const file = checked.control;
        try {
          const applied = await controlDb().$transaction((tx) => upsertWorkspaceRows(tx as never, file), { timeout: 10 * 60_000, maxWait: 60_000 });
          done.rows = applied.inserted;
          for (const note of applied.notes) await log.say("records", note);
        } catch (err) {
          throw new Error(`Its plan, billing and settings records couldn't be put back: ${describeWriteError(err)}`);
        }
        await controlDb().platformAuditLog.create({
          data: {
            actorKind: "SYSTEM",
            actor: "restore",
            action: "restore.control-rows",
            tenantId: tenant.id,
            detail: { restoreRunId: runId, inserted: done.rows.length },
          },
        });
        await refreshEntitlements(tenant.id);
        await log.say("records", `Its plan, billing and settings records were put back from the backup (${done.rows.length} added, the rest updated; audited).`);
      } else {
        await log.say("records", "Its plan, billing and settings records on this server were left as they are.");
      }
      faultAt("workspace:after-control-rows");

      // 7. What lives beside the database, brought in line; then open again.
      forgetRegistry();
      const fresh = (await tenantById(tenant.id)) ?? tenant;
      const problems = await runAsTenant(fresh, () => afterRestoreChores((m) => void log.say("after", m)));
      if (!problems.length) await log.say("after", "Backup list, sign-in index, device routes, Automate and seats brought in line.");
      await stopBeating();
      await releaseLock();
      await log.say("done", `${tenant.slug} is restored and open again. Everybody signs in again.`);
      await finishRow(runId, "SUCCEEDED", log);
      await rm(work, { recursive: true, force: true }).catch(() => {});
      return {
        status: "SUCCEEDED",
        error: null,
        mode: "IN_PLACE",
        log: log.lines,
      };
    } catch (err) {
      await stopBeating();
      const why = err instanceof RestoreRefused || err instanceof BundleFormatError ? err.message : `The restore failed: ${message(err)}`;
      if (!state.changed && !done.keys && !done.rows) {
        await releaseLock();
        await log.say("failed", why);
        await finishRow(runId, "FAILED", log, { error: why });
        await rm(work, { recursive: true, force: true }).catch(() => {});
        return {
          status: "FAILED",
          error: why,
          mode: "IN_PLACE",
          log: log.lines,
        };
      }
      return rollBackInPlace(runId, tenant, tool, connection, role, safety!, done, why, log, work);
    }
  });
}

/** Puts a workspace back exactly as it was before the restore: its database from the safety copy, keys, records. */
async function rollBackInPlace(
  runId: string,
  tenant: Tenant,
  tool: DumpTool,
  connection: NonNullable<ReturnType<typeof parseDatabaseUrl>>,
  role: string | null,
  safety: { id: string; file: string; snapshot: string },
  done: { keys: string | null; rows: AppliedRow[] | null },
  why: string,
  log: Log,
  work: string,
): Promise<RestoreOutcome> {
  await log.say("rollback", `${why} Putting the workspace back as it was before the restore…`);
  const left: string[] = [];
  try {
    const opened = path.join(work, "safety.dump");
    await openBackupFileTo(tenant.id, safety.file, opened);
    await clearSchema(db);
    await db.$disconnect().catch(() => {});
    await withoutRoleLimits(role, () => restoreDumpFile(tool, opened, connection));
    await rm(opened, { force: true });
    await log.say("rollback", "The database is back as it was, from the safety copy.");
  } catch (err) {
    left.push(`the database could not be put back from the safety copy (${message(err)})`);
  }
  if (done.keys) {
    try {
      const oldKeys = done.keys;
      await controlDb().$transaction(async (tx) => {
        await tx.tenant.update({
          where: { id: tenant.id },
          data: { keyBundleCipher: oldKeys },
        });
        await tx.platformAuditLog.create({
          data: {
            actorKind: "SYSTEM",
            actor: "restore",
            action: "tenant.keys.restored",
            tenantId: tenant.id,
            detail: {
              restoreRunId: runId,
              why: "the restore failed and was put back",
            },
          },
        });
      });
      forgetRegistry();
      await log.say("rollback", "Its keys are back as they were.");
    } catch (err) {
      left.push(`its keys could not be put back (${message(err)})`);
    }
  }
  if (done.rows) {
    try {
      const snapshot = decodeControlRows(openBuffer(tenant.id, await readFile(safety.snapshot), "file"));
      const inserted = done.rows;
      await controlDb().$transaction((tx) => putBackSnapshot(tx as never, snapshot, inserted), { timeout: 10 * 60_000, maxWait: 60_000 });
      await refreshEntitlements(tenant.id).catch(() => {});
      await log.say("rollback", "Its plan, billing and settings records are back as they were.");
    } catch (err) {
      left.push(`its plan, billing and settings records could not be put back (${message(err)}) — they are saved in ${safety.snapshot}`);
    }
  }
  await rm(work, { recursive: true, force: true }).catch(() => {});
  if (!left.length) {
    await afterRestoreChores(() => {}).catch(() => []);
    await releaseLock();
    const error = `${why}\nNothing was lost: the workspace was put back as it was just before the restore started, from the safety copy ${path.basename(safety.file)}.`;
    await log.say("rolled-back", "Put back as it was. The workspace is open again.");
    await finishRow(runId, "ROLLED_BACK", log, { error });
    return { status: "ROLLED_BACK", error, mode: "IN_PLACE", log: log.lines };
  }
  const error = `${why}\nPutting it back failed too: ${left.join("; ")}. The workspace stays closed. To recover, restore the safety copy ${path.basename(safety.file)} (backup ${safety.id}, at ${safety.file}) with npm run db:restore -- --workspace ${tenant.slug} "${safety.file}" --i-understand-this-replaces-everything, then remove ${path.join(path.dirname(safety.file), ".restore", "restore.lock")}.`;
  await holdLock(runId, "a restore failed and could not be put back").catch(() => {});
  await log.say("failed", error);
  await finishRow(runId, "FAILED", log, { error });
  return { status: "FAILED", error, mode: "IN_PLACE", log: log.lines };
}

async function refuseRun(runId: string, log: Log, why: string): Promise<RestoreOutcome> {
  await log.say("checks", `Refused: ${why}`);
  await finishRow(runId, "FAILED", log, { error: why });
  return { status: "FAILED", error: why, mode: null, log: log.lines };
}

// ─── A workspace this server hasn't got ──────────────────────────────────────────────────────────

async function restoreAsNew(runId: string, source: RestoreSource, passphrase: string, checked: Checked, log: Log): Promise<RestoreOutcome> {
  const tenantId = checked.tenantId!;
  const base = `workspaces/${tenantId}/`;
  const expected = new Map(checked.manifest.entries.map((e) => [e.name, e]));
  const tool = await resolveDumpTool("pg_restore");
  if (!tool) return refuseRun(runId, log, "pg_restore could not be found. Install the Postgres client tools or set PG_DUMP_PATH. Nothing has been changed.");
  const work = path.join(platformRestoreDir(), runId);
  await mkdir(work, { recursive: true, mode: 0o700 });
  const beat = setInterval(
    () =>
      void controlDb()
        .restoreRun.update({
          where: { id: runId },
          data: { beatAt: new Date() },
        })
        .catch(() => {}),
    RESTORE_HEARTBEAT_MS,
  );
  beat.unref?.();

  const st: { made: WorkspaceDatabase | null; inserted: AppliedRow[] | null } = { made: null, inserted: null };
  const written: Written = [];
  const disk: string[] = [];
  const bundleTenant = checked.control!.models.Tenant![0]!;
  const finalStatus = String(bundleTenant.status ?? "ACTIVE");
  try {
    let files = 0;
    await readBundle(source.file, passphrase, async (name, content) => {
      const entry = name.startsWith(base) ? classify(name, tenantId) : null;
      if (!entry) return;
      if (entry.what === "db") {
        const staged = path.join(work, "db.dump");
        await log.say("database", "Taking the database out of the backup and checking it against its manifest…");
        await writeEntry(name, content, staged, expected.get(name));
        const made = await createWorkspaceDatabase();
        st.made = made;
        await log.say("database", `A new database made for it on this server (${made.dbName}); putting the backup's in it…`);
        const connection = parseDatabaseUrl(made.url)!;
        const role = made.dbRole;
        await withoutRoleLimits(role, () => restoreDumpFile(tool, staged, connection));
        await rm(staged, { force: true });
        const direct = directClient(made.url, { max: 1 });
        try {
          await clearOwnReferenceCopy(direct);
          await log.say("database", "Bringing the database up to this version…");
          await migrateDeploy(made.url);
          await endEverySignIn(direct);
        } finally {
          await direct.$disconnect().catch(() => {});
        }
        await log.say("database", "Database restored and migrated; every sign-in it carried has ended.");
        return;
      }
      if (entry.what === "control") {
        const madeDb = st.made;
        if (!madeDb) throw new BundleFormatError("The backup's records come before its database — it was not made by this app.");
        const hash = createHash("sha256");
        for await (const c of content) hash.update(c as Buffer);
        if (hash.digest("hex") !== expected.get(name)?.sha256) throw new BundleFormatError(`${name} is not what the backup held when it was checked.`);
        const tenant = {
          status: "PROVISIONING",
          isDefault: false,
          dbUrlCipher: sealForTenant(tenantId, "db-url", madeDb.url),
          dbName: madeDb.dbName,
          dbRole: madeDb.dbRole,
          schemaVersion: latestMigrationName(),
          suspendedFor: null,
          suspendedAt: null,
        };
        try {
          const applied = await controlDb().$transaction((tx) => insertWorkspaceRows(tx as never, checked.control!, tenant), { timeout: 10 * 60_000, maxWait: 60_000 });
          st.inserted = applied.inserted;
          for (const note of applied.notes) await log.say("records", note);
        } catch (err) {
          throw new Error(`Its records couldn't be added to this server's control plane: ${describeWriteError(err)}`);
        }
        await log.say("records", `Its records added to this server's control plane: the workspace, its plans, subscription, invoices and domains (${st.inserted.length} rows).`);
        faultAt("as-new:after-control-rows");
        return;
      }
      if (!st.made) throw new BundleFormatError("The backup's files come before its database — it was not made by this app.");
      if (await writeWorkspaceFile(entry, tenantId, name, content, expected.get(name), work, written, disk)) files += 1;
    });
    if (!st.made || !st.inserted) throw new RestoreRefused("The backup's database or records never came — nothing was kept.");
    await log.say("files", `${files} file${files === 1 ? "" : "s"} written into this server's storage.`);

    await controlDb().tenant.update({
      where: { id: tenantId },
      data: {
        status: finalStatus as "ACTIVE",
        ...(finalStatus === "SUSPENDED"
          ? {
              suspendedFor: (bundleTenant.suspendedFor as "STAFF" | "BILLING" | null) ?? "STAFF",
              suspendedAt: new Date(),
            }
          : {}),
      },
    });
    await controlDb().platformAuditLog.create({
      data: {
        actorKind: "SYSTEM",
        actor: "restore",
        action: "restore.workspace-added",
        tenantId,
        detail: { restoreRunId: runId, slug: checked.slug },
      },
    });
    forgetRegistry();
    await refreshEntitlements(tenantId);
    const tenant = await tenantById(tenantId);
    if (tenant) await runAsTenant(tenant, () => afterRestoreChores((m) => void log.say("after", m)));
    clearInterval(beat);
    await log.say("done", `${checked.slug} is on this server now${finalStatus === "ACTIVE" ? " and open" : ` (${finalStatus.toLowerCase()}, as it was in the backup)`}. Everybody signs in again.`);
    await finishRow(runId, "SUCCEEDED", log);
    await rm(work, { recursive: true, force: true }).catch(() => {});
    return { status: "SUCCEEDED", error: null, mode: "AS_NEW", log: log.lines };
  } catch (err) {
    clearInterval(beat);
    const why = err instanceof RestoreRefused || err instanceof BundleFormatError ? err.message : `The restore failed: ${message(err)}`;
    const left: string[] = [];
    const madeDb = st.made;
    const rows = st.inserted;
    if (rows) {
      await controlDb()
        .$transaction((tx) => removeInserted(tx as never, rows), {
          timeout: 10 * 60_000,
          maxWait: 60_000,
        })
        .catch((e: unknown) => left.push(`its records in the control plane could not be removed (${describeWriteError(e)})`));
    }
    if (madeDb) await dropWorkspaceDatabase(madeDb.dbName, madeDb.dbRole).catch((e: unknown) => left.push(`its new database ${madeDb.dbName} could not be dropped (${message(e)})`));
    for (const w of written) await w.store.remove(w.key).catch(() => {});
    for (const f of disk) await rm(f, { force: true }).catch(() => {});
    forgetRegistry();
    await rm(work, { recursive: true, force: true }).catch(() => {});
    if (!madeDb && !rows) {
      await log.say("failed", why);
      await finishRow(runId, "FAILED", log, { error: why });
      return { status: "FAILED", error: why, mode: "AS_NEW", log: log.lines };
    }
    if (!left.length) {
      const error = `${why}\nNothing was kept: the new database was dropped and the records and files it added were removed.`;
      await log.say("rolled-back", "Everything it added was taken away again.");
      await finishRow(runId, "ROLLED_BACK", log, { error });
      return { status: "ROLLED_BACK", error, mode: "AS_NEW", log: log.lines };
    }
    const error = `${why}\nTaking it away again failed too: ${left.join("; ")}. Remove those by hand (the workspace's id is ${tenantId}).`;
    await log.say("failed", error);
    await finishRow(runId, "FAILED", log, { error });
    return { status: "FAILED", error, mode: "AS_NEW", log: log.lines };
  }
}

// ─── The whole application ───────────────────────────────────────────────────────────────────────

const controlUrl = () => process.env.CONTROL_DATABASE_URL!.trim();

/** Where the control plane's safety dump goes before a full restore. */
export const controlSafetyFile = (runId: string) => path.join(path.dirname(platformRestoreDir()), "restore-safety", runId, "control.dump");

/**
 * The control plane put back from a dump of it sealed under CONTROL_SEAL — a full restore's rollback, and by hand
 * (`npm run bundle -- put-back-control <run id>`) when that rollback could not.
 */
export async function putBackControlPlane(sealed: string, work: string): Promise<void> {
  const tool = await resolveDumpTool("pg_restore");
  if (!tool) throw new Error("pg_restore could not be found.");
  const connection = parseDatabaseUrl(controlUrl());
  if (!connection) throw new Error("CONTROL_DATABASE_URL is not a Postgres URL.");
  await mkdir(work, { recursive: true, mode: 0o700 });
  const opened = path.join(work, `control-safety-${process.pid}.dump`);
  await openBackupFileTo(CONTROL_SEAL, sealed, opened);
  try {
    await closeControlDb();
    const direct = directClient(controlUrl(), { max: 1 });
    try {
      await clearSchema(direct);
    } finally {
      await direct.$disconnect().catch(() => {});
    }
    await restoreDumpFile(tool, opened, connection);
  } finally {
    await rm(opened, { force: true }).catch(() => {});
    forgetStorageBoxSettings();
    forgetRegistry();
  }
}

type WsState = {
  id: string;
  slug: string;
  made: WorkspaceDatabase | null;
  restored: boolean;
  failed: string | null;
  files: number;
  skipped: boolean;
};

async function restoreFull(runId: string, source: RestoreSource, passphrase: string, file: ReturnType<typeof fileLog>, staff: { id: string | null; label: string }): Promise<RestoreOutcome> {
  const log = file;
  const run = file.run;
  // The application's "closed" marker renewed; the last renewal awaited before it is removed (or held), so a late one
  // can never close the application again after the restore has finished.
  let beating: Promise<unknown> = Promise.resolve();
  const beat = setInterval(() => {
    beating = writeActive(runId, run.startedAt, false).catch(() => {});
  }, RESTORE_HEARTBEAT_MS);
  beat.unref?.();
  const work = path.join(platformRestoreDir(), runId);
  const finish = async (state: FullRestoreState, error: string | null, held = false) => {
    clearInterval(beat);
    await beating;
    run.state = state;
    run.error = error;
    run.finishedAt = new Date().toISOString();
    run.step = "done";
    await file.save();
    if (held) await writeActive(runId, run.startedAt, true).catch(() => {});
    else await clearActive(runId);
    await rm(work, { recursive: true, force: true }).catch(() => {});
  };
  /** The run's row in whichever control plane is there now: the one it started on (refused, rolled back), or the restored one. */
  const writeRow = async (status: RestoreStatusValue, error: string | null) => {
    await controlDb().restoreRun.upsert({
      where: { id: runId },
      create: {
        id: runId,
        kind: "FULL",
        backupId: source.backupId,
        status,
        log: run.log,
        safetyPath: run.safetyPath,
        outcomes: (run.outcomes ?? undefined) as object | undefined,
        mode: "FULL",
        startedById: staff.id,
        startedAt: new Date(run.startedAt),
        finishedAt: new Date(),
        error,
      },
      update: {
        status,
        log: run.log,
        safetyPath: run.safetyPath,
        outcomes: (run.outcomes ?? undefined) as object | undefined,
        mode: "FULL",
        finishedAt: new Date(),
        error,
      },
    });
  };

  // 1. The checks.
  await file.step("checks");
  let checked: Checked;
  try {
    checked = await precheck("full", source, passphrase, runId, (m) => log.say("checks", m));
  } catch (err) {
    const why = err instanceof RestoreRefused ? err.message : `The checks could not be finished: ${message(err)}. Nothing has been changed.`;
    await log.say("checks", `Refused: ${why}`);
    await writeRow("FAILED", why).catch(() => {});
    await finish("failed", why);
    return { status: "FAILED", error: why, mode: "FULL", log: run.log };
  }
  const tool = await resolveDumpTool("pg_restore");
  const dumpTool = await resolveDumpTool("pg_dump");
  const controlConnection = parseDatabaseUrl(controlUrl());
  if (!tool || !dumpTool || !controlConnection) {
    const why = "pg_dump and pg_restore are both needed, and CONTROL_DATABASE_URL must be a Postgres URL. Nothing has been changed.";
    await log.say("checks", `Refused: ${why}`);
    await writeRow("FAILED", why).catch(() => {});
    await finish("failed", why);
    return { status: "FAILED", error: why, mode: "FULL", log: run.log };
  }
  const states = new Map<string, WsState>(
    checked.header.workspaces.map((w) => [
      w.id,
      {
        id: w.id,
        slug: w.slug,
        made: null,
        restored: false,
        failed: null,
        files: 0,
        skipped: false,
      },
    ]),
  );
  run.total = states.size;
  await log.say(
    "checks",
    `Checked: the backup is sound, made under this server's PLATFORM_MASTER_KEY, from ${checked.header.createdAt.slice(0, 16).replace("T", " ")} UTC, with ${states.size} workspace${states.size === 1 ? "" : "s"}.`,
  );
  if (checked.existing.length) {
    await log.say(
      "checks",
      `This server is not a fresh install: it holds ${checked.existing.length} workspace${checked.existing.length === 1 ? "" : "s"} already. Their databases are left untouched; the restored workspaces get new ones.`,
    );
  }
  await log.say("checks", `Started by ${staff.label}. Their session ends when the control plane is replaced; afterwards sign in with a staff account from the backup.`);

  // 1b. The safety copy of this server's control plane — always, even on a fresh install, so a rollback is exact.
  await file.step("safety");
  const safetyFile = controlSafetyFile(runId);
  try {
    await mkdir(path.dirname(safetyFile), { recursive: true, mode: 0o700 });
    run.safetyPath = safetyFile;
    await file.save();
    await controlDb()
      .restoreRun.update({
        where: { id: runId },
        data: { safetyPath: safetyFile, mode: "FULL", beatAt: new Date() },
      })
      .catch(() => {});
    await dump(dumpTool, controlConnection, safetyFile, 6, CONTROL_SEAL);
    if ((await stat(safetyFile)).size < 1024) throw new Error("the dump is too small to be a whole database");
  } catch (err) {
    const why = `A safety copy of this server's control plane couldn't be taken, so nothing was restored and nothing has been changed: ${message(err)}`;
    await log.say("safety", why);
    await writeRow("FAILED", why).catch(() => {});
    await finish("failed", why);
    return { status: "FAILED", error: why, mode: "FULL", log: run.log };
  }
  await log.say("safety", `Safety copy of this server's control plane taken: ${safetyFile} (encrypted under this server's key).`);

  // 2. This server's own settings, which survive the restore.
  const kept = await controlDb().platformSetting.findMany({
    where: { key: { in: [...SERVER_SETTINGS] } },
  });
  const bundleRow = source.backupId
    ? await controlDb().platformBackup.findUnique({
        where: { id: source.backupId },
      })
    : null;
  const untouched = checked.existing.map((t) => ({
    id: t.id,
    slug: t.slug,
    database: t.dbName,
  }));
  await log.say(
    "settings",
    kept.length ? `Kept from this server: ${kept.map((k) => k.key).join(", ")}.` : "This server has no storage box or off-site store set in the console; it uses its environment's, if any.",
  );

  const progress: {
    replaced: boolean;
    inventory: { settings?: Record<string, boolean> } | null;
  } = { replaced: false, inventory: null };
  const expected = new Map(checked.manifest.entries.map((e) => [e.name, e]));
  try {
    await mkdir(work, { recursive: true, mode: 0o700 });
    const markFailed = async (ws: WsState, err: unknown) => {
      if (ws.failed) return;
      ws.failed = err instanceof RestoreRefused || err instanceof BundleFormatError ? err.message : message(err);
      ws.restored = false;
      if (ws.made) await dropWorkspaceDatabase(ws.made.dbName, ws.made.dbRole).catch(() => {});
      ws.made = null;
      await controlDb()
        .tenant.updateMany({
          where: { id: ws.id },
          data: {
            dbUrlCipher: null,
            dbName: null,
            dbRole: null,
            status: "SUSPENDED",
            suspendedFor: "STAFF",
            suspendedAt: new Date(),
          },
        })
        .catch(() => {});
      await log.say("workspaces", `${ws.slug} could not be restored and is left suspended: ${ws.failed}`);
    };

    await readBundle(source.file, passphrase, async (name, content) => {
      if (name === "control/control.dump") {
        // 3. The control plane replaced.
        await file.step("control");
        const staged = path.join(work, "control.dump");
        await writeEntry(name, content, staged, expected.get(name));
        await log.say("control", "Replacing the control plane with the backup's…");
        progress.replaced = true;
        await closeControlDb();
        const direct = directClient(controlUrl(), { max: 1 });
        try {
          await clearSchema(direct);
          await restoreDumpFile(tool, staged, controlConnection);
          // At once: every workspace's sealed address names the old server's databases, which this server must never
          // reach. They are given this server's as each workspace is restored below.
          await direct.$executeRawUnsafe(`UPDATE "tenants" SET "dbUrlCipher" = NULL, "dbName" = NULL, "dbRole" = NULL`);
        } finally {
          await direct.$disconnect().catch(() => {});
        }
        await rm(staged, { force: true });
        faultAt("full:after-control-restore");
        await log.say("control", "Bringing the control plane up to this version…");
        await migrateDeploy(controlUrl(), "control");
        await log.say("control", "The control plane is the backup's now, at this version.");

        // 4. This server's settings back; what belongs to the old server cleared.
        await file.step("settings");
        await applyServerSettings(kept, log);
        await clearOldServer(runId, bundleRow, log);
        faultAt("full:after-settings");
        forgetStorageBoxSettings();
        forgetRegistry();
        await file.step("workspaces");
        return;
      }
      if (name === "platform/inventory.json") {
        const chunks: Buffer[] = [];
        for await (const c of content) chunks.push(c as Buffer);
        try {
          progress.inventory = JSON.parse(Buffer.concat(chunks).toString("utf8")) as { settings?: Record<string, boolean> };
        } catch {
          progress.inventory = null;
        }
        return;
      }
      const m = /^workspaces\/([^/]+)\//.exec(name);
      const ws = m ? states.get(m[1]!) : undefined;
      if (!ws) return;
      if (!progress.replaced) throw new BundleFormatError("The backup's workspaces come before its control plane — it was not made by this app.");
      if (ws.failed) return;
      const entry = classify(name, ws.id)!;
      try {
        if (entry.what === "db") {
          // 5. A new database for it, here.
          const staged = path.join(work, "db.dump");
          await writeEntry(name, content, staged, expected.get(name));
          ws.made = await createWorkspaceDatabase();
          const connection = parseDatabaseUrl(ws.made.url)!;
          const made = ws.made;
          await withoutRoleLimits(made.dbRole, () => restoreDumpFile(tool, staged, connection));
          await rm(staged, { force: true });
          const direct = directClient(made.url, { max: 1 });
          try {
            await clearOwnReferenceCopy(direct);
            await migrateDeploy(made.url);
            await endEverySignIn(direct);
          } finally {
            await direct.$disconnect().catch(() => {});
          }
          faultAt(`full:workspace:${ws.slug}`);
          await controlDb().tenant.update({
            where: { id: ws.id },
            data: {
              dbUrlCipher: sealForTenant(ws.id, "db-url", made.url),
              dbName: made.dbName,
              dbRole: made.dbRole,
              schemaVersion: latestMigrationName(),
            },
          });
          ws.restored = true;
          await log.say("workspaces", `${ws.slug}: database restored into ${made.dbName} and migrated.`);
          return;
        }
        if (entry.what === "control" || entry.what === "other") return; // its records are in the control plane's dump
        if (!ws.restored) throw new BundleFormatError(`${ws.slug}'s files come before its database.`);
        if (await writeWorkspaceFile(entry, ws.id, name, content, expected.get(name), work, null, null)) ws.files += 1;
      } catch (err) {
        await markFailed(ws, err);
      }
    });

    // Each workspace finished: counted, its files said, the ones the backup had no database for named.
    for (const ws of states.values()) {
      if (ws.restored && !ws.failed) {
        run.done += 1;
        await log.say("workspaces", `${ws.slug}: ${ws.files} file${ws.files === 1 ? "" : "s"} written into this server's storage.`);
      } else if (!ws.failed && !ws.made) {
        // Still being set up when the backup was made: nothing to restore, and nothing wrong.
        ws.skipped = true;
        run.done += 1;
        await log.say("workspaces", `${ws.slug}: the backup has no database for it (it had none when the backup was made); its record is kept as it was.`);
      }
    }
    await file.save();
    faultAt("full:before-finish");
    if (states.size > 0 && ![...states.values()].some((w) => w.restored && !w.failed)) throw new Error("No workspace could be restored.");
  } catch (err) {
    const why = err instanceof RestoreRefused || err instanceof BundleFormatError ? err.message : `The restore failed: ${message(err)}`;
    if (!progress.replaced) {
      await log.say("failed", `${why} Nothing has been changed.`);
      await writeRow("FAILED", `${why} Nothing has been changed.`).catch(() => {});
      await finish("failed", `${why} Nothing has been changed.`);
      return { status: "FAILED", error: why, mode: "FULL", log: run.log };
    }
    // 8. Back to this server as it was: the new databases dropped, the control plane from the safety copy.
    await file.step("rolling-back");
    await log.say("rolling-back", `${why} Putting this server back as it was…`);
    for (const ws of states.values()) if (ws.made) await dropWorkspaceDatabase(ws.made.dbName, ws.made.dbRole).catch(() => {});
    try {
      await putBackControlPlane(safetyFile, work);
      const error = `${why}\nNothing was lost: this server was put back as it was just before the restore, from the safety copy ${safetyFile}.`;
      await log.say("rolled-back", "This server is back as it was before the restore.");
      run.outcomes = {
        workspaces: [...states.values()].map((w) => ({
          id: w.id,
          slug: w.slug,
          ok: false,
          error: w.failed,
        })),
        untouched,
      };
      await writeRow("ROLLED_BACK", error).catch(() => {});
      await finish("rolled-back", error);
      return { status: "ROLLED_BACK", error, mode: "FULL", log: run.log };
    } catch (back) {
      const error = `${why}\nPutting the control plane back failed too: ${message(back)}. The application stays closed. To recover, put the control plane back from the safety copy with: npm run bundle -- put-back-control ${runId} --i-understand (it is ${safetyFile}).`;
      await log.say("failed", error);
      await finish("failed", error, true);
      return { status: "FAILED", error, mode: "FULL", log: run.log };
    }
  }

  // 6. Settled: the registry forgotten, each workspace's own chores, the reference data reloaded.
  await file.step("finishing");
  forgetRegistry();
  forgetRememberedFiles();
  for (const ws of states.values()) {
    if (!ws.restored || ws.failed) continue;
    const tenant = await tenantById(ws.id).catch(() => null);
    if (tenant) await runAsTenant(tenant, () => afterRestoreChores((m) => void log.say("after", `${ws.slug}: ${m}`))).catch(() => {});
  }
  await reloadReference(log);
  const env = progress.inventory?.settings;
  if (env) {
    const set = Object.entries(env)
      .filter(([k, v]) => v && !["PLATFORM_MASTER_KEY", "CONTROL_DATABASE_URL", "BACKUP_DIR", "LOG_DIR", "GEOIP_DIR"].includes(k))
      .map(([k]) => k);
    if (set.length) await log.say("finishing", `The old server had these set in its environment, which a backup never carries — set the ones this server needs by hand: ${set.join(", ")}.`);
  }
  const outcomes = {
    workspaces: [...states.values()].map((w) => ({
      id: w.id,
      slug: w.slug,
      ok: (w.restored || w.skipped) && !w.failed,
      error: w.failed,
      database: w.made?.dbName ?? null,
      ...(w.skipped ? { skipped: "no database in the backup" } : {}),
    })),
    untouched,
  };
  run.outcomes = outcomes;
  if (untouched.length)
    await log.say(
      "finishing",
      `This server's earlier workspaces' databases were left untouched; drop them when you no longer need them: ${untouched.map((u) => `${u.slug} (${u.database ?? "no database"})`).join(", ")}.`,
    );
  const failed = outcomes.workspaces.filter((w) => !w.ok);
  const state: FullRestoreState = failed.length ? "partial" : "succeeded";
  const error = failed.length ? `Partly restored: ${run.done} of ${states.size} workspaces. Not restored (left suspended): ${failed.map((w) => `${w.slug} — ${w.error}`).join("; ")}.` : null;
  await log.say("done", failed.length ? error! : "Done — the whole application is restored. Sign in with your staff account from the backup.");
  await controlDb()
    .platformAuditLog.create({
      data: {
        actorKind: "SYSTEM",
        actor: "restore",
        action: "restore.full",
        detail: {
          restoreRunId: runId,
          restored: run.done,
          of: states.size,
          by: staff.label,
        },
      },
    })
    .catch(() => {});
  try {
    await writeRow(failed.length ? "FAILED" : "SUCCEEDED", error);
  } catch (err) {
    await log.say("done", `The run's record could not be written into the restored control plane (${message(err)}); its log stays in ${runFilePath(runId)}.`);
  }
  await finish(state, error);
  return {
    status: failed.length ? "FAILED" : "SUCCEEDED",
    error,
    mode: "FULL",
    log: run.log,
  };
}

/** This server's storage box and off-site store put back over the backup's, which name the old server's. */
async function applyServerSettings(
  kept: {
    key: string;
    value: string | null;
    secretCipher: string | null;
    updatedBy: string | null;
  }[],
  log: Log,
): Promise<void> {
  const control = controlDb();
  const theirs = await control.platformSetting.findMany({
    where: { key: { in: [...SERVER_SETTINGS] } },
    select: { key: true, value: true, secretCipher: true },
  });
  const same = (k: string) => {
    const a = theirs.find((t) => t.key === k);
    const b = kept.find((t) => t.key === k);
    return (a?.value ?? null) === (b?.value ?? null) && (a?.secretCipher ?? null) === (b?.secretCipher ?? null);
  };
  const offsiteChanged = !["offsite.provider", "offsite.config", "offsite.secret"].every(same);
  await control.$transaction(async (tx) => {
    await tx.platformSetting.deleteMany({
      where: { key: { in: [...SERVER_SETTINGS] } },
    });
    await tx.platformSetting.createMany({
      data: kept.map((k) => ({
        key: k.key,
        value: k.value,
        secretCipher: k.secretCipher,
        updatedBy: k.updatedBy,
      })),
    });
  });
  const dropped = theirs.filter((t) => !kept.some((k) => k.key === t.key)).map((t) => t.key);
  if (dropped.length) await log.say("settings", `The backup's own ${dropped.join(", ")} named the old server's storage and were removed; this server keeps its own.`);
  if (offsiteChanged) {
    const cleared = await control.offsiteWorkspace.deleteMany({});
    await control.offsiteRun.updateMany({
      where: { status: "RUNNING" },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        error: "was running on the server the backup came from",
      },
    });
    await log.say(
      "settings",
      `The off-site store differs from the old server's: its record of what was off-site there was cleared (${cleared.count} workspace${cleared.count === 1 ? "" : "s"}); the next off-site run starts afresh.`,
    );
  }
}

/** Everything in the restored control plane that belongs to the server it came from. */
type BackupRecord = NonNullable<Awaited<ReturnType<ReturnType<typeof controlDb>["platformBackup"]["findUnique"]>>>;

async function clearOldServer(runId: string, bundleRow: BackupRecord | null, log: Log): Promise<void> {
  const c = controlDb();
  const sessions = (await c.platformSession.deleteMany({})).count;
  const cms = (await c.cmsSession.deleteMany({})).count;
  const partners = (await c.partnerSession.deleteMany({})).count;
  const leases = (await c.tenantJobLease.deleteMany({})).count;
  const warm = (await c.warmDatabase.deleteMany({})).count;
  await log.say(
    "settings",
    `Cleared from the old server: ${sessions} staff, ${cms} website-editor and ${partners} partner sign-ins; ${leases} job leases; ${warm} warm databases (they were the old server's).`,
  );
  let expired = 0;
  for (const b of await c.platformBackup.findMany({
    where: { status: { in: ["READY", "RUNNING"] } },
    select: { id: true, status: true, fileName: true },
  })) {
    const file = bundlePath(b.fileName);
    const here = file ? !!(await stat(file).catch(() => null))?.isFile() : false;
    if (b.status === "RUNNING")
      await c.platformBackup.update({
        where: { id: b.id },
        data: {
          status: "FAILED",
          finishedAt: new Date(),
          error: "was being made on the server the backup came from",
        },
      });
    else if (!here)
      await c.platformBackup.update({
        where: { id: b.id },
        data: { status: "EXPIRED" },
      });
    else continue;
    expired += 1;
  }
  if (expired) await log.say("settings", `${expired} backup record${expired === 1 ? "" : "s"} from the old server marked as gone (their files are not on this server).`);
  await c.restoreRun.updateMany({
    where: { status: "RUNNING", NOT: { id: runId } },
    data: {
      status: "FAILED",
      finishedAt: new Date(),
      error: "was running on the server the backup came from",
    },
  });
  if (
    bundleRow &&
    !(await c.platformBackup.findUnique({
      where: { id: bundleRow.id },
      select: { id: true },
    }))
  ) {
    // The backup this was restored from, listed in the restored control plane too.
    const { id, kind, tenantId, tenantSlug, status, source, fileName, sizeBytes, sha256, header, startedAt, finishedAt, expiresAt, verifiedAt, verifyOk } = bundleRow;
    await c.platformBackup
      .create({
        data: {
          id,
          kind,
          tenantId,
          tenantSlug,
          status,
          source,
          fileName,
          sizeBytes,
          sha256,
          header: (header ?? undefined) as object | undefined,
          startedAt,
          finishedAt,
          expiresAt,
          verifiedAt,
          verifyOk,
        },
      })
      .catch(() => {});
  }
}

/**
 * The reference database (PIN directory, world places) is never in a bundle: after a full restore it is loaded from
 * its source again — the committed PIN directory and GeoNames' public files — by the same detached workers the
 * console's Reference data page starts. Without REFERENCE_DATABASE_URL there is nothing to load; the log says how.
 */
let referenceLoader: ((log: Log) => Promise<void>) | null = null;
/** For the checks: what the reload does instead. Null puts the real one back. */
export function setReferenceReloaderForChecks(fake: ((log: Log) => Promise<void>) | null): void {
  referenceLoader = fake;
}
async function reloadReference(log: Log): Promise<void> {
  if (referenceLoader) return referenceLoader(log);
  if (!process.env.REFERENCE_DATABASE_URL?.trim()) {
    await log.say(
      "finishing",
      "No REFERENCE_DATABASE_URL here, so the reference data was not reloaded. Set it, then run: npm run reference:migrate && npm run db:reference && npm run db:geonames:download",
    );
    return;
  }
  try {
    const { spawn } = await import("node:child_process");
    const tsx = path.join(process.cwd(), "node_modules", "tsx", "dist", "cli.mjs");
    const child = spawn(process.execPath, [tsx, path.join(process.cwd(), "prisma", "reference", "load.ts")], {
      cwd: process.cwd(),
      detached: true,
      stdio: "ignore",
      env: { ...process.env },
    });
    child.once("error", () => {});
    child.unref();
    const { startWorldSync } = await import("@/lib/platform/reference-sync");
    const world = await startWorldSync("restore");
    await log.say(
      "finishing",
      `Reference data: the PIN directory is being loaded from its committed copy${world.ok ? ", and world places from GeoNames" : ` (world places: ${world.error})`} — in the background. If either doesn't finish, run: npm run db:reference && npm run db:geonames:download`,
    );
  } catch (err) {
    await log.say("finishing", `The reference data could not be reloaded from here (${message(err)}). Run: npm run db:reference && npm run db:geonames:download`);
  }
}

// ─── Running one ─────────────────────────────────────────────────────────────────────────────────

/** A new full restore's run file and the marker that closes the application, written before its worker starts. */
export async function openFullRestore(runId: string, backupId: string | null, startedById: string | null): Promise<void> {
  const startedAt = new Date().toISOString();
  const run: FullRestoreFile = {
    id: runId,
    state: "running",
    step: "checks",
    startedAt,
    finishedAt: null,
    done: 0,
    total: 0,
    log: [],
    error: null,
    safetyPath: null,
    outcomes: null,
    backupId,
    startedById,
  };
  await writeAtomic(runFilePath(runId), JSON.stringify(run, null, 2));
  await writeActive(runId, startedAt);
}

/** The run file of a full restore that never got going (its worker didn't start): closed, the application opened. */
export async function abandonFullRestore(runId: string, why: string): Promise<void> {
  try {
    const run = JSON.parse(await readFile(runFilePath(runId), "utf8")) as FullRestoreFile;
    run.state = "failed";
    run.error = why;
    run.finishedAt = new Date().toISOString();
    run.log.push({ at: run.finishedAt, step: "checks", message: why });
    await writeAtomic(runFilePath(runId), JSON.stringify(run, null, 2));
  } catch {
    // Nothing to close.
  }
  await clearActive(runId);
}

async function staffLabel(id: string | null): Promise<string> {
  if (!id) return "a script";
  const user = await controlDb()
    .platformUser.findUnique({
      where: { id },
      select: { name: true, email: true },
    })
    .catch(() => null);
  return user ? `${user.name} (${user.email})` : "a staff member";
}

/**
 * One restore, from its RestoreRun (made RUNNING by the console) — what scripts/restore-bundle-worker.ts runs, and
 * the checks run in-process. The passphrase is taken from its sealed handoff first, before anything can fail.
 */
export async function runRestoreJob(runId: string): Promise<RestoreOutcome> {
  const passphrase = await takePassphrase(runId, "restore");
  if (!controlConfigured()) throw new Error("No control plane: CONTROL_DATABASE_URL is not set.");
  const row = await controlDb().restoreRun.findUnique({ where: { id: runId } });
  if (!row || row.status !== "RUNNING")
    return {
      status: "FAILED",
      error: "That restore isn't waiting to run.",
      mode: null,
      log: [],
    };
  const options = ((row.outcomes as { options?: RestoreOptions } | null)?.options ?? {}) as RestoreOptions;
  const backup = row.backupId
    ? await controlDb().platformBackup.findUnique({
        where: { id: row.backupId },
      })
    : null;
  const file = backup ? bundlePath(backup.fileName) : null;
  const source: RestoreSource = {
    file: file ?? "",
    backupId: row.backupId,
    expectedSha256: backup?.sha256 ?? null,
    label: backup?.fileName ?? "a backup",
  };
  const kind: RestoreKind = row.kind === "FULL" ? "full" : "workspace";
  if (!passphrase) {
    const why = "The passphrase did not reach the restore — it is only kept for a few minutes. Start the restore again. Nothing has been changed.";
    if (kind === "full") await abandonFullRestore(runId, why);
    const log = rowLog(runId, Array.isArray(row.log) ? (row.log as RestoreLogLine[]) : []);
    return refuseRun(runId, log, why);
  }
  if (!backup || backup.status !== "READY" || !file) {
    const why = "The backup is no longer ready on this server (it expired, was deleted, or its file is gone). Upload it again. Nothing has been changed.";
    if (kind === "full") await abandonFullRestore(runId, why);
    return refuseRun(runId, rowLog(runId), why);
  }
  return runRestore(runId, kind, source, passphrase, options, row.startedById);
}

/** The restore itself, once its run exists — shared by the worker and the script. */
async function runRestore(
  runId: string,
  kind: RestoreKind,
  source: RestoreSource,
  passphrase: string,
  options: RestoreOptions,
  startedById: string | null,
  scriptLabel?: string,
): Promise<RestoreOutcome> {
  const label = scriptLabel ?? (await staffLabel(startedById));
  if (kind === "full") {
    let run: FullRestoreFile;
    try {
      run = JSON.parse(await readFile(runFilePath(runId), "utf8")) as FullRestoreFile;
    } catch {
      await openFullRestore(runId, source.backupId, startedById);
      run = JSON.parse(await readFile(runFilePath(runId), "utf8")) as FullRestoreFile;
    }
    await writeActive(runId, run.startedAt);
    return restoreFull(runId, source, passphrase, fileLog(run), {
      id: startedById,
      label,
    });
  }
  const row = await controlDb().restoreRun.findUnique({
    where: { id: runId },
    select: { log: true },
  });
  const log = rowLog(runId, Array.isArray(row?.log) ? (row!.log as RestoreLogLine[]) : []);
  await log.say("checks", `Restoring ${source.label}, started by ${label}. Checking it before anything is changed…`);
  let checked: Checked;
  try {
    checked = await precheck("workspace", source, passphrase, runId, (m) => log.say("checks", m));
  } catch (err) {
    return refuseRun(runId, log, err instanceof RestoreRefused ? err.message : `The checks could not be finished: ${message(err)}. Nothing has been changed.`);
  }
  await controlDb().restoreRun.update({
    where: { id: runId },
    data: {
      mode: checked.mode,
      tenantId: checked.tenantId,
      tenantSlug: checked.slug,
    },
  });
  await log.say(
    "checks",
    checked.mode === "IN_PLACE"
      ? `Checked: the backup is sound. ${checked.slug} is on this server, so it is restored in place.`
      : `Checked: the backup is sound. ${checked.slug} isn't on this server, so it is added as a new workspace.`,
  );
  return checked.mode === "IN_PLACE" ? restoreInPlace(runId, source, passphrase, checked, options, log) : restoreAsNew(runId, source, passphrase, checked, log);
}

/**
 * `npm run bundle -- restore <file> [--workspace <slug>] --i-understand`: the same checks and steps as the console's,
 * for a server whose console can't be used. `workspace`: the slug the file must be a backup of; without it, the file
 * must be a full backup. Recorded as a RestoreRun like the console's.
 */
export async function restoreFromFile(input: { file: string; workspace: string | null; passphrase: string; putBackControlRows?: boolean; by: string }): Promise<RestoreOutcome> {
  if (!controlConfigured())
    return {
      status: "FAILED",
      error: "This server has no control plane (CONTROL_DATABASE_URL), so it can't take a restore.",
      mode: null,
      log: [],
    };
  const kind: RestoreKind = input.workspace ? "workspace" : "full";
  const file = path.resolve(input.file);
  const source: RestoreSource = {
    file,
    backupId: null,
    expectedSha256: null,
    label: file,
  };
  let header: BundleHeader | null = null;
  try {
    header = await readBundleHeader(file);
  } catch {
    header = null;
  }
  const slug = kind === "workspace" ? (header?.workspaces?.[0]?.slug ?? null) : null;
  if (kind === "workspace" && header && header.kind === "workspace" && slug !== input.workspace) {
    const why = `That file is a backup of ${slug ?? "another workspace"}, not of ${input.workspace}. Nothing has been changed.`;
    await recordRefusal({
      kind: "WORKSPACE",
      tenantSlug: input.workspace,
      message: why,
    });
    return { status: "FAILED", error: why, mode: null, log: [] };
  }
  const row = await controlDb().restoreRun.create({
    data: {
      kind: kind === "full" ? "FULL" : "WORKSPACE",
      tenantId: kind === "workspace" ? (header?.workspaces?.[0]?.id ?? null) : null,
      tenantSlug: slug,
      status: "RUNNING",
      log: [],
      startedById: null,
      beatAt: new Date(),
      outcomes: kind === "workspace" ? { options: { putBackControlRows: !!input.putBackControlRows } } : undefined,
    },
    select: { id: true },
  });
  if (kind === "full") await openFullRestore(row.id, null, null);
  return runRestore(row.id, kind, source, input.passphrase, { putBackControlRows: !!input.putBackControlRows }, null, input.by || `script:${os.userInfo().username}`);
}

/**
 * RUNNING restores whose worker died (no heartbeat for half an hour) marked FAILED, saying what that leaves — the page
 * and the platform tick call it. A full restore's account is its file; one stopped half way is the runbook's to undo.
 */
export async function settleRestores(now: Date = new Date()): Promise<number> {
  if (!controlConfigured()) return 0;
  try {
    const dead = new Date(now.getTime() - 30 * 60_000);
    const rows = await controlDb().restoreRun.findMany({
      where: { status: "RUNNING" },
      select: {
        id: true,
        beatAt: true,
        startedAt: true,
        safetyPath: true,
        kind: true,
      },
    });
    let n = 0;
    for (const r of rows) {
      if ((r.beatAt ?? r.startedAt) > dead) continue;
      const error = `Stopped — the server restarted while it was restoring.${r.safetyPath ? ` If it had started changing things, put it back from the safety copy at ${r.safetyPath} (docs/runbook.md §4.3).` : ""}`;
      n += (
        await controlDb().restoreRun.updateMany({
          where: { id: r.id, status: "RUNNING" },
          data: { status: "FAILED", finishedAt: now, error },
        })
      ).count;
    }
    return n;
  } catch {
    return 0;
  }
}
