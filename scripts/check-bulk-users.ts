/**
 * check:bulk-users — Settings › Users bulk bar (owner, 31 Oct 2026): tick people, then change their role,
 * mark them active or inactive, set their department or manager, or resend their setup email.
 *
 *   · admins only — a non-admin is refused outright, and so is anybody viewing as somebody;
 *   · every person goes through the single action's own rules: your own role and status, the super admin
 *     (asserted refused, never changed), seats (the plan's limit stood in), a reporting loop;
 *   · what's allowed is applied, the rest answered per person, one audit entry per person changed.
 *
 * The real action with the session, `next/cache`, the platform account hooks and the tenant's seat limit
 * substituted; no mail leaves (the platform mailer is replaced). Fixtures are ZZBULK / @zzbulk-check.invalid,
 * removed in a finally; assertions are about them, never about how many people the database holds.
 *
 *   npm run check:bulk-users
 */
import "dotenv/config";
import Module from "node:module";

const TAG = "ZZBULK";
const MAIL = "@zzbulk-check.invalid";

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
/** The plan's seats while set; undefined is the workspace's own answer. */
let seatsOverride: number | null | undefined;
const stubHits = { session: 0, hooks: 0, tenant: 0 };
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
  if (request === "next/navigation") {
    return { useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {}, prefetch() {} }), useSearchParams: () => new URLSearchParams(), usePathname: () => "/settings/users" };
  }
  if (request === "@/lib/platform/account-hooks" || request.endsWith("lib/platform/account-hooks")) {
    stubHits.hooks += 1;
    return { accountsChanged: async () => {} };
  }
  // The workspace as it is, but with the seat limit this check sets — how many seats are free is the
  // dev database's business, so the limit is put relative to the fixture's own count.
  if (request === "@/lib/tenancy/resolve" || request.endsWith("lib/tenancy/resolve")) {
    stubHits.tenant += 1;
    const real = originalLoad.call(this, request, parent, isMain) as typeof import("../src/lib/tenancy/resolve");
    return {
      ...real,
      currentTenant: async () => {
        const t = await real.currentTenant();
        return seatsOverride === undefined ? t : { ...t, entitlements: { ...t.entitlements, seats: seatsOverride } };
      },
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  const { noPasswordYet } = require("../src/lib/no-password") as typeof import("../src/lib/no-password");
  const { seatsInUse } = require("../src/lib/seats") as typeof import("../src/lib/seats");
  const USER = require("../src/actions/user") as typeof import("../src/actions/user");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const mail: { to: string }[] = [];
  mailer.setTestPlatformMailer(async (m) => void mail.push(m));

  await cleanup(db);
  try {
    section("Set-up");
    ok("the session stand-in is the one the action loads", stubHits.session > 0);
    ok("the platform account hooks are stood in for", stubHits.hooks > 0);
    ok("the tenant's seat limit is stood in for", stubHits.tenant > 0);

    const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true, role: true, active: true, managerId: true } });
    ok("there is a super admin to be refused on (never changed)", superAdmin !== null);
    if (!superAdmin) return;

    const placeholder = "zz-fixture-placeholder";
    const mk = (name: string, role: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name: `${TAG} ${name}`, email: `${name.toLowerCase()}${MAIL}`, role, passwordHash: placeholder, ...extra }, select: { id: true, name: true } });
    const admin = await mk("Admin", "ADMIN");
    // Role changes and reporting lines need their own keys; the fixture admin holds them as grants, so the
    // check doesn't hang on how this workspace's ADMIN role happens to be configured.
    await db.userPermission.createMany({
      data: ["users.manage", "users.assignRole", "permissions.manage", "permissions.view"].map((permission) => ({ userId: admin.id, permission, allowed: true, reason: TAG })),
    });
    const sales = await mk("Sales", "SALES");
    const asha = await mk("Asha", "SALES");
    const bela = await mk("Bela", "SALES");
    const chet = await mk("Chet", "SALES");
    const off1 = await mk("Offone", "SALES", { active: false });
    const off2 = await mk("Offtwo", "SALES", { active: false });
    const off3 = await mk("Offthree", "SALES", { active: false });
    const invited = await mk("Invited", "SALES", { passwordHash: noPasswordYet() });
    const dept = await db.department.create({ data: { name: `${TAG} Field` }, select: { id: true } });
    const who = async (id: string) => db.user.findUniqueOrThrow({ where: { id }, select: { role: true, active: true, departmentId: true, managerId: true } });
    const audits = async (id: string) => db.auditLog.count({ where: { userId: admin.id, entityId: id } });

    section("Who may use it");
    actorId = sales.id;
    const notAdmin = await USER.bulkUpdateUsers({ ids: [asha.id], op: "deactivate" });
    ok("a non-admin is refused outright", !notAdmin.ok && notAdmin.error === "Only admins can change users in bulk.", notAdmin);
    ok("  and nothing changed", (await who(asha.id)).active === true);
    actorId = admin.id;
    viewingAs = true;
    const asOther = await USER.bulkUpdateUsers({ ids: [asha.id], op: "deactivate" });
    viewingAs = false;
    ok("refused while viewing as somebody", !asOther.ok && /viewing as/i.test(asOther.error), asOther);
    ok("  and nothing changed", (await who(asha.id)).active === true);

    section("Change role");
    const role = await USER.bulkUpdateUsers({ ids: [asha.id, bela.id, admin.id, superAdmin.id], op: "role", value: "MANAGEMENT" });
    ok("the action answers", role.ok, role);
    if (role.ok) {
      ok("two changed", role.data.done.map((d) => d.id).sort().join() === [asha.id, bela.id].sort().join(), role.data);
      const reasons = new Map(role.data.refused.map((r) => [r.id, r.reason]));
      ok("  your own role refused", /your own role/.test(reasons.get(admin.id) ?? ""), reasons.get(admin.id));
      ok("  the super admin refused", /super admin/i.test(reasons.get(superAdmin.id) ?? ""), reasons.get(superAdmin.id));
    }
    ok("  Asha and Bela are MANAGEMENT", (await who(asha.id)).role === "MANAGEMENT" && (await who(bela.id)).role === "MANAGEMENT");
    ok("  one audit entry each", (await audits(asha.id)) === 1 && (await audits(bela.id)) === 1);
    ok("  none for the refused", (await audits(superAdmin.id)) === 0 && (await audits(admin.id)) === 0);
    const again = await USER.bulkUpdateUsers({ ids: [asha.id], op: "role", value: "MANAGEMENT" });
    ok("  the same role again is 'already so', not a change", again.ok && again.data.unchanged.length === 1 && again.data.done.length === 0 && (await audits(asha.id)) === 1);

    section("Mark inactive / active");
    const offs = await USER.bulkUpdateUsers({ ids: [asha.id, bela.id, admin.id, superAdmin.id], op: "deactivate" });
    ok("the action answers", offs.ok, offs);
    if (offs.ok) {
      ok("two switched off", offs.data.done.length === 2, offs.data);
      const reasons = new Map(offs.data.refused.map((r) => [r.id, r.reason]));
      ok("  yourself refused", /your own account/.test(reasons.get(admin.id) ?? ""), reasons.get(admin.id));
      ok("  the super admin refused", /super admin/i.test(reasons.get(superAdmin.id) ?? ""), reasons.get(superAdmin.id));
    }
    ok("  Asha and Bela are off", !(await who(asha.id)).active && !(await who(bela.id)).active);
    ok("  you and the super admin are not", (await who(admin.id)).active && (await who(superAdmin.id)).active === superAdmin.active);
    const ons = await USER.bulkUpdateUsers({ ids: [asha.id, bela.id], op: "activate" });
    ok("both back on, with no seat limit", ons.ok && ons.data.done.length === 2 && (await who(asha.id)).active && (await who(bela.id)).active, ons);

    section("Seats");
    seatsOverride = (await seatsInUse()) + 1;
    const seats = await USER.bulkUpdateUsers({ ids: [off1.id, off2.id, off3.id], op: "activate" });
    seatsOverride = undefined;
    ok("the action answers", seats.ok, seats);
    if (seats.ok) {
      ok("one seat free: one switched on", seats.data.done.length === 1, seats.data);
      ok("  the other two refused, saying every seat is taken", seats.data.refused.length === 2 && seats.data.refused.every((r) => /every seat is taken/.test(r.reason)), seats.data.refused);
      ok("  and how many are left: none", seats.data.seatsLeft === 0, seats.data.seatsLeft);
    }
    const onNow = (await Promise.all([off1, off2, off3].map((u) => who(u.id)))).filter((u) => u.active).length;
    ok("  exactly one of the three is on", onNow === 1, onNow);

    section("Department");
    const depts = await USER.bulkUpdateUsers({ ids: [asha.id, chet.id], op: "department", value: dept.id });
    ok("both set", depts.ok && depts.data.done.length === 2 && (await who(asha.id)).departmentId === dept.id && (await who(chet.id)).departmentId === dept.id, depts);
    ok("  their roles untouched", (await who(chet.id)).role === "SALES" && (await who(asha.id)).role === "MANAGEMENT");
    const none = await USER.bulkUpdateUsers({ ids: [chet.id], op: "department", value: null });
    ok("  and No department clears it", none.ok && (await who(chet.id)).departmentId === null, none);

    section("Manager");
    // Bela reports to Asha; making Asha report to Bela would be a loop.
    const line = await USER.bulkUpdateUsers({ ids: [bela.id, chet.id, asha.id], op: "manager", value: asha.id });
    ok("the action answers", line.ok, line);
    if (line.ok) {
      ok("Bela and Chet now report to Asha", (await who(bela.id)).managerId === asha.id && (await who(chet.id)).managerId === asha.id);
      ok("  Asha refused as her own manager", /own reporting manager/.test(line.data.refused.find((r) => r.id === asha.id)?.reason ?? ""), line.data.refused);
    }
    const loop = await USER.bulkUpdateUsers({ ids: [asha.id], op: "manager", value: bela.id });
    ok("a loop is refused", loop.ok && loop.data.done.length === 0 && /reporting loop/.test(loop.data.refused[0]?.reason ?? ""), loop);
    ok("  and Asha still reports to nobody", (await who(asha.id)).managerId === null);
    const cleared = await USER.bulkUpdateUsers({ ids: [bela.id, chet.id], op: "manager", value: null });
    ok("No manager clears it", cleared.ok && (await who(bela.id)).managerId === null && (await who(chet.id)).managerId === null, cleared);

    section("Resend setup email");
    const sentBefore = mail.length;
    const setup = await USER.bulkUpdateUsers({ ids: [invited.id, asha.id], op: "resendSetup" });
    ok("the action answers", setup.ok, setup);
    if (setup.ok) {
      ok("the invited one is sent one", setup.data.done.some((d) => d.id === invited.id), setup.data);
      ok("  somebody set up is refused", /already chosen a password/.test(setup.data.refused.find((r) => r.id === asha.id)?.reason ?? ""), setup.data.refused);
    }
    ok("  one email left (to the stand-in mailer)", mail.length === sentBefore + 1 && mail.at(-1)?.to === `invited${MAIL}`, mail.slice(sentBefore));

    section("The list");
    const { createElement } = require("react") as typeof import("react"); // eslint-disable-line @typescript-eslint/no-require-imports
    const { renderToStaticMarkup } = require("react-dom/server") as typeof import("react-dom/server"); // eslint-disable-line @typescript-eslint/no-require-imports
    const { UsersDirectory } = require("../src/components/settings/people/users-directory") as typeof import("../src/components/settings/people/users-directory"); // eslint-disable-line @typescript-eslint/no-require-imports
    const rows = [asha, off1].map((u, i) => ({ id: u.id, name: u.name, roleName: "Sales", role: "SALES", departmentId: null, departmentName: null, active: i === 0, setupPending: false, isSuperAdmin: false, photoUpdatedAt: null, exceptions: 0, lapsingSoon: false }));
    // The tab Users opens on is Profile now (Permissions moved to the person's Access Control profile).
    const base = { rows, selected: null, tab: "profile", departments: [], roles: [], mayAdd: true };
    const forAdmin = renderToStaticMarkup(createElement(UsersDirectory, { ...base, bulk: { roles: [], departments: [], people: [] } }));
    const forOther = renderToStaticMarkup(createElement(UsersDirectory, { ...base, bulk: null }));
    ok("an admin sees a tick box per person and Select all shown", forAdmin.includes(`aria-label="Select ${asha.name}"`) && forAdmin.includes(`aria-label="Select ${off1.name}"`) && forAdmin.includes("Select all shown"));
    ok("  anybody else sees none", !forOther.includes('type="checkbox"') || !forOther.includes(`Select ${asha.name}`));
    ok("  the Active / Inactive filter is there to pick from", forAdmin.includes("Inactive (1)") && forAdmin.includes("Active (1)"));
    ok("  and each person opens under Users, not on a tab that moved away", forAdmin.includes(`href="/settings/users?user=${asha.id}"`) && forAdmin.includes(`href="/settings/users?user=${off1.id}"`) && !forAdmin.includes("/settings/access/"));

    ok("the super admin is exactly as found", JSON.stringify(await db.user.findUniqueOrThrow({ where: { id: superAdmin.id }, select: { id: true, role: true, active: true, managerId: true } })) === JSON.stringify(superAdmin));
  } finally {
    actorId = "";
    await cleanup(db);
    await db.$disconnect?.();
  }
  console.log(`\n${passes} passed, ${failures} failed`);
  if (failures) process.exitCode = 1;
}

async function cleanup(db: typeof import("../src/lib/db").db) {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  await db.user.updateMany({ where: { id: { in: ids } }, data: { managerId: null } });
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }] } });
  await db.permissionChange.deleteMany({ where: { OR: [{ actorUserId: { in: ids } }, { subjectUserId: { in: ids } }] } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
  await db.signIn.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.department.deleteMany({ where: { name: { startsWith: TAG } } });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
