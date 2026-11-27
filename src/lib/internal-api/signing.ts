import { createHash, createHmac, timingSafeEqual } from "node:crypto";

/**
 * How the admin app signs a call to the CRM's internal API, and how the CRM checks it.
 *
 * The admin app (a separate codebase) carries a copy of this file; the two must stay byte-for-byte
 * the same in `canonical` and `sign`. Version 1:
 *
 *   x-deskzo-key        which secret signed it (DESKZO_INTERNAL_API_KEY_ID), so a secret can be rotated
 *   x-deskzo-ts         Unix milliseconds when it was signed
 *   x-deskzo-nonce      16+ random bytes, hex; never accepted twice
 *   x-deskzo-actor      base64url JSON of the acting staff member (src/lib/internal-api/actor.ts)
 *   x-deskzo-signature  hex HMAC-SHA256 of `canonical(...)` under the secret
 *
 * The signature covers the method, the path, the time, the nonce, the actor and a SHA-256 of the
 * body, so none of them can be changed or replayed without the secret. The secret is its own
 * (DESKZO_INTERNAL_API_SECRET, 32+ bytes): not PLATFORM_MASTER_KEY, which the admin app never holds.
 */
export const SIGNATURE_VERSION = "v1";
export const MAX_SKEW_MS = 60_000;

export type SignedHeaders = {
  "x-deskzo-key": string;
  "x-deskzo-ts": string;
  "x-deskzo-nonce": string;
  "x-deskzo-actor": string;
  "x-deskzo-signature": string;
};

export function bodyHash(body: string | Uint8Array): string {
  return createHash("sha256").update(typeof body === "string" ? Buffer.from(body, "utf8") : body).digest("hex");
}

export function canonical(input: { method: string; path: string; ts: string; nonce: string; actor: string; body: string | Uint8Array }): string {
  return [SIGNATURE_VERSION, input.method.toUpperCase(), input.path, input.ts, input.nonce, input.actor, bodyHash(input.body)].join("\n");
}

export function sign(secret: string, input: { method: string; path: string; ts: string; nonce: string; actor: string; body: string | Uint8Array }): string {
  return createHmac("sha256", secret).update(canonical(input), "utf8").digest("hex");
}

export function signaturesMatch(a: string, b: string): boolean {
  const x = Buffer.from(a, "utf8");
  const y = Buffer.from(b, "utf8");
  if (x.length !== y.length) return false;
  return timingSafeEqual(x, y);
}

/** The secrets this server accepts, by key id: the current one, and a previous one while rotating. */
export function acceptedSecrets(env: NodeJS.ProcessEnv = process.env): Map<string, string> {
  const out = new Map<string, string>();
  const add = (id: string | undefined, secret: string | undefined) => {
    const k = id?.trim();
    const s = secret?.trim();
    if (k && s && Buffer.byteLength(s, "utf8") >= 32) out.set(k, s);
  };
  add(env.DESKZO_INTERNAL_API_KEY_ID || "k1", env.DESKZO_INTERNAL_API_SECRET);
  add(env.DESKZO_INTERNAL_API_PREVIOUS_KEY_ID, env.DESKZO_INTERNAL_API_PREVIOUS_SECRET);
  return out;
}

/**
 * Nonces seen within the skew window, so a captured call can't be sent again. Per process: behind
 * several web processes (DESKZO_WEB_PROCESSES) the internal listener should run as one process, or
 * the window is what bounds a replay (docs/internal-api.md).
 */
const NONCES = Symbol.for("deskzo.internal-api.nonces");
type NonceHolder = { [NONCES]?: Map<string, number> };
const nonceHolder = globalThis as NonceHolder;

export function spendNonce(nonce: string, now: number = Date.now()): boolean {
  const seen = (nonceHolder[NONCES] ??= new Map());
  if (seen.size > 2000) for (const [n, at] of seen) if (now - at > MAX_SKEW_MS * 2) seen.delete(n);
  if (seen.has(nonce)) return false;
  seen.set(nonce, now);
  return true;
}
