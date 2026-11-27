import { requireAccessViewer } from "@/lib/access-control/guard";
import { permissionChangeHistory } from "@/actions/access";
import { fieldMaskingState, personFieldAccess, roleFieldAccess } from "@/actions/field-access";
import { listRolesForScreen } from "@/actions/role";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { resolveStoredFieldPolicies } from "@/lib/authz/fields";
import { FIELD_ENTITIES, isFieldEntity, type FieldEntity, type FieldPolicy } from "@/lib/authz/field-policy";
import { AcPage, EmptyNote, Panel } from "@/components/access-control/ui";
import { FieldManager } from "@/components/access-control/fields/field-manager";
import type { EntityAccess, FieldChange, FieldSubject, LimitSummary, OwnCaps, SubjectOption } from "@/components/access-control/fields/model";

export const metadata = { title: "Field Permissions" };

/**
 * Settings › Access Control › Field Permissions: for one role or one employee, what they see of each
 * field of a lead, a contact and a company — read, masked in lists, masked on the record, how it is
 * masked, whether it can be unmasked, and how it is exported (src/lib/authz/field-policy.ts).
 *
 * All three record types are read here, so switching between them on the screen fetches nothing and
 * staged changes on one survive a look at another. `permissions.manage` decides editable or read-only;
 * the actions that save (src/actions/field-access.ts) check it again, with the rest of their rules.
 */
export default async function FieldPermissionsPage({ searchParams }: { searchParams: Promise<{ role?: string; user?: string; entity?: string }> }) {
  const sp = await searchParams;
  const viewer = await requireAccessViewer();

  const [mayManage, viewerRow, roleRows, staff, masking] = await Promise.all([
    can(viewer.id, "permissions.manage"),
    db.user.findUnique({ where: { id: viewer.id }, select: { isSuperAdmin: true } }),
    listRolesForScreen(),
    // Everybody who can sign in — and whoever the link names, so a switched-off account still opens.
    db.user.findMany({
      where: { kind: "MEMBER", OR: [{ active: true }, ...(sp.user ? [{ id: sp.user }] : [])] },
      orderBy: { name: "asc" },
      select: { id: true, name: true, role: true, active: true, isSuperAdmin: true },
    }),
    fieldMaskingState(),
  ]);
  const roles = roleRows.ok ? roleRows.data : [];
  const roleName = new Map(roles.map((r) => [r.key, r.name]));
  const roleOptions: SubjectOption[] = roles.map((r) => ({ id: r.key, name: r.name, hint: r.active ? null : "switched off" }));
  const peopleOptions: SubjectOption[] = staff.map((u) => ({ id: u.id, name: u.name, hint: u.isSuperAdmin ? "Super Admin" : (roleName.get(u.role) ?? u.role) }));

  const person = sp.user ? (staff.find((u) => u.id === sp.user) ?? null) : null;
  const role = person ? null : (roles.find((r) => r.key === sp.role) ?? roles.find((r) => r.key !== "ADMIN") ?? roles[0] ?? null);
  if (!person && !role) {
    return (
      <AcPage crumb="Field Permissions" title="Field-Level Permission Manager">
        <Panel>
          <EmptyNote>There are no roles yet.</EmptyNote>
        </Panel>
      </AcPage>
    );
  }

  const read = await Promise.all(FIELD_ENTITIES.map((entity) => (person ? personFieldAccess(person.id, entity) : roleFieldAccess(role!.key, entity))));
  const first = read[0];
  if (!first || read.some((r) => r === null)) {
    return (
      <AcPage crumb="Field Permissions" title="Field-Level Permission Manager">
        <Panel>
          <EmptyNote>{person ? "Their field access can't be read." : "This role's field access can't be read."}</EmptyNote>
        </Panel>
      </AcPage>
    );
  }
  const access: EntityAccess[] = FIELD_ENTITIES.map((entity, i) => {
    const data = read[i]!;
    return { entity, rows: data.rows, warnings: "warnings" in data ? data.warnings : [] };
  });

  const [history, caps] = await Promise.all([
    permissionChangeHistory(person ? { userId: person.id, limit: 200 } : { role: role!.key, limit: 200 }),
    viewerRow?.isSuperAdmin ? null : ownCaps(viewer.id),
  ]);
  // "field:<entity>:<key>" — a custom field's key carries a colon of its own, so only the first two are split off.
  const fieldHistory: FieldChange[] = history.flatMap((h) => {
    const match = h.permission ? /^field:([^:]+):(.+)$/.exec(h.permission) : null;
    if (!match || !isFieldEntity(match[1])) return [];
    return [{ id: h.id, entity: match[1], field: match[2]!, detail: h.detail ?? h.changeKind.toLowerCase().replaceAll("_", " "), actor: h.actor?.name ?? null, at: h.createdAt.toISOString() }];
  });

  let subject: FieldSubject;
  let limit: LimitSummary;
  if (person) {
    const data = first as NonNullable<Awaited<ReturnType<typeof personFieldAccess>>>;
    const roleRow = roles.find((r) => r.key === person.role);
    subject = {
      type: "user",
      id: person.id,
      name: person.name,
      roleKey: person.role,
      roleName: roleName.get(person.role) ?? person.role,
      superAdmin: person.isSuperAdmin,
      inactive: !person.active || roleRow?.active === false,
    };
    limit = { kind: "user", effective: data.limit.effective, why: data.limit.why, used: data.usage.used, limit: data.usage.limit, remaining: data.usage.remaining, zone: data.zone };
  } else {
    const data = first as NonNullable<Awaited<ReturnType<typeof roleFieldAccess>>>;
    subject = {
      type: "role",
      id: role!.key,
      name: role!.name,
      system: role!.isSystem,
      active: role!.active,
      holders: staff.filter((u) => u.active && !u.isSuperAdmin && u.role === role!.key).map((u) => ({ id: u.id, name: u.name })),
    };
    limit = { kind: "role", dailyLimit: data.dailyLimit, limitStored: data.limitStored, workspaceDefault: data.workspaceDefault };
  }

  return (
    <FieldManager
      // Another role or person starts again: staged changes belong to the subject they were made for.
      key={`${subject.type}:${subject.id}`}
      subject={subject}
      roles={roleOptions}
      people={peopleOptions}
      initialEntity={isFieldEntity(sp.entity) ? sp.entity : "leads"}
      access={access}
      editable={mayManage && first.editable}
      why={first.why}
      caps={caps}
      masking={{ enabled: masking.enabled, changedAtText: masking.changedAtText, changedBy: masking.changedBy }}
      limit={limit}
      history={fieldHistory}
    />
  );
}

/**
 * The viewer's own answer for every field, as the rules stand whether or not masking is switched on —
 * what the save actions hold them to ("nobody gives more than they have"), so the screen can say which
 * staged change would be refused before it is sent.
 */
async function ownCaps(viewerId: string): Promise<OwnCaps> {
  const out = {} as Record<FieldEntity, Record<string, FieldPolicy>>;
  await Promise.all(
    FIELD_ENTITIES.map(async (entity) => {
      const resolved = await resolveStoredFieldPolicies(viewerId, entity);
      out[entity] = Object.fromEntries([...resolved.fields].map(([key, f]) => [key, f.policy]));
    }),
  );
  return out;
}
