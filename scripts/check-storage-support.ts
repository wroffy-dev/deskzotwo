/**
 * check:storage-support — the storage box (src/lib/storage/box.ts) for Contact Support's files, the nightly sweep and
 * the exports.
 *
 *   1. Support attachments without a box: on disk, exactly as before.
 *   2. With a box (STORAGE_DIR, a temporary folder): sending a request puts each file in the box, sealed under the
 *      workspace's key, and leaves no copy here; the row's storageKey says "box:"; the console's file route serves it
 *      back whole and in ranges (a large recording too); a box that refuses the file gives the upload back to
 *      staging; a file the box has lost is a 410.
 *   3. The off-site mirror copies only what is on disk, and not the opened copies.
 *   4. Retention deletes box-held files from the box, and leaves one alone (unmarked) when the box is gone.
 *   5. In a scratch workspace database: the nightly sweep runs for each workspace, deletes what nobody points at, and
 *      a workspace that fails doesn't stop the others; the platform tick runs it in its daily chores, guarded.
 *   6. Exports carry the files themselves, never references; data reset reads no file.
 *
 * The control plane is a stand-in in memory (no request leaves for it); the workspace database is a scratch one
 * built from the migrations, dropped after. Every folder is a temporary one, removed after.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { directClient } from "../src/lib/tenancy/direct-client";

const TMP = mkdtempSync(path.join(os.tmpdir(), "zz-check-storage-support-"));
const SUPPORT_DIR = path.join(TMP, "support");
const BOX_DIR = path.join(TMP, "box");
const MIRROR_DIR = path.join(TMP, "mirror");
process.env.SUPPORT_DIR = SUPPORT_DIR;
process.env.BACKUP_DIR = path.join(TMP, "backups");
process.env.DESKZO_TENANCY_FALLBACK = "legacy";
process.env.CONTROL_DATABASE_URL = "";
const STORAGE_VARS = ["STORAGE_AZURE_CONNECTION_STRING", "STORAGE_AZURE_CONTAINER", "STORAGE_AZURE_CONTAINER_URL", "STORAGE_AZURE_SAS", "STORAGE_DIR", "STORAGE_PREFIX"];
const noBox = () => {
  // Emptied, not deleted: a Prisma client loaded later reads .env again and would put a deleted value back.
  for (const k of STORAGE_VARS) process.env[k] = "";
};
const boxAt = (dir: string) => {
  noBox();
  process.env.STORAGE_DIR = dir;
};
noBox();

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
async function part(title: string, work: () => Promise<void>) {
  console.log(`\n— ${title} —\n`);
  try {
    await work();
  } catch (err) {
    ok("the section ran to its end", false, err instanceof Error ? `${err.message}\n${err.stack?.split("\n").slice(1, 6).join("\n")}` : String(err));
  }
}
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  u.search = "";
  return u.toString();
}
function walk(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name)]));
}
async function refusedWith(work: () => Promise<unknown>): Promise<{ status: number; message: string }> {
  try {
    await work();
    return { status: 0, message: "" };
  } catch (err) {
    return { status: (err as { status?: number }).status ?? 0, message: err instanceof Error ? err.message : String(err) };
  }
}
const DAY = 86_400_000;

// ─── The control plane, in memory ────────────────────────────────────────────────────────────────

type AttachmentRow = { id: string; requestId: string; kind: string; filename: string; mime: string; size: number; sha256: string; storageKey: string; durationMs: number | null; purgedAt: Date | null; createdAt: Date };
type RequestRow = { id: string; number: number; tenantId: string; closedAt: Date | null };
const requests = new Map<string, RequestRow>();
const attachments = new Map<string, AttachmentRow>();
let controlOn = false;
const fakeControl = {
  platformSetting: { findMany: async () => [] },
  supportRequest: {
    async create({ data }: { data: { id: string; tenantId: string; attachments: { create: Omit<AttachmentRow, "requestId" | "purgedAt" | "createdAt">[] } } }) {
      const number = requests.size + 1;
      requests.set(data.id, { id: data.id, number, tenantId: data.tenantId, closedAt: null });
      for (const a of data.attachments.create) attachments.set(a.id, { ...a, durationMs: a.durationMs ?? null, requestId: data.id, purgedAt: null, createdAt: new Date() });
      return { id: data.id, number };
    },
    async delete({ where }: { where: { id: string } }) {
      requests.delete(where.id);
      for (const [id, a] of attachments) if (a.requestId === where.id) attachments.delete(id);
    },
  },
  supportAttachment: {
    async update({ where, data }: { where: { id: string }; data: Partial<AttachmentRow> }) {
      const a = attachments.get(where.id);
      if (!a) throw new Error("no such attachment");
      Object.assign(a, data);
      return a;
    },
    async findMany({ where, take }: { where: { purgedAt: null; request: { closedAt: { lt: Date } }; id?: { notIn: string[] } }; take: number }) {
      return [...attachments.values()]
        .filter((a) => a.purgedAt === null && !(where.id?.notIn ?? []).includes(a.id))
        .filter((a) => {
          const r = requests.get(a.requestId);
          return !!r?.closedAt && r.closedAt < where.request.closedAt.lt;
        })
        .slice(0, take)
        .map((a) => ({ id: a.id, storageKey: a.storageKey }));
    },
    async updateMany({ where, data }: { where: { id: { in: string[] }; purgedAt: null }; data: { purgedAt: Date } }) {
      let count = 0;
      for (const id of where.id.in) {
        const a = attachments.get(id);
        if (a && a.purgedAt === null) {
          a.purgedAt = data.purgedAt;
          count += 1;
        }
      }
      return { count };
    },
  },
};

const STAFF = { id: "zzstaff0000001", email: "owner@zz-storage.in", name: "Zz Owner", role: "OWNER" };
let audits = 0;
const nextCache = { revalidatePath() {}, revalidateTag() {}, unstable_cache: <T,>(fn: T) => fn };
const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return nextCache;
  if (request === "@/lib/platform/control-db") {
    const real = realLoad.call(this, request, parent, isMain) as object;
    return { ...real, controlConfigured: () => controlOn, controlDb: () => fakeControl, closeControlDb: async () => {} };
  }
  if (request === "@/lib/platform/staff-session") {
    const real = realLoad.call(this, request, parent, isMain) as object;
    return { ...real, currentStaffSession: async () => ({ staff: STAFF, sessionId: "zz", mfaDone: true, enrolled: true, twoFactorRequired: false }) };
  }
  if (request === "@/lib/support/console") {
    const real = realLoad.call(this, request, parent, isMain) as object;
    return {
      ...real,
      async supportAttachmentForStaff(id: string) {
        const a = attachments.get(id);
        const r = a ? requests.get(a.requestId) : null;
        return a && r ? { id: a.id, requestId: a.requestId, number: r.number, tenantId: r.tenantId, kind: a.kind, filename: a.filename, mime: a.mime, size: a.size, storageKey: a.storageKey, purgedAt: a.purgedAt } : null;
      },
      async auditAttachmentOpen() {
        audits += 1;
      },
    };
  }
  return realLoad.call(this, request, parent, isMain);
};

// ─── Fixtures ────────────────────────────────────────────────────────────────────────────────────

const TENANT = "zzstoragews0001";
const USER = "zzstorageuser01";
const PDF = Buffer.concat([Buffer.from("%PDF-1.4\n% zz storage support\n"), Buffer.alloc(3000, 0x41), Buffer.from("\n%%EOF\n")]);
/** A WebM's magic, then 6 MB that never repeats — a recording too big to want in memory twice. */
const WEBM = Buffer.concat([Buffer.from([0x1a, 0x45, 0xdf, 0xa3]), Buffer.from(Array.from({ length: 6 * 1024 * 1024 }, (_, i) => (i * 7919 + (i >> 11)) & 0xff))]);
const from = (b: Buffer) => Readable.from([b.subarray(0, 1000), b.subarray(1000)]);

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const storage = require("../src/lib/support/storage") as typeof import("../src/lib/support/storage");
  const requestsLib = require("../src/lib/support/requests") as typeof import("../src/lib/support/requests");
  const retention = require("../src/lib/support/retention") as typeof import("../src/lib/support/retention");
  const mirror = require("../src/lib/offsite/support") as typeof import("../src/lib/offsite/support");
  const store = require("../src/lib/offsite/store") as typeof import("../src/lib/offsite/store");
  const route = require("../src/app/platform-console/support-files/[id]/route") as typeof import("../src/app/platform-console/support-files/[id]/route");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const stage = (bytes: Buffer, filename: string, kind: "file" | "recording" = "file") => storage.stageUpload(from(bytes), { tenantId: TENANT, userId: USER, kind, filename });
  const supportFilesHere = () => walk(SUPPORT_DIR).filter((f) => !f.includes(`${path.sep}.box-cache${path.sep}`) && !f.includes(`${path.sep}staging${path.sep}`));
  const boxFiles = () => walk(BOX_DIR);
  /** A request sent the real way (src/lib/support/requests.ts), with these staged uploads. */
  async function send(uploads: { uploadId: string; kind: "FILE" | "RECORDING"; meta: import("../src/lib/support/storage").StagedMeta }[]) {
    return requestsLib.createSupportRequest({
      tenantId: TENANT,
      requester: { userId: USER, name: "Zz Person", email: "zz.person@zz-storage.in", role: "ADMIN" },
      mobile: null,
      subject: "zz storage",
      body: "zz storage support check",
      priority: "NORMAL",
      context: {},
      consoleLog: null,
      recordingConsentAt: null,
      ip: null,
      attachments: uploads.map((u) => ({ uploadId: u.uploadId, kind: u.kind, meta: u.meta, durationMs: null })),
    });
  }
  const rowsOf = (requestId: string) => [...attachments.values()].filter((a) => a.requestId === requestId);
  async function get(attachmentId: string, range?: string) {
    controlOn = true;
    try {
      const res = await route.GET(new Request(`https://admin.localhost/support-files/${attachmentId}`, { headers: range ? { range } : {} }), { params: Promise.resolve({ id: attachmentId }) } as never);
      return { status: res.status, headers: res.headers, body: res.body ? Buffer.from(await res.arrayBuffer()) : Buffer.alloc(0) };
    } finally {
      controlOn = false;
    }
  }
  async function head(attachmentId: string) {
    controlOn = true;
    try {
      const res = await route.HEAD(new Request(`https://admin.localhost/support-files/${attachmentId}`, { method: "HEAD" }), { params: Promise.resolve({ id: attachmentId }) } as never);
      return { status: res.status, length: res.headers.get("content-length") };
    } finally {
      controlOn = false;
    }
  }

  let diskRequest = "";
  let diskAttachment = "";
  await part("1. Without a box: on this disk, as before", async () => {
    noBox();
    const staged = await stage(PDF, "notes.pdf");
    ok("a new attachment's key names no box", (await storage.attachmentStorageKey(TENANT, "zzrequest00001", "zzattach000001")) === `${TENANT}/zzrequest00001/zzattach000001`);
    const sent = await send([{ uploadId: staged.uploadId, kind: "FILE", meta: staged }]);
    const [row] = rowsOf(sent.id);
    diskRequest = sent.id;
    diskAttachment = row!.id;
    ok("the row's storageKey is <workspace>/<request>/<attachment>", row?.storageKey === `${TENANT}/${sent.id}/${row?.id}` && !storage.inStorageBox(row!.storageKey), row?.storageKey);
    ok("  and the file is under SUPPORT_DIR, whole", readFileSync(path.join(SUPPORT_DIR, TENANT, sent.id, row!.id)).equals(PDF));
    ok("  and nothing went to a box", boxFiles().length === 0);
    const whole = await get(row!.id);
    ok("the console's file route serves it back whole", whole.status === 200 && whole.body.equals(PDF), whole.status);
    const some = await get(row!.id, "bytes=0-4");
    ok("  and a range of it", some.status === 206 && some.body.toString() === "%PDF-" && some.headers.get("content-range") === `bytes 0-4/${PDF.length}`);
  });

  let boxRequest = "";
  let boxPdf = "";
  let boxWebm = "";
  await part("2. With a box: sealed in the box, nothing left here", async () => {
    boxAt(BOX_DIR);
    const pdf = await stage(PDF, "report.pdf");
    const webm = await stage(WEBM, "screen.webm", "recording");
    ok("staging stays on this disk (short-lived)", existsSync(path.join(SUPPORT_DIR, TENANT, "staging", pdf.uploadId)) && boxFiles().length === 0);
    const sent = await send([
      { uploadId: pdf.uploadId, kind: "FILE", meta: pdf },
      { uploadId: webm.uploadId, kind: "RECORDING", meta: webm },
    ]);
    boxRequest = sent.id;
    const rows = rowsOf(sent.id);
    const pdfRow = rows.find((r) => r.mime === "application/pdf")!;
    const webmRow = rows.find((r) => r.mime === "video/webm")!;
    boxPdf = pdfRow.id;
    boxWebm = webmRow.id;
    ok("each row's storageKey marks it as in the box", rows.length === 2 && rows.every((r) => r.storageKey === `box:${TENANT}/${sent.id}/${r.id}` && storage.inStorageBox(r.storageKey)), rows.map((r) => r.storageKey));
    const inBox = boxFiles();
    const expected = rows.map((r) => path.join(BOX_DIR, "support", TENANT, sent.id, r.id));
    ok("the files are in the box's support folder", expected.every((f) => inBox.includes(f)) && inBox.length === 2, inBox.map((f) => path.relative(BOX_DIR, f)));
    const sealed = readFileSync(expected.find((f) => f.endsWith(pdfRow.id))!);
    ok("  sealed — the box holds ciphertext, not the file", sealed.subarray(0, 8).toString("latin1") === "DZBKENC1" && !sealed.includes(PDF.subarray(0, 40)) && sealed.length === PDF.length + 37, sealed.length);
    ok("  and no copy is left on this disk — not under the request, not in staging", supportFilesHere().every((f) => f.includes(diskRequest)) && walk(path.join(SUPPORT_DIR, TENANT, "staging")).length === 0, supportFilesHere());
    ok("  nor the request's folder", !existsSync(path.join(SUPPORT_DIR, TENANT, sent.id)));

    const sizeFirst = await storage.attachmentSize(pdfRow.storageKey);
    ok("its size is read from the box without fetching it", sizeFirst === PDF.length && !existsSync(path.join(SUPPORT_DIR, ".box-cache")), sizeFirst);
    const head1 = await head(pdfRow.id);
    ok("  HEAD answers with it, and no audit row", head1.status === 200 && head1.length === String(PDF.length) && audits === 2, head1);
    const before = audits;
    const whole = await get(pdfRow.id);
    ok("the console's file route serves it back whole", whole.status === 200 && whole.body.equals(PDF) && whole.headers.get("content-type") === "application/pdf", whole.status);
    ok("  audited, with the file's headers", audits === before + 1 && whole.headers.get("x-content-type-options") === "nosniff" && whole.headers.get("content-length") === String(PDF.length));
    const range = await get(pdfRow.id, "bytes=5-9");
    ok("  and a range of it", range.status === 206 && range.body.equals(PDF.subarray(5, 10)) && range.headers.get("content-range") === `bytes 5-9/${PDF.length}`);
    const past = await get(pdfRow.id, `bytes=${PDF.length + 10}-`);
    ok("  a range past its end is 416", past.status === 416, past.status);

    const rec = await get(webmRow.id);
    ok("a 6 MB recording is served back whole", rec.status === 200 && rec.body.equals(WEBM), `${rec.status} ${rec.body.length}`);
    const seeks = await Promise.all([
      get(webmRow.id, "bytes=4000000-4000999"),
      get(webmRow.id, "bytes=0-3"),
      get(webmRow.id, `bytes=-500`),
    ]);
    ok("  and a player's seeks, at once, each get their bytes", seeks[0]!.status === 206 && seeks[0]!.body.equals(WEBM.subarray(4_000_000, 4_001_000)) && seeks[1]!.body.equals(WEBM.subarray(0, 4)) && seeks[2]!.body.equals(WEBM.subarray(WEBM.length - 500)));
    const cache = walk(path.join(SUPPORT_DIR, ".box-cache"));
    ok("  from one opened copy each, kept a while for the next range", cache.length === 2 && cache.every((f) => !path.basename(f).includes(".")), cache.map((f) => path.basename(f)));
    ok("  which the staging sweep leaves alone", (await storage.sweepStaging(0)) === 0 && walk(path.join(SUPPORT_DIR, ".box-cache")).length === 2);
    const pruned = await storage.pruneBoxCache(Date.now() + 20 * 60_000);
    ok("  and which go after a quarter of an hour unasked", pruned === 2 && walk(path.join(SUPPORT_DIR, ".box-cache")).length === 0, pruned);
    const again = await get(pdfRow.id, "bytes=0-4");
    ok("  then fetched from the box again", again.status === 206 && again.body.toString() === "%PDF-");

    const failing = await stage(PDF, "again.pdf");
    const notAFolder = path.join(TMP, "not-a-folder");
    writeFileSync(notAFolder, "x");
    boxAt(notAFolder);
    const requestsBefore = requests.size;
    const refused = await refusedWith(() => send([{ uploadId: failing.uploadId, kind: "FILE", meta: failing }]));
    ok("a box that can't take the file refuses the send, saying to try again", refused.status === 503 && /try again/i.test(refused.message), refused);
    ok("  the upload is back in staging, so Send works again", (await storage.readStaged(TENANT, failing.uploadId)) !== null);
    const folders = readdirSync(path.join(SUPPORT_DIR, TENANT)).filter((d) => d !== "staging");
    ok("  and nothing is left of the request: no row, no folder", requests.size === requestsBefore && folders.length === 1 && folders[0] === diskRequest, { requests: requests.size, folders });
    boxAt(BOX_DIR);
    const retried = await send([{ uploadId: failing.uploadId, kind: "FILE", meta: failing }]);
    const retriedRow = rowsOf(retried.id)[0]!;
    ok("  sent again with the box back, it is in the box", storage.inStorageBox(retriedRow.storageKey) && (await get(retriedRow.id)).body.equals(PDF));

    rmSync(path.join(BOX_DIR, "support", TENANT, retried.id), { recursive: true, force: true });
    await storage.pruneBoxCache(Date.now() + 20 * 60_000);
    const lost = await get(retriedRow.id);
    ok("a file the box has lost is 410, not a 500", lost.status === 410, lost.status);
    ok("  and its size is unknown", (await storage.attachmentSize(retriedRow.storageKey)) === null);

    noBox();
    const noBoxNow = await get(boxPdf);
    ok("a box-held file on a server whose box was taken away is 410", noBoxNow.status === 410, noBoxNow.status);
    const old = await get(diskAttachment);
    ok("an attachment sent before the box is still served from disk", old.status === 200 && old.body.equals(PDF));
    boxAt(BOX_DIR);
    const oldWithBox = await get(diskAttachment, "bytes=0-4");
    ok("  with the box set up too", oldWithBox.status === 206 && oldWithBox.body.toString() === "%PDF-");
  });

  await part("3. The off-site mirror skips box-held files", async () => {
    boxAt(BOX_DIR);
    await get(boxPdf); // an opened copy in the cache, which must not be mirrored either
    const target = store.openStore({ provider: "filesystem", path: MIRROR_DIR, prefix: "" }, null);
    const synced = await mirror.syncSupportFiles(target);
    const copied = walk(MIRROR_DIR).map((f) => path.relative(MIRROR_DIR, f));
    ok("only the file on disk is copied off-site", synced.sent === 1 && copied.length === 1 && copied[0] === path.join("support", TENANT, diskRequest, diskAttachment), { synced, copied });
    ok("  not the box-held ones, nor the opened copies", !copied.some((c) => c.includes(boxRequest) || c.includes(".box-cache")));
  });

  await part("4. Retention deletes box-held files from the box", async () => {
    boxAt(BOX_DIR);
    const recent = await stage(PDF, "recent.pdf");
    const kept = await send([{ uploadId: recent.uploadId, kind: "FILE", meta: recent }]);
    const now = new Date();
    requests.get(diskRequest)!.closedAt = new Date(now.getTime() - 400 * DAY);
    requests.get(boxRequest)!.closedAt = new Date(now.getTime() - 400 * DAY);
    requests.get(kept.id)!.closedAt = new Date(now.getTime() - 10 * DAY);
    await get(boxPdf); // an opened copy, which goes with the file
    const result = await retention.runSupportRetention(now);
    ok("the old requests' files are purged — on disk and in the box", result.purged === 3 && result.stuck === 0, result);
    ok("  gone from the box", !existsSync(path.join(BOX_DIR, "support", TENANT, boxRequest)) || walk(path.join(BOX_DIR, "support", TENANT, boxRequest)).length === 0, walk(path.join(BOX_DIR, "support", TENANT, boxRequest)));
    ok("  and from disk", !existsSync(path.join(SUPPORT_DIR, TENANT, diskRequest, diskAttachment)));
    ok("  and its opened copy", walk(path.join(SUPPORT_DIR, ".box-cache")).length === 0, walk(path.join(SUPPORT_DIR, ".box-cache")));
    ok("  each row marked, and kept", rowsOf(boxRequest).every((a) => a.purgedAt) && attachments.has(boxPdf) && attachments.has(boxWebm));
    const purgedAnswer = await get(boxPdf);
    ok("  the file route says it was removed by retention (410)", purgedAnswer.status === 410);
    ok("a request closed ten days ago keeps its file in the box", rowsOf(kept.id).every((a) => !a.purgedAt) && walk(path.join(BOX_DIR, "support", TENANT, kept.id)).length === 1);
    noBox();
    requests.get(kept.id)!.closedAt = new Date(now.getTime() - 400 * DAY);
    const stuck = await retention.runSupportRetention(now);
    ok("with the box taken away, a box-held file isn't marked purged — it can't be deleted from here", stuck.purged === 0 && stuck.stuck === 1 && rowsOf(kept.id).every((a) => !a.purgedAt), stuck);
    boxAt(BOX_DIR);
    ok("  and the next tick with the box back purges it", (await retention.runSupportRetention(now)).purged === 1 && walk(path.join(BOX_DIR, "support", TENANT, kept.id)).length === 0);
  });

  // ─── A scratch workspace ───────────────────────────────────────────────────────────────────────
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host)) throw new Error("not a local database");
  const scratch = `${new URL(url).pathname.slice(1)}_storagesupport`;
  const scratchUrl = withDatabase(url, scratch);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    process.env.DATABASE_URL = scratchUrl;
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const files = require("../src/lib/storage/files") as typeof import("../src/lib/storage/files");
    const sweep = require("../src/lib/platform/storage-sweep") as typeof import("../src/lib/platform/storage-sweep");
    const { currentTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const portability = require("../src/lib/portability/export") as typeof import("../src/lib/portability/export");
    const { EXPORTERS } = require("../src/lib/portability/exporters") as typeof import("../src/lib/portability/exporters");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
    const pngUrl = files.toDataUrl(png, "image/png");
    const user = await db.user.create({ data: { name: "Zz Storage", email: "zz.storage@zz-storage.in", passwordHash: "!", role: "ADMIN", isSuperAdmin: true }, select: { id: true } });

    await part("5. The nightly sweep", async () => {
      const tenant = await currentTenant();
      noBox();
      ok("without a box it does nothing at all", (await sweep.sweepStorageBox(new Date(), [tenant])) === null);
      boxAt(BOX_DIR);
      const kept = await files.keepDataUrl("user-photos", pngUrl);
      await db.userPhoto.create({ data: { userId: user.id, dataUrl: kept, mimeType: "image/png", byteSize: png.length } });
      const orphan = await files.keepDataUrl("user-photos", files.toDataUrl(Buffer.from("nobody points here"), "text/plain"));
      const fileOf = (ref: string) => walk(path.join(BOX_DIR, "workspaces")).find((f) => f.endsWith(files.storedRef(ref)!.key.split("/").pop()!));
      const long = new Date(Date.now() - 400 * DAY);
      for (const r of [kept, orphan]) utimesSync(fileOf(r)!, long, long);
      const broken = { ...tenant, id: "zz-broken-ws", slug: "zz-broken", isDefault: false, dbUrl: withDatabase(url, `${scratch}_missing`) };
      const result = await sweep.sweepStorageBox(new Date(), [broken, tenant]);
      ok("it runs for each workspace, and deletes an old file nobody points at", !!result && result.workspaces === 1 && result.removed >= 1 && !fileOf(orphan), result);
      ok("  never one a row points at", !!fileOf(kept));
      ok("  a workspace that fails is named, and the others are swept all the same", !!result && result.failed.length === 1 && result.failed[0]!.startsWith("zz-broken:"), result?.failed);
      process.env.STORAGE_AZURE_CONNECTION_STRING = "AccountName=zz;AccountKey=a2V5;BlobEndpoint=http://files.example.com/zz";
      const wrong = await sweep.sweepStorageBox(new Date(), [tenant]);
      ok("a box set up wrongly is reported, not thrown", !!wrong && wrong.failed.length === 1 && /set up wrongly/.test(wrong.failed[0]!), wrong);
      boxAt(BOX_DIR);
      const tick = readFileSync(path.join(__dirname, "..", "src", "app", "api", "platform", "tick", "route.ts"), "utf8");
      const daily = tick.slice(tick.indexOf('if ((await getSetting("billing.dailyRanOn")) !== today)'), tick.indexOf('await setSetting("billing.dailyRanOn"'));
      ok("the platform tick runs it once a day, in its daily chores", /storage = await sweepStorageBox\(now\)/.test(daily));
      ok("  inside its own try, its failures in the day's `failed` — never stopping the other chores", /try \{\s*storage = await sweepStorageBox\(now\);\s*failed\.push\(\.\.\.\(storage\?\.failed/.test(daily) && /catch \(err\) \{\s*failed\.push\(`storage-sweep:/.test(daily));
    });

    await part("6. Exports carry the files, never references", async () => {
      boxAt(BOX_DIR);
      const receipt = await files.keepDataUrl("expense-receipts", pngUrl);
      ok("(a receipt in the box, its row holding a reference)", files.isStoredRef(receipt));
      await db.expense.create({ data: { userId: user.id, amount: 120, spentOn: new Date(), description: "zz taxi", receiptDataUrl: receipt, receiptName: "taxi.png" } });
      const expenses = await portability.areaRows(user.id, "expenses");
      ok("the expenses export has the expense", expenses.length === 1, expenses.length);
      ok("  and no box reference anywhere in it", !JSON.stringify(expenses).includes(files.TEXT_REF));
      const bytesRef = await files.keepBytes("task-attachments", png, "image/png");
      const missing = `${files.TEXT_REF}user-photos/2026-11/${"0".repeat(24)}|image/png`;
      const exporters = EXPORTERS as Record<string, (typeof EXPORTERS)[string]>;
      exporters["zz-files"] = async () => [{ Name: "zz", File: receipt, Bytes: bytesRef, Gone: missing, Plain: "dzblob is just a word" }];
      try {
        const [row] = await portability.areaRows(user.id, "zz-files");
        ok("a file column in an export comes out as the file itself (data URL)", row?.File === pngUrl);
        ok("  a Bytes one as its bytes", Buffer.isBuffer(row?.Bytes) && (row!.Bytes as Buffer).equals(png));
        ok("  a file the box has lost as empty, not an error", row?.Gone === "");
        ok("  anything else untouched", row?.Name === "zz" && row?.Plain === "dzblob is just a word");
        const book = await portability.toWorkbookBuffer([{ name: "Files", rows: [row!] }], { title: "zz", by: "zz", generatedAt: new Date() });
        ok("  and it writes to a workbook", book.length > 1000 && !book.includes(Buffer.from(files.TEXT_REF)));
      } finally {
        delete exporters["zz-files"];
      }
      noBox();
      const plain = await portability.areaRows(user.id, "expenses");
      ok("without a box the export is as it was", plain.length === 1 && !JSON.stringify(plain).includes(files.TEXT_REF));

      // Import: no importer writes a file column (check:portability fails a portability file that touches one
      // without src/lib/storage/files.ts), so there is nothing to put back in the box on the way in.
      const importers = readdirSync(path.join(__dirname, "..", "src", "lib", "portability", "importers")).map((f) => readFileSync(path.join(__dirname, "..", "src", "lib", "portability", "importers", f), "utf8"));
      ok("no importer writes a file column", importers.every((t) => !/receiptDataUrl|fileDataUrl|photoDataUrl|imageDataUrl|\.userPhoto\.|Attachment\.|\.marketingAsset\./.test(t)));
      // Data reset empties tables with TRUNCATE and DELETE; the sweep removes the files later.
      const reset = ["data-reset.ts", "reset-classes.ts", "workspace-reset.ts"].map((f) => readFileSync(path.join(__dirname, "..", "src", "lib", f), "utf8")).join("\n");
      ok("data reset reads no file's bytes", !/storage\/files|receiptDataUrl|fileDataUrl|photoDataUrl|imageDataUrl|dataUrl:|bytesOf|dataUrlOf/.test(reset));
    });
  } finally {
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    await admin.$disconnect().catch(() => {});
  }
}

main()
  .catch((err) => {
    ok("the check ran to its end", false, err instanceof Error ? `${err.message}\n${err.stack}` : String(err));
  })
  .finally(() => {
    rmSync(TMP, { recursive: true, force: true });
    console.log(`\n${failures ? `${passes} passed, ${failures} FAILED` : `All ${passes} storage support checks passed.`}`);
    process.exit(failures ? 1 : 0);
  });
