/**
 * check:assign-teams — which departments' people may be a company's caller, account manager or renewal manager (owner,
 * 30 Oct 2026 — src/lib/companies/assign-teams.ts).
 *
 *   1. No department ticked: anyone, as before.
 *   2. A department ticked: only its people; anybody else refused, saying which department; somebody with none too.
 *   3. Every road refuses: one company and a selection, for caller, account manager and renewal manager; a vendor's
 *      "assigned to" is its onboarding and the caller rule leaves it alone; whoever has it already keeps it.
 *   4. The pickers' list says what each person may be given.
 *   5. Ticking is for whoever manages departments.
 *
 * In a scratch workspace built from the migrations, dropped after.
 *
 *   npm run check:assign-teams
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
  requireModuleUser: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
  // A module's own actions ask the section as well (audit L-6); here, as the plan, only who is calling.
  requireModuleAccess: async () => {
    if (!actor) throw new Error("The check called an action without saying who was calling it.");
    return actor;
  },
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
// React's `cache` keeps a value for one request; a script is one long request, so each call reads afresh.
const react = { ...(Module.createRequire(__filename)("react") as object), cache: <T,>(fn: T) => fn };
const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["@/lib/session", session],
  ["react", react],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("react"), react],
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
  const scratch = `${realName}_assignteams`;
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
    const teams = require("../src/lib/companies/assign-teams") as typeof import("../src/lib/companies/assign-teams");
    const company = require("../src/actions/company") as typeof import("../src/actions/company");
    const renewal = require("../src/actions/renewal") as typeof import("../src/actions/renewal");
    const department = require("../src/actions/department") as typeof import("../src/actions/department");
    /* eslint-enable @typescript-eslint/no-require-imports */
    const sales = await db.department.create({ data: { name: "Zz Sales" }, select: { id: true } });
    const support = await db.department.create({ data: { name: "Zz Support" }, select: { id: true } });
    const person = (name: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${name.toLowerCase().replace(/\W+/g, ".")}@zz-teams.in`, passwordHash: "!", role: "SALES", ...extra }, select: { id: true, name: true, email: true, role: true } });
    const boss = await person("Zz Boss", { role: "ADMIN", isSuperAdmin: true });
    const seller = await person("Zz Seller", { departmentId: sales.id });
    const helper = await person("Zz Helper", { departmentId: support.id });
    const loner = await person("Zz Loner");
    const as = (u: { id: string; name: string; email: string | null; role: string }) => (actor = { id: u.id, name: u.name, email: u.email!, role: u.role });
    as(boss);
    const client = (name: string, extra: Record<string, unknown> = {}) =>
      db.company.create({ data: { name, normalizedName: name.toLowerCase(), relationshipType: "CLIENT", stage: "CUSTOMER", createdById: boss.id, ownerUserId: boss.id, ...extra }, select: { id: true } });
    const acme = await client("Zz Acme");
    const beta = await client("Zz Beta");
    const vendor = await client("Zz Parts Vendor", { relationshipType: "VENDOR", stage: "PROSPECT" });

    section("1. No department ticked");
    ok("anyone may be given any of the three", (await teams.assignRefusal("caller", helper.id)) === null && (await teams.assignRefusal("accountManager", loner.id)) === null && (await teams.assignRefusal("renewalManager", helper.id)) === null);
    ok("  and the caller is set", (await company.setCompanyCaller(acme.id, helper.id)).ok);

    section("2. A department ticked");
    ok("ticking Sales as callers", (await department.setDepartmentAssignTeam(sales.id, "caller", true)).ok);
    ok("someone in Sales may call", (await teams.assignRefusal("caller", seller.id)) === null);
    const refusal = await teams.assignRefusal("caller", helper.id);
    ok("  someone in Support may not, and is told who may", !!refusal && refusal.includes("Zz Sales") && refusal.includes("Zz Helper"), refusal);
    ok("  nor someone in no department", (await teams.assignRefusal("caller", loner.id)) !== null);
    ok("  the other two stay open — nothing ticked for them", (await teams.assignRefusal("accountManager", helper.id)) === null && (await teams.assignRefusal("renewalManager", helper.id)) === null);

    section("3. Every road refuses");
    ok("one company's caller: Support refused", !(await company.setCompanyCaller(beta.id, helper.id)).ok);
    ok("  Sales taken", (await company.setCompanyCaller(beta.id, seller.id)).ok);
    ok("  whoever has it already keeps it — saving the same caller again isn't refused", (await company.setCompanyCaller(acme.id, helper.id)).ok && (await db.company.findUnique({ where: { id: acme.id }, select: { assignedToUserId: true } }))?.assignedToUserId === helper.id);
    ok("  a vendor's \"assigned to\" is its onboarding: anyone", (await company.setCompanyCaller(vendor.id, helper.id)).ok);
    ok("a selection's caller: refused", !(await company.assignCompanies({ companyIds: [acme.id, beta.id], userId: loner.id })).ok);
    ok("  through bulk update too", !(await company.bulkUpdateCompanies({ companyIds: [acme.id, beta.id], assignedToUserId: loner.id, addTags: [] })).ok);
    ok("  a selection of vendors only: anyone", (await company.assignCompanies({ companyIds: [vendor.id], userId: loner.id })).ok);

    await department.setDepartmentAssignTeam(sales.id, "accountManager", true);
    ok("account manager, Sales ticked: Support refused on one company", !(await company.setCompanyOwner(acme.id, helper.id)).ok);
    ok("  and on a selection", !(await company.bulkUpdateCompanies({ companyIds: [acme.id, beta.id], ownerUserId: helper.id, addTags: [] })).ok);
    ok("  Sales taken", (await company.setCompanyOwner(acme.id, seller.id)).ok);

    await department.setDepartmentAssignTeam(support.id, "renewalManager", true);
    ok("renewal manager, Support ticked: Sales refused", !(await company.setCompanyRenewalManager(acme.id, seller.id)).ok);
    ok("  Support taken", (await company.setCompanyRenewalManager(acme.id, helper.id)).ok);
    ok("  back to the account manager is always allowed", (await company.setCompanyRenewalManager(acme.id, null)).ok);
    const item = await db.item.create({ data: { name: "Zz Licence", sku: "ZZ-TEAMS-1", type: "SUBSCRIPTION", billingCycle: "ANNUAL", sellingPrice: 100, createdById: boss.id }, select: { id: true } });
    const site = await db.companyLocation.create({ data: { companyId: beta.id, label: "HO", isPrimary: true, city: "Pune", state: "Maharashtra", pincode: "411001", country: "India" }, select: { id: true } });
    const order = await db.companyProduct.create({
      data: { companyId: beta.id, locationId: site.id, itemId: item.id, addedByUserId: boss.id, quantity: 1, unitPrice: 100, fullTermUnitPrice: 100, startDate: new Date("2026-02-01T00:00:00Z"), endDate: new Date("2027-01-31T00:00:00Z"), orderStatus: "FULFILLED" },
      select: { id: true },
    });
    const bulk = await renewal.bulkSetRenewalManager({ orderIds: [order.id], userId: seller.id });
    ok("  a selection of renewals: Sales refused", !bulk.ok, bulk);

    section("4. The pickers' list");
    const listed = await company.listAssignableUsers();
    const takes = (id: string) => listed.find((u) => u.id === id)?.takes;
    ok("Sales: caller and account manager, not renewals", JSON.stringify(takes(seller.id)) === JSON.stringify({ leadOwner: true, caller: true, accountManager: true, renewalManager: false }), takes(seller.id));
    ok("  Support: renewals only", JSON.stringify(takes(helper.id)) === JSON.stringify({ leadOwner: true, caller: false, accountManager: false, renewalManager: true }), takes(helper.id));
    ok("  no department: none of them", JSON.stringify(takes(loner.id)) === JSON.stringify({ leadOwner: true, caller: false, accountManager: false, renewalManager: false }), takes(loner.id));
    const shown = await department.listDepartments();
    ok("Settings › Departments shows the ticks", shown.some((d) => d.id === sales.id && d.callerTeam && d.accountManagerTeam && !d.renewalManagerTeam));

    section("4b. Lead owner (owner, 20 Nov 2026)");
    ok("none ticked for leads: anyone may own one", (await teams.assignRefusal("leadOwner", helper.id)) === null);
    ok("  ticking Sales for leads", (await department.setDepartmentAssignTeam(sales.id, "leadOwner", true)).ok);
    ok("  then Support is refused, by name", /only someone in .*Sales/.test((await teams.assignRefusal("leadOwner", helper.id)) ?? ""));
    ok("  and Sales may", (await teams.assignRefusal("leadOwner", seller.id)) === null);
    const relisted = await company.listAssignableUsers();
    ok("  the pickers see it", relisted.find((u) => u.id === seller.id)?.takes.leadOwner === true && relisted.find((u) => u.id === helper.id)?.takes.leadOwner === false);
    ok("  Settings › Departments shows the tick", (await department.listDepartments()).some((d) => d.id === sales.id && d.leadOwnerTeam));
    ok("  unticked: anyone again", (await department.setDepartmentAssignTeam(sales.id, "leadOwner", false)).ok && (await teams.assignRefusal("leadOwner", helper.id)) === null);

    section("4c. Counting a team: active people, the switched-off said apart (owner, 25 Nov 2026)");
    const { peopleCount, ofThemSwitchedOff } = await import("../src/lib/people-count");
    const { roleHeadcount } = await import("../src/lib/authz/role-registry");
    const wasIn = (await department.listDepartments()).find((d) => d.id === sales.id)!;
    const heldBefore = (await roleHeadcount())[seller.role]!;
    await db.user.update({ where: { id: seller.id }, data: { active: false } });
    const nowIn = (await department.listDepartments()).find((d) => d.id === sales.id)!;
    ok("somebody switched off leaves the team's count", nowIn.people.active === wasIn.people.active - 1 && nowIn.people.switchedOff === wasIn.people.switchedOff + 1, nowIn.people);
    ok("  and still holds its deletion back", nowIn._count.members === wasIn._count.members);
    const heldNow = (await roleHeadcount())[seller.role]!;
    ok("  a role the same", heldNow.all === heldBefore.all && heldNow.switchedOff === heldBefore.switchedOff + 1, heldNow);
    await db.user.update({ where: { id: seller.id }, data: { active: true } });
    ok("  switched on, counted again", (await department.listDepartments()).find((d) => d.id === sales.id)!.people.active === wasIn.people.active);
    ok("  as it reads", peopleCount(17, 37, "member", "members") === "17 members · 37 switched off" && peopleCount(1, 0, "member", "members") === "1 member" && peopleCount(0, 11, "member", "members") === "0 members · 11 switched off");
    ok("  and in a refusal", ofThemSwitchedOff(3, 2) === " (2 switched off)" && ofThemSwitchedOff(3, 3) === " (all switched off)" && ofThemSwitchedOff(1, 1) === " (switched off)" && ofThemSwitchedOff(3, 0) === "");

    section("5. Who may tick");
    as(seller);
    ok("a rep is refused", !(await department.setDepartmentAssignTeam(sales.id, "renewalManager", true)).ok);
    as(boss);
    ok("  a made-up role is refused", !(await department.setDepartmentAssignTeam(sales.id, "toString" as never, true)).ok);
    ok("  unticked: anyone again", (await department.setDepartmentAssignTeam(sales.id, "caller", false)).ok && (await teams.assignRefusal("caller", loner.id)) === null);
  } finally {
    actor = null;
    await close?.().catch(() => {});
    await admin.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${scratch}" WITH (FORCE)`).catch(() => {});
    const left = await admin.$queryRawUnsafe<{ n: bigint }[]>(`select count(*)::bigint as n from pg_database where datname = '${scratch}'`);
    ok("the scratch database is dropped", Number(left[0]?.n ?? 1) === 0);
    await admin.$disconnect();
  }

  console.log(failures === 0 ? `
All ${passes} assign-team checks passed.
` : `
${failures} check(s) FAILED (${passes} passed).
`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
