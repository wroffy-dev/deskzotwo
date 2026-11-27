import { notFound } from "next/navigation";
import { getPermissionMatrix, effectivePermissionsFor } from "@/actions/permission";
import { userPermissionOverrides } from "@/actions/access";
import { roleAccessLevels } from "@/actions/access-levels";
import { personAccessGrid } from "@/actions/person-access";
import { currentUser } from "@/lib/session";
import { can, permissionsFor, resolveUserPermissions } from "@/lib/authz/resolve";
import { OWN_ACCESS_KEYS } from "@/lib/authz/guards";
import { roleGrants } from "@/lib/authz/role-permission";
import { getPermissionDefinition } from "@/lib/permissions";
import { AcPage, EmptyNote, Panel } from "@/components/access-control/ui";
import { DocumentPermissions, type PermRow, type ScreenViewer } from "@/components/access-control/scope/document-permissions";
import { docScreenKeys, docScreenRecords } from "@/components/access-control/scope/doc-areas";
import { loadSubject } from "@/components/access-control/scope/load-subject";
import { reachOfPerson, reachOfRole, type ReachRow } from "@/components/access-control/scope/reach";

export const metadata = { title: "Document Permissions" };

/**
 * Settings › Access Control › Document Permissions: for a role or one person, per document area —
 * how far each record action reaches, the permission for each document type and action, the area's
 * other permissions, and whether the area is in their menu at all.
 *
 * `permissions.view` opens it (the layout, and again here); `permissions.manage` changes anything, and
 * every save goes through the actions that check that — and everything else — again.
 */
export default async function DocumentPermissionsPage({ searchParams }: { searchParams: Promise<{ role?: string; user?: string; area?: string }> }) {
  const viewer = await currentUser();
  if (!viewer || !(await can(viewer.id, "permissions.view"))) notFound();
  const sp = await searchParams;
  const mayManage = await can(viewer.id, "permissions.manage");
  const loaded = await loadSubject(sp, viewer.id, mayManage);
  const { subject } = loaded;

  if (!subject) {
    return (
      <AcPage crumb="Document Permissions" title="Document Permissions" description="Per area: how far each record action reaches, and who may do what to each kind of document.">
        <Panel>
          <EmptyNote>There are no roles yet.</EmptyNote>
        </Panel>
      </AcPage>
    );
  }

  const keys = new Set(docScreenKeys());
  const records = new Set<string>(docScreenRecords());
  const [viewerHolds, resolved] = await Promise.all([permissionsFor(viewer.id), resolveUserPermissions(viewer.id)]);
  // Which of the two keys that open these screens the viewer holds *through their role*: those are
  // locked on their own role, as `assertKeepsOwnAccessAdmin` would refuse taking them away.
  const ownAccessThroughRole = OWN_ACCESS_KEYS.filter((key) => {
    const source = resolved.sources.get(key);
    return source?.via === "roleDefault" || source?.via === "adminDefault" || (source?.via === "roleOverride" && source.allowed);
  });
  const screenViewer: ScreenViewer = { isSuperAdmin: resolved.isSuperAdmin, holds: viewerHolds.map(String), role: resolved.role ?? "", ownAccessThroughRole: [...ownAccessThroughRole] };

  let permissions: PermRow[];
  let reach: ReachRow[];
  let permissionLock: string | null;
  let reachLock: string | null;
  let version: string;

  if (subject.type === "role") {
    const [matrix, grid] = await Promise.all([getPermissionMatrix(), roleAccessLevels(subject.key)]);
    permissions = matrix
      .filter((p) => keys.has(p.key))
      .map((p) => {
        const held = p.roles[subject.key] ?? false;
        return { key: p.key, label: p.label, description: p.description, tier: p.tier, superAdminOnly: p.superAdminOnly, selfExcluded: p.selfExcluded, role: held, own: null, held, why: "" };
      });
    reach = reachOfRole(grid?.rows ?? []).filter((r) => records.has(r.key));
    permissionLock = !mayManage ? "You can review roles but not change them." : subject.key === "ADMIN" && !resolved.isSuperAdmin ? "Only a super admin can change what admins can do." : null;
    reachLock = grid ? grid.why : "This role's records can't be read.";
    version = `role:${subject.key}`;
  } else {
    const [effective, overrides, grants, grid] = await Promise.all([effectivePermissionsFor(subject.id), userPermissionOverrides(subject.id), roleGrants(subject.roleKey), personAccessGrid(subject.id)]);
    const own = new Map(overrides.map((o) => [o.permission, o]));
    permissions = (effective?.permissions ?? [])
      .filter((p) => keys.has(p.key))
      .map((p) => {
        const def = getPermissionDefinition(p.key);
        const o = own.get(p.key);
        return {
          key: p.key,
          label: p.label,
          description: def?.description ?? "",
          tier: p.tier,
          superAdminOnly: def?.superAdminOnly === true,
          selfExcluded: def?.selfExcluded === true,
          role: grants(p.key),
          own: o ? { allowed: o.allowed, reason: o.reason, expiresAt: o.expiresAt ? o.expiresAt.toISOString() : null, expired: o.expired } : null,
          held: p.held,
          why: p.why,
        };
      });
    reach = reachOfPerson(grid ?? [], subject.roleName).filter((r) => records.has(r.key));
    permissionLock = loaded.personLock;
    reachLock = loaded.personLock;
    version = `user:${subject.id}`;
  }

  return (
    <DocumentPermissions
      // A different subject is a different screen: nothing staged for one carries to the next.
      key={version}
      subject={subject}
      roles={loaded.roles}
      people={loaded.people}
      meta={loaded.meta}
      permissions={permissions}
      reach={reach}
      viewer={screenViewer}
      permissionLock={permissionLock}
      reachLock={reachLock}
      initialArea={sp.area}
    />
  );
}
