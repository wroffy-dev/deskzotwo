import { assetLinksResponse } from "@/lib/app/asset-links";

/**
 * /.well-known/assetlinks.json, rewritten here by next.config.ts (security audit round two, 13 Nov 2026, R2-12): Android's check that Deskzo's own app
 * may open https://deskzo.com/app-return/… — src/lib/app/asset-links.ts. 404 until the app's certificate fingerprints
 * are set. Read by Google's verifier with no session, so the proxy must let it through untouched.
 */

export const dynamic = "force-dynamic";

export function GET(): Response {
  return assetLinksResponse();
}
