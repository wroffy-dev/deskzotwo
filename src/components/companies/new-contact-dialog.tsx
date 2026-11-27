"use client";

import { useEffect, useState } from "react";
import { addContact, contactFieldSetup } from "@/actions/company";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import {
  CustomFieldInputs,
  missingRequired,
  type CustomFieldFormValues,
  type CustomFieldPerson,
} from "@/components/custom-fields/custom-field-inputs";
import type { CustomFieldDef } from "@/lib/custom-fields/rules";
import { DesignationInput } from "@/components/contacts/designation-input";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";
import { PhoneInput } from "@/components/ui/phone-input";

const EMPTY = { name: "", designationName: "", email: "", phone: "" };

type FieldSetup = { fields: CustomFieldDef[]; values: CustomFieldFormValues; people: CustomFieldPerson[] };
const NO_FIELDS: FieldSetup = { fields: [], values: {}, people: [] };

export type CreatedContact = { id: string; name: string; designation: string };

/**
 * A new person at a company that already exists — from inside whatever form needed them.
 *
 * The lead form lists the company's contacts, and the person a new requirement came from is often
 * somebody not on it yet. Without this the only way to add them was to abandon the lead, go to the
 * company, add the contact, and start the lead again.
 *
 * Saved through `addContact`, so the same validation and the same account scope apply as on the
 * company page — a company this person cannot see answers "not found" here too. New ticket saves
 * through its own action (`addTicketContact`), for support who log tickets but don't change accounts.
 */
export function NewContactDialog({
  open,
  companyId,
  companyName,
  initialPhone = "",
  save: add = addContact,
  fieldSetup = contactFieldSetup,
  note = "Added to the company's contacts, and picked for this lead.",
  onClose,
  onCreated,
}: {
  open: boolean;
  companyId: string;
  companyName: string;
  /** The person's number already in, for a lead made from a call (src/lib/telephony). */
  initialPhone?: string;
  /** How they are saved, and where the workspace's own fields come from, for a form with a rule of its own (New ticket). */
  save?: typeof addContact;
  fieldSetup?: typeof contactFieldSetup;
  /** What happens to them, under the form. */
  note?: string;
  onClose: () => void;
  onCreated: (contact: CreatedContact) => void;
}) {
  const w = useWording();
  const [form, setForm] = useState({ ...EMPTY, phone: initialPhone });
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [wasOpen, setWasOpen] = useState(open);
  /**
   * The workspace's own contact fields (src/lib/custom-fields) — asked for the first time the dialog
   * opens, because the forms that open it know nothing about contacts. Null until they arrive.
   */
  const [setup, setSetup] = useState<FieldSetup | null>(null);
  const [custom, setCustom] = useState<CustomFieldFormValues>({});
  const [customErrors, setCustomErrors] = useState<Record<string, string>>({});

  // Fresh each time it opens — adjusted during render, as the quick-create dialog does.
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) {
      setForm({ ...EMPTY, phone: initialPhone });
      setError(null);
      setCustom(setup?.values ?? {});
      setCustomErrors({});
    }
  }

  useEffect(() => {
    if (!open || setup) return;
    let live = true;
    fieldSetup().then(
      (loaded) => {
        if (live) setSetup(loaded);
      },
      // Without them the person is still added — and a field the server insists on says so.
      () => {
        if (live) setSetup(NO_FIELDS);
      },
    );
    return () => {
      live = false;
    };
  }, [open, setup, fieldSetup]);

  const set = (key: keyof typeof EMPTY) => (e: { target: { value: string } }) =>
    setForm((prev) => ({ ...prev, [key]: e.target.value }));

  async function save(e: React.FormEvent) {
    e.preventDefault();
    // The dialog is portalled to <body>, but React still bubbles its events up the component tree —
    // so without this, submitting it from inside another form would submit that form as well.
    e.stopPropagation();
    const name = form.name.trim();
    if (!name) {
      setError("Their name is needed.");
      return;
    }
    const missing = missingRequired(setup?.fields ?? [], custom);
    setCustomErrors(missing);
    if (Object.keys(missing).length > 0) return;
    setSaving(true);
    setError(null);
    const result = await add(companyId, {
      name,
      designationName: form.designationName,
      email: form.email.trim(),
      phone: form.phone.trim(),
      isPrimary: false,
      customFields: custom,
    });
    setSaving(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }
    onCreated({ id: result.data.id, name, designation: form.designationName.trim() || "OTHER" });
  }

  return (
    <Dialog open={open} onClose={onClose} title={`${slot(w, "New contact", "contact", "New {one:lower}")} at ${companyName}`}>
      <form onSubmit={save} className="space-y-3">
        {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}
        <div className="grid grid-cols-2 gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="nc-name">Name *</Label>
            <Input id="nc-name" value={form.name} onChange={set("name")} autoComplete="off" autoFocus />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nc-designation">Designation</Label>
            <DesignationInput id="nc-designation" value={form.designationName} onChange={set("designationName")} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nc-email">Email</Label>
            <Input id="nc-email" type="email" value={form.email} onChange={set("email")} autoComplete="off" />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="nc-phone">Phone</Label>
            <PhoneInput id="nc-phone" value={form.phone} onChange={(v) => set("phone")({ target: { value: v } })} autoComplete="off" />
          </div>
        </div>
        {setup && setup.fields.length > 0 && (
          <CustomFieldInputs
            fields={setup.fields}
            values={custom}
            people={setup.people}
            errors={customErrors}
            idPrefix="nc-cf"
            disabled={saving}
            onChange={(key, value) => {
              setCustom((prev) => ({ ...prev, [key]: value }));
              setCustomErrors((prev) => {
                if (!prev[key]) return prev;
                const next = { ...prev };
                delete next[key];
                return next;
              });
            }}
          />
        )}
        <p className="text-xs text-subtle">{note}</p>
        <div className="flex justify-end gap-2 pt-1">
          <Button type="button" variant="secondary" size="sm" onClick={onClose}>
            Cancel
          </Button>
          {/* Not before the workspace's own fields are known: a required one would only be refused. */}
          <Button type="submit" size="sm" disabled={saving || !setup}>
            {saving ? "Adding…" : slot(w, "Add contact", "contact", "Add {one:lower}")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}
