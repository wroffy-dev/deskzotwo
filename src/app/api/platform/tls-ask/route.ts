import { NextResponse, type NextRequest } from "next/server";
import { certificateAllowed } from "@/lib/tenancy/certificates";
import { tlsAskAllowed } from "@/lib/platform/tls-ask-auth";

/**
 * The HTTPS proxy's question before it gets a certificate for a name (Caddy's `on_demand_tls ask`,
 * deploy/azure/Caddyfile):
 *
 *   GET /api/platform/tls-ask?domain=acme.deskzo.com   → 200: ours, go ahead · 404: not ours
 *
 * What counts as ours is src/lib/tenancy/certificates.ts. The proxy calls the app by its own address
 * inside the server, which is no platform host, so src/proxy.ts lets this one path through on any
 * host. Security audit round two, 13 Nov 2026 (R2-07): it answers only that internal call, or one
 * carrying TLS_ASK_SECRET (src/lib/platform/tls-ask-auth.ts); anybody else gets the same 404 as a
 * name that isn't ours, so it lists nothing.
 */
export async function GET(request: NextRequest) {
  if (!tlsAskAllowed({ headers: request.headers, host: request.nextUrl.host, key: request.nextUrl.searchParams.get("key") })) {
    return new NextResponse(null, { status: 404, headers: { "cache-control": "no-store" } });
  }
  const allowed = await certificateAllowed(request.nextUrl.searchParams.get("domain"));
  return new NextResponse(null, { status: allowed ? 200 : 404, headers: { "cache-control": "no-store" } });
}
