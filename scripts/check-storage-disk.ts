/**
 * check:storage-disk — the files on the server's own disk leave it once the storage box is set up (owner, 13 Nov 2026:
 * "backup and call recordings, logs — sab storage block m save ho taaki vm pr load naa pde").
 *
 * With STORAGE_DIR a temporary folder standing in for the box, and BACKUP_DIR, LOG_DIR and SUPPORT_DIR temporary
 * folders, on a scratch control plane of its own (<db>_storagedisk_control, dropped at the end, pass or fail):
 *
 *   1. Call recordings go to the box's workspaces/<id>/recordings/ with no RECORDINGS_* set; to the folder or the
 *      container RECORDINGS_* names when one is (so the recordings kept there are still found); nowhere with neither.
 *   2. Off-site falls back to the box: with nothing set in the console, the store is the box's offsite/ folder; the
 *      console's page says so.
 *   3. The access log: a finished day goes from the server as soon as it is archived (LOG_LOCAL_KEEP_DAYS), today's
 *      never; an upload that fails leaves every day; without a store, the old two weeks.
 *   4. Backups: an upload that fails leaves every copy here; once the sync has them in the box, the older copies here
 *      go at the next backup run, the newest stays, as does a safety copy inside its keep-until and one not sent yet;
 *      every piece a manifest still here names stays, the pieces only removed manifests named go; what went is fetched
 *      back from the box whole, as Download and Restore do.
 *   5. The control plane's dumps: an older one goes once the box has it, one it hasn't stays; a failed upload leaves
 *      them all.
 *   6. A store set in the console still wins over the box.
 *
 *   npm run check:storage-disk
 */
import "dotenv/config";
import { createHash, randomBytes } from "node:crypto";
import { execSync } from "node:child_process";
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

const TMP = mkdtempSync(path.join(os.tmpdir(), "deskzo-storagedisk-"));
const BOX = path.join(TMP, "box");
process.env.BACKUP_DIR = path.join(TMP, "backups");
process.env.LOG_DIR = path.join(TMP, "logs");
process.env.SUPPORT_DIR = path.join(TMP, "support");
process.env.ACCESS_LOG = "on";
process.env.DESKZO_TENANCY_FALLBACK = "legacy";
for (const name of ["STORAGE_AZURE_CONNECTION_STRING", "STORAGE_AZURE_CONTAINER", "STORAGE_AZURE_CONTAINER_URL", "STORAGE_AZURE_SAS", "STORAGE_PREFIX", "RECORDINGS_AZURE_CONTAINER_URL", "RECORDINGS_AZURE_SAS", "RECORDINGS_DIR", "BACKUP_LOCAL_KEEP", "LOG_LOCAL_KEEP_DAYS"]) delete process.env[name];
process.env.STORAGE_DIR = BOX;
mkdirSync(BOX, { recursive: true });
mkdirSync(process.env.BACKUP_DIR, { recursive: true });

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail?: unknown) => {
  if (pass) passes += 1;
  else failures += 1;
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${pass || detail === undefined ? "" : ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}`}`);
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const sha256 = (value: Buffer | string) => createHash("sha256").update(value).digest("hex");
const DAY = 86_400_000;
const dayKey = (at: Date) => at.toISOString().slice(0, 10);
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;
const load = Module.createRequire(__filename);

// Nothing here calls out.
globalThis.fetch = (async (input: RequestInfo | URL) => {
  throw new Error(`check:storage-disk makes no outside calls — ${String(input)}`);
}) as typeof fetch;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const realName = new URL(url).pathname.slice(1);
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname);

  const recordings = load("../src/lib/calls/recordings") as typeof import("../src/lib/calls/recordings");
  const resolve = load("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
  const { directClient } = load("../src/lib/tenancy/direct-client") as typeof import("../src/lib/tenancy/direct-client");

  // ─── 1. Call recordings ────────────────────────────────────────────────────────────────────────
  section("Call recordings");
  const tenantLike = { id: "zzdisk-tenant", slug: "zzdisk", isDefault: false } as unknown as Parameters<typeof resolve.runAsTenant>[0];
  const sound = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A "), randomBytes(2048)]);
  const key = "calls/2026/11/zzcall.m4a";
  {
    const store = await resolve.runAsTenant(tenantLike, () => recordings.recordingStore());
    if (store) await store.put(key, sound);
    const inBox = path.join(BOX, "workspaces", "zzdisk-tenant", "recordings", key);
    // Security audit round three, 14 Nov 2026 (R3-24): sealed there under the workspace's key, as every file in the box.
    ok("no RECORDINGS_* set: a recording goes to the box, in the workspace's own recordings folder, sealed", !!store && existsSync(inBox) && readFileSync(inBox).subarray(0, 8).toString("latin1") === "DZBKENC1" && sha256(readFileSync(inBox)) !== sha256(sound), store?.label);
    ok("  and comes back from it", !!store && sha256((await store.get(key)) ?? Buffer.alloc(0)) === sha256(sound));
  }
  {
    const dir = path.join(TMP, "recordings");
    process.env.RECORDINGS_DIR = dir;
    const store = await resolve.runAsTenant(tenantLike, () => recordings.recordingStore());
    if (store) await store.put("calls/2026/11/zzcall2.m4a", sound);
    ok("RECORDINGS_DIR set: the old folder still, not the box — what was kept there is found where it was", !!store && existsSync(path.join(dir, "ws-zzdisk-tenant", "calls/2026/11/zzcall2.m4a")) && !existsSync(path.join(BOX, "workspaces", "zzdisk-tenant", "recordings", "calls/2026/11/zzcall2.m4a")));
    delete process.env.RECORDINGS_DIR;
    process.env.RECORDINGS_AZURE_CONTAINER_URL = "https://zzaccount.blob.core.windows.net/recordings";
    process.env.RECORDINGS_AZURE_SAS = "sv=2023&sig=zz";
    const azure = await resolve.runAsTenant(tenantLike, () => recordings.recordingStore());
    ok("RECORDINGS_AZURE_* set: that container still, not the box", !!azure && /Azure/.test(azure.label) && azure.label.includes("zzaccount") && !azure.label.includes(BOX), azure?.label);
    delete process.env.RECORDINGS_AZURE_CONTAINER_URL;
    delete process.env.RECORDINGS_AZURE_SAS;
    delete process.env.STORAGE_DIR;
    const none = await resolve.runAsTenant(tenantLike, () => recordings.recordingStore());
    ok("neither, and no box: nowhere, as before", none === null);
    process.env.STORAGE_DIR = BOX;
  }

  // ─── A scratch control plane ───────────────────────────────────────────────────────────────────
  section("A scratch control plane");
  ok("the database server is a local one", local);
  if (!local) throw new Error("not a local database");
  const controlName = `${realName}_storagedisk_control`;
  const controlUrl = withDatabase(url, controlName);
  const admin = directClient(withDatabase(url, "postgres"));
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    ok("built from its migrations", true);

    const { controlDb, closeControlDb } = load("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const settings = load("../src/lib/platform/settings") as typeof import("../src/lib/platform/settings");
    const config = load("../src/lib/offsite/config") as typeof import("../src/lib/offsite/config");
    const chores = load("../src/lib/offsite/chores") as typeof import("../src/lib/offsite/chores");
    const status = load("../src/lib/offsite/status") as typeof import("../src/lib/offsite/status");
    const backups = load("../src/lib/offsite/backups") as typeof import("../src/lib/offsite/backups");
    const fetchLib = load("../src/lib/offsite/fetch") as typeof import("../src/lib/offsite/fetch");
    const control = load("../src/lib/offsite/control") as typeof import("../src/lib/offsite/control");
    const chunks = load("../src/lib/backup/chunks") as typeof import("../src/lib/backup/chunks");
    const atRest = load("../src/lib/backup/at-rest") as typeof import("../src/lib/backup/at-rest");
    const sidecar = load("../src/lib/backup/sidecar") as typeof import("../src/lib/backup/sidecar");
    const run = load("../src/lib/backup/run") as typeof import("../src/lib/backup/run");
    const accessLog = load("../src/lib/logs/access-log") as typeof import("../src/lib/logs/access-log");
    const db = controlDb();
    const boxFiles = async (prefix: string) => (await walk(path.join(BOX, prefix))).map((f) => path.relative(BOX, f));
    /** Makes the box refuse every write under offsite/<what>: a file where its folder should be. */
    const blockBox = (what: string) => {
      const target = path.join(BOX, "offsite", what);
      if (existsSync(target)) throw new Error(`${what} is already in the box — blocking it would lose it`);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, "not a folder");
    };
    const unblockBox = (what: string) => rmSync(path.join(BOX, "offsite", what), { force: true });

    // ─── 2. Off-site falls back to the box ───────────────────────────────────────────────────────
    section("Off-site falls back to the box");
    const found = await config.currentStore();
    ok("with no store set in the console, the store is the box's offsite/ folder", found?.source === "box" && found.store.label.endsWith("› offsite"), found?.store.label);
    const st = await status.offsiteStatus();
    ok("  the console's Backups & logs says the box is what's used — its label, no secret", st.box?.inUse === true && !!st.box.label?.includes("offsite") && st.label === null && !JSON.stringify(st.box).includes("sig="), st.box);
    ok("  and its alerts count it as set up", (await status.offsiteFacts()).configured);
    ok("  the hourly sync is due with it", (await chores.dueChores()).includes("sync"));

    // ─── 3. The access log ───────────────────────────────────────────────────────────────────────
    section("The access log");
    const now = new Date();
    const days = { today: dayKey(now), yesterday: dayKey(new Date(now.getTime() - DAY)), older: dayKey(new Date(now.getTime() - 3 * DAY)) };
    const logDay = (day: string) => path.join(accessLog.accessLogDir(), day);
    for (const day of Object.values(days)) {
      mkdirSync(logDay(day), { recursive: true });
      writeFileSync(path.join(logDay(day), "zzhost-1.jsonl"), `{"t":"${day}","p":"/zz"}\n`);
    }
    blockBox("logs");
    const failedLogs = await chores.runChore("logs", "check");
    ok("an archive that fails: the run says so, and every day stays here", !failedLogs.ok && Object.values(days).every((d) => existsSync(path.join(logDay(d), "zzhost-1.jsonl"))), failedLogs);
    unblockBox("logs");
    process.env.LOG_LOCAL_KEEP_DAYS = "2";
    await db.offsiteRun.deleteMany({});
    const kept2 = await chores.runChore("logs", "check");
    const archivedOlder = existsSync(path.join(BOX, "offsite", "logs", days.older, "access", "zzhost-1.jsonl.gz"));
    ok("archived to the box, sealed", kept2.ran && archivedOlder && atRest.isSealed(readFileSync(path.join(BOX, "offsite", "logs", days.older, "access", "zzhost-1.jsonl.gz"))), kept2);
    ok("  LOG_LOCAL_KEEP_DAYS=2: the day before yesterday goes from here, yesterday (sent) and today stay", !existsSync(logDay(days.older)) && existsSync(path.join(logDay(days.yesterday), "zzhost-1.jsonl.sent")) && existsSync(logDay(days.today)));
    delete process.env.LOG_LOCAL_KEEP_DAYS;
    await db.offsiteRun.deleteMany({});
    await chores.runChore("logs", "check");
    ok("unset (1): yesterday goes too, as soon as it is archived", !existsSync(logDay(days.yesterday)) && existsSync(path.join(BOX, "offsite", "logs", days.yesterday, "access", "zzhost-1.jsonl.gz")));
    ok("  today's, being written, is never touched — nor sent", readFileSync(path.join(logDay(days.today), "zzhost-1.jsonl"), "utf8").includes(days.today) && !existsSync(path.join(BOX, "offsite", "logs", days.today)));
    // Without any store: the old rule — a sent day stays two weeks.
    delete process.env.STORAGE_DIR;
    mkdirSync(logDay(days.older), { recursive: true });
    writeFileSync(path.join(logDay(days.older), "zzhost-1.jsonl"), "{}\n");
    writeFileSync(path.join(logDay(days.older), "zzhost-1.jsonl.sent"), "");
    await db.offsiteRun.deleteMany({});
    const noStore = await chores.runChore("logs", "check");
    ok("with no store and no box: a sent day three days old stays (the old two weeks)", !noStore.ok && existsSync(logDay(days.older)) && existsSync(logDay(days.today)), noStore);
    process.env.STORAGE_DIR = BOX;

    // ─── 4. Backups ──────────────────────────────────────────────────────────────────────────────
    section("Workspaces' backups");
    const A = await db.tenant.create({ data: { slug: "zzdisk-a", name: "Zz disk A", status: "ACTIVE", keyBundleCipher: "zz" }, select: { id: true, slug: true, isDefault: true } });
    const rootA = path.join(process.env.BACKUP_DIR!, "workspaces", A.id);
    mkdirSync(rootA, { recursive: true });
    const base = randomBytes(1024 * 1024);
    const ago = (days: number) => new Date(Date.now() - days * DAY).toISOString();
    const chunked = async (id: string, age: number) => {
      const file = path.join(TMP, `${id}.raw`);
      writeFileSync(file, Buffer.concat([base, randomBytes(400 * 1024)]));
      const m = await chunks.storeDump(rootA, file, A.id);
      const manifest = { ...m, takenAt: ago(age), filename: `deskzo-${id}.chunked`, schemaVersion: "zz" };
      await chunks.writeManifest(rootA, id, manifest);
      return manifest;
    };
    const full = async (name: string, age: number, keepUntil: string | null = null) => {
      const plain = randomBytes(150 * 1024);
      const file = path.join(rootA, name);
      await pipeline(async function* () {
        yield plain;
      }, atRest.sealingStream(A.id, "dump"), createWriteStream(file));
      await sidecar.writeSidecar(file, { filename: name, takenAt: ago(age), schemaVersion: "zz", secretFingerprint: null, via: "check", sizeBytes: plain.length, app: "Deskzo One", keepUntil });
      return plain;
    };
    const plainF1 = await full("deskzo-2026-11-10-020000.dump", 3);
    await full("deskzo-2026-11-10-140000.dump", 2.5, new Date(Date.now() + 30 * DAY).toISOString());
    const m1 = await chunked("zzm1", 2);
    const m2 = await chunked("zzm2", 1);
    const local = async () => ({
      manifests: (await readdir(chunks.manifestDir(rootA))).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5)).sort(),
      dumps: (await readdir(rootA)).filter((f) => f.endsWith(".dump")).sort(),
    });
    const before = await local();
    const prune = () => run.pruneOldBackups(rootA, { offsiteFor: A.id });

    await prune();
    ok("before anything is off-site, a backup run removes nothing here", JSON.stringify(await local()) === JSON.stringify(before), await local());

    blockBox("backups");
    const failedSync = await chores.runChore("sync", "check");
    await prune();
    ok("an upload to the box that fails: the sync says so, and every copy here stays", !failedSync.ok && JSON.stringify(await local()) === JSON.stringify(before), { failedSync, local: await local() });
    unblockBox("backups");

    await db.offsiteRun.deleteMany({});
    await db.offsiteWorkspace.deleteMany({});
    const synced = await chores.runChore("sync", "check");
    const offPrefix = `offsite/backups/workspaces/${A.id}`;
    const inBox = await boxFiles(offPrefix);
    ok("the sync sends them to the box with nothing set in the console", synced.ok && ["zzm1", "zzm2"].every((id) => inBox.includes(`${offPrefix}/manifests/${id}.json`)) && inBox.includes(`${offPrefix}/dumps/deskzo-2026-11-10-020000.dump`), { synced, inBox: inBox.length });
    ok("  and that alone removes nothing here — the copies go at the workspace's next backup run", JSON.stringify(await local()) === JSON.stringify(before));

    await prune();
    const after = await local();
    ok("then the older copies go: only the newest (BACKUP_LOCAL_KEEP, 1) stays", after.manifests.join() === "zzm2" && !after.dumps.includes("deskzo-2026-11-10-020000.dump"), after);
    ok("  a safety copy inside its keep-until stays, though it is off-site", after.dumps.includes("deskzo-2026-11-10-140000.dump") && existsSync(sidecar.sidecarPath(path.join(rootA, "deskzo-2026-11-10-140000.dump"))));
    ok("  a removed dump's sidecar goes with it", !existsSync(sidecar.sidecarPath(path.join(rootA, "deskzo-2026-11-10-020000.dump"))));
    ok("  every piece the kept manifest names is still here", m2.chunks.every((h) => existsSync(chunks.chunkPath(rootA, h))));
    const onlyM1 = m1.chunks.filter((h) => !m2.chunks.includes(h));
    ok("  the pieces only the removed one named are gone", onlyM1.length > 0 && onlyM1.every((h) => !existsSync(chunks.chunkPath(rootA, h))), onlyM1.length);
    const rebuiltM2 = path.join(TMP, "m2.dump");
    await chunks.reassemble(rootA, m2, rebuiltM2, A.id);
    ok("  the kept one still rebuilds here, checked", existsSync(rebuiltM2));
    const marks = await backups.keptOffsite(rootA);
    ok("the Backups list can tell the removed ones are kept off-site", !!marks && marks.manifests.has("zzm1") && marks.dumps.has("deskzo-2026-11-10-020000.dump"));

    // Fetched back, as Download and Restore do for a backup no longer here.
    const scratch = path.join(rootA, ".restore");
    mkdirSync(scratch, { recursive: true });
    const outM1 = path.join(scratch, "m1.dump");
    const fetchedM1 = await fetchLib.fetchFromOffsite(A.id, { id: "zzm1", filename: "deskzo-zzm1.chunked", kind: "INCREMENTAL" }, outM1, scratch);
    ok("a chunked backup gone from here is fetched back from the box whole — its checksum holds", !!fetchedM1 && sha256(readFileSync(outM1)) === m1.sha256);
    const outF1 = path.join(scratch, "f1.dump");
    const fetchedF1 = await fetchLib.fetchFromOffsite(A.id, { id: "zzf1", filename: "deskzo-2026-11-10-020000.dump", kind: "FULL" }, outF1, scratch);
    ok("  and a full one, opened to what it was", !!fetchedF1 && sha256(readFileSync(outF1)) === sha256(plainF1));
    ok("  nothing of the fetch is left behind but the dump asked for", (await readdir(scratch)).sort().join() === "f1.dump,m1.dump", await readdir(scratch));
    ok("  one that is nowhere: null, so the route answers as before", (await fetchLib.fetchFromOffsite(A.id, { id: "zznone", filename: "deskzo-zznone.chunked", kind: "INCREMENTAL" }, path.join(scratch, "x.dump"), scratch)) === null);
    rmSync(scratch, { recursive: true, force: true });

    // A backup not sent yet is never removed, even when it isn't the newest.
    await chunked("zzm3", 0.5);
    const m4 = await chunked("zzm4", 0.1);
    await prune();
    const later = await local();
    ok("a newer backup arrives: the one before it goes once off-site; one not sent yet stays, newest or not", later.manifests.join() === "zzm3,zzm4", later);
    ok("  the pieces of both kept ones are all here", [...m4.chunks].every((h) => existsSync(chunks.chunkPath(rootA, h))));
    process.env.BACKUP_LOCAL_KEEP = "5";
    await db.offsiteWorkspace.updateMany({ data: { lastPrunedAt: new Date() } });
    await chores.runChore("sync", "check");
    await prune();
    ok("BACKUP_LOCAL_KEEP=5: once all are off-site, nothing more goes", (await local()).manifests.join() === "zzm3,zzm4");
    delete process.env.BACKUP_LOCAL_KEEP;
    await prune();
    ok("  back to 1: the older one goes", (await local()).manifests.join() === "zzm4");

    // ─── 5. The control plane's dumps ────────────────────────────────────────────────────────────
    section("The control plane's dumps");
    const controlDir = control.controlDumpDir();
    mkdirSync(controlDir, { recursive: true });
    const stamp = (daysAgo: number) => {
      const iso = new Date(Date.now() - daysAgo * DAY).toISOString();
      return `deskzo-control-${iso.slice(0, 10)}-${iso.slice(11, 19).replace(/:/g, "")}.dump`;
    };
    const sentBefore = stamp(3);
    const neverSent = stamp(2);
    writeFileSync(path.join(controlDir, sentBefore), randomBytes(4096));
    writeFileSync(path.join(controlDir, neverSent), randomBytes(4096));
    const box = (await config.currentStore())!;
    blockBox("backups/control");
    const failedDump = await control.dumpControlPlane(box.store, box.setup).then(() => "sent", (err: unknown) => (err instanceof Error ? err.message : String(err)));
    const afterFail = (await readdir(controlDir)).filter((f) => f.startsWith("deskzo-control-"));
    ok("an upload that fails: every dump here stays (the new one too)", failedDump !== "sent" && afterFail.includes(sentBefore) && afterFail.includes(neverSent) && afterFail.length === 3, { failedDump, afterFail });
    unblockBox("backups/control");
    for (const f of afterFail) if (f !== sentBefore && f !== neverSent) rmSync(path.join(controlDir, f));
    await box.store.put(`backups/control/${sentBefore}`, readFileSync(path.join(controlDir, sentBefore)));
    const dumped = await control.dumpControlPlane(box.store, box.setup);
    const hereNow = (await readdir(controlDir)).filter((f) => f.startsWith("deskzo-control-")).sort();
    ok("the newest goes to the box and stays here", dumped.sent && existsSync(path.join(BOX, "offsite", "backups", "control", dumped.filename)) && hereNow.includes(dumped.filename));
    ok("  an older one the box has goes from here; one it hasn't stays", !hereNow.includes(sentBefore) && hereNow.includes(neverSent), hereNow);

    // ─── 6. A store set in the console wins ──────────────────────────────────────────────────────
    section("A store set in the console still wins");
    const consoleStore = path.join(TMP, "console-store");
    mkdirSync(consoleStore, { recursive: true });
    await settings.setSetting("offsite.provider", "filesystem", "check");
    await settings.setSetting("offsite.config", config.storedConfig({ provider: "filesystem", path: consoleStore, prefix: "deskzo" }), "check");
    const chosen = await config.currentStore();
    ok("the console's store is used, not the box", chosen?.source === "console" && chosen.store.label.includes(consoleStore), chosen?.store.label);
    const st2 = await status.offsiteStatus();
    ok("  the page says the box isn't used for these copies", st2.box?.inUse === false && !!st2.label);
    const boxBefore = (await walk(path.join(BOX, "offsite"))).length;
    await chunked("zzm5", 0);
    await db.offsiteRun.deleteMany({});
    const toConsole = await chores.runChore("sync", "check");
    const consoleFiles = (await walk(consoleStore)).map((f) => path.relative(consoleStore, f));
    ok("  the sync goes there, and nothing new to the box", toConsole.ok && consoleFiles.includes(`deskzo/backups/workspaces/${A.id}/manifests/zzm5.json`) && (await walk(path.join(BOX, "offsite"))).length === boxBefore, { toConsole, boxBefore });
    await prune();
    ok("  and the copies here are trimmed against what that store has", (await local()).manifests.join() === "zzm5");
    await settings.setSetting("offsite.provider", null, "check");
    await settings.setSetting("offsite.config", null, "check");

    await closeControlDb();
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${controlName}" WITH (FORCE)`).catch(() => {});
    await admin.$disconnect();
    ok("the scratch control plane is dropped", true);
  }
}

main()
  .catch((err) => {
    failures += 1;
    console.error(err);
  })
  .finally(() => {
    rmSync(TMP, { recursive: true, force: true });
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures === 0 ? 0 : 1);
  });
