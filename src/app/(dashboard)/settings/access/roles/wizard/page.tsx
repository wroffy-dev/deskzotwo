import Link from "next/link";
import { notFound } from "next/navigation";
import { Eye } from "lucide-react";
import { listRolesForScreen } from "@/actions/role";
import { getPermissionMatrix } from "@/actions/permission";
import { roleAccessLevels } from "@/actions/access-levels";
import { currentUser } from "@/lib/session";
import { db } from "@/lib/db";
import { OWN_ACCESS_KEYS } from "@/lib/authz/guards";
import { ROLE_PRESETS } from "@/lib/authz/presets";
import { can, permissionsFor, resolveUserPermissions } from "@/lib/authz/resolve";
import { getPermissionDefinition } from "@/lib/permissions";
import { ACCESS_MODULES, FOLDED_KEYS, isSectionKey, moduleOfPermission } from "@/lib/staff/access-modules";
import { acPath } from "@/lib/access-control/nav";
import { AcPage, Panel, acButton } from "@/components/access-control/ui";
import { RoleWizard } from "@/components/access-control/roles/role-wizard";
import type { WizardModule, WizardRole, WizardStart, WizardViewer } from "@/components/access-control/roles/types";

export const metadata = { title: "Role wizard" };

const STEPS = 4;

/**
 * Settings › Access Control › Roles & Permissions › Create / Edit Role: the design's stepper over the
 * real actions. A role has to exist before anything can be set on it, so the first step creates it
 * (blank, as a copy of another, or from a built-in profile) and the later steps edit the role that
 * now exists — the same steps `?role=KEY` opens for a role that already did.
 *
 * Changing roles needs `permissions.manage`; somebody who may only review them is told so.
 */
export default async function RoleWizardPage({ searchParams }: { searchParams: Promise<{ role?: string; step?: string; created?: string }> }) {
  const viewer = await currentUser();
  if (!viewer || !(await can(viewer.id, "permissions.view"))) notFound();
  const sp = await searchParams;

  if (!(await can(viewer.id, "permissions.manage"))) {
    return (
      <AcPage crumb={sp.role ? "Edit Role" : "Create Role"} title={sp.role ? "Edit Role" : "Create Role"}>
        <Panel className="flex flex-wrap items-center gap-3 px-4 py-3 text-[13px] text-muted">
          <Eye className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
          <span className="flex-1">You can review roles but not change them.</span>
          <Link href={sp.role ? acPath.modules({ role: sp.role }) : acPath.roles()} className={acButton.secondary}>
            {sp.role ? "Open its permissions" : "Back to roles"}
          </Link>
        </Panel>
      </AcPage>
    );
  }

  const [roleRows, matrix] = await Promise.all([listRolesForScreen(), getPermissionMatrix()]);
  const roles = roleRows.ok ? roleRows.data : [];
  const roleName = new Map(roles.map((r) => [r.key, r.name]));
  const labels = Object.fromEntries(matrix.map((p) => [p.key, p.label]));

  const start: WizardStart = {
    sources: roles.map((r) => ({ key: r.key, name: r.name })),
    presets: ROLE_PRESETS.map((p) => ({ key: p.key, label: p.label, description: p.description, roleName: roleName.get(p.role) ?? p.role, permissions: [...p.permissions] })),
  };

  if (!sp.role) return <RoleWizard key="new" role={null} start={start} viewer={null} labels={labels} initialStep={0} justCreated={false} />;

  const row = roles.find((r) => r.key === sp.role);
  if (!row) notFound();

  const [grid, people, viewerRow, viewerHolds, resolved] = await Promise.all([
    roleAccessLevels(row.key),
    // Who a change reaches: the people who hold the role and can sign in.
    db.user.count({ where: { role: row.key, active: true, isSuperAdmin: false } }),
    db.user.findUnique({ where: { id: viewer.id }, select: { isSuperAdmin: true } }),
    permissionsFor(viewer.id),
    resolveUserPermissions(viewer.id),
  ]);

  // The module step's list: each module's permissions, in the registry's order. Menu sections are the
  // Module Matrix's, and the keys another row already decides (FOLDED_KEYS) aren't offered as switches.
  const byModule = new Map<string, WizardModule["permissions"]>();
  for (const p of matrix) {
    if (isSectionKey(p.key) || FOLDED_KEYS.has(p.key)) continue;
    const def = getPermissionDefinition(p.key);
    const moduleKey = def ? moduleOfPermission(def) : "admin";
    byModule.set(moduleKey, [
      ...(byModule.get(moduleKey) ?? []),
      { key: p.key, label: p.label, description: p.description, tier: p.tier, superAdminOnly: p.superAdminOnly, selfExcluded: p.selfExcluded },
    ]);
  }
  const modules: WizardModule[] = ACCESS_MODULES.flatMap((m) => {
    const permissions = byModule.get(m.key) ?? [];
    return permissions.length ? [{ key: m.key, label: m.label, description: m.description, icon: m.icon, permissions }] : [];
  });

  // Which of the two keys that open these screens the viewer holds *through their role*: those are
  // locked on their own role, as `assertKeepsOwnAccessAdmin` would refuse taking them away.
  const ownAccessThroughRole = OWN_ACCESS_KEYS.filter((key) => {
    const source = resolved.sources.get(key);
    return source?.via === "roleDefault" || source?.via === "adminDefault" || (source?.via === "roleOverride" && source.allowed);
  });

  const role: WizardRole = {
    key: row.key,
    name: row.name,
    description: row.description,
    isSystem: row.isSystem,
    people,
    modules,
    held: matrix.filter((p) => p.roles[row.key]).map((p) => p.key),
    grid: grid?.rows ?? [],
    gridWhy: grid ? grid.why : "This role's records can't be read.",
    presets: ROLE_PRESETS.filter((p) => p.role === row.key).map((p) => ({ key: p.key, label: p.label, description: p.description })),
  };
  const viewerFacts: WizardViewer = {
    isSuperAdmin: viewerRow?.isSuperAdmin ?? false,
    role: resolved.role ?? "",
    holds: viewerHolds.map(String),
    ownAccessThroughRole: [...ownAccessThroughRole],
  };

  const step = Math.min(STEPS, Math.max(1, Number.parseInt(sp.step ?? "1", 10) || 1)) - 1;
  return <RoleWizard key={row.key} role={role} start={start} viewer={viewerFacts} labels={labels} initialStep={step} justCreated={sp.created === "1"} />;
}
