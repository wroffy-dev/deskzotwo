import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { ADMIN_ROLE, SUPPORT_READONLY_ROLE, type Role } from "@/lib/roles";

/**
 * The roles that exist, read from the database.
 *
 * This is the half of `src/lib/roles.ts` that needs a query, and it lives apart from it for the
 * reason that file's own header gives: `roles.ts` holds constants a form may import, so pulling
 * Prisma in behind it would drag the client, bcrypt and the whole server surface into the bundle of
 * every page with a role dropdown. The same split as `fingerprint.ts` and `policy.ts`.
 *
 * There is no cache. The list is eight rows on a screen that is not hot, and a stale one is the
 * specific failure this feature exists to remove — an admin creates a role and it does not appear
 * in the dropdown they created it for.
 */
export type RoleSummary = {
  key: Role;
  name: string;
  description: string | null;
  isSystem: boolean;
  sortOrder: number;
};

export async function listRoles(): Promise<RoleSummary[]> {
  return db.role.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: { key: true, name: true, description: true, isSystem: true, sortOrder: true },
  });
}

/** Just the keys, in the same order, for the places that only need the columns of a matrix. */
export async function roleKeys(): Promise<Role[]> {
  return (await listRoles()).map((r) => r.key);
}

/**
 * Whether a role key names a role that exists.
 *
 * The check the compiler used to do. `Role` was a union of eight literals, so a typo was a build
 * error; roles are rows now and no union can describe them, so the same mistake has to be caught
 * here and by the foreign key on `users.role` underneath it.
 */
export async function roleExists(key: string): Promise<boolean> {
  if (!key) return false;
  return (await db.role.count({ where: { key } })) > 0;
}

/**
 * How many people hold each role: everybody, and how many of them are switched off.
 *
 * Needed wherever a role is about to be deleted or emptied, and worth showing beside the name on
 * the roles screen: "Sales — 39 people" is the number that makes somebody think twice before
 * revoking a permission from it. Somebody switched off still holds it, so it can't be deleted, but a screen
 * doesn't count them as one of its people (owner, 25 Nov 2026).
 */
export async function roleHeadcount(): Promise<Record<string, { all: number; switchedOff: number }>> {
  const rows = await db.user.groupBy({ by: ["role", "active"], _count: { _all: true } });
  const counts: Record<string, { all: number; switchedOff: number }> = {};
  for (const r of rows) {
    const c = (counts[r.role] ??= { all: 0, switchedOff: 0 });
    c.all += r._count._all;
    if (!r.active) c.switchedOff += r._count._all;
  }
  return counts;
}

/**
 * The roles switched off (`Role.active`). Read by name and on its own, so a workspace whose database
 * hasn't got the column yet reads as having every role on.
 */
export async function inactiveRoleKeys(): Promise<Set<string>> {
  try {
    const rows = await db.role.findMany({ where: { active: false }, select: { key: true } });
    return new Set(rows.map((r) => r.key));
  } catch (err) {
    if (notMigratedYet(err)) return new Set();
    throw err;
  }
}

/** Whether a role is switched on — false for one that doesn't exist. */
export async function roleIsActive(key: string): Promise<boolean> {
  if (!key) return false;
  try {
    const row = await db.role.findUnique({ where: { key }, select: { active: true } });
    return row?.active ?? false;
  } catch (err) {
    if (notMigratedYet(err)) return roleExists(key);
    throw err;
  }
}

/**
 * The roles that are rows but nobody in the workspace gives to anybody: platform support's read-only role.
 * Its holders are let in by the platform on the workspace's grant (src/lib/platform/support.ts
 * `enterAsSupport`, which writes the role itself), and the resolver hands it every view key
 * (src/lib/authz/resolve.ts) — so given to an ordinary account from Users or an import, it was an account
 * that reads everything, made by somebody who holds `users.manage` (owner, 2 Nov 2026 — "Phase 1 security
 * fixes", audit H-2).
 */
export const HIDDEN_ROLE_KEYS: ReadonlySet<string> = new Set([SUPPORT_READONLY_ROLE]);

/**
 * Whether a role is hidden: one of the above, or any other role that exists but that the role listings
 * leave out (src/lib/db.ts `withoutSupport`). Asked of the listing itself, so a role somebody hides there
 * later is refused here without anybody remembering to add it — a role nobody is offered is a role nobody
 * may give. A role that doesn't exist isn't hidden; it's refused as missing.
 */
export async function roleIsHidden(key: string): Promise<boolean> {
  if (!key) return false;
  if (HIDDEN_ROLE_KEYS.has(key)) return true;
  if (!(await roleExists(key))) return false;
  return !(await listRoles()).some((r) => r.key === key);
}

export { ADMIN_ROLE };
