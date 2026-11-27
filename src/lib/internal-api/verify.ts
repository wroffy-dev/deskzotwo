import { NextResponse } from "next/server";
import type { StaffRole } from "@deskzo/control-client";
import { ALL_ROLES } from "@/lib/console-shared/roles";
import type { InternalActor } from "@/lib/internal-api/actor";
import { internalApiReachable } from "@/lib/internal-api/gate";
import { MAX_SKEW_MS, acceptedSecrets, sign, signaturesMatch, spendNonce } from "@/lib/internal-api/signing";
import { controlDb } from "@/lib/platform/control-db";
import { requestHost } from "@/lib/tenancy/host";

/**
 * What every internal API route checks before it does anything: where the call came (gate.ts), its
 * signature over method, path, time, nonce, actor and body (signing.ts), a nonce never seen before,
 * and a well-formed staff member. Then the CRM's shadow row for that staff member.
 */

export const plain = (status: number, error: string) => NextResponse.json({ ok: false, error }, { status, headers: { "cache-control": "no-store" } });

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
 * The control plane keeps a row for every staff member it has heard of, so what points at staff (support
 * requests assigned, entries written, names in the audit log) still holds. A shadow: no password, no
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

/**
 * The checked actor, or the response to send instead. `signedPath` is what the signature covers as the
 * path: the route's own path, plus for the HTTP bridge the target it asks for.
 */
export async function verifyInternalCall(request: Request, body: Buffer | string, signedPath: string): Promise<InternalActor | Response> {
  const host = requestHost(request.headers);
  if (typeof host !== "string" || !internalApiReachable(host, request.headers)) return plain(404, "Not found.");
  const keyId = request.headers.get("x-deskzo-key") ?? "";
  const ts = request.headers.get("x-deskzo-ts") ?? "";
  const nonce = request.headers.get("x-deskzo-nonce") ?? "";
  const actorRaw = request.headers.get("x-deskzo-actor") ?? "";
  const signature = request.headers.get("x-deskzo-signature") ?? "";
  const secret = acceptedSecrets().get(keyId);
  const at = Number(ts);
  if (!secret || !/^[0-9a-f]{32,128}$/.test(nonce) || !Number.isFinite(at) || Math.abs(Date.now() - at) > MAX_SKEW_MS || !/^[0-9a-f]{64}$/.test(signature)) {
    return plain(401, "Not signed.");
  }
  const expected = sign(secret, { method: request.method, path: signedPath, ts, nonce, actor: actorRaw, body });
  if (!signaturesMatch(expected, signature)) return plain(401, "Not signed.");
  if (!spendNonce(nonce)) return plain(401, "Already used.");
  const actor = parseActor(actorRaw);
  if (!actor) return plain(401, "No staff member.");
  await shadowStaff(actor);
  return actor;
}
