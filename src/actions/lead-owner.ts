"use server";

import { db } from "@/lib/db";
import { requireModuleAccess } from "@/lib/modules-access";
import { leadAccess } from "@/lib/authz/access";
import { mayChangeLeadOwner, mayLeaveUnassigned, reassignRights } from "@/lib/authz/reassign";
import { notMigratedYet } from "@/lib/not-migrated";
import { PEOPLE_ONLY } from "@/lib/people";
import { assignTeams } from "@/lib/companies/assign-teams";
import { viewAsContext } from "@/lib/session";

/**
 * Who a lead is with, on the lead itself (owner, 26 Oct 2026): whether the viewer may hand it to somebody else —
 * the reassign rules every screen uses (src/lib/authz/reassign-rules.ts): anybody's lead with "Reassign accounts
 * & leads" (sales heads and admins have it), their own with "Hand off their own" — and who has had it before.
 * The change itself goes through the leads list's own action (`bulkUpdateLeads`), which asks all of it again.
 */

export type LeadOwnership = {
  mayChange: boolean;
  mayUnassign: boolean;
  people: { id: string; name: string }[];
  history: { userId: string | null; name: string | null; assignedAt: Date; respondedAt: Date | null; endedAt: Date | null; timedOut: boolean }[];
};

export async function leadOwnership(leadId: string): Promise<LeadOwnership | null> {
  const user = await requireModuleAccess("leads");
  const lead = await db.lead.findFirst({ where: { AND: [{ id: leadId }, await leadAccess(user.id, "view")] }, select: { id: true, ownerUserId: true } });
  if (!lead) return null;
  // Somebody viewing as a colleague reads, and changes nothing.
  const viewingAs = !!(await viewAsContext());
  const [rights, mayAssignHere] = await Promise.all([
    reassignRights(user.id),
    db.lead.count({ where: { AND: [{ id: leadId }, await leadAccess(user.id, "assign")] } }).then((n) => n > 0),
  ]);
  const mayChange = !viewingAs && mayAssignHere && mayChangeLeadOwner(rights, user.id, lead);
  // Only who may own a lead (Settings › Departments — src/lib/companies/assign-teams.ts); none ticked, anyone.
  const leadTeam = mayChange ? (await assignTeams()).leadOwner : null;
  const people = mayChange
    ? await db.user.findMany({ where: { active: true, ...PEOPLE_ONLY, ...(leadTeam ? { departmentId: { in: [...leadTeam] } } : {}) }, orderBy: { name: "asc" }, select: { id: true, name: true } })
    : [];

  let history: LeadOwnership["history"] = [];
  try {
    const rows = await db.leadAssignment.findMany({
      where: { leadId },
      orderBy: { assignedAt: "desc" },
      take: 10,
      select: { userId: true, assignedAt: true, respondedAt: true, endedAt: true, timedOutAt: true, user: { select: { name: true } } },
    });
    history = rows.map((r) => ({ userId: r.userId, name: r.user?.name ?? null, assignedAt: r.assignedAt, respondedAt: r.respondedAt, endedAt: r.endedAt, timedOut: !!r.timedOutAt }));
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  return { mayChange, mayUnassign: mayChange && mayLeaveUnassigned(rights), people, history };
}
