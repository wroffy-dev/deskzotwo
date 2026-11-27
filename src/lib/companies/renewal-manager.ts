import { cache } from "react";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Who looks after a customer's renewals (owner, 30 Oct 2026): its account manager, unless somebody else is given them
 * as its renewal manager (`Company.renewalManagerId`). The Renewals list shows and filters by that person; a workspace
 * not migrated to 20261130100000_renewal_manager yet has every renewal its account manager's.
 */

/** Whether this workspace has the column yet — asked before a query names it; once a request. */
export const renewalManagersHere = cache(async (): Promise<boolean> => {
  try {
    await db.company.findFirst({ select: { renewalManagerId: true }, take: 1 });
    return true;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
});

/**
 * The companies whose renewals are this person's: theirs as renewal manager, or as account manager where nobody else
 * is renewal manager. "unassigned": nobody either way.
 */
export async function renewalManagerWhere(userId: string): Promise<Prisma.CompanyWhereInput> {
  const here = await renewalManagersHere();
  if (userId === "unassigned") return here ? { renewalManagerId: null, ownerUserId: null } : { ownerUserId: null };
  return here ? { OR: [{ renewalManagerId: userId }, { renewalManagerId: null, ownerUserId: userId }] } : { ownerUserId: userId };
}

export type RenewalManager = { id: string; name: string; own: boolean } | null;

/**
 * Each company's renewal manager: its own (`own: true`), else its account manager. Read on its own, so the list's
 * main query never names the column.
 */
export async function renewalManagersOf(companies: { id: string; owner: { id: string; name: string } | null }[]): Promise<Map<string, RenewalManager>> {
  const out = new Map<string, RenewalManager>(companies.map((c) => [c.id, c.owner ? { ...c.owner, own: false } : null]));
  if (companies.length === 0 || !(await renewalManagersHere())) return out;
  const rows = await db.company.findMany({
    where: { id: { in: [...new Set(companies.map((c) => c.id))] }, renewalManagerId: { not: null } },
    select: { id: true, renewalManager: { select: { id: true, name: true } } },
  });
  for (const r of rows) if (r.renewalManager) out.set(r.id, { ...r.renewalManager, own: true });
  return out;
}
