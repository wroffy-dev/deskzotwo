/**
 * check:filing-deadlines — the filing calendar (owner, 29 Oct 2026; src/lib/compliance): GSTR-1 by the 11th, GSTR-3B by the
 * 20th, TDS by the 7th (March's by 30 April), the quarterly TDS and TCS returns; only what the workspace owes; the bell
 * three days before and the day after a miss, once each; marked filed, it stops. On a scratch workspace database.
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const withDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => (actorId ? { id: actorId, role: "ADMIN", name: "Zz", email: `${actorId}@zzfiling.invalid` } : null);
    return {
      requireUser: async () => {
        const u = await user();
        if (!u) throw new Error("Unauthorized");
        return u;
      },
      currentUser: user,
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => null,
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is needed.");
  if (!["localhost", "127.0.0.1", "::1"].includes(new URL(url).hostname)) throw new Error("Only against a local database server.");
  const scratchName = `${new URL(url).pathname.slice(1)}_filing_deadlines_check`;
  const scratchUrl = withDatabase(url, scratchName);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  section("A scratch workspace");
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
  try {
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("built from its migrations", true);
    // Off by value, never deleted, so a client re-reading .env can't put them back.
    process.env.DATABASE_URL = scratchUrl;
    process.env.CONTROL_DATABASE_URL = " ";
    process.env.DESKZO_TENANCY_FALLBACK = "legacy";
    await scenario();
  } finally {
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRaw<{ n: bigint }[]>`select count(*)::bigint as n from pg_database where datname = ${scratchName}`;
    ok("the scratch workspace is dropped", Number(left[0]!.n) === 0);
    await admin.$disconnect();
  }
  console.log(failures === 0 ? "\nAll filing deadline checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

async function scenario() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const cal = require("../src/lib/compliance/deadlines") as typeof import("../src/lib/compliance/deadlines");
  const filings = require("../src/lib/compliance/filings") as typeof import("../src/lib/compliance/filings");
  const actions = require("../src/actions/compliance") as typeof import("../src/actions/compliance");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("The calendar");
  const all = { gst: true, tds: true, salaryTds: true, tcs: true };
  const nov = cal.deadlinesDue("2026-11-01", "2026-11-30", all);
  const due = (key: string, list = nov) => list.find((d) => d.key === key)?.due;
  ok("October's GSTR-1 by 11 November, its GSTR-3B by 20 November, its TDS by 7 November", due("GSTR1:2026-10") === "2026-11-11" && due("GSTR3B:2026-10") === "2026-11-20" && due("TDS_DEPOSIT:2026-10") === "2026-11-07", nov.map((d) => `${d.key} ${d.due}`));
  const april = cal.deadlinesDue("2026-04-01", "2026-04-30", all);
  ok("  March's TDS by 30 April, not the 7th", due("TDS_DEPOSIT:2026-03", april) === "2026-04-30" && !april.some((d) => d.key === "TDS_DEPOSIT:2026-03" && d.due === "2026-04-07"), april.map((d) => `${d.key} ${d.due}`));
  const year = cal.deadlinesDue("2026-04-01", "2027-05-31", all);
  ok(
    "the quarterly TDS returns by 31 July, 31 October, 31 January, 31 May; TCS's by the 15th",
    due("TDS26Q:2026-Q1", year) === "2026-07-31" && due("TDS26Q:2026-Q2", year) === "2026-10-31" && due("TDS24Q:2026-Q3", year) === "2027-01-31" && due("TDS26Q:2026-Q4", year) === "2027-05-31" && due("TCS27EQ:2026-Q2", year) === "2026-10-15",
    year.filter((d) => /Q\d/.test(d.key)).map((d) => `${d.key} ${d.due}`),
  );
  ok("  soonest first", nov.every((d, i) => i === 0 || nov[i - 1]!.due <= d.due));
  const gstOnly = cal.deadlinesDue("2026-11-01", "2026-11-30", { gst: true, tds: false, salaryTds: false, tcs: false });
  ok("only what a business owes: GST alone, no TDS", gstOnly.length === 2 && gstOnly.every((d) => d.kind === "GSTR1" || d.kind === "GSTR3B"));
  ok("days to a date, negative once past", cal.daysTo("2026-11-08", "2026-11-11") === 3 && cal.daysTo("2026-11-12", "2026-11-11") === -1);

  section("This workspace");
  const boss = await db.user.create({ data: { name: "Zz Boss", email: "boss@zzfiling.invalid", role: "ADMIN", isSuperAdmin: true, passwordHash: "x".repeat(60) } });
  actorId = boss.id;
  ok("nothing owed with no GST registration and no TDS", Object.values(await filings.liability()).every((v) => !v));
  await db.gstRegistration.create({ data: { gstin: "27AAACZ1234F1Z5", stateCode: "27", code: "ZZMH" } });
  const owed = await filings.liability();
  ok("  a GST registration: GST returns owed, still no TDS", owed.gst && !owed.tds && !owed.salaryTds && !owed.tcs, owed);
  const nov8 = await filings.filingCalendar("2026-11-08");
  ok("on 8 November: October's GSTR-1 in 3 days and GSTR-3B in 12", nov8.rows.find((r) => r.key === "GSTR1:2026-10")?.daysLeft === 3 && nov8.rows.find((r) => r.key === "GSTR3B:2026-10")?.daysLeft === 12, nov8.rows.map((r) => `${r.key} ${r.daysLeft}`));

  section("The bell");
  const first = await filings.filingChores(new Date("2026-11-08T06:00:00Z"));
  const bells = await db.notification.findMany({ where: { type: "FILING_DUE" }, select: { userId: true, title: true, link: true } });
  ok("three days before, whoever keeps the books is told — once", first.told === 1 && bells.length === 1 && bells[0]!.userId === boss.id && /GSTR-1 for October 2026 is due in 3 days/.test(bells[0]!.title), bells);
  await filings.filingChores(new Date("2026-11-08T12:00:00Z"));
  ok("  a second beat the same day tells nobody again", (await db.notification.count({ where: { type: "FILING_DUE" } })) === 1);
  await filings.filingChores(new Date("2026-11-12T06:00:00Z"));
  ok("missed: told the day after, once more", (await db.notification.findMany({ where: { type: "FILING_DUE" }, select: { title: true } })).some((n) => /was due yesterday/.test(n.title)));

  section("Marked filed");
  const marked = await actions.markFilingDone("GSTR3B:2026-10", "2026-11-15", "AA271026123456X");
  ok("GSTR-3B marked filed, with its ARN", marked.ok && (await db.complianceFiling.findUnique({ where: { key: "GSTR3B:2026-10" } }))?.reference === "AA271026123456X", marked);
  const before = await db.notification.count({ where: { type: "FILING_DUE" } });
  await filings.filingChores(new Date("2026-11-17T06:00:00Z"));
  ok("  its reminder doesn't ring", (await db.notification.count({ where: { type: "FILING_DUE" } })) === before);
  const after = await filings.filingCalendar("2026-11-17");
  ok("  on the list as filed; the missed GSTR-1 still there, not filed", after.rows.find((r) => r.key === "GSTR3B:2026-10")?.filed?.on === "2026-11-15" && after.rows.find((r) => r.key === "GSTR1:2026-10")?.filed === null);
  ok("a key that isn't a filing is refused", !(await actions.markFilingDone("GSTR9:2026", "2026-11-15")).ok);
  const back = await actions.markFilingDone("GSTR3B:2026-10", null);
  ok("  and a mark taken back", back.ok && !(await db.complianceFiling.findUnique({ where: { key: "GSTR3B:2026-10" } })));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
