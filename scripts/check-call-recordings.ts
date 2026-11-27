/**
 * check:call-recordings — the phone recorder's files, kept and played (owner, 9 Nov 2026 — src/lib/calls/recordings.ts).
 *
 *   1. The rules: which files are recordings, when one is deleted.
 *   2. On the database, with a folder store of its own and a phone call of its own (ZZPROBE_REC, removed in a finally):
 *      refused while switched off; kept once, sent again it's the same; only this phone's call; the caller plays their
 *      own, somebody without "Listen to call recordings" can't play another's, somebody with it can; the play route
 *      answers a seek; past its day it's deleted, sound and row.
 *
 *   npm run check:call-recordings
 */
import "dotenv/config";
import Module from "node:module";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { deleteAfterOf, recordingType } from "../src/lib/calls/recordings";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};

let actorId = "";
const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const u = async () => ({ id: actorId, name: "Probe" });
    return { requireUser: u, currentUser: u, getCurrentUser: u, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

async function main() {
  console.log("\n— 1. The rules —\n");
  ok("a recorder's files are recordings", ["Call@Priya_20261109.m4a", "rec.amr", "x.mp3", "y.3gp", "z.wav", "a.aac", "b.ogg"].every((n) => recordingType(n) !== null));
  ok("  anything else isn't", ["photo.jpg", "notes.txt", "noext", "", null].every((n) => recordingType(n) === null));
  ok("  served as what it is", recordingType("a.m4a")?.contentType === "audio/mp4" && recordingType("a.amr")?.contentType === "audio/amr");
  const now = new Date("2026-11-09T10:00:00Z");
  ok("kept 90 days, deleted after; kept for good, never", deleteAfterOf(90, now)?.toISOString() === "2027-02-07T10:00:00.000Z" && deleteAfterOf(null, now) === null);

  console.log("\n— 2. On the database —\n");
  const dir = mkdtempSync(path.join(os.tmpdir(), "deskzo-rec-"));
  process.env.RECORDINGS_DIR = dir;
  delete process.env.RECORDINGS_AZURE_CONTAINER_URL;
  const { db } = await import("../src/lib/db");
  const rec = await import("../src/lib/calls/recordings");
  const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });
  const call = await db.callLog.findFirst({ where: { source: "PHONE", appDeviceId: { not: null }, recording: null }, select: { id: true, userId: true, appDeviceId: true } });
  const madeCall = !call;
  let probe = call;
  const before = await db.callRecordingSettings.findUnique({ where: { id: "default" } });
  try {
    if (!probe) {
      // A phone call of its own, on a phone of its own.
      const caller = await db.user.findFirstOrThrow({ where: { active: true, isSuperAdmin: false, kind: "MEMBER", role: "SALES" }, select: { id: true } });
      const company = await db.company.findFirstOrThrow({ where: { ownerUserId: caller.id }, select: { id: true } }).catch(() => db.company.findFirstOrThrow({ select: { id: true } }));
      const device = await db.userDevice.create({ data: { userId: caller.id, kind: "MOBILE", status: "APPROVED", label: "ZZPROBE_REC phone", tokenHash: `zzprobe-rec-${Date.now()}` } as never, select: { id: true } });
      const phone = await db.appDevice.create({ data: { userId: caller.id, deviceId: device.id, platform: "android", model: "ZZPROBE_REC" } as never, select: { id: true } });
      probe = await db.callLog.create({ data: { companyId: company.id, userId: caller.id, phoneNumber: "+919800000001", direction: "OUTBOUND", outcome: "CONNECTED", durationSeconds: 95, startedAt: new Date(), source: "PHONE", appDeviceId: phone.id, phoneCallKey: `zzprobe-rec-${Date.now()}`, notes: "ZZPROBE_REC" } as never, select: { id: true, userId: true, appDeviceId: true } });
    }
    const p = probe!;
    // An m4a as recorders write it: its "ftyp" box at byte 4 — the bytes are checked, not the name (security audit SEC-54).
    const bytes = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A "), Buffer.from("fake audio ".repeat(200))]);
    await db.callRecordingSettings.upsert({ where: { id: "default" }, create: { id: "default", enabled: false }, update: { enabled: false } });
    const off = await rec.keepRecording({ callId: p.id, appDeviceId: p.appDeviceId!, userId: p.userId, fileName: "Call_x.m4a", bytes }).catch((e) => e);
    ok("switched off: refused, nothing kept", off instanceof rec.RecordingRefused && off.code === "recordings_off" && !(await db.callRecording.count({ where: { callLogId: p.id } })));
    await db.callRecordingSettings.update({ where: { id: "default" }, data: { enabled: true, retentionDays: 90 } });
    ok("switched on with a store: the app is told to send", await rec.recordingsWanted());
    const notAudio = await rec.keepRecording({ callId: p.id, appDeviceId: p.appDeviceId!, userId: p.userId, fileName: "photo.jpg", bytes }).catch((e) => e);
    ok("a file that isn't a recording is refused", notAudio instanceof rec.RecordingRefused && notAudio.code === "not_audio");
    const renamed = await rec.keepRecording({ callId: p.id, appDeviceId: p.appDeviceId!, userId: p.userId, fileName: "Call_x.m4a", bytes: Buffer.from("%PDF-1.7 not a sound") }).catch((e) => e);
    ok("  nor is one only named like one", renamed instanceof rec.RecordingRefused && renamed.code === "not_audio");
    const otherPhone = await rec.keepRecording({ callId: p.id, appDeviceId: "not-this-phone", userId: p.userId, fileName: "Call_x.m4a", bytes }).catch((e) => e);
    ok("another phone's call is refused", otherPhone instanceof rec.RecordingRefused && otherPhone.code === "not_found");
    const kept = await rec.keepRecording({ callId: p.id, appDeviceId: p.appDeviceId!, userId: p.userId, fileName: "Call_x.m4a", bytes });
    const row = await db.callRecording.findUniqueOrThrow({ where: { id: kept.id } });
    ok("kept: the row, the sound in the store, deleted in 90 days", !kept.again && row.sizeBytes === bytes.length && existsSync(dir) && !!row.deleteAfter && Math.round((row.deleteAfter.getTime() - row.createdAt.getTime()) / 86_400_000) === 90);
    const store = await rec.recordingStore();
    ok("  and the store gives it back", (await store!.get(row.storageKey))?.equals(bytes) === true);
    const again = await rec.keepRecording({ callId: p.id, appDeviceId: p.appDeviceId!, userId: p.userId, fileName: "Call_x.m4a", bytes });
    ok("sent again: the same one", again.again && again.id === kept.id && (await db.callRecording.count({ where: { callLogId: p.id } })) === 1);

    ok("the caller plays their own", (await rec.listenable(p.userId, p.id))?.recordingId === kept.id);
    const plain = await db.user.findFirst({ where: { active: true, isSuperAdmin: false, kind: "MEMBER", role: "SUPPORT", id: { not: p.userId } }, select: { id: true } });
    if (plain) ok("somebody without Listen to call recordings can't play another's", (await rec.listenable(plain.id, p.id)) === null);
    ok("the super admin (who holds it) can", (await rec.listenable(admin.id, p.id))?.recordingId === kept.id);
    const listed = await rec.playableCalls(p.userId, [{ id: p.id, userId: p.userId }]);
    ok("the Calls list shows the caller a play button", listed.has(p.id));

    // The play route, as the caller, with a seek.
    actorId = p.userId;
    const route = await import("../src/app/api/calls/[id]/recording/route");
    const first = await route.GET(new Request("http://x/api/calls/x/recording"), { params: Promise.resolve({ id: p.id }) });
    const seek = await route.GET(new Request("http://x/api/calls/x/recording", { headers: { range: "bytes=100-199" } }), { params: Promise.resolve({ id: p.id }) });
    ok("played: the whole sound, as audio", first.status === 200 && first.headers.get("content-type") === "audio/mp4" && Number(first.headers.get("content-length")) === bytes.length);
    ok("  a seek gets just that part", seek.status === 206 && seek.headers.get("content-range") === `bytes 100-199/${bytes.length}` && (await seek.arrayBuffer()).byteLength === 100);
    ok("  the play is written down, once", (await db.callRecordingPlay.count({ where: { recordingId: kept.id } })) === 1);

    await db.callRecording.update({ where: { id: kept.id }, data: { deleteAfter: new Date(Date.now() - 1000) } });
    ok("past its day it's deleted: sound and row", (await rec.sweepRecordings()) >= 1 && !(await db.callRecording.findUnique({ where: { id: kept.id } })) && (await store!.get(row.storageKey)) === null);

    const source = readFileSync("src/lib/permissions.ts", "utf8");
    ok("the permission is declared", /key: "calls\.listen"/.test(source));
    ok("the heartbeat sweeps", readFileSync("src/lib/marketing/heartbeat.ts", "utf8").includes("sweepRecordings()"));
    ok("the app is told whether to send", readFileSync("src/app/api/app/me/route.ts", "utf8").includes("recordingsWanted()"));
  } finally {
    if (probe) await db.callRecording.deleteMany({ where: { callLogId: probe.id } });
    if (madeCall && probe) {
      const phone = await db.appDevice.findUnique({ where: { id: probe.appDeviceId! }, select: { deviceId: true } });
      await db.callLog.delete({ where: { id: probe.id } }).catch(() => undefined);
      await db.appDevice.delete({ where: { id: probe.appDeviceId! } }).catch(() => undefined);
      if (phone) await db.userDevice.delete({ where: { id: phone.deviceId } }).catch(() => undefined);
    }
    if (before) await db.callRecordingSettings.update({ where: { id: "default" }, data: { enabled: before.enabled, retentionDays: before.retentionDays } });
    else await db.callRecordingSettings.deleteMany({ where: { id: "default" } });
    rmSync(dir, { recursive: true, force: true });
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
