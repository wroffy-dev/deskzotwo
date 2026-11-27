/**
 * check:approval-history — every approval decision in one place (owner, 30 Oct 2026 — src/lib/approvals/log.ts,
 * src/actions/approval-history.ts).
 *
 *   1. Every kind is written: each one APPROVAL_KINDS names is recorded by some approval action, and every action
 *      that records names a kind that exists.
 *   2. A decision is kept: who decided, on what, who asked, the note.
 *   3. Who sees what: "See everyone's activity" sees every decision; anybody else theirs and those on what they asked.
 *   4. Filters: what, decision, who decided, a search.
 *   5. Downloading needs "Export the activity log".
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:approval-history
 */
import "dotenv/config";
import Module from "node:module";
import { execSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";
import { APPROVAL_KINDS } from "../src/lib/approvals/kinds";

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

function sourcesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? sourcesUnder(join(dir, e.name)) : /\.tsx?$/.test(e.name) ? [join(dir, e.name)] : []));
}

async function main() {
  section("1. Every kind is written");
  const written = new Set<string>();
  for (const file of [...sourcesUnder("src/actions"), ...sourcesUnder("src/lib")]) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(/recordApproval\(\{[^)]*?kind: "(\w+)"/g)) written.add(m[1]!);
    for (const m of text.matchAll(/recordApproval\(\{ \.\.\.\w+, kind: "(\w+)"/g)) written.add(m[1]!);
  }
  const kinds = Object.keys(APPROVAL_KINDS);
  const unwritten = kinds.filter((k) => !written.has(k));
  ok("every kind the history can show is recorded by an approval action", unwritten.length === 0, unwritten);
  const unknown = [...written].filter((k) => !kinds.includes(k));
  ok("  and every kind recorded is one it knows", unknown.length === 0, unknown);

  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  const realName = new URL(url).pathname.slice(1);
  section("A scratch workspace");
  const local = ["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host);
  ok("the database is a local one, so a scratch database may be made beside it", local, host);
  if (!local) throw new Error("not a local database");
  const scratch = `${realName}_approvals`;
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
    const log = require("../src/lib/approvals/log") as typeof import("../src/lib/approvals/log");
    const history = require("../src/actions/approval-history") as typeof import("../src/actions/approval-history");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const person = (name: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-appr.in`, passwordHash: "!", role: "SALES", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const boss = await person("Zz Boss", { role: "ADMIN", isSuperAdmin: true });
    const accounts = await person("Zz Accounts");
    const rep = await person("Zz Rep");
    const other = await person("Zz Other");
    const as = (u: { id: string; name: string; email: string | null; role: string }) => (actor = { id: u.id, name: u.name, email: u.email!, role: u.role });

    section("2. A decision is kept");
    await log.recordApproval({ kind: "order", decision: "REJECTED", recordId: "o1", label: "ORD-000001 — Zz Acme", href: "/orders/ORD-000001", note: "  Terms too long  ", requestedById: rep.id, decidedById: accounts.id });
    await log.recordApproval({ kind: "order", decision: "APPROVED", recordId: "o1", label: "ORD-000001 — Zz Acme", href: "/orders/ORD-000001", requestedById: rep.id, decidedById: accounts.id });
    await log.recordApproval({ kind: "leave", decision: "APPROVED", recordId: "l1", label: "2 day(s) CL — Zz Other", requestedById: other.id, decidedById: boss.id });
    const kept = await db.approvalEvent.findMany({ where: { recordId: "o1" }, orderBy: { decidedAt: "asc" } });
    ok("both decisions on one order are kept, the rejection before the approval", kept.length === 2 && kept[0]!.decision === "REJECTED" && kept[1]!.decision === "APPROVED", kept.map((k) => k.decision));
    ok("  with who decided, who asked and the note, trimmed", kept[0]!.decidedById === accounts.id && kept[0]!.requestedById === rep.id && kept[0]!.note === "Terms too long" && !kept[0]!.backfilled);

    section("3. Who sees what");
    as(boss);
    const own = await history.listApprovalHistory({}, { page: 1, pageSize: 50 });
    ok("the admin opens on their own decisions, not everybody's", own.ok && !own.data.all && own.data.mayAll && own.data.rows.every((r) => r.decidedBy === "Zz Boss" || r.requestedBy === "Zz Boss"), own.ok ? own.data.total : own);
    const all = await history.listApprovalHistory({ whose: "everyone" }, { page: 1, pageSize: 50 });
    ok("  and sees every decision when they ask for everyone's", all.ok && all.data.total === 3 && all.data.all, all.ok ? all.data.total : all);
    ok("  named, newest first", all.ok && all.data.rows[0]!.kindLabel === "Leave" && all.data.rows.some((r) => r.decidedBy === "Zz Accounts" && r.requestedBy === "Zz Rep"));
    as(rep);
    const mine = await history.listApprovalHistory({}, { page: 1, pageSize: 50 });
    ok("the rep sees the decisions on what they asked for, not somebody's leave", mine.ok && mine.data.total === 2 && !mine.data.all && !mine.data.mayAll && mine.data.rows.every((r) => r.requestedBy === "Zz Rep"), mine.ok ? mine.data.rows.map((r) => r.label) : mine);
    as(accounts);
    const decided = await history.listApprovalHistory({}, { page: 1, pageSize: 50 });
    ok("  accounts, the ones they decided", decided.ok && decided.data.total === 2);

    section("4. Filters");
    as(boss);
    const count = async (f: Parameters<typeof history.listApprovalHistory>[0]) => {
      const r = await history.listApprovalHistory({ whose: "everyone", ...f }, { page: 1, pageSize: 50 });
      return r.ok ? r.data.total : -1;
    };
    ok("by what", (await count({ kind: "leave" })) === 1);
    ok("  by decision", (await count({ decision: "REJECTED" })) === 1);
    ok("  by who decided", (await count({ person: accounts.id })) === 2);
    ok("  by a search of the record and the note", (await count({ q: "terms too" })) === 1 && (await count({ q: "acme" })) === 2);
    ok("  a made-up kind is no filter, not an error", (await count({ kind: "toString" })) === 3);

    section("5. Downloading");
    as(rep);
    ok("a rep can't download", !(await history.exportApprovalHistory({})).ok);
    as(boss);
    const csv = await history.exportApprovalHistory({ whose: "everyone" });
    ok("the admin downloads every row, with a header", csv.ok && csv.data.rows === 3 && csv.data.csv.split("\n")[0]!.includes("Decided by"), csv.ok ? csv.data.rows : csv);
  } finally {
    actor = null;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `
All ${passes} approval history checks passed.
` : `
${failures} check(s) FAILED (${passes} passed).
`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
