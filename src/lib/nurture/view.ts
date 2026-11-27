import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { mayAccess } from "@/lib/authz/access";
import { contactMasker } from "@/lib/contacts/masking";
import { copilotConfig } from "@/lib/copilot/settings";
import { latestPlan } from "@/lib/research/plan-server";
import { nurtureConfig, nurtureOf, type NurtureView } from "@/lib/nurture/server";
import { feedbackOf } from "@/lib/ai/drafts";

/**
 * The nurture card on a lead (owner, 18 Nov 2026 — phase 3, src/lib/nurture): where it stands, and what this person may
 * do — start it, send or skip a waiting email (its owner only), stop it. The contact's name only where they may see it.
 */

export type NurtureCard = {
  leadId: string;
  nurture: NurtureView | null;
  /** Switched on for the workspace. */
  enabled: boolean;
  mayStart: boolean;
  /** Why it can't start, when it can't and the person otherwise could. */
  startNote: string | null;
  isOwner: boolean;
  mayStop: boolean;
  /** May change the lead — for a reply's suggested stage (phase 4). */
  mayEdit: boolean;
  /** This person's thumbs on the drafts and answers shown, by id (step 2 — src/lib/ai/drafts.ts). */
  thumbs: Record<string, boolean>;
};

const CLOSED = ["WON", "LOST", "DISQUALIFIED"];

export async function nurtureCardData(leadId: string, userId: string): Promise<NurtureCard> {
  const [config, nurture, mayUse, ai, mayEdit, plan, lead] = await Promise.all([
    nurtureConfig(),
    nurtureOf(leadId),
    can(userId, "copilot.use"),
    copilotConfig(),
    mayAccess(userId, "leads", "edit", leadId),
    latestPlan({ kind: "lead", id: leadId }),
    db.lead.findUnique({ where: { id: leadId }, select: { status: true } }),
  ]);
  let view = nurture;
  if (view) {
    const enrolment = await db.nurtureEnrolment.findUnique({ where: { leadId }, select: { contactId: true } });
    if (enrolment) {
      const masker = await contactMasker(userId, "detail", [enrolment.contactId]);
      if (masker.hidden(enrolment.contactId).includes("name")) {
        // The replies' people too (phase 4): who wrote, and whom they point to.
        view = { ...view, contactName: "the contact", replies: view.replies.map((r) => ({ ...r, fromName: null, suggestedName: null, suggestedEmail: null })) };
      }
    }
    // A drafted answer is its owner's to read and send.
    if (view.ownerId !== userId) view = { ...view, replies: view.replies.map((r) => ({ ...r, answer: null })) };
  }
  const active = view?.status === "ACTIVE";
  const open = !!lead && !CLOSED.includes(lead.status);
  const could = config.enabled && mayUse && ai.enabled && mayEdit && open && !active;
  const startNote = !could ? null : !plan?.plan.email ? "Make a Research & plan first — its email is the first one." : null;
  return {
    leadId,
    nurture: view,
    enabled: config.enabled,
    mayStart: could && !startNote,
    startNote,
    isOwner: !!view && view.ownerId === userId,
    mayStop: active && mayEdit,
    mayEdit,
    thumbs: view
      ? {
          ...(await feedbackOf("nurture.email", view.touches.map((t) => t.id), userId)),
          ...(await feedbackOf("nurture.answer", view.replies.map((r) => r.id), userId)),
        }
      : {},
  };
}
