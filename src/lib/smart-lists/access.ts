import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Who may see a Smart List and fill it in (owner, 20 Nov 2026 — Smart Lists phase 4: "share a list with chosen people or
 * departments only; make some people view-only; optionally let only a row's owner change that row"). The one rule every
 * reader asks — the list's page, its actions, its reminders, mentions, links and the guests' Connect — so nobody sees a
 * list here they couldn't open there.
 *
 *   · Its builder, and whoever holds `workspace.manageAny`: everything, always.
 *   · A private list (`shared` off): nobody else.
 *   · Otherwise, with no access set (`WorkbookAccess`): everyone sees it and fills it in, as Smart Lists always were.
 *   · Set to CHOSEN: only its members — people, or everyone in a department — each to EDIT or only VIEW.
 *   · Set to EVERYONE: everyone, as `everyoneRole` says (EDIT or VIEW); a member's own role wins.
 *   · `rowRule` OWN: each person changes only their own rows — those naming them in a Person column, or, with none chosen,
 *     those they added. Viewers may still comment. Server only.
 */

export type Role = "EDIT" | "VIEW";
export type ListRights = { view: boolean; fill: boolean; shape: boolean; rowRule: "ANY" | "OWN"; ownerPropertyId: string | null };
export const NONE: ListRights = { view: false, fill: false, shape: false, rowRule: "ANY", ownerPropertyId: null };

type Access = { audience: string; everyoneRole: string; rowRule: string; ownerPropertyId: string | null };
type Member = { userId: string | null; departmentId: string | null; role: string };

async function settingsOf(workbookIds: string[]): Promise<{ access: Map<string, Access>; members: Map<string, Member[]> }> {
  const access = new Map<string, Access>();
  const members = new Map<string, Member[]>();
  if (!workbookIds.length) return { access, members };
  try {
    const [a, m] = await Promise.all([
      db.workbookAccess.findMany({ where: { workbookId: { in: workbookIds } }, select: { workbookId: true, audience: true, everyoneRole: true, rowRule: true, ownerPropertyId: true } }),
      db.workbookMember.findMany({ where: { workbookId: { in: workbookIds } }, select: { workbookId: true, userId: true, departmentId: true, role: true } }),
    ]);
    for (const r of a) access.set(r.workbookId, r);
    for (const r of m) (members.get(r.workbookId) ?? members.set(r.workbookId, []).get(r.workbookId)!).push(r);
  } catch (err) {
    // Before the tables arrive no list can have been narrowed.
    if (!notMigratedYet(err)) throw err;
  }
  return { access, members };
}

function decide(user: { id: string; departmentId: string | null }, wb: { shared: boolean; ownerUserId: string }, manageAny: boolean, access: Access | undefined, members: Member[]): ListRights {
  if (wb.ownerUserId === user.id || manageAny) return { view: true, fill: true, shape: true, rowRule: "ANY", ownerPropertyId: null };
  if (!wb.shared) return NONE;
  if (!access) return { view: true, fill: true, shape: false, rowRule: "ANY", ownerPropertyId: null };
  const mine = members.find((m) => m.userId === user.id) ?? (user.departmentId ? members.find((m) => m.departmentId === user.departmentId) : undefined);
  const role = mine ? mine.role : access.audience === "CHOSEN" ? null : access.everyoneRole;
  if (!role) return NONE;
  return { view: true, fill: role === "EDIT", shape: false, rowRule: access.rowRule === "OWN" ? "OWN" : "ANY", ownerPropertyId: access.ownerPropertyId };
}

async function who(userId: string): Promise<{ id: string; departmentId: string | null; manageAny: boolean }> {
  const u = await db.user.findUnique({ where: { id: userId }, select: { departmentId: true } });
  return { id: userId, departmentId: u?.departmentId ?? null, manageAny: await can(userId, "workspace.manageAny") };
}

/** One list's rights for one person. */
export async function rightsFor(userId: string, wb: { id: string; shared: boolean; ownerUserId: string }, known?: { manageAny?: boolean }): Promise<ListRights> {
  const me = await who(userId);
  const { access, members } = await settingsOf([wb.id]);
  return decide(me, wb, known?.manageAny ?? me.manageAny, access.get(wb.id), members.get(wb.id) ?? []);
}

/** Many lists' rights for one person, in two queries — the Smart Lists page, an audience picker. */
export async function rightsForMany(userId: string, lists: { id: string; shared: boolean; ownerUserId: string }[]): Promise<Map<string, ListRights>> {
  const me = await who(userId);
  const { access, members } = await settingsOf(lists.map((l) => l.id));
  return new Map(lists.map((l) => [l.id, decide(me, l, me.manageAny, access.get(l.id), members.get(l.id) ?? [])]));
}

/** Which of `userIds` may see the list — who a comment may mention, who a reminder may reach. */
export async function viewersAmong(wb: { id: string; shared: boolean; ownerUserId: string }, userIds: string[]): Promise<Set<string>> {
  const { access, members } = await settingsOf([wb.id]);
  const users = await db.user.findMany({ where: { id: { in: userIds } }, select: { id: true, departmentId: true } });
  const out = new Set<string>();
  for (const u of users) {
    const manageAny = u.id === wb.ownerUserId ? false : await can(u.id, "workspace.manageAny");
    if (decide({ id: u.id, departmentId: u.departmentId }, wb, manageAny, access.get(wb.id), members.get(wb.id) ?? []).view) out.add(u.id);
  }
  return out;
}

/**
 * Whether a person may change one row under the list's row rule: any row, or — OWN — a row naming them in the chosen
 * Person column, or, with none chosen on a list of its own rows, a row they added.
 */
export async function mayChangeRow(rights: ListRights, userId: string, workbookId: string, own: boolean, rowKey: string): Promise<boolean> {
  if (!rights.fill) return false;
  if (rights.rowRule !== "OWN" || rights.shape) return true;
  if (rights.ownerPropertyId) {
    const cell = own
      ? await db.workbookRowValue.findUnique({ where: { propertyId_rowId: { propertyId: rights.ownerPropertyId, rowId: rowKey } }, select: { value: true } })
      : await db.workbookValue.findUnique({ where: { propertyId_companyId: { propertyId: rights.ownerPropertyId, companyId: rowKey } }, select: { value: true } });
    return cell?.value === userId;
  }
  if (!own) return false;
  const row = await db.workbookRow.findFirst({ where: { id: rowKey, workbookId }, select: { createdByUserId: true } });
  return row?.createdByUserId === userId;
}

export const ROW_NOT_YOURS = "Only the person this row belongs to can change it here.";
export const VIEW_ONLY = "You can look at this list, not change it.";
