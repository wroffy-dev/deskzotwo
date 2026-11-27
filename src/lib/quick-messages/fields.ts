/**
 * Messages sent by hand from a template (owner, 11 Nov 2026): the fields a template can name, and filling them in.
 *
 * The same writing as Marketing's templates — `{{firstName}}`, or `{{firstName|there}}` with a fallback — and the
 * same rule: a field with no value and no fallback stops the message, so "Hi ," never reaches a customer. A person
 * reads the preview before it goes, so what is missing is said there, with the field's name.
 *
 * WhatsApp outside the 24 hours a customer's own message opens takes only a template Meta approved, with its fields
 * as {{1}}, {{2}}… — `whatsappVariables` gives a text's values in the order its fields first appear, and
 * `metaText` the text to submit to Meta, so the two can't number them differently.
 *
 * Dependency-free: the settings screen and the send dialog lay themselves out from it.
 */

export const QUICK_MOMENTS = ["MANAGER_CHANGED", "AFTER_CALL", "ANY"] as const;
export type QuickMoment = (typeof QUICK_MOMENTS)[number];
export const QUICK_MOMENT_LABELS: Record<QuickMoment, string> = {
  MANAGER_CHANGED: "Account manager changed",
  AFTER_CALL: "After a call",
  ANY: "Any time",
};

export const CALL_RESULTS = ["ANY", "CONNECTED", "NOT_CONNECTED"] as const;
export type CallResult = (typeof CALL_RESULTS)[number];
export const CALL_RESULT_LABELS: Record<CallResult, string> = { ANY: "Any call", CONNECTED: "A call that connected", NOT_CONNECTED: "A call that didn't connect" };

/** Which templates a call's outcome offers: spoken to them, or not. */
export function callResultOf(outcome: string | null | undefined): Exclude<CallResult, "ANY"> | null {
  if (!outcome) return null;
  return outcome === "CONNECTED" || outcome === "CALLBACK_REQUESTED" || outcome === "NOT_INTERESTED" ? "CONNECTED" : "NOT_CONNECTED";
}

export type QuickField = { key: string; label: string; example: string; source: string; only?: QuickMoment };

export const QUICK_FIELDS: QuickField[] = [
  { key: "firstName", label: "First name", example: "Rajesh", source: "The contact's name, first word only" },
  { key: "fullName", label: "Full name", example: "Rajesh Kumar", source: "The contact's name" },
  { key: "companyName", label: "Their company", example: "Vertex Industries LLP", source: "The customer's name" },
  { key: "ourName", label: "Our name", example: "Acme", source: "Trade name from organisation settings" },
  { key: "myName", label: "Sender's name", example: "Priya Sharma", source: "Whoever it is sent from" },
  { key: "myPhone", label: "Sender's phone", example: "+91 98765 43210", source: "Their phone, from their profile" },
  { key: "myEmail", label: "Sender's email", example: "priya@example.com", source: "Their sign-in address" },
  { key: "newManagerName", label: "New account manager", example: "Priya Sharma", source: "Who manages the account now", only: "MANAGER_CHANGED" },
  { key: "newManagerPhone", label: "New account manager's phone", example: "+91 98765 43210", source: "Their phone, from their profile", only: "MANAGER_CHANGED" },
  { key: "newManagerEmail", label: "New account manager's email", example: "priya@example.com", source: "Their sign-in address", only: "MANAGER_CHANGED" },
  { key: "oldManagerName", label: "Previous account manager", example: "Arjun Mehta", source: "Who managed it before", only: "MANAGER_CHANGED" },
];

const KNOWN = new Set(QUICK_FIELDS.map((f) => f.key));
const FIELD = /\{\{\s*([a-zA-Z]+)\s*(?:\|([^}]*))?\}\}/g;

export type QuickValues = Partial<Record<string, string | null>>;
export type Filled = { ok: boolean; text: string; missing: string[]; unknown: string[]; used: string[] };

/** A template's text with its fields filled. Not ok when a field has no value and no fallback, or isn't a field. */
export function fill(template: string, values: QuickValues): Filled {
  const missing = new Set<string>();
  const unknown = new Set<string>();
  const used = new Set<string>();
  const text = template.replace(FIELD, (whole, key: string, fallback: string | undefined) => {
    if (!KNOWN.has(key)) {
      unknown.add(key);
      return whole;
    }
    used.add(key);
    const value = values[key]?.toString().trim();
    if (value) return value;
    if (fallback !== undefined) return fallback.trim();
    missing.add(key);
    return whole;
  });
  return { ok: missing.size === 0 && unknown.size === 0, text, missing: [...missing], unknown: [...unknown], used: [...used] };
}

/** The fields a text names, each once, in the order they first appear — WhatsApp's {{1}}, {{2}}… */
export function fieldsInOrder(template: string): { key: string; fallback: string | null }[] {
  const out: { key: string; fallback: string | null }[] = [];
  for (const m of template.matchAll(FIELD)) {
    if (!out.some((f) => f.key === m[1])) out.push({ key: m[1]!, fallback: m[2] === undefined ? null : m[2].trim() });
  }
  return out;
}

/** The text to submit to Meta for approval: the same words, its fields numbered as WhatsApp wants them. */
export function metaText(template: string): string {
  const order = fieldsInOrder(template).map((f) => f.key);
  return template.replace(FIELD, (_whole, key: string) => `{{${order.indexOf(key) + 1}}}`);
}

/** A WhatsApp template's values, in Meta's order. Null when one has no value and no fallback. */
export function whatsappVariables(template: string, values: QuickValues): { ok: true; variables: string[] } | { ok: false; missing: string[] } {
  const missing: string[] = [];
  const variables = fieldsInOrder(template).map((f) => {
    const value = values[f.key]?.toString().trim() || f.fallback || "";
    if (!value) missing.push(f.key);
    return value;
  });
  return missing.length ? { ok: false, missing } : { ok: true, variables };
}

export const fieldLabel = (key: string) => QUICK_FIELDS.find((f) => f.key === key)?.label ?? key;

/** What stops a template being saved, in words; null when it is fine. */
export function templateRefusal(t: { name: string; emailSubject?: string | null; emailBody?: string | null; whatsappBody?: string | null; whatsappTemplateName?: string | null }): string | null {
  if (!t.name.trim()) return "Give the template a name.";
  const email = !!t.emailBody?.trim();
  const whatsapp = !!t.whatsappBody?.trim();
  if (!email && !whatsapp) return "Write the email, the WhatsApp message, or both.";
  if (email && !t.emailSubject?.trim()) return "The email needs a subject.";
  for (const text of [t.emailSubject, t.emailBody, t.whatsappBody]) {
    const strange = text ? fill(text, {}).unknown : [];
    if (strange.length) return `{{${strange[0]}}} isn't a field — pick one from the list.`;
  }
  const name = t.whatsappTemplateName?.trim();
  if (name && !/^[a-z0-9_]{1,512}$/.test(name)) return "Give the WhatsApp template's name as Meta has it: lower case, digits and underscores.";
  if (name && !whatsapp) return "Write the WhatsApp message its Meta template says.";
  if (whatsapp && fieldsInOrder(t.whatsappBody!).length > 10) return "A WhatsApp template takes at most ten fields.";
  return null;
}
