import { requireAccessViewer } from "@/lib/access-control/guard";
import { can, permissionsFor, resolveUserPermissions } from "@/lib/authz/resolve";
import { actorContext, OWN_ACCESS_KEYS } from "@/lib/authz/guards";
import { roleDefault } from "@/lib/authz/role-permission";
import { exportVisibility, FIELD_ENTITIES, FIELD_ENTITY_WORDS } from "@/lib/authz/field-policy";
import { getPermissionDefinition, heldByDefault, type PermissionDefinition } from "@/lib/permissions";
import { PORTABLE_AREAS } from "@/lib/portability/areas";
import { IMPLEMENTED_IMPORTS } from "@/lib/portability/import";
import { getSecurityPolicy } from "@/lib/security/store";
import { getPermissionMatrix, holdersOf } from "@/actions/permission";
import { listRolesForScreen } from "@/actions/role";
import { fieldMaskingState, roleFieldAccess } from "@/actions/field-access";
import { AcPage, EmptyNote, Panel } from "@/components/access-control/ui";
import { ImportExportScreen, type IoFieldEntity, type IoHolders, type IoIcon, type IoKey, type IoRow } from "@/components/access-control/policy/import-export-screen";

export const metadata = { title: "Import & Export Permissions" };

/**
 * The data areas, each with the permission its exporter checks and the one its importer checks
 * (src/lib/portability/areas.ts; src/actions/data-export.ts and data-import.ts). The last two are
 * the other ways a file leaves: the activity log (and the approval history, which asks for the same
 * key) and a backup taken off the server. Neither has anything to import.
 */
const DATA_AREAS: { id: string; label: string; icon: IoIcon; exportKey: string; importKey: string | null; covers?: string[]; note?: string; importWhy?: string }[] = [
  { id: "crm", label: "CRM & customers", icon: "crm", exportKey: "data.exportCrm", importKey: "data.importCrm", note: "An export holds only the accounts the person can already see." },
  { id: "finance", label: "Finance", icon: "finance", exportKey: "data.exportFinance", importKey: "data.importFinance" },
  { id: "catalog", label: "Catalog", icon: "catalog", exportKey: "data.exportCatalog", importKey: "data.importCatalog" },
  { id: "people", label: "People & HR", icon: "people", exportKey: "data.exportPeople", importKey: "data.importPeople", note: "Salary figures and bank details are left out of every export, whoever takes it." },
  { id: "users", label: "User accounts", icon: "users", exportKey: "data.exportUsers", importKey: "data.importUsers", note: "Password hashes and two-factor secrets are never in an export." },
  {
    id: "activity",
    label: "Activity log",
    icon: "activity",
    exportKey: "activity.export",
    importKey: null,
    covers: ["Activity log", "Approval history"],
    importWhy: "Written by the system as things happen — there is nothing to import.",
  },
  {
    id: "backups",
    label: "Backups",
    icon: "backups",
    exportKey: "backups.download",
    importKey: null,
    covers: ["Database backups"],
    note: "A sealed file, encrypted under a passphrase chosen at download; each download is recorded against whoever asked.",
    importWhy: "Putting a backup back is “Restore from a backup”, a permission of its own.",
  },
];

/**
 * Settings › Access Control › Import & Export: per role, who may import and who may export each data
 * area, how the role's sensitive fields go out in a file, and everybody who can export today.
 *
 * `permissions.view` opens it (the layout); `permissions.manage` stages changes, and the actions that
 * save them check again. The locks are the role editor's own (src/components/settings/roles/
 * role-modules-workspace.tsx `keyLock`), worked out here so a cell that would be refused says so first.
 */
export default async function ImportExportPermissionsPage({ searchParams }: { searchParams: Promise<{ role?: string }> }) {
  const sp = await searchParams;
  const viewer = await requireAccessViewer();

  const [mayManage, actor, roleRows, matrix, viewerHolds, resolved, masking, policy] = await Promise.all([
    can(viewer.id, "permissions.manage"),
    actorContext(viewer.id),
    listRolesForScreen(),
    getPermissionMatrix(),
    permissionsFor(viewer.id),
    resolveUserPermissions(viewer.id),
    fieldMaskingState(),
    getSecurityPolicy(),
  ]);

  const roles = (roleRows.ok ? roleRows.data : []).map((r) => ({ key: r.key, name: r.name, active: r.active, headcount: r.headcount, switchedOff: r.switchedOff }));
  const role = roles.find((r) => r.key === sp.role) ?? roles.find((r) => r.key !== "ADMIN") ?? roles[0];
  if (!role) {
    return (
      <AcPage crumb="Import & Export" title="Import & Export Permissions">
        <Panel>
          <EmptyNote>There are no roles yet.</EmptyNote>
        </Panel>
      </AcPage>
    );
  }
  const roleName = new Map(roles.map((r) => [r.key, r.name]));

  // ── What the role answers, and whether the person looking may change it ──────────────────────
  const held = new Set(viewerHolds.map(String));
  // Of the keys that open these screens, the ones the viewer holds through their role (as `assertKeepsOwnAccessAdmin` reads it).
  const ownAccessThroughRole: string[] = OWN_ACCESS_KEYS.filter((key) => {
    const source = resolved.sources.get(key);
    return source?.via === "roleDefault" || source?.via === "adminDefault" || (source?.via === "roleOverride" && source.allowed);
  });
  const lockOf = (def: PermissionDefinition, allowed: boolean): string | null => {
    if (!mayManage) return "You can review roles but not change them.";
    if (role.key === "ADMIN" && !actor.isSuperAdmin) return "Only a super admin can change what admins can do.";
    if (actor.isSuperAdmin) return null;
    if (def.superAdminOnly) return "Only a super admin can grant this permission.";
    if (def.adminOnly && actor.role !== "ADMIN") return "Only an admin or the super admin can give this permission.";
    if (!held.has(def.key)) return "You don't hold this yourself, so you can't change it for a role.";
    if (role.key === actor.role && ownAccessThroughRole.includes(def.key) && allowed) return "You hold this through this role. Taking it away would lock you out of putting it back.";
    return null;
  };
  const byKey = new Map(matrix.map((p) => [p.key, p]));
  const cellOf = (key: string | null): IoKey | null => {
    const def = key ? getPermissionDefinition(key) : undefined;
    const cell = def ? byKey.get(def.key) : undefined;
    if (!def || !cell) return null;
    const allowed = cell.roles[role.key] ?? false;
    const defaultAllowed = roleDefault(def, role.key);
    const defaultWhy =
      role.key === "ADMIN"
        ? def.superAdminOnly
          ? "only a super admin grants it, to admins too"
          : "admins hold everything not switched off"
        : heldByDefault(def, role.key)
          ? "comes with the role"
          : "not part of this role";
    return {
      key: def.key,
      label: def.label,
      description: def.description,
      tier: cell.tier,
      superAdminOnly: cell.superAdminOnly,
      allowed,
      explicit: cell.explicit[role.key] ?? false,
      defaultAllowed,
      defaultWhy,
      lock: lockOf(def, allowed),
    };
  };

  const rows: IoRow[] = DATA_AREAS.map((a) => {
    const areas = PORTABLE_AREAS.filter((p) => p.exportPermission === a.exportKey);
    return {
      id: a.id,
      label: a.label,
      icon: a.icon,
      areas: a.covers ?? areas.filter((p) => p.importPermission !== null).map((p) => p.label),
      exportOnly: areas.filter((p) => p.importPermission === null).map((p) => ({ label: p.label, why: p.importRefusedBecause ?? "This area cannot be imported." })),
      importNotBuilt: areas.filter((p) => p.importPermission !== null && !IMPLEMENTED_IMPORTS.includes(p.key)).map((p) => p.label),
      note: a.note ?? null,
      export: cellOf(a.exportKey),
      import: cellOf(a.importKey),
      importWhy: a.importWhy ?? null,
    };
  });

  // ── Who can export, and how this role's sensitive fields go out ───────────────────────────────
  const [holderSets, fieldSets] = await Promise.all([
    Promise.all(DATA_AREAS.map((a) => holdersOf(a.exportKey))),
    Promise.all(FIELD_ENTITIES.map((entity) => roleFieldAccess(role.key, entity))),
  ]);
  const holders: IoHolders[] = holderSets.flatMap((h) =>
    h
      ? [
          {
            key: h.permission.key,
            label: h.permission.label,
            holders: h.holders.map((p) => ({ id: p.id, name: p.name, roleName: p.via === "superAdmin" ? "Super admin" : (roleName.get(p.role) ?? p.role), why: p.why })),
            denied: h.denied.length,
          },
        ]
      : [],
  );
  const fieldEntities: IoFieldEntity[] = FIELD_ENTITIES.map((entity, i) => {
    const access = fieldSets[i];
    return {
      entity,
      title: FIELD_ENTITY_WORDS[entity].title,
      readable: access !== null && access !== undefined,
      fields: (access?.rows ?? []).map((f) => ({ key: f.key, label: f.label, mode: exportVisibility(f.effective), asList: f.effective.export === null })),
    };
  });

  return (
    <ImportExportScreen
      key={role.key}
      roles={roles}
      role={role}
      rows={rows}
      holders={holders}
      fieldEntities={fieldEntities}
      maskingOn={masking.enabled}
      exportRowLimit={policy.exportRowLimit}
      mayManage={mayManage}
    />
  );
}
