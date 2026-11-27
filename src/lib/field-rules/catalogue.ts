/**
 * Field rules (owner, 12 Nov 2026 — "build field rules"): what an admin may make compulsory or hold to a format,
 * on a company, a contact or a lead. This file is the list of fields a rule can be about, what kind of value each
 * holds, and which rules fit which kind — dependency-free, so the settings screen and the server read the same list.
 *
 * A field is a built-in one by its name (`industryId`, `location.gstNumber`) or one of the workspace's own fields as
 * `cf.<key>` (src/lib/custom-fields), added by the server from the workspace's definitions.
 */

export const RULE_ENTITIES = ["COMPANY", "CONTACT", "LEAD"] as const;
export type RuleEntity = (typeof RULE_ENTITIES)[number];
export const RULE_ENTITY_LABELS: Record<RuleEntity, string> = { COMPANY: "Companies", CONTACT: "Contacts", LEAD: "Leads" };

/** What a field holds, which decides the rules it can take. */
export type FieldKind = "text" | "number" | "date" | "choice" | "list" | "yesno" | "reference";

export type RuleField = {
  key: string;
  label: string;
  kind: FieldKind;
  /** A choice's options, for the "only when" condition and its words. */
  options?: { value: string; label: string }[];
  /** Only for an "only when" condition — always has a value, so it can't be made compulsory. */
  conditionOnly?: boolean;
};

const RELATIONSHIP = [
  ["CLIENT", "Client"],
  ["RESELLER", "Reseller"],
  ["VENDOR", "Vendor"],
  ["OEM", "OEM"],
  ["DISTRIBUTOR", "Distributor"],
  ["PARTNER", "Partner"],
  ["COMMISSION_PARTY", "Commission party"],
  ["OTHER", "Other"],
].map(([value, label]) => ({ value: value!, label: label! }));

const LEAD_SOURCES = [
  ["WEBSITE", "Website"],
  ["REFERRAL", "Referral"],
  ["LINKEDIN", "LinkedIn"],
  ["CALLING", "Outbound call"],
  ["EMAIL", "Email"],
  ["EVENT", "Event"],
  ["PARTNER", "Partner"],
  ["ADVERTISEMENT", "Advertisement"],
  ["EXISTING_CUSTOMER", "Existing customer"],
  ["WALK_IN", "Walk-in"],
  ["WHATSAPP", "WhatsApp"],
  ["OTHER", "Other"],
].map(([value, label]) => ({ value: value!, label: label! }));

const COMPANY_SOURCES = [
  ["LINKEDIN", "LinkedIn"],
  ["REFERRAL", "Referral"],
  ["INBOUND", "Inbound"],
  ["OTHER", "Other"],
].map(([value, label]) => ({ value: value!, label: label! }));

export const BUILT_IN_FIELDS: Record<RuleEntity, RuleField[]> = {
  COMPANY: [
    { key: "name", label: "Company name", kind: "text" },
    { key: "relationshipType", label: "Relationship", kind: "choice", options: RELATIONSHIP, conditionOnly: true },
    { key: "source", label: "Source", kind: "choice", options: COMPANY_SOURCES, conditionOnly: true },
    { key: "industryId", label: "Industry", kind: "reference" },
    { key: "customerCategoryId", label: "Customer category", kind: "reference" },
    { key: "companyType", label: "Company type", kind: "reference" },
    { key: "employeeBand", label: "Employees", kind: "reference" },
    { key: "website", label: "Website", kind: "text" },
    { key: "linkedinUrl", label: "LinkedIn page", kind: "text" },
    { key: "dunsNumber", label: "DUNS number", kind: "text" },
    { key: "tags", label: "Tags", kind: "list" },
    { key: "location.gstNumber", label: "GSTIN", kind: "text" },
    { key: "location.address", label: "Address", kind: "text" },
    { key: "location.city", label: "City", kind: "text" },
    { key: "location.state", label: "State", kind: "text" },
    { key: "location.pincode", label: "PIN code", kind: "text" },
    { key: "location.country", label: "Country", kind: "text" },
  ],
  CONTACT: [
    { key: "name", label: "Contact name", kind: "text" },
    { key: "email", label: "Email", kind: "text" },
    { key: "phone", label: "Phone", kind: "text" },
    { key: "designationName", label: "Designation", kind: "text" },
    { key: "linkedinUrl", label: "LinkedIn profile", kind: "text" },
  ],
  LEAD: [
    { key: "title", label: "Lead title", kind: "text" },
    { key: "source", label: "Source", kind: "choice", options: LEAD_SOURCES, conditionOnly: true },
    { key: "description", label: "Description", kind: "text" },
    { key: "estimatedValue", label: "Estimated value", kind: "number" },
    { key: "expectedCloseDate", label: "Expected close date", kind: "date" },
    { key: "contactId", label: "Contact person", kind: "reference" },
    { key: "sourceDetail", label: "Source detail", kind: "text" },
  ],
};

/** A custom field's type, as a rule sees it. */
export function kindOfCustomType(type: string): FieldKind | null {
  switch (type) {
    case "TEXT":
    case "LONG_TEXT":
    case "EMAIL":
    case "PHONE":
    case "URL":
      return "text";
    case "NUMBER":
    case "MONEY":
      return "number";
    case "DATE":
      return "date";
    case "SELECT":
      return "choice";
    case "MULTI_SELECT":
      return "list";
    case "CHECKBOX":
      return "yesno";
    case "USER":
    case "FILE":
      return "reference";
    // A secret is never read back to check, so no rule can be about it.
    default:
      return null;
  }
}

// ─── The rules ───────────────────────────────────────────────────────────────────────────────────

export const RULE_KINDS = ["REQUIRED", "LENGTH", "PATTERN", "RANGE", "UNIQUE"] as const;
export type RuleKind = (typeof RULE_KINDS)[number];
export const RULE_KIND_LABELS: Record<RuleKind, string> = {
  REQUIRED: "Must be filled in",
  LENGTH: "Length",
  PATTERN: "Format",
  RANGE: "Number between",
  UNIQUE: "No two the same",
};

/** Which rules each kind of field can take. */
export const KINDS_FOR: Record<FieldKind, RuleKind[]> = {
  text: ["REQUIRED", "LENGTH", "PATTERN", "UNIQUE"],
  number: ["REQUIRED", "RANGE"],
  date: ["REQUIRED"],
  choice: ["REQUIRED"],
  list: ["REQUIRED"],
  yesno: ["REQUIRED"],
  reference: ["REQUIRED"],
};

export const PATTERNS = ["DIGITS", "LETTERS", "LETTERS_DIGITS", "UPPERCASE", "STARTS_WITH", "ENDS_WITH", "CUSTOM"] as const;
export type PatternKind = (typeof PATTERNS)[number];
export const PATTERN_LABELS: Record<PatternKind, string> = {
  DIGITS: "Digits only",
  LETTERS: "Letters and spaces only",
  LETTERS_DIGITS: "Letters and digits only",
  UPPERCASE: "Capital letters, digits and symbols — no small letters",
  STARTS_WITH: "Starts with…",
  ENDS_WITH: "Ends with…",
  CUSTOM: "A pattern of my own (regular expression)",
};

export const CONDITION_OPS = ["EQUALS", "NOT_EQUALS", "FILLED", "EMPTY", "GREATER", "LESS"] as const;
export type ConditionOp = (typeof CONDITION_OPS)[number];
export const CONDITION_OP_LABELS: Record<ConditionOp, string> = {
  EQUALS: "is",
  NOT_EQUALS: "is not",
  FILLED: "is filled in",
  EMPTY: "is empty",
  GREATER: "is more than",
  LESS: "is less than",
};
/** Which conditions each kind of field can be asked. */
export const OPS_FOR: Record<FieldKind, ConditionOp[]> = {
  text: ["EQUALS", "NOT_EQUALS", "FILLED", "EMPTY"],
  number: ["GREATER", "LESS", "FILLED", "EMPTY"],
  date: ["FILLED", "EMPTY"],
  choice: ["EQUALS", "NOT_EQUALS", "FILLED", "EMPTY"],
  list: ["FILLED", "EMPTY"],
  yesno: ["FILLED", "EMPTY"],
  reference: ["FILLED", "EMPTY"],
};
export const opNeedsValue = (op: ConditionOp) => op === "EQUALS" || op === "NOT_EQUALS" || op === "GREATER" || op === "LESS";

export type RuleCondition = { field: string; op: ConditionOp; value?: string | null };

export type FieldRule = {
  id: string;
  entity: RuleEntity;
  field: string;
  kind: RuleKind;
  /** LENGTH and RANGE: the bounds, either may be left out. */
  min?: number | null;
  max?: number | null;
  /** PATTERN: which, and its text for STARTS_WITH, ENDS_WITH and CUSTOM. */
  pattern?: PatternKind | null;
  patternValue?: string | null;
  /** Checked only when this holds; always when null. */
  when?: RuleCondition | null;
  /** Only when a record is made, never when one is changed — so older records aren't held to it. */
  newOnly?: boolean;
  /** What the person sees instead of the words made up from the rule. */
  message?: string | null;
  active: boolean;
};

/** A record as the rules read it: each field by its key, a custom one as `cf.<key>`. */
export type RuleRecord = Record<string, unknown>;
