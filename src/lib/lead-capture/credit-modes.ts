/**
 * The choices for who a website form's leads are raised by — the plain half of src/lib/lead-capture/credit.ts, which the
 * settings screen imports without the database.
 */
export const CREDIT_MODES = ["NOBODY", "MAKER", "PERSON"] as const;
export type CreditMode = (typeof CREDIT_MODES)[number];
export type KeyCredit = { mode: CreditMode; userId: string | null; label: string };

/** Shown as Raised by when no person is credited and the admin named nothing. */
export const DEFAULT_CREDIT_LABEL = "Website";

export function isCreditMode(value: unknown): value is CreditMode {
  return typeof value === "string" && (CREDIT_MODES as readonly string[]).includes(value);
}
