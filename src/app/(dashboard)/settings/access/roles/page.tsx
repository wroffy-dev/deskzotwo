import { notFound } from "next/navigation";
import { listRolesForScreen } from "@/actions/role";
import { getPermissionMatrix } from "@/actions/permission";
import { currentUser } from "@/lib/session";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { ROLE_PRESETS } from "@/lib/authz/presets";
import { getPermissionDefinition } from "@/lib/permissions";
import { ACCESS_MODULES, isSectionKey, moduleOfPermission } from "@/lib/staff/access-modules";
import { RolesScreen } from "@/components/access-control/roles/roles-screen";
import type { RoleListRow } from "@/components/access-control/roles/types";

export const metadata = { title: "Roles & Permissions" };

/**
 * Settings › Access Control › Roles & Permissions: the roles as a table — who holds each, how much it
 * grants, when it last changed and whether it is on — with compare, and a menu per role.
 *
 * `permissions.view` opens it (the layout checked; checked again here because this page reads the
 * database itself); `permissions.manage` shows what changes a role, and every action checks that again.
 */
export default async function AccessControlRolesPage() {
  const viewer = await currentUser();
  if (!viewer || !(await can(viewer.id, "permissions.view"))) notFound();

  const [mayManage, viewerRow, roleRows, people, superAdmins, matrix, lastChange] = await Promise.all([
    can(viewer.id, "permissions.manage"),
    db.user.findUnique({ where: { id: viewer.id }, select: { isSuperAdmin: true } }),
    listRolesForScreen(),
    // Who holds each role and can sign in — the super admin counted on their own, not as an Admin.
    db.user.findMany({ where: { active: true, isSuperAdmin: false }, orderBy: { name: "asc" }, select: { id: true, name: true, role: true } }),
    db.user.count({ where: { isSuperAdmin: true, active: true } }),
    getPermissionMatrix(),
    // When each role was last changed: its newest row in the permission history.
    db.permissionChange.groupBy({ by: ["subjectRole"], where: { subjectType: "ROLE", subjectRole: { not: null } }, _max: { createdAt: true } }),
  ]);

  const newest = lastChange.flatMap((c) => (c.subjectRole && c._max.createdAt ? [{ subjectRole: c.subjectRole, createdAt: c._max.createdAt }] : []));
  const changedBy = newest.length
    ? await db.permissionChange.findMany({ where: { subjectType: "ROLE", OR: newest }, select: { subjectRole: true, createdAt: true, actor: { select: { name: true } } } })
    : [];
  const updated = new Map(changedBy.map((c) => [c.subjectRole ?? "", { at: c.createdAt.toISOString(), by: c.actor?.name ?? null }]));

  const holders = new Map<string, { id: string; name: string }[]>();
  for (const p of people) holders.set(p.role, [...(holders.get(p.role) ?? []), { id: p.id, name: p.name }]);

  // What a role grants, the menu sections apart: they decide the menu, not what can be done.
  const permissions = matrix.filter((p) => !isSectionKey(p.key));
  const moduleOf = new Map(
    permissions.map((p) => {
      const def = getPermissionDefinition(p.key);
      return [p.key, def ? moduleOfPermission(def) : "admin"] as const;
    }),
  );

  const roles: RoleListRow[] = (roleRows.ok ? roleRows.data : []).map((r) => {
    const held = permissions.filter((p) => p.roles[r.key]);
    const mine = holders.get(r.key) ?? [];
    return {
      key: r.key,
      name: r.name,
      description: r.description,
      isSystem: r.isSystem,
      active: r.active,
      people: mine.length,
      headcount: r.headcount,
      switchedOff: r.switchedOff,
      avatars: mine.slice(0, 3),
      permissions: held.length,
      modules: new Set(held.map((p) => moduleOf.get(p.key))).size,
      updatedAt: updated.get(r.key)?.at ?? null,
      updatedBy: updated.get(r.key)?.by ?? null,
      presets: ROLE_PRESETS.filter((p) => p.role === r.key).map((p) => ({ key: p.key, label: p.label, description: p.description })),
    };
  });

  return (
    <RolesScreen
      roles={roles}
      superAdmins={superAdmins}
      totals={{ permissions: permissions.length, modules: ACCESS_MODULES.length }}
      mayManage={mayManage}
      viewerIsSuperAdmin={viewerRow?.isSuperAdmin ?? false}
      labels={Object.fromEntries(matrix.map((p) => [p.key, p.label]))}
    />
  );
}
