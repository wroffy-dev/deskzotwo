"use server";

import { revalidatePath } from "next/cache";
import type { Role } from "@/lib/roles";
import { db } from "@/lib/db";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { roleExists } from "@/lib/authz/role-registry";
import { roleDefault } from "@/lib/authz/role-permission";
import { actorContext, assertGrantWithinOwnAuthority, assertKeepsOwnAccessAdmin, AuthzError } from "@/lib/authz/guards";
import { recordPermissionChange } from "@/lib/authz/audit";
import { getPermissionDefinition } from "@/lib/permissions";
import type { ActionResult } from "@/actions/company";

/**
 * The Module Permission Matrix's Save for a role (Settings › Access Control › Module Matrix).
 *
 * The matrix stages answers and saves them together, and a role's answer has three states — Default
 * (no stored row), Allow and Deny (a stored row) — where `setRolePermissions` (src/actions/permission.ts)
 * only knows two and `resetRolePermission` clears one key at a time. This is those three actions as one
 * step, all or nothing, with every rule they apply and nothing of its own.
 */

export type RoleAnswer = "default" | "allow" | "deny";

/**
 * Several stored answers for one role at once: Allow and Deny write the row (`setRolePermission`),
 * Default removes it (`resetRolePermission`).
 *
 * The same guards as those two, checked for every change before anything is written — "Change roles
 * and permissions"; only a super admin changes what ADMIN holds; nobody grants, revokes or resets a key
 * they don't hold themselves; nobody takes away their own way into the access screens through their
 * role — so a refusal on the fifth cell leaves the first four as they were. An answer already stored as
 * asked is skipped; each one that changes is recorded exactly as the single actions record it.
 */
export async function saveRoleAnswers(role: Role, changes: { key: string; state: RoleAnswer }[]): Promise<ActionResult<{ changed: number }>> {
  const session = await requireUser();
  const actor = await actorContext(session.id);

  if (!actor.isSuperAdmin && !(await can(actor.id, "permissions.manage"))) {
    return { ok: false, error: "You can't change role permissions." };
  }
  // Security audit round three, 14 Nov 2026 (low): never while viewing as somebody.
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (role === "ADMIN" && !actor.isSuperAdmin) {
    return { ok: false, error: "Only a super admin can change what admins can do." };
  }
  if (!(await roleExists(String(role ?? "")))) return { ok: false, error: "That role no longer exists." };

  // The last word for a key wins, as it would have clicking through the matrix.
  const wanted = new Map<string, RoleAnswer>();
  for (const change of Array.isArray(changes) ? changes : []) {
    if (!change || typeof change.key !== "string" || !["default", "allow", "deny"].includes(change.state)) {
      return { ok: false, error: "That isn't a permission change." };
    }
    wanted.set(change.key, change.state);
  }

  const stored = new Map((await db.rolePermission.findMany({ where: { role }, select: { permission: true, allowed: true } })).map((r) => [r.permission, r.allowed]));

  const writes: { key: string; label: string; state: RoleAnswer; before: boolean; after: boolean }[] = [];
  try {
    for (const [key, state] of wanted) {
      const def = getPermissionDefinition(key);
      if (!def) return { ok: false, error: `Unknown permission "${key}".` };
      const row = stored.get(key);
      if (state === "default" ? row === undefined : row === (state === "allow")) continue;
      const byDefault = roleDefault(def, role);
      // What the role grants once this is written — a reset is a grant or a revoke too, whichever way
      // the default points, so it passes the same two checks.
      const after = state === "default" ? byDefault : state === "allow";
      await assertGrantWithinOwnAuthority(actor, key);
      await assertKeepsOwnAccessAdmin(actor, role, key, after);
      writes.push({ key, label: def.label, state, before: row ?? byDefault, after });
    }
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.message };
    throw err;
  }

  if (writes.length === 0) return { ok: true, data: { changed: 0 } };

  await db.$transaction(async (tx) => {
    for (const write of writes) {
      if (write.state === "default") {
        await tx.rolePermission.deleteMany({ where: { role, permission: write.key } });
      } else {
        await tx.rolePermission.upsert({
          where: { role_permission: { role, permission: write.key } },
          update: { allowed: write.after },
          create: { role, permission: write.key, allowed: write.after },
        });
      }
    }
  });

  for (const write of writes) {
    if (write.state === "default") {
      await recordPermissionChange({
        actorUserId: actor.id,
        subjectType: "ROLE",
        subjectRole: role,
        permission: write.key,
        changeKind: "RESET_TO_DEFAULT",
        detail: `${write.key} for ${role} returned to its default`,
      });
    } else {
      await recordPermissionChange({
        actorUserId: actor.id,
        subjectType: "ROLE",
        subjectRole: role,
        permission: write.key,
        fromAllowed: write.before,
        toAllowed: write.after,
        changeKind: write.after ? "GRANT" : "REVOKE",
        detail: `${write.label} for ${role}`,
      });
    }
  }

  revalidatePath("/settings", "layout");
  revalidatePath("/", "layout");
  return { ok: true, data: { changed: writes.length } };
}
