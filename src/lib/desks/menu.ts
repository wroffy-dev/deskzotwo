import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { CLOSED, deskLabel, deskPath } from "./rules";

/** What the menu shows: whether there's a desk to ask, and the desks this person works at — every one, for the super admin. */
export async function deskMenu(userId: string): Promise<{ open: boolean; desks: { href: string; label: string }[] }> {
  try {
    const u = await db.user.findUnique({ where: { id: userId }, select: { departmentId: true, active: true, kind: true, isSuperAdmin: true } });
    if (!u?.active || u.kind !== "MEMBER") return { open: false, desks: [] };
    const [live, mine] = await Promise.all([
      db.desk.count({ where: { active: true, department: { members: { some: { active: true, kind: "MEMBER" } } } } }),
      u.isSuperAdmin
        ? db.desk.findMany({ where: { OR: [{ active: true }, { requests: { some: { status: { notIn: CLOSED } } } }] }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { seq: true, name: true } })
        : u.departmentId
          ? db.desk.findMany({ where: { departmentId: u.departmentId, OR: [{ active: true }, { requests: { some: {} } }] }, orderBy: [{ sortOrder: "asc" }, { name: "asc" }], select: { seq: true, name: true } })
          : [],
    ]);
    // Somebody whose only desk was switched off still has their own requests to read.
    const open = live > 0 || (await db.deskRequest.count({ where: { requesterId: userId } })) > 0;
    return { open, desks: mine.map((d) => ({ href: deskPath(d.seq), label: deskLabel(d.name) })) };
  } catch (err) {
    if (notMigratedYet(err)) return { open: false, desks: [] };
    throw err;
  }
}
