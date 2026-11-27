import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { clearAccessCache } from "@/lib/access/gate";

/**
 * Ends every way a person is signed in, bar the one they are using now.
 *
 * Security audit, 11 Nov 2026 (SEC-22, SEC-25, SEC-26): a password reset ended the browser and phone sign-ins
 * (their SignIn rows — the access gate and /api/app both refuse an ended one), but changing one's own password or
 * two-factor ended nothing, an API key made with a stolen session outlived every one of them, and a phone signed
 * out that way kept its push address. This is the one place that does all of it, so each path that ends a
 * person's sign-ins ends the same things:
 *
 *   - their SignIn rows, except `keepSid` (the session that made the change stays signed in);
 *   - their API keys, unless `keepApiKeys` — a key is a sign-in that never expires on its own;
 *   - the push addresses of their phones, whose sign-in rows just ended.
 *
 * Takes a transaction client so it can join the write that made it necessary. Server-only and deliberately not
 * a "use server" module.
 */
export async function endSignInsFor(
  userId: string,
  options: { keepSid?: string | null; byId?: string | null; keepApiKeys?: boolean; now?: Date; tx?: Prisma.TransactionClient } = {},
): Promise<{ signIns: number; apiKeys: number; phones: number }> {
  const client = options.tx ?? db;
  const now = options.now ?? new Date();
  const keep = options.keepSid ?? null;
  const ended = await client.signIn.updateMany({
    where: { userId, endedAt: null, ...(keep ? { NOT: { sid: keep } } : {}) },
    data: { endedAt: now, endedById: options.byId ?? null },
  });
  const keys = options.keepApiKeys
    ? { count: 0 }
    : await client.apiKey.updateMany({ where: { userId, revokedAt: null }, data: { revokedAt: now, revokedById: options.byId ?? null } });
  // Every phone of theirs: a phone's own sign-in is never the browser session kept above.
  const phones = await client.appDevice.updateMany({ where: { userId, pushToken: { not: null } }, data: { pushToken: null } });
  // The access gate keeps its verdicts 20 seconds; inside a transaction the caller clears them once it commits.
  if (!options.tx) clearAccessCache();
  return { signIns: ended.count, apiKeys: keys.count, phones: phones.count };
}
