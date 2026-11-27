import { createHash, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat } from "node:fs/promises";
import path from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { passphraseProblem, PassphraseError } from "@/lib/backup/archive";
import { backupBase } from "@/lib/backup/maintenance";
import { parseDatabaseUrl } from "@/lib/backup/policy";
import { dumpStream, resolveDumpTool, type DumpTool } from "@/lib/backup/run";
import { controlRowsJson } from "@/lib/bundle/control-rows";
import { BUNDLE_EXTENSION, createBundleWriter, type BundleHeader, type BundleHeaderInput, type BundleKind, type BundleManifest, type BundleWorkspace, type BundleWriter } from "@/lib/bundle/format";
import { rawRecordingStoreFor } from "@/lib/calls/recordings";
import type { OffsiteStore } from "@/lib/offsite/store";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { platformKeyFingerprint } from "@/lib/platform/kek";
import { storageBox, storageBoxState } from "@/lib/storage/box";
import { supportDir, validId } from "@/lib/support/storage";
import { directClient } from "@/lib/tenancy/direct-client";
import { tenantsForBackup } from "@/lib/tenancy/registry";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * Building a Backup & Restore bundle (owner, 26 Nov 2026 — the file format is src/lib/bundle/format.ts).
 *
 * Two kinds, both one `.dzbk` file the console offers for download:
 *
 *   FULL        the whole installation, restorable on a fresh install: the control plane's dump, and every workspace
 *               that isn't closed — suspended ones and ones still being set up too — with all of its entries below.
 *   WORKSPACE   one workspace, restorable into this server or as that workspace on another:
 *
 *     workspaces/<id>/db.dump                  pg_dump (custom format) of its database, streamed from pg_dump's stdout
 *     workspaces/<id>/control.json             its control-plane rows (src/lib/bundle/control-rows.ts)
 *     workspaces/<id>/box/<key>                every object under the storage box's workspaces/<id>/ — documents,
 *                                              attachments, photos, call recordings — as the box holds them (sealed)
 *     workspaces/<id>/support/box/<key>        its support attachments in the box (support/<id>/…, sealed)
 *     workspaces/<id>/support/disk/<path>      its support attachments still on this disk (SUPPORT_DIR/<id>/…;
 *                                              never staging/, which is uploads not yet sent)
 *     workspaces/<id>/recordings-store/<key>   its call recordings, when this server keeps them in a separate
 *                                              RECORDINGS_* store rather than the box
 *
 *   Files kept inline in the database (from before the box) are inside db.dump already.
 *
 *   A full bundle adds `control/control.dump` and `platform/inventory.json` — which settings this server had (names
 *   and whether they were set, never values) and what was deliberately left out, for whoever sets up the server it is
 *   restored on. The CMS's media and the app updates' files are rows in the control plane, so they are in its dump.
 *
 * ## What is never in a bundle
 *
 *   · PLATFORM_MASTER_KEY. The header carries its fingerprint; the restoring server must be given the same key, and
 *     refuses a different one before touching anything. Everything sealed — workspaces' key bundles, platform secrets,
 *     the box's files — is copied as it is, sealed, which is why the same key opens it there.
 *   · The environment's secrets (SMTP, STORAGE_*, gateway keys…), the reference database (reloaded from its sources),
 *     logs, GeoIP data, other backups (BACKUP_DIR), and the box's offsite/ folder.
 *
 * ## Streaming
 *
 * One workspace can have gigabytes of files. Every entry is streamed: pg_dump's stdout straight into the writer, the
 * control rows a page at a time, and each box object through a temporary file next to the bundle (the store fetches
 * to a file, never into memory) that is deleted as soon as it has gone in — so the disk holds the bundle and at most
 * one object besides.
 *
 * The bundle is written to `<out>.part` and renamed when finished; a failure removes it, so a file with the bundle's
 * name is always a whole one. Progress is reported as it goes (entry, bytes) and, with a control plane, kept on the
 * PlatformBackup row the build records.
 */

export type BundleProgress = {
  /** The entry being written. */
  entry: string;
  /** Its bytes so far. */
  entryBytes: number;
  /** Every entry's bytes so far. */
  bytes: number;
  /** Entries finished. */
  entries: number;
};

export type BuildOptions = {
  /** Where the bundle goes. Default: BACKUP_DIR/platform/bundles/<a name for it>. */
  out?: string;
  passphrase: string;
  /** Who asked, for the header: "staff:<id>", "script:<user>". */
  createdBy: string;
  /** The staff member, for the PlatformBackup row. */
  startedById?: string | null;
  /**
   * A PlatformBackup row already made for this build (RUNNING) — the console's, made before its worker starts
   * (src/lib/bundle/jobs.ts) — which the build fills in instead of making one of its own.
   */
  backupId?: string | null;
  /**
   * Count the entries first (listing the box once more), so progress can say "entries done of total" — the console's
   * builds do; the script's don't need to. The count is as things stood a moment before: a file added or removed
   * meanwhile makes it one off.
   */
  countEntries?: boolean;
  /** What the bundle is expected to come to (the console's estimate), kept with the progress for a bar. */
  expectedBytes?: number | null;
  /** For the checks only: the header as it would be written, changed — a schema version from a newer server. */
  adjustHeader?: (header: BundleHeaderInput) => BundleHeaderInput;
  onProgress?: (progress: BundleProgress) => void;
  /** Frame size in bytes — the checks use small ones. */
  frameSize?: number;
};

export type BuildResult = {
  file: string;
  header: BundleHeader;
  manifest: BundleManifest;
  sizeBytes: number;
  /** Of the whole file, hex. */
  sha256: string;
  /** The PlatformBackup row, when there is a control plane to keep one in. */
  backupId: string | null;
};

/** Where the server builds bundles to be downloaded: BACKUP_DIR/platform/bundles/. */
export const bundleDir = () => path.join(backupBase(), "platform", "bundles");

/** How long a bundle built into bundleDir waits to be downloaded before it may be removed. */
const KEEP_HOURS = 24;

export function bundleFileName(kind: BundleKind, slug: string | null, at: Date = new Date()): string {
  const iso = at.toISOString();
  const stamp = `${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, "")}`;
  const what = kind === "full" ? "full" : (slug ?? "workspace").replace(/[^a-z0-9-]/gi, "-");
  return `deskzo-${what}-${stamp}${BUNDLE_EXTENSION}`;
}

/** One workspace's bundle: its database, its control-plane rows, its files. */
export async function buildWorkspaceBundle(tenant: Tenant, options: BuildOptions): Promise<BuildResult> {
  return build("workspace", [tenant], false, options);
}

/** The whole installation: the control plane and every workspace that isn't closed. */
export async function buildFullBundle(options: BuildOptions): Promise<BuildResult> {
  return build("full", await tenantsForBackup(), controlConfigured(), options);
}

// ─── What goes in ────────────────────────────────────────────────────────────────────────────────

type Context = {
  writer: BundleWriter;
  tool: DumpTool | null;
  box: OffsiteStore | null;
  work: string;
  notes: string[];
  counts: Record<string, number>;
  progress: (entry: string, bytes: number) => void;
  entryDone: () => void;
};

const boxId = (tenantId: string) => tenantId.replace(/[^A-Za-z0-9._-]/g, "-");

async function addEntry(ctx: Context, name: string, source: Readable | AsyncIterable<Buffer | string>, contentType?: string): Promise<number> {
  ctx.progress(name, 0);
  const entry = await ctx.writer.addEntry(name, source, { contentType, onBytes: (n) => ctx.progress(name, n) });
  ctx.entryDone();
  return entry.size;
}

/** pg_dump of a database into an entry, and its exit checked once its output has all gone in. */
async function addDump(ctx: Context, name: string, url: string, what: string): Promise<void> {
  if (!ctx.tool) throw new Error("pg_dump could not be found — not on the PATH, not at PG_DUMP_PATH, and not in the database container.");
  const connection = parseDatabaseUrl(url);
  if (!connection) throw new Error(`${what}'s database address is not a Postgres URL.`);
  const { stream, done } = dumpStream(ctx.tool, connection, 6);
  let size: number;
  try {
    size = await addEntry(ctx, name, stream, "application/vnd.postgresql.custom-dump");
  } catch (err) {
    stream.destroy();
    throw err;
  }
  await done.catch((err: unknown) => {
    throw new Error(`pg_dump of ${what} failed: ${err instanceof Error ? err.message : String(err)}`);
  });
  // A dump that exited zero with next to nothing in it is a broken pipe, not a database (src/lib/backup/run.ts).
  if (size < 1024) throw new Error(`The dump of ${what} is only ${size} bytes, which cannot be a whole database.`);
  ctx.counts.dumps = (ctx.counts.dumps ?? 0) + 1;
}

/** Every object under `prefix` in a store, each through a temporary file, as entries named `<into>/<key below prefix>`. */
async function addStoreObjects(ctx: Context, store: OffsiteStore, prefix: string, into: string, counter: string): Promise<void> {
  const { objects } = await store.list(prefix);
  objects.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  for (const object of objects) {
    const rel = object.key.startsWith(prefix) ? object.key.slice(prefix.length) : object.key;
    if (!rel) continue;
    const name = `${into}/${rel}`;
    const temp = path.join(ctx.work, randomBytes(8).toString("hex"));
    try {
      if (!(await store.getToFile(object.key, temp))) {
        // Deleted between the listing and now — the nightly sweep, a retention run. Said, not fatal.
        ctx.notes.push(`${name} was listed but gone when it was read.`);
        ctx.counts.vanished = (ctx.counts.vanished ?? 0) + 1;
        continue;
      }
      await addEntry(ctx, name, createReadStream(temp));
      ctx.counts[counter] = (ctx.counts[counter] ?? 0) + 1;
    } finally {
      await rm(temp, { force: true }).catch(() => {});
    }
  }
}

/** Files under a folder on this disk, relative paths, sorted; `skipTop` names first-level folders to leave out. */
async function filesUnder(root: string, skipTop: Set<string>): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, rel: string) => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const e of entries) {
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (!rel && skipTop.has(e.name)) continue;
      if (e.isDirectory()) await walk(path.join(dir, e.name), r);
      else if (e.isFile()) out.push(r);
    }
  };
  await walk(root, "");
  return out.sort();
}

async function workspaceEntries(ctx: Context, tenant: Tenant): Promise<void> {
  const base = `workspaces/${tenant.id}`;

  if (tenant.dbUrl) await addDump(ctx, `${base}/db.dump`, tenant.dbUrl, `workspace ${tenant.slug}`);
  else ctx.notes.push(`${tenant.slug} has no database yet (${tenant.status}): no db.dump.`);

  if (controlConfigured() && tenant.source === "control") {
    await addEntry(ctx, `${base}/control.json`, Readable.from(controlRowsJson(tenant.id)), "application/json");
  } else {
    // A workspace from the environment has no control-plane rows; the file says so rather than being missing.
    const stub = { format: 1, tenantId: tenant.id, exportedAt: new Date().toISOString(), order: [], models: {}, shared: {}, omitted: {}, uncarried: {}, source: "environment" };
    await addEntry(ctx, `${base}/control.json`, Readable.from([JSON.stringify(stub)]), "application/json");
  }

  if (ctx.box) {
    await addStoreObjects(ctx, ctx.box, `workspaces/${boxId(tenant.id)}/`, `${base}/box`, "boxFiles");
    await addStoreObjects(ctx, ctx.box, `support/${tenant.id}/`, `${base}/support/box`, "supportFiles");
  }

  // Support attachments from before the box, or on a server without one. Never staging/: uploads not yet sent.
  if (validId(tenant.id)) {
    const dir = path.join(supportDir(), tenant.id);
    for (const rel of await filesUnder(dir, new Set(["staging"]))) {
      await addEntry(ctx, `${base}/support/disk/${rel}`, createReadStream(path.join(dir, ...rel.split("/"))));
      ctx.counts.supportFiles = (ctx.counts.supportFiles ?? 0) + 1;
    }
  }

  // Recordings in a store of their own (RECORDINGS_*); without one they are in the box, above.
  if (process.env.RECORDINGS_AZURE_CONTAINER_URL?.trim() || process.env.RECORDINGS_DIR?.trim()) {
    const store = await rawRecordingStoreFor(tenant.id);
    if (store) await addStoreObjects(ctx, store, "", `${base}/recordings-store`, "recordings");
  }
  ctx.counts.workspaces = (ctx.counts.workspaces ?? 0) + 1;
}

/** How many entries `workspaceEntries` and the rest will add — the same sources, listed. */
async function countEntries(kind: BundleKind, tenants: Tenant[], withControl: boolean, box: OffsiteStore | null): Promise<number> {
  let n = (withControl ? 1 : 0) + (kind === "full" ? 1 : 0);
  const below = async (store: OffsiteStore, prefix: string) => (await store.list(prefix)).objects.filter((o) => o.key.startsWith(prefix) && o.key.length > prefix.length).length;
  for (const t of tenants) {
    n += (t.dbUrl ? 1 : 0) + 1;
    if (box) n += (await below(box, `workspaces/${boxId(t.id)}/`)) + (await below(box, `support/${t.id}/`));
    if (validId(t.id)) n += (await filesUnder(path.join(supportDir(), t.id), new Set(["staging"]))).length;
    if (process.env.RECORDINGS_AZURE_CONTAINER_URL?.trim() || process.env.RECORDINGS_DIR?.trim()) {
      const store = await rawRecordingStoreFor(t.id);
      if (store) n += (await store.list("")).objects.length;
    }
  }
  return n;
}

/** Settings a fresh server needs to be given again — by name, and whether this one had them. Never a value. */
const SETTINGS = [
  "PLATFORM_MASTER_KEY",
  "AUTH_SECRET",
  "CONTROL_DATABASE_URL",
  "REFERENCE_DATABASE_URL",
  "PLATFORM_DOMAIN",
  "PLATFORM_SMTP_URL",
  "STORAGE_AZURE_CONNECTION_STRING",
  "STORAGE_AZURE_CONTAINER",
  "STORAGE_AZURE_CONTAINER_URL",
  "STORAGE_AZURE_SAS",
  "STORAGE_DIR",
  "STORAGE_PREFIX",
  "RECORDINGS_AZURE_CONTAINER_URL",
  "RECORDINGS_AZURE_SAS",
  "RECORDINGS_DIR",
  "SUPPORT_DIR",
  "BACKUP_DIR",
  "LOG_DIR",
  "GEOIP_DIR",
];

async function inventory(): Promise<string> {
  const box = await storageBoxState().catch(() => null);
  return JSON.stringify(
    {
      settings: Object.fromEntries(SETTINGS.map((name) => [name, !!process.env[name]?.trim()])),
      storageBox: box ? { configured: box.configured, mode: box.mode, source: box.source } : null,
      leftOut: {
        PLATFORM_MASTER_KEY: "never carried — give the new server the same key (the header has its fingerprint)",
        environment: "secrets and settings in the environment (SMTP, STORAGE_*, gateway keys…) — set them again",
        referenceDatabase: "REFERENCE_DATABASE_URL — reloaded from its sources",
        logs: "LOG_DIR and archived logs",
        geoip: "GEOIP_DIR — downloaded again",
        backups: "BACKUP_DIR and the box's offsite/ folder — other backups",
        closedWorkspaces: "workspaces that are DEPROVISIONED (their rows are in control.dump; their data is gone)",
      },
    },
    null,
    2,
  );
}

// ─── The build ───────────────────────────────────────────────────────────────────────────────────

async function appVersion(): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

async function latestMigrationAt(url: string): Promise<string | null> {
  const client = directClient(url, { max: 1 });
  try {
    const rows = await client.$queryRawUnsafe<{ migration_name: string }[]>(
      `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 1`,
    );
    return rows[0]?.migration_name ?? null;
  } catch {
    return null;
  } finally {
    await client.$disconnect().catch(() => {});
  }
}

async function controlSchemaVersion(): Promise<string | null> {
  try {
    const rows = await controlDb().$queryRawUnsafe<{ migration_name: string }[]>(
      `SELECT migration_name FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 1`,
    );
    return rows[0]?.migration_name ?? null;
  } catch {
    return null;
  }
}

async function build(kind: BundleKind, tenants: Tenant[], withControl: boolean, options: BuildOptions): Promise<BuildResult> {
  const problem = passphraseProblem(options.passphrase);
  if (problem) throw new PassphraseError(problem);
  if (kind === "full" && !withControl && tenants.length === 0) throw new Error("There is nothing to put in a full bundle: no control plane and no workspace.");

  const startedAt = new Date();
  const single = kind === "workspace" ? tenants[0]! : null;
  const file = path.resolve(options.out ?? path.join(bundleDir(), bundleFileName(kind, single?.slug ?? null, startedAt)));
  const part = `${file}.part`;
  const work = `${file}.work-${randomBytes(4).toString("hex")}`;
  const record = controlConfigured();
  let backupId: string | null = record ? (options.backupId ?? null) : null;

  if (record && backupId) {
    await controlDb().platformBackup.update({ where: { id: backupId }, data: { fileName: path.basename(file), status: "RUNNING" } });
  } else if (record) {
    const row = await controlDb().platformBackup.create({
      data: {
        kind: kind === "full" ? "FULL" : "WORKSPACE",
        tenantId: single?.id ?? null,
        tenantSlug: single?.slug ?? null,
        status: "RUNNING",
        source: "CREATED",
        fileName: path.basename(file),
        startedById: options.startedById ?? null,
        startedAt,
      },
      select: { id: true },
    });
    backupId = row.id;
  }

  let output: { stream: Transform; written: Promise<void> } | null = null;
  const fail = async (err: unknown): Promise<never> => {
    if (output) {
      // Closing the half-written file before it is removed, so nothing writes to it afterwards.
      output.stream.destroy();
      await output.written.catch(() => {});
    }
    await rm(part, { force: true }).catch(() => {});
    await rm(work, { recursive: true, force: true }).catch(() => {});
    if (backupId) {
      await controlDb()
        .platformBackup.update({ where: { id: backupId }, data: { status: "FAILED", finishedAt: new Date(), error: err instanceof Error ? err.message : String(err) } })
        .catch(() => {});
    }
    throw err;
  };

  try {
    const needsDump = withControl || tenants.some((t) => t.dbUrl);
    const tool = needsDump ? await resolveDumpTool("pg_dump") : null;
    if (needsDump && !tool) throw new Error("pg_dump could not be found — not on the PATH, not at PG_DUMP_PATH, and not in the database container. Install the Postgres client tools or set PG_DUMP_PATH.");

    const workspaces: BundleWorkspace[] = [];
    for (const t of tenants) workspaces.push({ id: t.id, slug: t.slug, name: t.name, schemaVersion: t.dbUrl ? await latestMigrationAt(t.dbUrl) : null });
    let headerInput: BundleHeaderInput = {
      kind,
      createdAt: startedAt.toISOString(),
      createdBy: options.createdBy,
      app: { name: "Deskzo One", version: await appVersion(), commit: process.env.SOURCE_COMMIT?.trim() || process.env.COOLIFY_SOURCE_COMMIT?.trim() || null },
      control: withControl ? { schemaVersion: await controlSchemaVersion() } : null,
      workspaces,
      keyFingerprint: platformKeyFingerprint(),
    };
    if (options.adjustHeader) headerInput = options.adjustHeader(headerInput);

    await mkdir(path.dirname(file), { recursive: true });
    await mkdir(work, { recursive: true });

    const hash = createHash("sha256");
    const hashing = new Transform({
      transform(chunk: Buffer, _enc, done) {
        hash.update(chunk);
        done(null, chunk);
      },
    });
    const written = pipeline(hashing, createWriteStream(part));
    written.catch(() => {});
    output = { stream: hashing, written };
    const writer = await createBundleWriter(hashing, headerInput, options.passphrase, { frameSize: options.frameSize });

    const box = await storageBox();
    const entriesTotal = options.countEntries ? await countEntries(kind, tenants, withControl, box).catch(() => null) : null;
    const expectedBytes = options.expectedBytes ?? null;
    let bytes = 0;
    let entries = 0;
    let current = { entry: "", entryBytes: 0 };
    let lastSaved = 0;
    // One write at a time, in order, and all of them done before the row is finished — so a late one never puts an
    // older picture back over the last.
    let saving: Promise<unknown> = Promise.resolve();
    let saved = false;
    const save = (force = false) => {
      if (!backupId || saved || (!force && Date.now() - lastSaved < 2000)) return;
      lastSaved = Date.now();
      const progress = { ...current, bytes, entries, entriesTotal, expectedBytes, at: new Date().toISOString() };
      const id = backupId;
      saving = saving.then(() => controlDb().platformBackup.update({ where: { id }, data: { progress } })).catch(() => {});
    };
    const ctx: Context = {
      writer,
      tool,
      box,
      work,
      notes: [],
      counts: {},
      progress: (entry, n) => {
        if (entry !== current.entry) current = { entry, entryBytes: 0 };
        current.entryBytes += n;
        bytes += n;
        options.onProgress?.({ entry, entryBytes: current.entryBytes, bytes, entries });
        save();
      },
      entryDone: () => {
        entries += 1;
        save();
      },
    };

    if (withControl) await addDump(ctx, "control/control.dump", process.env.CONTROL_DATABASE_URL!.trim(), "the control plane");
    for (const tenant of tenants) await workspaceEntries(ctx, tenant);
    if (kind === "full") await addEntry(ctx, "platform/inventory.json", Readable.from([await inventory()]), "application/json");

    const { manifest } = await writer.finish({ counts: ctx.counts, notes: ctx.notes });
    await written;
    await rename(part, file);
    await rm(work, { recursive: true, force: true }).catch(() => {});

    const sizeBytes = (await stat(file)).size;
    const sha256 = hash.digest("hex");
    saved = true;
    await saving;
    if (backupId) {
      const finishedAt = new Date();
      const inBundleDir = path.dirname(file) === path.resolve(bundleDir());
      await controlDb().platformBackup.update({
        where: { id: backupId },
        data: {
          status: "READY",
          finishedAt,
          sizeBytes: BigInt(sizeBytes),
          sha256,
          header: JSON.parse(JSON.stringify(writer.header)),
          progress: { entry: null, entryBytes: 0, bytes, entries, entriesTotal: entries, expectedBytes, at: finishedAt.toISOString() },
          expiresAt: inBundleDir ? new Date(finishedAt.getTime() + KEEP_HOURS * 3600_000) : null,
        },
      });
    }
    return { file, header: writer.header, manifest, sizeBytes, sha256, backupId };
  } catch (err) {
    return fail(err);
  }
}
