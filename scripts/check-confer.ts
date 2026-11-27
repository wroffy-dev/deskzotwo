/**
 * check:confer — nobody confers more than they hold, on the users side (owner, 2 Nov 2026 — "Phase 1 security
 * fixes"; DESKZO_PERMISSION_SYSTEM_AUDIT.md H-1, H-2, M-5, M-9):
 *
 *   · H-1 moving somebody into a role holds them to `assertMayStartInRole`, as creating an account does — the
 *     single edit, the bulk bar and the users import's existing rows; a role the mover does hold still moves;
 *   · H-2 platform support's read-only role is given to nobody — not by creating, moving or importing — while
 *     the platform's own provisioning (a SUPPORT account written straight into that role) still works;
 *   · M-5 a manager change never brings somebody into the changer's own reporting line, never puts somebody
 *     under a person reaching wider by team than the changer does, needs `permissions.manage` in the import
 *     too, and never catches an admin reaching everything or the super admin;
 *   · M-9 role, department and manager changes, switching on and off and a 2FA reset each write one access-
 *     history row (nothing when nothing changed); a 2FA reset of yourself or while viewing as somebody is
 *     refused; changing your own password and switching off your own 2FA are audited;
 *   · converting a hired candidate makes an account, so it is held to the same three rules: the candidate's
 *     role (assignable, nothing above the converter) and manager (within the converter's reach).
 *
 * The real actions and the real importer with the session, `next/cache` and the platform account hooks
 * substituted; no mail leaves (the platform mailer is replaced). Fixtures are ZZCONFER / @zzconfer-check.invalid
 * and removed in a finally; the super admin is borrowed as an actor and never changed.
 *
 *   npm run check:confer
 */
import "dotenv/config";
import Module from "node:module";
import type { PermissionChangeKind } from "@prisma/client";

const TAG = "ZZCONFER";
const MAIL = "@zzconfer-check.invalid";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

// ─── Stand-ins ───────────────────────────────────────────────────────────────────────────────────
let actorId = "";
let viewingAs = false;
// "View as" (Phase 2, L-7): its cookie, kept here while `viewAsOn` is set — see the stand-ins below.
let viewAsOn = false;
const jar = new Map<string, string>();
const cookieJar = {
  get: (name: string) => (jar.has(name) ? { name, value: jar.get(name)! } : undefined),
  getAll: () => [...jar].map(([name, value]) => ({ name, value })),
  has: (name: string) => jar.has(name),
  set: (first: string | { name: string; value: string }, value?: string) => void (typeof first === "string" ? jar.set(first, value ?? "") : jar.set(first.name, first.value)),
  delete: (arg: string | { name: string }) => void jar.delete(typeof arg === "string" ? arg : arg.name),
};
const stubHits = { session: 0, hooks: 0 };
const internals = Module as unknown as { _load(request: string, parent: unknown, isMain: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    stubHits.session += 1;
    class UnauthorizedError extends Error {}
    const user = () => (actorId ? { id: actorId, name: "Zz Probe", email: `probe${MAIL}`, role: "ADMIN" } : null);
    return {
      UnauthorizedError,
      requireUser: async () => {
        const u = user();
        if (!u) throw new UnauthorizedError("signed out");
        return u;
      },
      currentUser: async () => user(),
      viewAsContext: async () => null,
      refuseWhileViewingAs: async () => (viewingAs ? "You're viewing as somebody else. Go back to your own account to do this." : null),
    };
  }
  if (request === "@/lib/platform/account-hooks" || request.endsWith("lib/platform/account-hooks")) {
    stubHits.hooks += 1;
    return { accountsChanged: async () => {} };
  }
  // "View as" (Phase 2, L-7) reads the raw session and a cookie, which exist only in a request: while `viewAsOn` is set,
  // the cookie store is the jar below, otherwise the real one. `auth()` always answers with the actor (with no sign-in
  // id): outside a request the real one only throws, and changing your own password asks it since main's 3 Nov change
  // (src/actions/profile.ts `twoFactorIdentity`).
  if (request === "next/headers" || request === "@/lib/auth" || request.endsWith("lib/auth")) {
    const real = originalLoad.call(this, request, parent, isMain) as object;
    const stand = request === "next/headers" ? "cookies" : "auth";
    return new Proxy(real, {
      get: (target, prop) => {
        if (prop !== stand || (stand === "cookies" && !viewAsOn)) return Reflect.get(target, prop);
        return stand === "auth" ? async () => (actorId ? { user: { id: actorId } } : null) : async () => cookieJar;
      },
    });
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const bcrypt = require("bcryptjs") as typeof import("bcryptjs");
  const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const { roleIsHidden } = require("../src/lib/authz/role-registry") as typeof import("../src/lib/authz/role-registry");
  const { SUPPORT_READONLY_ROLE } = require("../src/lib/roles") as typeof import("../src/lib/roles");
  const { usersImporter } = require("../src/lib/portability/importers/users") as typeof import("../src/lib/portability/importers/users");
  const USER = require("../src/actions/user") as typeof import("../src/actions/user");
  const PROFILE = require("../src/actions/profile") as typeof import("../src/actions/profile");
  const CANDIDATE = require("../src/actions/candidate") as typeof import("../src/actions/candidate");
  const TICKET = require("../src/actions/ticket") as typeof import("../src/actions/ticket");
  const VIEW_AS = require("../src/actions/impersonation") as typeof import("../src/actions/impersonation");
  const { resolveViewAs } = require("../src/lib/impersonation") as typeof import("../src/lib/impersonation");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const mail: { to: string }[] = [];
  mailer.setTestPlatformMailer(async (m) => void mail.push(m));

  await cleanup(db);
  try {
    section("Set-up");
    ok("the session stand-in is the one the actions load", stubHits.session > 0);
    ok("the platform account hooks are stood in for", stubHits.hooks > 0);
    const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true, role: true, active: true, managerId: true } });
    ok("there is a super admin to borrow as an actor (never changed)", superAdmin !== null);
    if (!superAdmin) return;

    // A custom role holding nothing but the sections, for actors who hold only what they're granted below.
    const HR_ROLE = `${TAG}_HR`;
    await db.role.create({ data: { key: HR_ROLE, name: `${TAG} Hr`, isSystem: false } });
    const placeholder = "zz-fixture-placeholder";
    const mk = (name: string, role: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name: `${TAG} ${name}`, email: `${name.toLowerCase()}${MAIL}`, role, passwordHash: placeholder, ...extra }, select: { id: true, name: true, email: true } });
    const grant = (userId: string, keys: string[]) => db.userPermission.createMany({ data: keys.map((permission) => ({ userId, permission, allowed: true, reason: TAG })) });

    // An ordinary admin (not the super admin), holding the two keys a role change and a reporting line need as grants,
    // so the check doesn't hang on how this workspace's ADMIN role happens to be configured.
    const admin = await mk("Admin", "ADMIN");
    await grant(admin.id, ["users.manage", "users.assignRole", "permissions.manage", "permissions.view"]);
    // An admin like that, but with one key the Admin role holds taken away from them personally.
    const denied = await mk("Denied", "ADMIN");
    await grant(denied.id, ["users.manage", "users.assignRole", "permissions.manage", "permissions.view"]);
    await db.userPermission.create({ data: { userId: denied.id, permission: "payments.record", allowed: false, reason: TAG } });
    // Somebody trusted with people and access, but holding almost nothing else.
    const hr = await mk("Hr", HR_ROLE);
    await grant(hr.id, ["users.manage", "users.assignRole", "permissions.manage"]);
    // Somebody trusted with people only.
    const clerk = await mk("Clerk", HR_ROLE);
    await grant(clerk.id, ["users.manage"]);

    const low = await mk("Low", "SALES");
    const low2 = await mk("Lowtwo", "SALES");
    const rep = await mk("Rep", "SALES");
    const rep2 = await mk("Reptwo", "SALES");
    const audited = await mk("Audited", "SALES");
    // A manager reaching leads by team — wider than `hr` reaches them (not at all).
    const lead = await mk("Lead", "SALES");
    await db.userAccessLevel.create({ data: { userId: lead.id, record: "leads", action: "view", level: "TEAM", reason: TAG } });
    // A manager reaching nothing by team that `hr` doesn't: the same role, nothing personal.
    const flat = await mk("Flat", HR_ROLE);
    // Somebody already in `hr`'s line, and somebody in it one step down.
    const sub = await mk("Sub", HR_ROLE, { managerId: hr.id });
    const inTeam = await mk("Inteam", HR_ROLE, { managerId: sub.id });
    const dept = await db.department.create({ data: { name: `${TAG} Field` }, select: { id: true, name: true } });

    const who = (id: string) => db.user.findUniqueOrThrow({ where: { id }, select: { role: true, active: true, managerId: true, departmentId: true } });
    const assign = (id: string, change: { role?: string; departmentId?: string | null; managerId?: string | null }) =>
      who(id).then((t) => USER.updateUserAssignment({ id, role: change.role ?? t.role, departmentId: change.departmentId !== undefined ? change.departmentId : t.departmentId, managerId: change.managerId !== undefined ? change.managerId : t.managerId }));
    const history = (subjectUserId: string, changeKind: PermissionChangeKind) => db.permissionChange.count({ where: { subjectUserId, changeKind } });
    const ctx = (actor: string) => ({ actorUserId: actor, area: "users", pendingKeys: new Set<string>() });

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("H-1 · moving somebody into a role holds the mover to what the role holds");

    actorId = hr.id;
    const intoManagement = await assign(low.id, { role: "MANAGEMENT" });
    ok("somebody holding users.assignRole but little else can't move a person into MANAGEMENT", !intoManagement.ok && /you don't hold yourself, so you can't move/.test(intoManagement.error), intoManagement);
    ok("  and the role didn't move", (await who(low.id)).role === "SALES");
    const intoOwnShape = await assign(low.id, { role: HR_ROLE });
    ok("  a role holding nothing they don't still moves", intoOwnShape.ok && (await who(low.id)).role === HR_ROLE, intoOwnShape);

    // The audit's way round: an admin denied a key moves an account they control into the role holding it.
    actorId = denied.id;
    const intoAdmin = await assign(low2.id, { role: "ADMIN" });
    ok("an admin denied a key can't move somebody into Admin, which holds it", !intoAdmin.ok && /"[^"]+", which you don't hold yourself, so you can't move/.test(intoAdmin.error), intoAdmin);
    ok("  and the role didn't move", (await who(low2.id)).role === "SALES");
    const bulkAdmin = await USER.bulkUpdateUsers({ ids: [low2.id], op: "role", value: "ADMIN" });
    ok("  nor through the bulk bar", bulkAdmin.ok && bulkAdmin.data.done.length === 0 && /you don't hold yourself/.test(bulkAdmin.data.refused[0]?.reason ?? ""), bulkAdmin);
    ok("  and still nothing moved", (await who(low2.id)).role === "SALES");
    actorId = admin.id;
    const intoManagementByAdmin = await assign(low2.id, { role: "MANAGEMENT" });
    ok("  while a role the admin holds everything of still moves", intoManagementByAdmin.ok && (await who(low2.id)).role === "MANAGEMENT", intoManagementByAdmin);
    await db.user.update({ where: { id: low2.id }, data: { role: "SALES" } });

    actorId = superAdmin.id;
    const bySuper = await assign(low2.id, { role: "ADMIN" });
    ok("the super admin is never caught", bySuper.ok && (await who(low2.id)).role === "ADMIN", bySuper);
    await db.user.update({ where: { id: low2.id }, data: { role: "SALES" } });

    const importMove = await usersImporter.plan({ Email: low2.email, Role: "MANAGEMENT" }, 2, ctx(hr.id));
    ok("the users import refuses the same move for an existing account", importMove.action === "error" && /you don't hold yourself, so you can't move/.test(importMove.error ?? ""), importMove);
    const importMoveAdmin = await usersImporter.plan({ Email: low2.email, Role: "MANAGEMENT" }, 2, ctx(admin.id));
    ok("  and allows it to somebody holding what the role holds", importMoveAdmin.action === "update", importMoveAdmin);
    const importSame = await usersImporter.plan({ Email: low2.email, Role: "SALES" }, 2, ctx(hr.id));
    ok("  a row restating the role is still a skip, not a refusal", importSame.action === "skip", importSame);

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("H-2 · platform support's read-only role is given to nobody");

    ok("the support role is hidden, an ordinary one isn't", (await roleIsHidden(SUPPORT_READONLY_ROLE)) && !(await roleIsHidden("SALES")) && !(await roleIsHidden(HR_ROLE)));
    actorId = admin.id;
    const created = await USER.createUser({ name: `${TAG} Ghost`, email: `ghost${MAIL}`, role: SUPPORT_READONLY_ROLE });
    ok("creating an account in it is refused", !created.ok && /kept for the platform/.test(created.error), created);
    ok("  and no account was made", (await db.user.count({ where: { email: `ghost${MAIL}`, kind: { in: ["MEMBER", "SUPPORT"] } } })) === 0);
    actorId = superAdmin.id;
    const createdBySuper = await USER.createUser({ name: `${TAG} Ghost`, email: `ghost${MAIL}`, role: SUPPORT_READONLY_ROLE });
    ok("  even by the super admin — it isn't a question of authority", !createdBySuper.ok && /kept for the platform/.test(createdBySuper.error), createdBySuper);
    actorId = admin.id;
    const moved = await assign(rep.id, { role: SUPPORT_READONLY_ROLE });
    ok("moving somebody into it is refused", !moved.ok && /kept for the platform/.test(moved.error), moved);
    ok("  and the role didn't move", (await who(rep.id)).role === "SALES");
    const imported = await usersImporter.plan({ Email: rep.email, Role: SUPPORT_READONLY_ROLE }, 2, ctx(admin.id));
    ok("  and so is an import row naming it", imported.action === "error", imported);
    // What src/lib/platform/support.ts `enterAsSupport` writes: the account in the role, straight to the database.
    const support = await db.user.create({ data: { email: `support.zz${MAIL}`, name: `${TAG} Support`, role: SUPPORT_READONLY_ROLE, kind: "SUPPORT", active: true, passwordHash: placeholder }, select: { id: true } });
    ok("the platform's own provisioning still makes a support account in it", !!support.id);
    ok("  which reads and changes nothing", (await can(support.id, "leads.view")) && !(await can(support.id, "leads.create")));

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("M-5 · a reporting line changes only within the changer's own reach");

    actorId = hr.id;
    const intoOwnLine = await assign(rep.id, { managerId: hr.id });
    ok("nobody brings somebody under themselves", !intoOwnLine.ok && /your own reporting line/.test(intoOwnLine.error), intoOwnLine);
    const underReport = await assign(rep.id, { managerId: sub.id });
    ok("  nor under somebody who reports to them", !underReport.ok && /your own reporting line/.test(underReport.error), underReport);
    ok("  and Rep still reports to nobody", (await who(rep.id)).managerId === null);
    const withinTeam = await assign(inTeam.id, { managerId: hr.id });
    ok("  moving somebody about inside their own team is fine", withinTeam.ok && (await who(inTeam.id)).managerId === hr.id, withinTeam);
    const wider = await assign(rep.id, { managerId: lead.id });
    ok("nobody puts a person under somebody reaching wider by team than they do", !wider.ok && /by team, wider than you reach/.test(wider.error), wider);
    ok("  and Rep still reports to nobody", (await who(rep.id)).managerId === null);
    const level = await assign(rep.id, { managerId: flat.id });
    ok("  under somebody reaching no wider is fine", level.ok && (await who(rep.id)).managerId === flat.id, level);
    const away = await assign(rep.id, { managerId: null });
    ok("  and taking a manager away gives nobody anything", away.ok && (await who(rep.id)).managerId === null, away);

    actorId = admin.id;
    const adminOwn = await assign(rep.id, { managerId: admin.id });
    ok("an admin can't bring somebody under themselves either", !adminOwn.ok && /your own reporting line/.test(adminOwn.error), adminOwn);
    const adminWide = await assign(rep.id, { managerId: lead.id });
    ok("  but reaching every lead, may put somebody under the team-lead manager", adminWide.ok && (await who(rep.id)).managerId === lead.id, adminWide);
    await db.user.update({ where: { id: rep.id }, data: { managerId: null } });

    actorId = superAdmin.id;
    const superOwn = await assign(rep2.id, { managerId: superAdmin.id });
    ok("the super admin is never caught", superOwn.ok && (await who(rep2.id)).managerId === superAdmin.id, superOwn);
    await db.user.update({ where: { id: rep2.id }, data: { managerId: null } });

    const importOwn = await usersImporter.plan({ Email: rep.email, Manager: hr.email }, 2, ctx(hr.id));
    ok("the users import refuses bringing somebody into your own line", importOwn.action === "error" && /your own reporting line/.test(importOwn.error ?? ""), importOwn);
    const importWide = await usersImporter.plan({ Email: rep.email, Manager: lead.email }, 2, ctx(hr.id));
    ok("  and under somebody reaching wider by team", importWide.action === "error" && /by team, wider than you reach/.test(importWide.error ?? ""), importWide);
    const importNew = await usersImporter.plan({ Name: `${TAG} Newbie`, Email: `newbie${MAIL}`, Role: HR_ROLE, Manager: hr.email }, 2, ctx(hr.id));
    ok("  a new account's row too", importNew.action === "error" && /your own reporting line/.test(importNew.error ?? ""), importNew);
    const importClerk = await usersImporter.plan({ Email: rep.email, Manager: flat.email }, 2, ctx(clerk.id));
    ok("  and a manager needs permission to manage access, as on the screen", importClerk.action === "error" && /permission to manage access/.test(importClerk.error ?? ""), importClerk);
    const importFine = await usersImporter.plan({ Email: rep.email, Manager: flat.email }, 2, ctx(hr.id));
    ok("  while a move within reach is planned as an update", importFine.action === "update", importFine);

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("M-9 · the access history");

    actorId = admin.id;
    const all = await assign(audited.id, { role: "MANAGEMENT", departmentId: dept.id, managerId: lead.id });
    ok("one change of role, department and manager is made", all.ok, all);
    const rows = await db.permissionChange.findMany({ where: { subjectUserId: audited.id }, select: { changeKind: true, actorUserId: true, detail: true } });
    ok("  one row each: role, department, manager", ["DEPARTMENT_CHANGED", "MANAGER_CHANGED", "ROLE_ASSIGNED"].join() === rows.map((r) => r.changeKind).sort().join(), rows);
    ok("  each the admin's, saying what moved", rows.every((r) => r.actorUserId === admin.id) && rows.some((r) => r.detail?.includes("SALES → MANAGEMENT")) && rows.some((r) => r.detail?.includes(dept.name)) && rows.some((r) => r.detail?.includes(lead.name)), rows);
    const same = await assign(audited.id, {});
    ok("  the same values again write nothing", same.ok && (await db.permissionChange.count({ where: { subjectUserId: audited.id } })) === 3, same);
    const bulkDept = await USER.bulkUpdateUsers({ ids: [audited.id], op: "department", value: null });
    ok("  the bulk bar's change is in it too", bulkDept.ok && (await history(audited.id, "DEPARTMENT_CHANGED")) === 2, bulkDept);

    const off = await USER.setUserActive(audited.id, false);
    ok("switching somebody off writes one row", off.ok && (await history(audited.id, "USER_DEACTIVATED")) === 1, off);
    const on = await USER.setUserActive(audited.id, true);
    ok("  switching them on another", on.ok && (await history(audited.id, "USER_ACTIVATED")) === 1, on);
    const onAgain = await USER.setUserActive(audited.id, true);
    ok("  and switching on somebody on already, none", onAgain.ok && (await history(audited.id, "USER_ACTIVATED")) === 1, onAgain);

    await db.user.update({ where: { id: audited.id }, data: { twoFactorEnabledAt: new Date() } });
    const reset = await USER.resetUserTwoFactor(audited.id);
    ok("a 2FA reset writes one row", reset.ok && (await history(audited.id, "TWO_FACTOR_RESET")) === 1 && (await db.user.findUniqueOrThrow({ where: { id: audited.id }, select: { twoFactorEnabledAt: true } })).twoFactorEnabledAt === null, reset);
    const resetSelf = await USER.resetUserTwoFactor(admin.id);
    ok("  your own is refused (Profile is for that)", !resetSelf.ok && /That's you/.test(resetSelf.error) && (await history(admin.id, "TWO_FACTOR_RESET")) === 0, resetSelf);
    viewingAs = true;
    const resetViewing = await USER.resetUserTwoFactor(audited.id);
    viewingAs = false;
    ok("  and so is one while viewing as somebody", !resetViewing.ok && /viewing as/i.test(resetViewing.error) && (await history(audited.id, "TWO_FACTOR_RESET")) === 1, resetViewing);

    const oldPassword = "Zz-old-password-1";
    const newPassword = "Zz-new-password-2";
    await db.user.update({ where: { id: audited.id }, data: { passwordHash: await bcrypt.hash(oldPassword, 4), twoFactorEnabledAt: new Date() } });
    actorId = audited.id;
    const changed = await PROFILE.changeOwnPassword({ currentPassword: oldPassword, newPassword, confirmPassword: newPassword });
    ok("changing your own password is audited", changed.ok && (await db.auditLog.count({ where: { userId: audited.id, entityId: audited.id, entityLabel: "Changed their own password" } })) === 1, changed);
    ok("  and in the activity log with the other password changes", (await db.activityLog.count({ where: { userId: audited.id, kind: "PASSWORD_CHANGED" } })) === 1);
    const wrong = await PROFILE.changeOwnPassword({ currentPassword: "nope-nope-nope", newPassword: oldPassword, confirmPassword: oldPassword });
    ok("  a refused change isn't", !wrong.ok && (await db.auditLog.count({ where: { userId: audited.id, entityLabel: "Changed their own password" } })) === 1, wrong);
    const disabled = await PROFILE.disableOwnTwoFactor({ currentPassword: newPassword });
    ok("switching off your own 2FA is audited", disabled.ok && (await db.auditLog.count({ where: { userId: audited.id, entityId: audited.id, entityLabel: "Switched off their own two-factor authentication" } })) === 1, disabled);

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("H-1 · H-2 · M-5 · converting a hired candidate is creating an account");
    // Somebody who runs HR and nothing else: converting takes hr.manage, and the account it makes takes the
    // candidate's role and manager, chosen while hiring.
    const recruiter = await mk("Recruiter", HR_ROLE);
    await grant(recruiter.id, ["hr.manage"]);
    const hire = (name: string, role: string, managerId: string | null, email = `${name.toLowerCase()}${MAIL}`) =>
      db.candidate.create({ data: { name: `${TAG} ${name}`, email, role, status: "ACCEPTED", managerId }, select: { id: true, email: true } });
    const convert = (id: string) => CANDIDATE.convertCandidate(id, { joinedOn: "2026-11-02" });
    const noAccount = async (email: string) => (await db.user.count({ where: { email } })) === 0;

    actorId = recruiter.id;
    const high = await hire("Hiredhigh", "MANAGEMENT", null);
    const intoHigh = await convert(high.id);
    ok("a role holding what the converter doesn't: refused, and no account", !intoHigh.ok && /which you don't hold yourself|only start people as an Employee/.test(intoHigh.error) && (await noAccount(high.email)), intoHigh);
    const hiredSupport = await hire("Hiredsupport", SUPPORT_READONLY_ROLE, null);
    const intoSupport = await convert(hiredSupport.id);
    ok("platform support's read-only role: refused, and no account", !intoSupport.ok && /platform's own support staff/.test(intoSupport.error) && (await noAccount(hiredSupport.email)), intoSupport);
    // Employee, the one role somebody who doesn't decide roles may start people in (main, 4 Nov 2026): the manager rule is what is tested.
    const underLead = await hire("Hiredunderlead", "EMPLOYEE", lead.id);
    const underLeadDone = await convert(underLead.id);
    ok("a manager reaching wider by team than the converter: refused, and no account", !underLeadDone.ok && /wider than you reach/.test(underLeadDone.error) && (await noAccount(underLead.email)), underLeadDone);
    const underSelf = await hire("Hiredunderself", "EMPLOYEE", recruiter.id);
    const underSelfDone = await convert(underSelf.id);
    ok("  reporting to the converter themselves: refused, and no account", !underSelfDone.ok && /your own reporting line/.test(underSelfDone.error) && (await noAccount(underSelf.email)), underSelfDone);
    // Past the guards, the next refusal is the email already in use — so nothing is made, and the guards are shown to let it by.
    const fine = await hire("Hiredfine", "EMPLOYEE", flat.id, low.email);
    const fineDone = await convert(fine.id);
    ok("  a role and manager within their reach get past the guards (stopped next on the email in use)", !fineDone.ok && /already has an account with that email/.test(fineDone.error), fineDone);
    actorId = superAdmin.id;
    const hiredBySuper = await hire("Hiredbysuper", "MANAGEMENT", lead.id, low2.email);
    const bySuperDone = await convert(hiredBySuper.id);
    ok("the super admin is never caught by them", !bySuperDone.ok && /already has an account with that email/.test(bySuperDone.error), bySuperDone);
    actorId = "";

    // ─── Phase 2 permission fixes (owner, 3 Nov 2026) ──────────────────────────────────────────────
    section("Phase 2 · L-1 · the users list is for whoever may review access");
    actorId = flat.id;
    const listedToNobody = await USER.listUsers();
    ok("somebody who may not review access is given nobody — no roles, managers or 2FA", listedToNobody.length === 0, listedToNobody.length);
    actorId = admin.id;
    const listedToAdmin = await USER.listUsers();
    ok("  whoever may (\"Review who can do what\") sees everybody, as before", listedToAdmin.some((u) => u.id === flat.id) && listedToAdmin.some((u) => u.id === admin.id), listedToAdmin.length);

    section("Phase 2 · L-3 · deleting a ticket is the super admin's alone; \"Delete tickets\" decides nothing and nobody is given it");
    // Somebody who sees tickets and owns one account — and an ordinary admin, who reaches every ticket.
    const deleter = await mk("Deleter", HR_ROLE);
    await grant(deleter.id, ["tickets.view"]);
    const plainAdmin = await mk("Plainadmin", "ADMIN");
    const account = await db.company.create({ data: { name: `${TAG} Ticket Co`, normalizedName: `${TAG} ticket co`.toLowerCase(), relationshipType: "CLIENT", createdById: superAdmin.id, ownerUserId: deleter.id }, select: { id: true } });
    const ticket = (companyId: string, title: string) => db.ticket.create({ data: { companyId, title: `${TAG} ${title}`, createdByUserId: superAdmin.id }, select: { id: true } });
    const stays = async (id: string) => (await db.ticket.count({ where: { id } })) === 1;
    const first = await ticket(account.id, "Printer jam");
    actorId = plainAdmin.id;
    const byPlainAdmin = await TICKET.deleteTicket(first.id);
    ok("an admin is refused, and the ticket stays", !byPlainAdmin.ok && (await stays(first.id)), byPlainAdmin);
    // Even given the key, as a stored row from the old defaults or presets would give it: it decides nothing.
    await db.userPermission.create({ data: { userId: deleter.id, permission: "tickets.delete", allowed: true, grantedById: superAdmin.id, reason: TAG } });
    actorId = deleter.id;
    const byHolder = await TICKET.deleteTicket(first.id);
    ok("  so is somebody holding \"Delete tickets\" who reaches it — the key changes nothing", !byHolder.ok && (await stays(first.id)), byHolder);
    actorId = superAdmin.id;
    const superDeletes = await TICKET.deleteTicket(first.id);
    ok("the super admin deletes it", superDeletes.ok && !(await stays(first.id)), superDeletes);
    actorId = "";

    section("Phase 2 · L-7 · viewing as somebody is the permission's, not the role's");
    viewAsOn = true;
    jar.clear();
    // Not an admin, and given "View the app as another user" as only the super admin can give it.
    const viewer = await mk("Viewer", HR_ROLE);
    await db.userPermission.create({ data: { userId: viewer.id, permission: "impersonation.use", allowed: true, grantedById: superAdmin.id, reason: TAG } });
    const colleague = await mk("Colleague", HR_ROLE);
    const payroller = await mk("Payroller", HR_ROLE);
    await grant(payroller.id, ["payroll.manage"]);
    // An ordinary admin it was never given to (nobody holds it by default since Phase 1 — said here outright).
    await db.userPermission.create({ data: { userId: plainAdmin.id, permission: "impersonation.use", allowed: false, reason: TAG } });
    actorId = plainAdmin.id;
    const adminTries = await VIEW_AS.startViewingAs(colleague.id);
    ok("an admin without \"View the app as another user\" can't view as anybody", !adminTries.ok && (await resolveViewAs(plainAdmin.id)) === null, adminTries);
    actorId = viewer.id;
    const viewerTries = await VIEW_AS.startViewingAs(colleague.id);
    const viewing = await resolveViewAs(viewer.id);
    ok("somebody who isn't an admin, given it by the super admin, views as a colleague holding nothing beyond them", viewerTries.ok && viewing?.user.id === colleague.id && viewing?.actor.id === viewer.id, viewerTries);
    await VIEW_AS.stopViewingAs();
    const beyond = await VIEW_AS.startViewingAs(payroller.id);
    ok("  but not as somebody holding what they don't", !beyond.ok && /holds permissions you don't/.test(beyond.ok ? "" : beyond.error), beyond);
    await VIEW_AS.startViewingAs(colleague.id);
    await db.userPermission.deleteMany({ where: { userId: viewer.id, permission: "impersonation.use" } });
    ok("  and once it's taken away, the session ends on the very next request", (await resolveViewAs(viewer.id)) === null);
    jar.clear();
    viewAsOn = false;
    actorId = "";

    actorId = "";
    ok("no setup email left for a refused account", !mail.some((m) => m.to === `ghost${MAIL}`));
    ok("the super admin is exactly as found", JSON.stringify(await db.user.findUniqueOrThrow({ where: { id: superAdmin.id }, select: { id: true, role: true, active: true, managerId: true } })) === JSON.stringify(superAdmin));
  } finally {
    actorId = "";
    viewingAs = false;
    await cleanup(db);
    await db.$disconnect?.();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}

async function cleanup(db: typeof import("../src/lib/db").db) {
  // Naming `kind` keeps the support fixture in the listing (src/lib/db.ts leaves SUPPORT accounts out otherwise).
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL }, kind: { in: ["MEMBER", "SUPPORT"] } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await db.user.updateMany({ where: { id: { in: ids } }, data: { managerId: null } });
  await db.candidate.deleteMany({ where: { name: { startsWith: TAG } } });
  // Onboarding tasks a conversion makes — none while the guards hold, but a run against code without them mustn't strand its fixtures.
  await db.task.deleteMany({ where: { OR: [{ createdByUserId: { in: ids } }, { assignedToUserId: { in: ids } }, { aboutUserId: { in: ids } }] } });
  await db.permissionChange.deleteMany({ where: { OR: [{ actorUserId: { in: ids } }, { subjectUserId: { in: ids } }] } });
  await db.activityLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }] } });
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }] } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.userAccessLevel.deleteMany({ where: { userId: { in: ids } } });
  // Phase 2's tickets, and their accounts (the tickets go with them; a run against code without the fix leaves some),
  // and the super admin's audit entry for deleting one.
  await db.auditLog.deleteMany({ where: { entityType: "Ticket", entityLabel: { contains: TAG } } });
  await db.ticket.deleteMany({ where: { title: { startsWith: TAG } } });
  await db.company.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
  await db.signIn.deleteMany({ where: { userId: { in: ids } } });
  await db.employeeProfile.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.department.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.rolePermission.deleteMany({ where: { role: { startsWith: TAG } } });
  await db.role.deleteMany({ where: { key: { startsWith: TAG } } });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
