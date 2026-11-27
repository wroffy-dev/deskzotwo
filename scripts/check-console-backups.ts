/**
 * check:console-backups — the console's Backups page (Backup & Restore, part B; owner, 26 Nov 2026): src/lib/bundle/
 * jobs.ts, upload.ts and console-data.ts, src/actions/platform/console-backups.ts, the routes under
 * src/app/platform-console/backup-files and backup-uploads, scripts/bundle-worker.ts, and the page.
 *
 * Through the console's own actions, routes and page, as signed-in staff, on a scratch control plane and a scratch
 * workspace database built from their migrations, a folder as the storage box and another as BACKUP_DIR — all
 * removed after:
 *
 *   1. Roles: owners and admins see the page; only owners create, download, upload, verify or delete.
 *   2. A workspace backup made by the real worker, spawned as a child the way the page spawns it: READY with the
 *      file's size and sha256, progress recorded, the passphrase's file gone, and the passphrase nowhere — not on the
 *      row, in the audit log, in any output, on the worker's command line or in its environment.
 *   3. A full backup (the worker in this process), one build at a time, and a dead worker settled.
 *   4. Not enough disk: refused with the numbers (a fake statfs).
 *   5. The download route: the exact bytes, Content-Length, the file name; refused for a non-owner, without a recent
 *      step-up, from another site, and for an expired file.
 *   6. A chunked upload: parts out of order and repeated, a dropped part resumed, byte-identical at the end; a file
 *      that isn't a bundle refused at init; too big refused; the uploaded row's header is the file's.
 *   7. Verify: a good bundle sound; a tampered one says what is wrong; the compatibility report — same key, a
 *      different PLATFORM_MASTER_KEY in words, a newer schema.
 *   8. Expiry and settling.
 *   9. The page: the list, progress, the restores with their logs; no passphrase or key material in the HTML; the
 *      workspace page's link.
 */
import "dotenv/config";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execSync, spawn } from "node:child_process";
import { createWriteStream } from "node:fs";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";
import { renderHtml } from "./lib/render-html";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.TRUST_PROXY = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";
for (const k of ["STORAGE_AZURE_CONNECTION_STRING", "STORAGE_AZURE_CONTAINER_URL", "STORAGE_AZURE_CONTAINER", "STORAGE_AZURE_SAS", "STORAGE_PREFIX", "RECORDINGS_AZURE_CONTAINER_URL", "RECORDINGS_DIR"]) process.env[k] = "";

const PASS = "zz-Backup-passphrase-" + randomBytes(6).toString("hex");
const WRONG = "a different passphrase entirely";

// Everything this process writes, to look through for the passphrase at the end.
let written = "";
for (const stream of [process.stdout, process.stderr]) {
  const real = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
  (stream as unknown as { write: (chunk: unknown, ...rest: unknown[]) => boolean }).write = (chunk: unknown, ...rest: unknown[]) => {
    written += typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8");
    return real(chunk, ...rest);
  };
}

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
const MB = 1024 * 1024;
const HOUR = 3_600_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ─── A request, as the console sees one ──────────────────────────────────────────────────────────
const HOST = "admin.localhost:3000";
const COOKIE = "deskzo-console";
const jar = new Map<string, string>();
const requestHeaders = new Headers({ host: HOST, "user-agent": "check:console-backups" });
const internals = Module as unknown as { _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: { filename?: string } | undefined, isMain: boolean) {
  if (request === "next/headers" || request.endsWith(`${path.sep}next${path.sep}headers.js`)) {
    return {
      headers: async () => requestHeaders,
      cookies: async () => ({
        get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
        set: (name: string, value: string) => void jar.set(name, value),
        delete: (name: string) => void jar.delete(name),
      }),
    };
  }
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") {
    return {
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      notFound: () => {
        throw new Error("notFound");
      },
      useRouter: () => ({ push() {}, replace() {}, refresh() {}, back() {}, prefetch() {} }),
      usePathname: () => "/backups",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  if (request === "@/lib/auth") return { auth: async () => null, signIn: async () => {}, signOut: async () => {} };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

type Page = (props: never) => Promise<unknown>;
async function render(page: Page, params: Record<string, string> = {}, searchParams: Record<string, string> = {}): Promise<string> {
  return renderHtml(await page({ params: Promise.resolve(params), searchParams: Promise.resolve(searchParams) } as never));
}
const textOf = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ");

/** A request from the console's own page (or, with `from`, from somewhere else). */
function consoleRequest(pathname: string, init: { method?: string; body?: Buffer | null; headers?: Record<string, string>; from?: "same" | "cross" | "none" } = {}): Request {
  const headers: Record<string, string> = { host: HOST, ...init.headers };
  if (init.from === "cross") {
    headers.origin = "https://evil.example";
    headers["sec-fetch-site"] = "cross-site";
  } else if (init.from !== "none") {
    headers["sec-fetch-site"] = "same-origin";
    if (init.method && init.method !== "GET" && init.method !== "HEAD") headers.origin = `http://${HOST}`;
  }
  return new Request(`http://${HOST}${pathname}`, { method: init.method ?? "GET", headers, body: init.body ? new Uint8Array(init.body) : undefined, duplex: "half" } as RequestInit);
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname)) throw new Error("not a local database");
  const realName = new URL(url).pathname.slice(1);
  const realKey = process.env.PLATFORM_MASTER_KEY;

  const controlName = `${realName}_consolebackups_control`;
  const workspaceName = `${realName}_consolebackups_ws`;
  const controlUrl = withDatabase(url, controlName);
  const workspaceUrl = withDatabase(url, workspaceName);
  const admin = directClient(withDatabase(url, "postgres"));
  const scratch = await mkdtemp(path.join(os.tmpdir(), "deskzo-console-backups-"));
  let cleanup: (() => Promise<void>) | null = null;
  const childOutput: string[] = [];
  const spawned: { args: string[]; env: NodeJS.ProcessEnv; handoff: { mode: number; holdsPassphrase: boolean } | null }[] = [];
  try {
    for (const name of [controlName, workspaceName]) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    }
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: workspaceUrl }, timeout: 15 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    process.env.DATABASE_URL = workspaceUrl;
    process.env.REFERENCE_DATABASE_URL = "";
    process.env.STORAGE_DIR = path.join(scratch, "box");
    process.env.SUPPORT_DIR = path.join(scratch, "support");
    process.env.BACKUP_DIR = path.join(scratch, "backups");
    ok("a scratch control plane and workspace, from their migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const kek = require("../src/lib/platform/kek") as typeof import("../src/lib/platform/kek");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const staffLib = require("../src/lib/platform/staff") as typeof import("../src/lib/platform/staff");
    const totp = require("../src/lib/totp") as typeof import("../src/lib/totp");
    const { authenticator } = require("otplib") as typeof import("otplib");
    const nav = require("../src/lib/console-shared/nav") as typeof import("../src/lib/console-shared/nav");
    const shared = require("../src/lib/console-shared/backups") as typeof import("../src/lib/console-shared/backups");
    const build = require("../src/lib/bundle/build") as typeof import("../src/lib/bundle/build");
    const format = require("../src/lib/bundle/format") as typeof import("../src/lib/bundle/format");
    const jobs = require("../src/lib/bundle/jobs") as typeof import("../src/lib/bundle/jobs");
    const upload = require("../src/lib/bundle/upload") as typeof import("../src/lib/bundle/upload");
    const data = require("../src/lib/bundle/console-data") as typeof import("../src/lib/bundle/console-data");
    const actions = require("../src/actions/platform/console-backups") as typeof import("../src/actions/platform/console-backups");
    const download = require("../src/app/platform-console/backup-files/[id]/route") as typeof import("../src/app/platform-console/backup-files/[id]/route");
    const uploadInit = require("../src/app/platform-console/backup-uploads/route") as typeof import("../src/app/platform-console/backup-uploads/route");
    const uploadOne = require("../src/app/platform-console/backup-uploads/[id]/route") as typeof import("../src/app/platform-console/backup-uploads/[id]/route");
    const { storageBox } = require("../src/lib/storage/box") as typeof import("../src/lib/storage/box");
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    const pageAt = (file: string) => (require(`../src/app/platform-console/(console)/${file}`) as { default: Page }).default;
    /* eslint-enable @typescript-eslint/no-require-imports */
    cleanup = async () => {
      jobs.setWorkerSpawnerForChecks(null);
      jobs.setFreeSpaceProbeForChecks(null);
      await db.$disconnect().catch(() => {});
      await closeControlDb();
    };
    const control = controlDb();
    const bundles = build.bundleDir();

    // ─── Staff, signed in ────────────────────────────────────────────────────────────────────────
    const addStaff = async (role: "OWNER" | "ADMIN" | "READONLY", tag = role.toLowerCase()) =>
      (await staffLib.createStaff({ email: `${tag}@zzbackups.example`, name: `Zz Backups ${tag}`, role }, "script:check:console-backups")).id;
    const staff = { owner: await addStaff("OWNER"), owner2: await addStaff("OWNER", "owner2"), admin: await addStaff("ADMIN"), readonly: await addStaff("READONLY") };
    const totpSecret = totp.generateTotpSecret();
    await control.platformUser.update({ where: { id: staff.owner }, data: { totpSecretCipher: kek.sealForPlatform("staff-totp", totpSecret), totpEnabledAt: new Date(Date.now() - 60_000) } });
    const sessions = new Map<string, string>();
    const actAs = async (userId: string) => {
      const token = randomBytes(32).toString("base64url");
      const id = sha256(token);
      await control.platformSession.create({ data: { id, userId, expiresAt: new Date(Date.now() + HOUR), mfaAt: new Date(), userAgent: "check:console-backups" } });
      jar.set(COOKIE, token);
      sessions.set(userId, id);
      return id;
    };
    const freshCode = () => {
      totp.forgetUsedTotpSteps();
      return authenticator.generate(totpSecret);
    };
    const refusedRole = (r: { ok: boolean; error?: string }) => !r.ok && /role cannot/i.test(r.error ?? "");
    const rowOf = (id: string) => control.platformBackup.findUniqueOrThrow({ where: { id } });
    const waitFor = async (id: string, done: (row: Awaited<ReturnType<typeof rowOf>>) => boolean, ms = 240_000) => {
      const until = Date.now() + ms;
      for (;;) {
        const row = await rowOf(id);
        if (done(row) || Date.now() > until) return row;
        await sleep(250);
      }
    };
    const fileSha = async (file: string) => sha256(await readFile(file));
    const exists = (file: string) => stat(file).then(() => true, () => false);

    // ─── A workspace with a database, a person and a file in the box ─────────────────────────────
    const tenantId = randomUUID();
    await control.tenant.create({
      data: {
        id: tenantId,
        slug: "zzcbmain",
        name: "Zz Backups Main",
        status: "ACTIVE",
        isDefault: true,
        keyBundleCipher: keys.sealKeyBundle(tenantId, keys.newKeyBundle()),
        dbUrlCipher: kek.sealForTenant(tenantId, "db-url", workspaceUrl),
        dbName: workspaceName,
        country: "IN",
        currency: "INR",
        timezone: "Asia/Kolkata",
        ownerEmail: "owner@zzcbmain.example",
        storageUsedBytes: BigInt(2 * MB),
      },
    });
    const ws = directClient(workspaceUrl, { max: 1 });
    await ws.user.create({ data: { name: "Zz Person", email: "zz@zzcbmain.example", passwordHash: "!", role: "SALES" } });
    await ws.$disconnect();
    const box = (await storageBox())!;
    await box.put(`workspaces/${tenantId}/files/employee-documents/2026-11/${"a".repeat(24)}`, randomBytes(300_000));
    const tenant = (await registry.tenantById(tenantId))!;

    /** Workers as the page starts them, run here instead — what each was given is kept to look at. */
    const inProcess = () =>
      jobs.setWorkerSpawnerForChecks((_command, args, env) => {
        spawned.push({ args, env, handoff: null });
        void jobs.runBundleJob(args[2] as "build" | "verify", args[3]!).catch((err) => console.error(`worker: ${err instanceof Error ? err.message : err}`));
      });

    // ─── 1. Roles ────────────────────────────────────────────────────────────────────────────────
    section("1. Who sees the page, and who acts");
    ok("Backups is in the Admin group of the nav, for owners and admins", nav.pageByKey("backups").group === "admin" && nav.pageByKey("backups").href === "/backups" && nav.canOpen("OWNER", "backups") && nav.canOpen("ADMIN", "backups"));
    ok("  and not for support, billing or read-only staff", !nav.canOpen("SUPPORT", "backups") && !nav.canOpen("BILLING", "backups") && !nav.canOpen("READONLY", "backups"));
    await actAs(staff.readonly);
    const readonlyPage = await render(pageAt("backups/page")).then(() => "rendered", (e: Error) => e.message);
    ok("read-only staff get not found", readonlyPage === "notFound", readonlyPage);
    await actAs(staff.admin);
    const adminPage = textOf(await render(pageAt("backups/page")));
    ok("an admin sees the page, marked view only, with no New backup or upload", adminPage.includes("Backups") && adminPage.includes("View only") && !adminPage.includes("New backup") && !adminPage.includes("Upload a backup"), adminPage.slice(0, 300));
    const input = { kind: "workspace", workspace: "zzcbmain", passphrase: PASS, confirm: PASS };
    ok("an admin can't start a backup", refusedRole(await actions.consoleCreateBackup(input)));
    ok("  nor see its estimate, verify, delete or give a code for a download", refusedRole(await actions.consolePreviewBackup(input)) && refusedRole(await actions.consoleVerifyBackup("x".repeat(20), PASS)) && refusedRole(await actions.consoleDeleteBackup("x".repeat(20))) && refusedRole(await actions.consoleBackupStepUp("123456")));
    ok("  and nothing was made", (await control.platformBackup.count()) === 0);

    // ─── 2. A workspace backup, by the real worker ───────────────────────────────────────────────
    section("2. A workspace backup, made by the worker the page spawns");
    jobs.setWorkerSpawnerForChecks((command, args, env, onError) => {
      // The handoff as the worker will find it: its mode, and whether the passphrase is readable in it.
      const id = args[3]!;
      const file = path.join(bundles, ".jobs", `${id}.${args[2]}.key`);
      void stat(file).then(async (info) => {
        const held = (await readFile(file, "utf8")).includes(PASS);
        spawned.push({ args, env, handoff: { mode: info.mode & 0o777, holdsPassphrase: held } });
        const child = spawn(command, args, { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });
        child.stdout.on("data", (b: Buffer) => childOutput.push(b.toString("utf8")));
        child.stderr.on("data", (b: Buffer) => childOutput.push(b.toString("utf8")));
        child.once("error", onError);
      }, onError);
    });
    await actAs(staff.owner);
    const mismatch = await actions.consoleCreateBackup({ ...input, confirm: PASS + "x" });
    ok("two passphrases that differ are refused", !mismatch.ok && /not the same/.test(mismatch.error));
    const short = await actions.consoleCreateBackup({ ...input, passphrase: "short", confirm: "short" });
    ok("  and one shorter than the rules allow, with the rule", !short.ok && /at least 12 characters/.test(short.error));
    const preview = await actions.consolePreviewBackup(input);
    ok("the estimate: its database and files, against the disk's free space", preview.ok && preview.data.bytes >= 2 * MB && preview.data.free > 0 && preview.data.fits, preview);
    const started = await actions.consoleCreateBackup(input);
    ok("an owner starts a workspace backup", started.ok, started);
    const wsId = started.ok ? started.data.id : "";
    const runningRow = await rowOf(wsId);
    ok("  its row is made at once, RUNNING, with the estimate kept for the progress bar", runningRow.status === "RUNNING" && runningRow.source === "CREATED" && runningRow.tenantId === tenantId && (runningRow.progress as { expectedBytes?: number }).expectedBytes === (preview.ok ? preview.data.bytes : -1));
    const wsRow = await waitFor(wsId, (r) => r.status !== "RUNNING");
    const wsFile = path.join(bundles, wsRow.fileName);
    ok("the worker made it: READY", wsRow.status === "READY", { status: wsRow.status, error: wsRow.error, output: childOutput.join("").slice(0, 600) });
    ok("  with the file's size and sha256 on its row", (await exists(wsFile)) && Number(wsRow.sizeBytes) === (await stat(wsFile)).size && wsRow.sha256 === (await fileSha(wsFile)));
    const wsProgress = wsRow.progress as { entries?: number; entriesTotal?: number; bytes?: number };
    const wsHeader = await format.readBundleHeader(wsFile);
    ok("  progress recorded: entries done of the total, and bytes", (wsProgress.entries ?? 0) >= 3 && wsProgress.entriesTotal === wsProgress.entries && (wsProgress.bytes ?? 0) > 0, wsProgress);
    ok("  its header is the workspace's, under this server's key", wsHeader.kind === "workspace" && wsHeader.workspaces[0]?.id === tenantId && wsHeader.keyFingerprint === kek.platformKeyFingerprint() && wsHeader.createdBy === `staff:${staff.owner}`);
    ok("  expiring a day after it was made", !!wsRow.expiresAt && Math.abs(wsRow.expiresAt.getTime() - wsRow.finishedAt!.getTime() - 24 * HOUR) < 5000);
    const first = spawned[0];
    ok("the worker's command line is the job and the row's id, nothing more", !!first && first.args.slice(-2).join(" ") === `build ${wsId}` && !first.args.some((a) => a.includes(PASS)), first?.args);
    ok("  its environment holds no passphrase", !!first && !Object.values(first.env).some((v) => typeof v === "string" && v.includes(PASS)));
    ok("  the passphrase reached it sealed, in a file only this user can read (0600)", first?.handoff?.mode === 0o600 && first.handoff.holdsPassphrase === false, first?.handoff);
    ok("  and that file is gone", !(await jobs.passphraseWaiting(wsId, "build")) && (await readdir(path.join(bundles, ".jobs"))).length === 0);
    ok("  the worker said nothing with the passphrase in it", !childOutput.join("").includes(PASS));
    ok("the backup really holds the workspace: it opens with the passphrase and is sound", (await format.verifyBundle(wsFile, PASS)).ok);
    const createAudit = await control.platformAuditLog.findFirst({ where: { action: "backup.create" } });
    ok("starting it is in the audit log, under the owner, naming the workspace", createAudit?.actor === staff.owner && createAudit.tenantId === tenantId && (createAudit.detail as { workspace?: string }).workspace === "zzcbmain");

    // ─── 3. A full backup, one at a time, a dead worker ──────────────────────────────────────────
    section("3. A full backup; one at a time; a worker that died");
    jobs.setWorkerSpawnerForChecks((_command, args, env) => void spawned.push({ args, env, handoff: null })); // started, never runs
    const stuck = await actions.consoleCreateBackup({ kind: "full", passphrase: PASS, confirm: PASS });
    ok("a full backup started (its worker never comes)", stuck.ok, stuck);
    const stuckId = stuck.ok ? stuck.data.id : "";
    const again = await actions.consoleCreateBackup({ kind: "full", passphrase: PASS, confirm: PASS });
    ok("a second full backup while one is being made is refused", !again.ok && /already being made/.test(again.error), again);
    const otherKind = await actions.consoleCreateBackup(input);
    const otherKindRow = otherKind.ok ? await rowOf(otherKind.data.id) : null;
    ok("  but a workspace backup meanwhile is not (one at a time per kind and workspace)", otherKind.ok && otherKindRow?.status === "RUNNING", otherKind);
    const stuckRow = await rowOf(stuckId);
    await writeFile(path.join(bundles, `${stuckRow.fileName}.part`), "half a bundle");
    const old = new Date(Date.now() - 31 * 60_000);
    for (const id of [stuckId, otherKind.ok ? otherKind.data.id : stuckId]) {
      await control.platformBackup.update({ where: { id }, data: { startedAt: old, progress: { entry: "control/control.dump", bytes: 10, entries: 0, at: old.toISOString() } } });
    }
    for (const name of await readdir(path.join(bundles, ".jobs"))) await utimes(path.join(bundles, ".jobs", name), old, old);
    const settled = await jobs.settleBackups(new Date(), upload.cleanStaleUploads);
    const deadRow = await rowOf(stuckId);
    ok("a build not heard from for half an hour is FAILED, saying why", deadRow.status === "FAILED" && deadRow.error === "stopped — the server restarted while it was being made" && settled.stopped === 2, { status: deadRow.status, error: deadRow.error, settled });
    ok("  its half-written file is removed, and the passphrase nobody took", !(await exists(path.join(bundles, `${stuckRow.fileName}.part`))) && (await readdir(path.join(bundles, ".jobs"))).length === 0);
    const recent = await actions.consoleCreateBackup({ kind: "full", passphrase: PASS, confirm: PASS });
    const recentId = recent.ok ? recent.data.id : stuckId;
    await jobs.settleBackups(new Date(), upload.cleanStaleUploads);
    ok("a build heard from recently is left alone, and once the dead one is settled another can start", recent.ok && (await rowOf(recentId)).status === "RUNNING");
    // Its worker never comes either: put out of the way, its passphrase taken as a worker would.
    await control.platformBackup.update({ where: { id: recentId }, data: { status: "FAILED", error: "zz: cleared by the check" } });
    await jobs.takePassphrase(recentId, "build");

    inProcess();
    const full = await actions.consoleCreateBackup({ kind: "full", passphrase: PASS, confirm: PASS });
    ok("an owner starts a full backup", full.ok, full);
    const fullRow = await waitFor(full.ok ? full.data.id : "", (r) => r.status !== "RUNNING");
    const fullFile = path.join(bundles, fullRow.fileName);
    const fullHeader = fullRow.status === "READY" ? await format.readBundleHeader(fullFile) : null;
    ok("the full backup is READY, its size and sha256 the file's", fullRow.status === "READY" && Number(fullRow.sizeBytes) === (await stat(fullFile)).size && fullRow.sha256 === (await fileSha(fullFile)), { status: fullRow.status, error: fullRow.error });
    ok("  the control plane and the workspace in it, the control plane's schema in its header", fullHeader?.kind === "full" && fullHeader.workspaces.some((w) => w.id === tenantId) && !!fullHeader.control?.schemaVersion && fullRow.tenantId === null);
    ok("  named for the full application", /^deskzo-full-\d{4}-\d\d-\d\d-\d{6}\.dzbk$/.test(fullRow.fileName), fullRow.fileName);
    ok("  the in-process worker's handoff is gone too", !(await jobs.passphraseWaiting(fullRow.id, "build")));

    // ─── 4. Not enough disk ──────────────────────────────────────────────────────────────────────
    section("4. Not enough disk");
    const before = await control.platformBackup.count();
    jobs.setFreeSpaceProbeForChecks(async () => 1 * MB);
    const tight = await actions.consolePreviewBackup(input);
    ok("the estimate says it won't fit", tight.ok && !tight.data.fits && tight.data.free === MB, tight);
    const refused = await actions.consoleCreateBackup(input);
    ok("starting it is refused, with the numbers", !refused.ok && /needs about [\d.]+ MB and the disk where backups are made has 1\.0 MB free/.test(refused.error), refused);
    ok("  and nothing was made", (await control.platformBackup.count()) === before);
    jobs.setFreeSpaceProbeForChecks(null);

    // ─── 5. Download ─────────────────────────────────────────────────────────────────────────────
    section("5. The download route");
    const get = (id: string, from: "same" | "cross" | "none" = "same", method = "GET") => {
      const req = consoleRequest(`/backup-files/${id}`, { from, method });
      return (method === "HEAD" ? download.HEAD : download.GET)(req, { params: Promise.resolve({ id }) });
    };
    const ownerSession = await actAs(staff.owner);
    const noStepUp = await get(wsId);
    ok("an owner without a fresh code is refused", noStepUp.status === 403 && /fresh code/.test(await noStepUp.text()));
    const wrongCode = await actions.consoleBackupStepUp(String((Number(authenticator.generate(totpSecret)) + 500_000) % 1_000_000).padStart(6, "0"));
    ok("  a wrong code doesn't count", !wrongCode.ok && /not right/.test(wrongCode.error) && !(await control.platformSession.findUniqueOrThrow({ where: { id: ownerSession } })).stepUpAt);
    const stepped = await actions.consoleBackupStepUp(freshCode());
    ok("  a fresh code is taken, for this session", stepped.ok && !!(await control.platformSession.findUniqueOrThrow({ where: { id: ownerSession } })).stepUpAt, stepped);
    const auditsBefore = await control.platformAuditLog.count({ where: { action: "backup.download" } });
    const head = await get(wsId, "same", "HEAD");
    ok("HEAD answers with the headers, records nothing", head.status === 200 && head.headers.get("content-length") === String((await stat(wsFile)).size) && (await control.platformAuditLog.count({ where: { action: "backup.download" } })) === auditsBefore);
    const res = await get(wsId);
    const body = Buffer.from(await res.arrayBuffer());
    ok("the download streams the exact bytes", res.status === 200 && sha256(body) === wsRow.sha256 && body.length === Number(wsRow.sizeBytes), res.status);
    ok("  with Content-Length", res.headers.get("content-length") === String(body.length));
    const disposition = res.headers.get("content-disposition") ?? "";
    ok("  and the file's name: deskzo-<slug>-<when>.dzbk", /^attachment; filename="deskzo-zzcbmain-\d{4}-\d\d-\d\dT\d{4}Z\.dzbk"$/.test(disposition), disposition);
    const fullRes = await get(fullRow.id);
    const fullName = fullRes.headers.get("content-disposition") ?? "";
    await fullRes.body?.cancel();
    ok("  a full one: deskzo-full-<when>.dzbk", /filename="deskzo-full-\d{4}-\d\d-\d\dT\d{4}Z\.dzbk"/.test(fullName), fullName);
    const downloadAudit = await control.platformAuditLog.findFirst({ where: { action: "backup.download" }, orderBy: { at: "desc" } });
    ok("each download is in the audit log, under the owner", downloadAudit?.actor === staff.owner && (await control.platformAuditLog.count({ where: { action: "backup.download" } })) === auditsBefore + 2);
    const cross = await get(wsId, "cross");
    ok("refused from another site, even with a fresh code", cross.status === 403);
    const bare = await get(wsId, "none");
    ok("  and a request that says nothing of where it came from", bare.status === 403);
    const adminSession = await actAs(staff.admin);
    await control.platformSession.update({ where: { id: adminSession }, data: { stepUpAt: new Date() } });
    const asAdmin = await get(wsId);
    ok("an admin is refused, whatever their session says", asAdmin.status === 403 && /Only an owner/.test(await asAdmin.text()));
    // The owner again, in a session whose code was given eleven minutes ago.
    const ownerToken = randomBytes(32).toString("base64url");
    await control.platformSession.create({ data: { id: sha256(ownerToken), userId: staff.owner, expiresAt: new Date(Date.now() + HOUR), mfaAt: new Date(), stepUpAt: new Date(Date.now() - 11 * 60_000) } });
    jar.set(COOKIE, ownerToken);
    const stale = await get(wsId);
    ok("a code given more than ten minutes ago no longer counts", stale.status === 403);
    await control.platformSession.update({ where: { id: sha256(ownerToken) }, data: { stepUpAt: new Date() } });
    const otherSession = await actAs(staff.owner);
    ok("  nor does one given in another session of the same owner", (await get(wsId)).status === 403 && otherSession !== sha256(ownerToken));
    jar.set(COOKIE, ownerToken);
    // An expired one: its time passed, not yet settled.
    const expiring = await build.buildWorkspaceBundle(tenant, { passphrase: PASS, createdBy: "script:check" });
    await control.platformBackup.update({ where: { id: expiring.backupId! }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const gone = await get(expiring.backupId!);
    ok("an expired backup is refused, saying so, and its file is removed", gone.status === 410 && /expired/.test(await gone.text()) && !(await exists(expiring.file)) && (await rowOf(expiring.backupId!)).status === "EXPIRED");
    const again410 = await get(expiring.backupId!);
    ok("  and stays refused", again410.status === 410);

    // ─── 6. Upload ───────────────────────────────────────────────────────────────────────────────
    section("6. Uploading a backup, in parts");
    // A bundle of three parts (16 + 16 + 8 MB and a bit), from another server: a workspace this one never had.
    const bigFile = path.join(scratch, "upload-source.dzbk");
    {
      const out = createWriteStream(bigFile);
      const writer = await format.createBundleWriter(
        out,
        {
          kind: "workspace",
          createdAt: new Date().toISOString(),
          createdBy: "script:elsewhere",
          app: { name: "Deskzo One", version: "0.1.0", commit: null },
          control: null,
          workspaces: [{ id: "zz-foreign-workspace", slug: "zzforeign", name: "Zz Foreign", schemaVersion: null }],
          keyFingerprint: kek.platformKeyFingerprint(),
        },
        PASS,
      );
      await writer.addEntry("workspaces/zz-foreign-workspace/box/big", (async function* () {
        for (let i = 0; i < 40; i++) yield randomBytes(MB);
      })());
      await writer.finish();
      if (!out.closed) await new Promise((r) => out.once("close", r));
    }
    const source = await readFile(bigFile);
    const P = upload.PART_BYTES;
    const partOf = (n: number, of: Buffer = source) => of.subarray(n * P, Math.min(of.length, (n + 1) * P));
    const init = (file: Buffer, name = "zz-upload.dzbk", total = file.length, from: "same" | "cross" = "same") =>
      uploadInit.POST(consoleRequest("/backup-uploads", { method: "POST", from, body: file.subarray(0, Math.min(upload.HEAD_BYTES, total)), headers: { "x-bundle-name": encodeURIComponent(name), "x-bundle-size": String(total) } }));
    const put = (id: string, n: number, bytes: Buffer, sha = sha256(bytes)) =>
      uploadOne.PUT(consoleRequest(`/backup-uploads/${id}?part=${n}`, { method: "PUT", body: bytes, headers: { "x-part-sha256": sha } }), { params: Promise.resolve({ id }) });
    const status = async (id: string) => (await (await uploadOne.GET(consoleRequest(`/backup-uploads/${id}`), { params: Promise.resolve({ id }) })).json()) as { received?: number; nextPart?: number; error?: string };

    await actAs(staff.admin);
    ok("an admin can't upload", (await init(source)).status === 403);
    await actAs(staff.owner);
    ok("  nor can anybody from another site", (await init(source, undefined, undefined, "cross")).status === 403);
    const pgdump = Buffer.concat([Buffer.from("PGDMP"), randomBytes(5000)]);
    const notBundle = await init(pgdump, "dump.dzbk");
    ok("a file that isn't a bundle is refused at the start, before any part, saying what it is", notBundle.status === 400 && /raw pg_dump file/.test(((await notBundle.json()) as { error: string }).error));
    const random = await init(randomBytes(70_000), "random.dzbk");
    ok("  and so is anything else", random.status === 400 && /not a Deskzo Backup & Restore bundle/.test(((await random.json()) as { error: string }).error));
    ok("  nothing of either is kept", (await readdir(upload.incomingDir()).catch(() => [])).filter((n) => !n.startsWith(".")).length === 0);
    jobs.setFreeSpaceProbeForChecks(async () => 10 * MB);
    const tooBig = await init(source);
    ok("a file larger than the disk has free is refused at the start, with the numbers", tooBig.status === 413 && /40\.\d MB and this server's disk has 10\.0 MB free/.test(((await tooBig.json()) as { error: string }).error));
    jobs.setFreeSpaceProbeForChecks(null);

    const begun = await init(source);
    const begunBody = (await begun.json()) as { id: string; parts: number; partSize: number; header: { kind: string } | null };
    const upId = begunBody.id;
    ok("an owner begins an upload: three parts of 16 MB, the header read from the first bytes", begun.status === 200 && begunBody.parts === 3 && begunBody.partSize === P && begunBody.header?.kind === "workspace", begunBody);
    const p1 = await put(upId, 1, partOf(1));
    const p1Body = (await p1.json()) as { received: number; waiting: boolean };
    ok("part 1 before part 0: kept aside, nothing appended yet", p1.status === 200 && p1Body.waiting && p1Body.received === 0, p1Body);
    const p1again = await put(upId, 1, partOf(1));
    ok("  part 1 again, the same bytes: accepted, nothing changes", p1again.status === 200 && ((await p1again.json()) as { already: boolean }).already === true);
    const p3ahead = await put(upId, 2, partOf(2).subarray(0, 100), sha256(partOf(2)));
    ok("  a part that arrives cut short is refused, and nothing kept of it", p3ahead.status === 400 && /did not arrive whole/.test(((await p3ahead.json()) as { error: string }).error));
    const p0 = await put(upId, 0, partOf(0));
    const p0Body = (await p0.json()) as { received: number; nextPart: number };
    ok("part 0: appended, and part 1 after it, from where it waited", p0.status === 200 && p0Body.received === 2 * P && p0Body.nextPart === 2, p0Body);
    const changed = Buffer.from(partOf(0));
    changed[100] ^= 0xff;
    const p0other = await put(upId, 0, changed);
    ok("  part 0 sent again with different bytes is refused", p0other.status === 409);
    const badSha = await put(upId, 2, partOf(2), "0".repeat(64));
    ok("a part whose SHA-256 is not its own is refused", badSha.status === 400);
    ok("  the server still has exactly two parts — what a dropped connection leaves", (await status(upId)).received === 2 * P && (await status(upId)).nextPart === 2);
    const early = await uploadOne.POST(consoleRequest(`/backup-uploads/${upId}`, { method: "POST" }), { params: Promise.resolve({ id: upId }) });
    ok("  finishing before the last part is refused, naming it", early.status === 409 && /Part 2/.test(((await early.json()) as { error: string }).error));
    // A reload: the page asks what arrived, and sends from there.
    const resumed = await status(upId);
    const last = await put(upId, resumed.nextPart!, partOf(resumed.nextPart!));
    ok("resumed from the part the server asks for", last.status === 200 && ((await last.json()) as { received: number }).received === source.length);
    await actAs(staff.owner2);
    const notMine = await uploadOne.POST(consoleRequest(`/backup-uploads/${upId}`, { method: "POST" }), { params: Promise.resolve({ id: upId }) });
    ok("another owner can't finish somebody else's upload", notMine.status === 404);
    jar.set(COOKIE, ownerToken);
    const completed = await uploadOne.POST(consoleRequest(`/backup-uploads/${upId}`, { method: "POST" }), { params: Promise.resolve({ id: upId }) });
    const completedBody = (await completed.json()) as { backupId: string; fileName: string; sha256: string };
    const upRow = completed.status === 200 ? await rowOf(completedBody.backupId) : null;
    const upFile = upRow ? path.join(bundles, upRow.fileName) : "";
    ok("finished: a READY backup, source UPLOADED", completed.status === 200 && upRow?.status === "READY" && upRow.source === "UPLOADED" && upRow.startedById === staff.owner, completedBody);
    ok("  byte-identical to the file sent", !!upRow && (await fileSha(upFile)) === sha256(source) && upRow.sha256 === sha256(source) && Number(upRow.sizeBytes) === source.length);
    const sourceHeader = await format.readBundleHeader(bigFile);
    const canonical = (v: unknown): string => (Array.isArray(v) ? `[${v.map(canonical).join(",")}]` : v && typeof v === "object" ? `{${Object.keys(v).sort().map((k) => `${JSON.stringify(k)}:${canonical((v as Record<string, unknown>)[k])}`).join(",")}}` : JSON.stringify(v));
    ok("  its row's header is the file's: the workspace it names, kind and key", !!upRow && canonical(upRow.header) === canonical(sourceHeader) && upRow.tenantSlug === "zzforeign" && upRow.kind === "WORKSPACE", upRow?.header);
    ok("  nothing left in staging", (await upload.uploadLeftovers(upId)).length === 0);
    ok("  recorded as backup.upload, with no workspace of this server named", !!(await control.platformAuditLog.findFirst({ where: { action: "backup.upload", tenantId: null } })));
    const finishedAgain = await uploadOne.POST(consoleRequest(`/backup-uploads/${upId}`, { method: "POST" }), { params: Promise.resolve({ id: upId }) });
    ok("  finishing it twice makes no second backup", finishedAgain.status === 404 && (await control.platformBackup.count({ where: { source: "UPLOADED" } })) === 1);

    // Part 0 must be the file the upload began with.
    const other = await readFile(wsFile);
    const swapBegun = (await (await init(source)).json()) as { id: string };
    const swapped = await put(swapBegun.id, 0, partOf(0, other.length > P ? other : Buffer.concat([other, randomBytes(P)]).subarray(0, P)));
    ok("a first part that isn't the file the upload began with is refused", swapped.status === 400 || swapped.status === 409);
    // Abandoned: cleared after a day.
    await upload.ageUploadForChecks(swapBegun.id, new Date(Date.now() - 25 * HOUR));
    await jobs.settleBackups(new Date(), upload.cleanStaleUploads);
    ok("an upload untouched for a day is cleared", (await upload.uploadLeftovers(swapBegun.id)).length === 0);

    // ─── 7. Verify, and whether it could be restored here ────────────────────────────────────────
    section("7. Verify, and the compatibility report");
    inProcess();
    const wrongPass = await actions.consoleVerifyBackup(wsId, WRONG);
    ok("a passphrase that doesn't open it is refused at once", !wrongPass.ok && /doesn't open/.test(wrongPass.error), wrongPass);
    const verifying = await actions.consoleVerifyBackup(wsId, PASS);
    ok("an owner verifies a backup", verifying.ok, verifying);
    const verified = await waitFor(wsId, (r) => (r.verifyProgress as { state?: string } | null)?.state !== "running", 60_000);
    ok("  a good one is sound: verified at, ok, no problems", verified.verifiedAt !== null && verified.verifyOk === true && Array.isArray(verified.verifyProblems) && (verified.verifyProblems as unknown[]).length === 0, { ok: verified.verifyOk, problems: verified.verifyProblems, progress: verified.verifyProgress });
    ok("  its passphrase's file gone", !(await jobs.passphraseWaiting(wsId, "verify")));
    // A tampered copy: one byte flipped in the middle of the body.
    const tamperedName = "zz-tampered.dzbk";
    const tamperedBytes = Buffer.from(await readFile(wsFile));
    tamperedBytes[Math.floor(tamperedBytes.length / 2)] ^= 0x01;
    await writeFile(path.join(bundles, tamperedName), tamperedBytes);
    const tampered = await control.platformBackup.create({
      data: { kind: "WORKSPACE", tenantId, tenantSlug: "zzcbmain", status: "READY", source: "UPLOADED", fileName: tamperedName, sizeBytes: BigInt(tamperedBytes.length), sha256: sha256(tamperedBytes), header: JSON.parse(JSON.stringify(wsHeader)), startedById: staff.owner, finishedAt: new Date(), expiresAt: new Date(Date.now() + HOUR) },
    });
    ok("a tampered copy's header still opens with the passphrase", (await actions.consoleVerifyBackup(tampered.id, PASS)).ok);
    const tamperedRow = await waitFor(tampered.id, (r) => (r.verifyProgress as { state?: string } | null)?.state !== "running", 60_000);
    const problems = (tamperedRow.verifyProblems as string[] | null) ?? [];
    ok("  and verify says what is wrong with it", tamperedRow.verifyOk === false && problems.length > 0 && /frame|damaged|altered/i.test(problems.join(" ")), problems);

    // Made under a different PLATFORM_MASTER_KEY, and one claiming a schema from the future.
    process.env.PLATFORM_MASTER_KEY = randomBytes(32).toString("base64");
    const otherKey = await build.buildWorkspaceBundle(tenant, { passphrase: PASS, createdBy: "script:check" }).finally(() => {
      process.env.PLATFORM_MASTER_KEY = realKey;
    });
    const future = await build.buildWorkspaceBundle(tenant, {
      passphrase: PASS,
      createdBy: "script:check",
      adjustHeader: (h) => ({ ...h, workspaces: h.workspaces.map((w) => ({ ...w, schemaVersion: "29991231000000_a_migration_from_the_future" })) }),
    });
    const board = await data.backupsBoard({ kind: null, workspace: null });
    const compatOf = (id: string) => board.rows.find((r) => r.id === id)?.compat ?? null;
    const same = compatOf(wsId);
    ok("same key and schema: it can be restored here", same?.verdict === "ok" && same.lines.some((l) => l.key === "key" && l.tone === "success" && /this server's PLATFORM_MASTER_KEY/.test(l.text)), same);
    ok("  and says the workspace is here already, by the same id", !!same?.lines.some((l) => l.key === `ws:${tenantId}` && /on this server as zzcbmain \(the same id\)/.test(l.text)));
    const different = compatOf(otherKey.backupId!);
    ok(
      "made under a different PLATFORM_MASTER_KEY: blocked, in words",
      different?.verdict === "blocked" && !!different.lines.find((l) => l.key === "key" && l.text === "Made with a different PLATFORM_MASTER_KEY — set that key on this server before restoring."),
      different,
    );
    const newer = compatOf(future.backupId!);
    ok("a newer schema than this server's: reported newer, can't be restored until this server is updated", newer?.verdict === "blocked" && !!newer.lines.find((l) => l.key === `ws:${tenantId}` && /newer/.test(l.label) && /until this server is updated/.test(l.text)), newer);
    const foreign = compatOf(upRow!.id);
    ok("an uploaded bundle of a workspace this server never had says a restore would add it", !!foreign?.lines.some((l) => /not on this server — a restore would add it/.test(l.text)));
    const fullCompat = compatOf(fullRow.id);
    ok("a full one reports the control plane's schema as the same", !!fullCompat?.lines.some((l) => l.key === "control" && l.label === "Control plane: same"), fullCompat?.lines);
    const facts = await data.serverFacts();
    const futureControl = shared.compatibilityOf({ ...shared.headerSummary(fullRow.header)!, control: { schemaVersion: "29991231000000_x" } }, facts);
    ok("  and a newer control plane as newer — blocked", futureControl.verdict === "blocked" && futureControl.lines.some((l) => l.key === "control" && /newer/i.test(l.label)));
    const olderControl = shared.compatibilityOf({ ...shared.headerSummary(fullRow.header)!, control: { schemaVersion: facts.controlMigrations[0]! } }, facts);
    ok("  an older one as older, brought up to date by a restore", olderControl.lines.some((l) => l.key === "control" && /older/i.test(l.label) && /brings it up to date/.test(l.text)));

    // ─── 8. Expiry and settling ──────────────────────────────────────────────────────────────────
    section("8. Expiry and settling");
    await control.platformBackup.update({ where: { id: future.backupId! }, data: { expiresAt: new Date(Date.now() - 60_000) } });
    await control.platformBackup.update({ where: { id: tampered.id }, data: { verifyProgress: { state: "running", at: new Date(Date.now() - 40 * 60_000).toISOString(), bytes: 5 } } });
    const settledAgain = await jobs.settleBackups(new Date(), upload.cleanStaleUploads);
    ok("a file past its time is removed and its row EXPIRED", (await rowOf(future.backupId!)).status === "EXPIRED" && !(await exists(future.file)) && settledAgain.expired >= 1, settledAgain);
    ok("  a check whose worker died is marked stopped", ((await rowOf(tampered.id)).verifyProgress as { state?: string }).state === "stopped" && settledAgain.checksStopped === 1);
    ok("  a READY one not yet due is left alone", (await rowOf(wsId)).status === "READY" && (await exists(wsFile)));

    // ─── Delete ──────────────────────────────────────────────────────────────────────────────────
    section("Delete");
    await actAs(staff.admin);
    ok("an admin can't delete one", refusedRole(await actions.consoleDeleteBackup(otherKey.backupId!)));
    jar.set(COOKIE, ownerToken);
    const deleted = await actions.consoleDeleteBackup(otherKey.backupId!);
    ok("an owner deletes one: its file removed, the row DELETED, recorded", deleted.ok && !(await exists(otherKey.file)) && (await rowOf(otherKey.backupId!)).status === "DELETED" && !!(await control.platformAuditLog.findFirst({ where: { action: "backup.delete" } })), deleted);
    const deletedGet = await get(otherKey.backupId!);
    ok("  and downloading it is refused, saying it was deleted", deletedGet.status === 410 && /deleted/.test(await deletedGet.text()));
    const runningNow = await control.platformBackup.create({ data: { kind: "FULL", status: "RUNNING", source: "CREATED", fileName: "deskzo-full-zz.dzbk", startedById: staff.owner, progress: { entry: "workspaces/x/db.dump", bytes: 3 * MB, entries: 3, entriesTotal: 10, expectedBytes: 12 * MB, at: new Date().toISOString() } } });
    ok("  one still being made can't be deleted", !(await actions.consoleDeleteBackup(runningNow.id)).ok);

    // ─── 9. The page ─────────────────────────────────────────────────────────────────────────────
    section("9. The page");
    await control.restoreRun.create({
      data: { kind: "WORKSPACE", tenantId, tenantSlug: "zzcbmain", backupId: wsId, status: "FAILED", startedById: staff.owner, finishedAt: new Date(), error: "zz restore failed", log: [{ at: new Date().toISOString(), step: "verify", message: "Read the whole file once" }, { at: new Date().toISOString(), step: "stop", message: "zz stopped on purpose" }] },
    });
    jar.set(COOKIE, ownerToken);
    const raw = await render(pageAt("backups/page"));
    const page = textOf(raw);
    ok("an owner sees New backup and Upload a backup", page.includes("New backup") && page.includes("Upload a backup"));
    ok("  every backup listed: made here and uploaded, ready, failed, expired, deleted", page.includes("zzforeign") && page.includes("made here") && page.includes("uploaded") && page.includes("Ready") && page.includes("Failed") && page.includes("Expired") && page.includes("Deleted"));
    ok("  the one being made, with its progress", page.includes("Being made") && page.includes("3 of 10 entries") && page.includes("workspaces/x/db.dump") && page.includes("of about 12.0 MB"), page.slice(page.indexOf("Being made") - 100, page.indexOf("Being made") + 300));
    ok("  the size and the sha256, short", page.includes(wsRow.sha256!.slice(0, 12)) && !page.includes(wsRow.sha256!));
    ok("  a dead build's reason", page.includes("stopped — the server restarted while it was being made"));
    ok("  verify's answers, and the compatibility report", page.includes("Verified sound") && page.includes("Verify found problems") && page.includes("Can be restored here") && page.includes("Can't be restored here yet"));
    ok("  the restores, each with its log to open", page.includes("Restores") && page.includes("Log (2 lines)") && page.includes("zz stopped on purpose") && page.includes("zz restore failed"));
    ok("  live while something is being made: it refreshes itself", page.includes("Live"));
    ok("no passphrase anywhere in it", !raw.includes(PASS) && !raw.includes(WRONG));
    const salt = (wsHeader.kdf as { salt?: string }).salt ?? "zz-no-salt";
    ok("  nor key material: no PLATFORM_MASTER_KEY, no fingerprint, no KDF salt, verifier or nonce", !raw.includes(realKey) && !raw.includes(kek.platformKeyFingerprint()!) && !raw.includes(salt) && !raw.includes(wsHeader.noncePrefix) && !raw.includes(wsHeader.verifier.iv));
    const filtered = textOf(await render(pageAt("backups/page"), {}, { workspace: "zzcbmain" }));
    ok("filtered to a workspace: only its backups", filtered.includes("zzcbmain") && !filtered.includes("zzforeign") && !filtered.includes("Full application Everything"), filtered.slice(0, 200));
    const fullOnly = textOf(await render(pageAt("backups/page"), {}, { kind: "full" }));
    ok("  to full backups: no workspace's", fullOnly.includes("Everything") && !fullOnly.includes("One workspace · made here"));
    const wsPage = await render(pageAt("workspaces/[slug]/page"), { slug: "zzcbmain" });
    const count = await control.platformBackup.count({ where: { tenantId } });
    ok("the workspace's page links to its backups, with how many", wsPage.includes('href="/backups?workspace=zzcbmain"') && textOf(wsPage).includes(`Backups (${count})`), count);
    ok("  as the console's own links go (no /platform-console prefix)", !raw.includes("/platform-console/") && !wsPage.includes("/platform-console/backups"));

    // ─── The passphrase, nowhere ─────────────────────────────────────────────────────────────────
    section("The passphrase, nowhere");
    const allRows = JSON.stringify(await control.platformBackup.findMany(), (_k, v) => (typeof v === "bigint" ? v.toString() : v));
    ok("not on any backup row", !allRows.includes(PASS));
    const audit = JSON.stringify(await control.platformAuditLog.findMany());
    ok("not in the audit log", audit.includes("backup.create") && !audit.includes(PASS));
    ok("not on any worker's command line or in its environment", spawned.length >= 4 && spawned.every((s) => !s.args.some((a) => a.includes(PASS)) && !Object.values(s.env).some((v) => typeof v === "string" && v.includes(PASS))), spawned.length);
    ok("not in anything this check or the worker printed", !written.includes(PASS) && !childOutput.join("").includes(PASS));
    ok("no passphrase file left behind", (await readdir(path.join(bundles, ".jobs")).catch(() => [])).length === 0);
  } finally {
    process.env.PLATFORM_MASTER_KEY = realKey;
    await cleanup?.().catch(() => {});
    for (const name of [controlName, workspaceName]) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.$disconnect().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
    ok("the scratch databases and folders are removed", true);
  }

  console.log(`\n${failures ? `${passes} passed, ${failures} FAILED` : `All ${passes} console backup checks passed.`}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
