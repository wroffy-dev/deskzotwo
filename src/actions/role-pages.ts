"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser } from "@/lib/session";
import { roleExists } from "@/lib/authz/role-registry";
import { can } from "@/lib/authz/resolve";
import { actorContext, assertGrantWithinOwnAuthority, AuthzError } from "@/lib/authz/guards";
import { recordAudit } from "@/lib/audit";
import { MENU_PAGES } from "@/lib/staff/menu-pages";
import type { ActionResult } from "@/actions/company";

/**
 * A role's per-page tick (owner, 2 Nov 2026 — "per-page ticks"): hide one menu page from it, or show it again.
 * The same rules as the role's section switches (`setRolePermissions`): Manage permissions, Admin only by a super
 * admin, and only a page whose section the person changing it holds themselves.
 */
export async function setRolePageHidden(roleKey: string, href: string, hidden: boolean): Promise<ActionResult<null>> {
  const session = await requireUser();
  const actor = await actorContext(session.id);
  if (!actor.isSuperAdmin && !(await can(actor.id, "permissions.manage"))) return { ok: false, error: "You can't change role permissions." };
  if (roleKey === "ADMIN" && !actor.isSuperAdmin) return { ok: false, error: "Only a super admin can change what admins can do." };
  if (!(await roleExists(String(roleKey ?? "")))) return { ok: false, error: "That role no longer exists." };
  const page = MENU_PAGES.find((p) => p.href === href);
  if (!page) return { ok: false, error: "That page isn't in the menu." };
  try {
    await assertGrantWithinOwnAuthority(actor, page.section);
  } catch (err) {
    if (err instanceof AuthzError) return { ok: false, error: err.message };
    throw err;
  }

  if (hidden) {
    await db.roleHiddenPage.upsert({
      where: { roleKey_href: { roleKey, href } },
      update: {},
      create: { roleKey, href, createdById: actor.id },
    });
  } else {
    await db.roleHiddenPage.deleteMany({ where: { roleKey, href } });
  }
  await recordAudit({
    userId: actor.id,
    action: "UPDATE",
    entityType: "Role",
    entityId: roleKey,
    entityLabel: `${hidden ? "Hid" : "Showed"} ${page.label} (${href}) for the ${roleKey} role`,
  });
  revalidatePath("/settings/access", "layout");
  return { ok: true, data: null };
}
