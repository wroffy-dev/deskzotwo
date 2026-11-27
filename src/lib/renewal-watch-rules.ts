import type { Prisma } from "@prisma/client";
import { RAISED_IN_DESKZO } from "@/lib/documents/imported";
import { UNMARKED_EXCEPT } from "@/lib/renewal-lapse-rules";

/**
 * Renewals nobody misses (owner, 30 Oct 2026). A subscription used to be mentioned once, thirty days out, to its
 * account's owner only, and then not again until the day after it had lapsed. Now:
 *
 *   · Its renewal manager is reminded on each of Settings › Renewals' days before its end (60, 30, 15, 7, 1) — the
 *     customer's own renewal manager, else its account manager while they're still with us, else every admin. A
 *     renewal always belongs to somebody.
 *   · Not started — no call logged against it, no proposal, proforma or invoice quoting it, not renewed, nobody's
 *     marked it — with `escalateManagerDays` left, that person's manager is told; with `escalateAdminDays`, the admins.
 *   · `taskLeadDays` out, a renewal task is raised for the renewal manager where none is open (src/lib/renewal-watch.ts).
 *   · Mondays, each renewal manager and each manager of one gets the week's list.
 *   · Gone quiet (owner, 11 Nov 2026) — started, but no call, quote or stage change in QUIET_DAYS — is escalated on
 *     the same days as not started: one call used to end the escalation for good, however long ago it was.
 *   · No end date (owner, 11 Nov 2026): none of the above can see a subscription saved without one, so those are
 *     counted on Monday's list and listed on Renewals › No end date until somebody enters it.
 *
 * The notices are the bell's own sweep (src/lib/notify.ts) — so a muted kind stays muted, each goes once (its
 * dedupe key), and the scheduled sweep emails them where the workspace emails "A renewal is coming up".
 */

export type RenewalWatch = {
  reminderDays: number[];
  escalateManagerDays: number | null;
  escalateAdminDays: number | null;
  taskLeadDays: number | null;
  weeklyList: boolean;
};

export const DEFAULT_WATCH: RenewalWatch = {
  reminderDays: [60, 30, 15, 7, 1],
  escalateManagerDays: 15,
  escalateAdminDays: 7,
  taskLeadDays: 45,
  weeklyList: true,
};

/**
 * A renewal task's title — what Renewals' "Raise tasks" writes and the heartbeat raises — and also how the list's
 * stage recognises one, as a task has no link to an order (src/actions/renewal.ts `renewalStageSignals`).
 */
export function renewalTaskTitle(itemName: string, companyName: string) {
  return `Renew ${itemName} — ${companyName}`;
}

/** How far ahead the list's "At risk" looks: thirty days, nothing done — or nothing lately. */
export const AT_RISK_DAYS = 30;

/** How long a renewal somebody has started may go with nothing new before it has gone quiet. */
export const QUIET_DAYS = 7;

/**
 * The step of the ladder a renewal with `daysLeft` is on: the nearest of the days at or above it — so one first seen
 * with 12 days left gets the 15-day reminder, late rather than lost, and never the 60 and 30 it missed as well.
 * Null past the furthest step, or once it has ended.
 */
export function ladderStep(daysLeft: number, steps: number[]): number | null {
  if (daysLeft < 0) return null;
  const at = steps.filter((s) => s >= daysLeft).sort((a, b) => a - b);
  return at[0] ?? null;
}

/**
 * The dedupe key of one step's reminder. The 30-day one keeps the key the single reminder had before, so somebody
 * already told isn't told again the day this ships.
 */
export function reminderKey(orderId: string, step: number): string {
  return step === 30 ? `renewal-expiring:${orderId}` : `renewal-remind:${orderId}:${step}`;
}

/** A subscription up for renewal: a parent subscription, not cancelled or refused, not renewed, not marked Lost or On hold. */
export function upForRenewalWhere(from: Date, to: Date): Prisma.CompanyProductWhereInput {
  return {
    item: { type: "SUBSCRIPTION" },
    parentId: null,
    orderStatus: { notIn: ["CANCELLED", "REJECTED"] },
    endDate: { not: null, gte: from, lte: to },
    renewedBy: { is: null },
    // An OR, as NOT over a null drops the unmarked rows with it. Negotiating is still somebody's to renew.
    OR: [{ renewalStage: null }, { renewalStage: { notIn: ["LOST", "ON_HOLD"] } }],
  };
}

/**
 * Not started: nothing in the record shows anybody working it — the same evidence the Renewals list's stage reads
 * (src/actions/renewal.ts `renewalStageSignals`), less the task, as a task raised isn't the customer hearing from us.
 */
export function notStartedWhere(): Prisma.CompanyProductWhereInput {
  return {
    renewedBy: { is: null },
    calls: { none: {} },
    documentLines: { none: { document: LIVE_QUOTE } },
    OR: [{ renewalStage: null }, { renewalStage: { notIn: UNMARKED_EXCEPT } }],
  };
}

/** A document quoting the next term that still stands — what "quoted" means on the Renewals list too. */
const LIVE_QUOTE = {
  docType: { in: ["PROPOSAL", "PROFORMA", "INVOICE"] },
  status: { notIn: ["CANCELLED", "REJECTED", "EXPIRED"] },
  ...RAISED_IN_DESKZO,
} satisfies Prisma.TradeDocumentWhereInput;

/**
 * Gone quiet: somebody started it — a call logged against it, a quote that still stands, or marked Negotiating — and
 * nothing has happened since `quietSince`: no call, no new quote, no change of stage. Not renewed. Used with
 * `upForRenewalWhere`, which leaves out Lost and On hold.
 */
export function goneQuietWhere(quietSince: Date): Prisma.CompanyProductWhereInput {
  return {
    renewedBy: { is: null },
    AND: [
      { OR: [{ calls: { some: {} } }, { documentLines: { some: { document: LIVE_QUOTE } } }, { renewalStage: "NEGOTIATING" }] },
      { calls: { none: { startedAt: { gte: quietSince } } } },
      { documentLines: { none: { document: { ...LIVE_QUOTE, createdAt: { gte: quietSince } } } } },
      // An OR, as a comparison over a null drops the rows nobody has marked.
      { OR: [{ renewalStageAt: null }, { renewalStageAt: { lt: quietSince } }] },
    ],
  };
}

/** When "nothing lately" starts, counted back from now. */
export function quietSince(now: Date): Date {
  return new Date(now.getTime() - QUIET_DAYS * 86_400_000);
}

/** At risk: not started, or started and gone quiet. Used with the thirty-day window. */
export function atRiskWhere(now: Date): Prisma.CompanyProductWhereInput {
  return { OR: [notStartedWhere(), goneQuietWhere(quietSince(now))] };
}

/**
 * A running subscription nothing can watch: no end date, so no reminder, no escalation, no task, no lapse, and no row
 * on the Renewals list. A parent subscription, not cancelled or refused, not renewed, not marked Lost or On hold.
 */
export function noEndDateWhere(): Prisma.CompanyProductWhereInput {
  return {
    item: { type: "SUBSCRIPTION" },
    parentId: null,
    orderStatus: { notIn: ["CANCELLED", "REJECTED"] },
    endDate: null,
    renewedBy: { is: null },
    OR: [{ renewalStage: null }, { renewalStage: { notIn: ["LOST", "ON_HOLD"] } }],
  };
}

/**
 * The companies whose renewals land with `userId`: theirs as renewal manager, or as account manager where there's no
 * renewal manager or the one there was has left. Before 20261130100000_renewal_manager, the account manager's.
 */
export function recipientWhere(userId: string, managersHere: boolean): Prisma.CompanyWhereInput {
  if (!managersHere) return { ownerUserId: userId };
  return { OR: [{ renewalManagerId: userId }, { renewalManagerId: null, ownerUserId: userId }, { renewalManager: { active: false }, ownerUserId: userId }] };
}

/** The companies whose renewals land with nobody still here — every admin's, then. */
export function nobodysWhere(managersHere: boolean): Prisma.CompanyWhereInput {
  const noOwner: Prisma.CompanyWhereInput = { OR: [{ ownerUserId: null }, { owner: { active: false } }] };
  if (!managersHere) return noOwner;
  return { AND: [{ OR: [{ renewalManagerId: null }, { renewalManager: { active: false } }] }, noOwner] };
}

/** The companies whose renewal manager (as above) reports to `managerId`. */
export function teamWhere(managerId: string, managersHere: boolean): Prisma.CompanyWhereInput {
  const owners: Prisma.CompanyWhereInput = { owner: { active: true, managerId } };
  if (!managersHere) return owners;
  return {
    OR: [
      { renewalManager: { active: true, managerId } },
      { AND: [{ OR: [{ renewalManagerId: null }, { renewalManager: { active: false } }] }, owners] },
    ],
  };
}
