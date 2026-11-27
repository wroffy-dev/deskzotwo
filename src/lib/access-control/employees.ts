import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { PEOPLE_ONLY } from "@/lib/people";
import { AWAITING_SETUP } from "@/lib/no-password";
import { PERMISSIONS } from "@/lib/permissions";
import { holdsFrom, resolveEveryone } from "@/lib/authz/bulk";

/**
 * What the Employee-Specific Permissions screens read past the roster and the per-person actions:
 * how many exceptions each person has of each kind, how many sensitive permissions each holds, and
 * the facts at the top of one person's page.
 *
 * Server-only, like ./overview.ts: not `"use server"`, so nothing here is an endpoint. The pages check
 * `permissions.view` before calling it. Reads only — every change goes through the existing actions.
 */

/** The permissions the registry marks sensitive or critical: what "Sensitive access" counts. */
export const SENSITIVE_PERMISSIONS = PERMISSIONS.filter((d) => d.tier === "sensitive" || d.tier === "critical");

export type ExceptionCounts = {
  /** In force now: permission exceptions, record levels, field policies, and a daily limit of their own. */
  permissions: number;
  levels: number;
  fields: number;
  limit: number;
  /** Of those in force, the ones with an end date. */
  temporary: number;
  /** Still stored, no longer in force: their end date has passed. */
  lapsed: number;
  /** Something in force ends within a week. */
  endingSoon: boolean;
};

const SOON_MS = 7 * 86_400_000;

function emptyCounts(): ExceptionCounts {
  return { permissions: 0, levels: 0, fields: 0, limit: 0, temporary: 0, lapsed: 0, endingSoon: false };
}

/** A table added by a later migration reads as empty on a workspace that hasn't got it yet. */
async function orNone<T>(query: Promise<T[]>): Promise<T[]> {
  try {
    return await query;
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/**
 * Every person's exceptions to their role, counted by kind — four queries for the whole list. An
 * exception is a stored fact (`UserPermission`, `UserAccessLevel`, `UserFieldPolicy`,
 * `UserUnmaskLimit`); one past its end date is counted apart, as the resolver no longer applies it.
 */
export async function exceptionCountsByUser(userId?: string): Promise<Map<string, ExceptionCounts>> {
  const where = userId ? { userId } : {};
  const select = { userId: true, expiresAt: true } as const;
  const [permissions, levels, fields, limits] = await Promise.all([
    db.userPermission.findMany({ where, select }),
    orNone(db.userAccessLevel.findMany({ where, select })),
    orNone(db.userFieldPolicy.findMany({ where, select })),
    orNone(db.userUnmaskLimit.findMany({ where, select })),
  ]);
  const now = Date.now();
  const out = new Map<string, ExceptionCounts>();
  const add = (kind: "permissions" | "levels" | "fields" | "limit", rows: { userId: string; expiresAt: Date | null }[]) => {
    for (const row of rows) {
      const counts = out.get(row.userId) ?? emptyCounts();
      out.set(row.userId, counts);
      if (row.expiresAt && row.expiresAt.getTime() <= now) {
        counts.lapsed += 1;
        continue;
      }
      counts[kind] += 1;
      if (row.expiresAt) {
        counts.temporary += 1;
        if (row.expiresAt.getTime() - now <= SOON_MS) counts.endingSoon = true;
      }
    }
  };
  add("permissions", permissions);
  add("levels", levels);
  add("fields", fields);
  add("limit", limits);
  return out;
}

/** How many sensitive and critical permissions each person holds, from one resolution of everybody. */
export async function sensitiveHeldByUser(): Promise<Map<string, number>> {
  const everyone = await resolveEveryone();
  const out = new Map<string, number>();
  for (const [userId, resolved] of everyone) {
    let held = 0;
    for (const def of SENSITIVE_PERMISSIONS) if (holdsFrom(resolved.sources.get(def.key))) held += 1;
    out.set(userId, held);
  }
  return out;
}

export type EmployeeFacts = {
  id: string;
  name: string;
  email: string;
  role: string;
  roleName: string;
  roleDescription: string | null;
  active: boolean;
  isSuperAdmin: boolean;
  /** Nobody has chosen a password for the account yet. */
  setupPending: boolean;
  departmentId: string | null;
  departmentName: string | null;
  managerId: string | null;
  managerName: string | null;
  /** Their designation on the HR record. */
  jobTitle: string | null;
};

/** One person, for the top of their page — or null for nobody, and for the accounts that are nobody's. */
export async function employeeFacts(id: string): Promise<EmployeeFacts | null> {
  const person = await db.user.findFirst({
    where: { id, ...PEOPLE_ONLY },
    select: {
      id: true,
      name: true,
      email: true,
      role: true,
      active: true,
      isSuperAdmin: true,
      departmentId: true,
      managerId: true,
      department: { select: { name: true } },
      manager: { select: { name: true } },
      roleRef: { select: { name: true, description: true } },
      employeeProfile: { select: { designation: true } },
    },
  });
  if (!person) return null;
  const pending = await db.user.count({ where: { AND: [{ id: person.id, ...PEOPLE_ONLY }, AWAITING_SETUP] } });
  return {
    id: person.id,
    name: person.name,
    email: person.email,
    role: person.role,
    roleName: person.isSuperAdmin ? "Super Admin" : person.roleRef.name,
    roleDescription: person.roleRef.description,
    active: person.active,
    isSuperAdmin: person.isSuperAdmin,
    setupPending: pending > 0,
    departmentId: person.departmentId,
    departmentName: person.department?.name ?? null,
    managerId: person.managerId,
    managerName: person.manager?.name ?? null,
    jobTitle: person.employeeProfile?.designation?.trim() || null,
  };
}
