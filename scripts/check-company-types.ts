/**
 * check:company-types — the workspace's own company types (owner, 27 Oct 2026; src/actions/company-type.ts,
 * src/lib/companies/company-types.ts, the old CRM import's company_type columns in src/lib/legacy-import/apply.ts).
 *
 * On a scratch workspace database of its own (<db>_company_types_check, built from the migrations and dropped at the
 * end, pass or fail):
 *
 *   · the eight Deskzo came with are there, under the keys they always had;
 *   · someone without settings.manage is refused; an admin adds one (its key from its name), renames it (key kept),
 *     and deleting one clears it from the companies that had it;
 *   · imported text finds its type — the old CRM's slugs, "Pvt Ltd", a name of the workspace's own — and text
 *     naming no type ("Construction") finds none.
 *
 * The session is a stand-in; nothing is written to any other database.
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
    const user = async () => (actorId ? { id: actorId, role: "ADMIN", name: "Zz", email: `${actorId}@zzctypes.invalid` } : null);
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
  const scratchName = `${new URL(url).pathname.slice(1)}_company_types_check`;
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
  console.log(failures === 0 ? "\nAll company type checks passed." : `\n${failures} check(s) FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
}

async function scenario() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const types = require("../src/actions/company-type") as typeof import("../src/actions/company-type");
  const lib = require("../src/lib/companies/company-types") as typeof import("../src/lib/companies/company-types");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const admin = await db.user.create({ data: { name: "Zz Admin", email: "admin@zzctypes.invalid", role: "ADMIN", passwordHash: "x".repeat(60) } });
  await db.userPermission.create({ data: { userId: admin.id, permission: "settings.manage", allowed: true, reason: "check:company-types" } });
  const rep = await db.user.create({ data: { name: "Zz Rep", email: "rep@zzctypes.invalid", role: "SALES", passwordHash: "x".repeat(60) } });
  await db.userPermission.create({ data: { userId: rep.id, permission: "settings.manage", allowed: false, reason: "check:company-types" } });

  section("What every workspace starts with");
  const start = await lib.companyTypeOptions();
  ok("the eight, under their old keys", start.length === 8 && ["PRIVATE_LIMITED", "PUBLIC_LIMITED", "PROPRIETORSHIP", "PARTNERSHIP", "LLP", "NGO", "GOVERNMENT", "OTHER"].every((k) => start.some((o) => o.key === k)), start);
  ok("  named for people", start.find((o) => o.key === "PRIVATE_LIMITED")?.name === "Private limited");

  section("Managing the list");
  actorId = rep.id;
  const byRep = await types.createCompanyType("Trust");
  ok("someone without settings.manage is refused", !byRep.ok && !(await db.companyTypeOption.findUnique({ where: { key: "TRUST" } })), byRep);
  actorId = admin.id;
  const trust = await types.createCompanyType("Section 8 company");
  ok("an admin adds one, its key from its name", trust.ok && trust.data.key === "SECTION_8_COMPANY", trust);
  const again = await types.createCompanyType("section 8 company");
  ok("  the same name twice is refused", !again.ok, again);
  if (!trust.ok) return;
  const renamed = await types.renameCompanyType(trust.data.id, "Section 8");
  const row = await db.companyTypeOption.findUnique({ where: { id: trust.data.id } });
  ok("renaming keeps the key", renamed.ok && row?.name === "Section 8" && row.key === "SECTION_8_COMPANY", { renamed, row });

  const holder = await db.company.create({ data: { name: "Zz Society", normalizedName: "zz society", relationshipType: "CLIENT", companyType: "SECTION_8_COMPANY", createdById: admin.id } });
  const other = await db.company.create({ data: { name: "Zz Private", normalizedName: "zz private", relationshipType: "CLIENT", companyType: "PRIVATE_LIMITED", createdById: admin.id } });
  const listed = await types.listCompanyTypesForSettings();
  ok("the list says how many companies hold each", listed.find((t) => t.key === "SECTION_8_COMPANY")?.used === 1, listed);
  const gone = await types.deleteCompanyType(trust.data.id);
  ok("deleting one clears it from its companies, and only those", gone.ok && gone.data.cleared === 1 && (await db.company.findUnique({ where: { id: holder.id } }))?.companyType === null && (await db.company.findUnique({ where: { id: other.id } }))?.companyType === "PRIVATE_LIMITED", gone);
  ok("  and it is in the audit log", !!(await db.auditLog.findFirst({ where: { entityType: "CompanyTypeOption", entityId: trust.data.id, action: "DELETE" } })));

  section("A company named in a file, in another legal form");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { companyIdByName } = require("../src/lib/companies/by-name") as typeof import("../src/lib/companies/by-name");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const ingram = await db.company.create({ data: { name: "Ingram Micro India Private Limited", normalizedName: "ingram micro india private limited", relationshipType: "VENDOR", createdById: admin.id } });
  await db.company.create({ data: { name: "Ingram Micro Singapore Pte Ltd", normalizedName: "ingram micro singapore pte ltd", relationshipType: "VENDOR", createdById: admin.id } });
  ok('"Ingram Micro India Pvt. Ltd." is Ingram Micro India Private Limited', (await companyIdByName("Ingram Micro India Pvt. Ltd.")) === ingram.id);
  ok("  so is its exact name, and PVT LTD in capitals", (await companyIdByName("ingram micro india private limited")) === ingram.id && (await companyIdByName("INGRAM MICRO INDIA PVT LTD")) === ingram.id);
  ok('  "Ingram Micro Pvt Ltd" (no India) is no company — every word but the legal form counts', (await companyIdByName("Ingram Micro Pvt Ltd")) === null);
  await db.company.create({ data: { name: "Zz Twin Pvt Ltd", normalizedName: "zz twin pvt ltd", relationshipType: "CLIENT", createdById: admin.id } });
  await db.company.create({ data: { name: "Zz Twin Private Limited", normalizedName: "zz twin private limited", relationshipType: "CLIENT", createdById: admin.id } });
  ok("  two that match only loosely are left for the file to tell apart", (await companyIdByName("Zz Twin Pvt. Limited")) === null);

  section("No twin made by hand, or by a quick lead");
  /* eslint-disable @typescript-eslint/no-require-imports */
  const companies = require("../src/actions/company") as typeof import("../src/actions/company");
  const quick = require("../src/actions/quick-lead") as typeof import("../src/actions/quick-lead");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const twin = await companies.createCompany({ name: "Ingram Micro India Pvt. Ltd." });
  ok('creating "Ingram Micro India Pvt. Ltd." is refused, naming the one there', !twin.ok && twin.error.includes("Ingram Micro India Private Limited"), twin);
  const harbour = await companies.createCompany({ name: "Zz Harbour Pvt Ltd" });
  ok("  a name that is nobody's is created", harbour.ok, harbour);
  if (harbour.ok) {
    const renamed = await companies.updateCompany({ id: harbour.data.id, name: "Ingram Micro India (Private) Limited" });
    ok("renaming a company into a twin is refused", !renamed.ok && /already exists/.test(renamed.error), renamed);
    const kept = await companies.updateCompany({ id: harbour.data.id, name: "Zz Harbour Private Limited" });
    ok("  renaming one to its own name in another legal form is not", kept.ok, kept);
  }
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { offersCreate } = require("../src/lib/company-name") as typeof import("../src/lib/company-name");
  /* eslint-enable @typescript-eslint/no-require-imports */
  ok('a picker with "Summit Motors Pvt Ltd" on its list offers no "Create new" for "summit motors private limited"', !offersCreate("summit motors private limited", ["Summit Motors Pvt Ltd"]) && offersCreate("summit motors india private limited", ["Summit Motors Pvt Ltd"]));
  const ability = await db.company.create({ data: { name: "Ability Engineering Private Limited", normalizedName: "ability engineering private limited", relationshipType: "CLIENT", createdById: admin.id } });
  await db.company.create({ data: { name: "Ability Engineering Works", normalizedName: "ability engineering works", relationshipType: "CLIENT", createdById: admin.id } });
  const searched = await companies.searchCustomerOptions("Ability Engineering pvt ltd");
  ok('searching "Ability Engineering pvt ltd" finds Ability Engineering Private Limited, and not Ability Engineering Works', searched.length === 1 && searched[0]!.id === ability.id, searched.map((c) => c.name));
  const parens = await companies.searchCustomerOptions("ability engineering (P) Ltd.");
  ok('  so does "(P) Ltd."', parens.length === 1 && parens[0]!.id === ability.id, parens.map((c) => c.name));
  const asked = await companies.findCompanyMatches("ingram micro india private ltd.", "CLIENT");
  ok('  and "Create new" for a name here in another spelling finds it (what Quick lead then picks)', asked.duplicate?.visible === true && asked.duplicate.match.id === ingram.id, asked.duplicate);
  const warned = await companies.findCompanyMatches("Ingram Micro India Pvt Ltd");
  ok("the form warns as it is typed", warned.duplicate?.visible === true && warned.duplicate.match.id === ingram.id, warned.duplicate);
  const lead = await quick.quickCreateLead({ companyName: "INGRAM MICRO INDIA PVT. LTD.", title: "Zz licences", requestId: "zz-ctypes-quick-0001" });
  ok("a quick lead typed so is on the company there", lead.ok ? (await db.lead.findUnique({ where: { id: lead.data.id }, select: { companyId: true } }))?.companyId === ingram.id || false : /vendor/.test(lead.error), lead);

  section("Imported text");
  const options = [...(await lib.companyTypeOptions()), { key: "TRUST", name: "Trust (registered)" }];
  const cases: [string, string | null][] = [
    ["private-limited", "PRIVATE_LIMITED"],
    ["Pvt Ltd", "PRIVATE_LIMITED"],
    [" PRIVATE LIMITED.", "PRIVATE_LIMITED"],
    ["limited", "PUBLIC_LIMITED"],
    ["sole-proprietorship", "PROPRIETORSHIP"],
    ["llp", "LLP"],
    ["government", "GOVERNMENT"],
    ["trust (registered)", "TRUST"],
    ["Construction ", null],
    ["", null],
  ];
  for (const [text, want] of cases) {
    const got = lib.companyTypeFromText(text, options);
    ok(`"${text}" → ${want ?? "none"}`, got === want, got);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
