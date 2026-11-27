import { db } from "@/lib/db";
import { listRolesForScreen } from "@/actions/role";
import type { Subject } from "@/components/access-control/scope/reach";
import type { PersonOption, RoleOption } from "@/components/access-control/scope/subject-bar";

/**
 * Who Document Permissions and Data Scope are about, read from `?role=` / `?user=`: the roles and
 * people the picker offers, the one chosen, and — for a person — why their access can't be changed
 * from here, in the words their own page has always used.
 *
 * A plain server module, not an action: the pages have already checked `permissions.view`.
 */
export type LoadedSubject = {
  roles: RoleOption[];
  people: PersonOption[];
  subject: Subject | null;
  /** A line about the subject for the picker. */
  meta: string;
  /** A person whose access nobody (or not this viewer) sets here, and why. Null for a role. */
  personLock: string | null;
};

export async function loadSubject(sp: { role?: string; user?: string }, viewerId: string, mayManage: boolean): Promise<LoadedSubject> {
  const [roleRows, users] = await Promise.all([
    listRolesForScreen(),
    db.user.findMany({
      orderBy: [{ active: "desc" }, { name: "asc" }],
      select: { id: true, name: true, role: true, active: true, isSuperAdmin: true, roleRef: { select: { name: true } } },
    }),
  ]);
  const allRoles = roleRows.ok ? roleRows.data : [];
  const roles: RoleOption[] = allRoles.map((r) => ({ key: r.key, name: r.name }));
  const person = sp.user ? (users.find((u) => u.id === sp.user) ?? null) : null;
  // The picker lists who can sign in — and the one asked for, whoever they are.
  const people: PersonOption[] = users
    .filter((u) => u.active || u.id === person?.id)
    .map((u) => ({ id: u.id, name: u.active ? u.name : `${u.name} (deactivated)`, roleKey: u.role, roleName: u.isSuperAdmin ? "Super Admin" : u.roleRef.name }));

  if (person) {
    const roleName = person.roleRef.name;
    const personLock = !mayManage
      ? "You can review access but not change it."
      : person.isSuperAdmin
        ? "A super admin holds everything and reaches every record. There is nothing to set for them."
        : person.id === viewerId
          ? "Your own access is changed by another admin."
          : null;
    return {
      roles,
      people,
      subject: { type: "user", id: person.id, name: person.name, roleKey: person.role, roleName },
      meta: `Role: ${person.isSuperAdmin ? "Super Admin" : roleName} · chips show what applies to them; changes save as overrides for them alone`,
      personLock,
    };
  }

  const role = allRoles.find((r) => r.key === sp.role) ?? allRoles.find((r) => r.key !== "ADMIN") ?? allRoles[0] ?? null;
  if (!role) return { roles, people, subject: null, meta: "", personLock: null };
  const holders = users.filter((u) => u.active && !u.isSuperAdmin && u.role === role.key).length;
  return {
    roles,
    people,
    subject: { type: "role", key: role.key, name: role.name },
    meta: `${role.isSystem ? "Built-in role" : "Custom role"} · ${holders} ${holders === 1 ? "person" : "people"}${role.active ? "" : " · switched off"}`,
    personLock: null,
  };
}
