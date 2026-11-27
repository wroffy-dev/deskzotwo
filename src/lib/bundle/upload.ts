import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, readdir, rename, rm, stat, truncate, writeFile } from "node:fs/promises";
import path from "node:path";
import { bundleDir } from "@/lib/bundle/build";
import { BUNDLE_EXTENSION, BundleFormatError, readBundleHeader, type BundleHeader } from "@/lib/bundle/format";
import { freeSpace } from "@/lib/bundle/jobs";
import { sizeText } from "@/lib/console-shared/backups";
import { controlDb } from "@/lib/platform/control-db";

/**
 * Uploading a Backup & Restore bundle to this server, to be restored here (owner, 26 Nov 2026: bundles are downloaded
 * and uploaded, never kept in a store). A full bundle is many gigabytes, so it comes in parts that survive a dropped
 * connection — the way src/lib/legacy-import/parts.ts takes a big file, but appended to one file as they come rather
 * than held until the last, and resumable:
 *
 *   init       name, total size, and the file's first bytes (up to 64 KiB). Refused here, before a part is sent, when
 *              it isn't a bundle (its magic) or is larger than the disk has free.
 *   part n     PART_BYTES each (the last shorter), with its SHA-256. Appended in order to
 *              BACKUP_DIR/platform/bundles/incoming/<id>.part; one that arrives early (up to a few ahead) waits beside
 *              it and goes in when its turn comes; one sent again with the same hash is already there — idempotent by
 *              part number. Part 0 must begin with the bytes given at init.
 *   status     what has arrived — how a page reloaded mid-upload carries on from the next part.
 *   complete   every byte there: renamed into the bundles folder, its header read (`readBundleHeader`), its SHA-256
 *              taken, and a PlatformBackup row — source UPLOADED, READY, expiring in a day like a built one.
 *
 * Parts are 16 MiB: under the proxy's buffer (next.config.ts `proxyClientMaxBodySize`, 36 MB, which cuts a body
 * there silently — the hash catches it if it ever does) and Cloudflare's 100 MB. Each upload belongs to the staff
 * member who began it. Staging abandoned for a day is cleared (`cleanStaleUploads`, from the page and the tick).
 * One request at a time works on an upload: a lock folder beside it, taken with mkdir, which is atomic.
 */

export const PART_BYTES = 16 * 1024 * 1024;
export const HEAD_BYTES = 64 * 1024;
/** Parts that may arrive ahead of the next one needed, and wait. */
const MAX_AHEAD = 4;
const STALE_MS = 24 * 3_600_000;
const LOCK_STALE_MS = 10 * 60_000;
const KEEP_HOURS = 24;

export class UploadRefused extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
    this.name = "UploadRefused";
  }
}

export const incomingDir = () => path.join(bundleDir(), "incoming");
const validId = (id: string) => /^[0-9a-f-]{36}$/.test(id);
const metaFile = (id: string) => path.join(incomingDir(), `${id}.json`);
const partFile = (id: string) => path.join(incomingDir(), `${id}.part`);
const earlyDir = (id: string) => path.join(incomingDir(), `${id}.early`);
const lockDir = (id: string) => path.join(incomingDir(), `${id}.lock`);

type Meta = {
  id: string;
  staffId: string;
  name: string;
  total: number;
  partSize: number;
  headLength: number;
  headSha256: string;
  /** Bytes appended to the .part file, from the start — always a whole number of parts, or the total. */
  received: number;
  /** Each part's SHA-256 as accepted, by number — appended or waiting. */
  sums: Record<string, string>;
  createdAt: string;
  updatedAt: string;
};

export type UploadStatus = { id: string; name: string; total: number; received: number; partSize: number; parts: number; nextPart: number };

const partsOf = (m: Pick<Meta, "total" | "partSize">) => Math.max(1, Math.ceil(m.total / m.partSize));
const statusOf = (m: Meta): UploadStatus => ({ id: m.id, name: m.name, total: m.total, received: m.received, partSize: m.partSize, parts: partsOf(m), nextPart: Math.floor(m.received / m.partSize) });
const sizeOfPart = (m: Meta, n: number) => Math.min(m.partSize, m.total - n * m.partSize);

async function readMeta(id: string): Promise<Meta | null> {
  if (!validId(id)) return null;
  try {
    return JSON.parse(await readFile(metaFile(id), "utf8")) as Meta;
  } catch {
    return null;
  }
}

async function writeMeta(meta: Meta): Promise<void> {
  meta.updatedAt = new Date().toISOString();
  const temp = `${metaFile(meta.id)}.${process.pid}.tmp`;
  await writeFile(temp, JSON.stringify(meta), { mode: 0o600 });
  await rename(temp, metaFile(meta.id));
}

/** The upload's own, for the staff member who began it; anybody else is told it isn't there. */
async function mine(id: string, staffId: string): Promise<Meta> {
  const meta = await readMeta(id);
  if (!meta || meta.staffId !== staffId) throw new UploadRefused("That upload is finished, was cleared, or was started by somebody else — upload the file again.", 404);
  return meta;
}

async function withLock<T>(id: string, work: () => Promise<T>): Promise<T> {
  const dir = lockDir(id);
  try {
    await mkdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    const info = await stat(dir).catch(() => null);
    if (info && Date.now() - info.mtimeMs < LOCK_STALE_MS) throw new UploadRefused("Another part of this upload is being received — try again in a moment.", 409);
    await rm(dir, { recursive: true, force: true });
    await mkdir(dir);
  }
  try {
    return await work();
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

function cleanName(name: unknown): string {
  const base = path.basename(typeof name === "string" ? name : "").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[^A-Za-z0-9]+/, "").replace(/\.{2,}/g, ".").slice(0, 120);
  const stem = base.toLowerCase().endsWith(BUNDLE_EXTENSION) ? base.slice(0, -BUNDLE_EXTENSION.length) : base;
  return `${stem || "uploaded"}${BUNDLE_EXTENSION}`;
}

// ─── init ────────────────────────────────────────────────────────────────────────────────────────

export type UploadStarted = UploadStatus & { header: BundleHeader | null };

/**
 * Begins an upload. `head` is the file's first min(64 KiB, total) bytes: a file that is not a bundle is refused now,
 * before gigabytes are sent, and so is one the disk has no room for.
 */
export async function initUpload(input: { staffId: string; name: unknown; total: unknown; head: Buffer }): Promise<UploadStarted> {
  const total = typeof input.total === "number" ? input.total : Number(input.total);
  if (!Number.isSafeInteger(total) || total <= 0) throw new UploadRefused("Say how large the file is.");
  const name = cleanName(input.name);
  const head = input.head;
  if (head.length !== Math.min(HEAD_BYTES, total)) throw new UploadRefused(`Send the file's first ${Math.min(HEAD_BYTES, total)} bytes to begin.`);

  await mkdir(incomingDir(), { recursive: true, mode: 0o700 });
  await cleanStaleUploads();

  // The first bytes read as a header would be: the magic and version, and the header itself when it fits.
  const probe = path.join(incomingDir(), `.head-${randomUUID()}`);
  let header: BundleHeader | null = null;
  try {
    await writeFile(probe, head, { mode: 0o600 });
    header = await readBundleHeader(probe);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A header longer than the bytes sent is read whole at the end; anything else wrong is wrong now.
    const longHeader = err instanceof BundleFormatError && /truncated inside its header/.test(message) && head.length < total;
    if (!longHeader) throw new UploadRefused(err instanceof BundleFormatError ? message : "That file could not be read as a Backup & Restore bundle.");
  } finally {
    await rm(probe, { force: true }).catch(() => {});
  }

  const free = await freeSpace(incomingDir());
  if (total > free) {
    throw new UploadRefused(`That file is ${sizeText(total)} and this server's disk has ${sizeText(free)} free where uploads go — make room, then upload it again.`, 413);
  }

  const now = new Date().toISOString();
  const meta: Meta = {
    id: randomUUID(),
    staffId: input.staffId,
    name,
    total,
    partSize: PART_BYTES,
    headLength: head.length,
    headSha256: createHash("sha256").update(head).digest("hex"),
    received: 0,
    sums: {},
    createdAt: now,
    updatedAt: now,
  };
  await writeFile(partFile(meta.id), Buffer.alloc(0), { mode: 0o600 });
  await writeMeta(meta);
  return { ...statusOf(meta), header };
}

export async function uploadStatus(id: string, staffId: string): Promise<UploadStatus> {
  return statusOf(await mine(id, staffId));
}

// ─── parts ───────────────────────────────────────────────────────────────────────────────────────

/** Streams `body` to `target` at `start`, hashing as it goes, refusing more than `size` bytes. */
async function receiveInto(body: AsyncIterable<Uint8Array>, target: string, start: number, size: number, headCheck: { length: number } | null) {
  const hash = createHash("sha256");
  const head = headCheck ? createHash("sha256") : null;
  let count = 0;
  const out = createWriteStream(target, { flags: start === 0 && !headCheck ? "w" : "r+", start });
  const finished = new Promise<void>((resolve, reject) => {
    out.once("finish", resolve);
    out.once("error", reject);
  });
  try {
    for await (const chunk of body) {
      const b = Buffer.from(chunk);
      count += b.length;
      if (count > size) throw new UploadRefused(`That part is larger than ${size} bytes.`);
      hash.update(b);
      if (head && headCheck) {
        const before = count - b.length;
        if (before < headCheck.length) head.update(b.subarray(0, Math.min(b.length, headCheck.length - before)));
      }
      if (!out.write(b)) await new Promise<void>((resolve) => out.once("drain", resolve));
    }
    out.end();
    await finished;
  } catch (err) {
    out.destroy();
    await finished.catch(() => {});
    throw err;
  }
  return { count, sha256: hash.digest("hex"), headSha256: head?.digest("hex") ?? null };
}

async function drain(body: AsyncIterable<Uint8Array>): Promise<void> {
  for await (const chunk of body) void chunk;
}

/** Copies a waiting part onto the end of the file. */
async function appendFile(from: string, to: string, at: number): Promise<number> {
  const out = createWriteStream(to, { flags: "r+", start: at });
  let n = 0;
  await new Promise<void>((resolve, reject) => {
    const input = createReadStream(from);
    input.on("data", (c) => (n += (c as Buffer).length));
    input.once("error", reject);
    out.once("error", reject);
    out.once("finish", resolve);
    input.pipe(out);
  });
  return n;
}

export type PartResult = UploadStatus & { part: number; already: boolean; waiting: boolean };

/**
 * One part: `n` from 0, its SHA-256 as hex, its bytes. Appended when it is the next one, kept aside when it is a few
 * ahead, accepted without writing when it is one already received with the same hash.
 */
export async function receivePart(input: { id: string; staffId: string; part: unknown; sha256: unknown; body: AsyncIterable<Uint8Array> }): Promise<PartResult> {
  const { id, staffId, body } = input;
  return withLock(id, async () => {
    const meta = await mine(id, staffId);
    const n = typeof input.part === "number" ? input.part : Number(input.part);
    const parts = partsOf(meta);
    if (!Number.isInteger(n) || n < 0 || n >= parts) throw new UploadRefused(`This upload has parts 0 to ${parts - 1}.`);
    const sha = typeof input.sha256 === "string" ? input.sha256.trim().toLowerCase() : "";
    if (!/^[0-9a-f]{64}$/.test(sha)) throw new UploadRefused("Each part needs its SHA-256.");
    const size = sizeOfPart(meta, n);
    const start = n * meta.partSize;
    const next = Math.floor(meta.received / meta.partSize);

    const known = meta.sums[String(n)];
    if (known) {
      await drain(body);
      if (known !== sha) throw new UploadRefused(`Part ${n} was already received with different bytes — upload the file again.`, 409);
      return { ...statusOf(meta), part: n, already: true, waiting: start >= meta.received };
    }

    if (n > next) {
      if (n - next > MAX_AHEAD) {
        await drain(body);
        throw new UploadRefused(`Send part ${next} first.`, 409);
      }
      await mkdir(earlyDir(id), { recursive: true, mode: 0o700 });
      const early = path.join(earlyDir(id), String(n));
      let got;
      try {
        got = await receiveInto(body, early, 0, size, null);
      } catch (err) {
        await rm(early, { force: true }).catch(() => {});
        throw err;
      }
      if (got.count !== size || got.sha256 !== sha) {
        await rm(early, { force: true }).catch(() => {});
        throw new UploadRefused(`Part ${n} did not arrive whole (${got.count} of ${size} bytes, or its SHA-256 differs) — send it again.`);
      }
      meta.sums[String(n)] = sha;
      await writeMeta(meta);
      return { ...statusOf(meta), part: n, already: false, waiting: true };
    }

    // n === next: appended where the file ends, and taken back off if it isn't whole.
    let got;
    try {
      got = await receiveInto(body, partFile(id), start, size, n === 0 ? { length: meta.headLength } : null);
    } catch (err) {
      await truncate(partFile(id), meta.received).catch(() => {});
      throw err;
    }
    if (got.count !== size || got.sha256 !== sha) {
      await truncate(partFile(id), meta.received).catch(() => {});
      throw new UploadRefused(`Part ${n} did not arrive whole (${got.count} of ${size} bytes, or its SHA-256 differs) — send it again.`);
    }
    if (n === 0 && got.headSha256 !== meta.headSha256) {
      await truncate(partFile(id), meta.received).catch(() => {});
      throw new UploadRefused("The file's first part is not the file this upload began with — upload the file again.", 409);
    }
    meta.received = start + size;
    meta.sums[String(n)] = sha;

    // Parts that came early and are next now.
    for (;;) {
      const k = Math.floor(meta.received / meta.partSize);
      const early = path.join(earlyDir(id), String(k));
      if (meta.received >= meta.total || !meta.sums[String(k)] || !(await stat(early).catch(() => null))) break;
      const added = await appendFile(early, partFile(id), meta.received);
      if (added !== sizeOfPart(meta, k)) {
        await truncate(partFile(id), meta.received).catch(() => {});
        delete meta.sums[String(k)];
        await rm(early, { force: true }).catch(() => {});
        break;
      }
      meta.received += added;
      await rm(early, { force: true }).catch(() => {});
    }
    await writeMeta(meta);
    return { ...statusOf(meta), part: n, already: false, waiting: false };
  });
}

// ─── complete ────────────────────────────────────────────────────────────────────────────────────

async function fileSha256(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file, { highWaterMark: 1024 * 1024 })) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

export type UploadDone = { backupId: string; fileName: string; header: BundleHeader; sizeBytes: number; sha256: string };

/** Every byte arrived: the file into the bundles folder, its header read, a READY row of source UPLOADED. */
export async function completeUpload(id: string, staffId: string): Promise<UploadDone> {
  return withLock(id, async () => {
    const meta = await mine(id, staffId);
    if (meta.received !== meta.total) throw new UploadRefused(`Part ${Math.floor(meta.received / meta.partSize)} hasn't arrived yet.`, 409);
    const size = (await stat(partFile(id))).size;
    if (size !== meta.total) throw new UploadRefused("The file on the server is not the size it was said to be — upload it again.", 409);

    let fileName = meta.name;
    if (await stat(path.join(bundleDir(), fileName)).catch(() => null)) fileName = `${fileName.slice(0, -BUNDLE_EXTENSION.length)}-${id.slice(0, 8)}${BUNDLE_EXTENSION}`;
    const target = path.join(bundleDir(), fileName);

    let header: BundleHeader;
    try {
      header = await readBundleHeader(partFile(id));
    } catch (err) {
      await discard(id);
      throw new UploadRefused(err instanceof BundleFormatError ? err.message : "That file could not be read as a Backup & Restore bundle.");
    }
    const sha256 = await fileSha256(partFile(id));
    await rename(partFile(id), target);

    const now = new Date();
    const workspace = header.kind === "workspace" ? (header.workspaces[0] ?? null) : null;
    const row = await controlDb().platformBackup.create({
      data: {
        kind: header.kind === "full" ? "FULL" : "WORKSPACE",
        tenantId: workspace?.id ?? null,
        tenantSlug: workspace?.slug ?? null,
        status: "READY",
        source: "UPLOADED",
        fileName,
        sizeBytes: BigInt(size),
        sha256,
        header: JSON.parse(JSON.stringify(header)),
        startedById: staffId,
        startedAt: new Date(meta.createdAt),
        finishedAt: now,
        expiresAt: new Date(now.getTime() + KEEP_HOURS * 3_600_000),
      },
      select: { id: true },
    });
    await discard(id, { keepPart: true });
    return { backupId: row.id, fileName, header, sizeBytes: size, sha256 };
  });
}

async function discard(id: string, options: { keepPart?: boolean } = {}): Promise<void> {
  await rm(metaFile(id), { force: true }).catch(() => {});
  if (!options.keepPart) await rm(partFile(id), { force: true }).catch(() => {});
  await rm(earlyDir(id), { recursive: true, force: true }).catch(() => {});
}

/** Stops an upload and removes what had arrived. */
export async function cancelUpload(id: string, staffId: string): Promise<void> {
  await mine(id, staffId);
  await discard(id);
}

/** Uploads nobody has touched for a day: their parts and their record removed. Returns how many. */
export async function cleanStaleUploads(now: Date = new Date()): Promise<number> {
  let cleared = 0;
  const names = await readdir(incomingDir()).catch(() => [] as string[]);
  for (const name of names) {
    const full = path.join(incomingDir(), name);
    const id = name.slice(0, 36);
    if (name.endsWith(".json") && validId(id)) {
      const meta = await readMeta(id);
      const touched = meta ? Date.parse(meta.updatedAt) : (await stat(full).catch(() => null))?.mtimeMs ?? 0;
      if (now.getTime() - touched > STALE_MS) {
        await discard(id);
        await rm(lockDir(id), { recursive: true, force: true }).catch(() => {});
        cleared += 1;
      }
    } else if (validId(id) && !names.includes(`${id}.json`)) {
      // A part or a folder whose record is gone.
      const info = await stat(full).catch(() => null);
      if (info && now.getTime() - info.mtimeMs > STALE_MS) await rm(full, { recursive: true, force: true }).catch(() => {});
    } else if (name.startsWith(".head-")) {
      const info = await stat(full).catch(() => null);
      if (info && now.getTime() - info.mtimeMs > 3_600_000) await rm(full, { force: true }).catch(() => {});
    }
  }
  return cleared;
}

/** For the checks: an upload's record made to look untouched since `at`. */
export async function ageUploadForChecks(id: string, at: Date): Promise<void> {
  const meta = await readMeta(id);
  if (!meta) return;
  await writeFile(metaFile(id), JSON.stringify({ ...meta, updatedAt: at.toISOString() }));
}

/** Whether anything of an upload is still in staging. */
export async function uploadLeftovers(id: string): Promise<string[]> {
  const names = await readdir(incomingDir()).catch(() => [] as string[]);
  return names.filter((n) => n.startsWith(id));
}
