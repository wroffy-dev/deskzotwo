/**
 * check:add-person — "Create and edit users" gives a way to add somebody (owner, 4 Nov 2026: an HR head held it with no
 * button, for the page also asked for "Review who can do what").
 *
 *   1. Holding users.manage without permissions.view: People has "Add a person"; the form opens, back to People, and
 *      offers Employee and nothing else (owner, 4 Nov 2026), whichever rights they hold; createUser holds to it too.
 *   2. Without users.manage: no button, and the page says they can't.
 *   3. With both: the form as before, back to Users.
 *   4. A role built by hand, holding none of Employee's starting rights, can still give Employee; anything more ticked
 *      on Employee is still checked, and the form says what.
 *   5. An Admin, and anybody granted "Change somebody's role", still start people in other roles, and never Admin here.
 *   6. The hiring board's joining role holds to the same rule when the candidate is saved.
 *
 * Makes three people in the dev workspace with personal grants and removes them, and anybody they made, afterwards.
 *
 *   npm run check:add-person
 */
import "dotenv/config";
import Module from "node:module";
import type { ReactElement } from "react";
import { directClient } from "../src/lib/tenancy/direct-client";

type Actor = { id: string; role: string; name: string; email: string };
let actor: Actor | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return { requireUser: async () => actor, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleUser: async () => actor };
  }
  if (request === "@/actions/module" || request.endsWith("actions/module")) return { isModuleEnabled: async () => true };
  if (request === "next/navigation") {
    const real = realLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, useRouter: () => ({ push() {}, refresh() {}, replace() {} }), usePathname: () => "/people", useSearchParams: () => new URLSearchParams() };
  }
  return realLoad.call(this, request, parent, isMain);
} as typeof realLoad;

const db = directClient();
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const TAG = "zzaddperson";
/** The options of the Role field alone: other fields hold values too. */
const roleOptions = (html: string) => [...(html.match(/id="as-role"[^]*?<\/select>/)?.[0] ?? "").matchAll(/<option value="([A-Z_]+)"/g)].map((m) => m[1]!);

async function main() {
  const { renderToStaticMarkup } = await import("react-dom/server");
  const NewPage = ((await import("../src/app/(dashboard)/settings/users/new/page")) as unknown as { default: () => Promise<ReactElement> }).default;
  const { viewerHas } = await import("../src/actions/permission");
  const { createUser } = await import("../src/actions/user");
  const { listRoles } = await import("../src/lib/authz/role-registry");
  const made: string[] = [];
  const make = async (name: string, grants: Record<string, boolean>) => {
    const u = await db.user.create({
      data: { name: `Zz ${name}`, email: `${TAG}.${name}@example.invalid`, role: "HR", passwordHash: "x".repeat(60), permissionGrants: { create: Object.entries(grants).map(([permission, allowed]) => ({ permission, allowed, reason: TAG })) } },
      select: { id: true, role: true, name: true, email: true },
    });
    made.push(u.id);
    return u;
  };
  try {
    const hrHead = await make("hrhead", { "users.manage": true, "permissions.view": false, "permissions.manage": false });
    const plain = await make("plain", { "users.manage": false, "permissions.view": false });
    const admin = await make("both", { "users.manage": true, "permissions.view": true });

    section("1. Create and edit users, without reviewing access");
    actor = hrHead;
    ok("People offers Add a person (the page asks viewerHas users.manage)", (await viewerHas("users.manage")) === true);
    const html = renderToStaticMarkup(await NewPage());
    ok("the form opens", html.includes("Create account") && !html.includes("You can&#x27;t add staff"), html.slice(0, 160));
    ok("  and goes back to People, not to a page they can't open", html.includes('href="/people"') && !html.includes('href="/settings/users"'));
    const options = roleOptions(html);
    const allRoles = (await listRoles()).map((r) => r.key);
    const offered = allRoles.filter((k) => options.includes(k));
    ok("  Employee and nothing else", offered.join() === "EMPLOYEE", offered);
    ok("  and it says so", html.includes("People you add start as an Employee"));
    const email = `${TAG}.new@example.invalid`;
    const created = await createUser({ name: "Zz New Starter", email, role: offered[0], departmentId: "", active: false });
    const row = await db.user.findUnique({ where: { email }, select: { id: true } });
    if (row) made.push(row.id);
    ok("  a role offered is one createUser takes", created.ok, created.ok ? offered[0] : created.error);
    // HR is their own role, whose rights they all hold: only the new rule refuses it.
    const no = await createUser({ name: "Zz Over", email: `${TAG}.over@example.invalid`, role: "HR", departmentId: "", active: false });
    const over = await db.user.findUnique({ where: { email: `${TAG}.over@example.invalid` }, select: { id: true } });
    if (over) made.push(over.id);
    ok("  their own role is refused too", !no.ok && no.error.includes("only start people as an Employee"), no.ok ? "made" : no.error);

    section("4. A role built by hand");
    const STARTING = ["copilot.use", "commissions.view", "section.hr", "section.payroll", "section.expenses", "section.engagement", "section.notifications", "section.tasks", "section.desks", "section.calendar", "section.notes", "section.chat", "section.cards"];
    const bare = await make("bare", { "users.manage": true, "permissions.view": false, ...Object.fromEntries(STARTING.map((k) => [k, false])) });
    actor = bare;
    const bareHtml = renderToStaticMarkup(await NewPage());
    const bareOptions = roleOptions(bareHtml);
    ok("Employee is offered", bareOptions.includes("EMPLOYEE"), bareOptions);
    ok("  and nothing else", bareOptions.join() === "EMPLOYEE", bareOptions);
    const hrToo = await createUser({ name: "Zz Hr", email: `${TAG}.hr@example.invalid`, role: "HR", departmentId: "", active: false });
    const hrRow = await db.user.findUnique({ where: { email: `${TAG}.hr@example.invalid` }, select: { id: true } });
    if (hrRow) made.push(hrRow.id);
    ok("  HR is refused", !hrToo.ok, hrToo.ok ? "made" : hrToo.error);
    const fresh = await createUser({ name: "Zz Joiner", email: `${TAG}.joiner@example.invalid`, role: "EMPLOYEE", departmentId: "", active: false });
    const joiner = await db.user.findUnique({ where: { email: `${TAG}.joiner@example.invalid` }, select: { id: true } });
    if (joiner) made.push(joiner.id);
    ok("  createUser takes it", fresh.ok, fresh.ok ? "" : fresh.error);

    // Something more on Employee, put back straight after: the row is the workspace's own.
    const EXTRA = "payments.manage";
    const before = await db.rolePermission.findUnique({ where: { role_permission: { role: "EMPLOYEE", permission: EXTRA } } });
    try {
      await db.rolePermission.upsert({ where: { role_permission: { role: "EMPLOYEE", permission: EXTRA } }, create: { role: "EMPLOYEE", permission: EXTRA, allowed: true }, update: { allowed: true } });
      const filled = await createUser({ name: "Zz Filled", email: `${TAG}.filled@example.invalid`, role: "EMPLOYEE", departmentId: "", active: false });
      const f = await db.user.findUnique({ where: { email: `${TAG}.filled@example.invalid` }, select: { id: true } });
      if (f) made.push(f.id);
      ok("a business right ticked on Employee is still refused", !filled.ok, filled.ok ? "made" : filled.error);
      const namedHtml = renderToStaticMarkup(await NewPage());
      ok("  and the form names the right that holds it back", roleOptions(namedHtml).length === 0 && namedHtml.includes("Why aren&#x27;t other roles listed?") && namedHtml.includes("Manage finance records"));
    } finally {
      if (before) await db.rolePermission.update({ where: { role_permission: { role: "EMPLOYEE", permission: EXTRA } }, data: { allowed: before.allowed } });
      else await db.rolePermission.delete({ where: { role_permission: { role: "EMPLOYEE", permission: EXTRA } } });
    }

    section("6. The hiring board");
    const { saveCandidate } = await import("../src/actions/candidate");
    const recruiter = await make("recruiter", { "hiring.manage": true });
    actor = recruiter;
    const hireSales = await saveCandidate({ name: "Zz Hire", email: `${TAG}.hire1@example.invalid`, role: "SALES" });
    ok("hiring into another role is refused", !hireSales.ok && hireSales.error.includes("only start people as an Employee"), hireSales);
    const hireOwn = await saveCandidate({ name: "Zz Hire", email: `${TAG}.hire2@example.invalid`, role: "HR" });
    ok("  so is their own", !hireOwn.ok, hireOwn);
    const hireEmployee = await saveCandidate({ name: "Zz Hire", email: `${TAG}.hire3@example.invalid`, role: "EMPLOYEE" });
    ok("  an Employee is saved", hireEmployee.ok, hireEmployee);
    const noRole = await saveCandidate({ name: "Zz Hire", email: `${TAG}.hire4@example.invalid` });
    ok("  and so is one with no role named", noRole.ok, noRole);
    const adminMade = await db.candidate.create({ data: { name: "Zz Hire", email: `${TAG}.hire5@example.invalid`, role: "SALES", ownerId: recruiter.id }, select: { id: true } });
    const keeps = await saveCandidate({ id: adminMade.id, name: "Zz Hire", email: `${TAG}.hire5@example.invalid`, role: "SALES" });
    ok("  a role already on the record can stay", keeps.ok, keeps);
    const changes = await saveCandidate({ id: adminMade.id, name: "Zz Hire", email: `${TAG}.hire5@example.invalid`, role: "MANAGEMENT" });
    ok("  but not change to another", !changes.ok, changes);
    const decider = await db.user.create({ data: { name: "Zz Decider", email: `${TAG}.decider@example.invalid`, role: "ADMIN", passwordHash: "x".repeat(60) }, select: { id: true, role: true, name: true, email: true } });
    made.push(decider.id);
    actor = decider;
    const adminHire = await saveCandidate({ name: "Zz Hire", email: `${TAG}.hire6@example.invalid`, role: "SALES" });
    ok("an Admin hires into another role", adminHire.ok, adminHire);

    section("2. Without it");
    actor = plain;
    ok("no Add a person", (await viewerHas("users.manage")) === false);
    ok("  the page says they can't", renderToStaticMarkup(await NewPage()).includes("can&#x27;t add staff"));

    section("3. With both");
    actor = admin;
    const both = renderToStaticMarkup(await NewPage());
    ok("the form, back to Users", both.includes("Create account") && both.includes('href="/settings/users"'));
    const everything = await make("everything", Object.fromEntries((await import("../src/lib/permissions")).PERMISSIONS.filter((p) => !p.superAdminOnly).map((p) => [p.key, true])));
    actor = everything;
    ok("holding every right but that one, still Employee only", roleOptions(renderToStaticMarkup(await NewPage())).join() === "EMPLOYEE");

    section("5. Those who decide roles");
    const realAdmin = await db.user.create({ data: { name: "Zz Admin", email: `${TAG}.admin@example.invalid`, role: "ADMIN", passwordHash: "x".repeat(60) }, select: { id: true, role: true, name: true, email: true } });
    made.push(realAdmin.id);
    actor = realAdmin;
    const adminHtml = renderToStaticMarkup(await NewPage());
    const adminOptions = roleOptions(adminHtml);
    ok("an Admin is offered other roles", adminOptions.includes("SALES") && adminOptions.includes("EMPLOYEE"), adminOptions);
    ok("  never Admin", !adminOptions.includes("ADMIN"));
    ok("  with no word about Employee only", !adminHtml.includes("People you add start as an Employee"));
    const sales = await createUser({ name: "Zz Sales", email: `${TAG}.sales@example.invalid`, role: "SALES", departmentId: "", active: false });
    const salesRow = await db.user.findUnique({ where: { email: `${TAG}.sales@example.invalid` }, select: { id: true } });
    if (salesRow) made.push(salesRow.id);
    ok("  and createUser takes one", sales.ok, sales.ok ? "" : sales.error);
    const trusted = await make("trusted", { "users.manage": true, "users.assignRole": true });
    actor = trusted;
    const trustedOptions = roleOptions(renderToStaticMarkup(await NewPage()));
    ok("granted Change somebody's role: the roles within their rights", trustedOptions.includes("EMPLOYEE") && trustedOptions.includes("HR") && !trustedOptions.includes("MANAGEMENT"), trustedOptions);
  } finally {
    actor = null;
    await db.candidate.deleteMany({ where: { email: { startsWith: TAG } } }).catch((e) => console.error("cleanup", String(e).slice(0, 200)));
    await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: made } }, { entityId: { in: made } }] } }).catch(() => undefined);
    await db.userPermission.deleteMany({ where: { userId: { in: made } } }).catch(() => undefined);
    await db.user.deleteMany({ where: { id: { in: made } } }).catch((e) => console.error("cleanup", String(e).slice(0, 200)));
  }
  console.log(failures === 0 ? `\nAll ${passes} add-a-person checks passed.\n` : `\n${failures} check(s) failed.\n`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
