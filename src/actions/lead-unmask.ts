"use server";

import { db } from "@/lib/db";
import { requireModuleUser } from "@/lib/modules-access";
import { viewAsContext } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { contactAccess, leadAccess } from "@/lib/authz/access";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { companyRevealFields, companyRevealRef } from "@/lib/companies/masking";
import { resolveFieldPolicies } from "@/lib/authz/fields";
import { isModuleEnabled } from "@/actions/module";
import { detailLeadMasker, listLeadReveal } from "@/lib/leads/masking";
import { formatLeadId } from "@/lib/order-id";
import { logUnmaskDenied, revealRecord, unmaskRequestMeta, unmaskUsageToday, type RevealFamilyMember, type UnmaskSubject, type UnmaskUsageStatus } from "@/lib/authz/unmask";

/**
 * Unmasking a lead — what "Show" on its page (src/components/leads/lead-unmask.tsx) and on the Leads list does. Since
 * 5 Nov 2026 (owner — Phase 3 masking fixes, audit M-10) it is a click, never the page opening, and it may carry the
 * person's reason, which is kept on the log row.
 *
 * Every time, in this order, and nothing taken from the caller but the lead's id and that reason:
 *
 *   1. who is asking — the session, and whether an admin is viewing as them;
 *   2. the plan, the Leads module and "View leads";
 *   3. that this lead is one they reach (the record engine's own `leadAccess`);
 *   4. which of its fields they see masked here and may unmask (field access);
 *   5. the daily limit — a unit for the lead's first unmasking today, none for a repeat or for fields granted
 *      since this morning's, and a refusal once the units are gone — counted and logged in one transaction
 *      (src/lib/authz/unmask.ts `revealRecord`);
 *   6. the lead's contact and its company revealed with it for the day, at no unit of their own (audit H.5) — each
 *      where they reach it and may unmask some of its fields — so the contact's own screens, and the company's page,
 *      lists and its leads' pages, show it in the clear too (the company since 5 Nov 2026 — Phase 3 masking fixes,
 *      wave B, audit H.4.5).
 *
 * It returns no values. The lead's page reads them itself on the refresh that follows, as it always
 * does — through the same field access, which now sees today's unmasking — so a value never travels
 * by a second road, and a page reloaded tomorrow is masked again.
 *
 * Viewing as somebody unmasks nothing: it would spend their limit on somebody else's clicks, and put
 * their name on the log for it. The attempt is logged as refused, with the admin behind it.
 */

export type UnmaskOutcome = {
  result: "ALLOWED" | "REPEAT" | "QUOTA_EXHAUSTED" | "DENIED" | "NOTHING";
  /** What the page says about it, in words; null when there is nothing to say. */
  message: string | null;
  usage: UnmaskUsageStatus | null;
};

const NOT_FOUND = "Lead not found.";

/** The lead's contact, to reveal with it: where this person reaches it and may unmask something of it. */
async function contactWithLead(userId: string, contactId: string | null, companyName: string): Promise<RevealFamilyMember[]> {
  if (!contactId) return [];
  const resolved = await resolveFieldPolicies(userId, "contacts");
  // What "Show" on the contact itself would reveal (src/actions/contact-unmask.ts): masked anywhere, and theirs to unmask.
  const fields = [...resolved.fields.values()].filter((f) => f.policy.view && f.policy.unmask && (f.policy.maskInList || f.policy.maskInDetail)).map((f) => f.field.key);
  if (fields.length === 0) return [];
  const reachable = await db.contact.findFirst({ where: { AND: [{ id: contactId }, await contactAccess(userId, "view")] }, select: { id: true } });
  return reachable ? [{ entity: "contacts", recordId: reachable.id, fields, ref: `Contact at ${companyName}`.slice(0, 120) }] : [];
}

/**
 * The lead's company, to reveal with it (owner, 5 Nov 2026 — Phase 3 masking fixes, wave B, audit H.4.5 and H.5): where
 * this person reaches it — the record engine's account rule, as its page asks (`canSeeCompany`) — and may unmask some of
 * its fields; what "Show" on the company itself would reveal (src/actions/company-unmask.ts).
 */
async function companyWithLead(userId: string, companyId: string): Promise<RevealFamilyMember[]> {
  const { revealable } = await companyRevealFields(userId);
  if (revealable.length === 0) return [];
  const company = await db.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, companySeq: true, ownerUserId: true, relationshipType: true } });
  if (!company || !(await canSeeCompany(userId, company))) return [];
  return [{ entity: "companies", recordId: company.id, fields: revealable, ref: companyRevealRef(company) }];
}

/**
 * `where`: "list" for "Show" on the Leads list (owner, 3 Nov 2026) — what the list masks, rather than the lead's page.
 * `reason`: what the person typed as why, optional (owner, 5 Nov 2026 — audit M-10).
 */
export async function unmaskLead(leadId: unknown, where: "page" | "list" = "page", reason?: unknown): Promise<UnmaskOutcome> {
  // Plan only: "Show" sits on the contacts, commission parties and company pages too (src/lib/module-actions.ts SHARED_ACTIONS).
  const user = await requireModuleUser("leads");
  const id = typeof leadId === "string" ? leadId.trim().slice(0, 64) : "";
  if (!id) return { result: "DENIED", message: NOT_FOUND, usage: null };
  const stated = typeof reason === "string" ? reason : null;

  const [viewAs, meta] = await Promise.all([viewAsContext(), unmaskRequestMeta()]);
  const subject: UnmaskSubject = { userId: user.id, userName: user.name ?? "", impersonatedByUserId: viewAs?.actor.id ?? null, entity: "leads", recordId: id, ref: null };

  const masker = where === "list" ? await listLeadReveal(user.id) : await detailLeadMasker(user.id, id);
  // Nothing masked for this person here: there is nothing to unmask, and nothing worth a log row.
  if (masker.concealed.length === 0 && masker.revealable.length === 0) return { result: "NOTHING", message: null, usage: null };

  const mayOpen = (await isModuleEnabled("leads")) && (await can(user.id, "leads.view"));
  const lead = mayOpen
    ? await db.lead.findFirst({ where: { AND: [{ id }, await leadAccess(user.id, "view")] }, select: { id: true, leadSeq: true, contactId: true, companyId: true, company: { select: { name: true } } } })
    : null;
  if (!lead) {
    // Out of reach and missing answer alike, as the lead's page does — but the attempt is kept.
    await logUnmaskDenied(subject, [...masker.revealable, ...masker.concealed], "Not a lead this person can open.", meta, stated);
    return { result: "DENIED", message: NOT_FOUND, usage: null };
  }
  subject.ref = formatLeadId(lead.leadSeq);

  if (masker.revealable.length === 0) {
    await logUnmaskDenied(subject, masker.concealed, "No permission to unmask these fields.", meta, stated);
    return { result: "DENIED", message: "You can't unmask this lead's hidden fields.", usage: await unmaskUsageToday(user.id) };
  }
  if (viewAs) {
    await logUnmaskDenied(subject, masker.revealable, `While ${viewAs.actor.name} was viewing as ${viewAs.user.name}.`, meta, stated);
    return {
      result: "DENIED",
      message: `You're viewing as ${viewAs.user.name}. Fields stay masked: unmasking would use their daily limit.`,
      usage: await unmaskUsageToday(user.id),
    };
  }

  const family = [...(await contactWithLead(user.id, lead.contactId, lead.company.name)), ...(await companyWithLead(user.id, lead.companyId))];
  const attempt = await revealRecord(user.id, "leads", lead.id, masker.revealable, stated, { ref: subject.ref, userName: subject.userName, meta, family });
  switch (attempt.result) {
    case "ALLOWED":
      return { result: "ALLOWED", message: null, usage: attempt.usage };
    case "REPEAT":
      return { result: "REPEAT", message: null, usage: attempt.usage };
    case "QUOTA_EXHAUSTED":
      return {
        result: "QUOTA_EXHAUSTED",
        message: `You've unmasked ${attempt.usage.limit} records today — leads, contacts and companies — your daily limit. Sensitive fields stay masked on leads you haven't shown today; it resets at midnight.`,
        usage: attempt.usage,
      };
    default:
      return { result: "DENIED", message: NOT_FOUND, usage: attempt.usage };
  }
}
