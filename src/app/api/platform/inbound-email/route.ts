import { NextResponse } from "next/server";
import { onPlatformHost } from "@/lib/billing/platform-request";
import { readTextWithin } from "@/lib/http/body";
import { MAX_INBOUND_BYTES, receiveInbound } from "@/lib/support-mail/inbound";

/**
 * Tickets by email: every email for <workspace>@<INBOUND_MAIL_DOMAIN>, posted by the mail receiver and
 * signed with INBOUND_MAIL_SECRET — see src/lib/support-mail/inbound.ts. On the platform's own address
 * only; a workspace's address answers 404.
 */

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  if (!onPlatformHost(request)) return NextResponse.json({ ok: false }, { status: 404 });
  // The body exactly as sent: the signature is over these bytes. Security audit, 11 Nov 2026 (SEC-27): read
  // streamed and stopped at the ceiling, so a chunked request with no length can't make the process hold more.
  const body = await readTextWithin(request, MAX_INBOUND_BYTES);
  if (body === null) return NextResponse.json({ ok: false, error: "Too large." }, { status: 413 });
  try {
    const answer = await receiveInbound(body, request.headers);
    return NextResponse.json(answer.body, { status: answer.status, headers: { "cache-control": "no-store" } });
  } catch (err) {
    // Logged by its kind only: an email's contents never reach the log.
    console.error(`[inbound-email] failed: ${err instanceof Error ? err.name : "error"}`);
    return NextResponse.json({ ok: false, error: "Try again." }, { status: 500 });
  }
}
