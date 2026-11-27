import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { elementorKeyId, elementorTokenMatches, readElementorBody } from "@/lib/lead-capture/elementor";
import { receiveLead } from "@/lib/lead-capture/receive";

/**
 * The Elementor address (src/lib/lead-capture/elementor.ts): an Elementor form's Webhook action posts here, the key
 * in the address, and the enquiry is a lead as the lead capture API makes one — the same limits, the same intake.
 * A wrong, revoked or made-up address is 401, the same answer for each.
 */

export const dynamic = "force-dynamic";

const deny = () => NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401 });

async function keyFor(segment: string) {
  const keyId = elementorKeyId(segment);
  const key = keyId ? await db.leadCaptureKey.findUnique({ where: { keyId } }) : null;
  // The token is made and compared even for no such key, so a wrong ID and a wrong token take the same time.
  const ok = await elementorTokenMatches(segment, key ?? { keyId: keyId ?? "lck_", secretDigest: "x".repeat(44) });
  return key && ok && key.active && !key.revokedAt ? key : null;
}

/** Checks the address works, without creating anything. */
export async function GET(_request: Request, { params }: { params: Promise<{ token: string }> }) {
  const key = await keyFor((await params).token);
  return key ? NextResponse.json({ ok: true, key: key.name }) : deny();
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const key = await keyFor((await params).token);
  if (!key) return deny();
  const answer = await receiveLead(request, key, readElementorBody);
  // Elementor's Webhook action counts anything but exactly 200 as "Webhook error" (owner, 1 Nov 2026: the form showed
  // visitors an error for a lead made with 201). Accepted is 200 here, with the same body; the lead API keeps its 201/202.
  if (answer.status === 201 || answer.status === 202) return new NextResponse(answer.body, { status: 200, headers: answer.headers });
  return answer;
}
