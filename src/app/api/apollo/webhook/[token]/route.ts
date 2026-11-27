import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { digestSecret } from "@/lib/crypto";
import { readTextWithin } from "@/lib/http/body";
import { notMigratedYet } from "@/lib/not-migrated";
import { readPhoneWebhook } from "@/lib/apollo/client";
import { receiveMobiles, tellMobileFound } from "@/lib/apollo/server";

/**
 * Apollo's webhook (owner, 14 Nov 2026 — src/lib/apollo): the phones it found for people asked about with "and their
 * mobile", POSTed minutes after the lookup. Apollo signs nothing, so the secret in this address is all a sender has —
 * and even then a number is only taken for a person a lookup in this workspace is still WAITING on (receiveMobiles).
 * Anything unreadable is answered 200, so Apollo stops retrying it.
 */

const MAX_BODY = 256_000;

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  if (!/^[A-Za-z0-9_-]{24,100}$/.test(token)) return NextResponse.json({ ok: false }, { status: 404 });
  try {
    const connection = await db.apolloConnection.findUnique({ where: { webhookTokenHash: await digestSecret(token) }, select: { active: true } });
    if (!connection?.active) return NextResponse.json({ ok: false }, { status: 404 });
  } catch (err) {
    if (notMigratedYet(err)) return NextResponse.json({ ok: false }, { status: 404 });
    throw err;
  }
  const raw = (await readTextWithin(request, MAX_BODY)) ?? "";
  let body: unknown = {};
  try {
    body = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    return NextResponse.json({ ok: true });
  }
  const done = await receiveMobiles(readPhoneWebhook(body));
  for (const d of done) if (d.requestedById) await tellMobileFound(d.requestedById, d.contactId, d.number, d.filled);
  return NextResponse.json({ ok: true, received: done.length });
}
