/**
 * Settings › Staff: Users, and Settings › Access Control — what was Staff & roles, then Users and Roles &
 * Permissions, with everything about what a role or a person may do now one area (`/settings/access/...`).
 *
 *   1. The pieces without a page: a person's status, "58m ago", which module a permission needs.
 *   2. Users: the list (All / Active / Inactive), one person open — their header, Profile with the open
 *      leads and job title, Login & Access with the last sign-in and the account's actions — as an admin
 *      and as a read-only reviewer. What they may do is their Access Control profile: its tabs, their
 *      exceptions, their daily limit, the Module Matrix opened on them — read-only for a reviewer, for
 *      yourself and for the super admin. And every retired Staff & roles link lands where it moved.
 *   3. Switching somebody off works, never deletes, and is refused for yourself and for the super admin.
 *   4. Add staff creates an account with a setup link and no password — and keeps `createUser`'s old
 *      callers working.
 *   5. Saving a role writes exactly the boxes ticked (a permission's wider reach is its own box), all
 *      or nothing, and nobody can take away their own way into these screens.
 *   6. A role on the Module Matrix, as a read-only reviewer, an admin and a manager who holds a few keys:
 *      the reasons a row can't change; its records on Data Scope; the matrix's own save (`saveRoleAnswers`)
 *      held to every rule in 5; and the server refuses a reviewer anyway.
 *   7. Roles & Permissions: the roles as a list, each row's menu and what it refuses; the open role's
 *      matrix, people, simulator and audit log; the exceptions and who-holds-what on Employee Permissions;
 *      and every link to the retired Roles, permission matrix and Unmasking logs pages lands where it moved.
 *   8. The door: every Access Control screen is not found for somebody without `permissions.view`.
 *   9. The names: the Settings entry, the area's own menu, the browser tabs, the sidebar.
 *
 * The real actions and the real pages, with the session, `next/cache`, `next/navigation`, the dialog's
 * portal, a row's "⋯" menu and the platform account hooks substituted. No mail leaves (the platform mailer is
 * replaced), no password is typed or set — fixtures that can "sign in" hold a placeholder nothing
 * matches. Everything is named ZZSTAFF / @zzstaff-check.invalid and removed in a finally; assertions
 * are about the fixtures, never about how many people the database happens to hold.
 *
 * Set STAFF_RENDERS_DIR to keep the rendered HTML of each screen.
 *
 *   npm run check:staff-roles
 */
import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import Module from "node:module";
import { cloneElement, createElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";

const TAG = "ZZSTAFF";
const MAIL = "@zzstaff-check.invalid";
const RENDERS = process.env.STAFF_RENDERS_DIR?.trim() || "";

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
const stubHits = { session: 0, dialog: 0, hooks: 0, menu: 0 };
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
      refuseWhileViewingAs: async () => null,
    };
  }
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("NEXT_NOT_FOUND");
      },
      redirect: (to: string) => {
        throw new Error(`redirect ${to}`);
      },
      useRouter: () => ({ push() {}, refresh() {}, replace() {}, back() {}, prefetch() {} }),
      useSearchParams: () => new URLSearchParams(),
      usePathname: () => "/settings/users",
    };
  }
  // The dialog portals into document.body, which a server render has none of. Its contents are what
  // is being checked, so it renders them in place — open or not, exactly as the real one decides.
  if (request === "@/components/ui/dialog" || request.endsWith("components/ui/dialog")) {
    stubHits.dialog += 1;
    return {
      Dialog: ({ open, title, children }: { open: boolean; title: string; children: ReactNode }) =>
        open ? createElement("div", { role: "dialog", "aria-label": title, "data-dialog": "in-place" }, children) : null,
    };
  }
  // A row's "⋯" menu opens into a portal on a click nobody makes here. What it offers — and what it refuses,
  // and why — is what is being checked, so its items are drawn in place; the items themselves are the real ones.
  if (request === "@/components/ui/menu" || request.endsWith("components/ui/menu")) {
    stubHits.menu += 1;
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return {
      ...real,
      Menu: ({ label, children }: { label?: string; children: (close: () => void) => ReactNode }) => createElement("div", { role: "menu", "aria-label": label ?? "More", "data-menu": "in-place" }, children(() => {})),
    };
  }
  // The control plane's email index and linked sign-in: nothing here should reach them.
  if (request === "@/lib/platform/account-hooks" || request.endsWith("lib/platform/account-hooks")) {
    stubHits.hooks += 1;
    return { accountsChanged: async () => {} };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

/** A server component tree with its nested async components awaited, so it can be rendered. */
async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  }
  if (el.props && "children" in el.props) {
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as ReactNode[])) : cloneElement(el, undefined, kids as ReactNode);
  }
  return el;
}

const html = (el: unknown) => renderToStaticMarkup(el as ReactElement);

function keep(name: string, markup: string) {
  if (!RENDERS) return;
  fs.mkdirSync(RENDERS, { recursive: true });
  const page = `<!doctype html><meta charset="utf-8"><title>${name}</title>\n${markup}\n`;
  fs.writeFileSync(path.join(RENDERS, `${name}.html`), page);
}

/** What a person reads: the markup without its tags, React's text separators or entities. */
function text(markup: string): string {
  return markup
    .replace(/<!-- -->/g, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ");
}
const count = (markup: string, pattern: RegExp) => (markup.match(pattern) ?? []).length;

// ─── Main ────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  // Required here, after the stand-ins are in place: a top-of-file import would load these (and what
  // they import) before `Module._load` is replaced, and the real session would answer.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const mailer = require("../src/lib/platform/mailer") as typeof import("../src/lib/platform/mailer");
  const { can, permissionsFor } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const { rolePermits } = require("../src/lib/authz/role-permission") as typeof import("../src/lib/authz/role-permission");
  const { PERMISSIONS } = require("../src/lib/permissions") as typeof import("../src/lib/permissions");
  const { MODULE_REGISTRY } = require("../src/lib/modules") as typeof import("../src/lib/modules");
  const { noPasswordYet, AWAITING_SETUP } = require("../src/lib/no-password") as typeof import("../src/lib/no-password");
  const { indiaClock } = require("../src/lib/time/zone") as typeof import("../src/lib/time/zone");
  const { staffFacts } = require("../src/lib/staff/roster") as typeof import("../src/lib/staff/roster");
  const { staffStatus, relativeAgo } = require("../src/lib/staff/status") as typeof import("../src/lib/staff/status");
  const { permissionModules, moduleNote } = require("../src/lib/staff/permission-modules") as typeof import("../src/lib/staff/permission-modules");
  const { SETTINGS_ITEMS } = require("../src/lib/settings/catalogue") as typeof import("../src/lib/settings/catalogue");
  const USER = require("../src/actions/user") as typeof import("../src/actions/user");
  const ROLE = require("../src/actions/role") as typeof import("../src/actions/role");
  const PERM = require("../src/actions/permission") as typeof import("../src/actions/permission");
  const USERS = require("../src/app/(dashboard)/settings/users/page") as typeof import("../src/app/(dashboard)/settings/users/page");
  // Settings › Access Control, where everything about what a role or a person may do now lives.
  const AC = "../src/app/(dashboard)/settings/access";
  const OVERVIEW = require(`${AC}/page`) as typeof import("../src/app/(dashboard)/settings/access/page");
  const ROLES = require(`${AC}/roles/page`) as typeof import("../src/app/(dashboard)/settings/access/roles/page");
  const WIZARD = require(`${AC}/roles/wizard/page`) as typeof import("../src/app/(dashboard)/settings/access/roles/wizard/page");
  const MODULES = require(`${AC}/modules/page`) as typeof import("../src/app/(dashboard)/settings/access/modules/page");
  const SCOPE = require(`${AC}/scope/page`) as typeof import("../src/app/(dashboard)/settings/access/scope/page");
  const FIELDS = require(`${AC}/fields/page`) as typeof import("../src/app/(dashboard)/settings/access/fields/page");
  const DOCUMENTS = require(`${AC}/documents/page`) as typeof import("../src/app/(dashboard)/settings/access/documents/page");
  const EMPLOYEES = require(`${AC}/employees/page`) as typeof import("../src/app/(dashboard)/settings/access/employees/page");
  const EMPLOYEE = require(`${AC}/employees/[id]/page`) as typeof import("../src/app/(dashboard)/settings/access/employees/[id]/page");
  const AUDIT = require(`${AC}/audit/page`) as typeof import("../src/app/(dashboard)/settings/access/audit/page");
  const SIMULATOR = require(`${AC}/simulator/page`) as typeof import("../src/app/(dashboard)/settings/access/simulator/page");
  const COMPARE = require(`${AC}/compare/page`) as typeof import("../src/app/(dashboard)/settings/access/compare/page");
  const SENSITIVE = require(`${AC}/sensitive/page`) as typeof import("../src/app/(dashboard)/settings/access/sensitive/page");
  const MASKING = require(`${AC}/sensitive/masking/page`) as typeof import("../src/app/(dashboard)/settings/access/sensitive/masking/page");
  const LIMITS = require(`${AC}/sensitive/limits/page`) as typeof import("../src/app/(dashboard)/settings/access/sensitive/limits/page");
  const IMPORT_EXPORT = require(`${AC}/import-export/page`) as typeof import("../src/app/(dashboard)/settings/access/import-export/page");
  const SECURITY = require(`${AC}/security/page`) as typeof import("../src/app/(dashboard)/settings/access/security/page");
  const AC_LAYOUT = require(`${AC}/layout`) as typeof import("../src/app/(dashboard)/settings/access/layout");
  // The pages those replaced, kept to send a saved link on.
  const RETIRED_ROLES = require("../src/app/(dashboard)/settings/roles/page") as typeof import("../src/app/(dashboard)/settings/roles/page");
  const RETIRED_MATRIX = require("../src/app/(dashboard)/settings/roles/matrix/page") as typeof import("../src/app/(dashboard)/settings/roles/matrix/page");
  const RETIRED_LOGS = require("../src/app/(dashboard)/settings/unmasking-logs/page") as typeof import("../src/app/(dashboard)/settings/unmasking-logs/page");
  const RETIRED_PERSON = require(`${AC}/users/[id]/page`) as typeof import("../src/app/(dashboard)/settings/access/users/[id]/page");
  const RETIRED_ADD = require(`${AC}/new/page`) as typeof import("../src/app/(dashboard)/settings/access/new/page");
  const ADD = require("../src/app/(dashboard)/settings/users/new/page") as typeof import("../src/app/(dashboard)/settings/users/new/page");
  const { ACCESS_MODULES, FOLDED_KEYS, REACH_KEYS, permissionsOfModule } = require("../src/lib/staff/access-modules") as typeof import("../src/lib/staff/access-modules");
  const { isDocKey } = require("../src/lib/documents/permission-keys") as typeof import("../src/lib/documents/permission-keys");
  const { userPath, rolePath, userAccessPath } = require("../src/lib/staff/staff-paths") as typeof import("../src/lib/staff/staff-paths");
  const { acPath, AC_NAV, AC_TOOLS } = require("../src/lib/access-control/nav") as typeof import("../src/lib/access-control/nav");
  const { roleAccessLevels } = require("../src/actions/access-levels") as typeof import("../src/actions/access-levels");
  const { saveRoleAnswers } = require("../src/actions/access-control-modules") as typeof import("../src/actions/access-control-modules");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const mail: { to: string; subject: string; text: string }[] = [];
  mailer.setTestPlatformMailer(async (m) => void mail.push(m));

  const renderUsers = async (sp: Record<string, string> = {}) => html(await resolveAsync(await USERS.default({ searchParams: Promise.resolve(sp) })));
  /** A page of Access Control, drawn for whoever `actorId` is — or "threw: …" where it refuses them or sends them on. */
  const draw = async (page: () => unknown) => {
    try {
      return html(await resolveAsync(await page()));
    } catch (err) {
      return `threw: ${(err as Error).message}`;
    }
  };
  const renderRoles = () => draw(() => ROLES.default());
  const renderModules = (sp: { role?: string; user?: string }) => draw(() => MODULES.default({ searchParams: Promise.resolve(sp) }));
  const renderScope = (sp: { role?: string; user?: string; record?: string }) => draw(() => SCOPE.default({ searchParams: Promise.resolve(sp) }));
  const renderEmployee = (id: string, tab?: string) => draw(() => EMPLOYEE.default({ params: Promise.resolve({ id }), searchParams: Promise.resolve(tab ? { tab } : {}) }));
  const renderEmployees = (sp: { role?: string } = {}) => draw(() => EMPLOYEES.default({ searchParams: Promise.resolve(sp) }));
  /** Where a retired page sends you: the stand-in `redirect` throws with the address. */
  const landsOn = async (page: () => unknown) => {
    try {
      await page();
      return null;
    } catch (err) {
      return /^redirect (.*)$/.exec((err as Error).message)?.[1] ?? (err as Error).message;
    }
  };

  await cleanup(db);
  try {
    section("Set-up");
    ok("the session stand-in is the one the actions load", stubHits.session > 0);
    ok("the dialog renders in place, not into a portal", stubHits.dialog > 0);
    ok("the platform account hooks are stood in for", stubHits.hooks > 0);
    ok("a row's menu is drawn in place, not behind a click", stubHits.menu > 0);

    const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true, name: true } });
    ok("there is a super admin to look at (borrowed, never changed)", superAdmin !== null);
    if (!superAdmin) return;

    // Two fixture roles: a reviewer who may only look, and a manager who may change roles but holds
    // only a few keys — the shape the dialog's refusals are about.
    const AUDITOR = `${TAG}_AUDITOR`;
    const MANAGER = `${TAG}_MANAGER`;
    await db.role.create({ data: { key: AUDITOR, name: `${TAG} Auditor`, sortOrder: 990 } });
    await db.role.create({ data: { key: MANAGER, name: `${TAG} Manager`, sortOrder: 991 } });
    await db.rolePermission.createMany({
      data: [
        { role: AUDITOR, permission: "permissions.view", allowed: true },
        ...["permissions.view", "permissions.manage", "tickets.create", "leads.view", "visits.view"].map((permission) => ({
          role: MANAGER,
          permission,
          allowed: true,
        })),
      ],
    });

    // A placeholder nothing can match — not a password, and nobody's. Not "awaiting setup" either.
    const signedUp = "zz-fixture-placeholder";
    const mk = (name: string, local: string, role: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${local}${MAIL}`, role, passwordHash: signedUp, ...extra }, select: { id: true, name: true } });
    const admin = await mk(`${TAG} Admin`, "admin", "ADMIN");
    // View as is the super admin's to hand out, not an admin's by default (audit M-1, 2 Nov 2026): this admin was given it.
    await db.userPermission.create({ data: { userId: admin.id, permission: "impersonation.use", allowed: true, reason: `${TAG} view as` } });
    const auditor = await mk(`${TAG} Reviewer`, "auditor", AUDITOR);
    const manager = await mk(`${TAG} Manager Person`, "manager", MANAGER);
    const akash = await mk(`${TAG} Akash`, "akash", "SALES", {
      phone: "+91 90000 00001",
      employeeProfile: { create: { designation: "Zz Field Engineer" } },
    });
    const bina = await mk(`${TAG} Bina`, "bina", "SALES", { passwordHash: noPasswordYet() });
    const chetan = await mk(`${TAG} Chetan`, "chetan", "SALES", { active: false });

    const now = new Date();
    // Today on the workspace's clock, which is India's here.
    const today = indiaClock.parts(now);
    const startOfToday = indiaClock.midnight(today.year, today.month, today.day);
    const company = await db.company.create({
      data: { name: `${TAG} Leads Co`, normalizedName: `${TAG.toLowerCase()} leads co`, createdById: admin.id, ownerUserId: akash.id },
      select: { id: true },
    });
    await db.lead.createMany({
      data: [
        { companyId: company.id, title: `${TAG} upcoming`, status: "NEW", ownerUserId: akash.id, expectedCloseDate: new Date(startOfToday.getTime() + 2 * 86_400_000) },
        { companyId: company.id, title: `${TAG} slipped`, status: "QUALIFIED", ownerUserId: akash.id, expectedCloseDate: new Date(startOfToday.getTime() - 3 * 86_400_000) },
        { companyId: company.id, title: `${TAG} won`, status: "WON", ownerUserId: akash.id, expectedCloseDate: new Date(startOfToday.getTime() - 10 * 86_400_000) },
      ],
    });
    const signedInAt = new Date(now.getTime() - 58 * 60_000);
    await db.signIn.create({ data: { sid: `${TAG}-${Date.now()}`, userId: akash.id, provider: "credentials", at: signedInAt, lastSeenAt: signedInAt } });

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("1. The pieces, without a page");

    ok("switched off wins over invited", staffStatus({ active: false, setupPending: true }) === "off");
    ok("  invited is active with no password yet", staffStatus({ active: true, setupPending: true }) === "invited");
    ok("  and active is the rest", staffStatus({ active: true, setupPending: false }) === "active");
    const ago = (ms: number) => relativeAgo(new Date(now.getTime() - ms), now);
    ok("\"58m ago\", \"3h ago\", \"2d ago\", \"just now\"", ago(58 * 60_000) === "58m ago" && ago(3 * 3_600_000) === "3h ago" && ago(2 * 86_400_000) === "2d ago" && ago(20_000) === "just now");
    ok("Run payroll belongs to the Payroll module", permissionModules("payroll.manage").join() === "payroll");
    ok("  View leads to none — leads are the core of the app", permissionModules("leads.view").length === 0);
    ok("  View quotes & invoices to both documents modules", permissionModules("documents.view").join() === "sales_documents,purchase_documents");
    const moduleKeys = new Set(MODULE_REGISTRY.map((m) => m.key));
    const strays = PERMISSIONS.flatMap((p) => permissionModules(p.key)).filter((k) => !moduleKeys.has(k));
    ok("every module the dialog files a permission under exists", strays.length === 0, strays.join(", "));
    const payrollOff = { payroll: { key: "payroll", label: "Payroll", entitled: true, switchedOn: false } };
    ok("a module that is off says so", (moduleNote(["payroll"], payrollOff) ?? "").includes("switched off"));
    ok("  and one that is on says nothing", moduleNote(["payroll"], { payroll: { ...payrollOff.payroll, switchedOn: true } }) === null);

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("2. The Staff tab: counts and statuses");

    const facts = await staffFacts([akash.id, bina.id, chetan.id], { leads: true, signIns: true, now });
    const a = facts.get(akash.id);
    ok("Leads: the open leads they own — Won doesn't count", a?.openLeads === 2, a);
    ok("  and the one past its expected close date is counted as overdue", a?.overdueLeads === 1, a);
    ok("  last signed in is their newest sign-in", a?.lastSignInAt?.getTime() === signedInAt.getTime());
    ok("  job title from the HR record, phone from the account", a?.jobTitle === "Zz Field Engineer" && a?.phone === "+91 90000 00001");
    ok("somebody with none has 0 leads and no sign-in", facts.get(bina.id)?.openLeads === 0 && facts.get(bina.id)?.lastSignInAt === null);
    const quiet = await staffFacts([akash.id], { leads: false, signIns: false, now });
    ok("  and nothing is fetched that wasn't asked for", quiet.get(akash.id)?.openLeads === null && quiet.get(akash.id)?.lastSignInAt === null);

    actorId = admin.id;
    const usersHtml = await renderUsers({ user: akash.id, tab: "profile" });
    keep("users-akash-profile-admin", usersHtml);
    const usersText = text(usersHtml);
    ok("the page is Users", usersHtml.includes(">Users<") && usersHtml.includes("Manage users and configure individual permissions."));
    const everybody = await db.user.count();
    const activeNow = await db.user.count({ where: { active: true } });
    const tabCount = (label: string) => Number(new RegExp(`${label} \\((\\d+)\\)`).exec(usersText)?.[1]);
    ok("All, Active and Inactive, each counted", tabCount("All") === everybody && tabCount("Active") === activeNow && tabCount("Inactive") === everybody - activeNow, `${tabCount("All")}/${tabCount("Active")}/${tabCount("Inactive")} vs ${everybody}/${activeNow}`);
    ok("  with search, department and role filters", usersHtml.includes('placeholder="Search users…"') && usersHtml.includes(">All departments<") && usersHtml.includes(">All roles<"));
    ok("  and + to add somebody", usersHtml.includes('href="/settings/users/new"'));
    const listed = (name: string) => usersHtml.split("<li").find((chunk) => chunk.includes(`>${name}</span>`)) ?? "";
    ok("everybody is listed with role • department, opening on Profile, the tab Users opens on", listed(`${TAG} Akash`).includes(`href="${userPath(akash.id).replaceAll("&", "&amp;")}"`) && text(listed(`${TAG} Akash`)).includes("Sales"));
    ok("  Bina, who hasn't chosen a password, says invited", text(listed(`${TAG} Bina`)).includes("• invited"));
    ok("  and Chetan, switched off, inactive", text(listed(`${TAG} Chetan`)).includes("• inactive"));
    ok("Akash is open: his initials, Active, his phone", usersHtml.includes(">ZA<") && usersHtml.includes(">Active<") && usersHtml.includes("+91 90000 00001") && usersHtml.includes('aria-current="page"'));
    // The header's "Save changes" saved a draft of the permission editors that sat under it. Those editors moved to
    // the person's Access Control profile, which saves from its own screens; what the header offers in its place is
    // the way there.
    const toAccess = usersHtml.match(new RegExp(`<a[^>]*href="${userAccessPath(akash.id)}"[^>]*>[\\s\\S]*?</a>`))?.[0] ?? "";
    ok("  with Reset to role defaults, View as user and the way to their Permissions & access", usersHtml.includes("Reset to role defaults") && usersHtml.includes("View as user") && text(toAccess).includes("Permissions & access"), toAccess || "no link to their Access Control profile");
    ok("    and no Save changes: nothing on Users is drafted any more", !usersHtml.includes("Save changes"));
    ok("  and the account's tabs: Profile, Role, Login & Access, Activity", ["Profile", "Role", "Login &amp; Access", "Activity"].every((t) => usersHtml.includes(`>${t}</a>`)));
    ok("    the four that were about access are not tabs here", ["Permissions", "Record Access", "Field Permissions", "Business Rules"].every((t) => !usersHtml.includes(`>${t}</a>`)));
    ok(
      "    a saved link to one of them lands on that part of the person's Access Control profile",
      (await landsOn(() => USERS.default({ searchParams: Promise.resolve({ user: akash.id, tab: "permissions" }) }))) === acPath.employee(akash.id, "overrides") &&
        (await landsOn(() => USERS.default({ searchParams: Promise.resolve({ user: akash.id, tab: "records" }) }))) === acPath.employee(akash.id, "scope") &&
        (await landsOn(() => USERS.default({ searchParams: Promise.resolve({ user: akash.id, tab: "fields" }) }))) === acPath.employee(akash.id, "fields") &&
        (await landsOn(() => USERS.default({ searchParams: Promise.resolve({ user: akash.id, tab: "rules" }) }))) === acPath.employee(akash.id, "pii"),
      await landsOn(() => USERS.default({ searchParams: Promise.resolve({ user: akash.id, tab: "permissions" }) })),
    );
    ok("Profile: job title, and open leads with the overdue one", usersText.includes("Zz Field Engineer") && usersText.includes("2 (1 past their expected close date)"));
    ok("  and Edit profile", usersHtml.includes("Edit profile"));
    const akashLogin = await renderUsers({ user: akash.id, tab: "login" });
    keep("users-akash-login-admin", akashLogin);
    ok("Login & Access: when he last signed in", text(akashLogin).includes("Last sign-in:") && !text(akashLogin).includes("Last sign-in: never"));
    const listedOnLogin = akashLogin.split("<li").find((chunk) => chunk.includes(`>${TAG} Bina</span>`)) ?? "";
    ok("  and the list opens the next person on the tab already open", listedOnLogin.includes(`href="${userPath(bina.id, "login").replaceAll("&", "&amp;")}"`));
    ok("  Switch off and Send password reset, each through its own action", akashLogin.includes("Switch off") && akashLogin.includes("Send password reset"));
    const binaLogin = text(await renderUsers({ user: bina.id, tab: "login" }));
    ok("  Bina is Invited, and never signed in", binaLogin.includes("Invited — no password chosen yet") && binaLogin.includes("Last sign-in: never"));
    const ownLogin = await renderUsers({ user: admin.id, tab: "login" });
    ok("no Switch off on your own account", !ownLogin.includes("Switch off"));
    const saLogin = await renderUsers({ user: superAdmin.id, tab: "login" });
    ok("  nor on the super admin's, nor Edit profile for an admin who isn't one", !saLogin.includes("Switch off") && !(await renderUsers({ user: superAdmin.id, tab: "profile" })).includes("Edit profile"));
    ok("Users opens on Profile", (await renderUsers({ user: akash.id })) === usersHtml || text(await renderUsers({ user: akash.id })).includes("Zz Field Engineer"));

    // What Akash may do — once the Permissions tab here — is his Access Control profile
    // (src/app/(dashboard)/settings/access/employees/[id]/page.tsx) and the screens it opens on him.
    const akashAccess = await renderEmployee(akash.id);
    keep("access-akash-overview-admin", akashAccess);
    ok(
      "his Access Control profile: who he is, his role, and a tab for each part of his access",
      text(akashAccess).includes(`${TAG} Akash`) && akashAccess.includes(">Sales<") && ["Overview", "Module permissions", "Field permissions", "Overrides", "Sensitive access", "PII & Unmasking", "Data scope", "Activity"].every((t) => text(akashAccess).includes(t)) && akashAccess.includes(`href="${acPath.employee(akash.id, "overrides")}"`),
      akashAccess.slice(0, 200),
    );
    ok("  with Simulate, View as user and Reset to role defaults", akashAccess.includes("View as user") && akashAccess.includes("Reset to role defaults") && akashAccess.includes("Simulate") && akashAccess.includes("Switch off account"));
    // Moving somebody between roles is the super admin's ("Change somebody's role" is granted by nobody else).
    const mayMove = (await can(admin.id, "users.manage")) && (await can(admin.id, "users.assignRole"));
    ok("    and Change role only for whoever may move people between roles", akashAccess.includes("Change role") === mayMove, mayMove ? "this admin may, and isn't offered it" : "this admin may not, and is offered it");
    actorId = superAdmin.id;
    ok("    which the super admin may", (await renderEmployee(akash.id)).includes("Change role"));
    actorId = admin.id;
    ok("  and the way back to his account", akashAccess.includes(`href="${userPath(akash.id, "profile").replaceAll("&", "&amp;")}"`) && text(akashAccess).includes("Account & sign-in settings"));
    const akashOverrides = await renderEmployee(akash.id, "overrides");
    keep("access-akash-overrides-admin", akashOverrides);
    ok("Overrides: the exceptions made for him alone, with Add override", akashOverrides.includes("Add override") && !akashOverrides.includes("You can review access but not change it."), text(akashOverrides).slice(0, 300));
    const akashPii = await renderEmployee(akash.id, "pii");
    keep("access-akash-pii-admin", akashPii);
    ok("PII & Unmasking: the daily limit that applies to him, and the fields masked for him", text(akashPii).includes("Daily unmasking quota") && text(akashPii).includes("daily limit") && text(akashPii).includes("records unmasked today"), text(akashPii).slice(0, 300));
    // Effective access, module by module, with what the role gives beside what applies to him.
    const akashModules = await renderEmployee(akash.id, "modules");
    ok("Overview and Module permissions: effective access for him, beside what his role gives", text(akashAccess).includes("Effective module access") && ["Module access", "Role · Sales", `Effective for ${TAG}`, "Permissions held"].every((t) => text(akashModules).includes(t)) && akashModules.includes(`href="${acPath.modules({ user: akash.id })}"`), text(akashModules).slice(0, 300));
    // Sensitive field masking: what each masked field shows him, with the way to the field manager opened on him.
    const akashFields = await renderEmployee(akash.id, "fields");
    ok("Field permissions: each record type's sensitive fields as they show for him, and where to change them", ["leads", "contacts", "companies"].every((entity) => akashFields.includes(`href="${acPath.fields({ user: akash.id, entity }).replaceAll("&", "&amp;")}"`)) && text(akashFields).includes("Email"), text(akashFields).slice(0, 300));
    // Conditions — which of the records a permission covers, and until when — are his Data scope, saved as overrides
    // with a reason and an end date.
    const akashScopeTab = await renderEmployee(akash.id, "scope");
    const akashScope = await renderScope({ user: akash.id });
    ok(
      "Data scope: which records each action reaches for him, his own level over his role's, saved as overrides",
      akashScopeTab.includes(`href="${acPath.scope({ user: akash.id })}"`) && ["Data Scope Management", "Set for them", "Their role's", "Save as overrides"].every((t) => text(akashScope).includes(t)) && akashScope.includes(`scope for ${TAG} Akash`),
      text(akashScope).slice(0, 300),
    );
    // Individual Permissions — role default, override and effective for each action — is the Module Matrix opened
    // on him (src/components/access-control/modules/module-matrix.tsx): what applies, his own answer, and why.
    const akashMatrix = await renderModules({ user: akash.id });
    keep("access-akash-modules-admin", akashMatrix);
    ok(
      "his permissions, action by action: what applies, the exception for him alone, and where the answer comes from",
      ["Module Permission Matrix", "Role: Sales", "Allowed", "Exception for them", "Source", "Save as exceptions", "Exceptions for them alone", "All from their role"].every((t) => text(akashMatrix).includes(t)) && akashMatrix.includes(`${TAG} Akash`),
      ["Module Permission Matrix", "Role: Sales", "Allowed", "Exception for them", "Source", "Save as exceptions", "Exceptions for them alone", "All from their role"].filter((t) => !text(akashMatrix).includes(t)).join(", "),
    );
    const viewLeads = akashMatrix.match(/<span role="radiogroup" aria-label="View leads: stored answer"[\s\S]*?<\/span>/)?.[0] ?? "";
    ok(
      "  every action offers their role's answer, Allow and Deny",
      (viewLeads.match(/role="radio"/g) ?? []).length === 3 && [">Role<", ">Allow<", ">Deny<"].every((w) => viewLeads.includes(w)) && /aria-checked="true"[^>]*>Role</.test(viewLeads) && !/disabled=""/.test(viewLeads),
      viewLeads || "no row for View leads",
    );
    ok("  and says in a line why it applies", /aria-label="View leads: (allowed|not allowed)"/.test(akashMatrix) && text(akashMatrix).includes("An exception — Allow or Deny — beats whatever their role says"));

    actorId = auditor.id;
    const usersReviewer = await renderUsers({ user: akash.id, tab: "profile" });
    keep("users-akash-profile-reviewer", usersReviewer);
    ok("a reviewer is told it's read-only", usersReviewer.includes("You can review access but not change it."));
    ok("  and gets no add, Edit profile or Reset", !usersReviewer.includes("/settings/users/new") && !usersReviewer.includes("Edit profile") && !usersReviewer.includes("Reset to role defaults"));
    ok("  nor Switch off", !(await renderUsers({ user: akash.id, tab: "login" })).includes("Switch off"));
    const reviewerAccess = await renderEmployee(akash.id, "overrides");
    keep("access-akash-overrides-reviewer", reviewerAccess);
    ok("  on his Access Control profile too: read-only, no Add override, Change role or Reset", reviewerAccess.includes("You can review access but not change it.") && !reviewerAccess.includes("Add override") && !reviewerAccess.includes("Change role") && !reviewerAccess.includes("Reset to role defaults") && !reviewerAccess.includes("View as user"));
    const reviewerMatrix = await renderModules({ user: akash.id });
    const reviewerLeads = reviewerMatrix.match(/<span role="radiogroup" aria-label="View leads: stored answer"[\s\S]*?<\/span>/)?.[0] ?? "";
    ok("    and every answer in his matrix locked, saying why", reviewerMatrix.includes("You can review access but not change it. Everything here is read-only.") && (reviewerLeads.match(/disabled=""/g) ?? []).length === 3, reviewerLeads || reviewerMatrix.slice(0, 200));
    ok("  and sees no open leads or sign-ins without the permissions behind them", !text(usersReviewer).includes("Open leads") && !text(await renderUsers({ user: akash.id, tab: "login" })).includes("Last sign-in"));

    actorId = admin.id;
    // The same locks the Permissions tab had, on the screens that replaced it: nobody changes their own access, and
    // there is nothing to set for the super admin.
    const ownAccess = await renderEmployee(admin.id, "overrides");
    ok("an admin's own access is another admin's to change", ownAccess.includes("Your own access is changed by another admin.") && !ownAccess.includes("Add override") && !ownAccess.includes("Reset to role defaults"));
    ok("  in their own matrix too", (await renderModules({ user: admin.id })).includes("Your own access is changed by another admin. Everything here is read-only."));
    const saAccess = await renderEmployee(superAdmin.id, "overrides");
    ok("  and there is nothing to set for the super admin", saAccess.includes("A super admin holds everything and sees every field. There is nothing to set for them.") && !saAccess.includes("Add override") && !saAccess.includes("Switch off account") && (await renderModules({ user: superAdmin.id })).includes("There is nothing to set for them. Everything here is read-only."));

    // Staff & roles lived at /settings/access with `?tab=`. That address is the Access Control Overview now; a link
    // that still names one of the old tabs lands on the screen that replaced it.
    const overview = (sp: Record<string, string>) => landsOn(() => OVERVIEW.default({ searchParams: Promise.resolve(sp) }));
    ok("an old link to Staff or People lands on Employee Permissions", (await overview({ tab: "people" })) === acPath.employees() && (await overview({ tab: "staff" })) === acPath.employees(), await overview({ tab: "people" }));
    ok("  the bare address is the Overview itself, sending nobody anywhere", (await overview({})) === null);
    ok("  one to a role, on the same role", (await overview({ tab: "roles", role: "SALES", rtab: "summary" })) === rolePath("SALES", "summary") && rolePath("SALES", "summary") === acPath.modules({ role: "SALES" }), await overview({ tab: "roles", role: "SALES", rtab: "summary" }));
    ok("  one to the roles, on the roles list", (await overview({ tab: "roles" })) === acPath.roles());
    ok("  Compare roles to Compare", (await overview({ tab: "roles", view: "compare" })) === acPath.compare());
    // Exceptions and Who can land ON their sections: both moved to Employee Permissions with the ids they had.
    ok("  Exceptions and Who can to their sections of Employee Permissions", (await overview({ tab: "exceptions" })) === `${acPath.employees()}#exceptions` && (await overview({ tab: "who" })) === `${acPath.employees()}#who-can`, `${await overview({ tab: "exceptions" })} · ${await overview({ tab: "who" })}`);
    ok("    which is the page that holds them", (await overview({ tab: "exceptions" }))?.split("#")[0] === acPath.employees() && (await overview({ tab: "who" }))?.split("#")[0] === acPath.employees());
    const person = (tab?: string) => landsOn(() => RETIRED_PERSON.default({ params: Promise.resolve({ id: akash.id }), searchParams: Promise.resolve(tab ? { tab } : {}) }));
    ok("  and a person's old access page to that part of their Access Control profile", (await person("fields")) === userPath(akash.id, "fields") && userPath(akash.id, "fields") === acPath.employee(akash.id, "fields") && (await person("records")) === acPath.employee(akash.id, "scope") && (await person("rules")) === acPath.employee(akash.id, "pii"), await person("fields"));
    ok("    its account tabs to Users, on the same tab", (await person("login")) === userPath(akash.id, "login") && (await person("activity")) === `/settings/users?user=${akash.id}&tab=activity`);
    // That page was one person's ACCESS, and opened on Permissions: the bare link and the access tabs land on their
    // Access Control profile, a link to their sign-in or activity on Users.
    ok("    and the bare link — it opened on Permissions — to their access, not their account", (await person()) === userPath(akash.id, "permissions") && (await person("permissions")) === userPath(akash.id, "permissions"), `${await person()} · ${await person("permissions")}`);
    ok("  the old Add staff page to the form under Users", (await landsOn(() => RETIRED_ADD.default())) === "/settings/users/new");

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("3. Switching somebody off");

    actorId = admin.id;
    const off = await USER.setUserActive(akash.id, false);
    ok("Switch off switches Akash off", off.ok, off.ok ? "" : off.error);
    ok("  and only switches him off — the account and everything he owns are still there", (await db.user.findUnique({ where: { id: akash.id }, select: { active: true } }))?.active === false && (await db.lead.count({ where: { ownerUserId: akash.id } })) === 3);
    const offHtml = await renderUsers({ user: akash.id, tab: "login" });
    ok("  he shows as inactive, with Switch on", text(offHtml).includes("• inactive") && offHtml.includes(">Inactive<") && offHtml.includes("Switch on"));
    const back = await USER.setUserActive(akash.id, true);
    ok("  and can be switched back on", back.ok, back.ok ? "" : back.error);
    const self = await USER.setUserActive(admin.id, false);
    ok("switching yourself off is refused", !self.ok && /own account/.test(self.error), self.ok ? "allowed" : self.error);
    const sa = await USER.setUserActive(superAdmin.id, false);
    ok("  and so is switching off the super admin, by an admin", !sa.ok, sa.ok ? "allowed" : sa.error);
    const confirmSource = fs.readFileSync(path.join(__dirname, "../src/components/settings/people/user-account-actions.tsx"), "utf8");
    ok("the confirmation says nothing is deleted", confirmSource.includes("Nothing is deleted.") && confirmSource.includes("Switch off ${row.name}"));

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("4. Add staff: a setup link, never a password");

    const addHtml = html(await resolveAsync(await ADD.default()));
    keep("add-staff-admin", addHtml);
    ok("the Add staff page has the reference's fields", ["Full name", "Email address", "Job title", "Phone", "Role", "Status", "Department", "Reporting manager"].every((l) => addHtml.includes(`>${l}<`)));
    ok("  Role says what it decides, and Admin is not on offer", addHtml.includes("Decides what they can do.") && !addHtml.includes('<option value="ADMIN"'));
    ok("  and there is no password field, only the note about the setup email", !/type="password"/.test(addHtml) && addHtml.includes("No password to set."));
    ok("  ending in Create account", addHtml.includes(">Create account<"));
    actorId = auditor.id;
    const addReviewer = html(await resolveAsync(await ADD.default()));
    keep("add-staff-reviewer", addReviewer);
    ok("a reviewer can't add staff", addReviewer.includes("You can&#x27;t add staff.") && !addReviewer.includes("Create account"));
    const refusedCreate = await USER.createUser({ name: `${TAG} Nope`, email: `nope${MAIL}`, role: "SALES" });
    ok("  and the action refuses them too", !refusedCreate.ok);

    actorId = admin.id;
    const sentBefore = mail.length;
    const made = await USER.createUser({
      name: `${TAG} Devika`,
      email: `devika${MAIL}`,
      role: "SALES",
      departmentId: "",
      jobTitle: "Zz Engineer",
      phone: "+91 90000 00002",
      active: true,
    });
    ok("Create account makes the account", made.ok, made.ok ? "" : made.error);
    if (made.ok) {
      const row = await db.user.findUnique({
        where: { id: made.data.id },
        select: { active: true, phone: true, mustChangePassword: true, employeeProfile: { select: { designation: true } } },
      });
      ok("  emails a setup link to them", made.data.emailed === true && mail.length === sentBefore + 1 && mail.at(-1)?.to === `devika${MAIL}` && /reset-password\?t=[^\s]+setup=1/.test(mail.at(-1)?.text ?? ""));
      ok("  with no password: the account is waiting for them to choose one", (await db.user.count({ where: { id: made.data.id, ...AWAITING_SETUP } })) === 1 && row?.mustChangePassword === false);
      ok("  job title on the HR record, phone on the account", row?.employeeProfile?.designation === "Zz Engineer" && row?.phone === "+91 90000 00002" && row?.active === true);
    }
    const offMade = await USER.createUser({ name: `${TAG} Esha`, email: `esha${MAIL}`, role: "SALES", active: false });
    ok("Status: Switched off makes the account switched off, and emails nobody", offMade.ok && offMade.data.startsSwitchedOff === true && offMade.data.emailed === false && mail.length === sentBefore + 1);
    if (offMade.ok) {
      ok("  so it takes no seat until switched on", (await db.user.findUnique({ where: { id: offMade.data.id }, select: { active: true } }))?.active === false);
      const early = await USER.resendSetupEmail(offMade.data.id);
      ok("  and its setup email waits until then", !early.ok);
    }
    const legacy = await USER.createUser({ name: `${TAG} Farhan`, email: `farhan${MAIL}`, role: "SALES", departmentId: "" });
    ok("an older caller's input (no job title, phone or status) works as before", legacy.ok && legacy.data.emailed === true && !("startsSwitchedOff" in legacy.data));
    const twice = await USER.createUser({ name: `${TAG} Devika again`, email: `DEVIKA${MAIL}`, role: "SALES" });
    ok("the same email twice is refused", !twice.ok && /already exists/.test(twice.error));

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("5. Saving a role writes exactly what was ticked");

    const createdRole = await ROLE.createRole({ name: `${TAG} Dialog Role`, description: "Probe" });
    ok("New role makes a role", createdRole.ok, createdRole.ok ? "" : createdRole.error);
    if (!createdRole.ok) return;
    const DIALOG = createdRole.data.key;
    const heldBy = async (role: string) => {
      const held: string[] = [];
      // Its permissions: the sections every role sees until unticked are no capability of its own.
      for (const def of PERMISSIONS) if (!def.everyone && (await rolePermits(role, def.key))) held.push(def.key);
      return held.sort();
    };
    const same = (x: string[], y: string[]) => x.length === y.length && [...x].sort().every((k, i) => k === [...y].sort()[i]);

    // "View all field visits" is how a permission's reach widens here: its own box, saved like any other.
    const first = ["tickets.create", "leads.view", "visits.view", "visits.viewAll"];
    const savedFirst = await PERM.setRolePermissions(DIALOG, first.map((key) => ({ key, allowed: true })));
    ok("Save role writes the ticked boxes", savedFirst.ok && savedFirst.data.changed === 4, savedFirst.ok ? savedFirst.data : savedFirst.error);
    ok("  and the role then grants exactly those — the wider-reach box included", same(await heldBy(DIALOG), first), await heldBy(DIALOG));
    const matrix = await PERM.getPermissionMatrix();
    ok("  which is what the dialog opens with next time", same(matrix.filter((p) => p.roles[DIALOG] && !p.key.startsWith("section.")).map((p) => p.key), first));

    const second = ["leads.view", "visits.view", "contacts.view"];
    const diff = PERMISSIONS.filter((p) => first.includes(p.key) !== second.includes(p.key)).map((p) => ({ key: p.key, allowed: second.includes(p.key) }));
    const savedSecond = await PERM.setRolePermissions(DIALOG, diff);
    ok("editing it writes only the boxes that changed", savedSecond.ok && savedSecond.data.changed === 3, savedSecond.ok ? savedSecond.data : savedSecond.error);
    ok("  and it grants exactly the new set", same(await heldBy(DIALOG), second), await heldBy(DIALOG));
    ok("  every change recorded, as one click in the matrix is", (await db.permissionChange.count({ where: { subjectRole: DIALOG } })) === 1 + 4 + 3);

    const salesRowBefore = await db.rolePermission.findUnique({ where: { role_permission: { role: "SALES", permission: "tickets.create" } } });
    if (salesRowBefore === null) {
      const untouched = await PERM.setRolePermissions("SALES", [{ key: "tickets.create", allowed: true }]);
      ok("a box left as it was keeps following the registry default — nothing is written", untouched.ok && untouched.data.changed === 0 && (await db.rolePermission.findUnique({ where: { role_permission: { role: "SALES", permission: "tickets.create" } } })) === null);
    } else {
      console.log("  (skipped: SALES already stores an answer for Create tickets on this database)");
    }

    actorId = manager.id;
    const partial = await PERM.setRolePermissions(DIALOG, [
      { key: "tickets.create", allowed: true },
      { key: "payroll.manage", allowed: true },
    ]);
    ok("one box the saver can't grant refuses the whole save", !partial.ok && /don't hold it yourself/.test(partial.error), partial.ok ? "saved" : partial.error);
    ok("  and the boxes before it were not written", !(await rolePermits(DIALOG, "tickets.create")));
    const unknown = await PERM.setRolePermissions(DIALOG, [{ key: "nothing.real", allowed: true }]);
    ok("an unknown permission is refused", !unknown.ok);
    const adminRole = await PERM.setRolePermissions("ADMIN", [{ key: "tickets.create", allowed: false }]);
    ok("only a super admin changes what Admin holds", !adminRole.ok && /super admin/.test(adminRole.error));
    const lockout = await PERM.setRolePermissions(MANAGER, [{ key: "permissions.manage", allowed: false }]);
    ok("nobody takes Change roles and permissions away from their own role", !lockout.ok && /your own role/.test(lockout.error), lockout.ok ? "saved" : lockout.error);
    const lockoutOne = await PERM.setRolePermission(MANAGER, "permissions.manage", false);
    const lockoutReset = await PERM.resetRolePermission(MANAGER, "permissions.manage");
    ok("  nor through the matrix's switch or its reset arrow", !lockoutOne.ok && !lockoutReset.ok);
    ok("  so they still hold it", await can(manager.id, "permissions.manage"));
    const otherBox = await PERM.setRolePermissions(MANAGER, [{ key: "tickets.create", allowed: false }]);
    ok("  while any other box on their own role is theirs to change", otherBox.ok);
    await db.userPermission.create({ data: { userId: manager.id, permission: "permissions.view", allowed: true, reason: `${TAG} personal grant` } });
    const personally = await PERM.setRolePermissions(MANAGER, [{ key: "permissions.view", allowed: false }]);
    ok("  and somebody who also holds it personally may take it off the role", personally.ok && (await can(manager.id, "permissions.view")));

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("6. A read-only reviewer can't save");

    actorId = auditor.id;
    const heldBefore = await heldBy(DIALOG);
    const reviewerSave = await PERM.setRolePermissions(DIALOG, [{ key: "leads.view", allowed: false }]);
    const reviewerRename = await ROLE.updateRole({ key: DIALOG, name: `${TAG} Renamed` });
    const reviewerCreate = await ROLE.createRole({ name: `${TAG} Sneaky` });
    ok("the server refuses a reviewer's save, rename and new role", !reviewerSave.ok && !reviewerRename.ok && !reviewerCreate.ok);
    ok("  and nothing changed", same(await heldBy(DIALOG), heldBefore));

    // The role's permissions are the Module Matrix opened on it (src/app/(dashboard)/settings/access/modules/page.tsx
    // → src/components/access-control/modules/module-matrix.tsx): every module, the first one open, and under it a
    // switch for what applies and Default / Allow / Deny for what is stored — with the server's reasons on a row
    // that can't be changed. Drawn here by the real page, for whoever is looking.
    const firstModule = ACCESS_MODULES[0]!;
    // The rows the matrix draws for a module: its permissions, less the document keys (Document Permissions) and
    // the ones that only say how far a record reaches (Data Scope).
    const crmDefs = permissionsOfModule(firstModule.key).filter((d) => !isDocKey(d.key) && !REACH_KEYS.has(d.key) && !FOLDED_KEYS.has(d.key));
    const esc = (t: string) => t.replaceAll("&", "&amp;").replaceAll("'", "&#x27;").replaceAll('"', "&quot;");
    /** The Allowed switch of the row with this label — its tag, or "" when there is none. */
    const pill = (markup: string, label: string) => (markup.match(/<button[^>]*role="switch"[^>]*>/g) ?? []).find((tag) => tag.includes(`aria-label="${esc(label)}: allowed"`) || tag.includes(`aria-label="${esc(label)}: not allowed"`)) ?? "";
    /** The stored answer of the row with this label: its Default / Allow / Deny group. */
    const answers = (markup: string, label: string) => {
      const at = markup.indexOf(`aria-label="${esc(label)}: stored answer"`);
      return at < 0 ? "" : markup.slice(at, markup.indexOf("</span>", at));
    };
    const grid = await roleAccessLevels(DIALOG);

    const asReviewer = await renderModules({ role: DIALOG });
    keep("role-modules-reviewer", asReviewer);
    const switches = count(asReviewer, /role="switch"/g);
    ok(`the reviewer sees the role's first module, ${firstModule.label}: an Allowed switch for each of its permissions`, crmDefs.length > 0 && crmDefs.every((d) => pill(asReviewer, d.label) !== ""), `${switches} switches, ${crmDefs.length} rows — missing: ${crmDefs.filter((d) => pill(asReviewer, d.label) === "").map((d) => d.key).join(", ")}`);
    ok("  every one disabled, saying why", crmDefs.every((d) => /disabled=""/.test(pill(asReviewer, d.label)) && pill(asReviewer, d.label).includes("You can review roles but not change them.")) && asReviewer.includes("You can review roles but not change them. Everything here is read-only."));
    ok("    and so is every stored answer", crmDefs.every((d) => count(answers(asReviewer, d.label), /disabled=""/g) === 3));
    ok("  and every module listed to open", ACCESS_MODULES.every((m) => asReviewer.includes(`>${esc(m.label)}</span>`)) && count(asReviewer, /aria-expanded="true"/g) === 1 && asReviewer.includes(">Sales<") && asReviewer.includes(">Settings<"), ACCESS_MODULES.filter((m) => !asReviewer.includes(`>${esc(m.label)}</span>`)).map((m) => m.label).join(", "));
    ok("  with the rest of the role's access beside it", [acPath.scope({ role: DIALOG }), acPath.fields({ role: DIALOG }), acPath.documents({ role: DIALOG }), acPath.importExport(DIALOG), acPath.audit({ role: DIALOG })].every((href) => asReviewer.includes(`href="${href.replaceAll("&", "&amp;")}"`)));

    actorId = admin.id;
    const adminHolds = new Set<string>((await permissionsFor(admin.id)).map(String));
    const asAdmin = await renderModules({ role: DIALOG });
    keep("role-modules-admin", asAdmin);
    ok("an admin's switches are on exactly as the role holds, in this module", crmDefs.every((d) => pill(asAdmin, d.label).includes('aria-checked="true"') === second.includes(d.key)), crmDefs.filter((d) => pill(asAdmin, d.label).includes('aria-checked="true"') !== second.includes(d.key)).map((d) => d.key).join(", "));
    const storedWord = (key: string) => (second.includes(key) ? "Allow" : first.includes(key) ? "Deny" : "Default");
    ok("  each stored answer shown: Allow where it was ticked, Deny where it was unticked, Default where never touched", crmDefs.every((d) => new RegExp(`aria-checked="true"[^>]*>${storedWord(d.key)}<`).test(answers(asAdmin, d.label))) && crmDefs.some((d) => storedWord(d.key) === "Allow") && crmDefs.some((d) => storedWord(d.key) === "Default"), crmDefs.filter((d) => !new RegExp(`aria-checked="true"[^>]*>${storedWord(d.key)}<`).test(answers(asAdmin, d.label))).map((d) => `${d.key} should be ${storedWord(d.key)}`).join(", "));
    // Open to change, but for what only a super admin grants — and what this admin doesn't hold on this database.
    const lockedForAdmin = (d: (typeof crmDefs)[number]) => d.superAdminOnly === true || !adminHolds.has(d.key);
    ok("  and open to change, but for what only a super admin grants", crmDefs.some((d) => !lockedForAdmin(d)) && crmDefs.every((d) => /disabled=""/.test(pill(asAdmin, d.label)) === lockedForAdmin(d)), crmDefs.filter((d) => /disabled=""/.test(pill(asAdmin, d.label)) !== lockedForAdmin(d)).map((d) => d.key).join(", "));
    ok("    said on the row", crmDefs.filter((d) => d.superAdminOnly).every((d) => pill(asAdmin, d.label).includes("Only a super admin can grant this permission.")));
    const inMenu = (asAdmin.match(/<button[^>]*role="switch"[^>]*>/g) ?? []).find((tag) => tag.includes(`aria-label="${esc(firstModule.label)} in the menu"`)) ?? "";
    ok(`  with ${firstModule.label}'s place in the menu as a switch of its own`, inMenu !== "" && !/disabled=""/.test(inMenu) && asAdmin.includes(">In menu<"));
    ok("  and Save changes, with nothing staged yet", /<button[^>]*disabled=""[^>]*>(?:<svg[\s\S]*?<\/svg>)?Save changes<\/button>/.test(asAdmin) && !asAdmin.includes("staged change"));
    const adminRoleScreen = await renderModules({ role: "ADMIN" });
    ok("Admin's own role is locked for a non-super admin", crmDefs.every((d) => pill(adminRoleScreen, d.label).includes("Only a super admin can change what admins can do.") && /disabled=""/.test(pill(adminRoleScreen, d.label))) && adminRoleScreen.includes("Only a super admin can change what admins can do. Everything here is read-only."));
    // Nobody hands out a key they don't hold: the manager fixture holds a handful.
    actorId = manager.id;
    const managerHolds = new Set<string>((await permissionsFor(manager.id)).map(String));
    const asManager = await renderModules({ role: DIALOG });
    const notHeld = crmDefs.filter((d) => !d.superAdminOnly && !d.adminOnly && !managerHolds.has(d.key));
    const heldByManager = crmDefs.filter((d) => !d.superAdminOnly && !d.adminOnly && managerHolds.has(d.key));
    ok("a manager who holds a few keys may change those", heldByManager.length > 0 && heldByManager.every((d) => pill(asManager, d.label) !== "" && !/disabled=""/.test(pill(asManager, d.label))), heldByManager.map((d) => d.key).join(", ") || "holds none of this module's keys");
    ok("  and none they don't hold themselves, each row saying so", notHeld.length > 0 && notHeld.every((d) => /disabled=""/.test(pill(asManager, d.label)) && pill(asManager, d.label).includes(esc("You don't hold this yourself, so you can't change it for a role."))), notHeld.filter((d) => !/disabled=""/.test(pill(asManager, d.label))).map((d) => d.key).join(", "));

    // Record Access is Data Scope (src/app/(dashboard)/settings/access/scope/page.tsx → scope/data-scope.tsx).
    actorId = admin.id;
    const recordsHtml = await renderScope({ role: DIALOG });
    keep("role-records", recordsHtml);
    const cells = (grid?.rows ?? []).reduce((n, r) => n + r.actions.length, 0);
    const reachChips = (markup: string) => count(markup, /<button[^>]*aria-label="[^"]*, (?:View|Edit|Delete|Assign): [^"]*"/g);
    ok("Data Scope is the whole grid: a choice per record and action", (grid?.rows.length ?? 0) > 0 && reachChips(recordsHtml) === cells && (grid?.rows ?? []).every((r) => recordsHtml.includes(`>${esc(r.label)}</span>`)), `${reachChips(recordsHtml)} chips for ${cells} cells`);
    ok("  with Save changes for an admin", recordsHtml.includes("Save changes") && recordsHtml.includes("Save scope"));
    actorId = auditor.id;
    const recordsReviewer = await renderScope({ role: DIALOG });
    const reviewerWhy = (await roleAccessLevels(DIALOG))?.why ?? "";
    ok("  and read-only for a reviewer, saying why", /review/.test(reviewerWhy) && text(recordsReviewer).includes(reviewerWhy) && !recordsReviewer.includes("Save changes") && !recordsReviewer.includes("Save scope") && reachChips(recordsReviewer) === cells, reviewerWhy);

    // The matrix saves a role through `saveRoleAnswers` (src/actions/access-control-modules.ts) — Default, Allow
    // and Deny in one step. It is held to every rule the single actions above are.
    actorId = admin.id;
    const matrixRole = await ROLE.createRole({ name: `${TAG} Matrix Role` });
    ok("a role to save through the matrix", matrixRole.ok, matrixRole.ok ? "" : matrixRole.error);
    if (matrixRole.ok) {
      const MATRIX = matrixRole.data.key;
      const stored = async (key: string) => (await db.rolePermission.findUnique({ where: { role_permission: { role: MATRIX, permission: key } } }))?.allowed ?? null;
      const staged = await saveRoleAnswers(MATRIX, [
        { key: "leads.view", state: "allow" },
        { key: "tickets.create", state: "deny" },
      ]);
      ok("Save changes writes each staged answer: an Allow and a Deny", staged.ok && staged.data.changed === 2 && (await stored("leads.view")) === true && (await stored("tickets.create")) === false, staged.ok ? staged.data : staged.error);
      const same2 = await saveRoleAnswers(MATRIX, [{ key: "leads.view", state: "allow" }]);
      ok("  an answer already stored as asked writes nothing", same2.ok && same2.data.changed === 0);
      const back = await saveRoleAnswers(MATRIX, [{ key: "tickets.create", state: "default" }]);
      ok("  Default removes the stored answer, recorded as a reset", back.ok && back.data.changed === 1 && (await stored("tickets.create")) === null && (await db.permissionChange.count({ where: { subjectRole: MATRIX, permission: "tickets.create", changeKind: "RESET_TO_DEFAULT" } })) === 1);
      ok("  every change in the role's history", (await db.permissionChange.count({ where: { subjectRole: MATRIX, permission: { in: ["leads.view", "tickets.create"] } } })) === 3);
      actorId = manager.id;
      const beyond = await saveRoleAnswers(MATRIX, [
        { key: "visits.view", state: "allow" },
        { key: "payroll.manage", state: "allow" },
      ]);
      ok("one answer the saver can't give refuses the whole save", !beyond.ok && /don't hold it yourself/.test(beyond.error) && (await stored("visits.view")) === null, beyond.ok ? "saved" : beyond.error);
      const nonsense = await saveRoleAnswers(MATRIX, [{ key: "nothing.real", state: "allow" }]);
      const notAState = await saveRoleAnswers(MATRIX, [{ key: "leads.view", state: "maybe" as never }]);
      ok("  an unknown permission, or an answer that isn't one, is refused", !nonsense.ok && !notAState.ok);
      const adminAnswers = await saveRoleAnswers("ADMIN", [{ key: "tickets.create", state: "deny" }]);
      ok("  only a super admin changes what Admin holds", !adminAnswers.ok && /super admin/.test(adminAnswers.error));
      const ownWayIn = await saveRoleAnswers(MANAGER, [{ key: "permissions.manage", state: "deny" }]);
      const ownWayInReset = await saveRoleAnswers(MANAGER, [{ key: "permissions.manage", state: "default" }]);
      ok("  nobody takes Change roles and permissions away from their own role — by Deny, or by putting it back to Default", !ownWayIn.ok && /your own role/.test(ownWayIn.error) && !ownWayInReset.ok && (await can(manager.id, "permissions.manage")), ownWayIn.ok ? "saved" : ownWayIn.error);
      actorId = auditor.id;
      const reviewerAnswers = await saveRoleAnswers(MATRIX, [{ key: "leads.view", state: "deny" }]);
      ok("  and a reviewer's save is refused", !reviewerAnswers.ok && (await stored("leads.view")) === true);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("7. Roles & Permissions");

    actorId = admin.id;
    const rolesHtml = await renderRoles();
    keep("roles-admin", rolesHtml);
    ok("the page is Roles & Permissions, with Create new role", rolesHtml.includes("Roles &amp; Permissions") && rolesHtml.includes("System and custom roles. Open a role to edit its module, field and data-scope permissions.") && rolesHtml.includes(`href="${acPath.wizard()}"`) && rolesHtml.includes("Create new role"), rolesHtml.slice(0, 200));
    const roleCount = await db.role.count();
    ok("the roles are listed, searchable, filtered and sorted", rolesHtml.includes('placeholder="Search roles"') && rolesHtml.includes('aria-label="Sort roles"') && [">All<", ">System<", ">Custom<"].every((w) => rolesHtml.includes(w)) && text(rolesHtml).includes(`${roleCount} of ${roleCount} roles`), text(rolesHtml).match(/\d+ of \d+ roles/)?.[0] ?? "no count");
    const roleRows = rolesHtml.slice(rolesHtml.indexOf("<tbody")).split("<tr").slice(1);
    ok("  the super admin first, marked System, and not to be edited", (roleRows[0] ?? "").includes("Super Admin") && (roleRows[0] ?? "").includes(">System<") && (roleRows[0] ?? "").includes("Cannot be edited") && !(roleRows[0] ?? "").includes('role="menu"'));
    const roleRow = (key: string) => roleRows.find((chunk) => chunk.includes(`href="${acPath.modules({ role: key })}"`)) ?? "";
    /** A row's menu item by its words: the opening tag, or "" when it isn't offered. */
    const item = (row: string, words: string) => new RegExp(`(<button[^>]*role="menuitem"[^>]*>)(?:(?!</button>)[\\s\\S])*?${words}</button>`).exec(row)?.[1] ?? "";
    const salesRow = roleRow("SALES");
    const salesActive = await db.user.count({ where: { role: "SALES", active: true, isSuperAdmin: false } });
    ok("  Sales with its people counted, opening on its permissions", salesRow.includes(`href="${rolePath("SALES")}"`) && text(salesRow).includes(`${salesActive} ${salesActive === 1 ? "person" : "people"}`) && salesRow.includes(`href="${acPath.employees()}?role=SALES"`) && salesRow.includes(">System<"), text(salesRow).slice(0, 200));
    const dialogRow = roleRow(DIALOG);
    ok("  and a custom role", dialogRow.includes(">Custom<") && dialogRow.includes(`role=${encodeURIComponent(DIALOG)}`) && text(dialogRow).includes("No one"));
    ok(
      "a role's row leads to everything the open role had tabs for: its modules, its records, its fields, its people",
      [acPath.modules({ role: "SALES" }), acPath.fields({ role: "SALES" })].every((href) => salesRow.includes(`href="${href}"`)) && ["Module permissions", "Field permissions", "Data scope", "Import &amp; export", `View employees \\(${salesActive}\\)`].every((w) => item(salesRow, w) !== ""),
      ["Module permissions", "Field permissions", "Data scope", "Import &amp; export", `View employees \\(${salesActive}\\)`].filter((w) => item(salesRow, w) === "").join(", "),
    );
    const builtIn = "One of the roles this application was built around";
    ok(
      "  its menu: Edit role, Rename, Duplicate — and Disable and Delete off on a built-in role, saying why",
      ["Edit role", "Rename", "Duplicate"].every((w) => item(salesRow, w) !== "" && !/disabled=""/.test(item(salesRow, w))) &&
        /disabled=""/.test(item(salesRow, "Delete role")) && item(salesRow, "Delete role").includes(`title="${builtIn} — it can&#x27;t be deleted."`) &&
        /disabled=""/.test(item(salesRow, "Disable role")) && item(salesRow, "Disable role").includes(`title="${builtIn} — it stays on."`),
      `${item(salesRow, "Delete role")} ${item(salesRow, "Disable role")}`,
    );
    ok("a custom role can be deleted, and disabled", item(dialogRow, "Delete role") !== "" && !/disabled=""/.test(item(dialogRow, "Delete role")) && item(dialogRow, "Disable role") !== "" && !/disabled=""/.test(item(dialogRow, "Disable role")), `${item(dialogRow, "Delete role")} ${item(dialogRow, "Disable role")}`);
    const adminRow = roleRow("ADMIN");
    ok("  Admin is marked locked for an admin who isn't the super admin, its presets off", adminRow.includes("Only a super admin can change what admins can do") && (item(adminRow, "Apply a preset") === "" || /disabled=""/.test(item(adminRow, "Apply a preset"))) && !rolesHtml.includes("Export to Excel"));

    // The open role — once tabs beside the list — is the Module Matrix on it.
    const salesMatrix = await renderModules({ role: "SALES" });
    keep("roles-sales-admin", salesMatrix);
    ok("the open role: its Module Matrix, with Data scope, Field permissions, Document permissions, Import & export, its audit log and Compare beside it", ["Module Permission Matrix", "Data scope", "Field permissions", "Document permissions", "Import & export", "This role's audit log", "Compare with another role"].every((t) => text(salesMatrix).includes(t)) && /<option value="SALES" selected="">Sales<\/option>/.test(salesMatrix), text(salesMatrix).slice(0, 200));
    // The matrix counts a role's people as the roles list does — those who hold it and can sign in, the super admin
    // apart — because that is who a change reaches ("N people hold this role; the changes apply to them…").
    ok("  its people counted as the roles list counts them", text(salesMatrix).includes(`System role · ${salesActive} ${salesActive === 1 ? "person" : "people"}`), text(salesMatrix).match(/System role · \d+ (?:person|people)/)?.[0] ?? "no count");
    const salesPeople = await renderEmployees({ role: "SALES" });
    ok("  and its people on Employee Permissions, narrowed to the role", salesPeople.includes("Employee-Specific Permissions") && /<option value="SALES" selected="">/.test(salesPeople) && salesPeople.includes(`${TAG} Akash`), salesPeople.slice(0, 200));
    // Permission preview — what the role reaches, module by module, or one of its people — is the Simulator.
    const preview = await draw(() => SIMULATOR.default({ searchParams: Promise.resolve({ role: "SALES" }) }));
    keep("roles-sales-simulator", preview);
    ok("  and the permission preview: the Simulator, on the role or on one of its people", preview.includes("Permission Preview / Simulator") && text(preview).includes("Sales") && !preview.startsWith("threw:") && !(await draw(() => SIMULATOR.default({ searchParams: Promise.resolve({ user: akash.id }) }))).startsWith("threw:"), preview.slice(0, 200));
    // Its Summary's history is the role's audit log.
    const dialogLog = await draw(() => AUDIT.default({ searchParams: Promise.resolve({ role: DIALOG }) }));
    keep("roles-custom-history", dialogLog);
    const dialogChanges = await db.permissionChange.count({ where: { subjectRole: DIALOG } });
    ok("a custom role keeps its history: every change, in its audit log", dialogChanges >= 8 && text(dialogLog).includes(`${dialogChanges} entries`) && count(dialogLog, /<tr/g) > dialogChanges && asAdmin.includes(`href="${acPath.audit({ role: DIALOG })}"`), text(dialogLog).match(/\d+ entr(?:y|ies)/)?.[0] ?? dialogLog.slice(0, 200));

    // The old permission matrix page: its matrix is the Module Matrix, one role at a time; its two access-review
    // sections moved to Employee Permissions.
    const everybodyHtml = await renderEmployees();
    keep("employees-admin", everybodyHtml);
    ok("the permission matrix, a role at a time, with its search", salesMatrix.includes('aria-label="Find a module or permission"') && salesMatrix.includes('aria-label="Role"'));
    ok("  with the exceptions to roles and who holds a permission on Employee Permissions", everybodyHtml.includes('id="exceptions"') && everybodyHtml.includes("Every permission granted or denied to one person") && everybodyHtml.includes('id="who-can"') && everybodyHtml.includes("Who holds a permission"));
    const retiredRole = (sp: Record<string, string>) => landsOn(() => RETIRED_ROLES.default({ searchParams: Promise.resolve(sp) }));
    ok("a link to the old Roles & Permissions page lands on the roles list", (await retiredRole({})) === acPath.roles(), await retiredRole({}));
    ok("  one to a role on its Module Matrix — Module Access, Summary and Business Rules alike", (await retiredRole({ role: "SALES" })) === acPath.modules({ role: "SALES" }) && (await retiredRole({ role: "SALES", tab: "summary" })) === acPath.modules({ role: "SALES" }) && (await retiredRole({ role: "SALES", tab: "rules" })) === acPath.modules({ role: "SALES" }));
    ok("  its Record Access on Data Scope, its Field Permissions on Field Permissions, its Users on its people", (await retiredRole({ role: "SALES", tab: "records" })) === acPath.scope({ role: "SALES" }) && (await retiredRole({ role: "SALES", tab: "fields" })) === acPath.fields({ role: "SALES" }) && (await retiredRole({ role: "SALES", tab: "users" })) === `${acPath.employees()}?role=SALES`);
    ok("  the old permission matrix on the Module Matrix", (await landsOn(() => RETIRED_MATRIX.default())) === acPath.modules());
    ok("  and the old unmasking logs on Unmasking Activity", (await landsOn(() => RETIRED_LOGS.default({ searchParams: Promise.resolve({}) }))) === `${acPath.audit()}?category=pii`);

    actorId = auditor.id;
    const rolesReviewer = await renderRoles();
    keep("roles-reviewer", rolesReviewer);
    const reviewerSales = rolesReviewer.slice(rolesReviewer.indexOf("<tbody")).split("<tr").find((chunk) => chunk.includes(`href="${acPath.modules({ role: "SALES" })}"`)) ?? "";
    ok(
      "a reviewer can open every role to read it, and change none",
      rolesReviewer.includes(`href="${rolePath("SALES")}"`) && !rolesReviewer.includes("Create new role") && ["Edit role", "Rename", "Duplicate", "Delete role", "Disable role", "Apply a preset"].every((w) => item(reviewerSales, w) === "") && item(reviewerSales, "Data scope") !== "" && rolesReviewer.includes("You can review roles but not change them."),
      ["Edit role", "Rename", "Duplicate", "Delete role", "Disable role", "Apply a preset"].filter((w) => item(reviewerSales, w) !== "").join(", "),
    );
    const reviewerWizard = await draw(() => WIZARD.default({ searchParams: Promise.resolve({}) }));
    ok("  nor create one: the wizard tells them so", !reviewerWizard.startsWith("threw:") && !reviewerWizard.includes("<input") && /review/i.test(text(reviewerWizard)), text(reviewerWizard).slice(0, 200));

    // ─────────────────────────────────────────────────────────────────────────────────────────────
    section("8. The door");

    // Every screen of the area asks `permissions.view` for itself — as the pages these replaced did. The layout asks
    // too, but a layout isn't run again when somebody moves between its pages.
    actorId = akash.id;
    ok("a salesperson holds no way into access review", !(await can(akash.id, "permissions.view")));
    const none = Promise.resolve({});
    const screens: [string, () => unknown][] = [
      ["the layout", () => AC_LAYOUT.default({ children: null })],
      ["Overview", () => OVERVIEW.default({ searchParams: none })],
      ["Roles & Permissions", () => ROLES.default()],
      ["the role wizard", () => WIZARD.default({ searchParams: none })],
      ["Module Matrix", () => MODULES.default({ searchParams: none })],
      ["Field Permissions", () => FIELDS.default({ searchParams: none })],
      ["Document Permissions", () => DOCUMENTS.default({ searchParams: none })],
      ["Employee Permissions", () => EMPLOYEES.default({ searchParams: none })],
      ["an employee's profile", () => EMPLOYEE.default({ params: Promise.resolve({ id: bina.id }), searchParams: none })],
      ["Data Scope", () => SCOPE.default({ searchParams: none })],
      ["Sensitive Data", () => SENSITIVE.default()],
      ["Global PII Masking", () => MASKING.default()],
      ["Unmasking Limits", () => LIMITS.default({ searchParams: none })],
      ["Import & Export", () => IMPORT_EXPORT.default({ searchParams: none })],
      ["Audit Logs", () => AUDIT.default({ searchParams: none })],
      ["Unmasking Activity", () => AUDIT.default({ searchParams: Promise.resolve({ category: "pii" }) })],
      ["Security Settings", () => SECURITY.default()],
      ["Permission Simulator", () => SIMULATOR.default({ searchParams: none })],
      ["Compare", () => COMPARE.default({ searchParams: none })],
    ];
    for (const [name, page] of screens) {
      const got = await draw(page);
      ok(`  ${name} is not found for them`, got === "threw: NEXT_NOT_FOUND", got.startsWith("threw:") ? got : `it drew ${got.length} characters: ${text(got).slice(0, 120)}`);
    }
    ok("  nor is Users", (await draw(() => USERS.default({ searchParams: Promise.resolve({}) }))) === "threw: NEXT_NOT_FOUND");
    ok("every screen in the area's menu is one of those", [...AC_NAV, ...AC_TOOLS].flatMap((i) => [i, ...(i.children ?? [])]).every((i) => fs.existsSync(path.join(__dirname, "../src/app/(dashboard)", i.href.split("?")[0]!, "page.tsx"))) && [...AC_NAV, ...AC_TOOLS].flatMap((i) => [i, ...(i.children ?? [])]).length <= screens.length);
    actorId = auditor.id;
    const reviewerDoor = await Promise.all(screens.map(async ([name, page]) => [name, await draw(page)] as const));
    ok("a reviewer, who holds it and nothing more, opens every one", reviewerDoor.every(([, got]) => !got.startsWith("threw:")), reviewerDoor.filter(([, got]) => got.startsWith("threw:")).map(([name, got]) => `${name}: ${got}`).join("; "));
    ok("  and is offered no way to change anything from the Overview", !(reviewerDoor.find(([name]) => name === "Overview")?.[1] ?? "").includes("Create role") && !(reviewerDoor.find(([name]) => name === "Overview")?.[1] ?? "").includes("Add employee"));

    section("9. The names");
    const area = SETTINGS_ITEMS.find((i) => i.href === "/settings/access");
    ok("Settings › Staff lists Access Control, Users and Departments", area?.label === "Access Control" && area.permission === "permissions.view" && SETTINGS_ITEMS.find((i) => i.key === "users")?.label === "Users" && SETTINGS_ITEMS.some((i) => i.href === "/settings/departments"));
    ok("  and nothing points at a retired page", !SETTINGS_ITEMS.some((i) => i.href.startsWith("/settings/roles") || i.href.startsWith("/settings/unmasking-logs") || i.label === "Roles & Permissions" || i.label === "Unmasking logs"));
    ok("  Roles & Permissions is a screen of the area, in its own menu", AC_NAV.some((i) => i.label === "Roles & Permissions" && i.href === acPath.roles()) && AC_NAV.some((i) => i.label === "Employee Permissions" && i.href === acPath.employees()));
    const titleOf = (page: unknown) => (page as { metadata?: { title?: string } }).metadata?.title;
    ok("  and the browser tabs say so", titleOf(USERS) === "Users" && titleOf(ROLES) === "Roles & Permissions" && titleOf(OVERVIEW) === "Access Control" && titleOf(MODULES) === "Module Permission Matrix" && titleOf(EMPLOYEES) !== undefined, `${titleOf(USERS)} · ${titleOf(ROLES)} · ${titleOf(OVERVIEW)} · ${titleOf(MODULES)} · ${titleOf(EMPLOYEES)}`);
    // The menu's links are built in src/lib/navigation.ts; the sidebar only draws them.
    const sidebar = fs.readFileSync(path.join(__dirname, "../src/lib/navigation.ts"), "utf8");
    ok("  as does the sidebar", sidebar.includes('label: "Users"') && /href: "\/settings\/access", label: "Access Control"/.test(sidebar) && !sidebar.includes('label: "Roles & Permissions"') && !sidebar.includes('"/settings/roles"') && !sidebar.includes('label: "Staff & roles"'));
  } finally {
    actorId = "";
    mailer.setTestPlatformMailer(null);
    await cleanup(db);
    await db.$disconnect();
  }

  console.log(failures === 0 ? `\nUsers and Access Control: all ${passes} checks passed.\n` : `\n${failures} FAILED, ${passes} passed\n`);
  process.exit(failures === 0 ? 0 : 1);
}

/** Everything the fixtures made, found by their address and names — and by whose they are. */
async function cleanup(db: typeof import("../src/lib/db").db) {
  const users = await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } });
  const ids = users.map((u) => u.id);
  const roles = await db.role.findMany({ where: { key: { startsWith: TAG } }, select: { key: true } });
  const keys = roles.map((r) => r.key);
  const companies = await db.company.findMany({
    where: { OR: [{ name: { startsWith: TAG } }, { createdById: { in: ids } }] },
    select: { id: true },
  });
  const companyIds = companies.map((c) => c.id);
  await db.lead.deleteMany({ where: { OR: [{ companyId: { in: companyIds } }, { ownerUserId: { in: ids } }] } });
  await db.company.deleteMany({ where: { id: { in: companyIds } } });
  await db.permissionChange.deleteMany({
    where: { OR: [{ actorUserId: { in: ids } }, { subjectUserId: { in: ids } }, { subjectRole: { startsWith: TAG } }] },
  });
  await db.activityLog.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.passwordResetToken.deleteMany({ where: { userId: { in: ids } } });
  await db.signIn.deleteMany({ where: { userId: { in: ids } } });
  await db.employeeProfile.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.rolePermission.deleteMany({ where: { role: { in: keys } } });
  await db.role.deleteMany({ where: { key: { in: keys } } });
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
