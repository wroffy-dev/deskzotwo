import { NextResponse } from "next/server";
import { onPlatformHost } from "@/lib/billing/platform-request";
import { receiveRazorpayWebhook } from "@/lib/billing/webhooks";
import { readTextWithin } from "@/lib/http/body";

/** Security audit round two, 13 Nov 2026 (low): a webhook body is read with a 1 MB ceiling before its signature is checked. */
const MAX_WEBHOOK_BYTES = 1_000_000;

/**
 * Razorpay's webhook — set in Razorpay's dashboard to https://admin.<domain>/api/platform/billing/razorpay,
 * with its secret entered in the console. Signed, processed once, see src/lib/billing/webhooks.ts.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!onPlatformHost(request)) return new NextResponse("Not found.", { status: 404 });
  const raw = await readTextWithin(request, MAX_WEBHOOK_BYTES);
  if (raw === null) return new NextResponse("Too large.", { status: 413 });
  const answer = await receiveRazorpayWebhook(raw, request.headers.get("x-razorpay-signature"), request.headers.get("x-razorpay-event-id"));
  return new NextResponse(answer.body, { status: answer.status, headers: { "content-type": "text/plain; charset=utf-8" } });
}
