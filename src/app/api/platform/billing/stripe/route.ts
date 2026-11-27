import { NextResponse } from "next/server";
import { onPlatformHost } from "@/lib/billing/platform-request";
import { receiveStripeWebhook } from "@/lib/billing/webhooks";
import { readTextWithin } from "@/lib/http/body";

/** Security audit round two, 13 Nov 2026 (low): a webhook body is read with a 1 MB ceiling before its signature is checked. */
const MAX_WEBHOOK_BYTES = 1_000_000;

/**
 * Stripe's webhook — set in Stripe's dashboard to https://admin.<domain>/api/platform/billing/stripe,
 * with its signing secret entered in the console. Signed, processed once, see src/lib/billing/webhooks.ts.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!onPlatformHost(request)) return new NextResponse("Not found.", { status: 404 });
  // The body exactly as sent: the signature is over these bytes, not over parsed JSON.
  const raw = await readTextWithin(request, MAX_WEBHOOK_BYTES);
  if (raw === null) return new NextResponse("Too large.", { status: 413 });
  const answer = await receiveStripeWebhook(raw, request.headers.get("stripe-signature"));
  return new NextResponse(answer.body, { status: answer.status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
