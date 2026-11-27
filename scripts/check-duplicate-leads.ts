/**
 * check:duplicate-leads — the copies an import made of leads already here (owner, 30 Oct 2026 — src/lib/leads/duplicates.ts).
 *
 *   1. A group: same company, pipeline, title (case and spacing aside) and contact, at least one copy from an import; the
 *      lead in Deskzo first kept. Not two leads somebody typed alike, not a different contact.
 *   2. A copy somebody has worked on is listed, and never taken away.
 *   3. Taken away: the copy deleted, its old system ID moved to the kept lead, the audit log told; the kept lead, a worked
 *      copy and anything not a copy left alone.
 *   4. Only the super admin.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:duplicate-leads
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
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

type Actor = { id: string; name: string; email: string; role: string };
let actor: Actor | null = null;
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
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("../src/lib/session"), session],
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

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_dupleads`;
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    const started = Date.now();
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, scratch) }, timeout: 10 * 60_000 });
    ok("built from the migrations", true, `${Math.round((Date.now() - started) / 1000)} s`);
    process.env.DATABASE_URL = withDatabase(url, scratch);
    process.env.CONTROL_DATABASE_URL = "";
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const dupes = require("../src/lib/leads/duplicates") as typeof import("../src/lib/leads/duplicates");
    const action = require("../src/actions/duplicate-leads") as typeof import("../src/actions/duplicate-leads");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const person = (name: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-dup.in`, passwordHash: "!", role: "SALES", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const boss = await person("Zz Boss", { role: "ADMIN", isSuperAdmin: true });
    const rep = await person("Zz Rep");
    const as = (u: { id: string; name: string; email: string | null; role: string }) => (actor = { id: u.id, name: u.name, email: u.email!, role: u.role });
    as(boss);
    const stage = await db.leadStage.findFirst({ where: { status: "NEW" }, select: { id: true, pipelineId: true } });
    if (!stage) throw new Error("no New stage in the main pipeline");
    const company = await db.company.create({ data: { name: "Zz Acme", normalizedName: "zz acme", relationshipType: "CLIENT", stage: "LEAD", createdById: boss.id }, select: { id: true } });
    const ravi = await db.contact.create({ data: { companyId: company.id, name: "Ravi", createdByUserId: boss.id }, select: { id: true } });
    const asha = await db.contact.create({ data: { companyId: company.id, name: "Asha", createdByUserId: boss.id }, select: { id: true } });
    const lead = (title: string, extra: Record<string, unknown> = {}) =>
      db.lead.create({
        data: { title, status: "NEW", stageId: stage.id, pipelineId: stage.pipelineId, companyId: company.id, contactId: ravi.id, createdByUserId: boss.id, ownerUserId: rep.id, ...extra },
        select: { id: true, leadSeq: true },
      });
    const imported = { assignmentNote: "Brought from the old system" };

    section("1. A group");
    const original = await lead("Microsoft 365 — Zz Acme", { externalId: null });
    const copy = await lead("microsoft 365  —  zz acme", { ...imported, externalId: "4411" });
    const worked = await lead("Microsoft 365 — Zz Acme", imported);
    await db.task.create({ data: { title: "Call Ravi", leadId: worked.id, createdByUserId: boss.id } });
    const otherContact = await lead("Microsoft 365 — Zz Acme", { ...imported, contactId: asha.id });
    const handA = await lead("Azure — Zz Acme");
    const handB = await lead("Azure — Zz Acme");
    const groups = await dupes.findDuplicateLeads();
    const g = groups.find((x) => x.keep.id === original.id);
    ok("the lead here first is kept; the imported copies (case and spacing aside) are its copies", Boolean(g) && g!.copies.map((c) => c.id).sort().join() === [copy.id, worked.id].sort().join(), g?.copies.map((c) => c.leadSeq));
    ok("  a different contact isn't the same lead", !groups.some((x) => x.copies.some((c) => c.id === otherContact.id) || x.keep.id === otherContact.id));
    ok("  two leads somebody typed alike aren't an import's to clean up", !groups.some((x) => [handA.id, handB.id].includes(x.keep.id)));

    section("2. Worked on");
    const w = g?.copies.find((c) => c.id === worked.id);
    ok("a copy with a task says so", w?.workedOn.join() === "1 tasks", w?.workedOn);
    ok("  an untouched copy says nothing", g?.copies.find((c) => c.id === copy.id)?.workedOn.length === 0);

    section("3. Taken away");
    const done = await dupes.removeDuplicateLeads([copy.id, worked.id, original.id], boss.id);
    ok("the untouched copy goes; the worked one and the kept lead stay", done.removed === 1 && done.kept === 2 && !(await db.lead.findUnique({ where: { id: copy.id } })) && Boolean(await db.lead.findUnique({ where: { id: worked.id } })) && Boolean(await db.lead.findUnique({ where: { id: original.id } })), done);
    ok("  the kept lead now carries its old system ID, so the file again matches it", (await db.lead.findUnique({ where: { id: original.id }, select: { externalId: true } }))?.externalId === "4411");
    ok("  the audit log says which lead it copied", (await db.auditLog.count({ where: { entityId: copy.id, action: "DELETE" } })) === 1);
    ok("  run again: nothing more", (await dupes.removeDuplicateLeads([copy.id], boss.id)).removed === 0);

    section("4. Only the super admin");
    as(rep);
    ok("a rep is refused", !(await action.removeDuplicateLeadCopies([worked.id])).ok);
    as(boss);
    ok("  the super admin isn't", (await action.removeDuplicateLeadCopies([])).ok);
  } finally {
    actor = null;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `
All ${passes} duplicate lead checks passed.
` : `
${failures} check(s) FAILED (${passes} passed).
`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
