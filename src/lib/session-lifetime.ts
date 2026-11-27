/**
 * How long a session lasts without being used: a day (security audit, Nov 2026). It had next-auth's default,
 * thirty days. The token is renewed as it is used, so somebody working every day stays signed in; a cookie
 * left behind, or copied, stops working a day after it was last used. Here on its own so the retention purge
 * (src/lib/security/retention.ts) can read it without the sign-in setup.
 */
export const SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;
