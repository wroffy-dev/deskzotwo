/**
 * Filling a template in.
 *
 * One rule, and it is the whole reason this is a module rather than a `replaceAll`: **a field with
 * no value and no fallback blocks the send.** "Hi ," reaching two hundred customers is the most
 * recognisable failure in all of marketing email, it is unrecoverable once sent, and it is always
 * caused by a system that treated a missing value as an empty string.
 *
 * Syntax is `{{firstName}}` — or `{{firstName|there}}`, which is what somebody should write when
 * the field genuinely might be absent. Making the fallback explicit means the author decides, at
 * the moment they write the line, whether a blank is acceptable there.
 */

export type MergeField = {
  key: string;
  label: string;
  /** Shown in the preview so somebody can see what it will look like before it goes. */
  example: string;
  /** What it reads from, in words — the author has no other way to know. */
  source: string;
};

export const MERGE_FIELDS: MergeField[] = [
  { key: "firstName", label: "First name", example: "Rajesh", source: "The contact's name, first word only" },
  { key: "fullName", label: "Full name", example: "Rajesh Kumar", source: "The contact's name" },
  { key: "companyName", label: "Company", example: "Vertex Industries LLP", source: "The company's name" },
  { key: "ourName", label: "Our name", example: "Acme", source: "Trade name from organisation settings" },
  { key: "ownerName", label: "Account manager", example: "Priya Sharma", source: "Whoever owns the account" },
  { key: "ownerEmail", label: "Account manager's email", example: "priya@example.com", source: "Their user record" },
  { key: "productName", label: "Product", example: "Microsoft 365 Business Basic", source: "The subscription that triggered this" },
  { key: "quantity", label: "Quantity", example: "20", source: "Seats or units on that subscription" },
  { key: "expiryDate", label: "Expiry", example: "9 Aug 2027", source: "When the subscription or cover ends" },
  { key: "startDate", label: "Start", example: "10 Aug 2026", source: "When the subscription's term starts — a renewal's new term" },
  { key: "daysLeft", label: "Days left", example: "58", source: "Days until that expiry" },
  {
    key: "daysLeftPhrase",
    label: "Days left, as a phrase",
    example: " — that's 58 days away",
    source: "The same number written out, and past tense once it has lapsed",
  },
  { key: "renewalValue", label: "Renewal value", example: "₹1,20,000", source: "Full-term price × quantity" },
  { key: "assetCount", label: "Machines", example: "40", source: "Assets we look after for them" },
  { key: "orderId", label: "Order number", example: "ORD-0188", source: "The order this is about" },
  // Several subscriptions renewing the same day, in one email (owner, 3 Nov 2026 — src/lib/subscriptions/same-day.ts).
  { key: "subscriptions", label: "Subscriptions table", example: "A table: product, seats, renews on", source: "A row for each subscription the email is about — one, or every one of the customer's renewing that day" },
  // A payment reminder on an order (owner, 3 Nov 2026 — src/lib/marketing/customer-notices.ts PAYMENT_NOTICE).
  { key: "orderTotal", label: "Order total", example: "₹1,18,000", source: "The order's total, tax in" },
  { key: "amountPaid", label: "Paid so far", example: "₹50,000", source: "What has been paid against the order" },
  { key: "balanceDue", label: "Balance due", example: "₹68,000", source: "What is still owed on the order" },
  { key: "subscriptionCount", label: "How many subscriptions", example: "3", source: "How many subscriptions the email is about" },
  { key: "poNumber", label: "Their PO", example: "PO/2026/441", source: "Their purchase order number, where they gave one" },
  { key: "fulfilledDate", label: "Completed on", example: "19 Sept 2026", source: "When the order was marked fulfilled" },
  { key: "unsubscribeUrl", label: "Unsubscribe link", example: "https://…/preferences/…", source: "Filled in automatically" },
  { key: "postalAddress", label: "Our address", example: "…", source: "Organisation settings" },
  // Form invitations only. Anywhere else they have no value, so use them there with a fallback or not at all.
  { key: "formName", label: "Form or event", example: "Customer roundtable — Pune", source: "The form an invitation is for" },
  { key: "formLink", label: "Their personal link", example: "https://…/forms/…/…", source: "Filled in per person — an invitation must carry it" },
  { key: "eventDate", label: "Event date", example: "Thu, 15 Oct 2026, 6:30 pm", source: "The event's start, in the workspace's time zone" },
  { key: "eventVenue", label: "Event venue", example: "The Westin, Koregaon Park", source: "The event's venue" },
  { key: "inviterName", label: "Who invited them", example: "Priya Sharma", source: "Whoever sent the invitation" },
];

const FIELD_KEYS = new Set(MERGE_FIELDS.map((f) => f.key));

/** `{{ key }}` or `{{ key | fallback }}`, tolerant of whitespace because people type it by hand. */
const TOKEN = /\{\{\s*([a-zA-Z0-9_]+)\s*(?:\|([^}]*))?\}\}/g;

export type RenderResult =
  | { ok: true; text: string; used: string[] }
  | { ok: false; missing: string[]; unknown: string[] };

export type MergeValues = Record<string, string | number | null | undefined>;

function valueOf(values: MergeValues, key: string): string | null {
  const raw = values[key];
  if (raw === null || raw === undefined) return null;
  const text = String(raw).trim();
  return text === "" ? null : text;
}

/**
 * Renders, or refuses and says exactly which fields were empty.
 *
 * `unknown` is reported separately from `missing`: a typo like `{{frstName}}` is an author error to
 * fix now, whereas a genuinely absent value may just mean this recipient should be skipped.
 */
export function render(
  template: string,
  values: MergeValues,
  /**
   * `escape` is applied to the merged values — not to the template, and not to a fallback, both of
   * which the author wrote. An HTML template passes `escapeHtml`, so a customer's name can never
   * become markup.
   */
  options?: { escape?: (value: string) => string },
): RenderResult {
  const missing: string[] = [];
  const unknown: string[] = [];
  const used: string[] = [];

  const shown = applyConditions(template, values, unknown);
  const text = shown.replace(TOKEN, (_match, rawKey: string, rawFallback?: string) => {
    const key = rawKey.trim();
    if (!FIELD_KEYS.has(key)) {
      if (!unknown.includes(key)) unknown.push(key);
      return "";
    }
    used.push(key);
    const value = valueOf(values, key);
    if (value !== null) return options?.escape ? options.escape(value) : value;

    // The bar is the decision. `{{firstName|there}}` says what to print instead; `{{firstName|}}`
    // says print nothing, deliberately; `{{firstName}}` says nothing at all about it, and that
    // last one is the "Hi ," case — the author never considered a recipient without a name.
    if (rawFallback !== undefined) return rawFallback.trim();
    if (!missing.includes(key)) missing.push(key);
    return "";
  });

  if (missing.length > 0 || unknown.length > 0) return { ok: false, missing, unknown };
  return { ok: true, text, used: [...new Set(used)] };
}

/**
 * Dynamic content (owner, 1 Nov 2026): a block only some people see. `{{#if customer}}…{{else}}…{{/if}}` — customer
 * (has bought from us) or prospect (hasn't yet), `city=Pune,Mumbai`, `state=Maharashtra` — nested if need be, and
 * `{{#unless …}}` for the opposite. Worked out before the fields are filled, so a field in a hidden block is never
 * asked for. The facts come from the recipient (src/lib/marketing/pipeline.ts mergeValuesFor): `isCustomer`,
 * `city`, `state`; the preview shows a customer in Pune, Maharashtra.
 */
export const CONDITIONS = [
  { key: "customer", label: "Customers — companies that have bought from us" },
  { key: "prospect", label: "Prospects — companies that haven't bought yet" },
  { key: "city=", label: "By city — city=Pune,Mumbai" },
  { key: "state=", label: "By state — state=Maharashtra" },
] as const;

const BLOCK = /\{\{\s*#(if|unless)\s+([^}]*?)\s*\}\}((?:(?!\{\{\s*#(?:if|unless)\b)[\s\S])*?)\{\{\s*\/(?:if|unless)\s*\}\}/i;
const ELSE = /\{\{\s*else\s*\}\}/i;

function holds(condition: string, values: MergeValues): boolean | null {
  // An HTML template's cleaner writes "Jammu & Kashmir" as "&amp;" — read it as typed.
  const c = condition.replace(/&amp;/gi, "&").replace(/&#39;|&apos;/gi, "'").trim().toLowerCase();
  if (c === "customer") return !!valueOf(values, "isCustomer");
  if (c === "prospect") return !valueOf(values, "isCustomer");
  const m = c.match(/^(city|state)\s*=\s*(.+)$/);
  if (!m) return null;
  const actual = valueOf(values, m[1]!)?.toLowerCase() ?? "";
  return m[2]!.split(",").map((v) => v.trim()).filter(Boolean).includes(actual);
}

function applyConditions(template: string, values: MergeValues, unknown: string[]): string {
  let text = template;
  // Innermost first, so a block inside a block is settled before the one around it.
  for (let guard = 0; guard < 200; guard++) {
    const m = text.match(BLOCK);
    if (!m || m.index === undefined) break;
    const [whole, kind, condition, inner] = m;
    const verdict = holds(condition!, values);
    if (verdict === null && !unknown.includes(`#${kind} ${condition}`)) unknown.push(`#${kind} ${condition}`);
    const [yes, no = ""] = inner!.split(ELSE);
    const show = kind!.toLowerCase() === "unless" ? verdict === false : verdict === true;
    text = text.slice(0, m.index) + (show ? yes : no) + text.slice(m.index + whole.length);
  }
  return text;
}

/** The fields a template will ask for, so the editor can warn before anybody presses send. */
export function fieldsUsed(template: string): { known: string[]; unknown: string[] } {
  const known: string[] = [];
  const unknown: string[] = [];
  for (const match of template.matchAll(TOKEN)) {
    const key = match[1].trim();
    if (key === "else") continue; // a dynamic block's, not a field
    const bucket = FIELD_KEYS.has(key) ? known : unknown;
    if (!bucket.includes(key)) bucket.push(key);
  }
  return { known, unknown };
}

/** Which of those have no fallback, and so must have a value for every single recipient. */
export function requiredFields(template: string): string[] {
  const required: string[] = [];
  for (const match of template.matchAll(TOKEN)) {
    const key = match[1].trim();
    if (key === "else") continue;
    // Same rule as `render`: a bar means the author decided, whatever follows it.
    const declared = match[2] !== undefined;
    if (FIELD_KEYS.has(key) && !declared && !required.includes(key)) required.push(key);
  }
  return required;
}

/** The preview: every field filled with its example, so a template can be read before it is used. */
export function previewValues(): MergeValues {
  return { ...Object.fromEntries(MERGE_FIELDS.map((f) => [f.key, f.example])), isCustomer: "yes", city: "Pune", state: "Maharashtra" };
}
