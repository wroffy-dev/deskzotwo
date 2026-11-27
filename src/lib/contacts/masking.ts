import { fieldMasker, maskCustomValues, resolveFieldPolicies, type FieldMasker } from "@/lib/authz/fields";
import { revealedFieldsAmong } from "@/lib/authz/unmask";
import { visibility, type FieldContext } from "@/lib/authz/field-policy";

/**
 * Field access applied to contacts (owner, 3 Nov 2026: "why no masking here" — the Contacts list showed every
 * contact's email and phone in full). The contact twin of src/lib/leads/masking.ts: what one person may see of a
 * contact's name, email, phone and custom fields, worked out on the server before a value is put in a response.
 *
 *   · "list" — the Contacts list, search, pickers and exports: many contacts at once.
 *   · "detail" — a customer's own Contacts tab: that company's people.
 *
 * A contact has no page of its own, so it is unmasked where it is shown: "Show" beside it uses a unit of the same
 * daily limit as a lead (src/actions/contact-unmask.ts), and for the rest of the day that contact's revealable fields
 * show in the clear wherever this person meets it — in lists too, as there's nowhere else to read them.
 *
 * Calling and WhatsApp don't need the number in the browser: the click hands the server the contact, which dials it
 * (src/components/calls/call-button.tsx) — so a masked number can still be called.
 */

export const contactKey = (contactId: string) => `contact:${contactId}`;

export type ContactMasker = {
  /** False when nothing about contacts is masked or restricted for this person — values go out as they are. */
  active: boolean;
  /** A field as this person sees it on this contact. */
  present(contactId: string, field: "name" | "email" | "phone", value: string | null | undefined): string | null;
  /** Custom field values, masked or left out as their policies say. */
  custom<V extends Record<string, unknown>>(contactId: string, values: V): V;
  /** Whether anything of this contact is hidden from them here right now. */
  concealed(contactId: string): boolean;
  /** Whether "Show" would reveal something of it — masked here, may unmask, not yet today. */
  revealable(contactId: string): boolean;
  /** The fields of this contact not shown in the clear to them here — kept as stored when they save the contact. */
  hidden(contactId: string): string[];
  /** Whether the field is masked (not merely restricted) — a click-to-call still dials it. */
  masked(contactId: string, field: "email" | "phone"): boolean;
};

const CLEAR: ContactMasker = {
  active: false,
  present: (_id, _f, v) => v ?? null,
  custom: (_id, v) => v,
  concealed: () => false,
  revealable: () => false,
  hidden: () => [],
  masked: () => false,
};

/** For contacts shown together: `ids` are the ones on the page, so today's reveals are read in one query. */
export async function contactMasker(userId: string, context: FieldContext, ids: string[]): Promise<ContactMasker> {
  const base: FieldMasker = await fieldMasker(userId, "contacts", context);
  if (!base.active) return CLEAR;
  const resolved = await resolveFieldPolicies(userId, "contacts");
  const fields = [...resolved.fields.values()];
  const revealableKeys = new Set(fields.filter((f) => visibility(f.policy, context) === "masked" && f.policy.unmask).map((f) => f.field.key));
  const concealedKeys = fields.filter((f) => visibility(f.policy, context) !== "clear").map((f) => f.field.key);
  // Today's reveals, by the fields each covered (owner, 5 Nov 2026 — Phase 3 masking fixes, audit C.3.6): a field
  // granted since stays masked until "Show" again. A lead's reveal reveals its contact too (audit H.5), as a row here.
  const covered = revealableKeys.size ? await revealedFieldsAmong(userId, "contacts", ids) : new Map<string, Set<string>>();
  const clearFor = (id: string, field: string) => revealableKeys.has(field) && (covered.get(id)?.has(field) ?? false);
  return {
    active: true,
    present: (id, field, value) => (clearFor(id, field) ? (value ?? null) : base.present(field, value)),
    custom: (id, values) =>
      covered.has(id)
        ? maskCustomValues({ ...base, visibility: (f) => (clearFor(id, f) ? "clear" : base.visibility(f)), present: (f, v) => (clearFor(id, f) ? (v ?? null) : base.present(f, v)) }, values)
        : maskCustomValues(base, values),
    concealed: (id) => concealedKeys.some((k) => !clearFor(id, k)),
    revealable: (id) => [...revealableKeys].some((k) => !clearFor(id, k)),
    hidden: (id) => concealedKeys.filter((k) => !clearFor(id, k)),
    masked: (id, field) => base.visibility(field) === "masked" && !clearFor(id, field),
  };
}

/** A contact row as a screen gets it, with what was masked on it said — so it can offer "Show" and still dial. */
export type MaskFlags = { masked: { name: boolean; email: boolean; phone: boolean }; revealable: boolean };

type Maskable = { id: string; name: string; email: string | null; phone: string | null; emailCheckedValue?: string | null; emailCheckDetail?: string | null; customFields?: unknown };

/**
 * Contacts as this person may see them here — name, email and phone masked or restricted as their field access says,
 * a masked email's verification fields gone with it (`emailCheckedValue` is the address itself), custom fields
 * masked as theirs say. Rows already redacted for a reseller's end customer stay redacted.
 */
export async function maskContactRows<T extends Maskable>(userId: string, context: FieldContext, rows: T[]): Promise<(T & MaskFlags)[]> {
  const masker = await contactMasker(userId, context, rows.map((r) => r.id));
  const none = { masked: { name: false, email: false, phone: false }, revealable: false };
  if (!masker.active) return rows.map((r) => ({ ...r, ...none }));
  return rows.map((r) => {
    const name = masker.present(r.id, "name", r.name) ?? "";
    const email = r.email === null ? null : masker.present(r.id, "email", r.email);
    const phone = r.phone === null ? null : masker.present(r.id, "phone", r.phone);
    const maskedEmail = r.email !== null && email !== r.email;
    const out = {
      ...r,
      name,
      email,
      phone,
      ...(maskedEmail && "emailCheckedValue" in r ? { emailCheckedValue: null, emailCheckDetail: null } : {}),
      ...(r.customFields && typeof r.customFields === "object" ? { customFields: masker.custom(r.id, r.customFields as Record<string, unknown>) } : {}),
      masked: { name: name !== r.name, email: maskedEmail, phone: r.phone !== null && phone !== r.phone },
      revealable: masker.concealed(r.id) && masker.revealable(r.id),
    };
    return out as T & MaskFlags;
  });
}

/**
 * Whether this person sees contacts' names, emails or phones masked in lists — a list search then can't match on them.
 *
 * The name too (security audit round three, 14 Nov 2026 — R3-21): a search that still matched a masked name answered
 * it letter by letter ("a" matches, "an" matches, "ana"…), the API's search included. Where the name is masked a
 * search leaves it out, and a list doesn't sort by it.
 */
export async function maskedInLists(userId: string): Promise<{ name: boolean; email: boolean; phone: boolean }> {
  const m = await fieldMasker(userId, "contacts", "list");
  return { name: m.active && m.visibility("name") !== "clear", email: m.active && m.visibility("email") !== "clear", phone: m.active && m.visibility("phone") !== "clear" };
}

/**
 * The number a call dials when the screen sent a masked one (owner, 3 Nov 2026): the contact's own, read here — so a
 * sales person can call a customer whose number they see as "+91 ******4321" without the browser ever holding it. Only
 * for a contact of the company being called, and only where the phone is masked for them, not restricted outright: a
 * number somebody may not read at all isn't theirs to ring either. Anything else is dialled as sent.
 */
export async function dialledNumber(userId: string, input: { phoneNumber: string; contactId?: string; companyId: string }): Promise<{ number: string; masked: boolean }> {
  const sent = input.phoneNumber?.trim() ?? "";
  if (!sent.includes("*") || !input.contactId) return { number: sent, masked: false };
  const { db } = await import("@/lib/db");
  const contact = await db.contact.findUnique({ where: { id: input.contactId }, select: { companyId: true, phone: true } });
  if (!contact || contact.companyId !== input.companyId || !contact.phone) return { number: sent, masked: false };
  const resolved = await resolveFieldPolicies(userId, "contacts");
  const policy = resolved.fields.get("phone")?.policy;
  if (!policy?.view) return { number: sent, masked: false };
  return { number: contact.phone, masked: true };
}
