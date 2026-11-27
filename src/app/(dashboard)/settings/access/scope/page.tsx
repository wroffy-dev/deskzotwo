import { notFound } from "next/navigation";
import { roleAccessLevels } from "@/actions/access-levels";
import { personAccessGrid } from "@/actions/person-access";
import { currentUser } from "@/lib/session";
import { can, permissionsFor } from "@/lib/authz/resolve";
import { roleGrants } from "@/lib/authz/role-permission";
import { getPermissionDefinition } from "@/lib/permissions";
import { RECORD_VIEW_KEY } from "@/lib/staff/access-modules";
import { AcPage, EmptyNote, Panel } from "@/components/access-control/ui";
import { DataScope, type OpensWith } from "@/components/access-control/scope/data-scope";
import { loadSubject } from "@/components/access-control/scope/load-subject";
import { reachOfPerson, reachOfRole, type ReachRow } from "@/components/access-control/scope/reach";
import { personLeadReachView, roleLeadReachView, type LeadReachView } from "@/lib/authz/lead-reach";

export const metadata = { title: "Data Scope" };

/**
 * Settings › Access Control › Data Scope: which records a role, or one person, reaches — per record
 * type and per action, a stored level or the one derived from what is underneath.
 *
 * `permissions.view` opens it (the layout, and again here); saving takes `permissions.manage` and goes
 * through `setRoleAccessLevels` / `setPersonAccessLevels`, which check it and every other rule again.
 * Why a grid can't be changed is the server's own answer (`roleAccessLevels().why`).
 */
export default async function DataScopePage({ searchParams }: { searchParams: Promise<{ role?: string; user?: string; record?: string }> }) {
  const viewer = await currentUser();
  if (!viewer || !(await can(viewer.id, "permissions.view"))) notFound();
  const sp = await searchParams;
  const mayManage = await can(viewer.id, "permissions.manage");
  const loaded = await loadSubject(sp, viewer.id, mayManage);
  const { subject } = loaded;

  if (!subject) {
    return (
      <AcPage crumb="Data Scope" title="Data Scope Management" description="Permissions decide what a role can do. Scope decides which records it can do it on.">
        <Panel>
          <EmptyNote>There are no roles yet.</EmptyNote>
        </Panel>
      </AcPage>
    );
  }

  let reach: ReachRow[];
  let reachLock: string | null;
  let holds: (key: string) => boolean;
  // Leads "as the account" also reaching what they own and made — two ticks under that tile (src/lib/authz/lead-reach.ts).
  let leadReach: LeadReachView | null;
  if (subject.type === "role") {
    const [grid, grants] = await Promise.all([roleAccessLevels(subject.key), roleGrants(subject.key)]);
    reach = reachOfRole(grid?.rows ?? []);
    reachLock = grid ? grid.why : "This role's records can't be read.";
    holds = grants;
    leadReach = await roleLeadReachView(subject.key);
  } else {
    const [grid, held] = await Promise.all([personAccessGrid(subject.id), permissionsFor(subject.id)]);
    const set = new Set<string>(held.map(String));
    reach = reachOfPerson(grid ?? [], subject.roleName);
    reachLock = loaded.personLock;
    holds = (key) => set.has(key);
    leadReach = await personLeadReachView(subject.id);
  }

  // The permission that opens each record type's pages at all: a level without it reaches pages that stay closed.
  const opens: Record<string, OpensWith> = {};
  for (const [record, key] of Object.entries(RECORD_VIEW_KEY)) {
    if (key) opens[record] = { label: getPermissionDefinition(key)?.label ?? key, held: holds(key) };
  }

  return (
    <DataScope
      // A different subject is a different screen: nothing staged for one carries to the next.
      key={subject.type === "role" ? `role:${subject.key}` : `user:${subject.id}`}
      subject={subject}
      roles={loaded.roles}
      people={loaded.people}
      meta={loaded.meta}
      reach={reach}
      reachLock={reachLock}
      opens={opens}
      initialRecord={sp.record}
      leadReach={leadReach}
    />
  );
}
