import type { GuestActivityKind } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { currentTenantOrNull } from "@/lib/tenancy/resolve";

/**
 * Deskzo Connect, phase 4 (owner, 20 Nov 2026): what guests do, for the activity report — and how many guests the
 * workspace's plan allows (src/lib/platform/entitlements.ts `connectGuestsFrom`: 10 a unit of the add-on, 3 on Deskzo One).
 * Server only.
 */

/** One thing a guest did. Never stops what they were doing: a failed write is let go. */
export async function recordGuestActivity(guestId: string, kind: GuestActivityKind, workbookId: string | null = null): Promise<void> {
  try {
    await db.guestActivity.create({ data: { guestId, kind, workbookId }, select: { id: true } });
  } catch (err) {
    if (!notMigratedYet(err)) console.error("[connect] activity not recorded", err);
  }
}

/** A guest who counts against the allowance: not stopped, access not over, and signed in — or invited and still able to. */
export function countsWhere(now = new Date()) {
  return {
    status: { not: "SUSPENDED" as const },
    OR: [{ accessUntil: null }, { accessUntil: { gt: now } }],
    AND: [{ OR: [{ status: "ACTIVE" as const }, { inviteExpiresAt: { gt: now } }] }],
  };
}

export type GuestAllowance = { limit: number | null; used: number };

/** How many guests the plan allows, and how many count now. Null limit: no limit; 0: Connect isn't in the plan. */
export async function guestAllowance(now = new Date()): Promise<GuestAllowance> {
  const tenant = await currentTenantOrNull().catch(() => null);
  const ent = tenant?.entitlements;
  // Absent — worked out before Connect was sold, or the installation as it was before workspaces: no limit.
  const limit = ent && ent.connectGuests !== undefined ? ent.connectGuests : null;
  const used = await db.guest.count({ where: countsWhere(now) }).catch((err) => {
    if (notMigratedYet(err)) return 0;
    throw err;
  });
  return { limit, used };
}

/** Why another guest can't be let in — or null when one can. */
export function allowanceRefusal(a: GuestAllowance): string | null {
  if (a.limit === null) return null;
  if (a.limit === 0) return "Deskzo Connect isn't in your plan. Add it under Billing — ₹999 a month for 10 guests — and invite people from other companies.";
  if (a.used >= a.limit) return `Your plan has room for ${a.limit} active guests, and ${a.used} are in. Stop or remove one, or add another 10 under Billing.`;
  return null;
}

/** Whether Connect is in the plan at all — guests of a workspace that dropped it can't sign in or see anything. */
export async function connectInPlan(): Promise<boolean> {
  const { moduleAvailableForTenant } = await import("@/lib/modules-access");
  // Fails closed: a workspace whose plan can't be read lets no guest in.
  if (!(await moduleAvailableForTenant("workspace").catch(() => false))) return false;
  const tenant = await currentTenantOrNull().catch(() => null);
  const g = tenant?.entitlements.connectGuests;
  return g === undefined || g === null || g > 0;
}
