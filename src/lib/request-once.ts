import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * One record per request (owner, 29 Oct 2026): a payment, a document or an expense saved twice — a double click, a
 * retry after an answer that never came, the form sent from two tabs — is the one it already made. The form sends one
 * `requestId` for all its tries (as the New lead form does — Lead.idempotencyKey, src/actions/lead.ts); the key is
 * scoped to its person, `<kind>:<user>:<token>`, and kept in `request_keys` (migration 20261129110000).
 *
 *   · **Claimed first**, before the write: the key is the table's primary key, so of two sends at once only one
 *     claims it. The other waits for the first to finish and answers with its record.
 *   · **Done** fills in the record the claim made; **release** lets the key go when the write fails, so the form,
 *     put right, can be sent again with it.
 *   · A request without a token, or a workspace not migrated yet, writes as before.
 */

const TOKEN = /^[A-Za-z0-9-]{8,100}$/;
const WAIT_MS = 6000;

export type Claim =
  | { kind: "new"; done: (recordId: string) => Promise<void>; release: () => Promise<void> }
  | { kind: "repeat"; recordId: string }
  | { kind: "busy"; error: string };

const free: Claim = { kind: "new", done: async () => {}, release: async () => {} };

/** The request's token from an action's input, or null. */
export function requestIdOf(input: unknown): string | null {
  const token = input && typeof input === "object" ? (input as { requestId?: unknown }).requestId : null;
  return typeof token === "string" && TOKEN.test(token) ? token : null;
}

export async function claimRequest(input: unknown, kind: string, userId: string): Promise<Claim> {
  const token = requestIdOf(input);
  if (!token) return free;
  const key = `${kind}:${userId}:${token}`;
  try {
    await db.requestKey.create({ data: { key, kind }, select: { key: true } });
  } catch (err) {
    if (notMigratedYet(err)) return free;
    if (!(err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002")) throw err;
    // Seen before: the record it made, once the first send has finished making it.
    for (const started = Date.now(); Date.now() - started < WAIT_MS; await new Promise((r) => setTimeout(r, 250))) {
      const held = await db.requestKey.findUnique({ where: { key }, select: { recordId: true } });
      if (!held) return claimRequest(input, kind, userId);
      if (held.recordId) return { kind: "repeat", recordId: held.recordId };
    }
    return { kind: "busy", error: "That's still being saved — refresh in a moment rather than sending it again." };
  }
  return {
    kind: "new",
    done: async (recordId) => {
      await db.requestKey.update({ where: { key }, data: { recordId } }).catch(() => undefined);
    },
    release: async () => {
      await db.requestKey.deleteMany({ where: { key, recordId: null } }).catch(() => undefined);
    },
  };
}
