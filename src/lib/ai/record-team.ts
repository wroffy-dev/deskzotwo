import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { notMigratedYet } from "@/lib/not-migrated";
import { copilotConfig } from "@/lib/copilot/settings";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { inCollectionsScope, mayLogFollowUps } from "@/lib/collections/load";
import { RECEIVABLE_DOC_TYPE } from "@/lib/trade-documents";
import type { TeammateKey } from "@/lib/ai/teammates";
import type { PlanCard } from "@/lib/research/plan-view";
import { FIT_LABELS } from "@/lib/research/plan";
import type { NurtureCard } from "@/lib/nurture/view";
import type { CheckInCard } from "@/lib/reengage/server";

/**
 * The AI team at the top of a record (owner, 20 Nov 2026 — "easily accessible", step 3): each teammate who works on this
 * kind of record, what they've done for it, and one button — Ved's Research & plan, Tara's nurture (on a quiet customer,
 * her check-in — step 4), Arjun's chase email —
 * each shown only to whoever its own button is offered to, and running that same action. Read from what the page
 * already loaded where it can (the plan card, the nurture card); nothing is sent from here.
 */

export type TeamAction = "ved-plan" | "tara-nurture" | "arjun-chase" | "tara-checkin";
export type TeamSlot = {
  teammate: TeammateKey;
  /** What they've done here, in a few words — or null. */
  status: string | null;
  /** Their button, where this person may press it. */
  action: { kind: TeamAction; label: string } | null;
  /** Why there's no button, where that helps ("Ved's plan first"). */
  note: string | null;
  href: string | null;
};

/** Ved's slot, from the record's plan card. */
function ved(planCard: PlanCard | null, planHref: string): TeamSlot | null {
  if (!planCard) return null;
  if (planCard.plan) {
    const n = planCard.plan.plan.steps.length;
    return { teammate: "ved", status: `Read as ${FIT_LABELS[planCard.plan.plan.fit]} · ${n} next step${n === 1 ? "" : "s"}`, action: null, note: null, href: planHref };
  }
  return planCard.mayPlan ? { teammate: "ved", status: null, action: { kind: "ved-plan", label: "Research & plan" }, note: null, href: null } : null;
}

/** Tara's slot, from the lead's nurture card. */
function tara(card: NurtureCard | null): TeamSlot | null {
  if (!card) return null;
  const n = card.nurture;
  if (n && n.status === "ACTIVE") {
    const waiting = n.touches.find((t) => t.status === "WAITING");
    const held = n.touches.find((t) => t.status === "SCHEDULED");
    const status = waiting
      ? card.isOwner
        ? `Email ${waiting.step + 1} waiting for you`
        : `Email ${waiting.step + 1} waiting for ${n.ownerName ?? "the owner"}`
      : held
        ? `Email ${held.step + 1} approved, goes soon`
        : `Nurturing · ${n.touchesSent} of 4 sent`;
    return { teammate: "tara", status, action: null, note: null, href: "#nurture" };
  }
  if (card.mayStart) return { teammate: "tara", status: n ? (n.stopReason ?? "Ended") : null, action: { kind: "tara-nurture", label: n ? "Nurture again" : "Nurture this lead" }, note: null, href: null };
  if (card.startNote) return { teammate: "tara", status: null, action: null, note: "Ved's plan first", href: null };
  return n ? { teammate: "tara", status: n.stopReason ?? "Ended", action: null, note: null, href: "#nurture" } : null;
}

/** Tara's slot on a quiet customer (step 4), from the check-in card: one waiting, approved, sent — or her button. */
function taraCheckIn(card: CheckInCard | null, href: string): TeamSlot | null {
  if (!card) return null;
  const e = card.latest;
  if (e?.status === "WAITING") return { teammate: "tara", status: card.isOwner ? "Check-in waiting for you" : `Check-in waiting for ${e.ownerName ?? "the account manager"}`, action: null, note: null, href };
  if (e?.status === "SCHEDULED") return { teammate: "tara", status: "Check-in approved, goes soon", action: null, note: null, href };
  if (card.mayDraft) return { teammate: "tara", status: "Quiet a while", action: { kind: "tara-checkin", label: "Check in with them" }, note: null, href: null };
  if (e?.status === "SENT") return { teammate: "tara", status: e.repliedAt ? `Checked in · ${(e.replyLabel ?? "replied").toLowerCase()}` : "Checked in", action: null, note: null, href };
  return null;
}

/** Arjun's slot on a customer: a chase email waiting, or one to draft where money is overdue and theirs to chase. */
async function arjun(userId: string, companyId: string, now: Date): Promise<TeamSlot | null> {
  if (!(await moduleAvailableForTenant("receivables")) || !(await mayLogFollowUps(userId))) return null;
  try {
    const waiting = await db.collectionChase.count({ where: { companyId, status: "WAITING", createdById: userId } });
    if (waiting) return { teammate: "arjun", status: "Chase email waiting for you", action: null, note: null, href: "/collections" };
    const [mayUse, config] = await Promise.all([can(userId, "copilot.use"), copilotConfig()]);
    if (!mayUse || !config.enabled) return null;
    // The oldest overdue invoice — and only if it's in this person's collections.
    const overdue = await db.tradeDocument.findFirst({
      where: { companyId, docType: RECEIVABLE_DOC_TYPE, status: { notIn: ["DRAFT", "CANCELLED", "PAID"] }, dueDate: { lt: now } },
      orderBy: { dueDate: "asc" },
      select: { id: true },
    });
    if (!overdue || !(await inCollectionsScope(userId, { documentId: overdue.id }))) return null;
    return { teammate: "arjun", status: "Money overdue", action: { kind: "arjun-chase", label: "Draft a chase email" }, note: null, href: null };
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

export function leadTeam(planCard: PlanCard | null, nurtureCard: NurtureCard | null): TeamSlot[] {
  return [ved(planCard, "#research-plan"), tara(nurtureCard)].filter((s): s is TeamSlot => !!s);
}

export async function companyTeam(userId: string, companyId: string, planCard: PlanCard | null, checkIn: CheckInCard | null = null, now = new Date()): Promise<TeamSlot[]> {
  return [ved(planCard, "?tab=details#research-plan"), taraCheckIn(checkIn, "?tab=details#check-in"), await arjun(userId, companyId, now)].filter((s): s is TeamSlot => !!s);
}
