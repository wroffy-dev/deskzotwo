"use server";

import { db } from "@/lib/db";
import { requireUser, viewAsContext } from "@/lib/session";
import { contactAccess } from "@/lib/authz/access";
import { resolveFieldPolicies } from "@/lib/authz/fields";
import { visibility } from "@/lib/authz/field-policy";
import { revealedFieldsToday, logUnmaskDenied, revealRecord, unmaskRequestMeta, unmaskUsageToday, type UnmaskSubject, type UnmaskUsageStatus } from "@/lib/authz/unmask";

/**
 * "Show" on a masked contact (owner, 3 Nov 2026 — src/lib/contacts/masking.ts): the lead's unmasking
 * (src/actions/lead-unmask.ts), for a contact — the same checks in the same order, the same daily limit and log.
 *
 *   1. who is asking, and whether an admin is viewing as them;
 *   2. that this contact is one they reach (the record engine's own contact rule);
 *   3. which of its fields they see masked and may unmask;
 *   4. a unit of the daily limit for its first reveal today, none for a repeat or for fields granted since this
 *      morning's — counted and logged together, through the one reveal every record uses (src/lib/authz/unmask.ts
 *      `revealRecord`, owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.5), with the person's reason if they gave one.
 *
 * It returns no values: the screen refreshes and reads them through the same field access, which now sees today's
 * reveal. Viewing as somebody unmasks nothing.
 */

export type ContactUnmaskOutcome = {
  result: "ALLOWED" | "REPEAT" | "QUOTA_EXHAUSTED" | "DENIED" | "NOTHING";
  message: string | null;
  usage: UnmaskUsageStatus | null;
};

const NOT_FOUND = "Contact not found.";

export async function unmaskContact(contactId: unknown, reason?: unknown): Promise<ContactUnmaskOutcome> {
  const user = await requireUser();
  const id = typeof contactId === "string" ? contactId.trim().slice(0, 40) : "";
  if (!id) return { result: "DENIED", message: NOT_FOUND, usage: null };
  const stated = typeof reason === "string" ? reason : null;

  const resolved = await resolveFieldPolicies(user.id, "contacts");
  const fields = [...resolved.fields.values()];
  // Masked anywhere it is shown — a list or the customer's page — counts; "Show" reveals it in both.
  const concealed = fields.filter((f) => visibility(f.policy, "list") !== "clear" || visibility(f.policy, "detail") !== "clear").map((f) => f.field.key);
  const revealable = fields.filter((f) => f.policy.view && f.policy.unmask && (f.policy.maskInList || f.policy.maskInDetail)).map((f) => f.field.key);
  if (concealed.length === 0) return { result: "NOTHING", message: null, usage: null };

  const [viewAs, meta] = await Promise.all([viewAsContext(), unmaskRequestMeta()]);
  const subject: UnmaskSubject = { userId: user.id, userName: user.name ?? "", impersonatedByUserId: viewAs?.actor.id ?? null, entity: "contacts", recordId: id, ref: null };

  const contact = await db.contact.findFirst({ where: { AND: [{ id }, await contactAccess(user.id, "view")] }, select: { id: true, company: { select: { name: true } } } });
  if (!contact) {
    await logUnmaskDenied(subject, concealed, "Not a contact this person can open.", meta, stated);
    return { result: "DENIED", message: NOT_FOUND, usage: null };
  }
  // The log's reference: whose contact it is, not the person's own (possibly masked) name.
  subject.ref = `Contact at ${contact.company.name}`.slice(0, 120);

  if (revealable.length === 0) {
    await logUnmaskDenied(subject, concealed, "No permission to unmask these fields.", meta, stated);
    return { result: "DENIED", message: "You can't unmask this contact's hidden fields.", usage: await unmaskUsageToday(user.id) };
  }
  if (viewAs) {
    await logUnmaskDenied(subject, revealable, `While ${viewAs.actor.name} was viewing as ${viewAs.user.name}.`, meta, stated);
    return { result: "DENIED", message: `You're viewing as ${viewAs.user.name}. Fields stay masked: unmasking would use their daily limit.`, usage: await unmaskUsageToday(user.id) };
  }
  // Every field it may reveal already revealed today: nothing to do, and nothing worth a log row (as before).
  const covered = await revealedFieldsToday(user.id, "contacts", id);
  if (covered && revealable.every((k) => covered.has(k))) return { result: "REPEAT", message: null, usage: await unmaskUsageToday(user.id) };

  const attempt = await revealRecord(user.id, "contacts", id, revealable, stated, { ref: subject.ref, userName: subject.userName, meta });
  switch (attempt.result) {
    case "ALLOWED":
    case "REPEAT":
      return { result: attempt.result, message: null, usage: attempt.usage };
    case "QUOTA_EXHAUSTED":
      return {
        result: "QUOTA_EXHAUSTED",
        message: `You've unmasked ${attempt.usage.limit} leads and contacts today, your daily limit. It resets at midnight.`,
        usage: attempt.usage,
      };
    default:
      return { result: "DENIED", message: NOT_FOUND, usage: attempt.usage };
  }
}
