import { NextResponse } from "next/server";
import { db } from "@/lib/db";
import { digestSecret } from "@/lib/crypto";
import { readTextWithin } from "@/lib/http/body";
import { notMigratedYet } from "@/lib/not-migrated";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { parseWebhookCall } from "@/lib/telephony/callerdesk";
import { recordCall } from "@/lib/telephony/ingest";
import { confirmFromList } from "@/lib/telephony/sync";

/**
 * CallerDesk's webhook (owner, 26 Oct 2026 — src/lib/telephony): a Live Call as a call starts, a Call Report
 * once it ends. Set on the business's CallerDesk dashboard (API & Integration › Webhooks) to the address
 * Settings › Cloud calling shows — this workspace's own host, with the connection's secret in the path.
 *
 * CallerDesk signs nothing, so the secret address is all a sender has, and even then a report is not believed:
 * it is kept, and the call logged only once CallerDesk's own call list has it — asked here at once, and on the
 * heartbeat if the list hasn't caught up. JSON, form fields or the same fields in the address all work, as
 * CallerDesk sends any of them. Anything unreadable is answered 200, so CallerDesk stops retrying it.
 */

const MAX_BODY = 64_000;

async function fieldsOf(request: Request): Promise<Record<string, unknown>> {
  const query = Object.fromEntries(new URL(request.url).searchParams);
  if (request.method !== "POST") return query;
  // Security audit, 11 Nov 2026 (SEC-27): read streamed and stopped at MAX_BODY; anything larger reads as nothing.
  const raw = (await readTextWithin(request, MAX_BODY)) ?? "";
  const type = request.headers.get("content-type") ?? "";
  try {
    if (type.includes("application/x-www-form-urlencoded")) return { ...query, ...Object.fromEntries(new URLSearchParams(raw)) };
    const body = raw.trim() ? (JSON.parse(raw) as unknown) : {};
    return body && typeof body === "object" && !Array.isArray(body) ? { ...query, ...(body as Record<string, unknown>) } : query;
  } catch {
    return query;
  }
}

async function handle(request: Request, token: string) {
  if (!/^[A-Za-z0-9_-]{24,100}$/.test(token)) return NextResponse.json({ ok: false }, { status: 404 });
  try {
    const connection = await db.telephonyConnection.findUnique({ where: { webhookTokenHash: await digestSecret(token) }, select: { id: true, active: true } });
    if (!connection?.active) return NextResponse.json({ ok: false }, { status: 404 });
    if (!(await moduleAvailableForTenant("calls"))) return NextResponse.json({ ok: true, ignored: "calls are off" });

    const call = parseWebhookCall(await fieldsOf(request));
    if (!call) return NextResponse.json({ ok: true, ignored: "not a call" });
    const kept = await recordCall(connection.id, call, "webhook");
    // Over: ask CallerDesk's list for it now, so it's logged while the caller is still at their desk.
    const logged = call.live ? null : await confirmFromList(connection.id, call).catch((err) => {
      console.error("callerdesk confirm failed", err);
      return null;
    });
    return NextResponse.json({ ok: true, state: kept.state, logged: !!(logged ?? kept.logged) });
  } catch (err) {
    if (notMigratedYet(err)) return NextResponse.json({ ok: true });
    console.error("callerdesk webhook failed", err);
    // A 500 has CallerDesk try again later, which is what's wanted when something here broke.
    return NextResponse.json({ ok: false }, { status: 500 });
  }
}

export async function POST(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return handle(request, (await params).token);
}

export async function GET(request: Request, { params }: { params: Promise<{ token: string }> }) {
  return handle(request, (await params).token);
}
