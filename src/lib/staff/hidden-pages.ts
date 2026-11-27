import { db } from "@/lib/db";
import { pageOf } from "@/lib/staff/menu-pages";

/**
 * The menu pages a person's role doesn't see (owner, 2 Nov 2026 — "per-page ticks"; RoleHiddenPage). Ticked on the
 * role screen under each module's sections; left out of the menu (src/lib/navigation.ts) and refused at the door
 * (src/proxy.ts), as a section switched off is. The super admin is never held to them.
 *
 * Read fresh every time — one indexed query, and a page unticked shows on the next request. A workspace without the
 * table yet hides nothing, as before it.
 */
export async function hiddenPagesFor(userId: string): Promise<string[]> {
  try {
    const rows = await db.roleHiddenPage.findMany({
      where: { role: { users: { some: { id: userId, isSuperAdmin: false } } } },
      select: { href: true },
    });
    return rows.map((r) => r.href);
  } catch {
    return [];
  }
}

/** What one role has hidden, for the role screen. */
export async function hiddenPagesOfRole(roleKey: string): Promise<string[]> {
  try {
    return (await db.roleHiddenPage.findMany({ where: { roleKey }, select: { href: true } })).map((r) => r.href);
  } catch {
    return [];
  }
}

/** Whether this person's role hides the page an address belongs to. */
export async function pageHiddenFor(userId: string, pathname: string): Promise<boolean> {
  const page = pageOf(pathname);
  if (!page) return false;
  return (await hiddenPagesFor(userId)).includes(page);
}
