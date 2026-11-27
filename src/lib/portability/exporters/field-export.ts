import { exportAnswers, fieldMasker, resolveFieldPolicies } from "@/lib/authz/fields";
import { CUSTOM_FIELD_PREFIX, isCustomFieldKey, type FieldEntity } from "@/lib/authz/field-policy";
import { maskContactRows, type MaskFlags } from "@/lib/contacts/masking";

/**
 * Field access in a file (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.4): every export — the Settings › Data
 * exports, the account workbook, the leads CSV — is the list's answers plus each field's `export`: the "export" context
 * the presenters take (src/lib/authz/field-policy.ts `exportVisibility`). What can't be handed that context is here.
 */

/**
 * Whether a field is masked by its export answer though the list shows it in the clear — such a cell goes out blank in
 * a file that is read back in. The leads and companies imports (src/lib/portability/importers/leads.ts, companies.ts)
 * leave alone what the *list* masks for the person importing, so a cell masked only by the export would read as typed,
 * and "O********" be saved over the real title of every lead in the file handed back. Blank is their "leave alone".
 * The contacts import knows a masked value by its stars, and the account workbook and the leads CSV are never read
 * back: those carry the masked value itself.
 */
export async function maskedOnlyInExports(userId: string, entity: FieldEntity): Promise<(field: string) => boolean> {
  const answers = await exportAnswers(userId, entity);
  return (field) => {
    const a = answers.get(field);
    return !!a && a.export === "masked" && a.list === "clear";
  };
}

/**
 * The custom fields (their keys, without `custom:`) a file leaves blank (`exportCells`' `hiddenFor`): those left out of
 * exports, and those the export masks where the list shows them in the clear — src/lib/custom-fields/sheets.ts masks a
 * custom cell as the list does, and can't be asked to mask it further. One exported "in the clear" that the list masks
 * stays masked there: never more than the list shows, in a custom column.
 */
export async function customLeftBlank(userId: string, entity: FieldEntity): Promise<ReadonlySet<string>> {
  const answers = await exportAnswers(userId, entity);
  const out = new Set<string>();
  for (const [key, a] of answers) {
    if (!isCustomFieldKey(key)) continue;
    if (a.export === "none" || (a.export === "masked" && a.list === "clear")) out.add(key.slice(CUSTOM_FIELD_PREFIX.length));
  }
  return out;
}

type ContactRow = { id: string; name: string; email: string | null; phone: string | null; emailCheckedValue?: string | null; emailCheckDetail?: string | null; customFields?: unknown };

/**
 * Contacts as a file carries them: the presenter in the "export" context — a contact "Show"n today in the clear as the
 * Contacts list shows it, where the export is the list's — except a field whose export is set to masked, which a reveal
 * doesn't open: a file has no "Show", and "masked" is masked even where the screen is clear.
 */
export async function contactsForExport<T extends ContactRow>(userId: string, rows: T[]): Promise<(T & MaskFlags)[]> {
  const out = await maskContactRows(userId, "export", rows);
  const resolved = await resolveFieldPolicies(userId, "contacts");
  const forced = (["name", "email", "phone"] as const).filter((f) => resolved.fields.get(f)?.policy.export === "masked");
  if (forced.length === 0) return out;
  const plain = await fieldMasker(userId, "contacts", "export");
  return out.map((row, i) => {
    const stored = rows[i]!;
    const next = { ...row, masked: { ...row.masked } };
    const values = next as ContactRow;
    for (const field of forced) {
      const raw = stored[field];
      if (raw == null || values[field] !== raw) continue;
      if (field === "name") values.name = plain.present("name", raw) ?? "";
      else values[field] = plain.present(field, raw);
      next.masked[field] = true;
      if (field === "email" && "emailCheckedValue" in values) Object.assign(values, { emailCheckedValue: null, emailCheckDetail: null });
    }
    return next;
  });
}
