/**
 * How long a typed value may be (security audit, 11 Nov 2026 — SEC-30).
 *
 * Until then some 350 text fields had no ceiling at all: a company saved with a 50,017-character name, and its list
 * page grew to half a megabyte. Every text field in src/lib/validation now carries a maximum, picked to be far past
 * anything typed in earnest — so the only thing it refuses is a request made by hand. `npx tsx
 * scripts/check-audit-fixes-e.ts` walks every schema and fails on a string or a list without one.
 *
 * The sizes, for a new field:
 */
export const TEXT_MAX = {
  /** An id, a date, a code, a status. */
  id: 100,
  /** A phone number, or the few of them people type into one box. */
  phone: 100,
  /** A name, a title, a subject, a city. */
  name: 200,
  /** An email address — the longest one the standard allows. */
  email: 254,
  /** Any other single line. */
  line: 500,
  /** A web address. */
  url: 2000,
  /** A reason, an address, an outcome. */
  paragraph: 5000,
  /** Notes, descriptions, terms and conditions. */
  notes: 20000,
  /** A written body: a comment, a template, HTML. */
  body: 200000,
  /** A list of ids picked on a screen. */
  ids: 1000,
} as const;

/** The refusal for a value past its maximum, in plain words. */
export const tooLong = (max: number) => `That's too long — keep it within ${max.toLocaleString("en-US")} characters.`;

/** The refusal for a list past its maximum. */
export const tooMany = (max: number, things = "of them") => `That's too many at once — ${max.toLocaleString("en-US")} ${things} at most.`;
