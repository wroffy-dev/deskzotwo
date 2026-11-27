/**
 * The storage box (src/lib/storage): the Azure container every file goes to.
 *
 *   1. The container SAS signed with the account key matches the one Azure's own SDK makes for the same inputs.
 *   2. A connection string is read as Azure writes them; an http address is refused unless it is this machine.
 *   3. Every column in the schema that holds a file is in src/lib/storage/registry.ts, or kept in the database with
 *      a reason.
 *   4. In a scratch workspace with a folder for a box: nothing changes without a box; with one, a file goes in sealed,
 *      comes back whole, can't be read from another workspace; the move copies what is in the database and leaves
 *      a reference; the sweep deletes only what nobody points at and is older than backups are kept.
 *
 * In a scratch database built from the migrations, dropped after.
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, utimes } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";

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
const load = Module.createRequire(__filename);
const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return nextCache;
  return realLoad.call(this, request, parent, isMain);
};

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
  const store = load("../src/lib/offsite/store") as typeof import("../src/lib/offsite/store");
  const boxLib = load("../src/lib/storage/box") as typeof import("../src/lib/storage/box");
  const registry = load("../src/lib/storage/registry") as typeof import("../src/lib/storage/registry");

  section("1. The container SAS");
  // The reference: @azure/storage-blob 12.26 generateBlobSASQueryParameters, the same account, key, container, times.
  const sas = store.containerSas({
    account: "acmefiles",
    container: "deskzo",
    key: Buffer.from("Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==", "base64"),
    start: new Date("2026-11-13T10:00:00Z"),
    expiry: new Date("2026-11-13T11:00:00Z"),
    https: true,
  });
  const params = new URLSearchParams(sas);
  ok("the signature is the one Azure's SDK makes", params.get("sig") === "0L5a/7cLGF6RaDd5s5pAT39LujXD/tMGJ9xAySXEGaY=", params.get("sig"));
  ok("for the container, read/add/create/write/delete/list, https only", params.get("sr") === "c" && params.get("sp") === "racwdl" && params.get("spr") === "https" && params.get("sv") === "2022-11-02");

  section("2. Connection strings");
  const parsed = boxLib.parseConnectionString("DefaultEndpointsProtocol=https;AccountName=acmefiles;AccountKey=a2V5;EndpointSuffix=core.windows.net");
  ok("the portal's form gives the account's blob address", parsed.blobEndpoint === "https://acmefiles.blob.core.windows.net" && parsed.account === "acmefiles" && parsed.key === "a2V5", parsed);
  const emu = boxLib.parseConnectionString("AccountName=devstoreaccount1;AccountKey=a2V5;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1/");
  ok("an explicit BlobEndpoint wins", emu.blobEndpoint === "http://127.0.0.1:10000/devstoreaccount1", emu.blobEndpoint);
  let refused = "";
  try {
    boxLib.parseConnectionString("AccountName=x;EndpointSuffix=core.windows.net");
  } catch (err) {
    refused = (err as Error).message;
  }
  ok("one without a key is refused", /AccountKey/.test(refused), refused);
  const saved = { ...process.env };
  process.env.STORAGE_AZURE_CONNECTION_STRING = "AccountName=acme;AccountKey=a2V5;BlobEndpoint=http://files.example.com/acme";
  const state = (await boxLib.storageBoxState());
  ok("an http address that isn't this machine is refused", !state.configured && /https/.test(state.error ?? ""), state);
  let threw = false;
  try {
    (await boxLib.storageBox());
  } catch {
    threw = true;
  }
  ok("  and asking for the box then throws, rather than keeping files on the server", threw);
  process.env.STORAGE_AZURE_CONNECTION_STRING = "AccountName=acme;AccountKey=a2V5;EndpointSuffix=core.windows.net";
  process.env.STORAGE_AZURE_CONTAINER = "files";
  ok("the container defaults sensibly and the label names it", (await boxLib.storageBoxState()).label === "Azure Blob · acme/files", (await boxLib.storageBoxState()));
  for (const k of ["STORAGE_AZURE_CONNECTION_STRING", "STORAGE_AZURE_CONTAINER"]) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }

  section("3. Every file column is accounted for");
  const schema = await readFile(path.join(__dirname, "..", "prisma", "schema.prisma"), "utf8");
  const found: string[] = [];
  const everyColumn = new Set<string>();
  for (const m of schema.matchAll(/\nmodel (\w+) \{([\s\S]*?)\n\}/g)) {
    for (const line of m[2]!.split("\n")) {
      const f = /^\s+(\w+)\s+(Bytes|String)\??(\s|$)/.exec(line);
      if (!f) continue;
      everyColumn.add(`${m[1]}.${f[1]}`);
      if (f[2] === "Bytes" || /dataUrl$|DataUrl$|^imageData$/.test(f[1]!)) found.push(`${m[1]}.${f[1]}`);
    }
  }
  const listed = new Set([...registry.FILE_COLUMNS.map((c) => `${c.model}.${c.column}`), ...Object.keys(registry.KEPT_IN_DATABASE)]);
  const missing = found.filter((f) => !listed.has(f));
  ok(`each of the ${found.length} file columns is in the registry or kept with a reason`, missing.length === 0, missing.join(", "));
  const stale = [...listed].filter((f) => !everyColumn.has(f));
  ok("and the registry names no column the schema doesn't have", stale.length === 0, stale.join(", "));
  for (const c of registry.FILE_COLUMNS) {
    const block = new RegExp(`\\nmodel ${c.model} \\{([\\s\\S]*?)\\n\\}`).exec(schema)?.[1] ?? "";
    const table = /@@map\("([^"]+)"\)/.exec(block)?.[1] ?? c.model;
    const shapeOk = c.shape === "bytes" ? new RegExp(`\\n\\s+${c.column}\\s+Bytes`).test(block) : new RegExp(`\\n\\s+${c.column}\\s+String`).test(block);
    const typeOk = c.typeColumn === null || new RegExp(`\\n\\s+${c.typeColumn}\\s`).test(block);
    const idOk = new RegExp(`\\n\\s+${c.id}\\s+\\S+[^\\n]*@id`).test(block);
    if (table !== c.table || !shapeOk || !typeOk || !idOk) ok(`${c.model}: table, id, column and type as the schema has them`, false, { table, shapeOk, typeOk, idOk });
  }
  ok("each registered column's table, id, shape and type column match the schema", true);

  section("4. In a scratch workspace");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${new URL(url).pathname.slice(1)}_storagebox`;
  const scratchUrl = withDatabase(url, scratch);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  const folder = await mkdtemp(path.join(os.tmpdir(), "deskzo-box-"));
  let close: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("built from the migrations", true);
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = "";
    for (const k of ["STORAGE_AZURE_CONNECTION_STRING", "STORAGE_AZURE_CONTAINER_URL", "STORAGE_DIR", "STORAGE_PREFIX"]) delete process.env[k];
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const files = require("../src/lib/storage/files") as typeof import("../src/lib/storage/files");
    const maint = require("../src/lib/storage/maintenance") as typeof import("../src/lib/storage/maintenance");
    const { currentTenant, runAsTenant } = require("../src/lib/tenancy/resolve") as typeof import("../src/lib/tenancy/resolve");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const png = Buffer.from("89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c489", "hex");
    const pngUrl = files.toDataUrl(png, "image/png");

    // No box: exactly as before.
    ok("without a box a data URL is kept as it is", (await files.keepDataUrl("user-photos", pngUrl)) === pngUrl);
    const plainBytes = await files.keepBytes("task-attachments", png, "image/png");
    ok("  and bytes too", Buffer.from(plainBytes).equals(png));
    ok("  and they read back as they always did", (await files.dataUrlOf(pngUrl)) === pngUrl && (await files.bytesOf(plainBytes))!.equals(png));
    ok("a value that isn't a file passes through untouched", (await files.keepDataUrl("employee-documents", "letter:abc")) === "letter:abc" && (await files.dataUrlOf("letter:abc")) === "letter:abc");

    process.env.STORAGE_DIR = folder;
    const ref = await files.keepDataUrl("user-photos", pngUrl);
    ok("with a box a data URL becomes a reference", ref.startsWith(files.TEXT_REF) && files.isStoredRef(ref) && ref.endsWith("|image/png"), ref);
    const tenant = await currentTenant();
    const written = await walk(folder);
    ok("  the file is in the workspace's own folder of the box", written.length === 1 && written[0]!.includes(path.join("workspaces", tenant.id.replace(/[^A-Za-z0-9._-]/g, "-"), "files", "user-photos")), written);
    const onDisk = await readFile(written[0]!);
    ok("  sealed — the bytes in the box aren't the file's", onDisk.subarray(0, 8).toString("latin1") === "DZBKENC1" && !onDisk.includes(png), onDisk.subarray(0, 8).toString("latin1"));
    ok("  and it reads back as the same data URL", (await files.dataUrlOf(ref)) === pngUrl);
    const bytesRef = await files.keepBytes("task-attachments", png, "image/png");
    ok("bytes become a reference too", files.isStoredRef(bytesRef) && bytesRef.byteLength < 200, bytesRef.byteLength);
    ok("  and read back whole", (await files.bytesOf(bytesRef))!.equals(png));
    const asFile = await files.storedFile(bytesRef);
    ok("  with their type", asFile?.contentType === "image/png" && asFile.bytes.equals(png), asFile?.contentType);
    ok("a file's own bytes that only look a little like a reference are not one", !files.isStoredRef(Buffer.concat([Buffer.from("\u0000DZBLOB\u0000", "latin1"), Buffer.from("garbage")])));
    ok("a made-up reference is not one either", !files.isStoredRef("dzblob:../../etc/passwd|text/plain"));

    const other = { ...tenant, id: "another-workspace", slug: "another" };
    let missing = "";
    await runAsTenant(other, async () => {
      try {
        await files.dataUrlOf(ref);
      } catch (err) {
        missing = (err as Error).name;
      }
    });
    ok("another workspace holding the same reference finds nothing", missing === "StoredFileMissing", missing);
    ok("  and the forgiving reader gives null for it", (await runAsTenant(other, () => files.dataUrlOrNull(ref))) === null);

    // The move.
    const user = await db.user.create({ data: { name: "Box Person", email: "box.person@zz-box.in", passwordHash: "!", role: "SALES" }, select: { id: true } });
    await db.userPhoto.create({ data: { userId: user.id, dataUrl: pngUrl, mimeType: "image/png", byteSize: png.length } });
    const before = await maint.fileColumnCounts();
    const photos = before.find((c) => c.model === "UserPhoto")!;
    ok("the status counts the photo still in the database", photos.inDatabase === 1 && photos.inBox === 0, photos);
    const column = (await import("../src/lib/storage/registry")).FILE_COLUMNS.find((c) => c.model === "UserPhoto")!;
    const dry = await maint.moveColumn(column, { dryRun: true });
    const stillThere = await db.userPhoto.findUnique({ where: { userId: user.id }, select: { dataUrl: true } });
    ok("a dry run counts and changes nothing", dry.moved === 1 && stillThere?.dataUrl === pngUrl, dry);
    const moved = await maint.moveColumn(column, { dryRun: false });
    const after = await db.userPhoto.findUnique({ where: { userId: user.id }, select: { dataUrl: true } });
    ok("the move leaves a reference in the row", moved.moved === 1 && files.isStoredRef(after?.dataUrl), moved);
    ok("  which reads back as the photo", (await files.dataUrlOf(after!.dataUrl)) === pngUrl);
    const again = await maint.moveColumn(column, { dryRun: false });
    ok("  and a second run has nothing left to move", again.moved === 0 && again.failed === 0, again);

    // The sweep.
    const orphanOld = await files.keepDataUrl("user-photos", files.toDataUrl(Buffer.from("old orphan"), "text/plain"));
    const orphanNew = await files.keepDataUrl("user-photos", files.toDataUrl(Buffer.from("new orphan"), "text/plain"));
    const fileOf = async (r: string) => (await walk(folder)).find((f) => f.endsWith(files.storedRef(r)!.key.split("/").pop()!))!;
    const long = new Date(Date.now() - 400 * 86_400_000);
    await utimes(await fileOf(orphanOld), long, long);
    await utimes(await fileOf(after!.dataUrl), long, long);
    const swept = await maint.sweepStoredFiles();
    const left = (await walk(folder)).map((f) => path.basename(f));
    const has = (r: string) => left.includes(files.storedRef(r)!.key.split("/").pop()!);
    ok("the sweep deletes an old file nobody points at", swept !== null && swept.removed >= 1 && !has(orphanOld), swept);
    ok("  keeps a young one — a backup may still point at it", has(orphanNew));
    ok("  and never one a row points at, however old", has(after!.dataUrl));
    ok("  waiting longer than backups are kept", (swept?.graceDays ?? 0) >= 45, swept?.graceDays);

    // A workspace's role stops any statement after thirty seconds (src/lib/platform/provisioner.ts); counting a table full
    // of files took longer on a real server. Here the database's limit is cut to 200 ms and a statement takes 600.
    await admin.$executeRawUnsafe(`ALTER DATABASE "${scratch}" SET statement_timeout = '200ms'`);
    await db.$disconnect();
    let plain = "";
    try {
      await db.$queryRawUnsafe("SELECT 1 AS one FROM pg_sleep(0.6)");
    } catch (err) {
      plain = String((err as Error).message);
    }
    ok("with the database's short limit, an ordinary statement is stopped", /statement timeout|57014/.test(plain), plain.split("\n").pop());
    let given = "";
    try {
      await maint.longQuery("SELECT 1 AS one FROM pg_sleep(0.6)");
      given = "ran";
    } catch (err) {
      given = String((err as Error).message).split("\n").pop() ?? "";
    }
    ok("  but the storage box's maintenance queries are given the time they need", given === "ran", given);
    const countsUnderLimit = await maint.fileColumnCounts().then(
      (c) => c.find((x) => x.model === "UserPhoto"),
      (err: Error) => err.message.split("\n").pop(),
    );
    ok("  and the status still counts under it", typeof countsUnderLimit === "object" && countsUnderLimit?.inBox === 1, countsUnderLimit);
    await admin.$executeRawUnsafe(`ALTER DATABASE "${scratch}" RESET statement_timeout`);
  } finally {
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    await admin.$disconnect().catch(() => {});
    await rm(folder, { recursive: true, force: true });
    ok("the scratch database is dropped", true);
  }

  console.log(`\n${failures ? `${passes} passed, ${failures} FAILED` : `All ${passes} storage box checks passed.`}`);
  process.exitCode = failures ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
