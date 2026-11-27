import { createHash, timingSafeEqual } from "node:crypto";
import { withinCallerBudget } from "@/lib/security/caller-budget";

/**
 * Security audit round two, 13 Nov 2026 (R2-13): publishing a phone app update rested on one thing — the update key
 * file on the publishing computer — and told nobody. Now, before a byte of the update is read:
 *
 *   · a second factor: the publisher secret, `x-deskzo-publisher-secret`, matching APP_UPDATES_PUBLISH_SECRET on the
 *     server (compared in constant time). Kept apart from the key — in the environment or ~/.deskzo/app-updates/
 *     publisher-secret on the publishing computer (scripts/app-update.ts) — so a copied key file alone publishes
 *     nothing. Unset on a production server, publishing is refused outright; on a development server it isn't asked.
 *   · so many tries an hour from one address (PUBLISH_TRIES_PER_HOUR), so the secret can't be guessed at speed.
 *
 * And after: every publish is emailed to the platform's owners (src/app/api/app-updates/publish/route.ts).
 */

export const PUBLISHER_SECRET_HEADER = "x-deskzo-publisher-secret";
export const PUBLISH_TRIES_PER_HOUR = 20;
/** Every caller with no address known shares one budget — wider, as it may be several honest people. */
const UNKNOWN_ADDRESS_TRIES_PER_HOUR = 60;

const digestOf = (value: string) => createHash("sha256").update(value, "utf8").digest();

export type PublishRefusal = { status: number; error: string; headers?: Record<string, string> };

/** Whether one more publish from this address fits the hour. Counted whether or not it then succeeds. */
export function publishRateRefusal(ip: string | null): PublishRefusal | null {
  const key = ip ? `app-updates:publish:${ip}` : "app-updates:publish:unknown";
  const max = ip ? PUBLISH_TRIES_PER_HOUR : UNKNOWN_ADDRESS_TRIES_PER_HOUR;
  return withinCallerBudget([{ key, max }], 3_600_000) ? null : { status: 429, error: "Too many publishing tries from this address — wait an hour.", headers: { "retry-after": "3600" } };
}

/** The publisher secret's check: null when it is right (or not asked for on a development server). */
export function publisherSecretRefusal(headers: Pick<Headers, "get">, env: Record<string, string | undefined> = process.env): PublishRefusal | null {
  const expected = env.APP_UPDATES_PUBLISH_SECRET?.trim() ?? "";
  if (!expected) {
    if (env.NODE_ENV === "production") return { status: 503, error: "Publishing app updates is switched off on this server until APP_UPDATES_PUBLISH_SECRET is set." };
    return null;
  }
  const sent = headers.get(PUBLISHER_SECRET_HEADER)?.trim() ?? "";
  // Both hashed first, so the comparison is the same length and takes the same time whatever was sent.
  const ok = sent.length > 0 && timingSafeEqual(digestOf(sent), digestOf(expected));
  return ok ? null : { status: 401, error: "The publisher secret is missing or wrong." };
}
