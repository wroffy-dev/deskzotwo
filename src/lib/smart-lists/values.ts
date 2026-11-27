/**
 * Smart Lists, Notion-style (owner, 20 Nov 2026 — "can we do something around smart lists along with notion type
 * ui"): what a list's own columns hold, and the one rule for what each kind accepts. Pure and client-safe — the cell
 * editors show what the server will keep, and the server keeps only what `parseValue` passes.
 *
 * A value is kept as the kind says: TEXT a string, NUMBER and MONEY a number (rupees for money), DATE a calendar day
 * "YYYY-MM-DD" (no time, so no time zone to get wrong), SELECT one option id, MULTI_SELECT option ids, CHECKBOX true,
 * LINK an http(s) address, PERSON a user id. Empty — "", null, [], false — is no value: the row is removed.
 *
 * Since 20 Nov 2026 (lists with rows of their own — src/lib/smart-lists/own-rows.ts): RATING one to five (a whole
 * number), EMAIL an address in lower case, PHONE the number as typed, tidied. Nothing here reaches outside Deskzo: a
 * link is kept as written, never fetched or checked (owner: "no automatic link tracker … just to keep records").
 */

export const PROPERTY_KINDS = ["TEXT", "NUMBER", "MONEY", "DATE", "SELECT", "MULTI_SELECT", "CHECKBOX", "LINK", "PERSON", "RATING", "EMAIL", "PHONE", "COMPANY", "LEAD", "CONTACT", "ROW", "FILE", "ROLLUP", "FORMULA"] as const;
export type PropertyKind = (typeof PROPERTY_KINDS)[number];

export const KIND_LABELS: Record<PropertyKind, string> = {
  TEXT: "Text",
  NUMBER: "Number",
  MONEY: "Money (₹)",
  DATE: "Date",
  SELECT: "Select",
  MULTI_SELECT: "Multi-select",
  CHECKBOX: "Checkbox",
  LINK: "Link",
  PERSON: "Person",
  RATING: "Rating (stars)",
  EMAIL: "Email",
  PHONE: "Phone",
  COMPANY: "Company",
  LEAD: "Lead",
  CONTACT: "Contact",
  ROW: "Row of another list",
  FILE: "Files",
  ROLLUP: "Count or sum of linked rows",
  FORMULA: "Formula",
};

/**
 * A count column's set-up (Smart Lists phase 3 — src/lib/smart-lists/rollups.ts), kept in its `options`: the other
 * list whose rows link here, the link column of it, and what it works out — how many, how many with a choice, or the
 * sum of a Number or Money column.
 */
export type Rollup = { list: string; via: string; fn: "count" | "sum"; field: string | null; where: { propertyId: string; optionId: string } | null; money: boolean };

const ID = /^[a-z0-9]{8,40}$/i;
export function rollupOf(options: unknown): Rollup | null {
  if (!options || typeof options !== "object" || Array.isArray(options)) return null;
  const o = options as Partial<Rollup>;
  if (typeof o.list !== "string" || !ID.test(o.list) || typeof o.via !== "string" || !ID.test(o.via)) return null;
  const fn = o.fn === "sum" ? "sum" : "count";
  const field = fn === "sum" && typeof o.field === "string" && ID.test(o.field) ? o.field : null;
  const w = o.where as Rollup["where"] | undefined;
  const where = fn === "count" && w && typeof w.propertyId === "string" && ID.test(w.propertyId) && typeof w.optionId === "string" && /^[a-z0-9]{1,16}$/.test(w.optionId) ? { propertyId: w.propertyId, optionId: w.optionId } : null;
  if (fn === "sum" && !field) return null;
  return { list: o.list, via: o.via, fn, field, where, money: o.money === true };
}

/**
 * Columns that link to records elsewhere (owner, 20 Nov 2026 — Smart Lists phase 2): a company, a lead, a contact, or a
 * row of another list. The value is their ids; who may see each is checked where it is saved and shown
 * (src/lib/smart-lists/links.ts).
 */
export const LINK_KINDS = ["COMPANY", "LEAD", "CONTACT", "ROW"] as const;
export type LinkKind = (typeof LINK_KINDS)[number];
export const isLinkKind = (k: unknown): k is LinkKind => typeof k === "string" && (LINK_KINDS as readonly string[]).includes(k);

/** The list a "Row of another list" column links to, kept in its `options` as { listId }. */
export function linkTargetOf(options: unknown): string | null {
  const id = options && typeof options === "object" && !Array.isArray(options) ? (options as { listId?: unknown }).listId : null;
  return typeof id === "string" && /^[a-z0-9]{8,40}$/i.test(id) ? id : null;
}

export const VIEW_KINDS = ["TABLE", "BOARD", "CALENDAR", "GALLERY", "TIMELINE"] as const;
export type ViewKind = (typeof VIEW_KINDS)[number];

/** A select's colours: the keys, never a hex, so the theme decides how each looks. */
export const OPTION_COLORS = ["gray", "blue", "green", "amber", "red", "purple", "pink"] as const;
export type OptionColor = (typeof OPTION_COLORS)[number];

export type SelectOption = { id: string; name: string; color: OptionColor };
export type ChecklistItem = { id: string; text: string; done: boolean };

export const LIMITS = {
  propertyName: 60,
  properties: 40,
  views: 12,
  viewName: 40,
  options: 60,
  optionName: 40,
  text: 2000,
  link: 500,
  email: 254,
  phone: 30,
  rating: 5,
  /** Records one link column holds for a row, and files one Files column does. */
  links: 20,
  files: 10,
  fileBytes: 5 * 1024 * 1024,
  notes: 20_000,
  checklist: 100,
  checklistText: 300,
  money: 1e13,
} as const;

export const isPropertyKind = (v: unknown): v is PropertyKind => typeof v === "string" && (PROPERTY_KINDS as readonly string[]).includes(v);
export const isViewKind = (v: unknown): v is ViewKind => typeof v === "string" && (VIEW_KINDS as readonly string[]).includes(v);

const clean = (v: unknown, max: number) => String(v ?? "").replace(/\s+/g, " ").trim().slice(0, max);

/** A short id for an option or a checklist line — unique within its list, nothing more. */
export function shortId(taken: Iterable<string> = []): string {
  const used = new Set(taken);
  for (;;) {
    const id = Math.random().toString(36).slice(2, 9);
    if (id && !used.has(id)) return id;
  }
}

/** A select's options as kept: named, no name twice (whatever the case), known colours, ids kept when given. */
export function cleanOptions(input: unknown): SelectOption[] {
  if (!Array.isArray(input)) return [];
  const out: SelectOption[] = [];
  const names = new Set<string>();
  for (const raw of input.slice(0, LIMITS.options)) {
    const o = (raw ?? {}) as Partial<SelectOption>;
    const name = clean(o.name, LIMITS.optionName);
    if (!name || names.has(name.toLowerCase())) continue;
    names.add(name.toLowerCase());
    const id = typeof o.id === "string" && /^[a-z0-9]{1,16}$/.test(o.id) && !out.some((x) => x.id === o.id) ? o.id : shortId(out.map((x) => x.id));
    const color = (OPTION_COLORS as readonly string[]).includes(String(o.color)) ? (o.color as OptionColor) : OPTION_COLORS[out.length % OPTION_COLORS.length]!;
    out.push({ id, name, color });
  }
  return out;
}

export function optionsOf(raw: unknown): SelectOption[] {
  return cleanOptions(raw);
}

const DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A real calendar day as "YYYY-MM-DD", or null. */
export function calendarDay(v: unknown): string | null {
  const m = DAY.exec(String(v ?? "").trim());
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const date = new Date(Date.UTC(y, mo - 1, d));
  if (date.getUTCFullYear() !== y || date.getUTCMonth() !== mo - 1 || date.getUTCDate() !== d || y < 1900 || y > 2200) return null;
  return `${m[1]}-${m[2]}-${m[3]}`;
}

export type Parsed = { ok: true; value: unknown | null } | { ok: false; error: string };

/**
 * What a cell keeps for `raw`, by its column's kind — null when it is empty (the value goes). `people` is who a PERSON
 * column may name (the workspace's active people), checked by the caller with the database.
 */
export function parseValue(kind: PropertyKind, raw: unknown, options: SelectOption[] = []): Parsed {
  if (raw === null || raw === undefined || raw === "" || raw === false || (Array.isArray(raw) && raw.length === 0)) return { ok: true, value: null };
  switch (kind) {
    case "TEXT": {
      const s = String(raw).trim().slice(0, LIMITS.text);
      return { ok: true, value: s || null };
    }
    case "NUMBER":
    case "MONEY": {
      const n = typeof raw === "number" ? raw : Number(String(raw).replace(/[,₹\s]/g, ""));
      if (!Number.isFinite(n)) return { ok: false, error: "That isn't a number." };
      if (Math.abs(n) > LIMITS.money) return { ok: false, error: "That number is too large." };
      return { ok: true, value: kind === "MONEY" ? Math.round(n * 100) / 100 : n };
    }
    case "DATE": {
      const day = calendarDay(raw);
      return day ? { ok: true, value: day } : { ok: false, error: "That isn't a date." };
    }
    case "SELECT": {
      const id = String(raw);
      return options.some((o) => o.id === id) ? { ok: true, value: id } : { ok: false, error: "That choice isn't one of this column's." };
    }
    case "MULTI_SELECT": {
      const ids = (Array.isArray(raw) ? raw : [raw]).map(String);
      const known = [...new Set(ids)].filter((id) => options.some((o) => o.id === id));
      if (known.length !== new Set(ids).size) return { ok: false, error: "A choice isn't one of this column's." };
      return { ok: true, value: known.length ? known : null };
    }
    case "CHECKBOX":
      return { ok: true, value: raw === true || raw === "true" ? true : null };
    case "LINK": {
      const s = String(raw).trim().slice(0, LIMITS.link);
      try {
        const url = new URL(/^https?:\/\//i.test(s) ? s : `https://${s}`);
        if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("scheme");
        if (!url.hostname.includes(".")) throw new Error("host");
        return { ok: true, value: url.toString() };
      } catch {
        return { ok: false, error: "That isn't a web address." };
      }
    }
    case "PERSON":
      return typeof raw === "string" && /^[a-z0-9]{8,40}$/i.test(raw) ? { ok: true, value: raw } : { ok: false, error: "Pick somebody from the list." };
    case "RATING": {
      // A number, or stars typed or pasted ("★★★").
      const s = String(raw).trim();
      const stars = /^[★*]+$/.test(s) ? s.length : Number(s);
      if (!Number.isFinite(stars) || stars < 0 || stars > LIMITS.rating) return { ok: false, error: `A rating is 1 to ${LIMITS.rating} stars.` };
      const n = Math.round(stars);
      return { ok: true, value: n === 0 ? null : n };
    }
    case "EMAIL": {
      const s = String(raw).trim().toLowerCase().slice(0, LIMITS.email);
      return /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/.test(s) ? { ok: true, value: s } : { ok: false, error: "That isn't an email address." };
    }
    case "ROLLUP":
      return { ok: false, error: "This column is worked out from the rows that link here." };
    case "FORMULA":
      return { ok: false, error: "This column is worked out by its formula." };
    case "COMPANY":
    case "LEAD":
    case "CONTACT":
    case "ROW":
    case "FILE": {
      // Ids, once each — whether each is one the person may link is the server's check (src/lib/smart-lists/links.ts).
      const ids = [...new Set((Array.isArray(raw) ? raw : [raw]).map(String))];
      const max = kind === "FILE" ? LIMITS.files : LIMITS.links;
      if (ids.some((id) => !/^[a-z0-9]{8,40}$/i.test(id))) return { ok: false, error: "Pick from the list." };
      if (ids.length > max) return { ok: false, error: kind === "FILE" ? `A cell holds up to ${max} files.` : `A cell links up to ${max} records.` };
      return { ok: true, value: ids.length ? ids : null };
    }
    case "PHONE": {
      const s = String(raw).replace(/\s+/g, " ").trim().slice(0, LIMITS.phone);
      const digits = s.replace(/\D/g, "");
      return /^\+?[\d\s()./-]+$/.test(s) && digits.length >= 5 && digits.length <= 15 ? { ok: true, value: s } : { ok: false, error: "That isn't a phone number." };
    }
  }
}

/** A value read back from the database, as its kind should be — a value left over from a changed column reads as empty. */
export function readValue(kind: PropertyKind, stored: unknown, options: SelectOption[]): unknown | null {
  // A formula's result is Deskzo's, kept as it was worked out (Smart Lists phase 4).
  if (kind === "FORMULA") return typeof stored === "number" || typeof stored === "string" || stored === true ? stored : null;
  const parsed = parseValue(kind, stored, options);
  return parsed.ok ? parsed.value : null;
}

/** A checklist as kept: lines with words, at most `LIMITS.checklist`, ids unique. */
export function cleanChecklist(input: unknown): ChecklistItem[] {
  if (!Array.isArray(input)) return [];
  const out: ChecklistItem[] = [];
  for (const raw of input.slice(0, LIMITS.checklist)) {
    const item = (raw ?? {}) as Partial<ChecklistItem>;
    const text = clean(item.text, LIMITS.checklistText);
    if (!text) continue;
    const id = typeof item.id === "string" && /^[a-z0-9]{1,16}$/.test(item.id) && !out.some((x) => x.id === item.id) ? item.id : shortId(out.map((x) => x.id));
    out.push({ id, text, done: item.done === true });
  }
  return out;
}

/** The value in words, for a card, a search or an export. */
export function valueText(kind: PropertyKind, value: unknown, options: SelectOption[], people: Map<string, string> = new Map()): string {
  if (value === null || value === undefined) return "";
  switch (kind) {
    case "MONEY":
      return typeof value === "number" ? `₹${value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}` : "";
    case "NUMBER":
      return typeof value === "number" ? value.toLocaleString("en-IN") : "";
    case "SELECT":
      return options.find((o) => o.id === value)?.name ?? "";
    case "MULTI_SELECT":
      return Array.isArray(value) ? value.map((id) => options.find((o) => o.id === id)?.name).filter(Boolean).join(", ") : "";
    case "CHECKBOX":
      return value === true ? "Yes" : "";
    case "PERSON":
      return people.get(String(value)) ?? "";
    case "RATING":
      return typeof value === "number" ? "★".repeat(Math.max(0, Math.min(LIMITS.rating, value))) : "";
    case "ROLLUP":
      return typeof value === "number" ? value.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "";
    case "FORMULA":
      return typeof value === "number" ? value.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : value === true ? "Yes" : typeof value === "string" ? value : "";
    case "COMPANY":
    case "LEAD":
    case "CONTACT":
    case "ROW":
    case "FILE":
      // `people` here holds the linked records' and files' names, by id.
      return Array.isArray(value) ? value.map((id) => people.get(String(id)) ?? "").filter(Boolean).join(", ") : "";
    default:
      return String(value);
  }
}
