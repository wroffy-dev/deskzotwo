import { requestHost } from "@/lib/tenancy/host";

/**
 * Whether a request that changes something came from a page of this same address.
 *
 * A server action gets this check from Next.js for free; a route handler does not, and a signed-in browser sends its
 * session cookie with a form any other site posts to it. Security audit, 11 Nov 2026 (SEC-60): the backup routes had
 * no such check.
 *
 * The rule every upload route already wrote out by hand (src/app/api/migration/upload/route.ts and its siblings) —
 * an `Origin` naming exactly the host this request arrived on — plus one case it never met: a plain form post from a
 * page served with `Referrer-Policy: no-referrer` (every page here — src/proxy.ts `harden`) is sent with
 * `Origin: null`, by the Fetch standard. The backup download is such a form. There the browser's own
 * `Sec-Fetch-Site`, which no page can set, says whether it came from this origin.
 */
export function sameOrigin(request: Request): boolean {
  const checked = requestHost(request.headers);
  const host = typeof checked === "string" ? checked : null;
  if (!host) return false;
  const origin = request.headers.get("origin");
  if (origin && origin !== "null") {
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }
  return request.headers.get("sec-fetch-site") === "same-origin";
}
