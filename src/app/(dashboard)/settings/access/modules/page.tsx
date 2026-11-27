import { requireAccessViewer } from "@/lib/access-control/guard";
import { db } from "@/lib/db";
import { can, permissionsFor, resolveUserPermissions } from "@/lib/authz/resolve";
import { roleDefault, roleGrants } from "@/lib/authz/role-permission";
import { OWN_ACCESS_KEYS } from "@/lib/authz/guards";
import { LEVEL_WORDS } from "@/lib/authz/level-order";
import { getPermissionDefinition } from "@/lib/permissions";
import { ACCESS_MODULES } from "@/lib/staff/access-modules";
import { hiddenPagesOfRole } from "@/lib/staff/hidden-pages";
import { currentTenant } from "@/lib/tenancy/resolve";
import { workspaceClock } from "@/lib/time/workspace";
import { permissionModules } from "@/lib/staff/permission-modules";
import { listRolesForScreen } from "@/actions/role";
import { effectivePermissionsFor, getPermissionMatrix } from "@/actions/permission";
import { userPermissionOverrides } from "@/actions/access";
import { personAccessGrid } from "@/actions/person-access";
import { roleAccessLevels } from "@/actions/access-levels";
import { getModuleStates } from "@/actions/module";
import { AcPage, EmptyNote, Panel } from "@/components/access-control/ui";
import { ModuleMatrix } from "@/components/access-control/modules/module-matrix";
import type { MatrixData, MatrixPermission, MatrixSubject, ModuleScope } from "@/components/access-control/modules/types";

export const metadata = { title: "Module Permission Matrix" };

/**
 * Settings › Access Control › Module Matrix: every module against its permissions, for one role
 * (`?role=`) or one person's exceptions to theirs (`?user=`). Each answer is Default, Allow or Deny;
 * changes are staged on the screen and saved together.
 *
 * The layout checked `permissions.view`; `permissions.manage` decides whether anything here can be
 * changed, and every save goes through actions that check it again — with who may change what
 * (ADMIN only by a super admin, nothing the viewer doesn't hold, never their own way in).
 */
export default async function ModuleMatrixPage({ searchParams }: { searchParams: Promise<{ role?: string; user?: string }> }) {
  const sp = await searchParams;
  const viewer = await requireAccessViewer();

  const [mayManage, roleRows, moduleStates, viewerHolds, resolved, activePeople, asked] = await Promise.all([
    can(viewer.id, "permissions.manage"),
    listRolesForScreen(),
    getModuleStates(),
    permissionsFor(viewer.id),
    resolveUserPermissions(viewer.id),
    db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, roleRef: { select: { name: true } } }, take: 500 }),
    sp.user
      ? db.user.findUnique({ where: { id: sp.user }, select: { id: true, name: true, role: true, active: true, isSuperAdmin: true, roleRef: { select: { name: true } } } })
      : null,
  ]);
  const roles = roleRows.ok ? roleRows.data : [];
  const role = roles.find((r) => r.key === sp.role) ?? roles.find((r) => r.key !== "ADMIN") ?? roles[0] ?? null;

  if (!asked && !role) {
    return (
      <AcPage crumb="Module Matrix" title="Module Permission Matrix" description="Every module against its permissions.">
        <Panel>
          <EmptyNote>There are no roles yet.</EmptyNote>
        </Panel>
      </AcPage>
    );
  }

  let subject: MatrixSubject;
  let permissions: MatrixPermission[];
  let scopes: Record<string, ModuleScope>;
  let hiddenPages: string[] = [];

  const flagsOf = (key: string) => {
    const def = getPermissionDefinition(key);
    return {
      description: def?.description ?? "",
      superAdminOnly: def?.superAdminOnly === true,
      adminOnly: def?.adminOnly === true,
      selfExcluded: def?.selfExcluded === true,
      modules: permissionModules(key),
    };
  };

  if (asked) {
    // One person: what their role gives, their own exception (if any), and what the resolver says applies.
    const [effective, overrides, grants, grid, clock] = await Promise.all([
      effectivePermissionsFor(asked.id),
      userPermissionOverrides(asked.id),
      roleGrants(asked.role),
      personAccessGrid(asked.id),
      workspaceClock(),
    ]);
    const own = new Map(overrides.map((o) => [o.permission, o]));
    subject = { kind: "user", id: asked.id, name: asked.name, roleKey: asked.role, roleName: asked.isSuperAdmin ? "Super Admin" : asked.roleRef.name, isSuperAdmin: asked.isSuperAdmin, active: asked.active };
    permissions = (effective?.permissions ?? []).map((p): MatrixPermission => {
      const o = own.get(p.key);
      return {
        key: p.key,
        label: p.label,
        tier: p.tier,
        ...flagsOf(p.key),
        state: o && !o.expired ? (o.allowed ? "allow" : "deny") : "default",
        base: grants(p.key),
        held: p.held,
        why: p.why,
        // An end is stored as the midnight after its last day, so the day named is the one before it.
        own: o
          ? { allowed: o.allowed, reason: o.reason, expiresAt: o.expiresAt ? o.expiresAt.toISOString() : null, until: o.expiresAt ? clock.date(new Date(o.expiresAt.getTime() - 1)) : null, expired: o.expired }
          : null,
      };
    });
    scopes = Object.fromEntries(
      ACCESS_MODULES.map((m) => [
        m.key,
        m.records.flatMap((r) => {
          const row = grid?.find((g) => g.key === r);
          return row ? [{ record: row.label, level: LEVEL_WORDS[row.cells.view.effective] }] : [];
        }),
      ]),
    );
  } else {
    // A role: the stored answer for each key over the registry's default for it.
    const picked = role!;
    const [matrix, grid, hidden, holders] = await Promise.all([
      getPermissionMatrix(),
      roleAccessLevels(picked.key),
      hiddenPagesOfRole(picked.key),
      // Who a change reaches: the people who hold the role and can sign in — the super admin apart, as the roles list counts them.
      db.user.count({ where: { role: picked.key, active: true, isSuperAdmin: false } }),
    ]);
    subject = { kind: "role", key: picked.key, name: picked.name, isSystem: picked.isSystem, active: picked.active, people: holders };
    permissions = matrix.map((p): MatrixPermission => {
      const def = getPermissionDefinition(p.key);
      const held = p.roles[picked.key] ?? false;
      return {
        key: p.key,
        label: p.label,
        tier: p.tier,
        ...flagsOf(p.key),
        state: p.explicit[picked.key] ? (held ? "allow" : "deny") : "default",
        base: def ? roleDefault(def, picked.key) : false,
        held,
        why: null,
        own: null,
      };
    });
    scopes = Object.fromEntries(
      ACCESS_MODULES.map((m) => [
        m.key,
        m.records.flatMap((r) => {
          const row = grid?.rows.find((g) => g.key === r);
          return row ? [{ record: row.label, level: LEVEL_WORDS[row.cells.view.stored ?? row.cells.view.derived] }] : [];
        }),
      ]),
    );
    hiddenPages = hidden;
  }

  // Which of the two keys that open these screens the viewer holds *through their role*: locked on
  // their own role, as `assertKeepsOwnAccessAdmin` would refuse taking them away.
  const ownAccessThroughRole = OWN_ACCESS_KEYS.filter((key) => {
    const source = resolved.sources.get(key);
    return source?.via === "roleDefault" || source?.via === "adminDefault" || (source?.via === "roleOverride" && source.allowed);
  });

  const people = activePeople.map((p) => ({ id: p.id, name: `${p.name} · ${p.roleRef.name}` }));
  if (asked && !people.some((p) => p.id === asked.id)) people.unshift({ id: asked.id, name: `${asked.name} · ${asked.roleRef.name}` });

  const data: MatrixData = {
    subject,
    roles: roles.map((r) => ({ id: r.key, name: r.active ? r.name : `${r.name} (switched off)` })),
    people,
    permissions,
    moduleStates: Object.fromEntries(moduleStates.map((m) => [m.key, { key: m.key, label: m.label, entitled: m.entitled, switchedOn: m.switchedOn }])),
    scopes,
    hiddenPages,
    country: (await currentTenant()).country,
    viewer: {
      id: viewer.id,
      mayManage,
      isSuperAdmin: resolved.isSuperAdmin,
      role: resolved.role ?? "",
      holds: viewerHolds.map(String),
      ownAccessThroughRole: [...ownAccessThroughRole],
    },
  };

  return <ModuleMatrix key={subject.kind === "role" ? `role:${subject.key}` : `user:${subject.id}`} data={data} />;
}
