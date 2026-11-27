/**
 * check:migration-repairs — a half-applied migration is put back by the next deploy
 * (src/lib/platform/migration-repairs.ts), as live's databases are after 20261201200000_employee_loans.
 *
 * On a scratch database of its own: every migration before the loans one, then the loans migration as
 * it first shipped (with the duplicate custom_field_reveals), which fails part-way exactly as it did on
 * live. Then the ordinary migrateDeploy: the repair must undo the half, mark it rolled back, and the
 * fixed file and everything after it must apply. A second case leaves a row in employee_loans and
 * expects the repair to refuse. The scratch databases are dropped in a finally.
 *
 *   npm run check:migration-repairs
 */
import "dotenv/config";
import { execFileSync } from "node:child_process";
import { cpSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { directClient } from "../src/lib/tenancy/direct-client";
import { migrateDeploy } from "../src/lib/platform/migrate";
import { repairKnownFailures } from "../src/lib/platform/migration-repairs";

const LOANS = "20261201200000_employee_loans";
let failures = 0;
function check(label: string, ok: boolean, detail?: unknown) {
  if (ok) console.log(`  ok    ${label}`);
  else {
    failures++;
    console.log(`  FAIL  ${label}${detail === undefined ? "" : ` — ${JSON.stringify(detail)}`}`);
  }
}

function urlFor(name: string) {
  const u = new URL(process.env.DATABASE_URL!);
  u.pathname = `/${name}`;
  return u.toString();
}

/** The loans migration as it shipped in 710f5f66's parent chain, before be2e6f84 fixed it. */
function originalLoans(): string {
  return execFileSync("git", ["show", `be2e6f84~1:prisma/migrations/${LOANS}/migration.sql`], { encoding: "utf8" });
}

/** A folder of migrations up to and including the broken loans one — what live ran. */
function brokenFolder(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "zzprobe-migrations-"));
  const migrations = path.join(dir, "migrations");
  const source = path.join(process.cwd(), "prisma", "migrations");
  for (const name of readdirSync(source)) {
    if (/^\d{14}_/.test(name) && name > LOANS) continue;
    cpSync(path.join(source, name), path.join(migrations, name), { recursive: true });
  }
  writeFileSync(path.join(migrations, LOANS, "migration.sql"), originalLoans());
  cpSync(path.join(process.cwd(), "prisma", "schema.prisma"), path.join(dir, "schema.prisma"));
  return dir;
}

function deployFrom(folder: string, url: string): { ok: boolean; output: string } {
  const cli = path.join(process.cwd(), "node_modules", "prisma", "build", "index.js");
  try {
    const output = execFileSync(process.execPath, [cli, "migrate", "deploy", "--schema", path.join(folder, "schema.prisma")], {
      env: { ...process.env, DATABASE_URL: url },
      encoding: "utf8",
      stdio: "pipe",
    });
    return { ok: true, output };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string };
    return { ok: false, output: `${e.stdout ?? ""}${e.stderr ?? ""}` };
  }
}

async function main() {
  const admin = directClient(urlFor("postgres"));
  const names = ["zzprobe_repair_a", "zzprobe_repair_b"];
  const folder = brokenFolder();
  try {
    for (const name of names) {
      await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${name}`);
      await admin.$executeRawUnsafe(`CREATE DATABASE ${name}`);
    }

    console.log("Live's state, reproduced");
    for (const name of names) {
      const first = deployFrom(folder, urlFor(name));
      check(`${name}: the broken loans migration fails as on live`, !first.ok && /42P07|already exists/.test(first.output), first.output.slice(-300));
    }
    const a = directClient(urlFor(names[0]!));
    const left = await a.$queryRawUnsafe<{ t: string | null }[]>(`SELECT to_regclass('"employee_loans"')::text AS t`);
    check("…rolled back whole: no employee_loans left behind", !left[0]?.t);
    const blocked = deployFrom(path.join(process.cwd(), "prisma"), urlFor(names[0]!));
    check("…and a plain deploy of the fixed files is refused (P3009)", !blocked.ok && /P3009|failed migrations/.test(blocked.output), blocked.output.slice(-300));

    console.log("The repair");
    const output = await migrateDeploy(urlFor(names[0]!));
    check("migrateDeploy says it repaired the loans migration", output.includes(`Repaired failed migration ${LOANS}`), output.slice(0, 200));
    const rows = await a.$queryRawUnsafe<{ migration_name: string; finished_at: Date | null; rolled_back_at: Date | null }[]>(
      `SELECT migration_name, finished_at, rolled_back_at FROM "_prisma_migrations" WHERE migration_name = $1 ORDER BY started_at`,
      LOANS,
    );
    check("the failed row is rolled back, a new one finished", rows.length === 2 && !!rows[0]!.rolled_back_at && !!rows[1]!.finished_at, rows);
    const latest = readdirSync(path.join(process.cwd(), "prisma", "migrations")).filter((n) => /^\d{14}_/.test(n)).sort().at(-1)!;
    const done = await a.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = $1 AND finished_at IS NOT NULL`, latest);
    check(`everything after it applied, up to ${latest}`, done[0]?.n === 1);
    const column = await a.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name = 'payslips' AND column_name = 'loanRecovery'`);
    check("payslips.loanRecovery is there once", column[0]?.n === 1);
    const again = await repairKnownFailures(urlFor(names[0]!));
    check("run again: nothing to repair", again.length === 0, again);
    await a.$disconnect();

    console.log("Rows written since: refused");
    const b = directClient(urlFor(names[1]!));
    // A database where the half did survive (a stand-in table), with a row written since.
    await b.$executeRawUnsafe(`CREATE TABLE "employee_loans" ("id" TEXT PRIMARY KEY)`);
    await b.$executeRawUnsafe(`INSERT INTO "employee_loans" ("id") VALUES ('zzl')`);
    const notes = await repairKnownFailures(urlFor(names[1]!));
    check("a loan row: the repair refuses and says why", notes.length === 1 && notes[0]!.outcome === "refused" && /employee_loans/.test(notes[0]!.reason ?? ""), notes);
    const still = await b.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "employee_loans"`);
    check("…and the row is untouched", still[0]?.n === 1);
    const kept = await b.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "_prisma_migrations" WHERE migration_name = $1 AND rolled_back_at IS NULL AND finished_at IS NULL`, LOANS);
    check("…and the failed row is left for a person", kept[0]?.n === 1);
    await b.$executeRawUnsafe(`DELETE FROM "employee_loans"`);
    const now = await repairKnownFailures(urlFor(names[1]!));
    check("emptied: the stand-in is dropped and the row rolled back", now.length === 1 && now[0]!.outcome === "repaired", now);
    await b.$disconnect();
  } finally {
    rmSync(folder, { recursive: true, force: true });
    for (const name of names) await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`).catch(() => null);
    await admin.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
