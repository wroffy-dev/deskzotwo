import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, type Hash } from "node:crypto";
import { once } from "node:events";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { Readable, type Writable } from "node:stream";
import { finished } from "node:stream/promises";
import {
  ArchiveFormatError,
  PassphraseError,
  deriveKey,
  newKdf,
  passphraseProblem,
  sealVerifier,
  verifierOpens,
  type ArchiveKdf,
  type SealedValue,
} from "@/lib/backup/archive";

/**
 * A Backup & Restore bundle (`.dzbk`): one file that carries a whole installation — or one workspace — from one
 * server to another (owner, 26 Nov 2026). Built on the server, downloaded, uploaded somewhere else, restored there.
 * Never kept in a store: it is as big as everything it holds (one workspace alone has ~5 GB of files), so every part
 * of it is streamed — through the writer, through the reader — and nothing ever holds an entry in memory.
 *
 * ## Layout
 *
 *     magic       8 bytes     "DZBUNDLE"
 *     version     1 byte      1
 *     headerLen   4 bytes     big-endian
 *     header      headerLen   UTF-8 JSON, in the clear (BundleHeader) — nothing secret
 *     frames      ...         until the frame flagged final
 *
 *   each frame:
 *     length      4 bytes     big-endian, the ciphertext's length — exactly `frameSize` except in the final frame
 *     ciphertext  length      AES-256-GCM
 *     tag         16 bytes
 *
 *   nonce = noncePrefix (4 random bytes, in the header) ‖ frame counter (8 bytes, big-endian, from 0)
 *   AAD   = sha256(magic ‖ version ‖ headerLen ‖ header) ‖ frame counter (8) ‖ final flag (1 byte: 1 final, 0 not)
 *
 * The key is HKDF'd from the scrypt key of the passphrase (the same KDF, parameters and verifier as the workspace
 * archive — src/lib/backup/archive.ts), so the verifier and the body never share a key. Binding the header's hash,
 * the counter and the final flag into every tag is what lets a reader refuse, each with its own reason:
 *
 *   · a wrong passphrase — the verifier, before a byte of the body is read;
 *   · an altered header — every frame was sealed against the header's hash, so the first one fails;
 *   · a flipped byte anywhere in the body — that frame's tag;
 *   · reordered, removed or repeated frames — the counter is in the nonce and the AAD;
 *   · a truncated file — the last frame present was not sealed as the final one;
 *   · bytes added after the end — the final frame was sealed as final, and something follows it.
 *
 * ## Inside (the plaintext, across frame boundaries)
 *
 * Records, each `type (1 byte) ‖ length (4 bytes, big-endian) ‖ payload`:
 *
 *     'E'   an entry starts: JSON { name, contentType? }
 *     'D'   a chunk of the entry's bytes (at most CHUNK_BYTES; any number of them)
 *     'X'   the entry ends (no payload)
 *     'M'   the manifest, last: JSON { entries: [{ name, size, sha256 }], counts, notes? }
 *
 * So a stream of unknown length — pg_dump's stdout, a file coming out of the storage box — goes in without anybody
 * knowing its size first. The manifest comes last because only then are the sizes and hashes known; a reader checks
 * every entry against it, and refuses a bundle whose entries and manifest disagree.
 *
 * Streaming has one consequence a restore must respect: `readBundle` hands each entry over as it goes, and only knows
 * at the end whether the whole file was sound. A restore therefore runs `verifyBundle` (one full read, nothing
 * written) before it touches anything, and treats what `readBundle` hands it as provisional until it resolves.
 */

export const BUNDLE_MAGIC = Buffer.from("DZBUNDLE", "latin1");
export const BUNDLE_VERSION = 1;
export const BUNDLE_EXTENSION = ".dzbk";
const PREAMBLE_BYTES = BUNDLE_MAGIC.length + 1 + 4;
const TAG_BYTES = 16;
const LENGTH_BYTES = 4;
const NONCE_PREFIX_BYTES = 4;
/** 1 MiB: big enough that the frame overhead (20 bytes) is nothing, small enough to hold one at a time. */
export const DEFAULT_FRAME_SIZE = 1024 * 1024;
/** What a reader accepts from a header it has not authenticated yet: never a frame big enough to exhaust memory. */
const MIN_FRAME_SIZE = 256;
const MAX_FRAME_SIZE = 16 * 1024 * 1024;
const MAX_HEADER_BYTES = 4 * 1024 * 1024;
/** A data record's payload, at most. */
const CHUNK_BYTES = 256 * 1024;
const MAX_DESCRIPTOR_BYTES = 64 * 1024;
/** The manifest is one JSON value; a box of a few hundred thousand files names them all in it. */
const MAX_MANIFEST_BYTES = 512 * 1024 * 1024;
const VERIFIER_LABEL = "deskzo-bundle-verifier-v1";
const BODY_KEY_INFO = "deskzo/bundle/body/v1";

const REC_ENTRY = 0x45; // 'E'
const REC_DATA = 0x44; // 'D'
const REC_END = 0x58; // 'X'
const REC_MANIFEST = 0x4d; // 'M'

export type BundleKind = "full" | "workspace";

export type BundleWorkspace = { id: string; slug: string; name: string; schemaVersion: string | null };

export type BundleHeader = {
  format: 1;
  kind: BundleKind;
  /** ISO 8601. */
  createdAt: string;
  /** Who asked for it: "staff:<id>", "script:<user>". */
  createdBy: string;
  app: { name: string; version: string | null; commit: string | null };
  /** The control plane's migration, for a full bundle; null for a workspace bundle or an installation without one. */
  control: { schemaVersion: string | null } | null;
  workspaces: BundleWorkspace[];
  /**
   * Which PLATFORM_MASTER_KEY the data was sealed under, without being it (src/lib/platform/kek.ts
   * `platformKeyFingerprint`). The key itself never travels: the server restoring this must be given the same one,
   * and refuses a different one with a clear message before touching anything. Null: no platform key was set.
   */
  keyFingerprint: string | null;
  kdf: ArchiveKdf;
  verifier: SealedValue;
  /** Base64 of 4 random bytes: the front of every frame's nonce. */
  noncePrefix: string;
  /** The plaintext bytes in every frame but the last. */
  frameSize: number;
};

/** What the caller decides; the writer adds the rest (format, kdf, verifier, noncePrefix, frameSize). */
export type BundleHeaderInput = Omit<BundleHeader, "format" | "kdf" | "verifier" | "noncePrefix" | "frameSize">;

export type BundleEntryDescriptor = { name: string; contentType?: string };
export type ManifestEntry = { name: string; size: number; sha256: string; contentType?: string };
export type BundleManifest = {
  entries: ManifestEntry[];
  counts: { entries: number; bytes: number } & Record<string, number>;
  /** Things the builder wants a restore to know, in a line each — a file that vanished while it was being read. */
  notes?: string[];
};

export class BundleFormatError extends ArchiveFormatError {
  constructor(message: string) {
    super(message);
    this.name = "BundleFormatError";
  }
}

/** Why a name can't be an entry's, or null. Names become paths on a restore, so nothing that climbs out of a folder. */
export function entryNameProblem(name: unknown): string | null {
  if (typeof name !== "string" || name.length === 0) return "An entry needs a name.";
  if (name.length > 1024) return "An entry's name is longer than 1024 characters.";
  if (name.startsWith("/") || name.includes("\\") || name.includes("\u0000")) return `"${name.slice(0, 80)}" is not a relative path with forward slashes.`;
  if (name.split("/").some((part) => part === "" || part === "." || part === "..")) return `"${name.slice(0, 80)}" has an empty, "." or ".." part.`;
  return null;
}

const u64 = (n: bigint) => {
  const b = Buffer.alloc(8);
  b.writeBigUInt64BE(n);
  return b;
};

function bodyKeyOf(key: Buffer): Buffer {
  return Buffer.from(hkdfSync("sha256", key, Buffer.alloc(0), BODY_KEY_INFO, 32));
}

function frameAad(headerHash: Buffer, counter: bigint, final: boolean): Buffer {
  return Buffer.concat([headerHash, u64(counter), Buffer.from([final ? 1 : 0])]);
}

function preambleFor(headerJson: Buffer): Buffer {
  const preamble = Buffer.alloc(PREAMBLE_BYTES);
  BUNDLE_MAGIC.copy(preamble, 0);
  preamble.writeUInt8(BUNDLE_VERSION, BUNDLE_MAGIC.length);
  preamble.writeUInt32BE(headerJson.length, BUNDLE_MAGIC.length + 1);
  return preamble;
}

function record(type: number, payload: Buffer | null): Buffer {
  const head = Buffer.alloc(5);
  head.writeUInt8(type, 0);
  head.writeUInt32BE(payload?.length ?? 0, 1);
  return payload ? Buffer.concat([head, payload]) : head;
}

// ─── Writing ─────────────────────────────────────────────────────────────────────────────────────

export type BundleWriter = {
  readonly header: BundleHeader;
  /**
   * Streams one entry in. Entries go in one at a time: await each before the next. `onBytes` hears every chunk's
   * size as it passes (progress). A source that fails leaves the writer unusable — the bundle is abandoned.
   */
  addEntry(
    name: string,
    source: Readable | AsyncIterable<Buffer | Uint8Array | string>,
    options?: { contentType?: string; onBytes?: (bytes: number) => void },
  ): Promise<ManifestEntry>;
  /** Writes the manifest and the final frame, and ends `output`. */
  finish(extra?: { counts?: Record<string, number>; notes?: string[] }): Promise<{ manifest: BundleManifest; bytesWritten: number }>;
  /** Bytes handed to `output` so far. */
  bytesWritten(): number;
};

/**
 * A bundle written to `output` as entries are added. The header goes out at once (with its KDF salt, verifier and
 * nonce prefix filled in); the body follows frame by frame, never more than one frame held.
 */
export async function createBundleWriter(
  output: Writable,
  input: BundleHeaderInput,
  passphrase: string,
  options?: { frameSize?: number },
): Promise<BundleWriter> {
  const problem = passphraseProblem(passphrase);
  if (problem) throw new PassphraseError(problem);
  const frameSize = options?.frameSize ?? DEFAULT_FRAME_SIZE;
  if (!Number.isInteger(frameSize) || frameSize < MIN_FRAME_SIZE || frameSize > MAX_FRAME_SIZE) throw new Error(`A frame is ${MIN_FRAME_SIZE}–${MAX_FRAME_SIZE} bytes.`);

  const kdf = newKdf();
  const key = deriveKey(passphrase, kdf);
  const prefix = randomBytes(NONCE_PREFIX_BYTES);
  const header: BundleHeader = {
    format: 1,
    kind: input.kind,
    createdAt: input.createdAt,
    createdBy: input.createdBy,
    app: input.app,
    control: input.control,
    workspaces: input.workspaces,
    keyFingerprint: input.keyFingerprint,
    kdf,
    verifier: sealVerifier(key, VERIFIER_LABEL),
    noncePrefix: prefix.toString("base64"),
    frameSize,
  };
  const headerJson = Buffer.from(JSON.stringify(header), "utf8");
  if (headerJson.length > MAX_HEADER_BYTES) throw new Error("The bundle's header is too large.");
  const preamble = preambleFor(headerJson);
  const headerHash = createHash("sha256").update(preamble).update(headerJson).digest();
  const bodyKey = bodyKeyOf(key);

  let written = 0;
  let counter = BigInt(0);
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let busy = false;
  let broken: Error | null = null;
  let done = false;
  const entries: ManifestEntry[] = [];
  const names = new Set<string>();

  const emit = async (bytes: Buffer) => {
    written += bytes.length;
    if (!output.write(bytes)) await once(output, "drain");
  };

  const sealFrame = (plain: Buffer, final: boolean): Buffer => {
    const nonce = Buffer.concat([prefix, u64(counter)]);
    const cipher = createCipheriv("aes-256-gcm", bodyKey, nonce);
    cipher.setAAD(frameAad(headerHash, counter, final));
    const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
    const length = Buffer.alloc(LENGTH_BYTES);
    length.writeUInt32BE(ciphertext.length);
    counter += BigInt(1);
    return Buffer.concat([length, ciphertext, cipher.getAuthTag()]);
  };

  /** Queues plaintext, and seals every whole frame it completes. */
  const plain = async (bytes: Buffer) => {
    pending.push(bytes);
    pendingBytes += bytes.length;
    while (pendingBytes >= frameSize) {
      const all = pending.length === 1 ? pending[0]! : Buffer.concat(pending);
      await emit(sealFrame(all.subarray(0, frameSize), false));
      const rest = all.subarray(frameSize);
      pending = rest.length ? [Buffer.from(rest)] : [];
      pendingBytes = rest.length;
    }
  };

  const guard = () => {
    if (broken) throw new Error(`This bundle can't be written any further: ${broken.message}`);
    if (done) throw new Error("This bundle is already finished.");
    if (busy) throw new Error("One entry at a time: await addEntry before adding the next.");
  };

  await emit(preamble);
  await emit(headerJson);

  return {
    header,
    bytesWritten: () => written,
    async addEntry(name, source, opts) {
      guard();
      const why = entryNameProblem(name);
      if (why) throw new Error(why);
      if (names.has(name)) throw new Error(`The bundle already has an entry named ${name}.`);
      busy = true;
      try {
        names.add(name);
        const descriptor: BundleEntryDescriptor = opts?.contentType ? { name, contentType: opts.contentType } : { name };
        await plain(record(REC_ENTRY, Buffer.from(JSON.stringify(descriptor), "utf8")));
        const hash = createHash("sha256");
        let size = 0;
        for await (const piece of source as AsyncIterable<Buffer | Uint8Array | string>) {
          const bytes = typeof piece === "string" ? Buffer.from(piece, "utf8") : Buffer.isBuffer(piece) ? piece : Buffer.from(piece.buffer, piece.byteOffset, piece.byteLength);
          for (let at = 0; at < bytes.length; at += CHUNK_BYTES) {
            const chunk = bytes.subarray(at, Math.min(bytes.length, at + CHUNK_BYTES));
            hash.update(chunk);
            size += chunk.length;
            await plain(record(REC_DATA, chunk));
            opts?.onBytes?.(chunk.length);
          }
        }
        await plain(record(REC_END, null));
        const entry: ManifestEntry = { name, size, sha256: hash.digest("hex"), ...(opts?.contentType ? { contentType: opts.contentType } : {}) };
        entries.push(entry);
        return entry;
      } catch (err) {
        broken = err instanceof Error ? err : new Error(String(err));
        throw err;
      } finally {
        busy = false;
      }
    },
    async finish(extra) {
      guard();
      busy = true;
      try {
        const manifest: BundleManifest = {
          entries,
          counts: { ...(extra?.counts ?? {}), entries: entries.length, bytes: entries.reduce((sum, e) => sum + e.size, 0) },
          ...(extra?.notes?.length ? { notes: extra.notes } : {}),
        };
        await plain(record(REC_MANIFEST, Buffer.from(JSON.stringify(manifest), "utf8")));
        const rest = pending.length === 1 ? pending[0]! : Buffer.concat(pending);
        pending = [];
        pendingBytes = 0;
        await emit(sealFrame(rest, true));
        done = true;
        output.end();
        await finished(output);
        return { manifest, bytesWritten: written };
      } catch (err) {
        broken = err instanceof Error ? err : new Error(String(err));
        throw err;
      } finally {
        busy = false;
      }
    },
  };
}

// ─── Reading ─────────────────────────────────────────────────────────────────────────────────────

/** Exactly-n reads over any byte stream, holding no more than it was asked for plus one chunk. */
class ByteSource {
  private chunks: Buffer[] = [];
  private length = 0;
  private ended = false;
  /** Bytes handed out so far. */
  consumed = 0;
  constructor(private readonly iterator: AsyncIterator<Buffer | Uint8Array | string>) {}

  private async fill(n: number): Promise<void> {
    while (this.length < n && !this.ended) {
      const next = await this.iterator.next();
      if (next.done) {
        this.ended = true;
        break;
      }
      const v = next.value;
      const b = typeof v === "string" ? Buffer.from(v) : Buffer.isBuffer(v) ? v : Buffer.from(v.buffer, v.byteOffset, v.byteLength);
      if (b.length) {
        this.chunks.push(b);
        this.length += b.length;
      }
    }
  }

  /** Up to n bytes — fewer only at the end of the stream. */
  async read(n: number): Promise<Buffer> {
    await this.fill(n);
    const take = Math.min(n, this.length);
    if (take === 0) return Buffer.alloc(0);
    const all = this.chunks.length === 1 ? this.chunks[0]! : Buffer.concat(this.chunks);
    const out = all.subarray(0, take);
    const rest = all.subarray(take);
    this.chunks = rest.length ? [rest] : [];
    this.length = rest.length;
    this.consumed += take;
    return out;
  }

  async atEnd(): Promise<boolean> {
    await this.fill(1);
    return this.length === 0;
  }

  async close(): Promise<void> {
    await this.iterator.return?.().catch(() => {});
  }
}

type ParsedHeader = { header: BundleHeader; headerHash: Buffer; headerBytes: number };

function parseHeaderJson(json: Buffer): BundleHeader {
  let header: BundleHeader;
  try {
    header = JSON.parse(json.toString("utf8")) as BundleHeader;
  } catch {
    throw new BundleFormatError("That bundle's header is not readable — the file is damaged.");
  }
  const prefix = typeof header?.noncePrefix === "string" ? Buffer.from(header.noncePrefix, "base64") : null;
  if (
    header?.format !== 1 ||
    (header.kind !== "full" && header.kind !== "workspace") ||
    !header.kdf?.salt ||
    header.kdf.name !== "scrypt" ||
    !header.verifier?.iv ||
    !prefix ||
    prefix.length !== NONCE_PREFIX_BYTES ||
    !Number.isInteger(header.frameSize) ||
    header.frameSize < MIN_FRAME_SIZE ||
    header.frameSize > MAX_FRAME_SIZE ||
    !Array.isArray(header.workspaces)
  ) {
    throw new BundleFormatError("That bundle's header is missing the fields needed to open it, or has been altered.");
  }
  return header;
}

async function parsePreamble(source: ByteSource): Promise<ParsedHeader> {
  const preamble = await source.read(PREAMBLE_BYTES);
  if (preamble.length < PREAMBLE_BYTES) throw new BundleFormatError("That file is too small to be a backup bundle.");
  if (!preamble.subarray(0, BUNDLE_MAGIC.length).equals(BUNDLE_MAGIC)) {
    const head = preamble.subarray(0, 8).toString("latin1");
    throw new BundleFormatError(
      head === "DESKZOBK"
        ? "That is a workspace backup archive (.wbak), not a Backup & Restore bundle — restore it from the workspace's Backups page."
        : head.startsWith("PGDMP")
          ? "That is a raw pg_dump file, not a Backup & Restore bundle."
          : "That is not a Deskzo Backup & Restore bundle.",
    );
  }
  const version = preamble.readUInt8(BUNDLE_MAGIC.length);
  if (version !== BUNDLE_VERSION) throw new BundleFormatError(`That bundle is format ${version}; this app reads format ${BUNDLE_VERSION}.`);
  const headerLen = preamble.readUInt32BE(BUNDLE_MAGIC.length + 1);
  if (headerLen === 0 || headerLen > MAX_HEADER_BYTES) throw new BundleFormatError("That bundle's header is damaged.");
  const json = await source.read(headerLen);
  if (json.length < headerLen) throw new BundleFormatError("That bundle is truncated inside its header.");
  const header = parseHeaderJson(json);
  return { header, headerHash: createHash("sha256").update(preamble).update(json).digest(), headerBytes: PREAMBLE_BYTES + headerLen };
}

/**
 * The header, without the passphrase — what an upload screen shows before anybody types anything: which kind, when,
 * from which version, which workspaces, which platform key.
 */
export async function readBundleHeader(file: string): Promise<BundleHeader> {
  const info = await stat(file).catch(() => null);
  if (!info?.isFile()) throw new BundleFormatError("There is no file there.");
  const handle = await open(file, "r");
  try {
    const preamble = Buffer.alloc(PREAMBLE_BYTES);
    const { bytesRead } = await handle.read(preamble, 0, PREAMBLE_BYTES, 0);
    const first = preamble.subarray(0, bytesRead);
    const headerLen = bytesRead === PREAMBLE_BYTES ? preamble.readUInt32BE(BUNDLE_MAGIC.length + 1) : 0;
    const json = Buffer.alloc(headerLen > 0 && headerLen <= MAX_HEADER_BYTES ? headerLen : 0);
    if (json.length) await handle.read(json, 0, json.length, PREAMBLE_BYTES);
    const source = new ByteSource((async function* () {
      yield first;
      if (json.length) yield json;
    })());
    return (await parsePreamble(source)).header;
  } finally {
    await handle.close();
  }
}

/** Proves a passphrase against a header in milliseconds (one scrypt), touching nothing else. */
export function bundlePassphraseOpens(header: BundleHeader, passphrase: string): boolean {
  try {
    return verifierOpens(deriveKey(passphrase, header.kdf), header.verifier, VERIFIER_LABEL);
  } catch {
    return false;
  }
}

/** The decrypted body, frame by frame, refusing anything out of place. */
async function* frames(source: ByteSource, parsed: ParsedHeader, bodyKey: Buffer): AsyncGenerator<Buffer> {
  const { header, headerHash } = parsed;
  const prefix = Buffer.from(header.noncePrefix, "base64");
  let counter = BigInt(0);
  for (;;) {
    const n = Number(counter);
    const lengthBytes = await source.read(LENGTH_BYTES);
    if (lengthBytes.length === 0) {
      throw new BundleFormatError(n === 0 ? "That bundle has nothing after its header — the file was cut short." : `That bundle stops after frame ${n} without its final frame — the file is truncated.`);
    }
    if (lengthBytes.length < LENGTH_BYTES) throw new BundleFormatError(`That bundle is truncated inside frame ${n + 1}.`);
    const length = lengthBytes.readUInt32BE(0);
    if (length > header.frameSize) throw new BundleFormatError(`Frame ${n + 1} claims ${length} bytes, more than the bundle's frame size — the file is damaged or altered.`);
    const body = await source.read(length + TAG_BYTES);
    if (body.length < length + TAG_BYTES) throw new BundleFormatError(`That bundle is truncated inside frame ${n + 1}.`);
    const final = await source.atEnd();
    if (!final && length !== header.frameSize) {
      throw new BundleFormatError(`Frame ${n + 1} is short but not the last — the file is damaged, or frames were removed or reordered.`);
    }

    const open = (asFinal: boolean): Buffer | null => {
      const decipher = createDecipheriv("aes-256-gcm", bodyKey, Buffer.concat([prefix, u64(counter)]));
      decipher.setAAD(frameAad(headerHash, counter, asFinal));
      decipher.setAuthTag(body.subarray(length));
      try {
        return Buffer.concat([decipher.update(body.subarray(0, length)), decipher.final()]);
      } catch {
        return null;
      }
    };

    const plain = open(final);
    if (!plain) {
      // Which of the ways a bundle can be wrong this is — worked out only to say so; nothing is released.
      if (final && open(false)) throw new BundleFormatError(`That bundle's final frame is missing — the file is truncated after frame ${n + 1}.`);
      if (!final && open(true)) throw new BundleFormatError(`That bundle has bytes after its final frame (frame ${n + 1}) — something was appended to the file.`);
      if (n === 0) throw new BundleFormatError("The bundle's first frame does not authenticate — its header was altered, or its body is damaged.");
      throw new BundleFormatError(`Frame ${n + 1} failed its integrity check — the file was altered or damaged, or frames were removed or reordered.`);
    }
    counter += BigInt(1);
    yield plain;
    if (final) return;
  }
}

export type OnBundleEntry = (name: string, content: Readable, descriptor: BundleEntryDescriptor) => Promise<void> | void;

type ReadOutcome = { header: BundleHeader; manifest: BundleManifest; problems: string[] };

/** A file's path, or the bytes as they arrive — a stream, an upload's body. */
export type BundleInput = string | Readable | AsyncIterable<Buffer | Uint8Array>;

async function readCore(
  input: BundleInput,
  passphrase: string,
  onEntry: OnBundleEntry,
  options: { collect: boolean; onBytes?: (bytes: number) => void },
): Promise<ReadOutcome> {
  const stream = typeof input === "string" ? createReadStream(input, { highWaterMark: 1024 * 1024 }) : input;
  const raw = new ByteSource(stream[Symbol.asyncIterator]() as AsyncIterator<Buffer | Uint8Array>);
  try {
    const parsed = await parsePreamble(raw);
    const key = (() => {
      try {
        return deriveKey(passphrase, parsed.header.kdf);
      } catch {
        throw new BundleFormatError("That bundle's header names key-derivation settings this app refuses — it was altered.");
      }
    })();
    // The passphrase is proved before a single byte of the body is read.
    if (!verifierOpens(key, parsed.header.verifier, VERIFIER_LABEL)) throw new PassphraseError("That passphrase does not open this bundle.");
    const plain = new ByteSource(frames(raw, parsed, bodyKeyOf(key)));

    let fatal: unknown = null;
    let chain: Promise<unknown> = Promise.resolve();
    /** Record reads, one at a time even when an entry's stream and the drain below both ask. */
    const serial = <T>(fn: () => Promise<T>): Promise<T> => {
      const run = chain.then(async () => {
        if (fatal) throw fatal;
        try {
          return await fn();
        } catch (err) {
          fatal ??= err;
          throw err;
        }
      });
      chain = run.catch(() => {});
      return run;
    };
    const readRecord = async (): Promise<{ type: number; payload: Buffer } | null> => {
      const head = await plain.read(5);
      if (head.length === 0) return null;
      if (head.length < 5) throw new BundleFormatError("The bundle's contents end in the middle of a record.");
      const type = head.readUInt8(0);
      const length = head.readUInt32BE(1);
      const limit = type === REC_DATA ? MAX_FRAME_SIZE : type === REC_MANIFEST ? MAX_MANIFEST_BYTES : type === REC_ENTRY ? MAX_DESCRIPTOR_BYTES : 0;
      if (![REC_ENTRY, REC_DATA, REC_END, REC_MANIFEST].includes(type)) throw new BundleFormatError(`The bundle's contents hold a record of an unknown kind (${type}).`);
      if (length > limit) throw new BundleFormatError("A record in the bundle is larger than any the writer makes.");
      const payload = length ? await plain.read(length) : Buffer.alloc(0);
      if (payload.length < length) throw new BundleFormatError("The bundle's contents end in the middle of a record.");
      return { type, payload };
    };

    const seen: ManifestEntry[] = [];
    const names = new Set<string>();
    let manifest: BundleManifest | null = null;

    for (;;) {
      const rec = await serial(readRecord);
      if (!rec) throw new BundleFormatError("The bundle ends without its manifest — it was not finished when it was written.");
      if (rec.type === REC_MANIFEST) {
        try {
          manifest = JSON.parse(rec.payload.toString("utf8")) as BundleManifest;
        } catch {
          throw new BundleFormatError("The bundle's manifest is not readable.");
        }
        if (!(await plain.atEnd())) throw new BundleFormatError("The bundle has contents after its manifest.");
        break;
      }
      if (rec.type !== REC_ENTRY) throw new BundleFormatError("The bundle's contents are out of order — data outside an entry.");
      let descriptor: BundleEntryDescriptor;
      try {
        descriptor = JSON.parse(rec.payload.toString("utf8")) as BundleEntryDescriptor;
      } catch {
        throw new BundleFormatError("An entry's description in the bundle is not readable.");
      }
      const why = entryNameProblem(descriptor?.name);
      if (why) throw new BundleFormatError(`The bundle holds an entry it must not: ${why}`);
      if (names.has(descriptor.name)) throw new BundleFormatError(`The bundle holds ${descriptor.name} twice.`);
      names.add(descriptor.name);

      const state: { done: boolean; size: number; hash: Hash } = { done: false, size: 0, hash: createHash("sha256") };
      const nextChunk = () =>
        serial(async () => {
          if (state.done) return null;
          const r = await readRecord();
          if (!r) throw new BundleFormatError(`The bundle ends inside ${descriptor.name}.`);
          if (r.type === REC_END) {
            state.done = true;
            return null;
          }
          if (r.type !== REC_DATA) throw new BundleFormatError(`${descriptor.name} is malformed inside the bundle.`);
          state.size += r.payload.length;
          state.hash.update(r.payload);
          options.onBytes?.(r.payload.length);
          return r.payload;
        });
      const content = Readable.from(
        (async function* () {
          for (;;) {
            const chunk = await nextChunk();
            if (chunk === null) return;
            yield chunk;
          }
        })(),
        { objectMode: false },
      );
      try {
        await onEntry(descriptor.name, content, descriptor);
      } catch (err) {
        content.destroy();
        throw fatal ?? err;
      }
      // Whatever the consumer left unread is read here, so the next entry starts where it should and every byte is hashed.
      while ((await nextChunk()) !== null) {
        /* draining */
      }
      content.destroy();
      seen.push({ name: descriptor.name, size: state.size, sha256: state.hash.digest("hex") });
    }

    const problems = checkManifest(manifest, seen);
    if (problems.length && !options.collect) throw new BundleFormatError(problems[0]!);
    return { header: parsed.header, manifest: manifest!, problems };
  } finally {
    await raw.close();
    if (typeof input === "string") (stream as ReturnType<typeof createReadStream>).destroy();
  }
}

function checkManifest(manifest: BundleManifest | null, seen: ManifestEntry[]): string[] {
  if (!manifest || !Array.isArray(manifest.entries)) return ["The bundle's manifest has no list of entries."];
  const problems: string[] = [];
  const listed = new Map(manifest.entries.map((e) => [e.name, e]));
  for (const entry of seen) {
    const m = listed.get(entry.name);
    if (!m) problems.push(`${entry.name} is in the bundle but not in its manifest.`);
    else if (m.size !== entry.size) problems.push(`${entry.name} holds ${entry.size} bytes; the manifest says ${m.size}.`);
    else if (m.sha256 !== entry.sha256) problems.push(`${entry.name} does not match the checksum in the manifest.`);
  }
  const present = new Set(seen.map((e) => e.name));
  for (const m of manifest.entries) if (!present.has(m.name)) problems.push(`The manifest lists ${m.name}, which is not in the bundle.`);
  return problems;
}

/**
 * Reads a bundle start to end, handing each entry to `onEntry` as a stream as it comes. `onEntry` should consume the
 * stream (whatever it leaves is read and discarded); when it returns, the next entry starts. Resolves only when the
 * whole file has passed: every frame authenticated, the final one present, every entry matching the manifest. Throws
 * `PassphraseError` before reading any of the body, and `BundleFormatError` saying what is wrong otherwise — mid-way
 * through, when that is where the damage is: so what `onEntry` received is provisional until this resolves.
 */
export async function readBundle(input: BundleInput, passphrase: string, onEntry: OnBundleEntry): Promise<{ header: BundleHeader; manifest: BundleManifest }> {
  const { header, manifest } = await readCore(input, passphrase, onEntry, { collect: false });
  return { header, manifest };
}

export type BundleVerification = { ok: boolean; problems: string[]; manifest: BundleManifest | null; header: BundleHeader | null };

/**
 * The whole file read once, nothing written: whether it opens with this passphrase and is sound throughout. A wrong
 * passphrase or a damaged file is a problem in the answer, never a throw.
 */
export async function verifyBundle(file: string, passphrase: string, options?: { onBytes?: (bytes: number) => void }): Promise<BundleVerification> {
  let header: BundleHeader | null = null;
  try {
    header = await readBundleHeader(file);
    const outcome = await readCore(file, passphrase, () => {}, { collect: true, onBytes: options?.onBytes });
    return { ok: outcome.problems.length === 0, problems: outcome.problems, manifest: outcome.manifest, header: outcome.header };
  } catch (err) {
    return { ok: false, problems: [err instanceof Error ? err.message : String(err)], manifest: null, header };
  }
}
