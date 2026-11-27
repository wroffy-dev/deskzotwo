import type { Prisma, RenewalStage } from "@prisma/client";

/**
 * Which subscriptions have lapsed (owner, 26 Oct 2026 — src/lib/renewal-lapse.ts): ended before `endedBefore`, not
 * renewed, not marked. Subscriptions only, parents only (an add-on goes with its subscription), never a cancelled
 * or refused order. Its own file, without imports, as the bell (src/lib/notify.ts) asks it too.
 */
export function lapsedWhere(endedBefore: Date): Prisma.CompanyProductWhereInput {
  return {
    item: { type: "SUBSCRIPTION" },
    parentId: null,
    orderStatus: { notIn: ["CANCELLED", "REJECTED"] },
    endDate: { not: null, lt: endedBefore },
    renewedBy: { is: null },
    // Marked by nobody — an OR, as NOT over a null drops the unmarked rows with it.
    OR: [{ renewalStage: null }, { renewalStage: { notIn: UNMARKED_EXCEPT } }],
  };
}

/** A renewal somebody has marked is somebody's call: not lapsed, whatever its dates say. */
export const UNMARKED_EXCEPT: RenewalStage[] = ["LOST", "NEGOTIATING", "ON_HOLD"];
