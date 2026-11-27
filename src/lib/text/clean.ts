/**
 * Characters nobody types on purpose, taken out of what is saved (owner, 15 Nov 2026: "input field sanitization and
 * validations").
 *
 *   · Control characters — NUL to US and DEL, and the C1 block — but not tab, new line or carriage return. A NUL can't
 *     even be stored in Postgres text; the rest are pasted from terminals and broken exports and break CSVs and PDFs.
 *   · Invisible spacing: the zero-width space (U+200B), the byte-order mark (U+FEFF), the word joiner (U+2060) and the
 *     Mongolian vowel separator (U+180E) — how "Acme" and "Ac​me" become two companies that look the same.
 *   · Direction overrides and isolates (U+202A–U+202E, U+2066–U+2069): "Trojan source" — text shown in another order
 *     than it is stored, so a name or a file name reads as something it isn't.
 *
 * Kept on purpose: the zero-width joiner and non-joiner (U+200C, U+200D), which Hindi, Malayalam, Persian and emoji
 * need to render correctly, and the left-to-right and right-to-left marks (U+200E, U+200F), which Arabic text uses.
 *
 * Written as ranges of char codes, never as escapes in a pattern — see the memory note on \uXXXX escapes landing as
 * invisible characters in source.
 */

const DROP = new Set<number>([0x200b, 0xfeff, 0x2060, 0x180e, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069]);

/** Whether a character code is one this takes out. */
function dropped(code: number): boolean {
  if (code === 0x09 || code === 0x0a || code === 0x0d) return false;
  if (code < 0x20 || code === 0x7f) return true;
  if (code >= 0x80 && code <= 0x9f) return true;
  return DROP.has(code);
}

/** The text without the characters above. The same string back when there are none (the common case, no copy). */
export function cleanText(value: string): string {
  let i = 0;
  for (; i < value.length; i++) if (dropped(value.charCodeAt(i))) break;
  if (i === value.length) return value;
  let out = value.slice(0, i);
  for (; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (!dropped(code)) out += value[i];
  }
  return out;
}

/** Whether a value is a plain object or array to walk — never a Date, Decimal, Buffer or class instance. */
function walkable(value: unknown): value is Record<string, unknown> | unknown[] {
  if (Array.isArray(value)) return true;
  if (value === null || typeof value !== "object") return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * A write's data with every string in it cleaned — nested creates, lists and JSON values too. Objects are copied only
 * where something changed, so a write with nothing to clean is passed through as it came.
 */
export function cleanWriteData<T>(value: T, depth = 0): T {
  if (typeof value === "string") return cleanText(value) as T;
  if (depth > 12 || !walkable(value)) return value;
  if (Array.isArray(value)) {
    let changed = false;
    const out = value.map((v) => {
      const c = cleanWriteData(v, depth + 1);
      if (c !== v) changed = true;
      return c;
    });
    return (changed ? out : value) as T;
  }
  let copy: Record<string, unknown> | null = null;
  for (const [key, v] of Object.entries(value)) {
    const c = cleanWriteData(v, depth + 1);
    if (c !== v) (copy ??= { ...(value as Record<string, unknown>) })[key] = c;
  }
  return (copy ?? value) as T;
}

/** The writes whose arguments carry data: their `data`, and an upsert's `create` and `update`. */
const WRITES = new Set(["create", "createMany", "createManyAndReturn", "update", "updateMany", "updateManyAndReturn", "upsert"]);

/** A model call's arguments with the data of a write cleaned (src/lib/db.ts); any other call as it came. */
export function cleanWriteArgs(method: string, args: unknown[]): unknown[] {
  if (!WRITES.has(method) || !walkable(args[0]) || Array.isArray(args[0])) return args;
  const [first, ...rest] = args;
  const options = first as Record<string, unknown>;
  let next: Record<string, unknown> | null = null;
  for (const key of ["data", "create", "update"]) {
    if (!(key in options)) continue;
    const cleaned = cleanWriteData(options[key]);
    if (cleaned !== options[key]) (next ??= { ...options })[key] = cleaned;
  }
  return next ? [next, ...rest] : args;
}
