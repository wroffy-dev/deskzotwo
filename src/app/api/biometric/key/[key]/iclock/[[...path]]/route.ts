/**
 * A terminal's own secret address (owner, 12 Nov 2026 — security audit SEC-06; src/lib/hr/device-key.ts): the same
 * handlers as the plain /iclock address, reached at /iclock-k/<key>/iclock/… (next.config.ts), with the key as a
 * route parameter the handlers check against the terminal the request names.
 */
export { GET, POST } from "@/app/api/biometric/iclock/[[...path]]/route";
