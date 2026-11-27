import { notFound } from "next/navigation";
import { accessRoster, permissionCatalogue } from "@/actions/permission";
import { listPermissionExceptions } from "@/actions/access";
import { listUsers } from "@/actions/user";
import { currentUser } from "@/lib/session";
import { db } from "@/lib/db";
import { ExceptionsTable } from "@/components/settings/exceptions-table";
import { WhoCan } from "@/components/settings/who-can";
import { can } from "@/lib/authz/resolve";
import { inactiveRoleKeys, listRoles } from "@/lib/authz/role-registry";
import { staffFacts } from "@/lib/staff/roster";
import { staffStatus } from "@/lib/staff/status";
import { exceptionCountsByUser, sensitiveHeldByUser } from "@/lib/access-control/employees";
import { EmployeesDirectory, type EmployeeRow } from "@/components/access-control/employees/employees-directory";

export const metadata = { title: "Employee-Specific Permissions" };

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/**
 * Settings › Access Control › Employee Permissions: everybody who can sign in, or could — their role,
 * how much they hold, the exceptions made for them alone, and how much sensitive access that adds up to.
 *
 * `permissions.view` opens it. The roster and the resolver give every number; a role change takes
 * `users.manage` and `users.assignRole`, and several at once is for admins only, as on Users — the
 * actions check each again.
 */
export default async function EmployeesPage({ searchParams }: { searchParams: Promise<{ role?: string }> }) {
  const viewer = await currentUser();
  if (!viewer || !(await can(viewer.id, "permissions.view"))) notFound();
  const sp = await searchParams;

  const [roster, users, roles, switchedOff, counts, sensitive, mayEditUsers, mayAssignRole, viewAllActivity, viewSignIns, viewerRow, exceptions, catalogue, mayManage] = await Promise.all([
    accessRoster(),
    listUsers(),
    listRoles(),
    inactiveRoleKeys(),
    exceptionCountsByUser(),
    sensitiveHeldByUser(),
    can(viewer.id, "users.manage"),
    can(viewer.id, "users.assignRole"),
    // When somebody last signed in is in the activity log and the sign-in log; whoever may read either
    // sees it here, and nobody else does — as on Users.
    can(viewer.id, "activity.viewAll"),
    can(viewer.id, "access.viewSignIns"),
    db.user.findUnique({ where: { id: viewer.id }, select: { isSuperAdmin: true, role: true } }),
    listPermissionExceptions(),
    permissionCatalogue(),
    can(viewer.id, "permissions.manage"),
  ]);
  const showLastActive = viewAllActivity || viewSignIns;
  const viewerIsSuperAdmin = viewerRow?.isSuperAdmin ?? false;
  // Bulk changes are for admins only (owner, 31 Oct 2026) — `bulkUpdateUsers` refuses anybody else.
  const viewerIsAdmin = viewerIsSuperAdmin || viewerRow?.role === "ADMIN";

  const facts = await staffFacts(
    roster.map((r) => r.id),
    { leads: false, signIns: showLastActive },
  );
  const account = new Map(users.map((u) => [u.id, u]));
  const roleName = new Map(roles.map((r) => [r.key, r.name]));

  const rows: EmployeeRow[] = roster.map((r) => {
    const c = counts.get(r.id);
    const f = facts.get(r.id);
    const u = account.get(r.id);
    const kinds = c
      ? [
          c.permissions ? plural(c.permissions, "permission", "permissions") : null,
          c.levels ? plural(c.levels, "record level", "record levels") : null,
          c.fields ? plural(c.fields, "field", "fields") : null,
          c.limit ? "a daily unmasking limit of their own" : null,
          c.lapsed ? `${c.lapsed} lapsed` : null,
        ].filter(Boolean)
      : [];
    return {
      id: r.id,
      name: r.name,
      email: r.email,
      role: r.role,
      roleName: roleName.get(r.role) ?? r.role,
      isSuperAdmin: r.isSuperAdmin,
      isYou: r.id === viewer.id,
      status: staffStatus({ active: r.active, setupPending: r.setupPending }),
      department: r.department,
      departmentId: u?.departmentId ?? null,
      managerId: u?.managerId ?? null,
      jobTitle: f?.jobTitle ?? null,
      holds: r.holds,
      total: r.total,
      overrides: c ? c.permissions + c.levels + c.fields + c.limit : 0,
      temporary: c?.temporary ?? 0,
      lapsed: c?.lapsed ?? 0,
      endingSoon: c?.endingSoon ?? false,
      overridesTitle: kinds.join(" · "),
      sensitive: sensitive.get(r.id) ?? 0,
      lastActive: f?.lastSignInAt ? f.lastSignInAt.toISOString() : null,
    };
  });

  const choices = roles.map((r) => ({ key: r.key, name: r.name }));
  return (
    <div className="flex min-w-0 flex-col gap-8">
    <EmployeesDirectory
      rows={rows}
      initialRole={roles.some((r) => r.key === sp.role) ? sp.role! : "all"}
      roles={choices}
      assignableRoles={choices.filter((r) => !switchedOff.has(r.key))}
      showLastActive={showLastActive}
      canBulk={viewerIsAdmin && mayEditUsers && mayAssignRole}
      canChangeRole={mayEditUsers && mayAssignRole}
      viewerIsSuperAdmin={viewerIsSuperAdmin}
      mayAddUsers={mayEditUsers}
    />

      {/* The two access-review questions a list of people can't answer, kept from the old permission matrix page. */}
      <section id="exceptions" className="scroll-mt-20 space-y-3">
        <div>
          <h2 className="text-base font-bold tracking-[-0.01em] text-text">Exceptions to roles</h2>
          <p className="mt-1 max-w-3xl text-[13px] text-muted">
            Every permission granted or denied to one person rather than to their whole role. An exception nobody can explain is one nobody dares remove, and a
            temporary grant with no end date stops being temporary the day everyone forgets it.
          </p>
        </div>
        <ExceptionsTable result={exceptions} mayManage={mayManage} />
      </section>

      <section id="who-can" className="scroll-mt-20 space-y-3">
        <div>
          <h2 className="text-base font-bold tracking-[-0.01em] text-text">Who holds a permission</h2>
          <p className="mt-1 max-w-3xl text-[13px] text-muted">
            Pick a permission to see everybody who holds it and how they came by it — their role, an answer set on the role, a personal grant, or being an admin.
          </p>
        </div>
        <WhoCan catalogue={catalogue} />
      </section>
    </div>
  );
}
