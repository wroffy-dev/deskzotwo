import { LIMITS, calendarDay, parseValue, type PropertyKind, type SelectOption } from "@/lib/smart-lists/values";

/**
 * Bringing a spreadsheet into a list with rows of its own (owner, 20 Nov 2026 — "CSV import and Excel export"): the
 * file read into rows of text, each column matched to one of the list's — its title, a column it has, a new column of
 * the kind its values look like, or left out — and each cell turned into what that column keeps. Pure and client-safe:
 * the import dialog shows the same guess the server acts on (src/actions/smart-list-rows.ts), and
 * check:smart-list-own-rows runs it.
 *
 * Nothing is looked up outside Deskzo: a link is kept as written.
 */

export const IMPORT_LIMITS = { rows: 2000, columns: 40, cell: LIMITS.text } as const;

/** A CSV file's rows — quoted fields, doubled quotes, line breaks inside quotes; a comma, semicolon or tab between. */
export function parseCsv(text: string): string[][] {
  // A byte-order mark (Excel writes one) is not part of the first header.
  const src = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const firstLine = src.slice(0, Math.max(0, src.search(/\r?\n/)) || src.length);
  const counts = { ",": 0, ";": 0, "\t": 0 } as Record<string, number>;
  let quoted = false;
  for (const ch of firstLine) {
    if (ch === '"') quoted = !quoted;
    else if (!quoted && ch in counts) counts[ch]! += 1;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0]!;
  const sep = best[1] > 0 ? best[0] : ",";

  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (src[i + 1] === '"') {
          field += '"';
          i += 1;
        } else inQuotes = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === "") inQuotes = true;
    else if (ch === sep) {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && src[i + 1] === "\n") i += 1;
      row.push(field);
      rows.push(row);
      row = [];
      field = "";
    } else field += ch;
  }
  if (field !== "" || row.length) {
    row.push(field);
    rows.push(row);
  }
  // Blank lines go; every row as wide as the header.
  const kept = rows.filter((r) => r.some((c) => c.trim() !== ""));
  return kept;
}

/** Headers and rows as the import works on them: trimmed, as wide as the header, within the limits. */
export function tidyTable(table: string[][]): { headers: string[]; rows: string[][]; cut: number } {
  const [head = [], ...body] = table;
  const width = Math.min(IMPORT_LIMITS.columns + 1, Math.max(head.length, ...body.slice(0, 50).map((r) => r.length)));
  const headers = Array.from({ length: width }, (_, i) => String(head[i] ?? "").replace(/\s+/g, " ").trim().slice(0, LIMITS.propertyName));
  const rows = body.slice(0, IMPORT_LIMITS.rows).map((r) => Array.from({ length: width }, (_, i) => String(r[i] ?? "").trim().slice(0, IMPORT_LIMITS.cell)));
  return { headers, rows, cut: Math.max(0, body.length - IMPORT_LIMITS.rows) };
}

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const pad = (n: number) => String(n).padStart(2, "0");

/**
 * A calendar day from what spreadsheets write: 2026-11-20, 20/11/2026, 20-11-2026, 20.11.2026 (day first, as in India),
 * 20 Nov 2026, 20-Nov-26, Nov 20, 2026, or a date and time. Null when it isn't one.
 */
export function toDay(raw: string): string | null {
  const s = raw.trim();
  if (!s) return null;
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[T ].*)?$/.exec(s);
  if (m) return calendarDay(`${m[1]}-${pad(Number(m[2]))}-${pad(Number(m[3]))}`);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{2}|\d{4})$/.exec(s);
  if (m) {
    const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return calendarDay(`${year}-${pad(Number(m[2]))}-${pad(Number(m[1]))}`);
  }
  m = /^(\d{1,2})[\s-]+([a-z]{3})[a-z]*[\s-,]+(\d{2}|\d{4})$/i.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[2]!.toLowerCase());
    const year = m[3]!.length === 2 ? 2000 + Number(m[3]) : Number(m[3]);
    return mo < 0 ? null : calendarDay(`${year}-${pad(mo + 1)}-${pad(Number(m[1]))}`);
  }
  m = /^([a-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{4})$/i.exec(s);
  if (m) {
    const mo = MONTHS.indexOf(m[1]!.toLowerCase());
    return mo < 0 ? null : calendarDay(`${m[3]}-${pad(mo + 1)}-${pad(Number(m[2]))}`);
  }
  return null;
}

/** A number from what people type: ₹1,23,456.50, Rs. 500, 12%, 1 200. Null when it isn't one. */
export function toNumber(raw: string): number | null {
  const s = raw.replace(/^(₹|rs\.?|inr|aed|usd|\$)\s*/i, "").replace(/[,\s%]/g, "");
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

const YES = new Set(["yes", "y", "true", "1", "✓", "✔", "x", "done", "ticked", "checked"]);
const NO = new Set(["no", "n", "false", "0", ""]);
const EMAIL = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[a-z]{2,}$/i;
const URLISH = /^(https?:\/\/|www\.)\S+$|^[a-z0-9-]+(\.[a-z0-9-]+)+(\/\S*)?$/i;
const PHONEISH = /^\+?[\d\s()./-]{7,20}$/;

const MONEY_WORDS = /price|cost|amount|value|fee|ctc|salary|budget|rate|revenue|₹|rs\b|inr|spend|paid|emd/i;
const PHONE_WORDS = /phone|mobile|whatsapp|contact no|cell/i;
const RATING_WORDS = /rating|stars|score out of 5/i;

/** The kind of column a header and its values look like — the kind a new column is made as. */
export function guessKind(header: string, samples: string[]): PropertyKind {
  const filled = samples.map((s) => s.trim()).filter(Boolean);
  if (filled.length === 0) return "TEXT";
  if (filled.every((s) => EMAIL.test(s))) return "EMAIL";
  if (PHONE_WORDS.test(header) && filled.every((s) => PHONEISH.test(s))) return "PHONE";
  if (filled.every((s) => URLISH.test(s) && !/^\d+(\.\d+)*$/.test(s))) return "LINK";
  if (filled.every((s) => toDay(s) !== null)) return "DATE";
  if (RATING_WORDS.test(header) && filled.every((s) => /^[★*]{1,5}$/.test(s) || /^[1-5]$/.test(s))) return "RATING";
  if (filled.every((s) => toNumber(s) !== null)) return MONEY_WORDS.test(header) ? "MONEY" : "NUMBER";
  const lower = filled.map((s) => s.toLowerCase());
  if (lower.every((s) => YES.has(s) || NO.has(s)) && lower.some((s) => YES.has(s))) return "CHECKBOX";
  const distinct = new Set(lower);
  // A few values, each repeated: a choice. (Unique names in every row are text.)
  if (filled.length >= 4 && distinct.size <= 12 && distinct.size <= filled.length * 0.6 && filled.every((s) => s.length <= LIMITS.optionName)) return "SELECT";
  return "TEXT";
}

/** The columns an Excel download adds after the list's own — who added a row and when. */
const EXPORT_EXTRAS = new Set(["added by", "added on", "last changed"]);

export type ImportTarget = { to: "title" } | { to: "skip" } | { to: "column"; propertyId: string } | { to: "new"; kind: PropertyKind; name: string };

/**
 * Where each column of the file goes, as first offered: the title — the header named like the list's title column,
 * or "Name"/"Title", else the first — a column of the list with the same name, or a new column of the kind it looks
 * like. A header with no name is left out.
 */
export function suggestMapping(headers: string[], rows: string[][], existing: { id: string; name: string }[], titleName: string): ImportTarget[] {
  const lower = headers.map((h) => h.toLowerCase());
  let title = lower.indexOf(titleName.toLowerCase());
  if (title < 0) title = lower.findIndex((h) => h === "name" || h === "title");
  if (title < 0) title = lower.findIndex((h) => h !== "");
  const taken = new Set(existing.map((p) => p.name.toLowerCase()));
  return headers.map((h, i): ImportTarget => {
    if (i === title) return { to: "title" };
    if (!h) return { to: "skip" };
    const same = existing.find((p) => p.name.toLowerCase() === h.toLowerCase());
    if (same) return { to: "column", propertyId: same.id };
    // What a Deskzo download adds after the columns (src/lib/smart-lists/own-rows.ts) isn't brought back in.
    if (EXPORT_EXTRAS.has(h.toLowerCase())) return { to: "skip" };
    let name = h;
    for (let n = 2; taken.has(name.toLowerCase()); n += 1) name = `${h} ${n}`.slice(0, LIMITS.propertyName);
    taken.add(name.toLowerCase());
    return { to: "new", kind: guessKind(h, rows.slice(0, 200).map((r) => r[i] ?? "")), name };
  });
}

/** A select's choices for a new column, from the values in the file — in the order they first appear. */
export function choicesIn(values: string[], multi: boolean): string[] {
  const seen = new Map<string, string>();
  for (const v of values) {
    for (const part of multi ? v.split(/[,;|]/) : [v]) {
      const name = part.replace(/\s+/g, " ").trim().slice(0, LIMITS.optionName);
      if (name && !seen.has(name.toLowerCase())) seen.set(name.toLowerCase(), name);
    }
  }
  return [...seen.values()].slice(0, LIMITS.options);
}

/**
 * What one cell of the file becomes in a column of `kind`: the value the column keeps, or null — empty, or not one
 * (counted as left out). A select's choice and a person are matched by name, whatever the case; a person also by email.
 */
export function cellValue(kind: PropertyKind, raw: string, ctx: { options: SelectOption[]; people: { id: string; name: string; email?: string | null }[] }): { value: unknown | null; skipped: boolean } {
  const s = raw.trim();
  if (!s) return { value: null, skipped: false };
  let input: unknown = s;
  switch (kind) {
    case "NUMBER":
    case "MONEY":
      input = toNumber(s);
      break;
    case "DATE":
      input = toDay(s);
      break;
    case "CHECKBOX":
      input = YES.has(s.toLowerCase());
      if (!input) return { value: null, skipped: !NO.has(s.toLowerCase()) };
      break;
    case "SELECT":
      input = ctx.options.find((o) => o.name.toLowerCase() === s.toLowerCase())?.id ?? null;
      break;
    case "MULTI_SELECT":
      input = s.split(/[,;|]/).map((p) => p.trim().toLowerCase()).filter(Boolean).map((p) => ctx.options.find((o) => o.name.toLowerCase() === p)?.id).filter(Boolean);
      break;
    case "PERSON":
      input = ctx.people.find((p) => p.name.toLowerCase() === s.toLowerCase() || (!!p.email && p.email.toLowerCase() === s.toLowerCase()))?.id ?? null;
      break;
  }
  if (input === null || (Array.isArray(input) && input.length === 0)) return { value: null, skipped: true };
  const parsed = parseValue(kind, input, ctx.options);
  return parsed.ok ? { value: parsed.value, skipped: parsed.value === null } : { value: null, skipped: true };
}
