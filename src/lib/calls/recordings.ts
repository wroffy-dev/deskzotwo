import { readFile, writeFile } from "node:fs/promises";
import { db } from "@/lib/db";
import { openBuffer, sealBuffer } from "@/lib/backup/at-rest";
import { callAccess, throughAccount } from "@/lib/authz/access";
import { can } from "@/lib/authz/resolve";
import { notMigratedYet } from "@/lib/not-migrated";
import { openStore, type OffsiteStore } from "@/lib/offsite/store";
import { storageBox, workspaceBox } from "@/lib/storage/box";
import { assertRoomFor, noteStored, StorageFull } from "@/lib/storage/allowance";
import { currentTenant } from "@/lib/tenancy/resolve";

/**
 * Call recordings from the phone's own call recorder, the way Kylas does it (owner, 9 Nov 2026). Android won't let an
 * app record a call; the phone's built-in recorder does, and the Deskzo app finds the file it made for a logged call
 * and sends it here. Off until an admin switches it on (Settings › Deskzo app); kept for the days they choose (90
 * unless set), then deleted.
 *
 * The sound goes to the recordings store, never the database: Azure Blob, as the owner chose —
 *   RECORDINGS_AZURE_CONTAINER_URL  https://<account>.blob.core.windows.net/<container>
 *   RECORDINGS_AZURE_SAS            a SAS token with read, add, create, write and delete
 * or, for a server without Azure (and the checks), RECORDINGS_DIR, a folder. Each workspace has its own folder in it.
 * With none of those set, the server's storage box (owner, 13 Nov 2026 — src/lib/storage/box.ts): each workspace's
 * `workspaces/<id>/recordings/`. A server that already has RECORDINGS_* keeps using it, so every recording kept there
 * is still found where its row says.
 *
 * Who listens: whoever can see the call — its company and its caller, as the Calls list asks — when it's their own
 * call, or they hold "Listen to call recordings". Every play is written down.
 */

export const MAX_RECORDING_BYTES = 40 * 1024 * 1024;
export const RETENTION_CHOICES = [30, 60, 90, 180, 365, 730] as const;
export const DEFAULT_RETENTION_DAYS = 90;

/** What a recorder writes, by extension, and what it's served as. */
const TYPES: Record<string, string> = {
  m4a: "audio/mp4",
  mp4: "audio/mp4",
  aac: "audio/aac",
  amr: "audio/amr",
  "3gp": "audio/3gpp",
  mp3: "audio/mpeg",
  ogg: "audio/ogg",
  opus: "audio/ogg",
  wav: "audio/wav",
};

/** The file's kind from its name, or null for something that isn't a recording. */
export function recordingType(fileName: string | null | undefined): { ext: string; contentType: string } | null {
  const ext = (fileName ?? "").toLowerCase().match(/\.([a-z0-9]{2,4})$/)?.[1];
  return ext && TYPES[ext] ? { ext, contentType: TYPES[ext]! } : null;
}

/**
 * Security audit, 11 Nov 2026 (SEC-54): whether the bytes are the kind of sound file the name says — the first bytes
 * of each format, not its extension, which anybody can choose. An MP4-family file (m4a, mp4, 3gp) says "ftyp" at byte
 * 4; AMR starts "#!AMR"; Ogg "OggS"; WAV "RIFF" … "WAVE"; MP3 an ID3 tag or a frame sync; AAC an ADTS sync or "ADIF".
 */
export function soundMatches(ext: string, bytes: Buffer): boolean {
  const at = (offset: number, text: string) => bytes.length >= offset + text.length && bytes.toString("latin1", offset, offset + text.length) === text;
  const sync = (mask: number, value: number) => bytes.length >= 2 && bytes[0] === 0xff && (bytes[1]! & mask) === value;
  switch (ext) {
    case "m4a":
    case "mp4":
    case "3gp":
      return at(4, "ftyp");
    case "amr":
      return at(0, "#!AMR");
    case "ogg":
    case "opus":
      return at(0, "OggS");
    case "wav":
      return at(0, "RIFF") && at(8, "WAVE");
    case "mp3":
      return at(0, "ID3") || sync(0xe0, 0xe0);
    case "aac":
      return at(0, "ADIF") || sync(0xf6, 0xf0);
    default:
      return false;
  }
}

/** Recordings one phone may send in a day (SEC-54): more calls than anybody makes. */
export const RECORDINGS_PER_DEVICE_PER_DAY = 300;

/** When a recording made now is deleted: never with no retention. */
export const deleteAfterOf = (retentionDays: number | null, now = new Date()) => (retentionDays === null ? null : new Date(now.getTime() + retentionDays * 86_400_000));

/**
 * A workspace's folder in the recordings store, by its id, as it is on disk or in the container — what is in it is
 * sealed (new recordings) or not (ones sent before 14 Nov 2026). For a job outside the workspace's requests: purging a
 * closed one (src/lib/platform/lifecycle.ts). Null when the server has no store.
 */
export async function rawRecordingStoreFor(tenantId: string): Promise<OffsiteStore | null> {
  const prefix = `ws-${tenantId}`.replace(/[^A-Za-z0-9._-]/g, "-");
  const azure = process.env.RECORDINGS_AZURE_CONTAINER_URL?.trim();
  if (azure) return openStore({ provider: "azure", containerUrl: azure, prefix }, process.env.RECORDINGS_AZURE_SAS?.trim() || null);
  const dir = process.env.RECORDINGS_DIR?.trim();
  if (dir) return openStore({ provider: "filesystem", path: dir, prefix }, null);
  const box = (await storageBox());
  return box ? workspaceBox(box, tenantId, "recordings") : null;
}

/**
 * Security audit round three, 14 Nov 2026 (R3-24): recordings sealed under the workspace's key, like every other file
 * in the box (src/lib/backup/at-rest.ts, "file") — the store's key alone opens none of them, and a recording copied into
 * another workspace's folder doesn't open there. A recording sent before this is read as it was (`openBuffer` returns
 * unsealed bytes untouched).
 */
function sealedRecordings(store: OffsiteStore, tenantId: string): OffsiteStore {
  const get = async (key: string) => {
    const sealed = await store.get(key);
    return sealed ? openBuffer(tenantId, sealed, "file") : null;
  };
  return {
    label: store.label,
    fingerprint: store.fingerprint,
    put: (key, body) => store.put(key, sealBuffer(tenantId, body, "file")),
    putFile: async (key, file) => store.put(key, sealBuffer(tenantId, await readFile(file), "file")),
    get,
    async getToFile(key, file) {
      const bytes = await get(key);
      if (!bytes) return false;
      await writeFile(file, bytes);
      return true;
    },
    list: (prefix, options) => store.list(prefix, options),
    remove: (key) => store.remove(key),
  };
}

/** The store, for this workspace: its own folder in the container, sealed. Null when the server has none set up. */
export async function recordingStore(): Promise<OffsiteStore | null> {
  const tenantId = (await currentTenant()).id;
  const raw = (await rawRecordingStoreFor(tenantId));
  return raw ? sealedRecordings(raw, tenantId) : null;
}

export type RecordingSettings = { enabled: boolean; retentionDays: number | null };

export async function recordingSettings(): Promise<RecordingSettings> {
  try {
    const row = await db.callRecordingSettings.findUnique({ where: { id: "default" }, select: { enabled: true, retentionDays: true } });
    return row ?? { enabled: false, retentionDays: DEFAULT_RETENTION_DAYS };
  } catch (err) {
    if (notMigratedYet(err)) return { enabled: false, retentionDays: DEFAULT_RETENTION_DAYS };
    throw err;
  }
}

/** Whether the app should send recordings now: switched on, and somewhere to put them. */
export async function recordingsWanted(): Promise<boolean> {
  return (await recordingSettings()).enabled && (await recordingStore()) !== null;
}

export class RecordingRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

/**
 * A recording the phone sent for one of its own logged calls. Once a call: sent again, it's the one already kept.
 * Throws `RecordingRefused` with what the phone should hear.
 */
export async function keepRecording(input: { callId: string; appDeviceId: string; userId: string; fileName: string | null; bytes: Buffer }): Promise<{ id: string; again: boolean }> {
  const settings = await recordingSettings();
  if (!settings.enabled) throw new RecordingRefused(409, "recordings_off", "Call recordings are switched off for this workspace.");
  const store = await recordingStore();
  if (!store) throw new RecordingRefused(503, "no_store", "This server has nowhere to keep recordings yet.");
  const kind = recordingType(input.fileName);
  if (!kind) throw new RecordingRefused(415, "not_audio", "That isn't a recording this app sends.");
  if (input.bytes.length === 0 || input.bytes.length > MAX_RECORDING_BYTES) throw new RecordingRefused(413, "too_big", "A recording is up to 40 MB.");
  if (!soundMatches(kind.ext, input.bytes)) throw new RecordingRefused(415, "not_audio", "That isn't a recording this app sends.");
  const call = await db.callLog.findFirst({ where: { id: input.callId, source: "PHONE", appDeviceId: input.appDeviceId, userId: input.userId }, select: { id: true, startedAt: true } });
  if (!call) throw new RecordingRefused(404, "not_found", "No call from this phone by that id.");
  const before = await db.callRecording.findUnique({ where: { callLogId: call.id }, select: { id: true } });
  if (before) return { id: before.id, again: true };
  const today = await db.callRecording.count({ where: { appDeviceId: input.appDeviceId, createdAt: { gte: new Date(Date.now() - 86_400_000) } } });
  if (today >= RECORDINGS_PER_DEVICE_PER_DAY) throw new RecordingRefused(429, "too_many", `This phone has sent ${RECORDINGS_PER_DEVICE_PER_DAY} recordings today — the rest wait for tomorrow.`);

  // Counted against the workspace's storage as every file is (storage in the plans, 20 Nov 2026 — src/lib/storage/
  // quota.ts). At the limit, 507: the app keeps the recording and sends it again on a later sync — after an
  // administrator has added storage — where a 413 would have it let go.
  try {
    await assertRoomFor(input.bytes.length);
  } catch (err) {
    if (err instanceof StorageFull) throw new RecordingRefused(507, "storage_full", err.message);
    throw err;
  }

  const at = call.startedAt.toISOString();
  const key = `calls/${at.slice(0, 4)}/${at.slice(5, 7)}/${call.id}.${kind.ext}`;
  await store.put(key, input.bytes);
  try {
    const row = await db.callRecording.create({
      data: { callLogId: call.id, storageKey: key, contentType: kind.contentType, sizeBytes: input.bytes.length, fileName: input.fileName?.slice(0, 200) ?? null, appDeviceId: input.appDeviceId, deleteAfter: deleteAfterOf(settings.retentionDays) },
      select: { id: true },
    });
    await noteStored(input.bytes.length);
    return { id: row.id, again: false };
  } catch (err) {
    // Two sends at once: the other kept it.
    const other = await db.callRecording.findUnique({ where: { callLogId: call.id }, select: { id: true } });
    if (other) return { id: other.id, again: true };
    throw err;
  }
}

/** The recording of a call this person may listen to, or why not. Doesn't count a play. */
export async function listenable(userId: string, callId: string): Promise<{ recordingId: string; storageKey: string; contentType: string; sizeBytes: number } | null> {
  const call = await db.callLog.findFirst({
    where: { AND: [{ id: callId }, await throughAccount(userId, "view"), await callAccess(userId, "view")] },
    select: { userId: true, recording: { select: { id: true, storageKey: true, contentType: true, sizeBytes: true } } },
  });
  if (!call?.recording) return null;
  if (call.userId !== userId && !(await can(userId, "calls.listen"))) return null;
  return { recordingId: call.recording.id, storageKey: call.recording.storageKey, contentType: call.recording.contentType, sizeBytes: call.recording.sizeBytes };
}

/** How long one play covers: a player's seeks and re-requests inside it are the same listening. */
export const PLAY_COVERS_MS = 5 * 60_000;

/**
 * Security audit, 11 Nov 2026 (SEC-52): a play, written down, for any request that sends sound — not only one that
 * starts at byte 0: a suffix range (`bytes=-N`) or `bytes=1-` fetched the whole file unlogged. Once per person per
 * recording in `PLAY_COVERS_MS`, so a player's seeks don't each count. Never throws.
 */
export async function notePlay(recordingId: string, userId: string, now = new Date()): Promise<boolean> {
  try {
    const recent = await db.callRecordingPlay.findFirst({ where: { recordingId, userId, at: { gte: new Date(now.getTime() - PLAY_COVERS_MS) } }, select: { id: true } });
    if (recent) return false;
    await db.callRecordingPlay.create({ data: { recordingId, userId, at: now } });
    return true;
  } catch {
    return false;
  }
}

/** Which of these calls have a recording this person may play — for the Calls list's buttons. */
export async function playableCalls(userId: string, calls: { id: string; userId: string }[]): Promise<Set<string>> {
  if (!calls.length) return new Set();
  try {
    const withRecording = await db.callRecording.findMany({ where: { callLogId: { in: calls.map((c) => c.id) } }, select: { callLogId: true } });
    if (!withRecording.length) return new Set();
    const listensToAll = await can(userId, "calls.listen");
    const own = new Set(calls.filter((c) => c.userId === userId).map((c) => c.id));
    return new Set(withRecording.map((r) => r.callLogId).filter((id) => listensToAll || own.has(id)));
  } catch (err) {
    if (notMigratedYet(err)) return new Set();
    throw err;
  }
}

/** Deletes recordings past their day, a couple of hundred at a time: the sound first, then the row. */
export async function sweepRecordings(now = new Date()): Promise<number> {
  try {
    const due = await db.callRecording.findMany({ where: { deleteAfter: { lt: now } }, take: 200, select: { id: true, storageKey: true } });
    if (!due.length) return 0;
    const store = await recordingStore();
    let removed = 0;
    for (const r of due) {
      if (store) await store.remove(r.storageKey).catch((err) => console.error("[recordings] couldn't delete", r.storageKey, err instanceof Error ? err.message : err));
      await db.callRecording.delete({ where: { id: r.id } });
      removed += 1;
    }
    return removed;
  } catch (err) {
    if (notMigratedYet(err)) return 0;
    throw err;
  }
}

/** The recordings kept now: how many and how big, for the settings page. */
export async function recordingTotals(): Promise<{ count: number; bytes: number }> {
  try {
    const t = await db.callRecording.aggregate({ _count: true, _sum: { sizeBytes: true } });
    return { count: t._count, bytes: t._sum.sizeBytes ?? 0 };
  } catch (err) {
    if (notMigratedYet(err)) return { count: 0, bytes: 0 };
    throw err;
  }
}
