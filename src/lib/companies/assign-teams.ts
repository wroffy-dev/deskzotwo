import { cache } from "react";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { ASSIGN_ROLES, type AssignRole } from "./assign-roles";

export { ASSIGN_ROLES, type AssignRole };

/**
 * Which departments' people may be given a company (owner, 30 Oct 2026 — "like who tickets can be assigned to"): its
 * caller, its account manager, its renewal manager. Ticked per department in Settings › Departments. While no
 * department is ticked for one, anyone may be given it, as before; once one is, the pickers offer only its members and
 * a save naming anybody else is refused. Whoever has it already keeps it — the rule is about who is given it next.
 * A company's creator still becomes its account manager, and imports bring the old system's people as they were.
 */

/** For each role, the departments ticked for it — null where none is, and anyone may be given it. Once a request. */
export const assignTeams = cache(async (): Promise<Record<AssignRole, Set<string> | null>> => {
  const open = { leadOwner: null, caller: null, accountManager: null, renewalManager: null };
  let rows: { id: string; callerTeam: boolean; accountManagerTeam: boolean; renewalManagerTeam: boolean }[];
  try {
    rows = await db.department.findMany({
      where: { OR: [{ callerTeam: true }, { accountManagerTeam: true }, { renewalManagerTeam: true }] },
      select: { id: true, callerTeam: true, accountManagerTeam: true, renewalManagerTeam: true },
    });
  } catch (err) {
    // A workspace not migrated to 20261130190000_department_assign_teams yet: nothing ticked.
    if (notMigratedYet(err)) return open;
    throw err;
  }
  // The lead owner's tick came later (20261221600000_department_lead_owner_team), so it is read on its own: a workspace
  // without it yet has no department ticked for leads, and the other three still hold.
  let leadOwnerIds: string[] = [];
  try {
    leadOwnerIds = (await db.department.findMany({ where: { leadOwnerTeam: true }, select: { id: true } })).map((d) => d.id);
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  const teams = (role: Exclude<AssignRole, "leadOwner">) => {
    const ids = rows.filter((d) => d[ASSIGN_ROLES[role].flag as "callerTeam" | "accountManagerTeam" | "renewalManagerTeam"]).map((d) => d.id);
    return ids.length ? new Set(ids) : null;
  };
  return { leadOwner: leadOwnerIds.length ? new Set(leadOwnerIds) : null, caller: teams("caller"), accountManager: teams("accountManager"), renewalManager: teams("renewalManager") };
});

export type Takes = Record<AssignRole, boolean>;

/** What a person of this department may be given. */
export function takesOf(teams: Record<AssignRole, Set<string> | null>, departmentId: string | null): Takes {
  const may = (role: AssignRole) => !teams[role] || (!!departmentId && teams[role]!.has(departmentId));
  return { leadOwner: may("leadOwner"), caller: may("caller"), accountManager: may("accountManager"), renewalManager: may("renewalManager") };
}

/** Why this person can't be given the role, in words — or null when they may. */
export async function assignRefusal(role: AssignRole, userId: string): Promise<string | null> {
  const teams = await assignTeams();
  const team = teams[role];
  if (!team) return null;
  const person = await db.user.findUnique({ where: { id: userId }, select: { name: true, departmentId: true } });
  if (person?.departmentId && team.has(person.departmentId)) return null;
  const names = (await db.department.findMany({ where: { id: { in: [...team] } }, orderBy: { name: "asc" }, select: { name: true } })).map((d) => d.name);
  return `${person?.name ?? "That person"} can't be ${ASSIGN_ROLES[role].label.toLowerCase()} — only someone in ${names.join(" or ")} (Settings › Departments).`;
}
