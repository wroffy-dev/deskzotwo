import { NextResponse } from "next/server";
import type { StaffRole } from "@deskzo/control-client";
import { ALL_ROLES } from "@/lib/console-shared/roles";
import { decode, encode } from "@/lib/internal-api/codec";
import { runAsInternalActor, type InternalActor } from "@/lib/internal-api/actor";
import { internalApiReachable } from "@/lib/internal-api/gate";
import { OPS } from "@/lib/internal-api/ops";
import { MAX_SKEW_MS, acceptedSecrets, sign, signaturesMatch, spendNonce } from "@/lib/internal-api/signing";
import { consoleRefusal } from "@/lib/platform/console-guard";
import { controlDb } from "@/lib/platform/control-db";
import { requestHost } from "@/lib/tenancy/host";

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
const MAX_BODY = 1_000_000;

const plain = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } });

function parseActor(raw: string): InternalActor | null {
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Record<string, unknown>;
    const role = ALL_ROLES.find((r) => r === v.role) as StaffRole | undefined;
    const str = (x: unknown, max: number) => (typeof x === "string" && x.length > 0 && x.length <= max ? x : null);
    const id = str(v.id, 100);
    const email = str(v.email, 320);
    const name = str(v.name, 200);
    const sessionRef = str(v.sessionRef, 200) ?? "";
    if (!role || !id || !email || !name || !/^[A-Za-z0-9_-]+$/.test(id)) return null;
    const stepUpAt = typeof v.stepUpAt === "string" ? new Date(v.stepUpAt) : null;
    return { id, email: email.toLowerCase(), name, role, sessionRef, stepUpAt: stepUpAt && !Number.isNaN(stepUpAt.getTime()) ? stepUpAt : null };
  } catch {
    return null;
  }
}

/**
 * The control plane keeps a row for every staff member it has heard of, so what points at staff
 * (support requests assigned, entries written) still holds. It is a shadow: no password, no
 * authenticator, nothing to sign in with. The admin app is where the account lives.
 */
async function shadowStaff(actor: InternalActor): Promise<void> {
  const db = controlDb();
  const data = { name: actor.name, role: actor.role, active: true };
  try {
    await db.platformUser.upsert({ where: { id: actor.id }, create: { id: actor.id, email: actor.email, passwordHash: "!", ...data }, update: data, select: { id: true } });
  } catch {
    // The address belongs to an older console account: keep the shadow under a private one instead.
    await db.platformUser.upsert({ where: { id: actor.id }, create: { id: actor.id, email: `${actor.id}@admin.invalid`, passwordHash: "!", ...data }, update: data, select: { id: true } });
  }
}

export async function POST(request: Request) {
  // The proxy checked this already; checked again, because a route must not rely on one gate.
  const host = requestHost(request.headers);
  if (typeof host !== "string" || !internalApiReachable(host, request.headers)) return plain(404, "Not found.");

  const keyId = request.headers.get("x-deskzo-key") ?? "";
  const ts = request.headers.get("x-deskzo-ts") ?? "";
  const nonce = request.headers.get("x-deskzo-nonce") ?? "";
  const actorRaw = request.headers.get("x-deskzo-actor") ?? "";
  const signature = request.headers.get("x-deskzo-signature") ?? "";

  const length = Number(request.headers.get("content-length") ?? "0");
  if (length > MAX_BODY) return plain(413, "Too large.");
  const body = await request.text();
  if (body.length > MAX_BODY) return plain(413, "Too large.");

  const secret = acceptedSecrets().get(keyId);
  const at = Number(ts);
  if (!secret || !/^[0-9a-f]{32,128}$/.test(nonce) || !Number.isFinite(at) || Math.abs(Date.now() - at) > MAX_SKEW_MS || !/^[0-9a-f]{64}$/.test(signature)) {
    return plain(401, "Not signed.");
  }
  const expected = sign(secret, { method: "POST", path: PATH, ts, nonce, actor: actorRaw, body });
  if (!signaturesMatch(expected, signature)) return plain(401, "Not signed.");
  if (!spendNonce(nonce)) return plain(401, "Already used.");

  const actor = parseActor(actorRaw);
  if (!actor) return plain(401, "No staff member.");

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

  await shadowStaff(actor);

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
