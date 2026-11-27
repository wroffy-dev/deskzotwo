"use server";

import { db } from "@/lib/db";
import { requireUser, viewAsContext } from "@/lib/session";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { companyRevealFields, companyRevealRef } from "@/lib/companies/masking";
import { revealedFieldsToday, logUnmaskDenied, revealRecord, unmaskRequestMeta, unmaskUsageToday, type UnmaskSubject, type UnmaskUsageStatus } from "@/lib/authz/unmask";

/**
 * "Show" on a masked company (owner, 5 Nov 2026 — Phase 3 masking fixes, wave B, audit H.4.5; src/lib/companies/masking.ts):
 * the contact's reveal (src/actions/contact-unmask.ts), for a company — the same checks in the same order, the same
 * daily limit and log.
 *
 *   1. who is asking, and whether an admin is viewing as them;
 *   2. that this company is one they reach (the record engine's own account rule, `canSeeCompany`, as its page asks);
 *   3. which of its fields they see masked and may unmask — address, GSTIN, PAN, website and custom fields, never
 *      its name (src/lib/companies/masking.ts);
 *   4. a unit of the daily limit for its first reveal today, none for a repeat or for fields granted since this
 *      morning's — counted and logged together through the one reveal every record uses (src/lib/authz/unmask.ts
 *      `revealRecord`), with the person's reason if they gave one.
 *
 * It returns no values: the page refreshes and reads them through the same field access, which now sees today's reveal
 * — on the company's page, in the company lists and on its leads' pages. Viewing as somebody unmasks nothing.
 */

export type CompanyUnmaskOutcome = {
  result: "ALLOWED" | "REPEAT" | "QUOTA_EXHAUSTED" | "DENIED" | "NOTHING";
  message: string | null;
  usage: UnmaskUsageStatus | null;
};

const NOT_FOUND = "Company not found.";

export async function unmaskCompany(companyId: unknown, reason?: unknown): Promise<CompanyUnmaskOutcome> {
  const user = await requireUser();
  const id = typeof companyId === "string" ? companyId.trim().slice(0, 40) : "";
  if (!id) return { result: "DENIED", message: NOT_FOUND, usage: null };
  const stated = typeof reason === "string" ? reason : null;

  // Masked anywhere it is shown — a list or the company's page — counts; "Show" reveals it in both.
  const { concealed, revealable } = await companyRevealFields(user.id);
  if (concealed.length === 0) return { result: "NOTHING", message: null, usage: null };

  const [viewAs, meta] = await Promise.all([viewAsContext(), unmaskRequestMeta()]);
  const subject: UnmaskSubject = { userId: user.id, userName: user.name ?? "", impersonatedByUserId: viewAs?.actor.id ?? null, entity: "companies", recordId: id, ref: null };

  const company = await db.company.findUnique({ where: { id }, select: { id: true, name: true, companySeq: true, ownerUserId: true, relationshipType: true } });
  if (!company || !(await canSeeCompany(user.id, company))) {
    // Out of reach and missing answer alike, as the company's page does — but the attempt is kept.
    await logUnmaskDenied(subject, concealed, "Not a company this person can open.", meta, stated);
    return { result: "DENIED", message: NOT_FOUND, usage: null };
  }
  // The log's reference: its number and name — a company's name is never masked.
  subject.ref = companyRevealRef(company);

  if (revealable.length === 0) {
    await logUnmaskDenied(subject, concealed, "No permission to unmask these fields.", meta, stated);
    return { result: "DENIED", message: "You can't unmask this company's hidden fields.", usage: await unmaskUsageToday(user.id) };
  }
  if (viewAs) {
    await logUnmaskDenied(subject, revealable, `While ${viewAs.actor.name} was viewing as ${viewAs.user.name}.`, meta, stated);
    return { result: "DENIED", message: `You're viewing as ${viewAs.user.name}. Fields stay masked: unmasking would use their daily limit.`, usage: await unmaskUsageToday(user.id) };
  }
  // Every field it may reveal already revealed today — by its own "Show" or with one of its leads: nothing to do, and
  // nothing worth a log row (as for a contact).
  const covered = await revealedFieldsToday(user.id, "companies", company.id);
  if (covered && revealable.every((k) => covered.has(k))) return { result: "REPEAT", message: null, usage: await unmaskUsageToday(user.id) };

  const attempt = await revealRecord(user.id, "companies", company.id, revealable, stated, { ref: subject.ref, userName: subject.userName, meta });
  switch (attempt.result) {
    case "ALLOWED":
    case "REPEAT":
      return { result: attempt.result, message: null, usage: attempt.usage };
    case "QUOTA_EXHAUSTED":
      return {
        result: "QUOTA_EXHAUSTED",
        message: `You've unmasked ${attempt.usage.limit} records today — leads, contacts and companies — your daily limit. It resets at midnight.`,
        usage: attempt.usage,
      };
    default:
      return { result: "DENIED", message: NOT_FOUND, usage: attempt.usage };
  }
}
