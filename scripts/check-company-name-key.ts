/**
 * check:company-name-key — a company's name as an import matches it, kept by the database (owner, 29 Oct 2026 —
 * migration 20261129100000, src/lib/companies/by-name.ts).
 *
 *   1. The database's key is legalNameKey's (src/lib/company-name.ts), name for name — legal forms, "(P)", "&", a
 *      leading "the", punctuation, and names that are none of these.
 *   2. It is kept on every write: a new company has it, a renamed one's follows.
 *   3. The match it was made for: among 600 companies whose names start "Shree", "Shree Ganesh Traders Pvt Ltd"
 *      finds "Shree Ganesh Traders Private Limited" — where the old search stopped at 500 and could miss.
 *   4. Two in the same legal-form name are left to the file to tell apart, as before.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:company-name-key
 */
import "dotenv/config";
import { execSync } from "node:child_process";
import { directClient } from "../src/lib/tenancy/direct-client";

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

const NAMES = [
  "Ingram Micro India Pvt. Ltd.",
  "Ingram Micro India Private Limited",
  "INGRAM MICRO INDIA (P) LTD",
  "Ingram Micro Singapore Pte Ltd",
  "The Acme & Sons Co.",
  "Acme and Sons Company",
  "M/S Metallicz Media",
  "Mission Compu Systems (Prakash M Somaiya)",
  "  Spaced   Out   Ltd  ",
  "W + K DESIGN & BIM CONSULTANTS LLP",
  "Bharat Heavy Electricals Limited (BHEL)",
  "Trinity Lubes & Greases FZC",
  "Mensch und Maschine Deutschland GmbH",
  "Corporate Professionals Capital Private Limited",
  "The",
  "The the Company Inc.",
  "Zexus Air Services Pvt Ltd",
  "Café Coffee Day Global Ltd",
  "123 Digital Corp",
  "Shree Ganesh Traders Private Limited",
];

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is not set.");
  const host = new URL(url).hostname;
  if (!["localhost", "127.0.0.1", "::1", "host.docker.internal"].includes(host)) throw new Error("not a local database");
  const scratch = `${new URL(url).pathname.slice(1)}_namekey`;
  const admin = directClient(withDatabase(url, "postgres"), { max: 1 });
  section("A scratch workspace");
  await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`);
  await admin.$executeRawUnsafe(`CREATE DATABASE "${scratch}"`);
  let close: (() => Promise<void>) | null = null;
  try {
    execSync("npx prisma migrate deploy", { stdio: "pipe", env: { ...process.env, DATABASE_URL: withDatabase(url, scratch) }, timeout: 10 * 60_000 });
    ok("built from the migrations", true);
    process.env.DATABASE_URL = withDatabase(url, scratch);
    process.env.CONTROL_DATABASE_URL = " ";
    process.env.DESKZO_TENANCY_FALLBACK = "legacy";
    /* eslint-disable @typescript-eslint/no-require-imports */
    const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
    close = () => db.$disconnect();
    const { legalNameKey, normalizeCompanyName } = require("../src/lib/company-name") as typeof import("../src/lib/company-name");
    const byName = require("../src/lib/companies/by-name") as typeof import("../src/lib/companies/by-name");
    /* eslint-enable @typescript-eslint/no-require-imports */

    section("1. The database's key is the app's");
    const differ: { name: string; app: string; db: string }[] = [];
    for (const name of NAMES) {
      const [row] = await db.$queryRaw<{ key: string }[]>`select company_legal_name_key(${name}) as key`;
      if (row?.key !== legalNameKey(name)) differ.push({ name, app: legalNameKey(name), db: row?.key ?? "(none)" });
    }
    ok(`the same key for all ${NAMES.length} names`, differ.length === 0, differ);

    section("2. Kept on every write");
    const boss = await db.user.create({ data: { name: "Zz Boss", email: "boss@zz-namekey.invalid", passwordHash: "!", role: "ADMIN" }, select: { id: true } });
    const make = (name: string) => db.company.create({ data: { name, normalizedName: normalizeCompanyName(name), createdById: boss.id }, select: { id: true } });
    const keyOf = async (id: string) => (await db.$queryRaw<{ k: string }[]>`select "legalNameKey" as k from "companies" where "id" = ${id}`)[0]?.k;
    const ingram = await make("Ingram Micro India Private Limited");
    ok("a new company has its key", (await keyOf(ingram.id)) === "ingram micro india pvt ltd");
    await db.company.update({ where: { id: ingram.id }, data: { name: "Ingram Micro Bharat Private Limited", normalizedName: normalizeCompanyName("Ingram Micro Bharat Private Limited") } });
    ok("  a renamed one's follows its name", (await keyOf(ingram.id)) === "ingram micro bharat pvt ltd");

    section("3. Among 600 named alike");
    await db.company.createMany({ data: Array.from({ length: 600 }, (_, i) => ({ name: `Shree Zz Trader ${i} Pvt Ltd`, normalizedName: `shree zz trader ${i} pvt ltd`, createdById: boss.id })) });
    const ganesh = await make("Shree Ganesh Traders Private Limited");
    ok("\"Shree Ganesh Traders Pvt Ltd\" finds \"Shree Ganesh Traders Private Limited\" among 600 starting \"Shree\"", (await byName.companyIdByName("Shree Ganesh Traders Pvt Ltd")) === ganesh.id);
    ok("  as a duplicate to stop, too", (await byName.companyNamedLike("Shree Ganesh Traders (P) Ltd."))?.id === ganesh.id);
    ok("  but never itself, when it is the one renamed", (await byName.companyNamedLike("Shree Ganesh Traders Pvt Ltd", ganesh.id)) === null);
    const plan = await db.$queryRaw<{ "QUERY PLAN": string }[]>`explain select "id" from "companies" where "legalNameKey" = ${"shree ganesh traders pvt ltd"}`;
    ok("  by the index, not a scan", plan.some((p) => /companies_legalNameKey_idx/.test(p["QUERY PLAN"])), plan);

    section("4. Two alike are the file's to tell apart");
    await make("Acme and Sons Company");
    await make("The Acme & Sons Co.");
    ok("two companies in one legal-form name: no match picked", (await byName.companyIdByName("Acme & Sons Co")) === null);
    ok("  an exact name still finds its own", (await byName.companyIdByName("Acme and Sons Company")) !== null);
  } finally {
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }
  console.log(failures === 0 ? `\nAll ${passes} company name key checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
