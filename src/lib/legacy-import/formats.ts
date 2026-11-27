import { DEFAULT_PHONE_COUNTRY, normalisePhone } from "@/lib/phone";
import type { CallOutcome, ContactDesignation, ItemType, LeadStatus, OrderBusinessType, TicketPriority, TicketStatus, TicketType, VisitPurpose } from "@prisma/client";

/**
 * The old CRM's export, table by table (owner, 26 Oct 2026; src/lib/legacy-import). Pure — the upload, the preview
 * and the import read it, and so does the suite.
 *
 * The export is a MySQL dump as CSV: snake_case headings, a numeric `id` on every table, `createdAt`/`updatedAt`,
 * and `deletedAt` for a row the old CRM deleted (those are left behind). A file is recognised by its headings, the
 * file's name settling the tables that share them (billing and shipping addresses); either can be corrected on the
 * page, and so can which heading each column is read from.
 */

export type KindKey =
  | "users"
  | "user_roles"
  | "roles"
  | "departments"
  | "designations"
  | "brands"
  | "categories"
  | "custom_categories"
  | "industry_types"
  | "company_types"
  | "sources"
  | "tags"
  | "entity_tags"
  | "products"
  | "customers"
  | "billing_addresses"
  | "shipping_addresses"
  | "employees"
  | "profilings"
  | "leads"
  | "customer_product"
  | "product_tickets"
  | "anonymous_tickets"
  | "replies"
  | "field_visits"
  | "call_logs"
  | "feedback_links"
  | "subscriptions"
  | "vendors"
  | "lead_product"
  | "tech_visits"
  | "zoho_contacts"
  | "zoho_vendors"
  | "zoho_contact_persons"
  | "zoho_vendor_contact_persons"
  | "zoho_items";

export type KindDef = {
  key: KindKey;
  label: string;
  /** What it becomes in Deskzo, in a few words. */
  becomes: string;
  /** Read for the others (users, tags…), turned into records (customers…), or not brought (feedback links). */
  /**
   * Read for the others (users, tags…), turned into records (customers…), matched into the master lists (Zoho's
   * contacts and items, WroffyCRM's vendors), or not brought (feedback links).
   */
  role: "lookup" | "records" | "master" | "ignored";
  /** Whose export it is. */
  source?: "wroffycrm" | "zoho";
  /** Usual file names, without .csv. */
  files: string[];
  /** Every heading the tool reads. */
  columns: string[];
  /** Headings a file must have to be taken for this table. */
  required: string[];
};

const STAMPS = ["createdAt", "updatedAt", "deletedAt"];

export const KINDS: KindDef[] = [
  { key: "users", label: "Users", becomes: "Deskzo users — matched by email; anyone else created switched off", role: "records", files: ["users"], columns: ["id", "name", "email", "phone", "country_code", "status", "department_id", "designation_id", "is_super_admin", ...STAMPS], required: ["id", "name", "email", "is_super_admin"] },
  { key: "user_roles", label: "User roles", becomes: "Read only, to say what each old user did", role: "lookup", files: ["user_role", "user_roles"], columns: ["user_id", "role_id"], required: ["user_id", "role_id"] },
  { key: "roles", label: "Roles", becomes: "Read only, to say what each old user did", role: "lookup", files: ["roles"], columns: ["id", "label", "name", ...STAMPS], required: ["id", "label", "name", "parent_id"] },
  { key: "departments", label: "Departments", becomes: "Deskzo departments, for the users it creates", role: "lookup", files: ["departments"], columns: ["id", "name", ...STAMPS], required: ["id", "name", "description", "status"] },
  { key: "designations", label: "Designations", becomes: "Contact designations", role: "lookup", files: ["designations"], columns: ["id", "department_id", "name", ...STAMPS], required: ["id", "department_id", "name", "visibility"] },
  { key: "brands", label: "Brands", becomes: "Item brands", role: "lookup", files: ["brands"], columns: ["id", "name", "label", ...STAMPS], required: ["id", "name", "label"] },
  { key: "categories", label: "Product categories", becomes: "Item categories", role: "lookup", files: ["categories"], columns: ["id", "name", "type", ...STAMPS], required: ["id", "name", "slug", "type"] },
  { key: "custom_categories", label: "Customer categories", becomes: "Customer categories", role: "lookup", files: ["custom_categories", "customer_categories"], columns: ["id", "name", "parent_id", "type", ...STAMPS], required: ["id", "name", "parent_id", "icon"] },
  { key: "company_types", label: "Company types", becomes: "Company types (Settings › Lists) — any the workspace hasn't got", role: "lookup", files: ["company_types"], columns: ["id", "name", "status", ...STAMPS], required: ["id", "name"] },
  { key: "industry_types", label: "Industries", becomes: "Industries", role: "lookup", files: ["industry_types", "industries"], columns: ["id", "name", ...STAMPS], required: ["id", "name", "status"] },
  { key: "sources", label: "Lead sources", becomes: "Read only, the list of sources", role: "lookup", files: ["source", "sources"], columns: ["id", "name", ...STAMPS], required: ["id", "name", "status"] },
  { key: "tags", label: "Tags", becomes: "Tag names, for companies", role: "lookup", files: ["tags"], columns: ["id", "name", ...STAMPS], required: ["id", "name", "description"] },
  { key: "entity_tags", label: "Tag links", becomes: "Tags on companies (a lead's or a profiling's go on its company)", role: "lookup", files: ["entity_tags"], columns: ["id", "tag_id", "entity_id", "entity_type", ...STAMPS], required: ["tag_id", "entity_id", "entity_type"] },
  { key: "products", label: "Products", becomes: "Items — matched by SKU", role: "records", files: ["products"], columns: ["id", "category_id", "brand_id", "name", "sku", "type", "identification_code", "display_price", "selling_price", "description", ...STAMPS], required: ["id", "name", "sku", "selling_price"] },
  { key: "customers", label: "Customers", becomes: "Companies (customers), each with its address as the head office", role: "records", files: ["customers"], columns: ["id", "cust_cat_id", "company", "customer_type", "gst_no", "phone", "official_email", "website", "industry_type", "specify_other", "employee_count", "currency", "address", "city", "state", "zipcode", "country", "source", "status", "created_by", "company_type", "linkedin_url", "anniversary", "country_code", "tags", "cin_number", ...STAMPS], required: ["id", "company", "official_email", "cin_number"] },
  { key: "billing_addresses", label: "Billing addresses", becomes: "Billing locations", role: "records", files: ["billing_addresses"], columns: ["id", "customer_id", "address", "city", "state", "country", "zipcode", "gst_no", "status", ...STAMPS], required: ["id", "customer_id", "address", "zipcode", "gst_no"] },
  { key: "shipping_addresses", label: "Shipping addresses", becomes: "Shipping locations", role: "records", files: ["shipping_addresses"], columns: ["id", "customer_id", "address", "city", "state", "country", "zipcode", "gst_no", "status", ...STAMPS], required: ["id", "customer_id", "address", "zipcode", "gst_no"] },
  { key: "employees", label: "Customer contacts", becomes: "Contacts", role: "records", files: ["employees"], columns: ["id", "customer_id", "designation_id", "first_name", "last_name", "email", "country_code", "phone", "is_contact_person", "status", ...STAMPS], required: ["id", "customer_id", "first_name", "is_contact_person"] },
  { key: "profilings", label: "Profilings", becomes: "Contacts on prospect companies, tagged Profiling", role: "records", files: ["profilings"], columns: ["id", "product_id", "name", "email", "phone", "mobile_no", "address", "city", "state", "country", "zipcode", "industry_type", "employee_count", "company", "department", "designation", "source", "status", "assigned_to", "created_by", "company_type", "linkedin_url", "country_code", ...STAMPS], required: ["id", "name", "company", "mobile_no", "designation"] },
  { key: "leads", label: "Leads", becomes: "Leads in the main pipeline", role: "records", files: ["leads"], columns: ["id", "product_id", "name", "email", "phone", "company", "address", "city", "state", "country", "zipcode", "employee_count", "value", "status", "source", "designation", "website", "assigned_to", "created_by", "company_type", "description", "reason", "bom", "country_code", ...STAMPS], required: ["id", "name", "company", "status", "bom"] },
  { key: "customer_product", label: "Customer products", becomes: "Orders (fulfilled) — the renewals book", role: "records", files: ["customer_product", "customer_products"], columns: ["id", "parent_id", "customer_id", "billing_address_id", "product_id", "quantity", "status", "start_date", "expiry_date", "invoice_no", "product_type", "domain_tenant", "vendor", "description", "renewal_id", "stage", "created_by", "reason", "payment_terms", ...STAMPS], required: ["id", "customer_id", "product_id", "expiry_date", "renewal_id"] },
  { key: "product_tickets", label: "Product tickets", becomes: "Tickets on the customer's product", role: "records", files: ["product_tickets"], columns: ["id", "customer_product_id", "customer_id", "ticket_no", "title", "description", "status", "priority", "assigned_to", "created_by", "contact_person_id", ...STAMPS], required: ["id", "customer_product_id", "ticket_no", "title"] },
  { key: "anonymous_tickets", label: "Other tickets", becomes: "Tickets (demos and the like)", role: "records", files: ["anonymous_tickets"], columns: ["id", "ticket_no", "customer_id", "product_id", "title", "description", "status", "priority", "type", "assigned_to", "created_by", "contact_person_id", ...STAMPS], required: ["id", "ticket_no", "customer_id", "product_id", "type"] },
  { key: "replies", label: "Ticket replies", becomes: "Ticket comments", role: "records", files: ["replies"], columns: ["id", "ticket_type", "ticket_id", "replier_id", "reply", ...STAMPS], required: ["id", "ticket_type", "ticket_id", "reply"] },
  { key: "field_visits", label: "Field visits", becomes: "Visits", role: "records", files: ["field_visits"], columns: ["id", "customer_id", "lead_id", "visit_date", "origin", "destination", "purpose", "status", "remarks", "contact_person_name", "contact_person_number", "contact_person_email", "created_by", "assigned_to", "coworker_id", "country_code", ...STAMPS], required: ["id", "visit_date", "origin", "destination"] },
  { key: "call_logs", label: "Call logs", becomes: "Call logs on the company (and the lead, ticket or contact)", role: "records", files: ["call_logs"], columns: ["id", "type", "type_id", "status", "feedback_type", "response", "remarks", "rescheduled_at", "reminder_at", "called_by", ...STAMPS], required: ["id", "type", "type_id", "called_by"] },
  { key: "feedback_links", label: "Feedback links", becomes: "Not brought across", role: "ignored", files: ["feedback_links"], columns: [], required: ["customer_id", "link"] },
  { key: "subscriptions", label: "Subscriptions (plans)", becomes: "Not brought across", role: "ignored", files: ["subscriptions"], columns: [], required: ["plan_id", "customer_id", "end_date"] },
  { key: "vendors", label: "Vendors", becomes: "Vendors, through the master list", role: "master", files: ["vendors"], columns: ["id", "company", "company_type", "business_type", "associated_oem", "pan_no", "msme", "gst_no", "cin_no", "official_phone", "official_email", "website", "address", "city", "state", "zipcode", "country", "payment_terms", "status", ...STAMPS], required: ["id", "company", "pan_no", "gst_no", "associated_oem"] },
  { key: "lead_product", label: "Lead products", becomes: "The products a lead is for", role: "records", files: ["lead_product"], columns: ["id", "lead_id", "product_id", "quantity", "renewal_date", ...STAMPS], required: ["lead_id", "product_id", "renewal_date"] },
  { key: "tech_visits", label: "Technical visits", becomes: "Not brought across (empty in the export)", role: "ignored", files: ["tech_visits"], columns: ["id", "ticket_id", "type_id", "type", "visited_at", "remark", "destination", "approved_by", "is_approved", ...STAMPS], required: ["ticket_id", "visited_at", "is_approved"] },
  { key: "zoho_contacts", label: "Zoho customers", becomes: "Companies, through the master list", role: "master", source: "zoho", files: ["contacts"], columns: ["Contact ID", "Display Name", "Company Name", "Legal Name", "First Name", "Last Name", "EmailID", "MobilePhone", "Phone", "Website", "Status", "Currency Code", "Payment Terms Label", "GST Treatment", "GST Identification Number (GSTIN)", "Place Of Contact", "Billing Address", "Billing Street2", "Billing City", "Billing State", "Billing Country", "Billing Code", "Created Time", "Owner Name"], required: ["Contact ID", "Display Name", "GST Identification Number (GSTIN)", "Customer Sub Type"] },
  { key: "zoho_vendors", label: "Zoho vendors", becomes: "Vendors, through the master list", role: "master", source: "zoho", files: ["vendors"], columns: ["Contact ID", "Display Name", "Company Name", "First Name", "Last Name", "EmailID", "MobilePhone", "Phone", "Website", "Status", "Currency Code", "Payment Terms Label", "GST Treatment", "GST Identification Number (GSTIN)", "MSME/Udyam No", "Billing Address", "Billing Street2", "Billing City", "Billing State", "Billing Country", "Billing Code", "Created Time", "Owner Name"], required: ["Contact ID", "Display Name", "GST Identification Number (GSTIN)", "MSME/Udyam No"] },
  { key: "zoho_contact_persons", label: "Zoho contact persons", becomes: "Contacts, through the master list", role: "master", source: "zoho", files: ["contact_persons"], columns: ["Customer ID", "Customer Name", "Contact Person ID", "Salutation", "First Name", "Last Name", "EmailID", "Phone", "MobilePhone", "Is Primary", "Department", "Designation"], required: ["Customer ID", "Contact Person ID", "Customer Name"] },
  { key: "zoho_vendor_contact_persons", label: "Zoho vendor contact persons", becomes: "Vendor contacts, through the master list", role: "master", source: "zoho", files: ["vendor_contact_persons"], columns: ["Vendor ID", "Display Name", "Contact Person ID", "Salutation", "First Name", "Last Name", "EmailID", "Phone", "MobilePhone", "Is Primary", "Department", "Designation"], required: ["Vendor ID", "Contact Person ID"] },
  { key: "zoho_items", label: "Zoho items", becomes: "Items, through the master list", role: "master", source: "zoho", files: ["item", "items"], columns: ["Item ID", "Item Name", "SKU", "HSN/SAC", "Description", "Rate", "Purchase Rate", "Product Type", "Item Type", "Status", "Usage unit", "Vendor", "Intra State Tax Rate"], required: ["Item ID", "Item Name", "SKU", "HSN/SAC"] },
];

export const kindDef = (key: string | null | undefined) => KINDS.find((k) => k.key === key) ?? null;

/** The order records come in: what others point at first. */
/** The tables in the order they come in; Zoho's before the WroffyCRM rows the master lists pair with them. */
export const STEPS: KindKey[] = ["users", "zoho_items", "products", "zoho_contacts", "zoho_vendors", "vendors", "customers", "billing_addresses", "shipping_addresses", "zoho_contact_persons", "zoho_vendor_contact_persons", "employees", "profilings", "leads", "lead_product", "customer_product", "product_tickets", "anonymous_tickets", "replies", "field_visits", "call_logs"];

/** A byte-order mark at the start of a heading, as Excel and MySQL exports write one. */
const BOM_START = new RegExp(`^${String.fromCharCode(0xfeff)}`);
const norm = (h: string) => h.replace(BOM_START, "").trim().toLowerCase();
const baseName = (name: string) => norm(name.split(/[\\/]/).pop() ?? name).replace(/\.csv$/, "");

/**
 * Which table a file holds: every table whose required headings it has, the one most of whose headings it has,
 * the file name settling a tie (billing and shipping addresses have the same headings). Null when it is none.
 */
export function detectKind(headers: string[], fileName: string): KindKey | null {
  const have = new Set(headers.map(norm));
  const name = baseName(fileName);
  // A lookup table only by its own file name (owner, 27 Oct 2026): its few headings — id, name, status — are
  // every small table's, so plans, groups and settings read by headings came in as departments and industries.
  const candidates = KINDS.filter((k) => (k.role !== "lookup" || k.files.includes(name)) && k.required.every((r) => have.has(r.toLowerCase())));
  if (candidates.length === 0) return KINDS.find((k) => k.files.includes(name))?.key ?? null;
  const score = (k: KindDef) => (k.files.includes(name) ? 1000 : 0) + k.columns.filter((c) => have.has(c.toLowerCase())).length / Math.max(1, k.columns.length);
  return candidates.sort((a, b) => score(b) - score(a))[0]!.key;
}

/** Each column the table reads, from the file's heading of the same name (ignoring case), else none. */
export function defaultMapping(kind: KindKey, headers: string[]): Record<string, string | null> {
  const byName = new Map(headers.map((h) => [norm(h), h]));
  return Object.fromEntries(kindDef(kind)!.columns.map((c) => [c, byName.get(c.toLowerCase()) ?? null]));
}

/** A raw row read through a mapping: every column the table reads, "" where the file hasn't it. */
export function mapRow(raw: Record<string, string>, mapping: Record<string, string | null>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [column, heading] of Object.entries(mapping)) out[column] = clean(heading ? raw[heading] : "");
  return out;
}

// ─── Values ──────────────────────────────────────────────────────────────────────────────────────

/**
 * An old CRM phone with its row's `country_code` (owner, 27 Oct 2026), kept the way Deskzo keeps numbers —
 * "+91 98765 43210" (src/lib/phone.ts). The code comes as "+91", "91" or blank; a number that already carries one
 * ("+44 …", "0091…", or twelve digits starting with the row's code) keeps its own; a number with neither is taken
 * as Indian, the workspace's country.
 */
export function oldPhone(phone: unknown, code: unknown): string | null {
  const typed = clean(phone);
  if (!typed) return null;
  if (/^(\+|00)/.test(typed)) return normalisePhone(typed) || null;
  const dial = clean(code).replace(/\D/g, "");
  const digits = typed.replace(/\D/g, "");
  if (dial && digits.length > 10 && digits.startsWith(dial) && digits.length - dial.length >= 6) return normalisePhone(`+${digits}`) || null;
  if (dial) return normalisePhone(`+${dial} ${typed}`) || null;
  return normalisePhone(typed, DEFAULT_PHONE_COUNTRY) || null;
}

/** A cell as text: trimmed, and the dump's NULL as empty. */
export function clean(value: unknown): string {
  const text = String(value ?? "").trim();
  return text === "NULL" || text === "null" || text === "[null]" ? "" : text;
}

const pad = (n: string | number) => String(n).padStart(2, "0");

/**
 * A cell's day and time, as the old CRM wrote them — "2025-07-03 15:12:42" — or as Excel rewrites them when the
 * export is opened and saved there: day first, the time's parts by a dot or a colon, maybe with AM/PM ("26-05-2025
 * 17.26", owner 30 Oct 2026). Null when it's neither.
 */
function dayAndTime(value: string): { day: string; time: string } | null {
  const text = clean(value);
  const iso = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/.exec(text);
  if (iso) return { day: iso[1]!, time: `${iso[2] ?? "00"}:${iso[3] ?? "00"}:${iso[4] ?? "00"}` };
  const dmy = /^(\d{1,2})[-/](\d{1,2})[-/](\d{4})(?:[ T]+(\d{1,2})[:.](\d{2})(?:[:.](\d{2}))?(?:\s*([AaPp])[Mm])?)?$/.exec(text);
  if (!dmy || Number(dmy[2]) > 12) return null;
  let hour = Number(dmy[4] ?? 0);
  if (dmy[7]) hour = (hour % 12) + (/p/i.test(dmy[7]) ? 12 : 0);
  return { day: `${dmy[3]}-${pad(dmy[2]!)}-${pad(dmy[1]!)}`, time: `${pad(hour)}:${dmy[5] ?? "00"}:${dmy[6] ?? "00"}` };
}

/**
 * A timestamp as the old CRM wrote it — "2025-07-03 15:12:42", India time — or as Excel saved it, as an instant.
 * Null for empty or unreadable.
 */
export function oldInstant(value: string): Date | null {
  const at = dayAndTime(value);
  if (!at) return null;
  const d = new Date(`${at.day}T${at.time}+05:30`);
  return Number.isNaN(d.getTime()) ? null : d;
}

/** A date the old CRM kept as a day ("2025-06-23 05:30:00" is 23 June): midnight UTC of it, as Deskzo keeps days. */
export function oldDay(value: string): Date | null {
  const at = dayAndTime(value);
  if (!at) return null;
  const d = new Date(`${at.day}T00:00:00Z`);
  return Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== at.day ? null : d;
}

/** "INR 1250.0", "25,800", "₹ 1,450" → 1250, 25800, 1450. Null when there is no number. */
export function money(value: string): number | null {
  const text = clean(value).replace(/INR|Rs\.?|₹|,|\s/gi, "");
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : null;
}

/** A JSON list cell — `["Azure","Microsoft 365"]` — as its strings. */
export function jsonList(value: string): string[] {
  const text = clean(value);
  if (!text.startsWith("[")) return [];
  try {
    const parsed = JSON.parse(text) as unknown;
    return Array.isArray(parsed) ? parsed.filter((v): v is string => typeof v === "string" && v.trim() !== "").map((v) => v.trim()) : [];
  } catch {
    return [];
  }
}

const STATES: Record<string, string> = {
  AN: "Andaman and Nicobar Islands", AP: "Andhra Pradesh", AR: "Arunachal Pradesh", AS: "Assam", BR: "Bihar", CH: "Chandigarh",
  CG: "Chhattisgarh", CT: "Chhattisgarh", DN: "Dadra and Nagar Haveli and Daman and Diu", DD: "Dadra and Nagar Haveli and Daman and Diu",
  DH: "Dadra and Nagar Haveli and Daman and Diu", DL: "Delhi", GA: "Goa", GJ: "Gujarat", HR: "Haryana", HP: "Himachal Pradesh",
  JK: "Jammu and Kashmir", JH: "Jharkhand", KA: "Karnataka", KL: "Kerala", LA: "Ladakh", LD: "Lakshadweep", MP: "Madhya Pradesh",
  MH: "Maharashtra", MN: "Manipur", ML: "Meghalaya", MZ: "Mizoram", NL: "Nagaland", OD: "Odisha", OR: "Odisha", PY: "Puducherry",
  PB: "Punjab", RJ: "Rajasthan", SK: "Sikkim", TN: "Tamil Nadu", TS: "Telangana", TG: "Telangana", TR: "Tripura", UP: "Uttar Pradesh",
  UK: "Uttarakhand", UT: "Uttarakhand", WB: "West Bengal",
};

/** "HR" → "Haryana" for an Indian address; anything else as written. */
export function stateName(state: string, country: string): string | null {
  const s = clean(state);
  if (!s) return null;
  return isIndia(country) ? (STATES[s.toUpperCase()] ?? s) : s;
}

export const isIndia = (country: string) => ["", "in", "ind", "india"].includes(clean(country).toLowerCase());

/** "IN" → "India"; another country's code as written. */
export function countryName(country: string): string {
  const c = clean(country);
  return isIndia(c) ? "India" : c.toUpperCase() === "TH" ? "Thailand" : c;
}

/** "information-technology" → "Information Technology". */
export const titleCase = (slug: string) =>
  clean(slug)
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());

/** The employee bands both systems share; "1001+" (the old top band) as Deskzo's 1,001–5,000. */
export const EMPLOYEE_BAND: Record<string, string> = { "1-10": "1-10", "11-50": "11-50", "51-200": "51-200", "201-500": "201-500", "501-1000": "501-1000", "1001+": "1001-5000", "1001-5000": "1001-5000", "5001-10000": "5001-10000", "10001+": "10001+" };

/** The old lead statuses; anything else is read by its words (src/lib/portability/importers/leads.ts stageMeaning). */
export const LEAD_STATUS: Record<string, LeadStatus> = {
  new: "NEW",
  "follow-up": "CONTACTED",
  contacted: "CONTACTED",
  // Owner, 27 Oct 2026: a mail or call done is contact made; an enquiry received, or no action yet, is a new lead.
  "mail-done": "CONTACTED",
  "call-done": "CONTACTED",
  "enquiry-received": "NEW",
  "no-action": "NEW",
  "quotation-shared": "PROPOSAL_SENT",
  negotiation: "NEGOTIATION",
  won: "WON",
  loss: "LOST",
  lost: "LOST",
  invalid: "DISQUALIFIED",
  // Owner, 30 Oct 2026, from the import's errors: 689 "Not a fit", 217 "On hold" and 45 "Lead" had come in as New. On hold is
  // still a live conversation, paused: Contacted, with "On hold in the old CRM" kept in its description.
  "not a fit": "DISQUALIFIED",
  "not-a-fit": "DISQUALIFIED",
  "on hold": "CONTACTED",
  "on-hold": "CONTACTED",
  lead: "NEW",
};

export const TICKET_STATUS: Record<string, TicketStatus> = {
  open: "OPEN",
  new: "OPEN",
  pending: "OPEN",
  "in-progress": "IN_PROGRESS",
  assigned: "IN_PROGRESS",
  observation: "ON_HOLD",
  "on-hold": "ON_HOLD",
  "escalated-to-oem": "ON_HOLD",
  resolved: "RESOLVED",
  closed: "CLOSED",
};

export const TICKET_PRIORITY: Record<string, TicketPriority> = { low: "LOW", medium: "MEDIUM", high: "HIGH", urgent: "URGENT", critical: "URGENT" };

export const TICKET_TYPE: Record<string, TicketType> = { demo: "DEMO", installation: "INSTALLATION", training: "TRAINING", support: "PRODUCT_SUPPORT", product: "PRODUCT_SUPPORT" };

export const VISIT_PURPOSE: Record<string, VisitPurpose> = { business: "RELATIONSHIP_BUILDING", demo: "PRODUCT_DEMO", meeting: "INTRO_MEETING", payment: "PAYMENT_FOLLOW_UP", support: "SUPPORT_ESCALATION", installation: "DELIVERY_INSTALLATION" };

export const CALL_OUTCOME: Record<string, CallOutcome> = { connected: "CONNECTED", disconnected: "NO_ANSWER", not_reachable: "SWITCHED_OFF", invalid_no: "WRONG_NUMBER", busy: "BUSY" };

export const BUSINESS_TYPE: Record<string, OrderBusinessType> = { fresh: "NEW", new: "NEW", addon: "ADDON", "add-on": "ADDON", renewal: "RENEWAL" };

/** A product: a subscription category's are subscriptions; otherwise goods are goods and the rest services. */
export function itemType(oldType: string, categoryType: string | null): ItemType {
  if (clean(categoryType ?? "").toLowerCase() === "subscription") return "SUBSCRIPTION";
  return clean(oldType).toLowerCase() === "goods" ? "GOOD" : "SERVICE";
}

/** A contact's job title as one of Deskzo's designations, by its words; Other when none fits. */
export function designationKind(title: string): ContactDesignation {
  const t = clean(title).toLowerCase();
  if (/\bcio\b|chief information/.test(t)) return "CIO";
  if (/\bceo\b|chief executive|founder|managing director/.test(t)) return "CEO";
  if (/director|\bmd\b|\bvp\b|vice president/.test(t)) return "DIRECTOR";
  const it = /\bit\b|information technology|\bict\b/.test(t);
  if (/\bcto\b/.test(t) || (it && /\bhead\b|\bagm\b|\bgm\b|general manager|\bdgm\b/.test(t))) return "IT_HEAD";
  if (it) return "IT_MANAGER";
  if (/purchase|procurement|buyer/.test(t)) return "PURCHASE_MANAGER";
  if (/\bhr\b|human resource/.test(t)) return "HR";
  return "OTHER";
}

/** How the files meet what Deskzo has, in the user's words — shown before anything is confirmed. */
export const STRATEGIES = [
  {
    key: "NEW",
    label: "Import new data",
    explain: "Adds every record the files have that hasn't come across yet. Records an earlier import brought are left as they are, and nothing already in Deskzo is changed — except that a Zoho customer or vendor with no account manager gets its owner in Zoho.",
  },
  {
    key: "UPDATE",
    label: "Update existing records",
    explain: "Adds what is new, and updates the records an earlier import brought — found by their id in the old CRM — with the files' values. Records typed into Deskzo by hand are never changed.",
  },
  {
    key: "REPLACE",
    label: "Replace earlier imports",
    explain: "First undoes every earlier import from the old CRM — removing only the records those imports created and putting back what they updated — then imports these files fresh. Records typed into Deskzo by hand, and anything since made on an imported record, are kept.",
  },
] as const;
export type StrategyKey = (typeof STRATEGIES)[number]["key"];
export const isStrategy = (v: unknown): v is StrategyKey => STRATEGIES.some((s) => s.key === v);

/** Kinds whose rows can meet a record Deskzo already had, and so ask: use that one ("link"), or leave the row out ("skip"). */
export const DECIDED_KINDS: KindKey[] = ["products", "customers", "employees", "zoho_contacts", "zoho_vendors"];

/**
 * Master-list tables the preview counts like records — new, brought before, already in Deskzo — and that can be
 * imported on their own (owner, 30 Oct 2026: Zoho's Contacts.csv alone, for its owners as account managers).
 */
export const COUNTED_MASTER: KindKey[] = ["zoho_contacts", "zoho_vendors"];

/** Whether the preview counts this table's rows and the import can run on it. */
export const countedKind = (def: { key: KindKey; role: KindDef["role"] }) => def.role === "records" || COUNTED_MASTER.includes(def.key);
export type MatchDecision = "link" | "skip";
