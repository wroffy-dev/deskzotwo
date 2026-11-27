/**
 * The first refusal in a form's errors, in the order the fields were declared (security audit, 11 Nov 2026 — SEC-69).
 *
 * A form checks itself against the same rules as the server before it sends anything. A field with a line of its own
 * shows why it was refused; a field without one refused silently, and the form "just did nothing" — a negative lead
 * value, a link that isn't a web address. Handing this to `handleSubmit`'s second argument puts the first reason at the
 * top of the form whichever field it belongs to.
 */
export function firstFormMessage(errors: unknown, depth = 0): string | null {
  if (!errors || typeof errors !== "object" || depth > 6) return null;
  const own = (errors as { message?: unknown }).message;
  if (typeof own === "string" && own.trim()) return own;
  for (const [key, value] of Object.entries(errors as Record<string, unknown>)) {
    // `ref` is the DOM node react-hook-form keeps beside the message: never walked.
    if (key === "ref") continue;
    const found = firstFormMessage(value, depth + 1);
    if (found) return found;
  }
  return null;
}

/** What a form says when it was refused and no field gave a reason. */
export const FORM_REFUSED = "Something on this form isn't right — check each field and try again.";
