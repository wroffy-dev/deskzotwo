/**
 * check:super-admin-delete — deleting a lead or a day's attendance (owner, 27 Oct 2026 —
 * src/actions/super-admin-delete.ts).
 *
 *   1. The super admin alone: an admin can't, nor the super admin while viewing as somebody.
 *   2. A lead goes with its own activities; a call logged against it stays, no longer pointing at it; the
 *      deletion is in the audit log, on its company.
 *   3. A day goes with where they clocked in from; another day stays.
 *   4. A day approved leave covers is refused, and so is one in a month whose payroll is locked.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:super-admin-delete
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
let viewingAs = false;
const session = {
  requireUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => (viewingAs ? { targetUserId: "someone" } : null),
  refuseWhileViewingAs: async () => null,
};
const authModule = { auth: async () => (actor ? { user: { id: actor.id, name: actor.name, email: actor.email } } : null) };
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const nextNavigation = { useRouter: () => ({ push: () => {}, refresh: () => {} }) };
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", nextNavigation],
  ["@/lib/session", session],
  ["@/lib/auth", authModule],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), nextNavigation],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("../src/lib/auth"), authModule],
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
  const scratch = `${realName}_sadelete`;
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  let close: (() => Promise<void>) | null = null;
  try {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
    await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, scratch) }, timeout: 10 * 60_000 });
    ok("built from the migrations", true);
    process.env.DATABASE_URL = withDatabase(url, scratch);
    process.env.CONTROL_DATABASE_URL = "";
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const del = require("../src/actions/super-admin-delete") as typeof import("../src/actions/super-admin-delete");
    const { DeleteLeadButton } = require("../src/components/leads/delete-lead-button") as typeof import("../src/components/leads/delete-lead-button");
    const { createElement } = require("react") as typeof import("react");
    const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server");
    /* eslint-enable @typescript-eslint/no-require-imports */

    const person = (name: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-delete.in`, passwordHash: "!", role: "SALES", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const asha = await person("Asha Zz", { role: "ADMIN", isSuperAdmin: true });
    const bala = await person("Bala Zz", { role: "ADMIN" });
    const chen = await person("Chen Zz");
    const as = <T,>(who: { id: string; name: string; email: string | null; role: string }, work: () => Promise<T>) => {
      const before = actor;
      actor = { id: who.id, name: who.name, email: who.email!, role: who.role };
      return work().finally(() => {
        actor = before;
      });
    };

    const company = await db.company.create({ data: { name: "Zz Acme", normalizedName: "zz acme", createdById: asha.id }, select: { id: true } });
    const lead = await db.lead.create({ data: { companyId: company.id, title: "Zz Laptops", ownerUserId: chen.id }, select: { id: true, leadSeq: true } });
    await db.activity.create({ data: { leadId: lead.id, userId: chen.id, type: "CALL", notes: "Spoke to IT" } });
    const call = await db.callLog.create({ data: { companyId: company.id, leadId: lead.id, phoneNumber: "9800000000", outcome: "CONNECTED", startedAt: new Date(), userId: chen.id }, select: { id: true } });

    section("1. The super admin alone");
    ok("an admin who isn't the super admin can't delete a lead", !(await as(bala, () => del.deleteLead(lead.id))).ok);
    ok("  nor a salesperson", !(await as(chen, () => del.deleteLead(lead.id))).ok);
    viewingAs = true;
    ok("  nor the super admin while viewing as somebody", !(await as(asha, () => del.deleteLead(lead.id))).ok && !(await as(asha, () => del.mayDeleteRecords())));
    viewingAs = false;
    ok("the page offers it to the super admin alone", (await as(asha, () => del.mayDeleteRecords())) && !(await as(bala, () => del.mayDeleteRecords())));
    ok("  the lead is still there", (await db.lead.count({ where: { id: lead.id } })) === 1);
    const html = renderToStaticMarkup(createElement(DeleteLeadButton, { leadId: lead.id, label: "LEAD-000001" }));
    ok("the lead's Delete button renders, its dialog closed until pressed", html.includes("Delete") && !html.includes("Delete LEAD-000001?"), html);

    section("2. A lead");
    const gone = await as(asha, () => del.deleteLead(lead.id));
    ok("the super admin deletes it", gone.ok && (await db.lead.count({ where: { id: lead.id } })) === 0, gone.ok ? "" : gone.error);
    ok("  its activities go with it", (await db.activity.count({ where: { leadId: lead.id } })) === 0);
    const kept = await db.callLog.findUnique({ where: { id: call.id }, select: { leadId: true } });
    ok("  the call logged against it stays, no longer pointing at it", kept !== null && kept.leadId === null);
    const entry = await db.auditLog.findFirst({ where: { action: "DELETE", entityType: "Lead", entityId: lead.id }, select: { userId: true, entityLabel: true, companyId: true } });
    ok("  the audit log has who and which, on its company", entry?.userId === asha.id && entry.entityLabel.includes("Zz Laptops") && entry.companyId === company.id, entry);
    ok("  deleting it again: it isn't there", !(await as(asha, () => del.deleteLead(lead.id))).ok);

    section("3. A day's attendance");
    const day = (date: string, extra: Record<string, unknown> = {}) => db.attendanceDay.create({ data: { userId: chen.id, date: new Date(`${date}T00:00:00Z`), status: "PRESENT", ...extra } });
    await day("2026-10-05");
    await day("2026-10-06");
    await db.attendanceLocation.create({ data: { userId: chen.id, date: new Date("2026-10-05T00:00:00Z"), kind: "IN" } });
    ok("an admin who isn't the super admin can't", !(await as(bala, () => del.deleteAttendanceDay({ userId: chen.id, date: "2026-10-05" }))).ok);
    const cleared = await as(asha, () => del.deleteAttendanceDay({ userId: chen.id, date: "2026-10-05" }));
    ok("the super admin deletes the 5th", cleared.ok && (await db.attendanceDay.count({ where: { userId: chen.id, date: new Date("2026-10-05T00:00:00Z") } })) === 0, cleared.ok ? "" : cleared.error);
    ok("  where they clocked in from that day goes with it", (await db.attendanceLocation.count({ where: { userId: chen.id, date: new Date("2026-10-05T00:00:00Z") } })) === 0);
    ok("  the 6th stays", (await db.attendanceDay.count({ where: { userId: chen.id, date: new Date("2026-10-06T00:00:00Z") } })) === 1);
    ok("  in the audit log", (await db.auditLog.count({ where: { action: "DELETE", entityType: "AttendanceDay", entityId: `${chen.id}:2026-10-05` } })) === 1);
    const nothing = await as(asha, () => del.deleteAttendanceDay({ userId: chen.id, date: "2026-10-07" }));
    ok("  a day with nothing recorded says so", !nothing.ok && /Nothing is recorded/.test(nothing.error));
    ok("  a date that isn't one is refused", !(await as(asha, () => del.deleteAttendanceDay({ userId: chen.id, date: "5 Oct" }))).ok);

    section("4. What stays");
    await day("2026-10-08", { status: "ON_LEAVE", leaveRequestId: "zz-leave" });
    const leave = await as(asha, () => del.deleteAttendanceDay({ userId: chen.id, date: "2026-10-08" }));
    ok("a day approved leave covers is refused — cancel the leave instead", !leave.ok && /leave/.test(leave.error) && (await db.attendanceDay.count({ where: { leaveRequestId: "zz-leave" } })) === 1);
    await db.payrollRun.create({ data: { month: 9, year: 2026, status: "LOCKED" } });
    await day("2026-09-15");
    const locked = await as(asha, () => del.deleteAttendanceDay({ userId: chen.id, date: "2026-09-15" }));
    ok("a day in a month whose payroll is locked is refused", !locked.ok && /payroll/.test(locked.error) && (await db.attendanceDay.count({ where: { userId: chen.id, date: new Date("2026-09-15T00:00:00Z") } })) === 1);
    await db.payrollRun.create({ data: { month: 8, year: 2026 } });
    await day("2026-08-14");
    ok("  a month whose payroll is still a draft: deleted", (await as(asha, () => del.deleteAttendanceDay({ userId: chen.id, date: "2026-08-14" }))).ok);
  } finally {
    actor = null;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} super-admin delete checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
