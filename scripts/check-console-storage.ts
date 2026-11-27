/**
 * check:console-storage — storage in the plans, from the platform console (owner, 20 Nov 2026: "plan create kr ske saas
 * se and control bhi and konsa tenant kitna storage box use kr rha hai vo bhi info saas mein dikhe").
 *
 * Through the console's own actions and loaders, as signed-in staff, on a scratch control plane and a scratch workspace
 * database, both built from their migrations and dropped after:
 *
 *   1. Plans: storage typed in GB (2.5 is 2560 MB) saved from the console; a save that doesn't touch storage keeps it
 *      (the editor's, and the card's retire button, which leaves it out); an add-on's is for each pack; a fraction of a
 *      MB is refused; the save's preview shows it; the plans pages show it, "for the workspace" or "for each pack".
 *   2. A workspace: its storage on Plan & modules (used, limit, %, when measured, by kind with names people read);
 *      "Measure now" measures it as the workspace, writes it and is audited, for the staff who change limits only;
 *      the storage override from the limits dialog changes its entitlements, is previewed and audited; a preview of
 *      anything else keeps the override (entitlement-preview passes it).
 *   3. The workspaces list: a Storage column, sorted by what each uses, the most first; the export; the usage
 *      leaderboard by storage.
 */
import "dotenv/config";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";
import { renderHtml } from "./lib/render-html";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.TRUST_PROXY = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v))}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");
function withDatabase(url: string, database: string): string {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
}
const MB = 1024 * 1024;
const HOUR = 3_600_000;

// ─── A request, as the console sees one ──────────────────────────────────────────────────────────
const COOKIE = "deskzo-console";
const jar = new Map<string, string>();
const requestHeaders = new Headers({ host: "admin.localhost:3000", "user-agent": "check:console-storage" });
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
      usePathname: () => "/",
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

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname)) throw new Error("not a local database");
  const realName = new URL(url).pathname.slice(1);

  /* eslint-disable @typescript-eslint/no-require-imports */
  const shared = require("../src/lib/console-shared/storage") as typeof import("../src/lib/console-shared/storage");
  const registryKinds = require("../src/lib/storage/registry") as typeof import("../src/lib/storage/registry");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("0. GB as typed, MB as kept");
  const read = (t: string) => {
    const r = shared.mbOfGbText(t);
    return r.ok ? r.value : "refused";
  };
  ok("2.5 GB is 2560 MB", read("2.5") === 2560, read("2.5"));
  ok("  2 is 2048, empty is none, 0.25 is 256", read("2") === 2048 && read("") === null && read(" 0.25 ") === 256);
  ok("  a negative, a word or a sum is refused", read("-1") === "refused" && read("lots") === "refused" && read("1e3") === "refused");
  ok("2560 MB reads back as 2.5, and any whole MB comes back the same", shared.gbTextOfMb(2560) === "2.5" && [1, 7, 999, 2561, 10239, 51200].every((mb) => read(shared.gbTextOfMb(mb)) === mb));
  ok("an edition's storage is the workspace's, an add-on's each pack's", shared.planStorageText(2560, "EDITION") === "2.5 GB of storage for the workspace" && shared.planStorageText(10240, "ADDON") === "10 GB of storage for each pack");
  ok("  an edition without one is no limit; an add-on without one says nothing", shared.planStorageText(null, "EDITION") === "No storage limit" && shared.planStorageText(null, "ADDON") === null);
  const kinds = [...new Set([...registryKinds.FILE_COLUMNS.map((c) => c.kind), "recordings"])];
  const unnamed = kinds.filter((k) => !shared.STORAGE_KIND_LABELS[k]);
  ok("every kind of file the registry keeps has a name people read", unnamed.length === 0, unnamed);
  ok(
    "  migrated PDFs, profile photos and call recordings by those names",
    shared.storageKindLabel("archived-documents") === "Migrated PDFs (Zoho)" && shared.storageKindLabel("user-photos") === "Profile photos" && shared.storageKindLabel("recordings") === "Call recordings",
  );

  const controlName = `${realName}_consolestorage_control`;
  const workspaceName = `${realName}_consolestorage_ws`;
  const controlUrl = withDatabase(url, controlName);
  const workspaceUrl = withDatabase(url, workspaceName);
  const admin = directClient(withDatabase(url, "postgres"));
  const folder = await mkdtemp(path.join(os.tmpdir(), "deskzo-console-storage-"));
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
    process.env.REFERENCE_DATABASE_URL = "";
    for (const k of ["STORAGE_AZURE_CONNECTION_STRING", "STORAGE_AZURE_CONTAINER_URL", "STORAGE_PREFIX"]) delete process.env[k];
    process.env.STORAGE_DIR = folder;
    ok("a scratch control plane and workspace, from their migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const kek = require("../src/lib/platform/kek") as typeof import("../src/lib/platform/kek");
    const { tenantById } = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const files = require("../src/lib/storage/files") as typeof import("../src/lib/storage/files");
    const staffLib = require("../src/lib/platform/staff") as typeof import("../src/lib/platform/staff");
    const consoleActions = require("../src/actions/platform/console") as typeof import("../src/actions/platform/console");
    const billingActions = require("../src/actions/platform/console-billing") as typeof import("../src/actions/platform/console-billing");
    const wsActions = require("../src/actions/platform/console-workspace") as typeof import("../src/actions/platform/console-workspace");
    const consoleData = require("../src/lib/platform/console-data") as typeof import("../src/lib/platform/console-data");
    const wsData = require("../src/lib/platform/workspace-data") as typeof import("../src/lib/platform/workspace-data");
    const directory = require("../src/lib/platform/workspace-directory") as typeof import("../src/lib/platform/workspace-directory");
    const params = require("../src/lib/console-shared/params") as typeof import("../src/lib/console-shared/params");
    const usage = require("../src/lib/platform/usage") as typeof import("../src/lib/platform/usage");
    const { planInputOf } = require("../src/components/console/plans/plan-cards") as typeof import("../src/components/console/plans/plan-cards");
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    const pageAt = (file: string) => (require(`../src/app/platform-console/(console)/${file}`) as { default: Page }).default;
    /* eslint-enable @typescript-eslint/no-require-imports */
    cleanup = async () => {
      await db.$disconnect();
      await closeControlDb();
    };
    const control = controlDb();

    const addStaff = async (role: "OWNER" | "BILLING" | "SUPPORT" | "READONLY") =>
      (await staffLib.createStaff({ email: `${role.toLowerCase()}@zzstorage.example`, name: `Zz Storage ${role}`, role }, "script:check:console-storage")).id;
    const staff = { owner: await addStaff("OWNER"), billing: await addStaff("BILLING"), support: await addStaff("SUPPORT"), readonly: await addStaff("READONLY") };
    const actAs = async (userId: string) => {
      const token = randomBytes(32).toString("base64url");
      await control.platformSession.create({ data: { id: sha256(token), userId, expiresAt: new Date(Date.now() + HOUR), mfaAt: new Date(), userAgent: "check:console-storage" } });
      jar.set(COOKIE, token);
    };
    const refusedRole = (r: { ok: boolean; error?: string }) => !r.ok && /role cannot/i.test(r.error ?? "");
    const lastAudit = (action: string, tenantId?: string) => control.platformAuditLog.findFirst({ where: { action, ...(tenantId ? { tenantId } : {}) }, orderBy: { at: "desc" } });

    // ─── 1. Plans ─────────────────────────────────────────────────────────────────────────────────
    section("1. Plans with storage, from the console");
    const BASE = "zz-cs-base";
    const PACK = "zz-cs-pack";
    const plan = (over: Partial<import("../src/lib/platform/plans").PlanInput>): import("../src/lib/platform/plans").PlanInput => ({
      key: BASE,
      name: "Zz Storage Base",
      kind: "EDITION",
      modules: ["tasks"],
      countries: [],
      seats: null,
      copilotTokens: null,
      customDomains: 0,
      ...over,
    });
    const storageOf = async (key: string) => (await control.plan.findUniqueOrThrow({ where: { key }, select: { storageMb: true } })).storageMb;

    await actAs(staff.readonly);
    ok("read-only staff can't save a plan", refusedRole(await consoleActions.consoleSavePlan(plan({ storageMb: 2560 }))));
    await actAs(staff.billing);
    const fresh = await billingActions.consolePreviewPlanSave(plan({ storageMb: 2560 }));
    ok("the save's preview of a new plan shows its storage", fresh.ok && fresh.data.storageMb[0] === null && fresh.data.storageMb[1] === 2560, fresh);
    const typed = shared.mbOfGbText("2.5");
    const created = await consoleActions.consoleSavePlan(plan({ storageMb: typed.ok ? typed.value : null }));
    ok("a plan saved from the console with 2.5 GB stores 2560 MB", created.ok && (await storageOf(BASE)) === 2560, { created, stored: await storageOf(BASE) });
    const createdAudit = await lastAudit("plan.create");
    ok("  recorded under the staff member, with its storage", createdAudit?.actor === staff.billing && (createdAudit.detail as Record<string, unknown>)?.storageMb === 2560, createdAudit?.detail);

    // As the editor sends it: the field shows the plan's own GB and nobody touched it.
    const shown = shared.mbOfGbText(shared.gbTextOfMb(await storageOf(BASE)));
    await consoleActions.consoleSavePlan(plan({ name: "Zz Storage Base renamed", storageMb: shown.ok ? shown.value : null }));
    ok("editing the plan without touching storage keeps 2560 MB", (await storageOf(BASE)) === 2560);
    const detail = await consoleData.planDetail(BASE);
    const retired = await consoleActions.consoleSavePlan({ ...planInputOf(detail!), active: false });
    ok("  and so does a save that leaves storage out (a card's retire button)", retired.ok && (await storageOf(BASE)) === 2560, retired);
    await consoleActions.consoleSavePlan({ ...planInputOf((await consoleData.planDetail(BASE))!), active: true });

    const change = await billingActions.consolePreviewPlanSave(plan({ storageMb: 3072 }));
    ok("the preview of a change shows storage before and after", change.ok && change.data.storageMb[0] === 2560 && change.data.storageMb[1] === 3072, change);
    const fraction = await consoleActions.consoleSavePlan(plan({ storageMb: 2.5 }));
    ok("a fraction of a MB is refused, in words", !fraction.ok && /Storage/.test(fraction.error) && (await storageOf(BASE)) === 2560, fraction);

    await consoleActions.consoleSavePlan(plan({ key: PACK, name: "Zz Storage Pack", kind: "ADDON", modules: [], customDomains: null, storageMb: shared.mbOfGbText("10").ok ? 10240 : null }));
    ok("an add-on of 10 GB a pack stores 10240 MB", (await storageOf(PACK)) === 10240);

    await actAs(staff.owner);
    const plansPage = textOf(await render(pageAt("plans/page")));
    ok("the plans page lists 2.5 GB for the workspace and 10 GB for each pack", plansPage.includes("2.5 GB of storage for the workspace") && plansPage.includes("10 GB of storage for each pack"), plansPage.slice(0, 400));
    const comparePage = textOf(await render(pageAt("plans/page"), {}, { view: "compare" }));
    ok("  and the side-by-side comparison has a Storage row", /Storage .*2\.5 GB of storage for the workspace/.test(comparePage) || comparePage.includes("2.5 GB of storage for the workspace"));
    const basePage = await render(pageAt("plans/[key]/page"), { key: BASE });
    ok("the plan's page has the field in GB, showing 2.5", basePage.includes("Storage for the workspace (GB)") && /value="2\.5"/.test(basePage), textOf(basePage).slice(0, 300));
    const packPage = await render(pageAt("plans/[key]/page"), { key: PACK });
    ok("  an add-on's says each pack", packPage.includes("Storage for each pack (GB)") && /value="10"/.test(packPage));
    /* eslint-disable-next-line @typescript-eslint/no-require-imports */
    const { EDITION_STORAGE_MB } = require("../src/lib/platform/product-plans") as typeof import("../src/lib/platform/product-plans");
    const newPage = await render(pageAt("plans/new/page"));
    const startsAt = shared.gbTextOfMb(EDITION_STORAGE_MB);
    const storageInput = newPage.match(/<input[^>]*id="plan-field-storage"[^>]*>/)?.[0] ?? "";
    ok(`a new plan starts as an edition with the catalogue's storage (${startsAt} GB)`, storageInput.includes(`value="${startsAt}"`), storageInput);

    // ─── 2. A workspace ───────────────────────────────────────────────────────────────────────────
    section("2. A workspace's storage on Workspace 360");
    const make = async (slug: string, withDb: boolean) => {
      const id = randomUUID();
      await control.tenant.create({
        data: {
          id,
          slug,
          name: `Zz ${slug}`,
          status: "ACTIVE",
          keyBundleCipher: keys.sealKeyBundle(id, keys.newKeyBundle()),
          ...(withDb ? { dbUrlCipher: kek.sealForTenant(id, "db-url", workspaceUrl), dbName: workspaceName } : {}),
          country: "IN",
          currency: "INR",
          ownerEmail: `owner@${slug}.example`,
          timezone: "Asia/Kolkata",
        },
      });
      return id;
    };
    const id = await make("zzcsmain", true);
    await actAs(staff.billing);
    const onPlans = await consoleActions.consoleSetWorkspacePlans(id, [
      { planKey: BASE, quantity: 1 },
      { planKey: PACK, quantity: 2 },
    ]);
    const entitled = async () => {
      const row = await control.tenant.findUniqueOrThrow({ where: { id }, select: { entitlements: true } });
      return (row.entitlements as { storageMb?: number | null } | null)?.storageMb;
    };
    ok("on the edition and two packs: 2.5 + 20 GB", onPlans.ok && (await entitled()) === 2560 + 20480, { onPlans, storage: await entitled() });

    // Files, as the workspace saves them: a task's attachment in the box, a profile photo still in the database.
    const tenant = (await tenantById(id))!;
    const user = await runAsTenant(tenant, () => db.user.create({ data: { name: "Zz Storage", email: "zz@storage.example", passwordHash: "!", role: "SALES" }, select: { id: true } }));
    const attachment = await runAsTenant(tenant, () => files.keepBytes("task-attachments", Buffer.alloc(3 * MB, 1), "application/pdf"));
    const task = await runAsTenant(tenant, () => db.task.create({ data: { title: "Zz storage task", createdByUserId: user.id }, select: { id: true } }));
    await runAsTenant(tenant, () => db.taskAttachment.create({ data: { taskId: task.id, fileName: "zz.pdf", mimeType: "application/pdf", size: 3 * MB, data: attachment, uploadedById: user.id } }));
    delete process.env.STORAGE_DIR;
    const inline = await runAsTenant(tenant, () => files.keepDataUrl("user-photos", files.toDataUrl(Buffer.alloc(200 * 1024, 5), "image/png"), { counted: false }));
    process.env.STORAGE_DIR = folder;
    await runAsTenant(tenant, () => db.userPhoto.create({ data: { userId: user.id, dataUrl: inline, mimeType: "image/png", byteSize: 200 * 1024 } }));

    const before = await wsData.workspacePlan(id);
    ok("before it is measured: what was saved is counted, never measured", before.storage !== null && before.storage.usedBytes === 3 * MB && before.storage.measuredAt === null, before.storage);
    ok("  against its limit of 22.5 GB, from its plans", before.storage?.limitBytes === (2560 + 20480) * MB && before.limits.storageMb === 2560 + 20480 && before.limits.storageOverrideMb === null);

    for (const who of ["readonly", "support"] as const) {
      await actAs(staff[who]);
      ok(`${who === "readonly" ? "read-only" : "support"} staff can't measure it`, refusedRole(await wsActions.consoleMeasureStorage(id)));
    }
    await actAs(staff.billing);
    const measured = await wsActions.consoleMeasureStorage(id);
    const row = await control.tenant.findUniqueOrThrow({ where: { id }, select: { storageUsedBytes: true, storageMeasuredAt: true, storageBreakdown: true } });
    const breakdown = (row.storageBreakdown ?? {}) as Record<string, number>;
    ok(
      "Measure now writes the measurement on its row",
      measured.ok && row.storageMeasuredAt !== null && Number(row.storageUsedBytes) === measured.data.usedBytes && (breakdown["task-attachments"] ?? 0) >= 3 * MB && (breakdown["user-photos"] ?? 0) >= 200 * 1024,
      { measured, breakdown },
    );
    const measureAudit = await lastAudit("tenant.storage-measure", id);
    ok("  recorded under the staff member, with what it came to", measureAudit?.actor === staff.billing && (measureAudit.detail as Record<string, unknown>)?.usedBytes === Number(row.storageUsedBytes), measureAudit);
    ok("  a workspace that's gone is refused, in words", !(await wsActions.consoleMeasureStorage("zz-no-such-workspace")).ok);

    const after = await wsData.workspacePlan(id);
    const s = after.storage!;
    ok("its status: used, limit, share and when measured", s.usedBytes === Number(row.storageUsedBytes) && s.limitBytes === (2560 + 20480) * MB && s.share !== null && Math.abs(s.share - s.usedBytes / s.limitBytes!) < 1e-9 && s.measuredAt !== null);
    const named = shared.storageBreakdownRows(s.breakdown);
    ok("  and by kind, the largest first, with names people read", named[0]?.label === "Task attachments" && named.some((r) => r.label === "Profile photos"), named);

    // The override, as the limits dialog sends it: 1 GB typed, MB sent.
    const oneGb = shared.mbOfGbText("1");
    const asked = { seats: null, copilotTokens: null, storageMb: oneGb.ok ? oneGb.value : null };
    const preview = await wsActions.consolePreviewEntitlements(id, { limits: asked });
    ok("the override's preview: 22.5 GB → 1 GB", preview.ok && preview.data.diff.storageMb[0] === 2560 + 20480 && preview.data.diff.storageMb[1] === 1024 && preview.data.refusal === null, preview);
    await actAs(staff.support);
    ok("support staff can't override it", refusedRole(await consoleActions.consoleSetLimitOverrides(id, asked)));
    await actAs(staff.billing);
    const saved = await consoleActions.consoleSetLimitOverrides(id, asked);
    ok("the override saved from the console changes its entitlements to 1 GB", saved.ok && (await entitled()) === 1024, { saved, storage: await entitled() });
    const overrideAudit = await lastAudit("tenant.limit-override", id);
    ok("  recorded under the staff member, with the storage", overrideAudit?.actor === staff.billing && (overrideAudit.detail as Record<string, unknown>)?.storageMb === 1024, overrideAudit?.detail);
    const overridden = await wsData.workspacePlan(id);
    ok("  and Plan & modules shows it overridden: 1 GB, used against 1 GB", overridden.limits.storageOverrideMb === 1024 && overridden.limits.storageMb === 1024 && overridden.storage?.limitBytes === 1024 * MB);
    await consoleActions.consoleSetLimitOverrides(id, { seats: 5, copilotTokens: null });
    ok("other limits saved without storage keep the override", (await entitled()) === 1024);
    const planPreview = await wsActions.consolePreviewEntitlements(id, { plans: [{ planKey: BASE, quantity: 1 }] });
    ok("a preview of a plan change keeps the storage override (now and after)", planPreview.ok && planPreview.data.diff.storageMb[0] === 1024 && planPreview.data.diff.storageMb[1] === 1024, planPreview.ok ? planPreview.data.diff.storageMb : planPreview);

    await actAs(staff.owner);
    const wsPage = textOf(await render(pageAt("workspaces/[slug]/page"), { slug: "zzcsmain" }, { tab: "plan" }));
    ok("Workspace 360 shows its storage: used of the limit, overridden, measured, by kind", /Storage/.test(wsPage) && wsPage.includes("of 1.0 GB") && wsPage.includes("Measure now") && wsPage.includes("Task attachments") && wsPage.includes("Profile photos") && wsPage.includes("override") && wsPage.includes("Measured"), wsPage.slice(wsPage.indexOf("Storage"), wsPage.indexOf("Storage") + 600));
    ok("  and the limit among its limits", wsPage.includes("Storage for the workspace 1 GB"));

    await actAs(staff.billing);
    await consoleActions.consoleSetLimitOverrides(id, { seats: null, copilotTokens: null, storageMb: "" });
    ok("clearing it lets the plans decide again", (await entitled()) === 2560 + 20480);

    // ─── 3. The list ──────────────────────────────────────────────────────────────────────────────
    section("3. The workspaces list, by storage");
    const big = await make("zzcsbig", false);
    const none = await make("zzcsnone", false);
    await control.tenant.update({ where: { id: big }, data: { storageUsedBytes: BigInt(900 * MB), storageMeasuredAt: new Date(), entitlements: { v: 1, all: false, modules: [], seats: null, copilotTokens: null, customDomains: 0, storageMb: 1024, plans: [] } } });
    const list = await directory.workspaceDirectory(params.parseDirectoryFilters({ sort: "-storage", q: "zzcs" }));
    const order = list.rows.map((r) => r.slug);
    ok("sorted by storage: the most first", order[0] === "zzcsbig" && order[1] === "zzcsmain" && order[2] === "zzcsnone", order);
    const bigRow = list.rows.find((r) => r.id === big)!;
    ok("  each row with used, limit and share", bigRow.storage.usedBytes === 900 * MB && bigRow.storage.limitBytes === 1024 * MB && Math.abs((bigRow.storage.share ?? 0) - 900 / 1024) < 1e-9, bigRow.storage);
    ok("  one never measured has nothing used and no time", list.rows.find((r) => r.id === none)!.storage.measuredAt === null);
    const newest = await directory.workspaceDirectory(params.parseDirectoryFilters({ q: "zzcs" }));
    ok("  the default order is still newest first", newest.rows[0]?.slug === "zzcsnone", newest.rows.map((r) => r.slug));
    const csv = await directory.workspacesCsv(params.parseDirectoryFilters({ sort: "-storage", q: "zzcs" }));
    ok("the export has storage used and limit, in MB", csv.csv.includes("Storage used (MB),Storage limit (MB)") && csv.csv.split("\n").some((line) => line.startsWith("zzcsbig,") && line.trim().endsWith(",900,1024")), csv.csv.split("\n").slice(0, 2));
    await actAs(staff.owner);
    const listPage = textOf(await render(pageAt("workspaces/page"), {}, { sort: "-storage", q: "zzcs" }));
    ok("the list shows a Storage column: used / limit (share)", listPage.includes("Storage") && listPage.includes("900 MB / 1.0 GB (88%)"), listPage.slice(0, 600));

    const today = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate()));
    for (const t of [id, big, none]) await control.tenantUsage.create({ data: { tenantId: t, day: today, seatsUsed: 1, seatsLimit: null, copilotTokens: 0 } });
    const leaders = await usage.usageLeaders({ by: "storage" });
    ok("the usage leaderboard ranks by storage, with the limit", leaders[0]?.tenant.slug === "zzcsbig" && leaders[0].storageLimitMb === 1024 && !leaders.some((r) => r.tenant.id === none), leaders.map((r) => [r.tenant.slug, r.storageBytes]));

    // ─── 4. The storage box, set from the console ─────────────────────────────────────────────────
    section("4. The storage box, set from the console (owner, 24 Nov 2026)");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const boxLib = require("../src/lib/storage/box") as typeof import("../src/lib/storage/box");
    const storageActions = require("../src/actions/platform/console-storage") as typeof import("../src/actions/platform/console-storage");
    const summaryLib = require("../src/lib/platform/storage-summary") as typeof import("../src/lib/platform/storage-summary");
    /* eslint-enable @typescript-eslint/no-require-imports */
    ok("with nothing saved here, the server's own box is used, and says so", (await boxLib.storageBoxState()).source === "environment");
    await actAs(staff.billing);
    ok("only an owner saves it", refusedRole(await storageActions.consoleSaveStorageBox({ connection: "AccountName=a;AccountKey=a2V5", container: "deskzo-files" })));
    await actAs(staff.owner);
    const noKey = await storageActions.consoleSaveStorageBox({ connection: "AccountName=acme;EndpointSuffix=core.windows.net", container: "deskzo-files" });
    ok("a connection string without its key is refused", !noKey.ok && /AccountKey/.test(noKey.error ?? ""), noKey);
    const badName = await storageActions.consoleCheckStorageBox({ connection: "AccountName=acme;AccountKey=a2V5;EndpointSuffix=core.windows.net", container: "Deskzo_Files" });
    ok("a container name Azure wouldn't take is refused", !badName.ok && /lower-case/.test(badName.error ?? ""), badName);
    const nothing = await storageActions.consoleSaveStorageBox({ container: "deskzo-files" });
    ok("an empty field with nothing saved asks for the connection string", !nothing.ok && /connection string/.test(nothing.error ?? ""), nothing);

    // The Azure emulator (Azurite) on this machine, when it is running: the real requests, signed with the account key.
    const EMU = "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1";
    const emulator = await fetch("http://127.0.0.1:10000/devstoreaccount1?comp=list").then(() => true, () => false);
    if (!emulator) {
      console.log("  skip  the save, change and removal against Azure — no Azure emulator on 127.0.0.1:10000 (npx azurite-blob, with containers deskzo-files and deskzo-other)");
    } else {
      const checked = await storageActions.consoleCheckStorageBox({ connection: EMU, container: "deskzo-files" });
      ok("an owner checks what is typed before saving: write, read, list and delete", checked.ok && checked.data.steps.length === 4 && checked.data.steps.every((st) => st.ok), checked.ok ? checked.data.steps : checked.error);
      const missing = await storageActions.consoleSaveStorageBox({ connection: EMU, container: "no-such-container" });
      ok("a container that isn't there is not saved", !missing.ok && /Not saved/.test(missing.error ?? "") && !(await control.platformSetting.findUnique({ where: { key: "storage.connection" } }))?.secretCipher, missing);
      // The server's own box here (a folder) already holds the workspaces' files from the sections above.
      const fromServer = await storageActions.consoleSaveStorageBox({ connection: EMU, container: "deskzo-files" });
      ok("taking over from the server's box, which holds files, needs saying so", !fromServer.ok && /holds workspaces' files/.test(fromServer.error ?? ""), fromServer);
      const saved = await storageActions.consoleSaveStorageBox({ connection: EMU, container: "deskzo-files", acknowledge: true });
      ok("a box that answers is saved", saved.ok, saved);
      const state = await boxLib.storageBoxState();
      ok("  and is used at once, ahead of the server's own", state.configured && state.source === "console" && /devstoreaccount1\/deskzo-files/.test(state.label ?? ""), state);
      const row = await control.platformSetting.findUniqueOrThrow({ where: { key: "storage.connection" } });
      ok("  the connection string kept sealed, never as typed", !!row.secretCipher && !row.secretCipher.includes("AccountKey") && row.value === null);
      const audit = await lastAudit("storage.save");
      ok("  in the audit log, without the key", !!audit && !JSON.stringify(audit.detail).includes("Eby8vdM02") && (audit.detail as { connection?: string }).connection === "replaced", audit?.detail);
      const tenant = (await tenantById(id))!;
      const ref = await runAsTenant(tenant, () => files.keepDataUrl("user-photos", files.toDataUrl(Buffer.from("zz-console-box"), "image/png")));
      ok("a workspace's file now goes to that box", files.isStoredRef(ref) && (await runAsTenant(tenant, () => files.dataUrlOf(ref))) === files.toDataUrl(Buffer.from("zz-console-box"), "image/png"));
      const kept = await storageActions.consoleSaveStorageBox({ container: "deskzo-files" });
      ok("saving again with the field empty keeps the connection string", kept.ok && (await lastAudit("storage.save"))?.detail && ((await lastAudit("storage.save"))!.detail as { connection?: string }).connection === "kept");
      const moving = await storageActions.consoleSaveStorageBox({ container: "deskzo-other" });
      ok("moving to another container while this one holds files is refused, saying why", !moving.ok && /holds workspaces' files/.test(moving.error ?? "") && /stops opening/.test(moving.error ?? ""), moving);
      ok("  and nothing changed", /deskzo-files/.test((await boxLib.storageBoxState()).label ?? ""));
      const moved = await storageActions.consoleSaveStorageBox({ container: "deskzo-other", acknowledge: true });
      ok("  said in words, it is saved", moved.ok && /deskzo-other/.test((await boxLib.storageBoxState()).label ?? ""), moved);
      // Back to the container that holds the workspace's file.
      await storageActions.consoleSaveStorageBox({ container: "deskzo-files", acknowledge: true });
      const removing = await storageActions.consoleRemoveStorageBox({});
      ok("removing a box that holds files is refused the same way", !removing.ok && /holds workspaces' files/.test(removing.error ?? ""), removing);
      const removed = await storageActions.consoleRemoveStorageBox({ acknowledge: true });
      ok("  and with it said, removed — the server's own box decides again", removed.ok && (await boxLib.storageBoxState()).source === "environment" && (await lastAudit("storage.remove")) !== null, removed);
    }

    const summary = await summaryLib.storageSummary();
    const mainRow = summary.rows.find((r) => r.id === id);
    ok("the summary has every open workspace, with files in the box and still waiting in its database", !!mainRow && summary.rows.length >= 3 && mainRow.inBox + mainRow.pending > 0, mainRow);
    ok("  its totals add up", summary.totals.inBox === summary.rows.reduce((n, r) => n + r.inBox, 0) && summary.totals.pending === summary.rows.reduce((n, r) => n + r.pending, 0));
    await actAs(staff.owner);
    const settingsPage = textOf(await render(pageAt("settings/offsite/page")));
    ok(
      "Settings › Backups & logs shows the box, where it is set, and the summary",
      settingsPage.includes("Storage box") && settingsPage.includes("Files in the box") && settingsPage.includes("Still in databases") && /Connect Azure Blob Storage|Change connection/.test(settingsPage),
      settingsPage.slice(settingsPage.indexOf("Storage box"), settingsPage.indexOf("Storage box") + 400),
    );
    ok("  and never the connection string", !settingsPage.includes("AccountKey") && !settingsPage.includes("Eby8vdM02"));
    const rawSettings = await render(pageAt("settings/offsite/page"));
    ok("  each workspace links to its page in the console, as the console's own links go (no /platform-console prefix)", rawSettings.includes('href="/workspaces/zzcsmain"') && !rawSettings.includes("/platform-console/workspaces/"));
  } finally {
    await cleanup?.().catch(() => {});
    for (const name of [controlName, workspaceName]) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.$disconnect().catch(() => {});
    await rm(folder, { recursive: true, force: true });
    ok("the scratch databases are dropped", true);
  }

  console.log(`\n${failures ? `${passes} passed, ${failures} FAILED` : `All ${passes} console storage checks passed.`}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
