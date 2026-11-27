import { db } from "@/lib/db";
import { resolveEveryone, holdsFrom } from "@/lib/authz/bulk";
import { getPermissionDefinition } from "@/lib/permissions";
import { businessDate } from "@/lib/authz/unmask";

/**
 * What the Access Control overview shows, read in one pass. Not an action: the page checks
 * `permissions.view` before calling it, and nothing here is reachable from the browser.
 */

/** The doors worth a glance on the overview: taking data out, bringing it in, and changing access itself. */
const SENSITIVE_KEYS = ["data.exportCrm", "data.exportFinance", "data.exportPeople", "data.exportUsers", "data.importCrm", "permissions.manage"] as const;

const SOON_MS = 7 * 86_400_000;
const RECENT_ROLE_MS = 7 * 86_400_000;

export async function accessControlOverview() {
  const now = Date.now();
  const today = await businessDate();
  const [users, roles, grants, usageToday, everyone, recentRoleChanges] = await Promise.all([
    db.user.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, role: true, isSuperAdmin: true } }),
    db.role.findMany({ orderBy: { name: "asc" }, select: { key: true, name: true, isSystem: true, active: true } }),
    db.userPermission.findMany({ select: { userId: true, permission: true, expiresAt: true, user: { select: { name: true, active: true } } } }),
    // One row per person, record and day; a row riding on another record's reveal used no unit.
    db.unmaskUsage.groupBy({ by: ["userId"], where: { businessDate: today, includedWith: null }, _count: { _all: true } }),
    resolveEveryone(),
    db.permissionChange.findMany({
      where: { subjectType: "ROLE", createdAt: { gte: new Date(now - RECENT_ROLE_MS) } },
      orderBy: { createdAt: "desc" },
      select: { subjectRole: true, createdAt: true, actor: { select: { name: true } } },
      take: 200,
    }),
  ]);

  const roleName = new Map(roles.map((r) => [r.key, r.name]));
  const live = grants.filter((g) => g.user.active && (!g.expiresAt || g.expiresAt.getTime() > now));
  const withOverrides = new Set(live.map((g) => g.userId)).size;
  const expiring = live.filter((g) => g.expiresAt && g.expiresAt.getTime() - now <= SOON_MS);

  const headcount = new Map<string, number>();
  for (const u of users) if (!u.isSuperAdmin) headcount.set(u.role, (headcount.get(u.role) ?? 0) + 1);
  const distribution = [...headcount.entries()]
    .map(([key, count]) => ({ key, name: roleName.get(key) ?? key, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));

  const sensitive = SENSITIVE_KEYS.flatMap((key) => {
    const def = getPermissionDefinition(key);
    if (!def) return [];
    const holders = users.filter((u) => holdsFrom(everyone.get(u.id)?.sources.get(key)));
    return [{ key, label: def.label, holders: holders.map((u) => ({ id: u.id, name: u.name })) }];
  });

  const seenRoles = new Set<string>();
  const roleAlerts: { role: string; at: Date; by: string }[] = [];
  for (const c of recentRoleChanges) {
    if (!c.subjectRole || seenRoles.has(c.subjectRole)) continue;
    seenRoles.add(c.subjectRole);
    roleAlerts.push({ role: c.subjectRole, at: c.createdAt, by: c.actor?.name ?? "someone" });
  }

  return {
    kpis: {
      employees: users.length,
      activeRoles: roles.filter((r) => r.active).length,
      customRoles: roles.filter((r) => !r.isSystem).length,
      withOverrides,
      unmasksToday: usageToday.reduce((n, r) => n + r._count._all, 0),
      peopleUnmaskingToday: usageToday.length,
      expiringSoon: expiring.length,
    },
    distribution,
    sensitive,
    expiring: expiring
      .sort((a, b) => a.expiresAt!.getTime() - b.expiresAt!.getTime())
      .slice(0, 6)
      .map((g) => ({ userId: g.userId, name: g.user.name, permission: getPermissionDefinition(g.permission)?.label ?? g.permission, expiresAt: g.expiresAt! })),
    recentRoles: roleAlerts.slice(0, 5).map((r) => ({ ...r, name: roleName.get(r.role) ?? r.role })),
    roleName: Object.fromEntries(roleName),
  };
}
