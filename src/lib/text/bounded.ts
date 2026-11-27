import { TEXT_MAX } from "@/lib/validation/text";

/**
 * Caps for what an action stores without a schema (owner, 15 Nov 2026: "input field sanitization and validations").
 * Every schema in src/lib/validation carries a maximum; an action that reads its input by hand caps it with these, at
 * the sizes in TEXT_MAX — far past anything typed in earnest, so only a request made by hand is ever cut.
 * scripts/check-input-bounds.ts fails on an action that saves typed text with neither.
 */
export { TEXT_MAX };

/** Typed text, trimmed and cut at `max` characters; "" for anything that isn't a string or number. */
export function clip(value: unknown, max: number): string {
  if (typeof value !== "string" && typeof value !== "number") return "";
  return String(value).trim().slice(0, max);
}

/** As `clip`, but null for nothing typed — for an optional column. */
export function clipOrNull(value: unknown, max: number): string | null {
  const text = clip(value, max);
  return text ? text : null;
}

/** A list of typed values, each cut at `max`, the list at `count` — empty strings dropped. */
export function clipList(value: unknown, max: number, count: number): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .slice(0, count)
    .map((v) => clip(v, max))
    .filter(Boolean);
}

/** Whether a JSON value (filters, settings, a provider's config) is within `bytes` once written out — 64 KB by default. */
export function withinSize(value: unknown, bytes = 64 * 1024): boolean {
  try {
    return JSON.stringify(value ?? null).length <= bytes;
  } catch {
    return false;
  }
}
