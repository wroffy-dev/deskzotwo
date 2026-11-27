/**
 * check:bundle — Backup & Restore bundles (src/lib/bundle; owner, 26 Nov 2026):
 *
 *   1. The format: a round trip of several entries, one of them multi-MB and streamed; the header readable without the
 *      passphrase; a wrong passphrase refused before any of the body is read; a flipped byte anywhere in the body, a
 *      truncated file, a removed frame, a swapped frame, an altered header, bytes appended — each refused, saying why;
 *      an entry that disagrees with the manifest refused even when every frame is validly sealed.
 *   2. The DMMF guard: the real control schema is fully decided; a new model hanging off Tenant, a new tenant column,
 *      or a new relation out of an exported model fails until it is exported or excluded.
 *   3. A workspace bundle, from a scratch control plane and scratch workspace databases built from their migrations, a
 *      folder as the storage box, and support files on disk: its dump (pg_restore --list reads it), its control.json
 *      (Tenant without dbUrlCipher, subscriptions, items, their plans; nothing excluded), every box and support file
 *      with matching sha256, never staging/, and nothing of the other workspace.
 *   4. A full bundle: the control plane's dump, each workspace's entries — a suspended one too, never a closed one —
 *      and the header listing every workspace with its schema version. The master key's fingerprint changes with the
 *      key and never reveals it.
 *   5. Memory: a bundle with a 200 MB file in the box is built and verified with the process's RSS rising far less.
 */
import "dotenv/config";
import { createHash, randomBytes, randomUUID, createCipheriv, createDecipheriv, hkdfSync } from "node:crypto";
import { execFileSync, execSync } from "node:child_process";
import { createWriteStream, readdirSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import Module from "node:module";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
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
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const PASS = "correct horse battery staple";

/** Deterministic bytes, streamed in pieces — never the whole thing at once. */
function streamOf(total: number, seed: number, piece = 64 * 1024): { stream: Readable; sha256: Promise<string> } {
  const hash = createHash("sha256");
  let resolve!: (s: string) => void;
  const sha256 = new Promise<string>((r) => (resolve = r));
  const stream = Readable.from(
    (function* () {
      let left = total;
      let n = seed;
      while (left > 0) {
        const size = Math.min(piece, left);
        const b = Buffer.alloc(size);
        for (let i = 0; i < size; i += 4) {
          n = (Math.imul(n, 1664525) + 1013904223) >>> 0;
          b.writeUInt32LE(n, i - (i + 4 > size ? i + 4 - size : 0));
        }
        hash.update(b);
        left -= size;
        yield b;
      }
      resolve(hash.digest("hex"));
    })(),
  );
  return { stream, sha256 };
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url || !process.env.PLATFORM_MASTER_KEY) throw new Error("DATABASE_URL and PLATFORM_MASTER_KEY are needed.");
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host)) throw new Error("not a local database");
  const realName = new URL(url).pathname.slice(1);
  const scratch = await mkdtemp(path.join(os.tmpdir(), "deskzo-bundle-"));

  /* eslint-disable @typescript-eslint/no-require-imports */
  const format = require("../src/lib/bundle/format") as typeof import("../src/lib/bundle/format");
  const rows = require("../src/lib/bundle/control-rows") as typeof import("../src/lib/bundle/control-rows");
  const archive = require("../src/lib/backup/archive") as typeof import("../src/lib/backup/archive");
  /* eslint-enable @typescript-eslint/no-require-imports */

  // ─── 1 ─────────────────────────────────────────────────────────────────────────────────────────
  section("1. The format");
  const headerInput = (over: Partial<import("../src/lib/bundle/format").BundleHeaderInput> = {}): import("../src/lib/bundle/format").BundleHeaderInput => ({
    kind: "workspace",
    createdAt: new Date().toISOString(),
    createdBy: "script:check",
    app: { name: "Deskzo One", version: "0.1.0", commit: null },
    control: null,
    workspaces: [{ id: "ws1", slug: "zz-one", name: "Zz One", schemaVersion: "20260101000000_x" }],
    keyFingerprint: "pk1:00000000000000000000000000000000",
    ...over,
  });

  /** Writes a bundle of these entries, each streamed; returns the file and every entry's sha256 and size. */
  async function writeBundle(file: string, entries: { name: string; size: number; seed: number }[], frameSize?: number) {
    const out = createWriteStream(file);
    const writer = await format.createBundleWriter(out, headerInput(), PASS, { frameSize });
    const expected = new Map<string, { size: number; sha256: string }>();
    for (const e of entries) {
      const { stream, sha256 } = streamOf(e.size, e.seed);
      const got = await writer.addEntry(e.name, stream);
      expected.set(e.name, { size: e.size, sha256: await sha256 });
      if (got.sha256 !== expected.get(e.name)!.sha256) throw new Error("the writer hashed differently");
    }
    await writer.finish({ counts: { custom: 7 } });
    return expected;
  }

  const roundFile = path.join(scratch, "round.dzbk");
  const ENTRIES = [
    { name: "workspaces/ws1/db.dump", size: 6 * MB + 12345, seed: 1 },
    { name: "workspaces/ws1/control.json", size: 2000, seed: 2 },
    { name: "workspaces/ws1/box/files/doc/2026-11/aaaa", size: 300_001, seed: 3 },
    { name: "workspaces/ws1/empty", size: 0, seed: 4 },
  ];
  const expected = await writeBundle(roundFile, ENTRIES);
  const header = await format.readBundleHeader(roundFile);
  ok("the header reads without the passphrase", header.kind === "workspace" && header.workspaces[0]?.slug === "zz-one" && header.keyFingerprint?.startsWith("pk1:") === true && header.frameSize === format.DEFAULT_FRAME_SIZE);
  ok("  and says nothing secret: no key, no passphrase", !JSON.stringify(header).includes(PASS) && !("key" in header));
  const got = new Map<string, { size: number; sha256: string }>();
  const read = await format.readBundle(roundFile, PASS, async (name, content) => {
    const h = createHash("sha256");
    let size = 0;
    for await (const c of content) {
      h.update(c as Buffer);
      size += (c as Buffer).length;
    }
    got.set(name, { size, sha256: h.digest("hex") });
  });
  ok("every entry comes back, in order, byte for byte (a 6 MB one streamed through)", [...got.keys()].join() === ENTRIES.map((e) => e.name).join() && ENTRIES.every((e) => got.get(e.name)?.sha256 === expected.get(e.name)!.sha256 && got.get(e.name)?.size === e.size));
  ok("  the manifest lists them with sizes and hashes, and the builder's counts", read.manifest.entries.length === 4 && read.manifest.counts.entries === 4 && read.manifest.counts.custom === 7 && read.manifest.entries.every((e) => expected.get(e.name)?.sha256 === e.sha256));
  const partial = await format.readBundle(roundFile, PASS, async (name, content) => {
    // A consumer that reads only the first chunk of each entry: the rest is read and checked anyway.
    const first = await content[Symbol.asyncIterator]().next();
    void first;
  }).then(() => true, () => false);
  ok("  a consumer that reads only part of an entry doesn't upset the next", partial);
  const v = await format.verifyBundle(roundFile, PASS);
  ok("verifyBundle: sound", v.ok && v.problems.length === 0 && v.manifest?.counts.entries === 4, v.problems);

  const wrong = await format.readBundle(roundFile, "not the passphrase at all", () => {}).then(() => null, (e: unknown) => e);
  ok("a wrong passphrase is refused as a wrong passphrase", wrong instanceof archive.PassphraseError && /passphrase does not open this bundle/.test((wrong as Error).message), String(wrong));
  // Proved before the body: a stream that notes when anything past the header is pulled from it.
  const whole = await readFile(roundFile);
  const bodyStart = 13 + whole.readUInt32BE(9);
  let bodyTouched = false;
  // A bare async iterable (as an upload's body is), so no stream reads ahead of what the reader asks for.
  const guarded = (async function* () {
    yield whole.subarray(0, bodyStart);
    bodyTouched = true;
    yield whole.subarray(bodyStart);
  })();
  const early = await format.readBundle(guarded, "not the passphrase at all", () => {}).then(() => null, (e: unknown) => e);
  ok("  before a byte of the body is read", early instanceof archive.PassphraseError && !bodyTouched);
  const headerOnly = path.join(scratch, "header-only.dzbk");
  await writeFile(headerOnly, whole.subarray(0, bodyStart));
  const hoWrong = await format.verifyBundle(headerOnly, "not the passphrase at all");
  const hoRight = await format.verifyBundle(headerOnly, PASS);
  ok("  a file cut after its header: wrong passphrase still says passphrase; the right one says cut short", /passphrase/.test(hoWrong.problems[0] ?? "") && /nothing after its header/.test(hoRight.problems[0] ?? ""), [hoWrong.problems[0], hoRight.problems[0]]);

  // Tampering, on a bundle with small frames so there are many.
  const tamperFile = path.join(scratch, "tamper.dzbk");
  const FRAME = 4096;
  await writeBundle(tamperFile, [{ name: "a", size: 50_000, seed: 5 }, { name: "b", size: 30_000, seed: 6 }], FRAME);
  const base = await readFile(tamperFile);
  const start = 13 + base.readUInt32BE(9);
  const frameBytes = 4 + FRAME + 16;
  const frames = Math.ceil((base.length - start) / frameBytes);
  ok("the tampering bundle is sound to start with, over many frames", (await format.verifyBundle(tamperFile, PASS)).ok && frames > 15, frames);
  const variant = async (label: string, bytes: Buffer, expect: RegExp) => {
    const f = path.join(scratch, `variant-${randomBytes(3).toString("hex")}.dzbk`);
    await writeFile(f, bytes);
    const r = await format.verifyBundle(f, PASS);
    ok(label, !r.ok && expect.test(r.problems.join(" | ")), r.problems.join(" | "));
    await rm(f, { force: true });
  };
  const flip = (at: number) => {
    const b = Buffer.from(base);
    b[at] = b[at]! ^ 0x01;
    return b;
  };
  await variant("a flipped byte in a frame's ciphertext: that frame fails its integrity check", flip(start + 3 * frameBytes + 4 + 100), /Frame 4 failed its integrity check/);
  await variant("a flipped byte in a frame's tag", flip(start + 2 * frameBytes - 3), /Frame 2 failed its integrity check/);
  await variant("a flipped byte in a frame's length", flip(start + 5 * frameBytes + 2), /Frame 6 (claims|is short)|Frame 6 failed|truncated/);
  await variant("a flipped byte in the final frame", flip(base.length - 20), new RegExp(`Frame ${frames} failed its integrity check`));
  let everyFlip = true;
  const flipMisses: number[] = [];
  for (let i = 0; i < 40; i++) {
    const at = start + Math.floor(Math.random() * (base.length - start));
    const f = path.join(scratch, "flip.dzbk");
    await writeFile(f, flip(at));
    const r = await format.verifyBundle(f, PASS);
    if (r.ok || !r.problems.length) {
      everyFlip = false;
      flipMisses.push(at);
    }
  }
  ok("  40 more flipped bytes at random places in the body: every one refused", everyFlip, flipMisses);
  await variant("truncated at a frame boundary (the final frame removed): refused as truncated", base.subarray(0, start + (frames - 1) * frameBytes), /final frame is missing|truncated/);
  await variant("truncated in the middle of a frame", base.subarray(0, start + 7 * frameBytes + 500), /truncated inside frame 8/);
  const removed = Buffer.concat([base.subarray(0, start + 4 * frameBytes), base.subarray(start + 5 * frameBytes)]);
  await variant("a frame removed from the middle", removed, /Frame 5 failed .*removed or reordered/);
  const swapped = Buffer.concat([base.subarray(0, start + 2 * frameBytes), base.subarray(start + 3 * frameBytes, start + 4 * frameBytes), base.subarray(start + 2 * frameBytes, start + 3 * frameBytes), base.subarray(start + 4 * frameBytes)]);
  await variant("two frames swapped", swapped, /Frame 3 failed .*reordered/);
  const headerText = base.subarray(13, start).toString("utf8");
  const alteredHeader = Buffer.concat([base.subarray(0, 13), Buffer.from(headerText.replace('"script:check"', '"script:chekk"'), "utf8"), base.subarray(start)]);
  await variant("an altered header (who made it, same length): the first frame refuses it", alteredHeader, /header was altered/);
  await variant("bytes appended after the final frame", Buffer.concat([base, Buffer.from("trailing")]), /after its final frame|Frame \d+ (failed|is short)/);
  const notBundle = path.join(scratch, "plain.dump");
  await writeFile(notBundle, Buffer.concat([Buffer.from("PGDMP"), Buffer.alloc(100)]));
  ok("a raw pg_dump file is named as one", /raw pg_dump/.test((await format.verifyBundle(notBundle, PASS)).problems[0] ?? ""));

  // Validly sealed, but an entry that disagrees with its manifest — re-sealed here with the format as documented.
  const resealed = await reseal(base, PASS, (plain) => {
    const at = plain.indexOf(Buffer.from([0x44])); // the first data record's type byte, after the first entry's descriptor
    plain[at + 5 + 10] = plain[at + 5 + 10]! ^ 0xff;
  });
  await variant("every frame sealed properly but an entry's bytes changed: refused by the manifest", resealed.bytes, /a does not match the checksum in the manifest/);
  ok("  (the re-sealing in this check opens the untouched bundle, so it is the format as documented)", resealed.untouchedOpened);
  const w = await format.createBundleWriter(createWriteStream(path.join(scratch, "names.dzbk")), headerInput(), PASS);
  const refusedName = await w.addEntry("../etc/passwd", Readable.from([Buffer.from("x")])).then(() => false, () => true);
  await w.addEntry("ok", Readable.from([Buffer.from("x")]));
  const refusedTwice = await w.addEntry("ok", Readable.from([Buffer.from("x")])).then(() => false, () => true);
  ok("the writer refuses a name that climbs out of its folder, and the same name twice", refusedName && refusedTwice);
  await w.finish();
  ok("  and a passphrase shorter than the archive's minimum", await format.createBundleWriter(createWriteStream(path.join(scratch, "short.dzbk")), headerInput(), "short").then(() => false, () => true));

  // ─── 2 ─────────────────────────────────────────────────────────────────────────────────────────
  section("2. The DMMF guard");
  const real = rows.controlDatamodel();
  ok("every model reachable from Tenant, and every tenant column, is decided", rows.controlRowsCoverage(real).length === 0, rows.controlRowsCoverage(real));
  const field = (name: string, type: string, extra: Partial<import("../src/lib/bundle/control-rows").DmmfField> = {}) => ({ name, kind: "scalar", type, isList: false, isId: false, ...extra });
  const widget = {
    name: "TenantWidget",
    fields: [field("id", "String", { isId: true }), field("tenantId", "String"), { name: "tenant", kind: "object", type: "Tenant", isList: false, isId: false, relationFromFields: ["tenantId"], relationToFields: ["id"] }],
  };
  const withWidget = { models: [...real.models, widget] };
  const lists = { exported: rows.EXPORTED, excluded: rows.EXCLUDED, softLinks: rows.SOFT_LINKS, carried: rows.CARRIED, uncarried: rows.UNCARRIED };
  const widgetProblems = rows.controlRowsCoverage(withWidget, lists);
  ok("a new model with a relation to Tenant fails the check", widgetProblems.some((p) => /TenantWidget is reachable from Tenant/.test(p)), widgetProblems);
  ok("  until it is excluded", rows.controlRowsCoverage(withWidget, { ...lists, excluded: { ...rows.EXCLUDED, TenantWidget: "test" } }).length === 0);
  ok("  or exported", rows.controlRowsCoverage(withWidget, { ...lists, exported: { ...rows.EXPORTED, TenantWidget: "test" } }).length === 0);
  const grandchild = { name: "WidgetPart", fields: [field("id", "String", { isId: true }), field("widgetId", "String"), { name: "widget", kind: "object", type: "TenantWidget", isList: false, isId: false, relationFromFields: ["widgetId"], relationToFields: ["id"] }] };
  ok("  and a model hanging off it is noticed too", rows.controlRowsCoverage({ models: [...withWidget.models, grandchild] }, { ...lists, excluded: { ...rows.EXCLUDED, TenantWidget: "t" } }).some((p) => /WidgetPart is reachable/.test(p)));
  const soft = { name: "WidgetLog", fields: [field("id", "String", { isId: true }), field("tenantId", "String")] };
  ok("a new model naming a workspace in a plain column fails the check", rows.controlRowsCoverage({ models: [...real.models, soft] }, lists).some((p) => /WidgetLog.tenantId looks like it names a workspace/.test(p)));
  ok("  until SOFT_LINKS says whether it travels", rows.controlRowsCoverage({ models: [...real.models, soft] }, { ...lists, softLinks: { ...rows.SOFT_LINKS, "WidgetLog.tenantId": { travel: false, why: "t" } } }).length === 0);
  const invoiceWithUser = { models: real.models.map((m) => (m.name === "Invoice" ? { ...m, fields: [...m.fields, field("issuedById", "String"), { name: "issuedBy", kind: "object", type: "PlatformUser", isList: false, isId: false, relationFromFields: ["issuedById"], relationToFields: ["id"] }] } : m)) };
  ok("a new relation from an exported row to a row outside the export fails until it is carried or not", rows.controlRowsCoverage(invoiceWithUser, lists).some((p) => /Invoice.issuedBy points at PlatformUser/.test(p)));

  // ─── 3, 4, 5: real databases ───────────────────────────────────────────────────────────────────
  section("A scratch control plane, two workspaces, a box and support files");
  const controlName = `${realName}_bundle_control`;
  const wsA = `${realName}_bundle_a`;
  const wsB = `${realName}_bundle_b`;
  const wsC = `${realName}_bundle_c`;
  const controlUrl = withDatabase(url, controlName);
  const urlA = withDatabase(url, wsA);
  const urlB = withDatabase(url, wsB);
  const urlC = withDatabase(url, wsC);
  const admin = directClient(withDatabase(url, "postgres"));
  const boxDir = path.join(scratch, "box");
  const supportRoot = path.join(scratch, "support");
  const backupDir = path.join(scratch, "backups");
  const out = path.join(scratch, "out");
  let cleanup: (() => Promise<void>) | null = null;
  const realKey = process.env.PLATFORM_MASTER_KEY!;
  try {
    for (const name of [controlName, wsA, wsB, wsC]) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${controlName}"`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${wsA}"`);
    execSync("npx prisma migrate deploy --config prisma.control.config.ts", { stdio: "pipe", env: { ...process.env, CONTROL_DATABASE_URL: controlUrl }, timeout: 5 * 60_000 });
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: urlA }, timeout: 15 * 60_000 });
    // The other two as copies of the first: the same migrations, without running them three times.
    await admin.$executeRawUnsafe(`CREATE DATABASE "${wsB}" TEMPLATE "${wsA}"`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${wsC}" TEMPLATE "${wsA}"`);
    process.env.CONTROL_DATABASE_URL = controlUrl;
    process.env.DATABASE_URL = urlA;
    for (const k of ["STORAGE_AZURE_CONNECTION_STRING", "STORAGE_AZURE_CONTAINER_URL", "STORAGE_PREFIX", "RECORDINGS_AZURE_CONTAINER_URL", "RECORDINGS_DIR"]) delete process.env[k];
    process.env.STORAGE_DIR = boxDir;
    process.env.SUPPORT_DIR = supportRoot;
    process.env.BACKUP_DIR = backupDir;
    await mkdir(out, { recursive: true });
    ok("a control plane and three workspace databases, from their migrations", true);

    /* eslint-disable @typescript-eslint/no-require-imports */
    const { controlDb, closeControlDb } = require("../src/lib/platform/control-db") as typeof import("../src/lib/platform/control-db");
    const plans = require("../src/lib/platform/plans") as typeof import("../src/lib/platform/plans");
    const keys = require("../src/lib/tenancy/keys") as typeof import("../src/lib/tenancy/keys");
    const kek = require("../src/lib/platform/kek") as typeof import("../src/lib/platform/kek");
    const registry = require("../src/lib/tenancy/registry") as typeof import("../src/lib/tenancy/registry");
    const build = require("../src/lib/bundle/build") as typeof import("../src/lib/bundle/build");
    const { storageBox } = require("../src/lib/storage/box") as typeof import("../src/lib/storage/box");
    /* eslint-enable @typescript-eslint/no-require-imports */
    cleanup = async () => {
      await closeControlDb();
    };
    const control = controlDb();
    const migrationsOf = async (u: string) => {
      const c = directClient(u, { max: 1 });
      try {
        return (await c.$queryRawUnsafe<{ m: string }[]>(`SELECT migration_name AS m FROM "_prisma_migrations" WHERE finished_at IS NOT NULL ORDER BY finished_at DESC, migration_name DESC LIMIT 1`))[0]?.m ?? null;
      } finally {
        await c.$disconnect();
      }
    };
    const wsVersion = await migrationsOf(urlA);
    const controlVersion = await migrationsOf(controlUrl);

    const base = { countries: [] as string[], seats: null, copilotTokens: null, modules: ["tasks"] };
    await plans.savePlan({ ...base, kind: "EDITION", key: "zz-bundle", name: "Zz Bundle", storageMb: 2048, isDefault: true }, "script:check");
    const plan = await control.plan.findUniqueOrThrow({ where: { key: "zz-bundle" } });
    await control.planPrice.create({ data: { planId: plan.id, currency: "INR", interval: "MONTH", amount: 49900 } });
    const partner = await control.partner.create({ data: { slug: "zzbundlepartner", kind: "RESELLER", legalName: "Zz Partner Pvt Ltd", displayName: "Zz Partner", country: "IN", contactName: "Zz", contactEmail: "zz@partner.example", territories: ["IN"], createdBy: "script:check" } });

    const A = randomUUID();
    const B = randomUUID();
    const C = randomUUID();
    const D = randomUUID();
    const tenantRow = (id: string, slug: string, u: string | null, extra: Record<string, unknown> = {}) => ({
      id,
      slug,
      name: slug.toUpperCase(),
      status: "ACTIVE" as const,
      keyBundleCipher: keys.sealKeyBundle(id, keys.newKeyBundle()),
      dbUrlCipher: u ? kek.sealForTenant(id, "db-url", u) : null,
      dbName: u ? new URL(u).pathname.slice(1) : null,
      country: "IN",
      currency: "INR",
      timezone: "Asia/Kolkata",
      ...extra,
    });
    await control.tenant.create({ data: tenantRow(A, "zzbundlea", urlA, { isDefault: true, partnerId: partner.id }) });
    await control.tenant.create({ data: tenantRow(B, "zzbundleb", urlB, { status: "SUSPENDED", suspendedFor: "STAFF", suspendedAt: new Date() }) });
    await control.tenant.create({ data: tenantRow(C, "zzbundlec", null, { status: "DEPROVISIONED", deprovisionedAt: new Date() }) });
    await control.tenant.create({ data: tenantRow(D, "zzbundled", urlC) });
    for (const id of [A, B]) await plans.setWorkspacePlans(id, [{ planKey: "zz-bundle", quantity: 1 }], "script:check");
    await control.tenantNote.create({ data: { tenantId: A, authorId: "staff-1", body: "note for A" } });
    await control.tenantNote.create({ data: { tenantId: B, authorId: "staff-1", body: "note for B" } });
    await control.tenantDomain.create({ data: { tenantId: A, host: "books.zzbundlea.example", kind: "CUSTOM" } });
    const request = await control.supportRequest.create({ data: { tenantId: A, requesterUserId: "u1", requesterName: "Zz", requesterEmail: "zz@a.example", subject: "Help", body: "Please", context: {} } });
    const attachmentId = "att" + randomBytes(8).toString("hex");
    await control.supportAttachment.create({ data: { requestId: request.id, kind: "FILE", filename: "x.pdf", mime: "application/pdf", size: 10, sha256: "0".repeat(64), storageKey: `box:${A}/${request.id}/${attachmentId}` } });
    await control.billingEvent.create({ data: { gateway: "MANUAL", eventId: `zz-${A}`, type: "test", tenantId: A, payload: { n: 1 } } });
    await control.billingEvent.create({ data: { gateway: "MANUAL", eventId: `zz-${B}`, type: "test", tenantId: B, payload: { n: 2 } } });
    await control.automationSentStep.create({ data: { tenantId: A, key: "run-1:step-1" } });
    await control.platformAuditLog.create({ data: { actorKind: "SCRIPT", actor: "script:check", action: "zz.test", tenantId: A } });
    await control.supportAccessGrant.create({ data: { tenantId: A, level: "READONLY", reason: "t", grantedByUserId: "u1", grantedByName: "Zz", expiresAt: new Date(Date.now() + 86_400_000) } });
    await control.tenantUsage.create({ data: { tenantId: A, day: new Date("2026-11-20T00:00:00Z"), seatsUsed: 3, copilotTokens: 0, storageBytes: BigInt("12345678901") } });

    // Each workspace's database has a person of its own.
    for (const [u, who] of [[urlA, "a"], [urlB, "b"]] as const) {
      const c = directClient(u, { max: 1 });
      await c.user.create({ data: { name: `Zz ${who}`, email: `zz-${who}@bundle.example`, passwordHash: "!", role: "SALES" } });
      await c.$disconnect();
    }

    // Files: the box (documents, recordings, support), support files still on disk, and an upload still in staging.
    const box = (await storageBox())!;
    const files = new Map<string, Buffer>();
    const put = async (key: string, bytes: Buffer) => {
      await box.put(key, bytes);
      files.set(key, bytes);
    };
    await put(`workspaces/${A}/files/employee-documents/2026-11/${"a".repeat(24)}`, randomBytes(70_000));
    await put(`workspaces/${A}/files/task-attachments/2026-11/${"b".repeat(24)}`, randomBytes(1234));
    await put(`workspaces/${A}/recordings/2026/11/call-1.m4a`, randomBytes(50_000));
    await put(`support/${A}/${request.id}/${attachmentId}`, randomBytes(9_999));
    await put(`workspaces/${B}/files/employee-documents/2026-11/${"c".repeat(24)}`, randomBytes(5_000));
    await put(`support/${B}/req${randomBytes(6).toString("hex")}/att${randomBytes(6).toString("hex")}`, randomBytes(100));
    await put(`offsite/backups/control/deskzo-control-2026-11-20-000000.dump`, randomBytes(2000));
    const diskReq = "req" + randomBytes(8).toString("hex");
    const diskAtt = "att" + randomBytes(8).toString("hex");
    const diskBytes = randomBytes(4321);
    await mkdir(path.join(supportRoot, A, diskReq), { recursive: true });
    await writeFile(path.join(supportRoot, A, diskReq, diskAtt), diskBytes);
    await mkdir(path.join(supportRoot, A, "staging"), { recursive: true });
    await writeFile(path.join(supportRoot, A, "staging", "upload1234567890"), randomBytes(10));

    /** Every entry of a bundle, with its bytes — the small ones; dumps written to files. */
    const entriesOf = async (file: string) => {
      const map = new Map<string, Buffer>();
      const dumps = new Map<string, string>();
      await format.readBundle(file, PASS, async (name, content) => {
        if (name.endsWith(".dump")) {
          const target = path.join(scratch, `${randomBytes(4).toString("hex")}.dump`);
          await pipeline(content, createWriteStream(target));
          dumps.set(name, target);
          map.set(name, Buffer.alloc(0));
          return;
        }
        const parts: Buffer[] = [];
        for await (const c of content) parts.push(c as Buffer);
        map.set(name, Buffer.concat(parts));
      });
      return { map, dumps };
    };
    const usersIn = (dumpFile: string) => {
      try {
        return execFileSync("pg_restore", ["--data-only", "--table=users", "--file=-", dumpFile], { encoding: "utf8" });
      } catch {
        return "";
      }
    };
    const restoreList = (dumpFile: string) => {
      try {
        return execFileSync("pg_restore", ["--list", dumpFile], { encoding: "utf8" });
      } catch {
        return "";
      }
    };

    // ─── 3 ───────────────────────────────────────────────────────────────────────────────────────
    section("3. A workspace bundle");
    const tenantA = (await registry.tenantById(A))!;
    const progress: string[] = [];
    const wsFile = path.join(out, "a.dzbk");
    const built = await build.buildWorkspaceBundle(tenantA, { out: wsFile, passphrase: PASS, createdBy: "script:check", onProgress: (p) => progress.push(p.entry) });
    ok("built", built.file === wsFile && (await stat(wsFile)).size === built.sizeBytes);
    ok("  no .part or work folder left beside it", !(await stat(`${wsFile}.part`).then(() => true, () => false)));
    ok("  progress was reported entry by entry", progress.includes(`workspaces/${A}/db.dump`) && progress.includes(`workspaces/${A}/control.json`));
    ok("the header: a workspace bundle of A, with its schema version and this server's key fingerprint", built.header.kind === "workspace" && built.header.workspaces.length === 1 && built.header.workspaces[0]!.id === A && built.header.workspaces[0]!.schemaVersion === wsVersion && built.header.keyFingerprint === kek.platformKeyFingerprint() && built.header.control === null, built.header.workspaces);
    const { map: wsEntries, dumps: wsDumps } = await entriesOf(wsFile);
    const names = [...wsEntries.keys()];
    const listing = restoreList(wsDumps.get(`workspaces/${A}/db.dump`) ?? "");
    ok("its database dump: pg_restore --list reads it, users and migrations tables and all", /TABLE public users /.test(listing) && /TABLE public _prisma_migrations /.test(listing), listing.split("\n").slice(0, 3).join(" "));
    const people = usersIn(wsDumps.get(`workspaces/${A}/db.dump`) ?? "");
    ok("  it is A's database: A's person is in it, B's is not", people.includes("zz-a@bundle.example") && !people.includes("zz-b@bundle.example"));
    const cj = rows.decodeControlRows(wsEntries.get(`workspaces/${A}/control.json`)!);
    const t = cj.models.Tenant?.[0];
    ok("control.json: the Tenant row, without dbUrlCipher, with its sealed key bundle", cj.models.Tenant?.length === 1 && t?.id === A && !("dbUrlCipher" in (t ?? {})) && typeof t?.keyBundleCipher === "string" && t?.createdAt instanceof Date);
    ok("  its subscription and items, and their plan with its modules and prices", (cj.models.Subscription?.length ?? 0) >= 1 && (cj.models.SubscriptionItem?.length ?? 0) >= 1 && cj.shared.Plan?.some((p) => p.id === plan.id) === true && (cj.shared.PlanModule?.length ?? 0) >= 1 && (cj.shared.PlanPrice?.length ?? 0) >= 1, { sub: cj.models.Subscription?.length, items: cj.models.SubscriptionItem?.length, plans: cj.shared.Plan?.length, mods: cj.shared.PlanModule?.length, prices: cj.shared.PlanPrice?.length });
    ok("  its partner, carried as a shared row", cj.shared.Partner?.length === 1 && cj.shared.Partner[0]!.id === partner.id);
    ok("  its note, domain, support request and attachment, billing event, sent automation step", cj.models.TenantNote?.length === 1 && cj.models.TenantDomain?.length === 1 && cj.models.SupportRequest?.length === 1 && cj.models.SupportAttachment?.length === 1 && cj.models.BillingEvent?.length === 1 && cj.models.AutomationSentStep?.length === 1);
    ok("  none of what is excluded: the audit log, the support access grant", !("PlatformAuditLog" in cj.models) && !("SupportAccessGrant" in cj.models));
    const usage = cj.models.TenantUsage?.[0];
    ok("  types come back as they were: a BigInt past 2^32, a date", usage?.storageBytes === BigInt("12345678901") && usage?.day instanceof Date && (usage.day as Date).toISOString().startsWith("2026-11-20"), usage ? Object.fromEntries(Object.entries(usage).map(([k, x]) => [k, typeof x])) : "no usage row");
    const cjText = wsEntries.get(`workspaces/${A}/control.json`)!.toString("utf8");
    ok("  nothing of workspace B in it", !cjText.includes(B) && !cjText.includes("note for B"));
    const boxOk = [...files.entries()].filter(([k]) => k.startsWith(`workspaces/${A}/`)).every(([k, bytes]) => sha(wsEntries.get(`workspaces/${A}/box/${k.slice(`workspaces/${A}/`.length)}`) ?? Buffer.alloc(1)) === sha(bytes));
    ok("every box file of A (documents and recordings), byte for byte", boxOk);
    ok("  its support file in the box", sha(wsEntries.get(`workspaces/${A}/support/box/${request.id}/${attachmentId}`) ?? Buffer.alloc(1)) === sha(files.get(`support/${A}/${request.id}/${attachmentId}`)!));
    ok("  its support file on disk", sha(wsEntries.get(`workspaces/${A}/support/disk/${diskReq}/${diskAtt}`) ?? Buffer.alloc(1)) === sha(diskBytes));
    ok("  never staging/", !names.some((n) => n.includes("staging")));
    ok("  and the manifest agrees with each", built.manifest.entries.every((e) => sha(wsEntries.get(e.name) ?? Buffer.alloc(0)) === e.sha256 || e.name.endsWith(".dump")));
    ok("nothing of another workspace, and nothing outside A's folder", names.every((n) => n.startsWith(`workspaces/${A}/`)) && !names.some((n) => n.includes(B)) && !names.some((n) => n.includes("offsite")), names);
    const fileHash = sha(await readFile(wsFile));
    const record = built.backupId ? await control.platformBackup.findUnique({ where: { id: built.backupId } }) : null;
    ok("a PlatformBackup row: READY, with the file's size and sha256, and its header", record?.status === "READY" && record.kind === "WORKSPACE" && record.tenantId === A && Number(record.sizeBytes) === built.sizeBytes && record.sha256 === fileHash && (record.header as { kind?: string } | null)?.kind === "workspace");
    const badDump = await build.buildWorkspaceBundle({ ...tenantA, dbUrl: withDatabase(url, `${realName}_bundle_missing`) }, { out: path.join(out, "bad.dzbk"), passphrase: PASS, createdBy: "script:check" }).then(() => null, (e: unknown) => e);
    const badRow = await control.platformBackup.findFirst({ where: { fileName: "bad.dzbk" } });
    ok("a dump that fails fails the build: no file left, the row FAILED with pg_dump's words", badDump instanceof Error && /pg_dump/.test(badDump.message) && !(await stat(path.join(out, "bad.dzbk")).then(() => true, () => false)) && !(await stat(path.join(out, "bad.dzbk.part")).then(() => true, () => false)) && badRow?.status === "FAILED", badDump instanceof Error ? badDump.message.slice(0, 120) : String(badDump));

    // ─── 4 ───────────────────────────────────────────────────────────────────────────────────────
    section("4. A full bundle");
    const fullFile = path.join(out, "full.dzbk");
    const full = await build.buildFullBundle({ out: fullFile, passphrase: PASS, createdBy: "script:check" });
    const { map: fullEntries, dumps: fullDumps } = await entriesOf(fullFile);
    const fnames = [...fullEntries.keys()];
    ok("the control plane's dump: pg_restore --list reads it, tenants table and all", restoreList(fullDumps.get("control/control.dump") ?? "").includes("tenants"));
    ok("the header lists every workspace that isn't closed — the suspended one too — each with its schema version", full.header.kind === "full" && full.header.workspaces.map((w) => w.id).sort().join() === [A, B, D].sort().join() && full.header.workspaces.every((w) => w.schemaVersion === wsVersion), full.header.workspaces);
    ok("  and the control plane's schema version", full.header.control?.schemaVersion === controlVersion && controlVersion === newestControlMigration(), full.header.control);
    ok("never the closed one", !fnames.some((n) => n.includes(C)) && !full.header.workspaces.some((w) => w.id === C));
    ok("each workspace's entries: its dump and its control.json", [A, B, D].every((id) => fnames.includes(`workspaces/${id}/db.dump`) && fnames.includes(`workspaces/${id}/control.json`)));
    ok("  each dump is its own workspace's database", usersIn(fullDumps.get(`workspaces/${B}/db.dump`) ?? "").includes("zz-b@bundle.example") && !usersIn(fullDumps.get(`workspaces/${B}/db.dump`) ?? "").includes("zz-a@bundle.example") && usersIn(fullDumps.get(`workspaces/${A}/db.dump`) ?? "").includes("zz-a@bundle.example"));
    ok("  each workspace's box files under its own name", sha(fullEntries.get(`workspaces/${B}/box/files/employee-documents/2026-11/${"c".repeat(24)}`) ?? Buffer.alloc(1)) === sha(files.get(`workspaces/${B}/files/employee-documents/2026-11/${"c".repeat(24)}`)!) && fnames.includes(`workspaces/${A}/support/disk/${diskReq}/${diskAtt}`));
    ok("  B's control.json has B's rows and not A's", (() => {
      const text = fullEntries.get(`workspaces/${B}/control.json`)!.toString("utf8");
      return text.includes("note for B") && !text.includes(A);
    })());
    const inv = JSON.parse(fullEntries.get("platform/inventory.json")?.toString("utf8") ?? "{}") as { settings?: Record<string, boolean>; leftOut?: Record<string, string> };
    ok("platform/inventory.json: which settings this server had, by name only, and what was left out", inv.settings?.PLATFORM_MASTER_KEY === true && !JSON.stringify(inv).includes(realKey) && !!inv.leftOut?.PLATFORM_MASTER_KEY);
    ok("nothing from the box's offsite/ folder", !fnames.some((n) => n.includes("offsite")));
    ok("verifyBundle: sound", (await format.verifyBundle(fullFile, PASS)).ok);

    const fp1 = kek.platformKeyFingerprint()!;
    process.env.PLATFORM_MASTER_KEY = randomBytes(32).toString("base64");
    const fp2 = kek.platformKeyFingerprint()!;
    const otherKey = process.env.PLATFORM_MASTER_KEY;
    process.env.PLATFORM_MASTER_KEY = realKey;
    const keyBytes = Buffer.from(realKey, "base64");
    ok("the key's fingerprint changes when PLATFORM_MASTER_KEY changes", fp1 !== fp2 && /^pk1:[0-9a-f]{32}$/.test(fp1) && kek.platformKeyFingerprint() === fp1);
    ok("  and never reveals it: neither the key, its bytes in hex, nor a hash of them", ![realKey, keyBytes.toString("hex"), sha(keyBytes), createHash("sha256").update(realKey).digest("hex")].some((s) => s.includes(fp1.slice(4)) || fp1.includes(s.slice(0, 16))) && !fp2.includes(otherKey!.slice(0, 8)));

    // ─── 5 ───────────────────────────────────────────────────────────────────────────────────────
    section("5. Memory: a 200 MB file in the box");
    const bigKey = `workspaces/${D}/files/employee-documents/2026-11/${"d".repeat(24)}`;
    const bigPath = path.join(boxDir, ...bigKey.split("/"));
    await mkdir(path.dirname(bigPath), { recursive: true });
    const big = streamOf(200 * MB, 9, MB);
    await pipeline(big.stream, createWriteStream(bigPath));
    const bigSha = await big.sha256;
    const tenantD = (await registry.tenantById(D))!;
    const measure = async <T,>(work: () => Promise<T>): Promise<{ result: T; rise: number; before: number; peak: number }> => {
      global.gc?.();
      const before = process.memoryUsage().rss;
      let peak = before;
      const timer = setInterval(() => {
        peak = Math.max(peak, process.memoryUsage().rss);
      }, 25);
      try {
        const result = await work();
        peak = Math.max(peak, process.memoryUsage().rss);
        return { result, rise: peak - before, before, peak };
      } finally {
        clearInterval(timer);
      }
    };
    const bigFile = path.join(out, "big.dzbk");
    const building = await measure(() => build.buildWorkspaceBundle(tenantD, { out: bigFile, passphrase: PASS, createdBy: "script:check" }));
    ok("built, with the 200 MB file in it", building.result.manifest.entries.some((e) => e.name.endsWith("d".repeat(24)) && e.size === 200 * MB && e.sha256 === bigSha));
    ok(`  RSS rose ${(building.rise / MB).toFixed(0)} MB while building — well under the file's 200 MB`, building.rise < 80 * MB, { beforeMb: Math.round(building.before / MB), peakMb: Math.round(building.peak / MB) });
    const verifying = await measure(() => format.verifyBundle(bigFile, PASS));
    ok(`  and ${(verifying.rise / MB).toFixed(0)} MB while reading it all back and checking it`, verifying.result.ok && verifying.rise < 80 * MB, { beforeMb: Math.round(verifying.before / MB), peakMb: Math.round(verifying.peak / MB) });
    await rm(bigFile, { force: true });
    await rm(bigPath, { force: true });
  } finally {
    process.env.PLATFORM_MASTER_KEY = realKey;
    await cleanup?.().catch(() => {});
    for (const name of [controlName, wsA, wsB, wsC]) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`).catch(() => {});
    await admin.$disconnect().catch(() => {});
    await rm(scratch, { recursive: true, force: true });
    ok("the scratch databases and folders are removed", true);
  }

  console.log(`\n${failures ? `${passes} passed, ${failures} FAILED` : `All ${passes} bundle checks passed.`}`);
  process.exitCode = failures ? 1 : 0;
}

/** The newest control-plane migration this code carries — what a freshly migrated control plane is at. */
function newestControlMigration(): string | null {
  return readdirSync(path.join(process.cwd(), "prisma", "control", "migrations"), { withFileTypes: true })
    .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
    .map((e) => e.name)
    .sort()
    .at(-1) ?? null;
}

/**
 * Opens every frame of a small bundle with the format as format.ts documents it, lets `change` alter the plaintext,
 * and seals it again under the same header — a bundle whose every frame is genuine but whose contents were changed by
 * somebody holding the passphrase. Written here from the documentation rather than calling format.ts, so it is also a
 * second reading of the layout.
 */
async function reseal(file: Buffer, passphrase: string, change: (plain: Buffer) => void): Promise<{ bytes: Buffer; untouchedOpened: boolean }> {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const archive = require("../src/lib/backup/archive") as typeof import("../src/lib/backup/archive");
  const headerLen = file.readUInt32BE(9);
  const headerBytes = file.subarray(0, 13 + headerLen);
  const header = JSON.parse(file.subarray(13, 13 + headerLen).toString("utf8")) as { kdf: import("../src/lib/backup/archive").ArchiveKdf; noncePrefix: string; frameSize: number };
  const key = Buffer.from(hkdfSync("sha256", archive.deriveKey(passphrase, header.kdf), Buffer.alloc(0), "deskzo/bundle/body/v1", 32));
  const prefix = Buffer.from(header.noncePrefix, "base64");
  const hh = createHash("sha256").update(headerBytes).digest();
  const u64 = (n: number) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64BE(BigInt(n));
    return b;
  };
  const plains: Buffer[] = [];
  let at = 13 + headerLen;
  let i = 0;
  let opened = true;
  while (at < file.length) {
    const len = file.readUInt32BE(at);
    const ct = file.subarray(at + 4, at + 4 + len);
    const tag = file.subarray(at + 4 + len, at + 4 + len + 16);
    at += 4 + len + 16;
    const final = at >= file.length;
    const d = createDecipheriv("aes-256-gcm", key, Buffer.concat([prefix, u64(i)]));
    d.setAAD(Buffer.concat([hh, u64(i), Buffer.from([final ? 1 : 0])]));
    d.setAuthTag(tag);
    try {
      plains.push(Buffer.concat([d.update(ct), d.final()]));
    } catch {
      opened = false;
      plains.push(Buffer.alloc(0));
    }
    i += 1;
  }
  const plain = Buffer.concat(plains);
  change(plain);
  const frames: Buffer[] = [headerBytes];
  const count = Math.max(1, Math.ceil(plain.length / header.frameSize));
  for (let n = 0; n < count; n++) {
    const piece = plain.subarray(n * header.frameSize, (n + 1) * header.frameSize);
    const final = n === count - 1;
    const c = createCipheriv("aes-256-gcm", key, Buffer.concat([prefix, u64(n)]));
    c.setAAD(Buffer.concat([hh, u64(n), Buffer.from([final ? 1 : 0])]));
    const ct = Buffer.concat([c.update(piece), c.final()]);
    const len = Buffer.alloc(4);
    len.writeUInt32BE(ct.length);
    frames.push(len, ct, c.getAuthTag());
  }
  return { bytes: Buffer.concat(frames), untouchedOpened: opened };
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
