/**
 * Storage in the plans (owner, 20 Nov 2026 — src/lib/storage/quota.ts, src/lib/platform/entitlements.ts `storageFrom`):
 *
 *   1. The arithmetic: an edition's storage once for the workspace, never per person; Extra storage packs added; an
 *      edition without a number is no limit; a staff override wins.
 *   2. The catalogue: every edition starts with 7 GB, and a pack of Extra storage is 10 GB.
 *   3. Plans saved with storage, a workspace on an edition with two packs, a staff override, all through the real
 *      save paths, and the answer read back as a workspace reads it.
 *   4. Saving a file: counted against the workspace, refused at the limit with a message saying so, never refused
 *      without a limit, and a move of files already counted is neither counted nor refused.
 *   5. The nightly measurement: files rows point at in the box and files still in the database, by kind — a file no
 *      row points at isn't counted — written on the workspace's control-plane row and the night's usage snapshot.
 *
 * On a scratch control plane and a scratch workspace database, both built from their migrations and dropped after.
 */
import "dotenv/config";
import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";

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
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return nextCache;
  return realLoad.call(this, request, parent, isMain);
};

const MB = 1024 * 1024;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host)) throw new Error("not a local database");
  const realName = new URL(url).pathname.slice(1);

  /* eslint-disable @typescript-eslint/no-require-imports */
  const ent = require("../src/lib/platform/entitlements") as typeof import("../src/lib/platform/entitlements");
  const rules = require("../src/lib/entitlements") as typeof import("../src/lib/entitlements");
  const catalogue = require("../src/lib/platform/product-plans") as typeof import("../src/lib/platform/product-plans");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("1. The arithmetic");
  const edition = (storageMb: number | null) => ({ key: "e", kind: "EDITION" as const, storageMb });
  const pack = (storageMb: number | null) => ({ key: "p", kind: "ADDON" as const, storageMb });
  ok("an edition's 2 GB, for the workspace", ent.storageFrom({}, [{ quantity: 1, plan: edition(2048) }]) === 2048);
  ok("  once, however many people it is sold for", ent.storageFrom({}, [{ quantity: 25, perSeat: true, plan: edition(2048) }]) === 2048);
  ok("  and two packs of 10 GB on top: 22 GB", ent.storageFrom({}, [{ quantity: 1, plan: edition(2048) }, { quantity: 2, plan: pack(10240) }]) === 2048 + 20480);
  ok("an edition without a number: no limit, packs or not", ent.storageFrom({}, [{ quantity: 1, plan: edition(null) }, { quantity: 2, plan: pack(10240) }]) === null);
  ok("an add-on without a number adds nothing", ent.storageFrom({}, [{ quantity: 1, plan: edition(2048) }, { quantity: 3, plan: pack(null) }]) === 2048);
  ok("a staff override replaces the sum", ent.storageFrom({ storageOverrideMb: 51200 }, [{ quantity: 1, plan: edition(2048) }]) === 51200);
  ok("a plan from before storage existed (no number given at all) is no limit on an edition", ent.storageFrom({}, [{ quantity: 1, plan: { kind: "EDITION" } }]) === null);
  const parsed = rules.parseEntitlements({ v: 1, all: false, modules: [], seats: 3, copilotTokens: 0, customDomains: 0, storageMb: 2048, plans: [] });
  ok("the answer keeps its storage when read back", parsed.storageMb === 2048);
  ok("  and one worked out before storage has none — no limit until worked out again", rules.parseEntitlements({ v: 1, all: false, modules: [], seats: 3, copilotTokens: 0, customDomains: 0, plans: [] }).storageMb === undefined);

  section("2. The catalogue");
  const cat = catalogue.productCatalogue();
  ok("every edition starts with 7 GB", cat.filter((p) => p.kind === "EDITION").every((p) => p.storageMb === 7168));
  const extra = cat.find((p) => p.key === catalogue.ADD_ON_PLAN_KEYS.storage);
  ok("Extra storage is an add-on of 10 GB a pack", extra?.kind === "ADDON" && extra.storageMb === 10240, extra?.storageMb);

  section("A scratch control plane and workspace");
  const controlName = `${realName}_storagequota_control`;
  const workspaceName = `${realName}_storagequota_ws`;
  const controlUrl = withDatabase(url, controlName);
  const workspaceUrl = withDatabase(url, workspaceName);
  const admin = directClient(withDatabase(url, "postgres"));
  const folder = await mkdtemp(path.join(os.tmpdir(), "deskzo-quota-"));
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
    for (const k of ["STORAGE_AZURE_CONNECTION_STRING", "STORAGE_AZURE_CONTAINER_URL", "STORAGE_PREFIX"]) delete process.env[k];
    process.env.STORAGE_DIR = folder;
    ok("both built from their migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const plans = require("../src/lib/platform/plans") as typeof import("../src/lib/platform/plans");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const files = require("../src/lib/storage/files") as typeof import("../src/lib/storage/files");
    const quota = require("../src/lib/storage/quota") as typeof import("../src/lib/storage/quota");
    const sweep = require("../src/lib/platform/storage-sweep") as typeof import("../src/lib/platform/storage-sweep");
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    /* eslint-enable @typescript-eslint/no-require-imports */
    type Tenant = import("../src/lib/tenancy/state").Tenant;
    cleanup = async () => {
      await db.$disconnect();
      await closeControlDb();
    };
    const control = controlDb();

    section("3. Plans and a workspace on them");
    const base = { countries: [] as string[], seats: null, copilotTokens: null, modules: ["tasks"] };
    await plans.savePlan({ ...base, kind: "EDITION", key: "zz-base", name: "Zz Base", storageMb: 2048, isDefault: true }, "script:check");
    await plans.savePlan({ ...base, modules: [], kind: "ADDON", key: "zz-storage", name: "Zz Storage", storageMb: 10240 }, "script:check");
    ok("a plan is saved with its storage", (await control.plan.findUniqueOrThrow({ where: { key: "zz-base" } })).storageMb === 2048);
    await plans.savePlan({ ...base, kind: "EDITION", key: "zz-base", name: "Zz Base renamed", isDefault: true }, "script:check");
    ok("  and a change that leaves storage out keeps it", (await control.plan.findUniqueOrThrow({ where: { key: "zz-base" } })).storageMb === 2048);
    ok("  a negative or fractional number is refused", await plans.savePlan({ ...base, kind: "EDITION", key: "zz-bad", name: "Zz Bad", storageMb: -5 }, "script:check").then(() => false, () => true));

    const id = randomUUID();
    await control.tenant.create({
      data: { id, slug: "zzquota", name: "Zz Quota", status: "ACTIVE", keyBundleCipher: keys.sealKeyBundle(id, keys.newKeyBundle()), country: "IN", currency: "INR", ownerEmail: "owner@zzquota.example", timezone: "Asia/Kolkata" },
    });
    await plans.setWorkspacePlans(id, [{ planKey: "zz-base", quantity: 1 }, { planKey: "zz-storage", quantity: 2 }], "script:check");
    const envTenant = await registry.legacyTenant();
    if (!envTenant) throw new Error("No local workspace to stand the scratch one on.");
    const standIn = async (): Promise<Tenant> => {
      const row = await control.tenant.findUniqueOrThrow({ where: { id }, select: { slug: true, name: true, entitlements: true } });
      return { ...envTenant, id, slug: row.slug, name: row.name, dbUrl: workspaceUrl, entitlements: rules.parseEntitlements(row.entitlements), source: "control", isDefault: false } as Tenant;
    };
    ok("a workspace on the edition with two packs has 22 GB", (await standIn()).entitlements.storageMb === 2048 + 20480, (await standIn()).entitlements.storageMb);
    await plans.setLimitOverrides(id, { seats: null, copilotTokens: null, storageMb: 1 }, "script:check");
    ok("a staff override of 1 MB replaces it", (await standIn()).entitlements.storageMb === 1);
    await plans.setLimitOverrides(id, { seats: null, copilotTokens: null }, "script:check");
    ok("  and is kept when the other limits are saved without it", (await standIn()).entitlements.storageMb === 1);

    section("4. Saving a file");
    const T = await standIn();
    const file = (bytes: number) => files.toDataUrl(Buffer.alloc(bytes, 7), "application/pdf");
    const used = async () => Number((await control.tenant.findUniqueOrThrow({ where: { id }, select: { storageUsedBytes: true } })).storageUsedBytes);
    const saved = await runAsTenant(T, () => files.keepDataUrl("employee-documents", file(400 * 1024)));
    ok("a 400 KB file under the 1 MB limit is saved in the box", files.isStoredRef(saved));
    ok("  and counted against the workspace", (await used()) === 400 * 1024, await used());
    let refused: unknown = null;
    await runAsTenant(T, () => files.keepBytes("task-attachments", Buffer.alloc(700 * 1024, 1), "application/pdf")).catch((err) => (refused = err));
    ok("a 700 KB file that would pass the limit is refused", refused instanceof quota.StorageFull, String(refused));
    ok("  with a message that says so, and where to add storage", refused instanceof Error && /storage is full \(0\.4 MB of 1\.0 MB used\)/.test(refused.message) && /Settings › Billing/.test(refused.message), refused instanceof Error ? refused.message : "");
    ok("  and nothing was counted for it", (await used()) === 400 * 1024);
    const moved = await runAsTenant(T, () => files.keepBytes("task-attachments", Buffer.alloc(700 * 1024, 2), "application/pdf", { counted: false }));
    ok("moving a file already counted is neither refused nor counted again", files.isStoredRef(moved) && (await used()) === 400 * 1024);
    await plans.setLimitOverrides(id, { seats: null, copilotTokens: null, storageMb: null }, "script:check");
    await plans.setWorkspacePlans(id, [{ planKey: plans.INTERNAL_PLAN_KEY, quantity: 1 }], "script:check").catch(async () => {
      await plans.savePlan({ ...base, kind: "INTERNAL", key: plans.INTERNAL_PLAN_KEY, name: "Internal", allModules: true }, "script:check");
      await plans.setWorkspacePlans(id, [{ planKey: plans.INTERNAL_PLAN_KEY, quantity: 1 }], "script:check");
    });
    const unlimited = await standIn();
    ok("on a plan without a storage limit…", unlimited.entitlements.storageMb === null, unlimited.entitlements.storageMb);
    const big = await runAsTenant(unlimited, () => files.keepBytes("task-attachments", Buffer.alloc(2 * MB, 3), "application/pdf"));
    ok("  …a file past any number is saved, and counted all the same", files.isStoredRef(big) && (await used()) === 400 * 1024 + 2 * MB);

    section("5. The nightly measurement");
    // A photo in the database still (as before the move), a document in the box a row points at, and one nobody points at.
    const user = await runAsTenant(unlimited, () => db.user.create({ data: { name: "Zz Quota", email: "zz@quota.example", passwordHash: "!", role: "SALES" }, select: { id: true } }));
    const savedStill = process.env.STORAGE_DIR;
    delete process.env.STORAGE_DIR;
    const inline = await runAsTenant(unlimited, () => files.keepDataUrl("user-photos", files.toDataUrl(Buffer.alloc(50 * 1024, 5), "image/png"), { counted: false }));
    process.env.STORAGE_DIR = savedStill;
    await runAsTenant(unlimited, () => db.userPhoto.create({ data: { userId: user.id, dataUrl: inline, mimeType: "image/png", byteSize: 50 * 1024 } }));
    // The 2 MB attachment saved above, pointed at by a task's row; the 400 KB document is pointed at by nothing.
    const task = await runAsTenant(unlimited, () => db.task.create({ data: { title: "Zz quota task", createdByUserId: user.id }, select: { id: true } }));
    await runAsTenant(unlimited, () => db.taskAttachment.create({ data: { taskId: task.id, fileName: "zz.pdf", mimeType: "application/pdf", size: 2 * MB, data: big, uploadedById: user.id } }));
    const measuredRow = await runAsTenant(unlimited, () => quota.recordWorkspaceStorage());
    const row = await control.tenant.findUniqueOrThrow({ where: { id }, select: { storageUsedBytes: true, storageMeasuredAt: true, storageBreakdown: true } });
    const breakdown = (row.storageBreakdown ?? {}) as Record<string, number>;
    ok("the photo still in the database is counted, as user photos", breakdown["user-photos"] !== undefined && breakdown["user-photos"] >= 50 * 1024, breakdown);
    ok("the attachment a row points at in the box is counted, as task attachments", (breakdown["task-attachments"] ?? 0) >= 2 * MB, breakdown);
    ok("files in the box nobody points at are not counted (the unused document, the moved file)", breakdown["employee-documents"] === undefined, breakdown);
    ok("the measurement is written on the workspace's row, replacing the running count", Number(row.storageUsedBytes) === measuredRow?.usedBytes && row.storageMeasuredAt !== null, { row: Number(row.storageUsedBytes), measured: measuredRow?.usedBytes });
    const status = await quota.storageStatus(await standIn());
    ok("the status a screen reads: used, no limit, when measured, by kind", status !== null && status.usedBytes === measuredRow?.usedBytes && status.limitBytes === null && status.share === null && status.measuredAt !== null);

    const nightly = await sweep.sweepStorageBox(new Date(), [unlimited]);
    ok("the nightly run sweeps and measures each workspace", nightly !== null && nightly.measured === 1 && nightly.failed.length === 0, nightly);
  } finally {
    await cleanup?.().catch(() => {});
    for (const name of [controlName, workspaceName]) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.$disconnect().catch(() => {});
    await rm(folder, { recursive: true, force: true });
    ok("the scratch databases are dropped", true);
  }

  console.log(`\n${failures ? `${passes} passed, ${failures} FAILED` : `All ${passes} storage quota checks passed.`}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
