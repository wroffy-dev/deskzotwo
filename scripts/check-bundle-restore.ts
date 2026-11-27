/**
 * check:bundle-restore — restoring Backup & Restore bundles (owner, 26 Nov 2026 — part C: src/lib/bundle/restore.ts,
 * control-apply.ts, restore-status.ts, the console's restore actions, scripts/restore-bundle-worker.ts, the proxy's
 * "Restore in progress" page).
 *
 * Four servers in one process, each its own scratch control plane, storage box folder, support folder and BACKUP_DIR,
 * all with the SAME PLATFORM_MASTER_KEY, all removed afterwards:
 *
 *   A   the server backed up: two workspaces with users, roles, permissions, settings, leads, companies, documents and
 *       a profile photo in the box, a value sealed under the workspace's keys, a plan with a price, a subscription, a
 *       partner, a domain, a support request with one attachment in the box and one on disk; a full bundle and a
 *       workspace bundle made of it with PR-A's builder.
 *   B   a fresh install: a new control plane (migrated, its bootstrap owner only), a new box folder.
 *   C   a server that is not fresh: a workspace of its own.
 *   D   another fresh install, for a workspace added as new.
 *
 *   1. Refusals on B, each recorded as a RestoreRun FAILED with nothing changed: a different PLATFORM_MASTER_KEY, a
 *      newer schema, a tampered file, a wrong passphrase, no storage box while the bundle has files, not enough disk,
 *      no step-up, an admin, the wrong confirmation.
 *   2. The full restore on B through the console's action and the restore worker: every workspace with the same ids and
 *      slugs; every table of each workspace's database with A's row counts; sample rows, the sealed value opening;
 *      every file readable through the app's own readers; A's staff there, A's sessions gone; each workspace on a new
 *      database of B's; the warm pool cleared; B's own storage setting kept; the RestoreRun SUCCEEDED in B's control
 *      plane with its log; entitlements and plans as on A; the "Restore in progress" status done.
 *   3. A workspace restored in place on A: data and files changed after the backup put back, newer files kept, the
 *      safety copy and its control snapshot there; its records left alone, then put back when asked; a failure made in
 *      pg_restore — and another after its records were put back — rolled back to exactly the state before, the
 *      workspace open again.
 *   4. A workspace added as new on D: a failure made after its records went in takes everything away again; then, by
 *      the real worker process, its plans, subscription, domain and files; then a backup refused on a server where its
 *      address name is taken.
 *   5. A full restore onto C, which isn't fresh: a failure made after the control plane is replaced rolls it back
 *      exactly; then one that finishes leaves C's own workspace database untouched and its control plane's safety dump
 *      on disk; then one where a workspace fails leaves it suspended and restores the other.
 *
 *   npm run check:bundle-restore
 */
import "dotenv/config";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
process.env.TRUST_PROXY = "";
process.env.PLATFORM_CONSOLE_IP_ALLOWLIST = "";
for (const k of [
  "STORAGE_AZURE_CONNECTION_STRING",
  "STORAGE_AZURE_CONTAINER_URL",
  "STORAGE_AZURE_CONTAINER",
  "STORAGE_AZURE_SAS",
  "STORAGE_PREFIX",
  "RECORDINGS_AZURE_CONTAINER_URL",
  "RECORDINGS_DIR",
  "REFERENCE_DATABASE_URL",
])
  process.env[k] = "";

const PASS = "zz-Restore-passphrase-" + randomBytes(6).toString("hex");

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(
    `${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail, (_k, v) => (typeof v === "bigint" ? v.toString() : v)).slice(0, 1500)}` : ""}`,
  );
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const sha256 = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const withDatabase = (url: string, database: string) => {
  const u = new URL(url);
  u.pathname = `/${database}`;
  return u.toString();
};
const HOUR = 3_600_000;

// ─── A request, as the console sees one ──────────────────────────────────────────────────────────
const HOST = "admin.localhost:3000";
const COOKIE = "deskzo-console";
const jar = new Map<string, string>();
const requestHeaders = new Headers({
  host: HOST,
  "user-agent": "check:bundle-restore",
});
const internals = Module as unknown as {
  _load(request: string, parent: { filename?: string } | undefined, isMain: boolean): unknown;
};
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
  if (request === "next/cache")
    return {
      revalidatePath() {},
      revalidateTag() {},
      unstable_cache: (fn: unknown) => fn,
    };
  if (request === "@/lib/auth")
    return {
      auth: async () => null,
      signIn: async () => {},
      signOut: async () => {},
    };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

type Server = {
  name: string;
  control: string;
  box: string | null;
  support: string;
  backups: string;
};

async function main() {
  const url = process.env.DATABASE_URL;
  const realKey = process.env.PLATFORM_MASTER_KEY;
  if (!url || !realKey) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname)) throw new Error("not a local database");
  const realName = new URL(url).pathname.slice(1);
  const admin = directClient(withDatabase(url, "postgres"));
  const scratch = await mkdtemp(path.join(os.tmpdir(), "deskzo-bundle-restore-"));
  const names = {
    tpl: `${realName}_br_ctltpl`,
    wsTpl: `${realName}_br_wstpl`,
    a: `${realName}_br_a`,
    b: `${realName}_br_b`,
    c: `${realName}_br_c`,
    d: `${realName}_br_d`,
    a2: `${realName}_br_a_ws2`,
    c1: `${realName}_br_c_ws1`,
  };
  const dbsBefore = new Set((await admin.$queryRawUnsafe<{ datname: string }[]>(`SELECT datname::text AS datname FROM pg_database WHERE datname LIKE 'w\\_%'`)).map((r) => r.datname));
  const rolesBefore = new Set((await admin.$queryRawUnsafe<{ rolname: string }[]>(`SELECT rolname::text AS rolname FROM pg_roles WHERE rolname LIKE 'w\\_%'`)).map((r) => r.rolname));
  let cleanup: (() => Promise<void>) | null = null;
  try {
    for (const n of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.tpl}"`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${names.wsTpl}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", {
      stdio: "pipe",
      env: {
        ...process.env,
        CONTROL_DATABASE_URL: withDatabase(url, names.tpl),
      },
      timeout: 5 * 60_000,
    });
    execSync("npx prisma migrate deploy", {
      stdio: "pipe",
      env: { ...process.env, DATABASE_URL: withDatabase(url, names.wsTpl) },
      timeout: 15 * 60_000,
    });
    for (const n of [names.a, names.b, names.c, names.d]) await admin.$executeRawUnsafe(`CREATE DATABASE "${n}" TEMPLATE "${names.tpl}"`);
    for (const n of [names.a2, names.c1]) await admin.$executeRawUnsafe(`CREATE DATABASE "${n}" TEMPLATE "${names.wsTpl}"`);
    const server = (name: string, db: string, withBox = true): Server => ({
      name,
      control: withDatabase(url, db),
      box: withBox ? path.join(scratch, name, "box") : null,
      support: path.join(scratch, name, "support"),
      backups: path.join(scratch, name, "backups"),
    });
    const A = server("a", names.a);
    const B = server("b", names.b);
    const C = server("c", names.c);
    const D = server("d", names.d);
    process.env.CONTROL_DATABASE_URL = A.control;
    process.env.DATABASE_URL = withDatabase(url, names.wsTpl);
    ok("four scratch control planes and workspace databases, from their migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const kek = require("../src/lib/platform/kek") as typeof import("../src/lib/platform/kek");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const { runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    const staffLib = require("../src/lib/platform/staff") as typeof import("../src/lib/platform/staff");
    const plans = require("../src/lib/platform/plans") as typeof import("../src/lib/platform/plans");
    const entitlements = require("../src/lib/platform/entitlements") as typeof import("../src/lib/platform/entitlements");
    const provisioner = require("../src/lib/platform/provisioner") as typeof import("../src/lib/platform/provisioner");
    const { migrateDeploy } = require("../src/lib/platform/migrate") as typeof import("../src/lib/platform/migrate");
    const totp = require("../src/lib/totp") as typeof import("../src/lib/totp");
    const { authenticator } = require("otplib") as typeof import("otplib");
    const build = require("../src/lib/bundle/build") as typeof import("../src/lib/bundle/build");
    const jobs = require("../src/lib/bundle/jobs") as typeof import("../src/lib/bundle/jobs");
    const upload = require("../src/lib/bundle/upload") as typeof import("../src/lib/bundle/upload");
    const restore = require("../src/lib/bundle/restore") as typeof import("../src/lib/bundle/restore");
    const status = require("../src/lib/bundle/restore-status") as typeof import("../src/lib/bundle/restore-status");
    const controlRows = require("../src/lib/bundle/control-rows") as typeof import("../src/lib/bundle/control-rows");
    const actions = require("../src/actions/platform/console-backups") as typeof import("../src/actions/platform/console-backups");
    const boxLib = require("../src/lib/storage/box") as typeof import("../src/lib/storage/box");
    const files = require("../src/lib/storage/files") as typeof import("../src/lib/storage/files");
    const support = require("../src/lib/support/storage") as typeof import("../src/lib/support/storage");
    const atRest = require("../src/lib/backup/at-rest") as typeof import("../src/lib/backup/at-rest");
    const maintenance = require("../src/lib/backup/maintenance") as typeof import("../src/lib/backup/maintenance");
    const { encryptSecret, decryptSecret } = require("../src/lib/crypto") as typeof import("../src/lib/crypto");
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    /* eslint-enable @typescript-eslint/no-require-imports */
    cleanup = async () => {
      jobs.setWorkerSpawnerForChecks(null);
      jobs.setFreeSpaceProbeForChecks(null);
      restore.setRestoreFaultForChecks(null);
      await db.$disconnect().catch(() => {});
      await closeControlDb();
    };

    /** One server at a time: its control plane, box, support folder and BACKUP_DIR, nothing remembered from another. */
    const switchTo = async (s: Server) => {
      await closeControlDb();
      await db.$disconnect().catch(() => {});
      process.env.CONTROL_DATABASE_URL = s.control;
      process.env.STORAGE_DIR = s.box ?? "";
      process.env.SUPPORT_DIR = s.support;
      process.env.BACKUP_DIR = s.backups;
      registry.forgetRegistry();
      boxLib.forgetStorageBoxSettings();
      files.forgetRememberedFiles();
      jar.delete(COOKIE);
    };
    const control = () => controlDb();

    // Workers as the console starts them, run here — what each was given is kept to look at.
    const spawned: { args: string[]; env: NodeJS.ProcessEnv }[] = [];
    let pending: Promise<unknown> = Promise.resolve();
    const inProcess = () =>
      jobs.setWorkerSpawnerForChecks((_command, args, env) => {
        spawned.push({ args, env });
        if (args.some((a) => a.endsWith("restore-bundle-worker.ts")))
          pending = restore.runRestoreJob(args.at(-1)!).catch((err) => console.error(`worker: ${err instanceof Error ? err.message : err}`));
      });
    inProcess();

    // ─── Staff ───────────────────────────────────────────────────────────────────────────────────
    const totpSecret = totp.generateTotpSecret();
    const addStaff = async (role: "OWNER" | "ADMIN", email: string, withTotp = role === "OWNER") => {
      const id = (await staffLib.createStaff({ email, name: `Zz ${email.split("@")[0]}`, role }, "script:check:bundle-restore")).id;
      if (withTotp)
        await control().platformUser.update({
          where: { id },
          data: {
            totpSecretCipher: kek.sealForPlatform("staff-totp", totpSecret),
            totpEnabledAt: new Date(Date.now() - 60_000),
          },
        });
      return id;
    };
    const signIn = async (userId: string) => {
      const token = randomBytes(32).toString("base64url");
      const id = sha256(token);
      await control().platformSession.create({
        data: {
          id,
          userId,
          expiresAt: new Date(Date.now() + HOUR),
          mfaAt: new Date(),
          userAgent: "check:bundle-restore",
        },
      });
      jar.set(COOKIE, token);
      return id;
    };
    const stepUp = async () => {
      totp.forgetUsedTotpSteps();
      return actions.consoleBackupStepUp(authenticator.generate(totpSecret));
    };

    // ─── Helpers over databases ──────────────────────────────────────────────────────────────────
    /** Every table's row count in a database, generically. */
    const tableCounts = async (dbUrl: string, skip: string[] = []) => {
      const c = directClient(dbUrl, { max: 1 });
      try {
        const tables = await c.$queryRawUnsafe<{ t: string }[]>(`SELECT tablename::text AS t FROM pg_tables WHERE schemaname = 'public' AND tablename <> '_prisma_migrations' ORDER BY tablename`);
        const out: Record<string, number> = {};
        for (const { t } of tables) if (!skip.includes(t)) out[t] = Number((await c.$queryRawUnsafe<{ n: bigint }[]>(`SELECT count(*)::bigint AS n FROM "${t}"`))[0]!.n);
        return out;
      } finally {
        await c.$disconnect().catch(() => {});
      }
    };
    const countsDiffer = (x: Record<string, number>, y: Record<string, number>) => {
      const out: Record<string, [number | undefined, number | undefined]> = {};
      for (const k of new Set([...Object.keys(x), ...Object.keys(y)])) if (x[k] !== y[k]) out[k] = [x[k], y[k]];
      return out;
    };
    const controlCounts = async (s: Server) => tableCounts(s.control, ["restore_runs", "platform_audit_log", "platform_sessions", "platform_backups"]);
    const wDatabases = async () =>
      (await admin.$queryRawUnsafe<{ datname: string }[]>(`SELECT datname::text AS datname FROM pg_database WHERE datname LIKE 'w\\_%' ORDER BY 1`))
        .map((r) => r.datname)
        .filter((n) => !dbsBefore.has(n));
    const filesIn = async (dir: string | null): Promise<string[]> => {
      if (!dir) return [];
      const out: string[] = [];
      const walk = async (d: string, rel: string) => {
        for (const e of await readdir(d, { withFileTypes: true }).catch(() => [])) {
          if (e.isDirectory()) await walk(path.join(d, e.name), `${rel}${e.name}/`);
          else out.push(`${rel}${e.name}`);
        }
      };
      await walk(dir, "");
      return out.sort();
    };
    const exists = (file: string) =>
      stat(file).then(
        () => true,
        () => false,
      );
    const readAll = async (stream: NodeJS.ReadableStream) => {
      const chunks: Buffer[] = [];
      for await (const c of stream) chunks.push(Buffer.from(c as Buffer));
      return Buffer.concat(chunks);
    };

    // ─── Server A ────────────────────────────────────────────────────────────────────────────────
    section("Server A: two workspaces, plans, billing, files");
    await switchTo(A);
    const aOwner = await addStaff("OWNER", "owner@zzrestore-a.example");
    await addStaff("ADMIN", "admin@zzrestore-a.example");
    await signIn(aOwner); // a session of A's, which must not survive onto B
    await plans.savePlan(
      {
        countries: [],
        seats: null,
        copilotTokens: null,
        modules: ["tasks"],
        kind: "EDITION",
        key: "zz-restore-plan",
        name: "Zz Restore",
        storageMb: 2048,
        isDefault: true,
      },
      "script:check",
    );
    const plan = await control().plan.findUniqueOrThrow({
      where: { key: "zz-restore-plan" },
    });
    await control().planPrice.create({
      data: {
        planId: plan.id,
        currency: "INR",
        interval: "MONTH",
        amount: 49900,
      },
    });
    const partner = await control().partner.create({
      data: {
        slug: "zzrestorepartner",
        kind: "RESELLER",
        legalName: "Zz Restore Partner Pvt Ltd",
        displayName: "Zz Restore Partner",
        country: "IN",
        contactName: "Zz",
        contactEmail: "zz@partner.example",
        territories: ["IN"],
        createdBy: "script:check",
      },
    });
    const w1Db = await provisioner.createWorkspaceDatabase();
    await migrateDeploy(w1Db.url);
    const w2Url = withDatabase(url, names.a2);
    const W1 = randomUUID();
    const W2 = randomUUID();
    const tenantRow = (id: string, slug: string, u: string, dbName: string, extra: Record<string, unknown> = {}) => ({
      id,
      slug,
      name: `Zz ${slug}`,
      status: "ACTIVE" as const,
      keyBundleCipher: keys.sealKeyBundle(id, keys.newKeyBundle()),
      dbUrlCipher: kek.sealForTenant(id, "db-url", u),
      dbName,
      country: "IN",
      currency: "INR",
      timezone: "Asia/Kolkata",
      ...extra,
    });
    await control().tenant.create({
      data: tenantRow(W1, "zzrsone", w1Db.url, w1Db.dbName, {
        isDefault: true,
        partnerId: partner.id,
        dbRole: w1Db.dbRole,
        billingName: "Zz One Pvt Ltd",
      }),
    });
    await control().tenant.create({
      data: tenantRow(W2, "zzrstwo", w2Url, names.a2),
    });
    for (const id of [W1, W2]) {
      await plans.setWorkspacePlans(id, [{ planKey: "zz-restore-plan", quantity: 1 }], "script:check");
      await entitlements.refreshEntitlements(id);
    }
    await control().tenantDomain.create({
      data: {
        tenantId: W1,
        host: "books.zzrsone.example",
        kind: "CUSTOM",
        status: "ACTIVE",
      },
    });
    await control().tenantNote.create({
      data: {
        tenantId: W1,
        authorId: aOwner,
        body: "note on one, as backed up",
      },
    });
    await control().warmDatabase.create({
      data: {
        dbName: "w_zzwarmold01",
        dbRole: "w_zzwarmold01",
        dbUrlCipher: kek.sealForPlatform("warm-db-url", "postgresql://old/old"),
      },
    });
    await control().platformSetting.create({
      data: { key: "storage.container", value: "zz-a-container" },
    });
    await control().platformSetting.create({
      data: { key: "offsite.provider", value: "filesystem" },
    });
    await control().tenantJobLease.create({
      data: {
        tenantId: W1,
        job: "zz-job",
        leasedUntil: new Date(Date.now() + HOUR),
        holder: "server-a",
      },
    });

    // Each workspace's own database: people, a role and its permissions, a setting, a company and a lead, a document
    // and a profile photo in the box, and a value sealed under its keys.
    const fixtures: Record<
      string,
      {
        photo: string;
        doc: string;
        docUrl: string;
        photoUrl: string;
        userId: string;
        cipher: string;
        supportBox?: { key: string; bytes: Buffer };
        supportDisk?: { key: string; bytes: Buffer };
      }
    > = {};
    for (const [id, slug] of [
      [W1, "zzrsone"],
      [W2, "zzrstwo"],
    ] as const) {
      const tenant = (await registry.tenantById(id))!;
      fixtures[id] = await runAsTenant(tenant, async () => {
        const owner = await db.user.create({
          data: {
            email: `owner@${slug}.example`,
            name: `Owner ${slug}`,
            role: "ADMIN",
            passwordHash: "!",
          } as never,
          select: { id: true },
        });
        await db.user.create({
          data: {
            email: `sales@${slug}.example`,
            name: `Sales ${slug}`,
            role: "SALES",
            passwordHash: "!",
          } as never,
        });
        await db.role.create({
          data: { key: `zz-${slug}`, name: `Zz role ${slug}` } as never,
        });
        await db.rolePermission.create({
          data: { role: `zz-${slug}`, permission: "leads.view" } as never,
        });
        await db.rolePermission.create({
          data: {
            role: `zz-${slug}`,
            permission: "leads.edit",
            allowed: false,
          } as never,
        });
        await db.documentNumberSetting.create({
          data: {
            docType: "PROPOSAL",
            prefix: `${slug.toUpperCase()}/QT/`,
            nextNumber: 42,
          } as never,
        });
        const company = await db.company.create({
          data: {
            name: `Acme ${slug}`,
            normalizedName: `acme ${slug}`,
            createdById: owner.id,
            ownerUserId: owner.id,
            relationshipType: "CLIENT",
          } as never,
          select: { id: true },
        });
        await db.lead.create({
          data: { companyId: company.id, title: `Lead for ${slug}` } as never,
        });
        await db.lead.create({
          data: {
            companyId: company.id,
            title: `Second lead for ${slug}`,
          } as never,
        });
        const cipher = await encryptSecret(`vault-${slug}`);
        await db.company.create({
          data: {
            name: `ZZSEALED:${cipher}`,
            normalizedName: `zzsealed ${slug}`,
            createdById: owner.id,
            ownerUserId: owner.id,
            relationshipType: "CLIENT",
          } as never,
        });
        const photoUrl = `data:image/png;base64,${randomBytes(4000).toString("base64")}`;
        const docUrl = `data:application/pdf;base64,${randomBytes(20_000).toString("base64")}`;
        const photo = await files.keepDataUrl("user-photos", photoUrl);
        const doc = await files.keepDataUrl("employee-documents", docUrl);
        await db.userPhoto.create({
          data: {
            userId: owner.id,
            dataUrl: photo,
            mimeType: "image/png",
            byteSize: 4000,
          } as never,
        });
        await db.employeeDocument.create({
          data: {
            userId: owner.id,
            name: "Offer letter",
            fileDataUrl: doc,
            mimeType: "application/pdf",
            sizeBytes: 20_000,
          } as never,
        });
        await db.signIn.create({
          data: {
            sid: `zz-${slug}-${randomBytes(4).toString("hex")}`,
            userId: owner.id,
            provider: "credentials",
          } as never,
        });
        return { photo, doc, docUrl, photoUrl, userId: owner.id, cipher };
      });
      ok(`  ${slug}: its document and photo are references into the box`, files.isStoredRef(fixtures[id]!.doc) && files.isStoredRef(fixtures[id]!.photo));
    }
    // A support request of the first, with one attachment in the box (sealed) and one still on disk.
    const request = await control().supportRequest.create({
      data: {
        tenantId: W1,
        requesterUserId: fixtures[W1]!.userId,
        requesterName: "Owner",
        requesterEmail: "owner@zzrsone.example",
        subject: "Help",
        body: "Please",
        context: {},
      },
    });
    const boxAtt = "att" + randomBytes(8).toString("hex");
    const diskAtt = "att" + randomBytes(8).toString("hex");
    const boxBytes = randomBytes(9_999);
    const diskBytes = randomBytes(7_777);
    await (await boxLib.storageBox())!.put(`support/${W1}/${request.id}/${boxAtt}`, atRest.sealBuffer(W1, boxBytes, "file"));
    await mkdir(path.join(A.support, W1, request.id), { recursive: true });
    await writeFile(path.join(A.support, W1, request.id, diskAtt), diskBytes);
    await control().supportAttachment.create({
      data: {
        requestId: request.id,
        kind: "FILE",
        filename: "in-box.pdf",
        mime: "application/pdf",
        size: boxBytes.length,
        sha256: sha256(boxBytes),
        storageKey: `box:${W1}/${request.id}/${boxAtt}`,
      },
    });
    await control().supportAttachment.create({
      data: {
        requestId: request.id,
        kind: "FILE",
        filename: "on-disk.pdf",
        mime: "application/pdf",
        size: diskBytes.length,
        sha256: sha256(diskBytes),
        storageKey: `${W1}/${request.id}/${diskAtt}`,
      },
    });
    fixtures[W1]!.supportBox = {
      key: `box:${W1}/${request.id}/${boxAtt}`,
      bytes: boxBytes,
    };
    fixtures[W1]!.supportDisk = {
      key: `${W1}/${request.id}/${diskAtt}`,
      bytes: diskBytes,
    };

    const aCounts = {
      [W1]: await tableCounts(w1Db.url),
      [W2]: await tableCounts(w2Url),
    };
    const aControl = {
      staff: (
        await control().platformUser.findMany({
          select: { email: true },
          orderBy: { email: "asc" },
        })
      ).map((u) => u.email),
      tenants: await control().tenant.findMany({
        select: { id: true, slug: true, entitlements: true, status: true },
        orderBy: { slug: "asc" },
      }),
      items: await control().subscriptionItem.count(),
      plans: (
        await control().plan.findMany({
          select: { key: true },
          orderBy: { key: "asc" },
        })
      ).map((p) => p.key),
    };
    ok("A: rows in every table, files in its box and on disk", (aCounts[W1]!.users ?? 0) === 2 && (aCounts[W1]!.leads ?? 0) === 2 && (await filesIn(A.box)).length >= 5, {
      users: aCounts[W1]!.users,
      files: await filesIn(A.box),
    });

    // The bundles, by PR-A's builder: a full one, one of the second workspace, one from a "newer" server.
    const out = path.join(scratch, "bundles");
    await mkdir(out, { recursive: true });
    const fullOnA = await build.buildFullBundle({
      out: path.join(out, "full.dzbk"),
      passphrase: PASS,
      createdBy: "script:check",
    });
    const wsOneOnA = await build.buildWorkspaceBundle((await registry.tenantById(W1))!, {
      out: path.join(out, "one.dzbk"),
      passphrase: PASS,
      createdBy: "script:check",
    });
    const wsTwoOnA = await build.buildWorkspaceBundle((await registry.tenantById(W2))!, {
      out: path.join(out, "two.dzbk"),
      passphrase: PASS,
      createdBy: "script:check",
    });
    const newer = await build.buildFullBundle({
      out: path.join(out, "newer.dzbk"),
      passphrase: PASS,
      createdBy: "script:check",
      adjustHeader: (h) => ({
        ...h,
        control: { schemaVersion: "29991231000000_from_a_newer_server" },
      }),
    });
    const tampered = path.join(out, "tampered.dzbk");
    {
      const bytes = await readFile(fullOnA.file);
      bytes[Math.floor(bytes.length * 0.6)]! ^= 0x5a;
      await writeFile(tampered, bytes);
    }
    ok("A: a full bundle and two workspace bundles made", fullOnA.header.workspaces.length === 2 && wsOneOnA.header.kind === "workspace" && wsTwoOnA.header.kind === "workspace");

    /** A bundle uploaded to the server in use, by the console's own upload code: its READY row's id. */
    const uploadTo = async (file: string, staffId: string) => {
      const bytes = await readFile(file);
      const started = await upload.initUpload({
        staffId,
        name: path.basename(file),
        total: bytes.length,
        head: bytes.subarray(0, upload.HEAD_BYTES),
      });
      for (let n = 0; n * upload.PART_BYTES < bytes.length; n++) {
        const part = bytes.subarray(n * upload.PART_BYTES, (n + 1) * upload.PART_BYTES);
        await upload.receivePart({
          id: started.id,
          staffId,
          part: n,
          sha256: sha256(part),
          body: Readable.from([part]),
        });
      }
      return (await upload.completeUpload(started.id, staffId)).backupId;
    };
    /** A restore through the console's action, its worker run here; the run's row when it has finished. */
    const startRestore = async (backupId: string, confirm: string, extra: { passphrase?: string; putBackControlRows?: boolean } = {}) => {
      const r = await actions.consoleStartRestore({
        backupId,
        passphrase: extra.passphrase ?? PASS,
        confirm,
        putBackControlRows: extra.putBackControlRows,
      });
      await pending;
      return r;
    };
    const lastRun = async () => control().restoreRun.findFirst({ orderBy: { startedAt: "desc" } });

    // ─── 1. Refusals on B, the fresh install ─────────────────────────────────────────────────────
    section("1. Refusals on a fresh install (B), each recorded, nothing changed");
    await switchTo(B);
    const bOwner = await addStaff("OWNER", "bootstrap@zzrestore-b.example");
    const bAdmin = await addStaff("ADMIN", "admin@zzrestore-b.example");
    await control().platformSetting.create({
      data: { key: "storage.container", value: "zz-b-container" },
    });
    await signIn(bOwner);
    const fullOnB = await uploadTo(fullOnA.file, bOwner);
    const newerOnB = await uploadTo(newer.file, bOwner);
    const tamperedOnB = await uploadTo(tampered, bOwner);
    const bBefore = {
      control: await controlCounts(B),
      box: await filesIn(B.box),
      dbs: await wDatabases(),
    };
    const unchanged = async () => {
      const now = {
        control: await controlCounts(B),
        box: await filesIn(B.box),
        dbs: await wDatabases(),
      };
      const diff = countsDiffer(bBefore.control, now.control);
      return Object.keys(diff).length === 0 && JSON.stringify(now.box) === JSON.stringify(bBefore.box) && JSON.stringify(now.dbs) === JSON.stringify(bBefore.dbs) && !status.activeFullRestore()
        ? true
        : { diff, box: now.box, dbs: now.dbs };
    };
    const refusedWith = async (label: string, r: { ok: boolean; error?: string }, pattern: RegExp, expectRecorded = true) => {
      const run = await lastRun();
      const recorded = !expectRecorded || (run?.status === "FAILED" && pattern.test(run.error ?? ""));
      const same = await unchanged();
      ok(label, recorded && same === true && (r.ok || pattern.test(r.error ?? "") || pattern.test(run?.error ?? "")), { r, run: run && { status: run.status, error: run.error }, same });
    };

    const noStepUp = await actions.consoleStartRestore({
      backupId: fullOnB,
      passphrase: PASS,
      confirm: "RESTORE EVERYTHING",
    });
    await refusedWith("without a fresh authenticator code: refused", noStepUp, /fresh code/);
    ok("  and said so to the owner", !noStepUp.ok && /fresh code/.test(noStepUp.error));
    const stepped = await stepUp();
    ok("an owner gives a fresh code", stepped.ok, stepped);
    await refusedWith(
      "the wrong confirmation: refused",
      await actions.consoleStartRestore({
        backupId: fullOnB,
        passphrase: PASS,
        confirm: "restore everything",
      }),
      /confirmation doesn't match/,
    );
    await refusedWith(
      "a wrong passphrase: refused",
      await actions.consoleStartRestore({
        backupId: fullOnB,
        passphrase: "not the passphrase at all",
        confirm: "RESTORE EVERYTHING",
      }),
      /passphrase doesn't open/,
    );
    await refusedWith("a newer schema: refused, saying this server must be updated", await startRestore(newerOnB, "RESTORE EVERYTHING"), /newer migration than this server has/);
    process.env.PLATFORM_MASTER_KEY = Buffer.from(randomBytes(32)).toString("base64");
    const otherKey = await startRestore(fullOnB, "RESTORE EVERYTHING");
    process.env.PLATFORM_MASTER_KEY = realKey;
    await refusedWith("a different PLATFORM_MASTER_KEY: refused, saying to set that key", otherKey, /different PLATFORM_MASTER_KEY\. Set that key on this server/);
    await refusedWith("a tampered bundle: refused by the worker's read-through, before anything", await startRestore(tamperedOnB, "RESTORE EVERYTHING"), /damaged or was altered/);
    process.env.STORAGE_DIR = "";
    boxLib.forgetStorageBoxSettings();
    const noBox = await startRestore(fullOnB, "RESTORE EVERYTHING");
    process.env.STORAGE_DIR = B.box!;
    boxLib.forgetStorageBoxSettings();
    await refusedWith("no storage box while the bundle has files: refused — set up the storage box first", noBox, /set up the storage box first/);
    jobs.setFreeSpaceProbeForChecks(async () => 2 * 1024 * 1024);
    const tight = await startRestore(fullOnB, "RESTORE EVERYTHING");
    jobs.setFreeSpaceProbeForChecks(null);
    await refusedWith("not enough disk: refused with the numbers", tight, /Not enough disk: restoring this needs about [\d.]+ MB .* and there is 2\.0 MB/);
    await signIn(bAdmin);
    await control().platformSession.update({
      where: { id: sha256(jar.get(COOKIE)!) },
      data: { stepUpAt: new Date() },
    });
    await refusedWith(
      "an admin: refused, whatever their session says",
      await actions.consoleStartRestore({
        backupId: fullOnB,
        passphrase: PASS,
        confirm: "RESTORE EVERYTHING",
      }),
      /Only an owner/,
    );
    const refusals = await control().restoreRun.count({
      where: { status: "FAILED" },
    });
    ok("every refusal is a RestoreRun FAILED on B", refusals >= 9, refusals);
    ok(
      "the passphrase was never on a worker's command line or in its environment",
      spawned.length >= 3 && spawned.every((s) => !s.args.some((a) => a.includes(PASS)) && !Object.values(s.env).some((v) => typeof v === "string" && v.includes(PASS))),
      spawned.length,
    );

    // ─── 2. The full restore on B ────────────────────────────────────────────────────────────────
    section("2. The whole application restored on the fresh install (B)");
    await signIn(bOwner);
    ok("  a fresh code for it", (await stepUp()).ok);
    const plan2 = await actions.consoleRestorePlan(fullOnB);
    ok(
      "the wizard's plan: a full restore, what happens in order, the confirmation to type",
      plan2.ok && plan2.data.mode === "FULL" && plan2.data.steps.length >= 6 && plan2.data.confirmText === "RESTORE EVERYTHING" && plan2.data.warning === null,
      plan2,
    );
    const started = await actions.consoleStartRestore({
      backupId: fullOnB,
      passphrase: PASS,
      confirm: "RESTORE EVERYTHING",
    });
    const runId = started.ok ? started.data.runId : "";
    ok("an owner starts it; the application is closed at once (the status page is up)", started.ok && started.data.full && status.activeFullRestore()?.runId === runId, started);
    ok("  the console shows a plain status page, no data", status.restoreStatusPage(runId).includes("Restore in progress") && !status.restoreStatusPage(runId).includes("zzrsone"));
    await pending;
    files.forgetRememberedFiles();
    registry.forgetRegistry();
    const bRun = await control().restoreRun.findUnique({
      where: { id: runId },
    });
    ok("the restore SUCCEEDED, its run and log written into B's restored control plane", bRun?.status === "SUCCEEDED" && Array.isArray(bRun.log) && (bRun.log as unknown[]).length > 8, {
      status: bRun?.status,
      error: bRun?.error,
      log: bRun?.log,
    });
    const pub = status.publicRestoreStatus(runId);
    ok(
      "  the status page now says done — sign in with your staff account from the backup — and the application is open",
      !status.activeFullRestore() && pub.state === "succeeded" && /sign in with your staff account from the backup/.test(pub.message) && !JSON.stringify(pub).includes("zzrs"),
      pub,
    );
    const bTenants = await control().tenant.findMany({
      select: {
        id: true,
        slug: true,
        entitlements: true,
        status: true,
        dbName: true,
        dbUrlCipher: true,
      },
      orderBy: { slug: "asc" },
    });
    ok(
      "every workspace there, with the same ids and slugs and status",
      JSON.stringify(bTenants.map((t) => [t.id, t.slug, t.status])) === JSON.stringify(aControl.tenants.map((t) => [t.id, t.slug, t.status])),
      bTenants.map((t) => t.slug),
    );
    ok("  entitlements as on A", JSON.stringify(bTenants.map((t) => t.entitlements)) === JSON.stringify(aControl.tenants.map((t) => t.entitlements)));
    ok(
      "  plans and subscription items as on A",
      JSON.stringify(
        (
          await control().plan.findMany({
            select: { key: true },
            orderBy: { key: "asc" },
          })
        ).map((p) => p.key),
      ) === JSON.stringify(aControl.plans) && (await control().subscriptionItem.count()) === aControl.items,
    );
    for (const t of bTenants) {
      const tenant = (await registry.tenantById(t.id))!;
      const newDb = t.dbName !== null && t.dbName !== (t.id === W1 ? w1Db.dbName : names.a2) && (await wDatabases()).includes(t.dbName);
      ok(`${t.slug}: its address points at a new database on B (${t.dbName})`, newDb && new URL(tenant.dbUrl).pathname === `/${t.dbName}`, { dbName: t.dbName });
      const bCounts = await tableCounts(tenant.dbUrl);
      const diff = countsDiffer(aCounts[t.id]!, bCounts);
      ok(`  every table's row count as on A (${Object.keys(bCounts).length} tables)`, Object.keys(diff).length === 0 && Object.keys(bCounts).length > 100, diff);
      const f = fixtures[t.id]!;
      const seen = await runAsTenant(tenant, async () => {
        const users = await db.user.findMany({
          select: { id: true, email: true, name: true, passwordHash: true },
          orderBy: { email: "asc" },
        });
        const sealed = (await db.company.findMany({ select: { name: true } })).find((c) => c.name.startsWith("ZZSEALED:"));
        const secret = sealed ? await decryptSecret(sealed.name.slice("ZZSEALED:".length)).catch(() => "unreadable") : null;
        const perms = await db.rolePermission.findMany({
          where: { role: `zz-${t.slug}` },
          orderBy: { permission: "asc" },
        });
        const setting = await db.documentNumberSetting.findUnique({
          where: { docType: "PROPOSAL" } as never,
        });
        const doc = await db.employeeDocument.findFirst({
          select: { fileDataUrl: true },
        });
        const photo = await db.userPhoto.findFirst({
          select: { dataUrl: true },
        });
        const docBytes = doc ? await files.dataUrlOf(doc.fileDataUrl).catch((e: Error) => `missing: ${e.message}`) : null;
        const photoBytes = photo ? await files.dataUrlOf(photo.dataUrl).catch((e: Error) => `missing: ${e.message}`) : null;
        const openSignIns = await db.signIn.count({ where: { endedAt: null } });
        return {
          users,
          secret,
          perms: perms.map((p) => `${p.permission}:${p.allowed}`),
          prefix: (setting as { prefix?: string } | null)?.prefix,
          docBytes,
          photoBytes,
          openSignIns,
        };
      });
      ok(
        "  sample rows as on A: its people, a role's permissions, a setting",
        seen.users.length === 2 &&
          seen.users.some((u) => u.id === f.userId && u.email === `owner@${t.slug}.example`) &&
          seen.perms.join() === "leads.edit:false,leads.view:true" &&
          seen.prefix === `${t.slug.toUpperCase()}/QT/`,
        seen,
      );
      ok("  the value sealed under its keys opens on B", seen.secret === `vault-${t.slug}`, seen.secret);
      ok("  its document and its profile photo open through the app's own readers", seen.docBytes === f.docUrl && seen.photoBytes === f.photoUrl, {
        doc: String(seen.docBytes).slice(0, 60),
        photo: String(seen.photoBytes).slice(0, 60),
      });
      ok("  every sign-in it carried has ended", seen.openSignIns === 0);
    }
    const sBox = fixtures[W1]!.supportBox!;
    const sDisk = fixtures[W1]!.supportDisk!;
    const boxOpen = await support.openAttachment(sBox.key);
    const diskOpen = await support.openAttachment(sDisk.key);
    ok(
      "its support attachments open on B — the one in the box and the one on disk",
      !!boxOpen && sha256(await readAll(boxOpen.stream)) === sha256(sBox.bytes) && !!diskOpen && sha256(await readAll(diskOpen.stream)) === sha256(sDisk.bytes),
    );
    const bStaff = (
      await control().platformUser.findMany({
        select: { email: true },
        orderBy: { email: "asc" },
      })
    ).map((u) => u.email);
    ok("A's staff are B's now; B's bootstrap owner is gone", JSON.stringify(bStaff) === JSON.stringify(aControl.staff), bStaff);
    ok("  and A's sessions are gone, B's own too", (await control().platformSession.count()) === 0);
    ok("the warm pool and job leases from A are cleared", (await control().warmDatabase.count()) === 0 && (await control().tenantJobLease.count()) === 0);
    const settings = await control().platformSetting.findMany({
      where: { key: { in: ["storage.container", "offsite.provider"] } },
    });
    ok("B's own storage box setting kept; A's off-site store not carried over", settings.length === 1 && settings[0]!.value === "zz-b-container", settings);
    ok("the backup it came from is listed in the restored control plane", !!(await control().platformBackup.findUnique({ where: { id: fullOnB } })));
    const log = (bRun?.log ?? []) as { message: string }[];
    ok(
      "the log says what to set by hand and how to reload the reference data",
      log.some((l) => /npm run db:reference/.test(l.message)) && log.some((l) => /safety copy of this server's control plane taken/i.test(l.message)),
      log.map((l) => l.message).slice(-6),
    );
    ok("the safety dump of B's control plane is on disk, encrypted", !!bRun?.safetyPath && (await exists(bRun.safetyPath)) && (await atRest.isSealedFile(bRun.safetyPath)));

    // ─── 3. A workspace restored in place on A ───────────────────────────────────────────────────
    section("3. A workspace restored in place (A)");
    await switchTo(A);
    await signIn(aOwner);
    ok("  a fresh code", (await stepUp()).ok);
    const oneOnA = await uploadTo(wsOneOnA.file, aOwner);
    const one = (await registry.tenantById(W1))!;
    // After the backup: data changed, a file of the backup's deleted, a newer file added, a record changed.
    const changed = await runAsTenant(one, async () => {
      await db.company.create({
        data: {
          name: "Added after the backup",
          normalizedName: "added after",
          createdById: fixtures[W1]!.userId,
          ownerUserId: fixtures[W1]!.userId,
          relationshipType: "CLIENT",
        } as never,
      });
      await db.user.update({
        where: { id: fixtures[W1]!.userId },
        data: { name: "Renamed after the backup" },
      });
      await db.lead.deleteMany({ where: { title: "Second lead for zzrsone" } });
      const newer = await files.keepDataUrl("employee-documents", `data:application/pdf;base64,${randomBytes(3000).toString("base64")}`);
      return { newer };
    });
    const docKey = files.storedRef(fixtures[W1]!.doc)!.key;
    const boxRoot = (await boxLib.storageBox())!;
    await boxRoot.remove(`workspaces/${W1}/files/${docKey}`);
    files.forgetRememberedFiles();
    await control().tenant.update({
      where: { id: W1 },
      data: { billingName: "Changed after the backup" },
    });
    await control().tenantNote.updateMany({
      where: { tenantId: W1 },
      data: { body: "note changed after the backup" },
    });
    await control().tenantNote.create({
      data: {
        tenantId: W1,
        authorId: aOwner,
        body: "a note added after the backup",
      },
    });
    const plan3 = await actions.consoleRestorePlan(oneOnA);
    ok(
      "the wizard's plan: in place, confirmed with its slug, warning what is replaced",
      plan3.ok && plan3.data.mode === "IN_PLACE" && plan3.data.confirmText === "zzrsone" && /replaced by the backup/.test(plan3.data.warning ?? ""),
      plan3,
    );
    const inPlace = await startRestore(oneOnA, "zzrsone");
    const run3 = await lastRun();
    ok("restored in place: SUCCEEDED", inPlace.ok && run3?.status === "SUCCEEDED" && run3.mode === "IN_PLACE", { inPlace, status: run3?.status, error: run3?.error, log: run3?.log });
    files.forgetRememberedFiles();
    registry.forgetRegistry();
    const back = await tableCounts(w1Db.url, ["backups"]);
    const want = { ...aCounts[W1]! };
    delete want.backups;
    ok("every table back to the backup's row counts", Object.keys(countsDiffer(want, back)).length === 0, countsDiffer(want, back));
    const after3 = await runAsTenant((await registry.tenantById(W1))!, async () => ({
      name: (
        await db.user.findUnique({
          where: { id: fixtures[W1]!.userId },
          select: { name: true },
        })
      )?.name,
      added: await db.company.count({
        where: { name: "Added after the backup" },
      }),
      doc: await files.dataUrlOf(fixtures[W1]!.doc).catch(() => "missing"),
      newer: await files.storedFile(changed.newer).then(
        (f) => !!f,
        () => false,
      ),
      safetyListed: await db.backup.count({
        where: { reason: { startsWith: "Before restoring" } } as never,
      }),
    }));
    ok("  the changed row is as it was in the backup, the added one gone", after3.name === "Owner zzrsone" && after3.added === 0, after3);
    ok("  the file deleted after the backup is back; the file added since is kept", after3.doc === fixtures[W1]!.docUrl && after3.newer === true);
    ok("  the safety copy is listed among its backups", after3.safetyListed >= 1);
    ok("  the safety copy and its control snapshot are on disk", !!run3?.safetyPath && (await exists(run3.safetyPath)) && (await exists(`${run3.safetyPath}.control.json`)));
    const snap = controlRows.decodeControlRows(atRest.openBuffer(W1, await readFile(`${run3!.safetyPath}.control.json`), "file"));
    ok("  the snapshot opens: the workspace's records as they were before the restore", snap.models.Tenant?.[0]?.billingName === "Changed after the backup");
    ok("  its records were left as they are by default", (await control().tenant.findUniqueOrThrow({ where: { id: W1 } })).billingName === "Changed after the backup");
    ok("  and it is open again", !maintenance.restoreInProgressFor(one));

    ok("  a fresh code for the next", (await stepUp()).ok);
    const withRecords = await startRestore(oneOnA, "zzrsone", {
      putBackControlRows: true,
    });
    const run3b = await lastRun();
    const notes = await control().tenantNote.findMany({
      where: { tenantId: W1 },
      orderBy: { createdAt: "asc" },
    });
    ok("with “also put back its records”: SUCCEEDED", withRecords.ok && run3b?.status === "SUCCEEDED", { status: run3b?.status, error: run3b?.error });
    ok(
      "  its billing record and note back as backed up; the note added since kept; nothing duplicated",
      (await control().tenant.findUniqueOrThrow({ where: { id: W1 } })).billingName === "Zz One Pvt Ltd" &&
        notes.length === 2 &&
        notes[0]!.body === "note on one, as backed up" &&
        notes[1]!.body === "a note added after the backup",
      notes.map((n) => n.body),
    );
    ok(
      "  audited",
      (await control().platformAuditLog.count({
        where: { action: "restore.control-rows", tenantId: W1 },
      })) === 1,
    );

    // Failures made on purpose: in pg_restore, and after its records were put back.
    for (const [point, records] of [
      ["workspace:after-restore", false],
      ["workspace:after-control-rows", true],
    ] as const) {
      await runAsTenant((await registry.tenantById(W1))!, async () => {
        await db.user.update({
          where: { id: fixtures[W1]!.userId },
          data: { name: `Before the failing restore (${point})` },
        });
        await db.company.create({
          data: {
            name: `Kept through ${point}`,
            normalizedName: `kept ${point}`,
            createdById: fixtures[W1]!.userId,
            ownerUserId: fixtures[W1]!.userId,
            relationshipType: "CLIENT",
          } as never,
        });
      });
      await control().tenant.update({
        where: { id: W1 },
        data: { billingName: `Billing before ${point}` },
      });
      await control().tenantNote.deleteMany({
        where: { tenantId: W1, body: "a note added after the backup" },
      });
      const notesBefore = await control().tenantNote.findMany({
        where: { tenantId: W1 },
        select: { id: true, body: true },
        orderBy: { id: "asc" },
      });
      // A note of the backup's that isn't here now: the restore inserts it, and the rollback must take it away again.
      await control().tenantNote.deleteMany({
        where: { tenantId: W1, body: "note on one, as backed up" },
      });
      const notesNow = await control().tenantNote.findMany({
        where: { tenantId: W1 },
        select: { id: true, body: true },
        orderBy: { id: "asc" },
      });
      const before = await tableCounts(w1Db.url, ["backups"]);
      ok(`  a fresh code (${point})`, (await stepUp()).ok);
      restore.setRestoreFaultForChecks(point);
      const failing = await startRestore(oneOnA, "zzrsone", {
        putBackControlRows: records,
      });
      restore.setRestoreFaultForChecks(null);
      registry.forgetRegistry();
      const run = await lastRun();
      const now = await tableCounts(w1Db.url, ["backups"]);
      const state = await runAsTenant((await registry.tenantById(W1))!, async () => ({
        name: (
          await db.user.findUnique({
            where: { id: fixtures[W1]!.userId },
            select: { name: true },
          })
        )?.name,
        kept: await db.company.count({
          where: { name: `Kept through ${point}` },
        }),
      }));
      ok(
        `a failure made in ${point === "workspace:after-restore" ? "pg_restore" : "the last step, after its records were put back"}: ROLLED_BACK, saying why`,
        failing.ok && run?.status === "ROLLED_BACK" && /made on purpose/.test(run.error ?? "") && /Nothing was lost/.test(run.error ?? ""),
        { status: run?.status, error: run?.error },
      );
      ok("  every table back to exactly the state before it", Object.keys(countsDiffer(before, now)).length === 0, countsDiffer(before, now));
      ok("  the row changed just before it is as it was", state.name === `Before the failing restore (${point})` && state.kept === 1, state);
      const tenantAfter = await control().tenant.findUniqueOrThrow({
        where: { id: W1 },
      });
      const notesAfter = await control().tenantNote.findMany({
        where: { tenantId: W1 },
        select: { id: true, body: true },
        orderBy: { id: "asc" },
      });
      ok("  its records as they were before it", tenantAfter.billingName === `Billing before ${point}` && JSON.stringify(notesAfter) === JSON.stringify(notesNow), {
        billing: tenantAfter.billingName,
        notesAfter,
        notesNow,
        notesBefore,
      });
      ok("  the workspace open again", !maintenance.restoreInProgressFor((await registry.tenantById(W1))!));
    }

    // ─── 4. A workspace added as new on D, by the real worker ────────────────────────────────────
    section("4. A workspace added as new on another fresh install (D), by the worker process");
    await switchTo(D);
    const dOwner = await addStaff("OWNER", "bootstrap@zzrestore-d.example");
    await signIn(dOwner);
    ok("  a fresh code", (await stepUp()).ok);
    const twoOnD = await uploadTo(wsTwoOnA.file, dOwner);
    const plan4 = await actions.consoleRestorePlan(twoOnD);
    ok("the wizard's plan: added as new", plan4.ok && plan4.data.mode === "AS_NEW" && plan4.data.confirmText === "zzrstwo", plan4);
    // First a failure made after its records went in: everything it added taken away again.
    const dBeforeFail = { tenants: await control().tenant.count(), plans: await control().plan.count(), dbs: await wDatabases(), box: await filesIn(D.box) };
    restore.setRestoreFaultForChecks("as-new:after-control-rows");
    const failingNew = await startRestore(twoOnD, "zzrstwo");
    restore.setRestoreFaultForChecks(null);
    const failedNew = await lastRun();
    ok("a failure made after its records went in: ROLLED_BACK, saying why", failingNew.ok && failedNew?.status === "ROLLED_BACK" && /made on purpose/.test(failedNew.error ?? "") && /Nothing was kept/.test(failedNew.error ?? ""), { status: failedNew?.status, error: failedNew?.error });
    ok(
      "  its new database dropped, its records and files taken away",
      (await control().tenant.count()) === dBeforeFail.tenants &&
        (await control().plan.count()) === dBeforeFail.plans &&
        JSON.stringify(await wDatabases()) === JSON.stringify(dBeforeFail.dbs) &&
        JSON.stringify(await filesIn(D.box)) === JSON.stringify(dBeforeFail.box),
      { dbs: await wDatabases(), box: (await filesIn(D.box)).length },
    );
    ok("  a fresh code", (await stepUp()).ok);
    jobs.setWorkerSpawnerForChecks(null); // the real worker, a process of its own
    const asNew = await actions.consoleStartRestore({
      backupId: twoOnD,
      passphrase: PASS,
      confirm: "zzrstwo",
    });
    const asNewId = asNew.ok ? asNew.data.runId : "";
    let run4 = null as Awaited<ReturnType<typeof lastRun>>;
    for (const until = Date.now() + 10 * 60_000; Date.now() < until; ) {
      run4 = await control().restoreRun.findUnique({ where: { id: asNewId } });
      if (run4?.status !== "RUNNING") break;
      await new Promise((r) => setTimeout(r, 500));
    }
    inProcess();
    registry.forgetRegistry();
    files.forgetRememberedFiles();
    ok("added as new by the worker process: SUCCEEDED", asNew.ok && run4?.status === "SUCCEEDED" && run4.mode === "AS_NEW", { asNew, status: run4?.status, error: run4?.error, log: run4?.log });
    const two = await registry.tenantById(W2);
    const dTenant = await control().tenant.findUnique({
      where: { id: W2 },
      include: {
        subscriptions: { include: { items: { include: { plan: true } } } },
        domains: true,
      },
    });
    ok(
      "  the workspace, ACTIVE, with a sealed address of D's own (a new database)",
      !!two && two.status === "ACTIVE" && !!dTenant?.dbName && dTenant.dbName !== names.a2 && (await wDatabases()).includes(dTenant.dbName),
      { status: two?.status, dbName: dTenant?.dbName },
    );
    ok("  its plan and subscription came with it", dTenant?.subscriptions.length === 1 && dTenant.subscriptions[0]!.items[0]?.plan.key === "zz-restore-plan");
    ok("  its entitlements worked out here", JSON.stringify(dTenant?.entitlements) === JSON.stringify(aControl.tenants.find((t) => t.id === W2)?.entitlements));
    const twoCounts = await tableCounts(two!.dbUrl);
    ok("  every table's row count as on A", Object.keys(countsDiffer(aCounts[W2]!, twoCounts)).length === 0, countsDiffer(aCounts[W2]!, twoCounts));
    const twoFiles = await runAsTenant(two!, async () => ({
      doc: await files.dataUrlOf(fixtures[W2]!.doc).catch(() => "missing"),
      photo: await files.dataUrlOf(fixtures[W2]!.photo).catch(() => "missing"),
    }));
    ok("  its files open on D", twoFiles.doc === fixtures[W2]!.docUrl && twoFiles.photo === fixtures[W2]!.photoUrl);
    // The first workspace's backup, whose address name is taken here by another workspace.
    await control().tenant.create({
      data: tenantRow(randomUUID(), "zzrsone", withDatabase(url, names.wsTpl), names.wsTpl),
    });
    const oneOnD = await uploadTo(wsOneOnA.file, dOwner);
    const dBefore = {
      control: await tableCounts(D.control, ["restore_runs", "platform_audit_log", "platform_backups", "platform_sessions"]),
      dbs: await wDatabases(),
    };
    ok("  a fresh code", (await stepUp()).ok);
    const clash = await startRestore(oneOnD, "zzrsone");
    const clashRun = await lastRun();
    ok(
      "a backup whose address name is taken here: refused, naming the workspace",
      clashRun?.status === "FAILED" && /address name “zzrsone” is already used on this server/.test(clashRun.error ?? ""),
      { clash, error: clashRun?.error },
    );
    ok(
      "  nothing changed",
      Object.keys(countsDiffer(dBefore.control, await tableCounts(D.control, ["restore_runs", "platform_audit_log", "platform_backups", "platform_sessions"]))).length === 0 &&
        JSON.stringify(dBefore.dbs) === JSON.stringify(await wDatabases()),
    );

    // ─── 5. A full restore onto C, which isn't fresh ─────────────────────────────────────────────
    section("5. The whole application restored onto a server that isn't fresh (C)");
    await switchTo(C);
    const cOwner = await addStaff("OWNER", "owner@zzrestore-c.example");
    const C1 = randomUUID();
    const c1Url = withDatabase(url, names.c1);
    await control().tenant.create({
      data: tenantRow(C1, "zzrscown", c1Url, names.c1),
    });
    const c1Before = await tableCounts(c1Url);
    await signIn(cOwner);
    const fullOnC = await uploadTo(fullOnA.file, cOwner);
    const plan5 = await actions.consoleRestorePlan(fullOnC);
    ok("the wizard warns prominently that this server holds workspaces", plan5.ok && /not a fresh install: it has 1 workspace \(zzrscown\)/.test(plan5.data.warning ?? ""), plan5);
    const cBefore = {
      control: await controlCounts(C),
      staff: (await control().platformUser.findMany({ select: { email: true } })).map((u) => u.email),
      dbs: await wDatabases(),
    };
    ok("  a fresh code", (await stepUp()).ok);
    restore.setRestoreFaultForChecks("full:after-control-restore");
    const failingFull = await actions.consoleStartRestore({
      backupId: fullOnC,
      passphrase: PASS,
      confirm: "RESTORE EVERYTHING",
    });
    await pending;
    restore.setRestoreFaultForChecks(null);
    registry.forgetRegistry();
    const failedRun = failingFull.ok
      ? await control().restoreRun.findUnique({
          where: { id: failingFull.data.runId },
        })
      : null;
    ok("a failure made after the control plane was replaced: ROLLED_BACK, saying why", failedRun?.status === "ROLLED_BACK" && /made on purpose/.test(failedRun.error ?? ""), {
      status: failedRun?.status,
      error: failedRun?.error,
    });
    const cAfterFail = {
      control: await controlCounts(C),
      staff: (await control().platformUser.findMany({ select: { email: true } })).map((u) => u.email),
      dbs: await wDatabases(),
    };
    ok(
      "  C's control plane is back exactly as it was: its staff, its workspace, every table",
      Object.keys(countsDiffer(cBefore.control, cAfterFail.control)).length === 0 && JSON.stringify(cAfterFail.staff) === JSON.stringify(cBefore.staff),
      countsDiffer(cBefore.control, cAfterFail.control),
    );
    ok(
      "  no database left behind; the application open again",
      JSON.stringify(cAfterFail.dbs) === JSON.stringify(cBefore.dbs) &&
        !status.activeFullRestore() &&
        status.publicRestoreStatus(failingFull.ok ? failingFull.data.runId : "x").state === "rolled-back",
    );
    ok("  a fresh code", (await stepUp()).ok);
    const fullC = await startRestore(fullOnC, "RESTORE EVERYTHING");
    const cRun = fullC.ok
      ? await control().restoreRun.findUnique({
          where: { id: fullC.data.runId },
        })
      : null;
    ok("then a full restore onto C: SUCCEEDED", cRun?.status === "SUCCEEDED", {
      fullC,
      status: cRun?.status,
      error: cRun?.error,
    });
    ok(
      "  C's own workspace database untouched — every table as it was",
      (await tableCounts(c1Url).then((x) => Object.keys(countsDiffer(c1Before, x)).length === 0)) &&
        (await admin.$queryRawUnsafe<unknown[]>(`SELECT 1 FROM pg_database WHERE datname = '${names.c1}'`)).length === 1,
    );
    ok(
      "  and named in the run, for an owner to drop later",
      JSON.stringify(cRun?.outcomes ?? {}).includes(names.c1) && ((cRun?.log ?? []) as { message: string }[]).some((l) => l.message.includes(names.c1)),
    );
    ok("  the control plane's safety dump is on disk", !!cRun?.safetyPath && (await exists(cRun.safetyPath)) && cRun.safetyPath.includes(path.join("platform", "restore-safety")));
    ok(
      "  C's console is the backup's: A's workspaces and staff",
      (await control().tenant.count({ where: { id: { in: [W1, W2] } } })) === 2 && (await control().tenant.count({ where: { id: C1 } })) === 0,
    );

    // One workspace that can't be restored doesn't stop the others: it is left suspended, the run says which.
    await signIn(aOwner); // C's staff are A's now
    ok("  a fresh code, as one of the backup's staff", (await stepUp()).ok);
    restore.setRestoreFaultForChecks("full:workspace:zzrstwo");
    const partial = await startRestore(fullOnC, "RESTORE EVERYTHING");
    restore.setRestoreFaultForChecks(null);
    registry.forgetRegistry();
    const partialRun = partial.ok ? await control().restoreRun.findUnique({ where: { id: partial.data.runId } }) : null;
    const twoOnC = await control().tenant.findUnique({ where: { id: W2 } });
    const oneOnC = await control().tenant.findUnique({ where: { id: W1 } });
    ok("a workspace that fails in a full restore: the run ends FAILED, “Partly restored: 1 of 2”, naming it", partialRun?.status === "FAILED" && /Partly restored: 1 of 2/.test(partialRun.error ?? "") && /zzrstwo/.test(partialRun.error ?? ""), { status: partialRun?.status, error: partialRun?.error });
    ok("  it is left suspended with no database; the other is restored and open", twoOnC?.status === "SUSPENDED" && twoOnC.dbUrlCipher === null && oneOnC?.status === "ACTIVE" && !!oneOnC.dbName && (await wDatabases()).includes(oneOnC.dbName));
    ok("  the application open again, the status page saying so", !status.activeFullRestore() && status.publicRestoreStatus(partial.ok ? partial.data.runId : "x").state === "partial");

    // ─── The proxy's page and the docs ───────────────────────────────────────────────────────────
    section("The status page, the script, the runbook");
    const proxySource = await readFile(path.join(process.cwd(), "src", "proxy.ts"), "utf8");
    ok(
      "the proxy holds every request while a full restore runs, before any database is read",
      /const held = wholeApplicationRestore\(args\[0\] as NextRequest\);\s*if \(held\) return held;\s*const handler = await withSession;/.test(proxySource),
    );
    const pkg = JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as { scripts: Record<string, string> };
    ok("check:bundle-restore is registered", pkg.scripts["check:bundle-restore"] === "tsx scripts/check-bundle-restore.ts");
    const runbook = await readFile(path.join(process.cwd(), "docs", "runbook.md"), "utf8");
    ok("the runbook has the fresh-install recipe", /same `PLATFORM_MASTER_KEY`/i.test(runbook) && /RESTORE EVERYTHING/.test(runbook) && /npm run bundle -- restore/.test(runbook));
    // The script refuses without --i-understand, and says what it would do.
    const cli = execSync(`node node_modules/tsx/dist/cli.mjs scripts/bundle.ts restore ${JSON.stringify(fullOnA.file)} 2>&1 || true`, {
      env: { ...process.env, BUNDLE_PASSPHRASE: PASS },
      encoding: "utf8",
    });
    ok("npm run bundle -- restore refuses without --i-understand, saying what it replaces", /Add --i-understand to go ahead/.test(cli), cli.slice(0, 300));
    await copyFile(fullOnA.file, path.join(scratch, "unused.dzbk")).catch(() => {});
  } finally {
    process.env.PLATFORM_MASTER_KEY = realKey;
    await cleanup?.().catch(() => {});
    for (const n of Object.values(names)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${n}" WITH (FORCE)`).catch(() => {});
    for (const { datname } of await admin.$queryRawUnsafe<{ datname: string }[]>(`SELECT datname::text AS datname FROM pg_database WHERE datname LIKE 'w\\_%'`)) {
      if (!dbsBefore.has(datname)) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${datname}" WITH (FORCE)`).catch(() => {});
    }
    for (const { rolname } of await admin.$queryRawUnsafe<{ rolname: string }[]>(`SELECT rolname::text AS rolname FROM pg_roles WHERE rolname LIKE 'w\\_%'`)) {
      if (!rolesBefore.has(rolname)) await admin.$executeRawUnsafe(`DROP ROLE IF EXISTS "${rolname}"`).catch(() => {});
    }
    await admin.$disconnect().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
    ok("the scratch databases, roles and folders are removed", true);
  }

  console.log(`\n${failures ? `${passes} passed, ${failures} FAILED` : `All ${passes} bundle restore checks passed.`}`);
  process.exitCode = failures ? 1 : 0;
  setTimeout(() => process.exit(), 2000).unref();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
  setTimeout(() => process.exit(), 2000).unref();
});
