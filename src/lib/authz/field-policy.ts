/**
 * Field access — the third of the three questions in docs/permission-redesign.md (§4.5): which
 * fields of a record somebody may read, which of them are masked, and which they may unmask.
 *
 * Dependency-free, so the role and person editors draw the same masks the server sends. The server
 * half — reading the stored policies and resolving them for one person — is src/lib/authz/fields.ts.
 *
 * ## Four separate answers per field
 *
 *   view          may the value be read at all. Off: the raw value never leaves the server — not
 *                 masked, not in a data attribute — only the word "Restricted" does.
 *   maskInList    shown masked wherever many records are listed: tables, boards, pickers, search,
 *                 dashboards, related-record previews, exports and reports.
 *   maskInDetail  shown masked on the record's own page until it is unmasked.
 *   unmask        may a masked value be revealed on the record's own page. Each lead revealed counts
 *                 once a day against the person's daily limit (src/lib/authz/unmask.ts).
 *   export        how the value leaves the building — an export file, the API's lists (owner, 5 Nov 2026 — Phase 3
 *                 masking fixes, audit H.4.4): null "as the list", "none" left out, "masked" masked even where the
 *                 screens show it, "clear" in the clear only where the person may see it so somewhere. The "export"
 *                 context below (`exportVisibility`).
 *
 * The answers are independent on purpose. Switching masking off never grants reading: a field
 * somebody may not view stays restricted whatever its mask switches say. And unmasking needs view.
 *
 * ## Where a policy comes from — the first that answers is final
 *
 *   1. Super admin            → everything readable, nothing masked.
 *   2. Inactive / automation  → nothing readable.
 *   3. The person's own policy for the field (`UserFieldPolicy`, unexpired).
 *   4. Their role's policy (`RoleFieldPolicy`).
 *   5. Nothing stored         → readable and unmasked, which is how every field worked before field
 *                               access existed. Nothing changes for anybody until an admin sets a policy.
 *
 * Field access narrows what the existing rules allow; it never widens them. A reseller's end
 * customer's email stays hidden without "View reseller-managed contact details", and a restricted
 * custom field without "See restricted fields", whatever a field policy says.
 */

export const FIELD_ENTITIES = ["leads", "contacts", "companies"] as const;
export type FieldEntity = (typeof FIELD_ENTITIES)[number];

/**
 * What each record type is called on the screens that set and show its masks. Contacts joined leads on 3 Nov 2026
 * (owner: "why no masking here" — the Contacts list showed every email and phone in full): a contact's own record,
 * wherever contacts are listed or opened, unmasked against the same daily limit as a lead. Companies joined on 5 Nov
 * 2026 (owner — Phase 3 masking fixes, audit H.4.1): their addresses, GSTINs, PAN, website and custom fields, on the
 * company's own record wherever it is listed, opened, exported or read by the API, the app or the copilot.
 */
export const FIELD_ENTITY_WORDS: Record<FieldEntity, { title: string; one: string; many: string }> = {
  leads: { title: "Leads", one: "lead", many: "leads" },
  contacts: { title: "Contacts", one: "contact", many: "contacts" },
  companies: { title: "Companies", one: "company", many: "companies" },
};

/**
 * Whether a masked value of a record type can be revealed ("Show", or the lead page). Every one now: a company's joined on
 * 5 Nov 2026 (owner — Phase 3 masking fixes, wave B: its "Show" on the generic reveal in src/lib/authz/unmask.ts, which
 * wave A held the editors' unmask switch back for). Kept as a table, so a record type added later can wait for its own.
 */
export const FIELD_ENTITY_REVEALS: Record<FieldEntity, boolean> = { leads: true, contacts: true, companies: true };

export function isFieldEntity(value: unknown): value is FieldEntity {
  return typeof value === "string" && (FIELD_ENTITIES as readonly string[]).includes(value);
}

export const MASK_FORMATS = ["first", "stars", "email", "phone_last4", "phone_code", "partial_address"] as const;
export type MaskFormat = (typeof MASK_FORMATS)[number];

export const MASK_FORMAT_LABELS: Record<MaskFormat, string> = {
  first: "First letter (A********)",
  stars: "Fully hidden (********)",
  email: "Email (s*****@g***.com)",
  phone_last4: "Country code and last four (+91 ******4321)",
  phone_code: "Country code only (+91 ******)",
  partial_address: "City only (********, Pune)",
};

/** What a field is, for choosing the masks it offers. */
export type FieldKind = "text" | "email" | "phone" | "address" | "choice";

export type SensitiveField = {
  entity: FieldEntity;
  /** Stable key; a custom field is `custom:<its key>`. */
  key: string;
  label: string;
  description: string;
  kind: FieldKind;
};

/** The built-in fields of each record that field access covers. Custom fields are added per workspace. */
export const SENSITIVE_FIELDS: readonly SensitiveField[] = [
  { entity: "leads", key: "title", label: "Lead name", description: "The lead's own name — usually the enquiry or the person.", kind: "text" },
  { entity: "leads", key: "companyName", label: "Company name", description: "The name of the company the lead is for, wherever the lead is shown.", kind: "text" },
  { entity: "leads", key: "contactName", label: "Contact name", description: "The name of the person the lead is with.", kind: "text" },
  { entity: "leads", key: "email", label: "Email", description: "The lead contact's email address.", kind: "email" },
  { entity: "leads", key: "phone", label: "Phone", description: "The lead contact's phone numbers.", kind: "phone" },
  { entity: "leads", key: "address", label: "Address", description: "The address of the lead's company.", kind: "address" },
  { entity: "leads", key: "source", label: "Lead source", description: "Where the enquiry came from, and its particulars.", kind: "choice" },
  // Not one of the six asked for by name, but the message a website or form sent lands here — often the
  // person's own words, number and address — so masking the rest and leaving this open would leave it open.
  { entity: "leads", key: "description", label: "Enquiry details", description: "The lead's description: the enquiry message and anything a website or form sent with it.", kind: "text" },
  { entity: "contacts", key: "name", label: "Name", description: "The contact's name, wherever contacts are listed or picked.", kind: "text" },
  { entity: "contacts", key: "email", label: "Email", description: "The contact's email address — on Contacts, a customer's Contacts tab, search and exports.", kind: "email" },
  { entity: "contacts", key: "phone", label: "Phone", description: "The contact's phone number. Calling and WhatsApp still work: the number is dialled, not shown.", kind: "phone" },
  // A company's own (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.1; src/lib/companies/masking.ts). Not its name:
  // that is the record's identity, the label on every order, ticket, invoice and payment, and masking it would be a
  // promise the app can't keep. Trade documents print the address as issued — they are the workspace's own.
  { entity: "companies", key: "address", label: "Address", description: "Every address of the company — street, city, state and PIN code, on each of its locations. Invoices and other documents still print it as issued.", kind: "address" },
  { entity: "companies", key: "gstin", label: "GSTIN", description: "The GST number (or TRN) of each of its locations. A GSTIN carries the PAN, and its first two digits the state.", kind: "text" },
  { entity: "companies", key: "pan", label: "PAN", description: "The company's PAN. Every GSTIN carries it too — mask GSTIN as well to hide it.", kind: "text" },
  { entity: "companies", key: "website", label: "Website", description: "The company's website, on its page, in lists, exports, the API and the app.", kind: "text" },
];

export const CUSTOM_FIELD_PREFIX = "custom:";

export function customFieldKey(key: string): string {
  return `${CUSTOM_FIELD_PREFIX}${key}`;
}

export function isCustomFieldKey(key: string): boolean {
  return key.startsWith(CUSTOM_FIELD_PREFIX) && key.length > CUSTOM_FIELD_PREFIX.length;
}

/** A custom field's kind, from its type (src/lib/custom-fields/rules.ts). */
export function customFieldKind(type: string): FieldKind {
  if (type === "EMAIL") return "email";
  if (type === "PHONE") return "phone";
  if (type === "SELECT" || type === "MULTI_SELECT" || type === "CHECKBOX" || type === "USER") return "choice";
  return "text";
}

/** The masks a kind of field offers, the first being its default. */
export function formatsFor(kind: FieldKind): MaskFormat[] {
  switch (kind) {
    case "email":
      return ["email", "first", "stars"];
    case "phone":
      return ["phone_last4", "phone_code", "stars"];
    case "address":
      return ["stars", "partial_address", "first"];
    case "choice":
      return ["stars", "first"];
    case "text":
      return ["first", "stars"];
  }
}

export function defaultFormat(kind: FieldKind): MaskFormat {
  return formatsFor(kind)[0]!;
}

export function isMaskFormat(value: unknown): value is MaskFormat {
  return typeof value === "string" && (MASK_FORMATS as readonly string[]).includes(value);
}

/**
 * How a field leaves the building (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.4 and C.3.2): an export file,
 * the account workbook, the leads CSV and the API's lists. Null — the column's default — is "as the list shows it".
 *
 *   none    left out: the cell goes out blank (blank is "leave alone" when a file comes back).
 *   masked  masked even where the screens show it in the clear.
 *   clear   in the clear — but only where this person may see it in the clear somewhere (a list or the record's page);
 *           masked everywhere, it goes out masked, so a file never says more than the screens do.
 */
export const EXPORT_MODES = ["none", "masked", "clear"] as const;
export type ExportMode = (typeof EXPORT_MODES)[number];

export const EXPORT_MODE_LABELS: Record<ExportMode | "list", string> = {
  list: "As the list",
  none: "Left out",
  masked: "Masked",
  clear: "In the clear",
};

export function isExportMode(value: unknown): value is ExportMode {
  return typeof value === "string" && (EXPORT_MODES as readonly string[]).includes(value);
}

export type FieldPolicy = {
  view: boolean;
  maskInList: boolean;
  maskInDetail: boolean;
  unmask: boolean;
  format: MaskFormat;
  /** How it is exported; null is as the list (`EXPORT_MODES`). */
  export: ExportMode | null;
};

/** Rule 5: nothing stored — readable, unmasked. */
export function openPolicy(kind: FieldKind): FieldPolicy {
  return { view: true, maskInList: false, maskInDetail: false, unmask: false, format: defaultFormat(kind), export: null };
}

/** Rule 2: nothing readable. */
export function closedPolicy(kind: FieldKind): FieldPolicy {
  return { view: false, maskInList: false, maskInDetail: false, unmask: false, format: defaultFormat(kind), export: null };
}

/**
 * A stored row made consistent. A field that can't be read can't be masked or unmasked either — the
 * switches are kept off rather than left saying something the server won't do — and a format the kind
 * doesn't offer falls back to its default. Nor exported (owner, 5 Nov 2026 — audit H.4.4): restricted is restricted in a
 * file too, so its export is left as the list's; an export mode the server doesn't know is the list's as well.
 */
export function normalisePolicy(
  kind: FieldKind,
  row: { view: boolean; maskInList: boolean; maskInDetail: boolean; unmask: boolean; format: string | null; export?: string | null },
): FieldPolicy {
  const format = isMaskFormat(row.format) && formatsFor(kind).includes(row.format) ? row.format : defaultFormat(kind);
  if (!row.view) return { view: false, maskInList: false, maskInDetail: false, unmask: false, format, export: null };
  return { view: true, maskInList: row.maskInList, maskInDetail: row.maskInDetail, unmask: row.unmask && (row.maskInList || row.maskInDetail), format, export: isExportMode(row.export) ? row.export : null };
}

/**
 * Where a value is being shown. "export" (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.4): a file or the API's
 * lists — the list's answer with the field's `export` mode applied (`exportVisibility`), so every presenter that takes a
 * context (src/lib/leads/masking.ts, src/lib/contacts/masking.ts, src/lib/companies/masking.ts) exports the same way.
 */
export type FieldContext = "list" | "detail" | "export";

/** How one value goes out: as it is, masked, or not at all. */
export type FieldVisibility = "clear" | "masked" | "restricted";

export function visibility(policy: FieldPolicy, context: FieldContext): FieldVisibility {
  if (context === "export") {
    const seen = exportVisibility(policy);
    // Left out of an export is "not at all" to every presenter — nothing to mask, nothing to reveal.
    return seen === "none" ? "restricted" : seen;
  }
  if (!policy.view) return "restricted";
  const masked = context === "list" ? policy.maskInList : policy.maskInDetail;
  return masked ? "masked" : "clear";
}

/**
 * How a value goes into an export or an API list (owner, 5 Nov 2026 — audit H.4.4): the list's answer unless the field's
 * `export` says otherwise. "clear" is clear only where the person sees the value in the clear somewhere — in a list or
 * on the record's page — so an export never says more than the screens do; "none" is left out (blank), which is not
 * the same as restricted: a field they may not read at all goes out as the word "Restricted", as in a list.
 */
export function exportVisibility(policy: FieldPolicy): FieldVisibility | "none" {
  if (!policy.view) return "restricted";
  switch (policy.export) {
    case "none":
      return "none";
    case "masked":
      return "masked";
    case "clear":
      return policy.maskInList && policy.maskInDetail ? "masked" : "clear";
    default:
      return visibility(policy, "list");
  }
}

/** What a restricted value is replaced with: no part of it, and the same for every value. */
export const RESTRICTED_TEXT = "Restricted";

const STARS = "********";

/**
 * The masked form of a value. Deterministic, from the value itself, and never as long as the value
 * — every mask is a fixed run of stars around what the format shows, so the length of a name or an
 * address isn't given away either.
 */
export function maskValue(value: string | null | undefined, format: MaskFormat): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  if (!text) return text;
  switch (format) {
    case "stars":
      return STARS;
    case "first":
      return `${Array.from(text)[0]}${STARS}`;
    case "email":
      return maskEmail(text);
    case "phone_last4":
      return maskPhone(text, true);
    case "phone_code":
      return maskPhone(text, false);
    case "partial_address": {
      const parts = text.split(/[,\n]/).map((p) => p.trim()).filter(Boolean);
      const city = parts.length > 1 ? parts[parts.length - 1]! : null;
      return city && !/\d{3,}/.test(city) ? `${STARS}, ${city}` : STARS;
    }
  }
}

function maskEmail(text: string): string {
  const at = text.lastIndexOf("@");
  if (at <= 0 || at === text.length - 1) return `${Array.from(text)[0]}${STARS}`;
  const local = text.slice(0, at);
  const domain = text.slice(at + 1);
  const dot = domain.lastIndexOf(".");
  const tld = dot > 0 && dot < domain.length - 1 ? domain.slice(dot + 1) : null;
  return `${Array.from(local)[0]}*****@${Array.from(domain)[0]}***${tld ? `.${tld}` : ""}`;
}

function maskPhone(text: string, lastFour: boolean): string {
  const digits = text.replace(/\D/g, "");
  // A country code is shown only where the number says it has one.
  const code = /^\s*\+(\d{1,3})(?:[\s-]|\(|$)/.exec(text)?.[1] ?? (/^\s*\+/.test(text) && digits.length > 10 ? digits.slice(0, digits.length - 10) : null);
  const prefix = code ? `+${code} ` : "";
  if (!lastFour || digits.length < 8) return `${prefix}******`;
  return `${prefix}******${digits.slice(-4)}`;
}

/** The value as somebody with this policy sees it in this context, before any unmasking. */
export function presentValue(value: string | null | undefined, policy: FieldPolicy, context: FieldContext): string | null {
  // Left out of an export (audit H.4.4): nothing — the cell is blank — rather than the word a restricted field gets.
  if (context === "export" && exportVisibility(policy) === "none") return null;
  switch (visibility(policy, context)) {
    case "clear":
      return value ?? null;
    case "restricted":
      // The same word whether or not there is a value: even "this lead has no phone" is the field's.
      return RESTRICTED_TEXT;
    case "masked":
      return maskValue(value, policy.format);
  }
}

/**
 * How open a policy leaves a field in one context, narrow to wide: not readable, masked, masked but
 * may be unmasked, in the clear. For "nobody gives more than they have" — the field twin of granting
 * only the permissions you hold yourself.
 */
export function openness(policy: FieldPolicy, context: FieldContext): number {
  if (!policy.view) return 0;
  if (context === "export") {
    // A file has no "Show": masked is masked, whether or not the screens may unmask it.
    const seen = exportVisibility(policy);
    return seen === "clear" ? 3 : seen === "masked" ? 1 : 0;
  }
  const masked = context === "list" ? policy.maskInList : policy.maskInDetail;
  if (!masked) return 3;
  return policy.unmask ? 2 : 1;
}

/**
 * Whether `next` is no more open than `own`, in lists, on the record's page and in an export alike — the export the
 * same "nothing wider than your own" as the others (owner, 5 Nov 2026 — audit H.4.4): nobody hands out a file in the
 * clear that their own would carry masked.
 */
export function withinPolicy(next: FieldPolicy, own: FieldPolicy): boolean {
  return openness(next, "list") <= openness(own, "list") && openness(next, "detail") <= openness(own, "detail") && openness(next, "export") <= openness(own, "export");
}

/** A policy in words, for the permission history: "masked in lists and on the lead, may unmask". */
export function describePolicy(policy: FieldPolicy, entity: FieldEntity = "leads"): string {
  if (!policy.view) return "restricted";
  const where = [policy.maskInList ? "in lists" : null, policy.maskInDetail ? `on the ${FIELD_ENTITY_WORDS[entity].one}` : null].filter(Boolean);
  // The export, when it isn't the list's (audit H.4.4).
  const exported = policy.export === "none" ? ", left out of exports" : policy.export === "masked" ? ", exported masked" : policy.export === "clear" ? ", exported in the clear" : "";
  if (where.length === 0) return `visible${exported}`;
  return `masked ${where.join(" and ")} (${policy.format})${policy.unmask ? ", may unmask" : ""}${exported}`;
}
