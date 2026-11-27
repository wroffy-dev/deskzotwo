import { NextResponse } from "next/server";
import { decode, encode } from "@/lib/internal-api/codec";
import { runAsInternalActor } from "@/lib/internal-api/actor";
import { OPS } from "@/lib/internal-api/ops";
import { plain, verifyInternalCall } from "@/lib/internal-api/verify";
import { consoleRefusal } from "@/lib/platform/console-guard";

/**
 * The CRM's internal API: the one way the admin app (its own codebase, VM, domain and database)
 * controls the CRM. Server to server only; see src/lib/internal-api/gate.ts for where it answers and
 * docs/internal-api.md for the whole picture.
 *
 *   POST /api/internal/v1/rpc   { "op": "console.consoleSuspend", "args": [...] }   (codec-encoded)
 *   →    200 { "ok": true, "data": ... }          what the action or loader returned (codec-encoded)
 *        200 { "ok": false, "error": "..." }      a refusal, in the console's own words
 *        401 / 404 / 413 / 500                    plain JSON, nothing more
 *
 * Every call carries the acting staff member, signed. Inside it, the console's actions see that person
 * (src/lib/internal-api/actor.ts), so roles, step-up codes and the audit log work as they always did.
 */

export const dynamic = "force-dynamic";

const PATH = "/api/internal/v1/rpc";
const MAX_BODY = 8_000_000;

export async function POST(request: Request) {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY) return plain(413, "Too large.");
  const body = await request.text();
  if (body.length > MAX_BODY) return plain(413, "Too large.");

  const actor = await verifyInternalCall(request, body, PATH);
  if (actor instanceof Response) return actor;

  let call: { op?: unknown; args?: unknown };
  try {
    call = JSON.parse(body) as typeof call;
  } catch {
    return plain(400, "Not JSON.");
  }
  const op = typeof call.op === "string" ? OPS.get(call.op) : undefined;
  if (!op) return plain(404, "No such operation.");
  const args = Array.isArray(call.args) ? (decode(call.args) as unknown[]) : [];

  if (op.kind === "loader" && !op.roles.includes(actor.role)) {
    return NextResponse.json({ ok: false, error: "Your role cannot see that." }, { headers: { "cache-control": "no-store" } });
  }

  try {
    const data = await runAsInternalActor(actor, () => (op.fn as (...a: unknown[]) => Promise<unknown>)(...args));
    return NextResponse.json({ ok: true, data: encode(data) }, { headers: { "cache-control": "no-store" } });
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return NextResponse.json({ ok: false, error: refusal }, { headers: { "cache-control": "no-store" } });
    console.error(`[internal-api] ${String(call.op)} failed`, err);
    return plain(500, "Something went wrong.");
  }
}
