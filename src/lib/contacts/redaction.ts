import type { FieldMasker } from "@/lib/authz/fields";
import type { ContactMasker } from "@/lib/contacts/masking";
import { leadRedactor, type TextRedactor } from "@/lib/leads/masking";

/**
 * A contact's concealed values masked wherever text quotes them (owner, 5 Nov 2026 — Phase 3 masking fixes, audit
 * H.4.7 "central redaction"): a call's notes naming the person and the number dialled, an email's subject and body,
 * a bounce saying which address bounced. The lead redactor (src/lib/leads/masking.ts `leadRedactor`) — one swap per
 * concealed value, longest first, in any case — run with the contacts policy (src/lib/contacts/masking.ts) instead of
 * the leads one, so a contact "Show"n today is in the clear here too, as it is in the Contacts list.
 *
 * `contactId` null: values with no contact behind them (a number nobody is on file with) are masked as the policy
 * masks that field, with no reveal to honour. Best-effort, as the lead's is (audit L-8): a value written another way
 * ("98100 00001" for "+919810000001") isn't caught.
 */
export function contactRedactor(m: ContactMasker, contactId: string | null, values: Array<["name" | "email" | "phone", string | null | undefined]>): TextRedactor {
  const id = contactId ?? "";
  // Only `active` and `present` are what the redactor asks of a masker.
  const asFields: FieldMasker = {
    active: m.active,
    context: "list",
    present: (field, value) => m.present(id, field as "name" | "email" | "phone", value),
    visibility: (field) => (m.hidden(id).includes(field) ? "masked" : "clear"),
    policy: () => null,
  };
  return leadRedactor(asFields, values);
}
