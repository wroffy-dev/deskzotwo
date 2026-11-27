import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { ApiError } from "@/lib/api/handler";

/**
 * A create from the phone app happening once (owner, 6 Nov 2026). The phone's outbox (mobile/src/lib/outbox.ts) sends what
 * was done offline with a key of its own, and may send it again if an answer was lost. Keys belong to their person; a day
 * is longer than any retry. No key, or a workspace not migrated yet: it simply goes ahead, as it did before.
 */

const KEEP_MS = 24 * 60 * 60 * 1000;
const STALE_MS = 60 * 1000;

export type OnceClaim = { done: false; key: string | null } | { done: true; recordId: string; key: string };

export async function claimOnce(userId: string, raw: string | null): Promise<OnceClaim> {
  const given = raw?.trim();
  if (!given || given.length < 8 || given.length > 100) return { done: false, key: null };
  const key = `${userId}:${given}`;
  try {
    await db.appOnceKey.deleteMany({ where: { createdAt: { lt: new Date(Date.now() - KEEP_MS) } } });
    await db.appOnceKey.create({ data: { key } });
    return { done: false, key };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const before = await db.appOnceKey.findUnique({ where: { key }, select: { recordId: true, createdAt: true } });
      if (before?.recordId) return { done: true, recordId: before.recordId, key };
      // Claimed and not finished. Still going: try again shortly. Long past it, that try died before making anything.
      if (before && Date.now() - before.createdAt.getTime() < STALE_MS) throw new ApiError(503, "in_progress", "That's still being saved.");
      await db.appOnceKey.deleteMany({ where: { key, recordId: null } });
      await db.appOnceKey.create({ data: { key } });
      return { done: false, key };
    }
    if (notMigratedYet(err)) return { done: false, key: null };
    throw err;
  }
}

export async function finishOnce(key: string | null, recordId: string): Promise<void> {
  if (key) await db.appOnceKey.update({ where: { key }, data: { recordId } }).catch(() => undefined);
}

/** It was refused, so it wasn't made: another try may make it. */
export async function releaseOnce(key: string | null): Promise<void> {
  if (key) await db.appOnceKey.delete({ where: { key } }).catch(() => undefined);
}
