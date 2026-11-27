/**
 * A page inside the workspace for the Deskzo app's pages to land on (src/lib/app/web-session.ts): an absolute
 * path, nothing that leaves the workspace, and nothing that signs in again. Null for anything else.
 */
export function safeAppPath(value: unknown): string | null {
  const path = safeLocalPath(value);
  if (!path) return null;
  if (/^\/(api|handoff|login|switch|link)(\/|\?|#|$)/.test(path)) return null;
  return path;
}

/**
 * Any absolute path on this site, and nothing a browser could read as another one — for a redirect after signing in
 * (/login's callbackUrl, which may be /link/confirm). One leading slash: "//host" and "/\host" are other sites to a
 * browser, which reads a backslash as a slash. No space, control character or DEL either (security audit, Nov 2026):
 * the URL parser drops tab, CR and LF, so "/\t/evil.example" arrives as "//evil.example". Null for anything else.
 */
export function safeLocalPath(value: unknown, max = 300): string | null {
  if (typeof value !== "string" || value.length > max) return null;
  if (!value.startsWith("/") || value.startsWith("//")) return null;
  if ([...value].some((ch) => ch === "\\" || ch.charCodeAt(0) <= 32 || ch.charCodeAt(0) === 127)) return null;
  return value;
}
