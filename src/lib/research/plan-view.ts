import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { canViewContacts } from "@/lib/authz/contact-access";
import { contactMasker } from "@/lib/contacts/masking";
import { STILL_THERE } from "@/lib/contacts/left";
import { aiService } from "@/lib/ai/gateway";
import { copilotConfig } from "@/lib/copilot/settings";
import { latestPlan, type PlanTarget, type PlanView } from "@/lib/research/plan-server";

/**
 * The "Research & plan" card's data (owner, 18 Nov 2026 — src/lib/research/plan.ts): the latest plan, whether this person
 * may make one, where Deskzo AI runs (said before it is used), and the two names the email draft is filled with — the
 * contact's first name only where they may see it.
 */

export type PlanCard = {
  target: PlanTarget;
  plan: PlanView | null;
  mayPlan: boolean;
  /** "Deskzo AI (Claude Sonnet, processed in India, never used for training)". */
  service: string;
  firstName: string | null;
  senderName: string | null;
};

async function contactFirstName(target: PlanTarget, userId: string): Promise<string | null> {
  if (!(await canViewContacts(userId))) return null;
  const contact =
    target.kind === "lead"
      ? (await db.lead.findUnique({ where: { id: target.id }, select: { contact: { select: { id: true, name: true, leftAt: true } } } }))?.contact
      : await db.contact.findFirst({ where: { companyId: target.id, ...STILL_THERE }, orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }], select: { id: true, name: true, leftAt: true } });
  if (!contact || contact.leftAt) return null;
  const masker = await contactMasker(userId, "detail", [contact.id]);
  if (masker.hidden(contact.id).includes("name")) return null;
  return contact.name.trim().split(/\s+/)[0] || null;
}

export async function planCardData(target: PlanTarget, userId: string): Promise<PlanCard> {
  const [plan, mayUse, config, service, firstName, me] = await Promise.all([
    latestPlan(target),
    can(userId, "copilot.use"),
    copilotConfig(),
    aiService("research.plan"),
    contactFirstName(target, userId).catch(() => null),
    db.user.findUnique({ where: { id: userId }, select: { name: true } }),
  ]);
  return {
    target,
    plan,
    mayPlan: mayUse && config.enabled,
    service: service ? `Deskzo AI (${service.model}, processed in ${service.residency}${service.noTraining ? ", never used for training" : ""})` : "Deskzo AI",
    firstName,
    senderName: me?.name ?? null,
  };
}
