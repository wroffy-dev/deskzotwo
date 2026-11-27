/**
 * HR setting somebody's work phone on their employee record (owner, 25 Nov 2026 — "work phone number option in user
 * profile which HR can add"; src/actions/hr.ts `saveEmployeeProfile`).
 *
 *   1. HR adds, changes and clears it — the account's own number, the one Edit profile and their Profile set.
 *   2. A save that doesn't send it leaves it; somebody without hr.manage can't set it here; HR can't set the super
 *      admin's; not while viewing as somebody. The audit names the field, never the number.
 *   3. The form offers it to HR and not on one's own record; the record shows it.
 *
 * The real action, with the session and module access substituted. Fixtures are named ZZWPHONE /
 * @zzworkphone-check.invalid and removed in a finally; the super admin is only read.
 *
 *   npm run check:work-phone
 */
import "dotenv/config";
import Module from "node:module";
import { createElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const TAG = "ZZWPHONE";
const MAIL = "@zzworkphone-check.invalid";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

type Person = { id: string; name: string; email: string; role: string };
let actor: Person | null = null;
let viewingAs = false;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "next/navigation") return { useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {}, prefetch() {} }), useSearchParams: () => new URLSearchParams(), usePathname: () => "/people" };
  if (request === "@/lib/session" || request.endsWith("/lib/session")) {
    class UnauthorizedError extends Error {}
    const me = async () => {
      if (!actor) throw new UnauthorizedError("signed out");
      return actor;
    };
    return { UnauthorizedError, requireUser: me, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => (viewingAs ? "Not while viewing as somebody else." : null) };
  }
  if (request === "@/lib/modules-access" || request.endsWith("/lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleUser: async () => actor, requireModuleAccess: async () => actor };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const HR = require("../src/actions/hr") as typeof import("../src/actions/hr");
  const { EmployeeForm } = require("../src/components/hr/employee-form") as typeof import("../src/components/hr/employee-form");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const cleanup = async () => {
    const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
    await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }] } });
    await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
    await db.employeeProfile.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  };
  await cleanup();
  try {
    const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true, phone: true, employeeProfile: { select: { updatedAt: true } } } });
    if (!superAdmin) throw new Error("no super admin");
    const mk = (local: string) =>
      db.user.create({ data: { name: `${TAG} ${local}`, email: `${local}${MAIL}`, role: "EMPLOYEE", passwordHash: "zz-fixture-placeholder" }, select: { id: true, name: true, email: true, role: true } });
    const hr = await mk("hr");
    const asha = await mk("asha");
    for (const permission of ["hr.manage", "hr.viewAll"]) await db.userPermission.create({ data: { userId: hr.id, permission, allowed: true, grantedById: superAdmin.id } });
    // HR holds no users.manage: that was the only way before.
    await db.userPermission.create({ data: { userId: hr.id, permission: "users.manage", allowed: false, grantedById: superAdmin.id } });
    const phoneOf = async (id: string) => (await db.user.findUniqueOrThrow({ where: { id }, select: { phone: true } })).phone;

    section("1. HR");
    actor = hr;
    const added = await HR.saveEmployeeProfile({ userId: asha.id, designation: "Zz Executive", workPhone: " +91 98765 43210 " });
    ok("HR adds it, with no right to manage users", added.ok && (await phoneOf(asha.id)) === "+91 98765 43210", added.ok ? await phoneOf(asha.id) : added.error);
    const audit = await db.auditLog.findFirst({ where: { entityId: asha.id }, orderBy: { createdAt: "desc" }, select: { userId: true, entityLabel: true } });
    ok("  audited by name, never the number", audit?.userId === hr.id && !!audit.entityLabel?.includes("work phone") && !audit.entityLabel.includes("98765"), audit);
    const read = await HR.getPerson(asha.id);
    ok("  and it's on their record", read?.phone === "+91 98765 43210", read?.phone);
    const kept = await HR.saveEmployeeProfile({ userId: asha.id, workLocation: "Noida" });
    ok("a save that doesn't send it leaves it", kept.ok && (await phoneOf(asha.id)) === "+91 98765 43210");
    const same = await HR.saveEmployeeProfile({ userId: asha.id, workPhone: "+91 98765 43210" });
    const sameAudit = await db.auditLog.findFirst({ where: { entityId: asha.id }, orderBy: { createdAt: "desc" }, select: { entityLabel: true } });
    ok("  sent unchanged: nothing said to have changed", same.ok && !sameAudit?.entityLabel?.includes("work phone"), sameAudit);
    const cleared = await HR.saveEmployeeProfile({ userId: asha.id, workPhone: "" });
    ok("HR clears it", cleared.ok && (await phoneOf(asha.id)) === null);
    const long = await HR.saveEmployeeProfile({ userId: asha.id, workPhone: "9".repeat(33) });
    ok("too long is refused", !long.ok && /too long/.test(long.error) && (await phoneOf(asha.id)) === null);
    const own = await HR.saveEmployeeProfile({ userId: hr.id, workPhone: "98111 11111" });
    ok("HR sets their own", own.ok && (await phoneOf(hr.id)) === "98111 11111");

    section("2. Nobody else");
    actor = asha;
    const self = await HR.saveEmployeeProfile({ userId: asha.id, city: "Noida", workPhone: "90000 00000" });
    ok("on one's own record without HR's rights: dropped — it's set on their Profile", self.ok && (await phoneOf(asha.id)) === null, self.ok ? await phoneOf(asha.id) : self.error);
    const other = await HR.saveEmployeeProfile({ userId: hr.id, workPhone: "90000 00000" });
    ok("on somebody else's: refused", !other.ok && (await phoneOf(hr.id)) === "98111 11111");
    actor = hr;
    const boss = await HR.saveEmployeeProfile({ userId: superAdmin.id, workPhone: "90000 00000" });
    const bossNow = await db.user.findUniqueOrThrow({ where: { id: superAdmin.id }, select: { phone: true, employeeProfile: { select: { updatedAt: true } } } });
    ok("the super admin's, by HR: refused, nothing written", !boss.ok && /super admin/.test(boss.error) && bossNow.phone === superAdmin.phone && bossNow.employeeProfile?.updatedAt.getTime() === superAdmin.employeeProfile?.updatedAt.getTime(), boss.ok ? "saved" : boss.error);
    viewingAs = true;
    const viewing = await HR.saveEmployeeProfile({ userId: asha.id, workPhone: "90000 00000" });
    viewingAs = false;
    ok("while viewing as somebody: refused", !viewing.ok && (await phoneOf(asha.id)) === null);

    section("3. The form");
    await HR.saveEmployeeProfile({ userId: asha.id, workPhone: "98765 43210" });
    const person = (await HR.getPerson(asha.id))!;
    const form = (canManage: boolean) => renderToStaticMarkup(createElement(EmployeeForm, { person, canManage, onDone: () => {} }) as ReactElement);
    ok("HR is offered it", form(true).includes("Work phone") && form(true).includes("Personal phone"));
    ok("  not on one's own record", !form(false).includes("Work phone"));
  } finally {
    actor = null;
    await cleanup();
    ok("the fixtures are gone", (await db.user.count({ where: { email: { endsWith: MAIL } } })) === 0);
  }
  console.log(failures === 0 ? `\nAll ${passes} work phone checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
