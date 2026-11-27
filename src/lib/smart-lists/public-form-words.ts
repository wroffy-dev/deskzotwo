/**
 * The words of a Smart List form's public link (Smart Lists phase 4) that the screen and the server share — pure, so
 * the form editor can show them. The rules are src/lib/smart-lists/public-forms.ts.
 */

/** The consent wording a public form starts with; {company} becomes the company's name. */
export const DEFAULT_CONSENT = "I agree that {company} may keep these answers and contact me about them.";

/** The longest consent wording a builder may write. */
export const CONSENT_MAX = 600;

/** A public form's address, from its slug. */
export const publicFormPath = (slug: string) => `/list-forms/${slug}`;
