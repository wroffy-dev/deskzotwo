import { currentUser } from "@/lib/session";
import { moduleAccessFor } from "@/lib/modules-access";
import { notMigratedYet } from "@/lib/not-migrated";
import { hearableRecording } from "@/lib/telephony/access";

/**
 * A cloud call's recording (owner, 26 Oct 2026 — src/lib/telephony), played through Deskzo: CallerDesk's own
 * link is never shown, because anybody holding it could listen, and here whether the person may hear the call
 * is asked on every play (src/lib/telephony/access.ts). Only CallerDesk's recording hosts are fetched, and a
 * seek's Range is passed on so the player can skip about.
 */
export const dynamic = "force-dynamic";

const ALLOWED_HOST = /(^|\.)callerdesk\.io$/i;
const notFound = () => new Response("Not found", { status: 404 });
const MAX_REDIRECTS = 3;

export async function GET(request: Request, context: { params: Promise<{ id: string }> }) {
  const user = await currentUser();
  if (!user || (await moduleAccessFor(user.id, "calls")) !== "available") return notFound();
  const { id } = await context.params;

  let source: URL;
  try {
    const url = await hearableRecording(user.id, id);
    if (!url) return notFound();
    source = new URL(url);
  } catch (err) {
    if (!notMigratedYet(err)) console.error("telephony recording failed", err);
    return notFound();
  }
  if (source.protocol !== "https:" || !ALLOWED_HOST.test(source.hostname)) return notFound();

  /**
   * Redirects followed by hand, each hop's host checked as the first was (security audit round three, 14 Nov 2026 —
   * low): with `redirect: "follow"`, a CallerDesk link that redirected anywhere — another host, an address inside our
   * own network — was fetched and its answer played back to the browser. A hop to anywhere but CallerDesk over https is
   * refused, and there are at most a few of them.
   */
  let upstream: Response | null = null;
  try {
    const range = request.headers.get("range");
    let at = source;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      const answer = await fetch(at, { headers: range ? { range } : {}, signal: AbortSignal.timeout(30_000), cache: "no-store", redirect: "manual" });
      if (answer.status < 300 || answer.status >= 400) {
        upstream = answer;
        break;
      }
      const next = answer.headers.get("location");
      void answer.body?.cancel();
      if (!next) break;
      const to = new URL(next, at);
      if (to.protocol !== "https:" || !ALLOWED_HOST.test(to.hostname)) return notFound();
      at = to;
    }
  } catch {
    return new Response("CallerDesk didn't send the recording. Try again in a minute.", { status: 502 });
  }
  if (!upstream) return new Response("CallerDesk didn't send the recording. Try again in a minute.", { status: 502 });
  if (!upstream.ok || !upstream.body) return new Response("CallerDesk no longer has this recording.", { status: upstream.status === 404 ? 404 : 502 });

  const type = upstream.headers.get("content-type") ?? "";
  const headers: Record<string, string> = {
    "content-type": type.startsWith("audio/") ? type : "audio/wav",
    "accept-ranges": upstream.headers.get("accept-ranges") ?? "bytes",
    "x-content-type-options": "nosniff",
    "content-security-policy": "sandbox; default-src 'none'; media-src 'self'",
    "cache-control": "private, no-store",
  };
  for (const name of ["content-length", "content-range"]) {
    const value = upstream.headers.get(name);
    if (value) headers[name] = value;
  }
  return new Response(upstream.body, { status: upstream.status, headers });
}
