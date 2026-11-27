import { apiRoute } from "@/lib/api/handler";
import { createLeadApi, listLeadsApi } from "@/lib/api/v1/leads";
import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { parseBasicAuth, secretMatches } from "@/lib/lead-capture/credentials";
import { readApiBody, receiveLead } from "@/lib/lead-capture/receive";

/**
 * The lead capture API — POST a website enquiry, get a lead.
 *
 * Documented for website developers on Settings → Lead capture API (and as downloadable Markdown),
 * both generated from src/lib/lead-capture/spec.ts. Outside the proxy's matcher like every /api
 * route, so there is no session here: the key is the whole of the authentication.
 *
 * ## What is refused, and how
 *
 *   · No key, a wrong secret, a revoked key: 401, identical in every case and the same shape as
 *     for a key that never existed — so the endpoint cannot be used to find out which key IDs are
 *     real. The secret is compared as a digest, in constant time.
 *   · Over 64 KB, or not JSON or a form: 413 / 415, before anything is parsed.
 *   · More than 60 leads a minute from one key: 429 with Retry-After. A form being spammed, or a
 *     loop in somebody's code, is stopped at one key without affecting the other websites.
 *
 * Never refused for one of the workspace's own fields: a value that can't be used is set aside and
 * listed in the 201's `not_saved` (src/lib/lead-capture/intake.ts).
 *
 * No CORS headers are sent, on purpose: a browser will not make this call, so a secret pasted into
 * page JavaScript fails straight away instead of being quietly exposed to every visitor.
 */

export const dynamic = "force-dynamic";

/**
 * The same address is the public API's lead list and create (owner, 17 Oct 2026 — src/lib/api): a call
 * with a Bearer API key (`dzk_….dzs_…`) goes there; Basic, a website's capture key, stays here.
 */
const apiLeads = { GET: apiRoute({ scope: "leads:read" }, listLeadsApi), POST: apiRoute({ scope: "leads:write" }, createLeadApi) };
const bearer = (request: Request) => /^bearer\s/i.test(request.headers.get("authorization") ?? "");

const deny = () => NextResponse.json({ ok: false, error: "Unauthorized" }, { status: 401, headers: { "WWW-Authenticate": 'Basic realm="Deskzo One lead capture"' } });

async function authenticate(request: Request) {
  const credentials = parseBasicAuth(request.headers.get("authorization"));
  if (!credentials) return null;
  const key = await db.leadCaptureKey.findUnique({ where: { keyId: credentials.keyId } });
  // The digest is computed even when there is no such key, so a wrong ID and a wrong secret take
  // the same time — a timing difference would tell a caller which key IDs exist.
  const ok = await secretMatches(credentials.secret, key?.secretDigest ?? "x".repeat(44));
  if (!key || !ok || !key.active || key.revokedAt) return null;
  return key;
}

/** Checks a key works, without creating anything. */
export async function GET(request: Request) {
  if (bearer(request)) return apiLeads.GET(request);
  const key = await authenticate(request);
  if (!key) return deny();
  return NextResponse.json({ ok: true, key: key.name });
}

export async function POST(request: Request) {
  if (bearer(request)) return apiLeads.POST(request);
  const key = await authenticate(request);
  if (!key) return deny();

  return receiveLead(request, key, readApiBody);
}
