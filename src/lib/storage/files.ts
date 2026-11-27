import { randomBytes } from "node:crypto";
import { openBuffer, sealBuffer } from "@/lib/backup/at-rest";
import { currentTenant } from "@/lib/tenancy/resolve";
import { storageBox, workspaceBox } from "@/lib/storage/box";
import { assertRoomFor, noteStored } from "@/lib/storage/allowance";

/**
 * Files in the storage box instead of the database (owner, 13 Nov 2026 — src/lib/storage/box.ts).
 *
 * A file's column keeps its place and its type; what it holds changes. With a box set up, a new file goes to the box,
 * sealed under the workspace's key (src/lib/backup/at-rest.ts, "file" — the connection string alone opens nothing),
 * and the column keeps a reference to it:
 *
 *   a text column (a data URL)   "dzblob:<kind>/<yyyy-mm>/<id>|<content type>"
 *   a Bytes column               "\0DZBLOB\0" followed by the same text
 *
 * as EmployeeDocument already keeps "letter:<id>" for a letter drawn on demand. So no column changes, every workspace
 * takes it at once, and a value written before the box — or on a server without one — reads exactly as it always did.
 *
 * Writers call `keepDataUrl` / `keepBytes` and save what they return; readers call `dataUrlOf` / `bytesOf` /
 * `storedFile` on what they read. Nothing else may hand a column's value to a page, a response or a PDF.
 *
 * The reference names a key inside the workspace's own part of the box (workspaces/<id>/files), never another's: a
 * reference copied into a different workspace finds nothing there.
 *
 * Nothing is deleted from the box when its row is. A file stays until the nightly sweep (src/lib/storage/sweep.ts)
 * finds no row that points at it for longer than backups are kept — a workspace restored from last month's backup
 * points at files that must still be there.
 */

export const TEXT_REF = "dzblob:";
const BYTES_MAGIC = Buffer.from("\u0000DZBLOB\u0000", "latin1");
const KIND = /^[a-z][a-z0-9-]{1,40}$/;
const KEY = /^[a-z][a-z0-9-]{1,40}\/\d{4}-\d{2}\/[a-f0-9]{24}$/;

export class StoredFileMissing extends Error {
  constructor(key: string) {
    super(`The file ${key} isn't in the storage box.`);
    this.name = "StoredFileMissing";
  }
}

export type StoredRef = { key: string; contentType: string };

// ─── References ──────────────────────────────────────────────────────────────────────────────────

function textRef(ref: StoredRef): string {
  return `${TEXT_REF}${ref.key}|${ref.contentType}`;
}

function parseText(text: string): StoredRef | null {
  if (!text.startsWith(TEXT_REF)) return null;
  const body = text.slice(TEXT_REF.length);
  const bar = body.indexOf("|");
  const key = bar < 0 ? body : body.slice(0, bar);
  if (!KEY.test(key)) return null;
  return { key, contentType: (bar < 0 ? "" : body.slice(bar + 1)) || "application/octet-stream" };
}

const asBuffer = (value: Uint8Array) => (Buffer.isBuffer(value) ? value : Buffer.from(value.buffer, value.byteOffset, value.byteLength));

/** The reference a column holds, or null for a file kept in the column itself (or nothing). */
export function storedRef(value: string | Uint8Array | null | undefined): StoredRef | null {
  if (value == null) return null;
  if (typeof value === "string") return parseText(value);
  const buf = asBuffer(value);
  if (buf.length < BYTES_MAGIC.length || buf.length > 400 || !buf.subarray(0, BYTES_MAGIC.length).equals(BYTES_MAGIC)) return null;
  return parseText(buf.subarray(BYTES_MAGIC.length).toString("utf8"));
}

/** Whether a column's value points into the box. */
export const isStoredRef = (value: string | Uint8Array | null | undefined): boolean => storedRef(value) !== null;

// ─── Data URLs ───────────────────────────────────────────────────────────────────────────────────

/** "data:image/png;base64,AAA" → its bytes and type; null for anything that isn't a data URL. */
export function parseDataUrl(text: string): { bytes: Buffer; contentType: string } | null {
  const m = /^data:([^,]*?),/i.exec(text.slice(0, 300));
  if (!m) return null;
  const params = m[1]!.split(";");
  const base64 = params.some((p) => p.trim().toLowerCase() === "base64");
  const contentType = params.filter((p) => p.trim().toLowerCase() !== "base64").join(";").trim() || "text/plain";
  const payload = text.slice(m[0].length);
  try {
    return { bytes: base64 ? Buffer.from(payload, "base64") : Buffer.from(decodeURIComponent(payload), "utf8"), contentType };
  } catch {
    return null;
  }
}

export const toDataUrl = (bytes: Buffer, contentType: string) => `data:${contentType || "application/octet-stream"};base64,${bytes.toString("base64")}`;

// ─── Writing ─────────────────────────────────────────────────────────────────────────────────────

async function filesBox() {
  const box = (await storageBox());
  if (!box) return null;
  const tenant = await currentTenant();
  return { tenantId: tenant.id, store: workspaceBox(box, tenant.id, "files") };
}

async function put(kind: string, bytes: Buffer, contentType: string): Promise<StoredRef | null> {
  if (!KIND.test(kind)) throw new Error(`Not a file kind: ${kind}`);
  const box = await filesBox();
  if (!box) return null;
  const key = `${kind}/${new Date().toISOString().slice(0, 7)}/${randomBytes(12).toString("hex")}`;
  await box.store.put(key, sealBuffer(box.tenantId, bytes, "file"));
  remember(box.tenantId, key, bytes);
  return { key, contentType: contentType.replace(/[|\r\n]/g, "").slice(0, 200) || "application/octet-stream" };
}

/**
 * Security audit round three, 14 Nov 2026 (low, "an uploaded file can pose as a storage-box reference"): what a writer
 * is handed is somebody's upload, and a reference is only ever made here. An upload that reads as one — "dzblob:…", or
 * bytes starting "\0DZBLOB\0" — was passed through as it was, and the row then pointed at whatever file in the
 * workspace's box that key names. So it is refused. Nothing legitimate does it: the move to the box
 * (src/lib/storage/maintenance.ts) hands these functions only values not in the box yet, and a form that sends a file
 * back sends the data URL it was shown.
 */
export class StoredRefRefused extends Error {
  constructor() {
    super("That file can't be saved — it isn't a file this app recognises. Choose the file again.");
    this.name = "StoredRefRefused";
  }
}

function refuseLookalike(value: string | Uint8Array): void {
  if (isStoredRef(value)) throw new StoredRefRefused();
}

/**
 * What to save in a data-URL column: a reference once the file is in the box, or the data URL unchanged when there is
 * no box. A value that isn't a data URL — empty, "letter:<id>" — is returned as it is; one that reads as a reference
 * already is refused (`StoredRefRefused`).
 */
/**
 * How a save counts against the workspace's storage (src/lib/storage/quota.ts): a new file is refused at the limit
 * (`StorageFull`) and added to what it uses. `counted: false` — the move of files already saved (src/lib/storage/
 * maintenance.ts `moveColumn`), which were counted where they were.
 */
type KeepOptions = { counted?: boolean };

export async function keepDataUrl(kind: string, dataUrl: string, options?: KeepOptions): Promise<string>;
export async function keepDataUrl(kind: string, dataUrl: string | null, options?: KeepOptions): Promise<string | null>;
export async function keepDataUrl(kind: string, dataUrl: string | null, options: KeepOptions = {}): Promise<string | null> {
  if (!dataUrl) return dataUrl;
  refuseLookalike(dataUrl);
  const parsed = parseDataUrl(dataUrl);
  if (!parsed) return dataUrl;
  const counted = options.counted !== false;
  if (counted) await assertRoomFor(parsed.bytes.length);
  const ref = await put(kind, parsed.bytes, parsed.contentType);
  if (counted) await noteStored(parsed.bytes.length);
  return ref ? textRef(ref) : dataUrl;
}

/** What to save in a Bytes column: a reference once the file is in the box, or the bytes unchanged when there is none. */
export async function keepBytes(kind: string, data: Uint8Array, contentType: string, options: KeepOptions = {}): Promise<Uint8Array<ArrayBuffer>> {
  const bytes = asBuffer(data);
  if (bytes.length === 0) return toPrismaBytes(bytes);
  refuseLookalike(bytes);
  const counted = options.counted !== false;
  if (counted) await assertRoomFor(bytes.length);
  const ref = await put(kind, bytes, contentType);
  if (counted) await noteStored(bytes.length);
  return toPrismaBytes(ref ? Buffer.concat([BYTES_MAGIC, Buffer.from(textRef(ref), "utf8")]) : bytes);
}

/** Prisma's Bytes wants a Uint8Array over a plain ArrayBuffer. */
function toPrismaBytes(buf: Buffer): Uint8Array<ArrayBuffer> {
  const copy = new Uint8Array(new ArrayBuffer(buf.byteLength));
  copy.set(buf);
  return copy;
}

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────────

async function fetchRef(ref: StoredRef): Promise<Buffer> {
  const tenant = await currentTenant();
  const hit = recall(tenant.id, ref.key);
  if (hit) return hit;
  const box = (await storageBox());
  // A reference with no box to read it from: the box's settings were taken off the server after files went in.
  if (!box) throw new StoredFileMissing(ref.key);
  const sealed = await workspaceBox(box, tenant.id, "files").get(ref.key);
  if (!sealed) throw new StoredFileMissing(ref.key);
  const bytes = openBuffer(tenant.id, sealed, "file");
  remember(tenant.id, ref.key, bytes);
  return bytes;
}

/**
 * A file as bytes and type, whichever way it is kept: a reference is fetched from the box; a data URL is decoded;
 * bytes are returned as they are, with `fallbackType`. Null for an empty value. Throws `StoredFileMissing` for a
 * reference the box doesn't have.
 */
export async function storedFile(value: string | Uint8Array | null | undefined, fallbackType = "application/octet-stream"): Promise<{ bytes: Buffer; contentType: string } | null> {
  if (value == null) return null;
  const ref = storedRef(value);
  if (ref) return { bytes: await fetchRef(ref), contentType: ref.contentType };
  if (typeof value === "string") return value ? parseDataUrl(value) : null;
  const bytes = asBuffer(value);
  return bytes.length ? { bytes, contentType: fallbackType } : null;
}

/** A data-URL column's value as a data URL again — the reference fetched, anything else as it was. */
export async function dataUrlOf(value: string): Promise<string>;
export async function dataUrlOf(value: string | null | undefined): Promise<string | null>;
export async function dataUrlOf(value: string | null | undefined): Promise<string | null> {
  if (value == null) return null;
  const ref = storedRef(value);
  if (!ref) return value;
  return toDataUrl(await fetchRef(ref), ref.contentType);
}

/** A Bytes column's value as the file's bytes — the reference fetched, anything else as it was. */
export async function bytesOf(value: Uint8Array): Promise<Buffer>;
export async function bytesOf(value: Uint8Array | null | undefined): Promise<Buffer | null>;
export async function bytesOf(value: Uint8Array | null | undefined): Promise<Buffer | null> {
  if (value == null) return null;
  const ref = storedRef(value);
  return ref ? fetchRef(ref) : asBuffer(value);
}

/** Like `dataUrlOf`, but a missing file reads as null rather than throwing — for a photo or a picture on a page. */
export async function dataUrlOrNull(value: string | null | undefined): Promise<string | null> {
  try {
    return await dataUrlOf(value);
  } catch (err) {
    if (err instanceof StoredFileMissing) return null;
    throw err;
  }
}

// ─── A small memory of recent files ──────────────────────────────────────────────────────────────

/**
 * Photos and pictures are asked for on page after page; a box's file never changes under its key (a new file is a new
 * key), so the small ones are remembered here — at most 64 MB, none over 1 MB, the least recently used let go.
 */
const MEMORY_MAX = 64 * 1024 * 1024;
const ITEM_MAX = 1024 * 1024;
const memory = new Map<string, Buffer>();
let memoryBytes = 0;

function remember(tenantId: string, key: string, bytes: Buffer): void {
  if (bytes.length > ITEM_MAX) return;
  const id = `${tenantId}|${key}`;
  if (memory.has(id)) return;
  memory.set(id, bytes);
  memoryBytes += bytes.length;
  for (const [k, v] of memory) {
    if (memoryBytes <= MEMORY_MAX) break;
    memory.delete(k);
    memoryBytes -= v.length;
  }
}

/**
 * Everything remembered let go — after a restore has written files back under keys that may be remembered from
 * before, and for the checks, which read the same keys as two servers in one process.
 */
export function forgetRememberedFiles(): void {
  memory.clear();
  memoryBytes = 0;
}

function recall(tenantId: string, key: string): Buffer | null {
  const id = `${tenantId}|${key}`;
  const hit = memory.get(id);
  if (!hit) return null;
  memory.delete(id);
  memory.set(id, hit);
  return hit;
}
