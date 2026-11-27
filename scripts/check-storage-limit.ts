/**
 * Storage in the plans, as a workspace's people meet it (owner, 20 Nov 2026 — src/lib/storage/quota.ts,
 * src/lib/file-refusal.ts, src/lib/storage-view.ts):
 *
 *   1. At the limit, each kind of upload answers its own "no" — an action's { ok: false, error }, a route's 413 (the
 *      phone's recordings a 507, so the app keeps the file and sends it later) — in the storage message, and leaves
 *      nothing half saved: no row, nothing counted. HR documents, task files, chat files, profile photos, expense
 *      receipts (and the same claim sent again once there is room), the email builder's pictures, custom-field files,
 *      call recordings; and the background ones: a helpdesk email still received without its files, a Zoho PDF left
 *      to fetch later, a WhatsApp photo shown but not kept, a visitor signed in without their photo.
 *   2. Under the limit, every one of them still saves, and is counted.
 *   3. What an administrator is shown: Settings › Billing's storage data and card, and the banner's notice, at 50%, 85%
 *      and 100% — the notice read once a minute at most — and how to add storage: the plan form when Extra storage has
 *      a price, "Ask Deskzo" when it hasn't.
 *
 * On a scratch control plane and a scratch workspace database, both built from their migrations and dropped after.
 *
 *   npm run check:storage-limit
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";
import { renderHtml } from "./lib/render-html";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}

// ─── Who is calling, and the bits of Next a script doesn't have ─────────────────────────────────

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
let deviceId = "";
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const requestHeaders = new Headers({ host: "deskzo.localhost:3000", "user-agent": "check:storage-limit" });
const nextHeaders = { headers: async () => requestHeaders, cookies: async () => ({ get: () => undefined, getAll: () => [], has: () => false, set() {}, delete() {} }) };
/**
 * The phone app's wrapper (src/lib/app/handler.ts) signs a paired phone in; here the route's own body runs as the
 * caller on its phone, its ApiError answered in the app's shape ({ error: { code, message } }).
 */
const appHandler = {
  appRoute: (_options: unknown, handler: (call: { actor: { userId: string }; device: { id: string }; params: Record<string, string>; req: Request }) => Promise<{ status?: number; data?: unknown }>) =>
    async (req: Request, context?: { params: Promise<Record<string, string>> }) => {
      /* eslint-disable-next-line @typescript-eslint/no-require-imports */
      const { ApiError } = require("../src/lib/api/handler") as typeof import("../src/lib/api/handler");
      try {
        const out = await handler({ actor: { userId: actor!.id }, device: { id: deviceId }, params: (await context?.params) ?? {}, req });
        return Response.json({ data: out.data ?? null }, { status: out.status ?? 200 });
      } catch (err) {
        if (err instanceof ApiError) return Response.json({ error: { code: err.code, message: err.message } }, { status: err.status });
        throw err;
      }
    },
};
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/headers", nextHeaders],
  ["@/lib/session", session],
  ["@/lib/app/handler", appHandler],
  ["@/lib/email", { sendEmailNotification: async () => {} }],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/headers"), nextHeaders],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/app/handler"), appHandler],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

// ─── Files ───────────────────────────────────────────────────────────────────────────────────────

const MB = 1024 * 1024;
/** Four red pixels, a real PNG (sharp reads it, as the email builder's upload does). */
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAIAAAAmkwkpAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAEUlEQVQImWP4z8AARwgWXg4ArpMP8bh5W0YAAAAASUVORK5CYII=", "base64");
const PNG_URL = `data:image/png;base64,${PNG.toString("base64")}`;
/** What a kiosk's camera sends: a JPEG, checked only by its first bytes. */
const JPEG = Buffer.from("ffd8ffe000104a46494600010100000100010000ffd9", "hex");
const JPEG_URL = `data:image/jpeg;base64,${JPEG.toString("base64")}`;
const pdf = (tag: string) => Buffer.from(`%PDF-1.4 zz ${tag}\n%%EOF\n`, "latin1");
const pdfUrl = (tag: string) => `data:application/pdf;base64,${pdf(tag).toString("base64")}`;
/** An m4a as recorders write it: its "ftyp" box at byte 4. */
const M4A = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypM4A "), Buffer.from("zz audio ".repeat(200))]);
const STORAGE_WORDS = /storage is full \([\d.]+ MB of 1\.0 MB used\), so this file can't be saved\. An administrator can add storage in Settings › Billing\./;

/** What a call answered, or what it threw. */
async function outcome<T>(fn: () => Promise<T>): Promise<{ value: T } | { threw: string }> {
  try {
    return { value: await fn() };
  } catch (err) {
    return { threw: err instanceof Error ? `${err.name}: ${err.message}` : String(err) };
  }
}
const refusal = (o: { value: unknown } | { threw: string }): string | null => {
  if ("threw" in o) return null;
  const v = o.value as { ok?: boolean; error?: string } | null;
  return v && v.ok === false && typeof v.error === "string" ? v.error : null;
};
const shown = (o: { value: unknown } | { threw: string }) => ("threw" in o ? `THREW ${o.threw}` : JSON.stringify(o.value)?.slice(0, 200));

async function walk(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await walk(full)));
    else out.push(full);
  }
  return out;
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host)) throw new Error("not a local database");
  const realName = new URL(url).pathname.slice(1);

  section("A scratch control plane and workspace");
  const controlName = `${realName}_storagelimit_control`;
  const workspaceName = `${realName}_storagelimit_ws`;
  const controlUrl = withDatabase(url, controlName);
  const workspaceUrl = withDatabase(url, workspaceName);
  const admin = directClient(withDatabase(url, "postgres"));
  const box = await mkdtemp(path.join(os.tmpdir(), "deskzo-limit-box-"));
  const recordingsDir = await mkdtemp(path.join(os.tmpdir(), "deskzo-limit-rec-"));
  let cleanup: (() => Promise<void>) | null = null;
  try {
    for (const name of [controlName, workspaceName]) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    }
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: workspaceUrl }, timeout: 10 * 60_000 });
    process.env.CONTROL_DATABASE_URL = controlUrl;
    process.env.DATABASE_URL = workspaceUrl;
    for (const k of ["STORAGE_AZURE_CONNECTION_STRING", "STORAGE_AZURE_CONTAINER", "STORAGE_AZURE_CONTAINER_URL", "STORAGE_AZURE_SAS", "STORAGE_PREFIX", "RECORDINGS_AZURE_CONTAINER_URL", "RECORDINGS_AZURE_SAS"]) delete process.env[k];
    process.env.STORAGE_DIR = box;
    process.env.RECORDINGS_DIR = recordingsDir;
    ok("both built from their migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const plans = require("../src/lib/platform/plans") as typeof import("../src/lib/platform/plans");
    const { ADD_ON_PLAN_KEYS } = require("../src/lib/platform/product-plans") as typeof import("../src/lib/platform/product-plans");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const rules = require("../src/lib/entitlements") as typeof import("../src/lib/entitlements");
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    const files = require("../src/lib/storage/files") as typeof import("../src/lib/storage/files");
    const view = require("../src/lib/storage-view") as typeof import("../src/lib/storage-view");
    const billing = require("../src/actions/billing") as typeof import("../src/actions/billing");
    const { StorageCard } = require("../src/components/settings/storage-card") as typeof import("../src/components/settings/storage-card");
    const docs = require("../src/actions/employee-docs") as typeof import("../src/actions/employee-docs");
    const tasks = require("../src/actions/task") as typeof import("../src/actions/task");
    const taskExtras = require("../src/actions/task-extras") as typeof import("../src/actions/task-extras");
    const chat = require("../src/actions/chat") as typeof import("../src/actions/chat");
    const photos = require("../src/actions/user-photo") as typeof import("../src/actions/user-photo");
    const expenses = require("../src/actions/expense") as typeof import("../src/actions/expense");
    const assetUpload = require("../src/app/api/marketing/assets/upload/route") as typeof import("../src/app/api/marketing/assets/upload/route");
    const fieldUpload = require("../src/app/api/custom-fields/files/route") as typeof import("../src/app/api/custom-fields/files/route");
    const recordingUpload = require("../src/app/api/app/calls/[id]/recording/route") as typeof import("../src/app/api/app/calls/[id]/recording/route");
    const { receiveEmail } = require("../src/lib/support-mail/receive") as typeof import("../src/lib/support-mail/receive");
    const pull = require("../src/lib/zoho/pull") as typeof import("../src/lib/zoho/pull");
    const inbox = require("../src/lib/inbox/server") as typeof import("../src/lib/inbox/server");
    const whatsapp = require("../src/lib/inbox/whatsapp") as typeof import("../src/lib/inbox/whatsapp");
    const { defaultChannelSettings } = require("../src/lib/inbox/settings") as typeof import("../src/lib/inbox/settings");
    const visitors = require("../src/actions/visitor") as typeof import("../src/actions/visitor");
    const visitorPublic = require("../src/actions/visitor-public") as typeof import("../src/actions/visitor-public");
    const { openMigration } = require("../src/lib/migration/state") as typeof import("../src/lib/migration/state");
    /* eslint-enable @typescript-eslint/no-require-imports */
    type Tenant = import("../src/lib/tenancy/state").Tenant;
    cleanup = async () => {
      whatsapp.setTestWhatsAppSender(null);
      whatsapp.setTestWhatsAppRead(null);
      whatsapp.setTestWhatsAppMedia(null);
      await db.$disconnect();
      await closeControlDb();
    };
    const control = controlDb();

    // A workspace of every module with 1 MB of storage — a staff override, as the console sets one.
    const id = randomUUID();
    const keyBundleCipher = keys.sealKeyBundle(id, keys.newKeyBundle());
    await control.tenant.create({
      data: { id, slug: "zzlimit", name: "Zz Limit", status: "ACTIVE", keyBundleCipher, country: "IN", currency: "INR", ownerEmail: "owner@zzlimit.example", timezone: "Asia/Kolkata" },
    });
    const envTenant = await registry.legacyTenant();
    if (!envTenant) throw new Error("No local workspace to stand the scratch one on.");
    const T = {
      ...envTenant,
      id,
      slug: "zzlimit",
      name: "Zz Limit",
      country: "IN",
      dbUrl: workspaceUrl,
      keyBundleCipher,
      entitlements: rules.parseEntitlements({ v: 1, all: true, modules: [], seats: null, copilotTokens: null, customDomains: 0, storageMb: 1, plans: [] }),
      source: "control",
      isDefault: false,
    } as Tenant;
    ok("the workspace's limit is 1 MB", T.entitlements.storageMb === 1, T.entitlements.storageMb);
    const inWs = <R,>(fn: () => Promise<R>) => runAsTenant(T, fn);
    const used = async () => Number((await control.tenant.findUniqueOrThrow({ where: { id }, select: { storageUsedBytes: true } })).storageUsedBytes);
    const setUsed = (bytes: number) => control.tenant.update({ where: { id }, data: { storageUsedBytes: BigInt(bytes) }, select: { id: true } });
    const full = () => setUsed(MB);
    const empty = () => setUsed(0);

    // People and the things the files hang off.
    const person = (key: string, extra: Record<string, unknown> = {}) =>
      inWs(() => db.user.create({ data: { name: `Zz ${key}`, email: `${key}@zz-storagelimit.in`, passwordHash: "!", role: "ADMIN", ...extra }, select: { id: true, name: true, email: true, role: true } }));
    const boss = await person("boss", { isSuperAdmin: true });
    const colleague = await person("colleague");
    actor = boss;
    const taskMade = await inWs(() => tasks.createTask({ title: "Zz limit task" }));
    if (!taskMade.ok) throw new Error(taskMade.error);
    const direct = await inWs(() => chat.startDirectChat(colleague.id));
    if (!direct.ok) throw new Error(direct.error);
    await inWs(() => db.customFieldDefinition.create({ data: { entity: "ORDER", key: "certificate", label: "Certificate", type: "FILE", createdById: boss.id } as never }));
    const company = await inWs(() => db.company.create({ data: { name: "Zz Limit Co", normalizedName: "zz limit co", createdById: boss.id } as never, select: { id: true } }));
    const device = await inWs(() => db.userDevice.create({ data: { userId: boss.id, kind: "MOBILE", status: "APPROVED", label: "Zz phone", tokenHash: `zz-limit-${Date.now()}` } as never, select: { id: true } }));
    const phone = await inWs(() => db.appDevice.create({ data: { userId: boss.id, deviceId: device.id, platform: "android", model: "Zz" } as never, select: { id: true } }));
    deviceId = phone.id;
    const phoneCall = (key: string) =>
      inWs(() => db.callLog.create({ data: { companyId: company.id, userId: boss.id, phoneNumber: "+919800000001", direction: "OUTBOUND", outcome: "CONNECTED", durationSeconds: 60, startedAt: new Date(), source: "PHONE", appDeviceId: phone.id, phoneCallKey: `zz-limit-${key}`, notes: "Zz" } as never, select: { id: true } }));
    await inWs(() => db.callRecordingSettings.upsert({ where: { id: "default" }, create: { id: "default", enabled: true, retentionDays: 90 }, update: { enabled: true, retentionDays: 90 } }));
    const migration = await inWs(() => db.migration.create({ data: { source: "zoho-books", yearStart: new Date("2026-04-01"), switchDate: new Date("2026-07-01"), createdById: boss.id } as never, select: { id: true } }));
    const archived = (n: string) =>
      inWs(() => db.archivedDocument.create({ data: { migrationId: migration.id, kind: "INVOICE", key: `INVOICE:zz:${n}`, number: n, date: new Date("2025-02-01"), year: "2024-25", partyName: "Zz Docs Co", total: 590, companyId: company.id, oldId: `OLD-${n}` } as never, select: { id: true } }));
    await inWs(() => db.inboxChannel.create({ data: { kind: "WHATSAPP", name: "Zz wa", phoneNumberId: "990000000977", settings: { ...defaultChannelSettings("WHATSAPP"), autoLead: false } as object, createdById: boss.id } }));
    whatsapp.setTestWhatsAppSender(async () => ({ ok: true, id: `wamid.zzsent${Date.now()}` }));
    whatsapp.setTestWhatsAppRead(async () => true);
    const waBytes = Buffer.concat([JPEG, Buffer.from("zz-whatsapp-photo")]);
    whatsapp.setTestWhatsAppMedia(async () => ({ ok: true, bytes: waBytes, mime: "image/jpeg" }));
    const kioskMade = await inWs(() => visitors.saveKiosk({ name: "Zz reception" }));
    if (!kioskMade.ok) throw new Error(kioskMade.error);
    const kioskToken = (await inWs(() => visitors.listKiosks()))?.find((k) => k.id === kioskMade.data.id)?.token ?? "";

    // ─── Each writer, as a person would call it ────────────────────────────────────────────────────
    const appOrigin = { origin: "http://deskzo.localhost:3000", host: "deskzo.localhost:3000" };
    const writers = {
      hr: (tag: string) => inWs(() => docs.uploadEmployeeDocument({ userId: boss.id, type: "PAN_CARD", name: `Zz ${tag}.pdf`, fileDataUrl: pdfUrl(tag), mimeType: "application/pdf" })),
      task: (tag: string) =>
        inWs(() => {
          const form = new FormData();
          form.set("taskId", taskMade.data.id);
          form.set("file", new File([Buffer.from(`timings ${tag}`)], "timings.txt", { type: "text/plain" }));
          return taskExtras.uploadTaskFile(form);
        }),
      chat: (tag: string) =>
        inWs(() => {
          const form = new FormData();
          form.set("chatId", direct.data.chatId);
          form.set("body", `Zz ${tag}`);
          form.append("files", new File([PNG], "pixel.png", { type: "image/png" }));
          form.append("files", new File([pdf(tag)], "note.pdf", { type: "application/pdf" }));
          return chat.sendChatMessage(form);
        }),
      photo: () => inWs(() => photos.setProfilePhoto(PNG_URL)),
      expense: () =>
        inWs(() => expenses.createExpense({ category: "TRAVEL", amount: 250, spentOn: "2026-11-02", description: "Zz cab to the client", paymentMode: "CASH", reimbursable: true, receiptDataUrl: PNG_URL, receiptName: "receipt.png", submit: false })),
      asset: () =>
        inWs(async () => {
          const form = new FormData();
          form.set("file", new File([PNG], "hero.png", { type: "image/png" }));
          const res = await assetUpload.POST(new Request("http://deskzo.localhost:3000/api/marketing/assets/upload", { method: "POST", headers: appOrigin, body: form }));
          return { status: res.status, json: (await res.json()) as { ok: boolean; error?: string; url?: string } };
        }),
      field: (tag: string) =>
        inWs(async () => {
          const form = new FormData();
          form.set("field", "certificate");
          form.set("file", new File([pdf(tag)], `${tag}.pdf`, { type: "application/pdf" }));
          const res = await fieldUpload.POST(new Request("http://deskzo.localhost:3000/api/custom-fields/files", { method: "POST", headers: appOrigin, body: form }));
          return { status: res.status, json: (await res.json()) as { ok: boolean; error?: string; value?: string } };
        }),
      recording: (callId: string) =>
        inWs(async () => {
          const res = await recordingUpload.POST(new Request(`http://x/api/app/calls/${callId}/recording`, { method: "POST", headers: { "x-file-name": "Call_zz.m4a" }, body: M4A }), { params: Promise.resolve({ id: callId }) });
          return { status: res.status, json: (await res.json()) as { data?: { id: string }; error?: { code: string; message: string } } };
        }),
    };
    const counts = () =>
      inWs(async () => ({
        hr: await db.employeeDocument.count(),
        task: await db.taskAttachment.count(),
        chatMessages: await db.chatMessage.count({ where: { chatId: direct.data.chatId } }),
        chatFiles: await db.chatAttachment.count(),
        photo: await db.userPhoto.count(),
        expense: await db.expense.count(),
        asset: await db.marketingAsset.count(),
        field: await db.customFieldFile.count(),
        recording: await db.callRecording.count(),
      }));

    // ─── 1. At the limit ───────────────────────────────────────────────────────────────────────────
    section("1. At the limit: each upload's own refusal, in the storage message, nothing half saved");
    await full();
    const before = await counts();
    const boxBefore = (await walk(box)).length;
    const recordingsBefore = (await walk(recordingsDir)).length;

    const hrFull = await outcome(() => writers.hr("full"));
    ok("an HR document: { ok: false } with the storage message", STORAGE_WORDS.test(refusal(hrFull) ?? ""), shown(hrFull));
    const taskFull = await outcome(() => writers.task("full"));
    ok("a task file: { ok: false } with the storage message", STORAGE_WORDS.test(refusal(taskFull) ?? ""), shown(taskFull));
    const chatFull = await outcome(() => writers.chat("full"));
    ok("a chat message with files: { ok: false } with the storage message", STORAGE_WORDS.test(refusal(chatFull) ?? ""), shown(chatFull));
    const photoFull = await outcome(() => writers.photo());
    ok("a profile photo: { ok: false } with the storage message", STORAGE_WORDS.test(refusal(photoFull) ?? ""), shown(photoFull));
    const expenseFull = await outcome(() => writers.expense());
    ok("an expense with its receipt: { ok: false } with the storage message", STORAGE_WORDS.test(refusal(expenseFull) ?? ""), shown(expenseFull));
    const assetFull = await outcome(() => writers.asset());
    ok("the email builder's picture: a 413, the storage message as its error", "value" in assetFull && assetFull.value.status === 413 && !assetFull.value.json.ok && STORAGE_WORDS.test(assetFull.value.json.error ?? ""), shown(assetFull));
    const fieldFull = await outcome(() => writers.field("full"));
    ok("a custom field's file: a 413, the storage message as its error", "value" in fieldFull && fieldFull.value.status === 413 && !fieldFull.value.json.ok && STORAGE_WORDS.test(fieldFull.value.json.error ?? ""), shown(fieldFull));
    const callFull = await phoneCall("full");
    const recordingFull = await outcome(() => writers.recording(callFull.id));
    ok(
      "a call recording from the app: a 507 storage_full, in the app's error shape, with the storage message",
      "value" in recordingFull && recordingFull.value.status === 507 && recordingFull.value.json.error?.code === "storage_full" && STORAGE_WORDS.test(recordingFull.value.json.error.message),
      shown(recordingFull),
    );

    const after = await counts();
    ok("no row was written for any of them", JSON.stringify(after) === JSON.stringify(before), { before, after });
    ok("  nothing went into the storage box", (await walk(box)).length === boxBefore);
    ok("  no recording was kept in the recordings store", (await walk(recordingsDir)).length === recordingsBefore);
    ok("  and nothing was counted", (await used()) === MB, await used());

    section("1b. At the limit, in the background: the job carries on, nothing half kept");
    const mail = (tag: string) =>
      inWs(() =>
        receiveEmail({
          from: null,
          to: ["help@zz.example"],
          cc: [],
          subject: `Zz ${tag}`,
          text: "Please see the attached.",
          messageId: `<zz-${tag}-${Date.now()}@zz.example>`,
          inReplyTo: null,
          references: [],
          automated: null,
          attachments: [{ fileName: `statement-${tag}.pdf`, mimeType: "application/pdf", sizeBytes: pdf(tag).length, dataUrl: pdfUrl(tag) }],
          senderVerified: false,
          senderCheck: "none",
        }),
      );
    const mailFull = await outcome(() => mail("full"));
    const mailRow = "value" in mailFull && mailFull.value.emailId ? await inWs(() => db.supportEmail.findUnique({ where: { id: mailFull.value.emailId! }, select: { body: true, _count: { select: { attachments: true } } } })) : null;
    ok("a helpdesk email is still received", !!mailRow, shown(mailFull));
    ok("  without the file there was no room for, and says so", mailRow?._count.attachments === 0 && /Not kept, the workspace's storage is full: statement-full\.pdf/.test(mailRow.body), mailRow?.body.slice(-120));

    const docFull = await archived("ZZ-FULL");
    // The pull's PDF step, as the heartbeat works it: at the limit it waits, without a call to Zoho.
    const openM = await inWs(() => openMigration());
    const zohoPull = await inWs(() => db.zohoPull.create({ data: { migrationId: migration.id, startedById: boss.id, status: "PDFS", progress: {} } as never, select: { id: true } }));
    const realFetch = globalThis.fetch;
    const zohoCalls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      zohoCalls.push(String(input instanceof Request ? input.url : input));
      throw new Error("check:storage-limit calls nobody");
    }) as typeof fetch;
    const stepped = openM ? await outcome(() => inWs(() => pull.pullStep(openM, zohoPull.id, boss.id, 1000))) : { threw: "no open migration" };
    globalThis.fetch = realFetch;
    ok(
      "the Zoho pull's PDFs wait for room — no call to Zoho spent, the pull not stopped, saying why",
      "value" in stepped && stepped.value.status === "WAITING" && /storage is full, with 1 earlier-year PDFs still to fetch/.test(stepped.value.progress.note ?? "") && zohoCalls.length === 0 && stepped.value.callsToday === 0,
      "value" in stepped ? { status: stepped.value.status, note: stepped.value.progress.note, calls: zohoCalls } : stepped,
    );
    const pdfKept = await outcome(() => inWs(() => pull.keepArchivedPdf(docFull.id, pdf("zoho-full"))));
    const docFullFile = await inWs(() => db.archivedDocumentFile.findUnique({ where: { documentId: docFull.id } }));
    ok("a Zoho PDF: not kept, no row — the document still waits for its PDF, and the pull isn't stopped", "value" in pdfKept && pdfKept.value === false && docFullFile === null, shown(pdfKept));

    const waId = `wamid.zzlimit${Date.now()}`;
    await inWs(() => inbox.receiveWhatsApp({ phoneNumberId: "990000000977", from: "919900000977", profileName: "Zz Wa", id: waId, at: new Date(), text: "[Photo]", media: { id: "zz-media-limit", mime: "image/jpeg", name: null } }));
    const waMessage = await inWs(() => db.conversationMessage.findFirst({ where: { externalId: waId } }));
    const viewer = { id: boss.id, viewAll: true };
    const waOpened = waMessage ? await outcome(() => inWs(() => inbox.conversationFile(viewer, waMessage.id))) : null;
    const waRow = waMessage ? await inWs(() => db.conversationFile.findUnique({ where: { messageId: waMessage.id } })) : null;
    ok("a WhatsApp photo: shown when opened, but not kept", !!waOpened && "value" in waOpened && waOpened.value.ok && waOpened.value.bytes.equals(waBytes) && waRow === null, waOpened ? shown(waOpened) : "no message");

    const signIn = await outcome(() => inWs(() => visitorPublic.checkIn({ token: kioskToken, purpose: "MEETING", hostUserId: colleague.id, name: "Zz Visitor full", phone: "98765 43210", company: "Zz Acme Ltd", email: "full@acme.example", photoDataUrl: JPEG_URL })));
    const visitor = await inWs(() => db.visitorEntry.findFirst({ where: { name: "Zz Visitor full" } }));
    ok("a visitor at the desk is signed in without their photo, the entry saying why", "value" in signIn && signIn.value.ok && !!visitor && visitor.photoDataUrl === null && /storage is full/.test(visitor.note ?? ""), shown(signIn));
    ok("still nothing counted", (await used()) === MB, await used());

    // ─── 2. Under the limit ────────────────────────────────────────────────────────────────────────
    section("2. Under the limit: each saves, and is counted");
    await empty();
    const hrRoom = await outcome(() => writers.hr("room"));
    ok("an HR document is saved", "value" in hrRoom && hrRoom.value.ok, shown(hrRoom));
    const taskRoom = await outcome(() => writers.task("room"));
    ok("a task file is saved", "value" in taskRoom && taskRoom.value.ok, shown(taskRoom));
    const chatRoom = await outcome(() => writers.chat("room"));
    ok("a chat message with its files is sent", "value" in chatRoom && chatRoom.value.ok, shown(chatRoom));
    const photoRoom = await outcome(() => writers.photo());
    ok("a profile photo is saved", "value" in photoRoom && photoRoom.value.ok, shown(photoRoom));
    const expenseRoom = await outcome(() => writers.expense());
    ok("the same expense claim, sent again once there is room, is saved (the refused one held nothing back)", "value" in expenseRoom && expenseRoom.value.ok, shown(expenseRoom));
    const assetRoom = await outcome(() => writers.asset());
    ok("the email builder's picture is saved", "value" in assetRoom && assetRoom.value.status === 200 && assetRoom.value.json.ok, shown(assetRoom));
    const fieldRoom = await outcome(() => writers.field("room"));
    ok("a custom field's file is saved", "value" in fieldRoom && fieldRoom.value.status === 200 && fieldRoom.value.json.ok, shown(fieldRoom));
    const recordingRoom = await outcome(() => writers.recording(callFull.id));
    ok("the recording the app kept is accepted when sent again", "value" in recordingRoom && recordingRoom.value.status === 201 && !!recordingRoom.value.json.data?.id, shown(recordingRoom));
    const room = await counts();
    ok(
      "one row each",
      room.hr === before.hr + 1 && room.task === before.task + 1 && room.chatMessages === before.chatMessages + 1 && room.chatFiles === before.chatFiles + 2 && room.photo === before.photo + 1 && room.expense === before.expense + 1 && room.asset === before.asset + 1 && room.field === before.field + 1 && room.recording === before.recording + 1,
      { before, room },
    );
    const savedRecording = await inWs(() => db.callRecording.findUnique({ where: { callLogId: callFull.id }, select: { sizeBytes: true } }));
    const counted = await used();
    ok("  and each counted against the workspace — the recording too", counted > M4A.length && savedRecording?.sizeBytes === M4A.length, counted);
    const mailRoom = await outcome(() => mail("room"));
    const mailRoomRow = "value" in mailRoom && mailRoom.value.emailId ? await inWs(() => db.supportEmail.findUnique({ where: { id: mailRoom.value.emailId! }, select: { body: true, _count: { select: { attachments: true } } } })) : null;
    ok("a helpdesk email keeps its file", mailRoomRow?._count.attachments === 1 && !/Not kept/.test(mailRoomRow.body), shown(mailRoom));
    const pdfRoom = await outcome(() => inWs(() => pull.keepArchivedPdf(docFull.id, pdf("zoho-room"))));
    ok("the waiting Zoho PDF is kept", "value" in pdfRoom && pdfRoom.value === true && !!(await inWs(() => db.archivedDocumentFile.findUnique({ where: { documentId: docFull.id } }))), shown(pdfRoom));
    const waAgain = waMessage ? await outcome(() => inWs(() => inbox.conversationFile(viewer, waMessage.id))) : null;
    ok("the WhatsApp photo is kept the next time it's opened", !!waAgain && "value" in waAgain && waAgain.value.ok && !!(await inWs(() => db.conversationFile.findUnique({ where: { messageId: waMessage!.id } }))));
    const signInRoom = await outcome(() => inWs(() => visitorPublic.checkIn({ token: kioskToken, purpose: "MEETING", hostUserId: colleague.id, name: "Zz Visitor room", phone: "98765 43211", company: "Zz Acme Ltd", email: "room@acme.example", photoDataUrl: JPEG_URL })));
    const visitorRoom = await inWs(() => db.visitorEntry.findFirst({ where: { name: "Zz Visitor room" } }));
    ok("a visitor's photo is kept", "value" in signInRoom && signInRoom.value.ok && files.isStoredRef(visitorRoom?.photoDataUrl) && !/storage/.test(visitorRoom?.note ?? ""), shown(signInRoom));

    // ─── 3. What administrators are shown ──────────────────────────────────────────────────────────
    section("3. Settings › Billing and the banner, at 50%, 85% and 100%");
    await inWs(() => db.user.update({ where: { id: boss.id }, data: { kind: "MEMBER" } as never }));
    await control.tenant.update({ where: { id }, data: { storageMeasuredAt: new Date(), storageBreakdown: { "employee-documents": 300 * 1024, "user-photos": 100 * 1024, recordings: 50 * 1024, "something-new": 10 } } });
    const billingAt = async (share: number) => {
      await setUsed(Math.round(MB * share));
      return inWs(() => billing.getBilling());
    };
    const half = await billingAt(0.5);
    ok("the billing page reads the workspace's storage: 512 KB of 1 MB, 50%", half?.storage?.usedBytes === MB / 2 && half.storage.limitBytes === MB && half.storage.percent === 50, half?.storage);
    ok("  when it was measured", !!half?.storage?.measuredAt);
    ok(
      "  by kind in plain words, largest first, a kind without words as Other files",
      JSON.stringify(half?.storage?.breakdown.map((r) => r.label)) === JSON.stringify(["HR documents", "Profile photos", "Call recordings", "Other files"]),
      half?.storage?.breakdown,
    );
    ok("  no warning at 50%", half?.storage?.notice === null);
    // Read as if five minutes ago, so the banner's minute-long memory of it has run out before the 85% read below.
    const halfBanner = await inWs(() => view.workspaceStorageNotice(T, Date.now() - 5 * 60_000));
    ok("  and no banner", halfBanner === null, halfBanner);
    ok("Extra storage with no price yet: \"Ask Deskzo to add storage\", not a button", view.storageBuy({ limited: true, onSale: half?.storage?.pack.onSale ?? true, mayBuy: true, changeFrom: null, byTransfer: false })?.kind === "ask" && half?.storage?.pack.planKey === ADD_ON_PLAN_KEYS.storage);
    const halfHtml = half?.storage ? await renderHtml(StorageCard({ storage: half.storage, buy: view.storageBuy({ limited: true, onSale: half.storage.pack.onSale, mayBuy: true, changeFrom: null, byTransfer: false }), price: null, measuredAt: "20 Nov 2026, 2:00 am" })) : "";
    ok("  the card says so", halfHtml.includes("Ask Deskzo to add storage") && !halfHtml.includes("?add=storage") && halfHtml.includes("0.5 MB") && halfHtml.includes("1.0 MB") && halfHtml.includes("HR documents"), halfHtml.slice(0, 300));

    const most = await billingAt(0.85);
    ok("at 85%: the page warns", most?.storage?.percent === 85 && most.storage.notice?.tone === "warning" && /^Storage is 85% full \(0\.9 MB of 1\.0 MB used\)/.test(most.storage.notice.text), most?.storage?.notice);
    const mostNotices = await inWs(() => billing.workspaceNotices());
    ok("  and so does the banner, to whoever manages billing", mostNotices.storage?.tone === "warning" && /^Storage is 85% full/.test(mostNotices.storage.text), mostNotices.storage);
    actor = colleague;
    const colleagueNotices = await inWs(() => billing.workspaceNotices());
    ok("  nobody else sees it", colleagueNotices.storage === null && colleagueNotices.billing === null, colleagueNotices);
    actor = boss;

    const fullView = await billingAt(1);
    ok("at 100%: the page says it is full and new files can't be saved", fullView?.storage?.percent === 100 && fullView.storage.notice?.tone === "danger" && /^Storage is full — new files can't be saved/.test(fullView.storage.notice.text), fullView?.storage?.notice);
    const cached = await inWs(() => billing.workspaceNotices());
    ok("the banner reads the control plane at most once a minute: still 85% just after", /^Storage is 85% full/.test(cached.storage?.text ?? ""), cached.storage);
    const fresh = await inWs(() => view.workspaceStorageNotice(T, Date.now() + 61_000));
    ok("  a minute on, full", fresh?.tone === "danger" && /^Storage is full — new files can't be saved/.test(fresh.text), fresh);
    await setUsed(MB / 2);
    const later = await inWs(() => view.workspaceStorageNotice(T, Date.now() + 122_000));
    ok("  and gone again once storage is back under 80%", later === null, later);
    await setUsed(MB);

    // Extra storage on sale: the card's button opens this page's plan form with a pack in it.
    await plans.savePlan({ kind: "ADDON", key: ADD_ON_PLAN_KEYS.storage, name: "Extra storage", countries: [], seats: null, copilotTokens: null, modules: [], storageMb: 10240 }, "script:check");
    const pack = await control.plan.findUniqueOrThrow({ where: { key: ADD_ON_PLAN_KEYS.storage }, select: { id: true } });
    await control.planPrice.create({ data: { planId: pack.id, currency: "INR", interval: "MONTH", amount: 49900, perSeat: false, active: true } as never });
    const onSale = await inWs(() => billing.getBilling());
    ok("with a price, Extra storage is on sale here: 10 GB a pack", onSale?.storage?.pack.onSale === true && onSale.storage.pack.mbEach === 10240, onSale?.storage?.pack);
    const paying = (onSale?.subscriptions ?? []).some((s) => s.gateway !== "MANUAL");
    const buy = view.storageBuy({ limited: true, onSale: onSale?.storage?.pack.onSale ?? false, mayBuy: !paying && onSale?.standing.kind !== "exempt", changeFrom: null, byTransfer: false });
    ok("  bought through the plan form on this page", buy?.kind === "form" && buy.anchor === "choose-plan", buy);
    const saleHtml = onSale?.storage ? await renderHtml(StorageCard({ storage: onSale.storage, buy, price: "₹499.00 a pack a month", measuredAt: null })) : "";
    ok("  the card: \"Add storage\" to it, saying what a pack adds", saleHtml.includes('href="/settings/billing?add=storage#choose-plan"') && saleHtml.includes("Add storage") && saleHtml.includes("10.0 GB a pack for the whole workspace") && saleHtml.includes("Storage is full"), saleHtml.slice(0, 400));
    const started = view.withOneMore(null, ADD_ON_PLAN_KEYS.storage);
    const renewing = view.withOneMore({ interval: "YEAR", items: [{ planKey: "deskzo-one", quantity: 5 }, { planKey: ADD_ON_PLAN_KEYS.storage, quantity: 1 }] }, ADD_ON_PLAN_KEYS.storage);
    ok("  the form starts with one more pack: one to a new plan, a second on top of one", started.items[0]?.quantity === 1 && renewing.interval === "YEAR" && renewing.items.find((i) => i.planKey === ADD_ON_PLAN_KEYS.storage)?.quantity === 2 && renewing.items.find((i) => i.planKey === "deskzo-one")?.quantity === 5);
    ok("  a workspace with no limit is offered nothing", view.storageBuy({ limited: false, onSale: true, mayBuy: true, changeFrom: null, byTransfer: false }) === null);
  } finally {
    await cleanup?.().catch(() => {});
    for (const name of [controlName, workspaceName]) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.$disconnect().catch(() => {});
    await rm(box, { recursive: true, force: true });
    await rm(recordingsDir, { recursive: true, force: true });
    ok("the scratch databases are dropped", true);
  }

  console.log(`\n${failures ? `${passes} passed, ${failures} FAILED` : `All ${passes} storage limit checks passed.`}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
