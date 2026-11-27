/**
 * check:onboarding-board — the console's onboarding board (owner, 29 Oct 2026 — src/lib/platform/onboarding.ts,
 * /onboarding in the console).
 *
 *   1. A workspace switching to Deskzo is read from inside it: each section's counts, what its rows wait for, the
 *      month check's tally, the Zoho pull's state, and its last sign of activity.
 *   2. Its flags, worst first: a stopped pull, rows refused, rows waiting, quiet for days; "Ready to finish" when every
 *      month agrees.
 *   3. Progress only: no row's own wording — an invoice number, a reason — reaches the board.
 *   4. Finished, it moves to the last 30 days' list.
 *   5. A workspace that can't be read is listed as such; the others still are.
 *
 * In a scratch workspace database built from the migrations, dropped after.
 *
 *   npm run check:onboarding-board
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import type { Tenant } from "../src/lib/tenancy/state";
import { directClient } from "../src/lib/tenancy/direct-client";

process.env.DESKZO_TENANCY_FALLBACK = "legacy";
// Emptied, not deleted: a Prisma client imported later reloads .env and would put a deleted value back.
process.env.REFERENCE_DATABASE_URL = "";
process.env.CONTROL_DATABASE_URL = "";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);
const withDatabase = (url: string, name: string) => {
  const u = new URL(url);
  u.pathname = `/${name}`;
  return u.toString();
};
const DAY = 86_400_000;

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(new URL(url).hostname)) throw new Error("not a local database");
  const scratchName = `${new URL(url).pathname.slice(1)}_onboarding`;
  const scratchUrl = withDatabase(url, scratchName);
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  section("A scratch workspace");
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${scratchName}"`);
  let close: (() => Promise<void>) | null = null;
  try {
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: scratchUrl }, timeout: 10 * 60_000 });
    ok("built from the migrations", true);
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { closeAllClients } = require("../src/lib/tenancy/clients") as typeof import("../src/lib/tenancy/clients");
    const { UNRESTRICTED } = require("../src/lib/entitlements") as typeof import("../src/lib/entitlements");
    const board = require("../src/lib/platform/onboarding") as typeof import("../src/lib/platform/onboarding");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const scratch = directClient(scratchUrl);
    close = async () => {
      await closeAllClients();
      await scratch.$disconnect();
    };
    const tenantFor = (id: string, slug: string, dbUrl: string): Tenant => ({
      id,
      slug,
      name: `Zz ${slug}`,
      status: "ACTIVE",
      dbUrl,
      primaryHost: `${slug}.localhost:3000`,
      hosts: [`${slug}.localhost:3000`],
      source: "env",
      isDefault: false,
      keyBundleCipher: null,
      country: "IN",
      entitlements: { ...UNRESTRICTED },
      holdReason: null,
    });
    const switching = tenantFor("zz-onboarding", "zzswitch", scratchUrl);
    const gone = tenantFor("zz-onboarding-gone", "zzgone", withDatabase(url, `${scratchName}_not_there`));

    // A switch five days quiet: invoices in, receipts with one row waiting for an invoice and one refused, a pull that stopped.
    const now = new Date();
    const fiveDaysAgo = new Date(now.getTime() - 5 * DAY);
    const boss = await scratch.user.create({ data: { name: "Zz Boss", email: "boss@zz-onboarding.invalid", passwordHash: "!", role: "ADMIN" }, select: { id: true } });
    const m = await scratch.migration.create({
      data: { source: "zoho-books", yearStart: new Date("2026-04-01T00:00:00Z"), switchDate: new Date("2026-07-01T00:00:00Z"), createdById: boss.id, createdAt: fiveDaysAgo, counts: { invoices: 10, receipts: 4 } },
      select: { id: true },
    });
    await scratch.migrationFile.create({
      data: {
        migrationId: m.id,
        step: "receipts",
        filename: "Customer_Payment.csv",
        rows: [],
        units: 6,
        done: 6,
        failures: [
          { line: 2, key: "R-1", error: "Invoice ZZ-SECRET-77 for Zz Customer isn't in Deskzo. Bring the invoices across first.", waitFor: "invoices" },
          { line: 3, key: "R-2", error: "Zz private reason: that isn't a date." },
        ],
        createdById: boss.id,
        createdAt: fiveDaysAgo,
      },
    });
    await scratch.migrationRecord.create({ data: { migrationId: m.id, kind: "document", recordId: "zz-doc-1", key: "ZZ-INV-1", createdAt: fiveDaysAgo } });
    await scratch.zohoPull.create({ data: { migrationId: m.id, status: "FAILED", error: "Zoho refused the token", startedById: boss.id, startedAt: fiveDaysAgo } });

    section("1. Read from inside the workspace");
    const b1 = await board.onboardingBoard(now, { tenants: [switching, gone] });
    const s = b1.inProgress.find((x) => x.slug === "zzswitch");
    ok("the switching workspace is listed, with its year and source", !!s && s.source === "zoho-books" && s.yearStart === "2026-04-01" && s.switchDate === "2026-07-01", s);
    const receipts = s?.sections.find((x) => x.key === "receipts");
    ok("  receipts: 4 brought, 6 of 6 gone through, 1 waiting, 1 refused", receipts?.brought === 4 && receipts.units === 6 && receipts.done === 6 && receipts.waiting === 1 && receipts.refused === 1, receipts);
    ok("  invoices: 10 brought, no file kept", s?.sections.find((x) => x.key === "invoices")?.brought === 10);
    ok("  what the rows wait for: Invoices (1)", s?.waitingFor.length === 1 && s.waitingFor[0]!.label === "Invoices" && s.waitingFor[0]!.n === 1, s?.waitingFor);
    ok("  the month check: three months, none uploaded", s?.months.total === 3 && s.months.uploaded === 0 && s.months.agreeing === 0, s?.months);
    ok("  the pull: stopped, with Zoho's reason", s?.pull?.status === "FAILED" && /refused/.test(s.pull.error ?? ""), s?.pull);
    ok("  last activity five days ago", !!s && Math.abs(s.lastActivity.getTime() - fiveDaysAgo.getTime()) < 1000, s?.lastActivity);

    section("2. Its flags, worst first");
    const labels = s?.flags.map((f) => f.label) ?? [];
    ok("stopped pull, refused, waiting, quiet 5 days — in that order", labels.join(" | ") === "Zoho pull stopped | 1 refused | 1 waiting | Quiet 5 days", labels);
    ok("  red, red, amber, amber", s?.flags.map((f) => f.tone).join() === "danger,danger,warning,warning");
    const readyFlags = board.flagsFor({ ...s!, pull: null, refused: 0, waiting: 0, lastActivity: now, months: { total: 3, uploaded: 3, agreeing: 3 } }, now);
    ok("every month agreeing, nothing else: Ready to finish", readyFlags.length === 1 && readyFlags[0]!.label === "Ready to finish" && readyFlags[0]!.tone === "success", readyFlags);
    const offFlags = board.flagsFor({ ...s!, pull: { status: "WAITING", module: "Bills", callsToday: 6750, allowance: 6750, error: null }, refused: 0, waiting: 0, lastActivity: now, months: { total: 3, uploaded: 3, agreeing: 1 } }, now);
    ok("  calls used for today, and two months off", offFlags.map((f) => f.label).join(" | ") === "Zoho's calls used for today | 2 months off", offFlags);

    section("3. Progress only");
    const shown = JSON.stringify(b1);
    ok("no row's own wording reaches the board — not its invoice number, its party or its reason", !shown.includes("ZZ-SECRET-77") && !shown.includes("Zz Customer") && !shown.includes("private reason") && !shown.includes("ZZ-INV-1"));

    section("5. A workspace that can't be read");
    const g = b1.unread.find((x) => x.slug === "zzgone");
    ok("listed with why, and the other one still read", !!g && g.reason.length > 0 && b1.inProgress.length === 1 && b1.workspaces === 2, b1.unread);

    section("4. Finished");
    await scratch.migration.update({ where: { id: m.id }, data: { status: "FINISHED", finishedAt: now, finishedById: boss.id } });
    const b2 = await board.onboardingBoard(now, { tenants: [switching] });
    ok("no longer in progress; in the last 30 days' list", b2.inProgress.length === 0 && b2.finished.length === 1 && b2.finished[0]!.slug === "zzswitch" && b2.finished[0]!.source === "zoho-books", b2);
    await scratch.migration.update({ where: { id: m.id }, data: { finishedAt: new Date(now.getTime() - 40 * DAY) } });
    const b3 = await board.onboardingBoard(now, { tenants: [switching] });
    ok("  finished 40 days ago: off the board", b3.inProgress.length === 0 && b3.finished.length === 0, b3);
  } finally {
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratchName}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratchName}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }
  console.log(failures === 0 ? `\nAll ${passes} onboarding board checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
