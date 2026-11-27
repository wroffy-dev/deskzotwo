import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can, resolveUserPermissions } from "@/lib/authz/resolve";
import { getPermissionDefinition, type PermissionKey } from "@/lib/permissions";
import type { AccessRecord } from "@/lib/authz/access";

/**
 * The rules that are code, not configuration.
 *
 * Everything else in this module is a setting an admin can change. These are not, and that is the
 * point: a control you can switch off from inside the application is a control that eventually
 * gets switched off. There is exactly one active admin on this installation, so "the last one is
 * demoted by accident" is not a hypothetical — it is one careless click from being the end of
 * anybody administering anything.
 */

export class AuthzError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AuthzError";
  }
}

/**
 * Refuses to let the last super admin disappear.
 *
 * Runs inside the caller's transaction, so the check and the write cannot be separated by another
 * request doing the same thing. Two admins demoting each other simultaneously would otherwise both
 * see "one other remains" and both succeed.
 *
 * Note the shape of the query. `SELECT count(*) ... FOR UPDATE` is not valid Postgres — row locking
 * is rejected with an aggregate — so the rows are selected and locked, and counted here. Dropping
 * `FOR UPDATE` instead would compile and reintroduce exactly the race this exists to prevent.
 */
export async function assertSuperAdminRemains(tx: Prisma.TransactionClient, excludingUserId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "users"
    WHERE "isSuperAdmin" = true AND "active" = true AND "id" <> ${excludingUserId}
    FOR UPDATE
  `;
  if (rows.length === 0) {
    throw new AuthzError(
      "That would leave nobody with super admin access, and nobody could put it back. Promote someone else first.",
    );
  }
}

/**
 * An ordinary admin may not act on a super admin.
 *
 * Without this, the tier is decorative: an admin could simply deactivate the super admin and
 * inherit an unguarded system.
 */
export function assertMayActOnTarget(
  actor: { id: string; isSuperAdmin: boolean },
  target: { id: string; isSuperAdmin: boolean },
) {
  if (target.isSuperAdmin && !actor.isSuperAdmin) {
    throw new AuthzError("Only a super admin can change another super admin's account.");
  }
}

/**
 * Nobody changes their own role, super-admin flag or active status.
 *
 * Generalises the existing self-deactivation guard, whose absence on the *role* path was the
 * two-click lockout: the sole admin demotes themselves to SALES and there is no longer any account
 * that can undo it.
 */
export function assertNotSelf(actorId: string, targetId: string, what: string) {
  if (actorId === targetId) {
    throw new AuthzError(`You can't change your own ${what}. Ask another admin.`);
  }
}

/**
 * You may only grant what you hold yourself.
 *
 * This is the rule that stops delegation from being escalation. Without it, the moment a super
 * admin grants somebody the ability to manage permissions, that person can grant themselves
 * everything else — and `permissions.manage` becomes a synonym for super admin.
 */
export async function assertGrantWithinOwnAuthority(
  actor: { id: string; isSuperAdmin: boolean },
  key: PermissionKey | string,
) {
  if (actor.isSuperAdmin) return;

  const def = getPermissionDefinition(key);
  if (!def) throw new AuthzError(`Unknown permission "${key}".`);

  if (def.superAdminOnly) {
    throw new AuthzError(`"${def.label}" can only be granted by a super admin.`);
  }
  if (def.adminOnly) {
    // The role is the subject (kept in Phase 2, audit L-7): `adminOnly` means "an admin or the super admin" gives it.
    const row = await db.user.findUnique({ where: { id: actor.id }, select: { role: true } });
    if (row?.role !== "ADMIN") throw new AuthzError(`"${def.label}" can only be given by an admin or the super admin.`);
  }
  if (!(await can(actor.id, key))) {
    throw new AuthzError(`You can't grant "${def.label}" because you don't hold it yourself.`);
  }
}

/**
 * The two keys that open and change the access screens. Taking either away from your own role is a
 * door you shut behind yourself: without View, Staff & roles no longer opens for you; without Change,
 * it opens read-only. Either way the change can't be undone from where it was made.
 */
export const OWN_ACCESS_KEYS = ["permissions.view", "permissions.manage"] as const;

/**
 * Nobody takes away their own way into the access screens through their role.
 *
 * The role path's version of `assertNotSelf`: somebody holding `permissions.manage` through their
 * role could untick it, or "Review who can do what", for that role and lock themselves out with it —
 * and if they were the only one holding it, nobody but the super admin could put it back. Refused
 * only when they hold the key *through that role*; somebody who also holds it personally keeps it
 * whatever the role says, so for them the change is just a change. A super admin holds everything
 * outside the permission system and is never caught by this.
 *
 * `allowedAfter` is what the role will grant once the change is made.
 */
export async function assertKeepsOwnAccessAdmin(
  actor: { id: string; role: string; isSuperAdmin: boolean },
  role: string,
  key: PermissionKey | string,
  allowedAfter: boolean,
) {
  if (actor.isSuperAdmin || allowedAfter || actor.role !== role) return;
  if (!(OWN_ACCESS_KEYS as readonly string[]).includes(key)) return;
  const resolved = await resolveUserPermissions(actor.id);
  const source = resolved.sources.get(key);
  const throughRole =
    source?.via === "roleDefault" ||
    source?.via === "adminDefault" ||
    (source?.via === "roleOverride" && source.allowed);
  if (!throughRole) return;
  const def = getPermissionDefinition(key);
  throw new AuthzError(
    `You can't take "${def?.label ?? key}" away from your own role — you'd lose the access you need to put it back. Ask another admin.`,
  );
}

/**
 * Separation of duties, as a property of the permission rather than a rule each action re-remembers.
 *
 * `selfExcluded` keys are the ones where approving your own work defeats the point — an order you
 * punched, an expense you claimed, an incentive you earned.
 *
 * `superAdmin`: the workspace's super admin, acting as themselves (`actingAsSuperAdmin`), may (owner, 13 Nov 2026:
 * "super admin can") — there is nobody above them to ask. Never while viewing as somebody else.
 */
export function assertNotOwnRecord(key: PermissionKey | string, actorId: string, recordOwnerId: string | null, superAdmin = false) {
  const def = getPermissionDefinition(key);
  if (!def?.selfExcluded || superAdmin) return;
  if (recordOwnerId && recordOwnerId === actorId) {
    throw new AuthzError(`You can't ${def.label.toLowerCase()} on something you raised yourself.`);
  }
}

/** The actor's own authorization facts, read from the database rather than the session token. */
export async function actorContext(userId: string) {
  const row = await db.user.findUnique({
    where: { id: userId },
    select: { id: true, name: true, role: true, active: true, isSuperAdmin: true },
  });
  if (!row) throw new AuthzError("That account no longer exists.");
  return row;
}

/**
 * What the built-in Employee role starts with, none of it over the business's records: the person's own pages, the
 * copilot (which only sees and does what they already can), and `commissions.view`, which every role was given when the
 * right was split out (20261201410000_view_rights_split) and which only shows on a customer's page, whose section
 * Employee starts without. A role built by hand holds few of these, and so could give nobody this role.
 */
const EMPLOYEE_STARTING_KEYS: ReadonlySet<string> = new Set([
  "copilot.use",
  "commissions.view",
  "section.hr",
  "section.payroll",
  "section.expenses",
  "section.engagement",
  "section.notifications",
  "section.tasks",
  "section.desks",
  "section.calendar",
  "section.notes",
  "section.chat",
  "section.cards",
]);

/**
 * Nobody makes an account start with more than they hold themselves.
 *
 * But for the Employee role's starting rights (owner, 4 Nov 2026): whoever may add people may always add a new joiner
 * as an Employee, and somebody who holds the rest moves them on from there. Anything else ticked on Employee is still
 * checked, so filling that role up doesn't open a way round this.
 *
 * The role's grants as the resolver reads them — its stored answers over its defaults
 * (src/lib/authz/role-permission.ts `roleGrants`) — not the registry's defaults alone: a custom role,
 * or a built-in one filled in from the role screen or a preset, would otherwise pass with no check at
 * all, and somebody holding only `users.manage` could mint an account on a role far above their own.
 *
 * The same rule for moving somebody who already has an account into a role (`moving`: their name, for the
 * refusal) — the single edit, the bulk bar and the users import (owner, 2 Nov 2026 — "Phase 1 security
 * fixes", audit H-1). Creating was checked and changing wasn't, so the way round it was two steps: make
 * a low account, then move it into Admin, or into any role holding keys you were denied.
 */
export async function assertMayStartInRole(actor: { id: string; isSuperAdmin: boolean }, role: string, moving?: { name: string }) {
  if (role !== "EMPLOYEE" && (await startsEmployeesOnly(actor))) {
    throw new AuthzError("You can only start people as an Employee. Ask an admin to create an account in any other role.");
  }
  const [first] = await rightsBeyond(actor, role);
  if (!first) return;
  throw new AuthzError(
    moving
      ? `${role} holds "${first}", which you don't hold yourself, so you can't move ${moving.name} into it. Ask somebody who does.`
      : `A ${role} account starts with "${first}", which you don't hold yourself. Ask somebody who does to create it.`,
  );
}

/**
 * Whether Employee is the one role this person may start somebody in (owner, 4 Nov 2026: "only role hr can assign should
 * be employee only"). Adding people is one thing and deciding what they can do is another: the second stays with a super
 * admin, an Admin, and whoever a super admin gave "Change somebody's role" — the key that already means it.
 */
export async function startsEmployeesOnly(actor: { id: string; isSuperAdmin: boolean }): Promise<boolean> {
  if (actor.isSuperAdmin) return false;
  const { role } = await actorContext(actor.id);
  if (role === "ADMIN") return false;
  return !(await can(actor.id, "users.assignRole"));
}

/**
 * The rights a role would give that this person can't: what `assertMayStartInRole` refuses over, by label. The add-a-person
 * form names them, so a role missing from its list has a reason anybody can act on (owner, 4 Nov 2026).
 */
export async function rightsBeyond(actor: { id: string; isSuperAdmin: boolean }, role: string): Promise<string[]> {
  if (actor.isSuperAdmin) return [];
  const { roleGrants } = await import("@/lib/authz/role-permission");
  const { PERMISSIONS } = await import("@/lib/permissions");
  const grants = await roleGrants(role);
  const beyond: string[] = [];
  for (const def of PERMISSIONS) {
    if (!grants(def.key)) continue;
    if (role === "EMPLOYEE" && EMPLOYEE_STARTING_KEYS.has(def.key)) continue;
    if (def.superAdminOnly || !(await can(actor.id, def.key))) beyond.push(def.label);
  }
  return beyond;
}

/**
 * A switched-off role is given to nobody (src/actions/role.ts `setRoleActive`), and neither is a hidden one —
 * platform support's read-only role, or any other the role listings leave out (src/lib/authz/role-registry.ts
 * `roleIsHidden`; owner, 2 Nov 2026 — "Phase 1 security fixes", audit H-2). `assertMayStartInRole` can't
 * catch that one: the role's stored grants are sections only, and the resolver gives it every view key on
 * top. The platform's own provisioning writes the role itself and never comes through here.
 */
export async function assertRoleAssignable(role: string) {
  const { roleIsActive, roleIsHidden } = await import("@/lib/authz/role-registry");
  if (await roleIsHidden(role)) throw new AuthzError("That role is kept for the platform's own support staff and can't be given to anybody. Choose another.");
  if (!(await roleIsActive(role))) throw new AuthzError("That role is switched off. Switch it on, or choose another.");
}

/** Everybody from `from` up the reporting line, nearest first — cycle-safe and capped, as `wouldCreateCycle` is. */
async function reportingChain(from: string | null): Promise<string[]> {
  const chain: string[] = [];
  let current = from;
  while (current && !chain.includes(current) && chain.length < 32) {
    chain.push(current);
    const row: { managerId: string | null } | null = await db.user.findUnique({ where: { id: current }, select: { managerId: true } });
    current = row?.managerId ?? null;
  }
  return chain;
}

/**
 * Who somebody reports to changes only within the changer's own reach (owner, 2 Nov 2026 — "Phase 1
 * security fixes", audit M-5).
 *
 * The reporting line is what "Team" reaches (src/lib/authz/access.ts): putting somebody under a new manager
 * gives that manager — and everybody above them who didn't have the person already — the person's records
 * and their reports', wherever they reach at Team level (and what a line manager sees beyond records). So
 * the move is checked as the grant it is, by the two rules every other grant follows:
 *
 *   1. Nobody widens their own reach. You can't bring somebody into your own reporting line — under you, or
 *      under anybody who reports up to you — unless they're in it already (moving people about inside your
 *      own team changes nothing you see). Another admin can.
 *   2. Nobody grants wider than they reach. Everybody who gains the person must reach at Team level only
 *      where you reach Team or wider yourself — the rule setting a level applies (`within`, as
 *      src/actions/person-access.ts asks it, "as the account" counting as All for somebody who reaches
 *      every account).
 *
 * Before either, the rule for any account: an ordinary admin can't act on the super admin. Taking a
 * manager away gives nobody anything, so only that rule applies to it; a super admin reaches everything
 * and is never caught. `target.id` is null for an account not made yet (a new row of the users import).
 *
 * `succeeding`: the person whose reports these were, when a team passes to a successor — a handover, or an
 * employee record moving to another account (owner, 3 Nov 2026 — Phase 2 permission fixes, audit M-5
 * follow-up). Rule 2 then also lets through a Team reach that person had over them: the team was already
 * seen that widely, by its manager, so passing it on is succession, not a new grant — and HR, which hands
 * teams over without reaching sales records itself, can still hand a sales manager's team to the next one.
 * Rule 1 is unchanged: nobody hands a team into their own line.
 */
export async function assertMayChangeManager(
  actor: { id: string; isSuperAdmin: boolean },
  target: { id: string | null; name: string; isSuperAdmin: boolean; managerId: string | null },
  managerId: string | null,
  opts: { succeeding?: string } = {},
) {
  if (target.id) assertMayActOnTarget(actor, { id: target.id, isSuperAdmin: target.isSuperAdmin });
  if (actor.isSuperAdmin || !managerId || managerId === target.managerId) return;

  const already = new Set(await reportingChain(target.managerId));
  const gainers = (await reportingChain(managerId)).filter((id) => id !== target.id && !already.has(id));
  if (gainers.includes(actor.id)) {
    throw new AuthzError(`You can't put ${target.name} into your own reporting line — that widens what you see yourself. Ask another admin.`);
  }

  const { resolveAccess, accessRecordDefinition } = await import("@/lib/authz/access");
  const { within } = await import("@/lib/authz/level-order");
  type Levels = Awaited<ReturnType<typeof resolveAccess>>["levels"];
  const reachIn = (levels: Levels, slot: string) => {
    const level = levels.get(slot)?.level ?? "NONE";
    return level === "FOLLOW" && levels.get(`companies:${slot.split(":")[1]}`)?.level === "ALL" ? "ALL" : level;
  };
  const own = (await resolveAccess(actor.id)).levels;
  const predecessor = opts.succeeding ? (await resolveAccess(opts.succeeding)).levels : null;
  const covered = (slot: string) => within("TEAM", reachIn(own, slot)) || (!!predecessor && within("TEAM", reachIn(predecessor, slot)));
  for (const id of gainers) {
    for (const [slot, { level }] of (await resolveAccess(id)).levels) {
      if (level !== "TEAM" || covered(slot)) continue;
      const [record, action] = slot.split(":");
      const label = accessRecordDefinition(record as AccessRecord).label.toLowerCase();
      const who = (await db.user.findUnique({ where: { id }, select: { name: true } }))?.name ?? "The new manager";
      throw new AuthzError(
        `${who} reaches ${label} (${action}) by team, wider than you reach them yourself, so you can't put ${target.name} under ${id === managerId ? "them" : "somebody who reports to them"}. Ask somebody who reaches that widely.`,
      );
    }
  }
}
