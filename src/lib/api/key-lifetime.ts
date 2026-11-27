/**
 * How long an API key may live (security audit, 11 Nov 2026, SEC-25): a year at most. A key is a sign-in that never
 * asks for a password or a code again, so "never expires" was a session for life. New keys get an `expiresAt` no
 * later than this (src/actions/api-keys.ts); a key made before, with none, ends a year after it was made — checked
 * on every call (src/lib/api/handler.ts). No database change needed. Client-safe: the settings screen reads it too.
 */
export const API_KEY_MAX_DAYS = 365;

const MAX_MS = API_KEY_MAX_DAYS * 86_400_000;

/** When this key stops working: its own expiry, but never later than a year after it was made. */
export function keyExpiry(key: { createdAt: Date; expiresAt: Date | null }): Date {
  const cap = new Date(key.createdAt.getTime() + MAX_MS);
  return key.expiresAt && key.expiresAt < cap ? key.expiresAt : cap;
}
