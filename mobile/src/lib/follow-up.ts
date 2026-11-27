/**
 * The follow-up after a call (owner, 11 Nov 2026 — GET and POST /api/app/calls/:id/follow-up; src/lib/app/follow-up.ts
 * on the server): what the server says can be sent, and filling a template's fields for the preview.
 *
 * The filling is the server's rule (src/lib/quick-messages/fields.ts), kept in step by hand: `{{field}}`, or
 * `{{field|fallback}}`; a field with no value and no fallback stops the message. The server fills them again when it
 * sends, per person, so this is only what the sender reads first.
 */

export type FollowUpContact = { id: string; name: string; email: string | null; phone: string | null; primary: boolean; email_stopped: string | null; whatsapp_open: boolean };

export type FollowUpTemplate = {
  id: string;
  name: string;
  email_subject: string | null;
  email_body: string | null;
  whatsapp_body: string | null;
  /** Meta has approved it, so it can go outside WhatsApp's 24 hours. */
  whatsapp_approved: boolean;
  attachment: { name: string; size: number } | null;
};

export type FollowUp = {
  company: string;
  from: string;
  email: { ready: boolean; note: string };
  whatsapp: { ready: boolean; note: string };
  contacts: FollowUpContact[];
  /** The number dialled, when nobody on file has it. */
  loose: { phone: string; whatsapp_open: boolean } | null;
  values: Record<string, string | null>;
  templates: FollowUpTemplate[];
};

export type FollowUpSent = { sent: number; skipped: { name: string; why: string }[]; note: string | null };

const FIELD = /\{\{\s*([a-zA-Z]+)\s*(?:\|([^}]*))?\}\}/g;

export function fill(template: string, values: Record<string, string | null | undefined>): { text: string; missing: string[] } {
  const missing = new Set<string>();
  const text = template.replace(FIELD, (whole, key: string, fallback: string | undefined) => {
    const value = values[key]?.toString().trim();
    if (value) return value;
    if (fallback !== undefined) return fallback.trim();
    missing.add(key);
    return whole;
  });
  return { text, missing: [...missing] };
}

export const valuesFor = (base: Record<string, string | null>, name: string | null): Record<string, string | null> => ({
  ...base,
  fullName: name,
  firstName: name ? name.trim().split(/\s+/)[0]! : null,
});

export const fileSize = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);
