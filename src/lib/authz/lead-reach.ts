import { db } from "@/lib/db";
import { explainAccess, resolveAccess, storedLeadReach, type LeadReach } from "@/lib/authz/access";
import { notMigratedYet } from "@/lib/not-migrated";
import type { LeadReachKey, LeadReachView } from "@/lib/authz/lead-reach-words";

export { LEAD_REACH_KEYS, LEAD_REACH_LABEL, type LeadReachKey, type LeadReachView } from "@/lib/authz/lead-reach-words";

/**
 * Data Scope's two ticks under Leads "as the account" (owner, 26 Nov 2026): whether a role's people — or one person —
 * also reach the leads they own and the leads they made, with their line's (src/lib/authz/access.ts `leadsFollowing`).
 * Both on unless unticked. Saved by `setRoleLeadReach` (src/actions/access-levels.ts) and `setPersonLeadReach`
 * (src/actions/person-access.ts), which hold the rules; this reads, and answers who may tick one on.
 */

/** A role's ticks. */
export async function roleLeadReachView(role: string): Promise<LeadReachView> {
  const r = await storedLeadReach(role, null);
  return { effective: { owned: r.owned, made: r.made }, role: { owned: r.owned, made: r.made }, own: null };
}

/** One person's ticks: their role's, their own, and what applies. */
export async function personLeadReachView(userId: string): Promise<LeadReachView | null> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { role: true } });
  if (!user) return null;
  const [role, effective] = await Promise.all([storedLeadReach(user.role, null), storedLeadReach(user.role, userId)]);
  let own: LeadReachView["own"] = null;
  try {
    const row = await db.userLeadReach.findUnique({ where: { userId }, select: { owned: true, made: true, reason: true } });
    own = row ? { owned: row.owned, made: row.made, reason: row.reason } : null;
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  return { effective: { owned: effective.owned, made: effective.made }, role: { owned: role.owned, made: role.made }, own };
}

/**
 * Whether this admin may tick one on for somebody: nobody gives a reach they haven't got. A super admin may; so may
 * somebody who sees every lead, or every account; or somebody whose own leads reach that way.
 */
export async function mayGiveLeadReach(actorId: string, isSuperAdmin: boolean, key: LeadReachKey): Promise<boolean> {
  if (isSuperAdmin) return true;
  const leads = (await explainAccess(actorId, "leads", "view")).level;
  if (leads === "ALL") return true;
  if (leads !== "FOLLOW") return false;
  if ((await explainAccess(actorId, "companies", "view")).level === "ALL") return true;
  const mine: LeadReach = (await resolveAccess(actorId)).leadReach;
  return mine[key];
}
