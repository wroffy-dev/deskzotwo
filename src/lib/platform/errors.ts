import { createHash } from "node:crypto";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { redactSecrets } from "@/lib/console-shared/redact";

/**
 * Server errors, kept on Deskzo's own server and grouped (owner, 30 Oct 2026: "start with alerts" —
 * docs: Deskzo at scale, Part 3). Every error Next catches while answering (src/instrumentation.ts
 * onRequestError) is counted under a fingerprint — its route and its message with the numbers, ids and
 * quoted values taken out — so a thousand of the same fault are one row with a count, and a fault never
 * seen before stands out. The console's alerts read it (`errorStats`): a new kind, and a spike.
 *
 * Nothing leaves the server: no outside error service is told. The message is its first line, secrets
 * redacted, cut to 300 characters; no request body, no headers, no stack.
 *
 * Recording must never hurt the request that failed: counts are gathered in memory and written a few
 * seconds later, a write that fails is said once a minute in the log and dropped.
 */

export type ServerError = {
  /** The workspace's log label, or "unknown". */
  tenant: string;
  method: string;
  path: string;
  routePath: string;
  routeType: string;
  message: string;
  digest: string | null;
};

/** Ten minutes: the step a spike is counted in. */
export const BUCKET_MS = 10 * 60_000;
const FLUSH_MS = 5_000;
const MAX_PENDING = 500;

/** A message as a kind of fault: numbers, ids, hashes, quoted values and addresses made one shape. */
export function normaliseMessage(message: string): string {
  return message
    .split("\n")[0]!
    .replace(/(["'`])(?:(?!\1).){0,200}\1/g, "$1…$1")
    .replace(/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, "<uuid>")
    .replace(/\bc[a-z0-9]{20,30}\b/g, "<id>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, "<email>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export function fingerprintOf(e: Pick<ServerError, "routeType" | "routePath" | "message">): string {
  return createHash("sha256").update(`${e.routeType}|${e.routePath}|${normaliseMessage(e.message)}`).digest("hex").slice(0, 32);
}

export const bucketOf = (at: Date) => new Date(Math.floor(at.getTime() / BUCKET_MS) * BUCKET_MS);

type Pending = { first: ServerError; last: ServerError; count: number; at: Date };
const pending = new Map<string, Pending>();
let timer: ReturnType<typeof setTimeout> | null = null;
let lastFailure = 0;

/** Counts one error, written within a few seconds. Never throws. */
export function recordServerError(e: ServerError, at = new Date()): void {
  try {
    if (!controlConfigured()) return;
    const fp = fingerprintOf(e);
    const row = pending.get(fp);
    if (row) {
      row.count += 1;
      row.last = e;
      row.at = at;
    } else if (pending.size < MAX_PENDING) {
      pending.set(fp, { first: e, last: e, count: 1, at });
    }
    if (!timer) {
      timer = setTimeout(() => {
        timer = null;
        void flushServerErrors();
      }, FLUSH_MS);
      timer.unref?.();
    }
  } catch {
    // Counting an error is never allowed to become one.
  }
}

/** Writes what has been counted. Exported for the checks; the timer calls it otherwise. */
export async function flushServerErrors(): Promise<void> {
  const rows = [...pending.entries()];
  pending.clear();
  for (const [fp, p] of rows) {
    try {
      const message = (redactSecrets(p.first.message.split("\n")[0]) ?? "").slice(0, 300);
      const last = { lastSeen: p.at, lastTenant: p.last.tenant.slice(0, 64), lastPath: p.last.path.slice(0, 300), lastDigest: p.last.digest?.slice(0, 64) ?? null };
      await controlDb().platformError.upsert({
        where: { fingerprint: fp },
        create: { fingerprint: fp, routeType: p.first.routeType.slice(0, 40), route: p.first.routePath.slice(0, 300), method: p.first.method.slice(0, 10), message, count: p.count, firstSeen: p.at, ...last },
        update: { count: { increment: p.count }, ...last },
      });
      const bucket = bucketOf(p.at);
      await controlDb().platformErrorBucket.upsert({
        where: { fingerprint_bucket: { fingerprint: fp, bucket } },
        create: { fingerprint: fp, bucket, count: p.count },
        update: { count: { increment: p.count } },
      });
    } catch (err) {
      if (Date.now() - lastFailure > 60_000) {
        lastFailure = Date.now();
        console.error(`[errors] could not record a server error: ${redactSecrets(err instanceof Error ? err.message : String(err))}`);
      }
    }
  }
}

/** A spike: this many errors of any kind in the last twenty minutes. Above `CRITICAL`, it's critical. */
export const SPIKE = { errors: 20, critical: 100, windowMs: 2 * BUCKET_MS } as const;
/** An error first seen in the last day is new; the alert names it until somebody acknowledges it. */
export const NEW_FOR_MS = 24 * 60 * 60_000;

export type ErrorStats = {
  recent: number;
  topRecent: { fingerprint: string; route: string; message: string; count: number }[];
  fresh: { fingerprint: string; route: string; method: string; message: string; count: number; firstSeen: Date; lastTenant: string | null }[];
};

/** What the alerts read: errors in the spike window, the worst of them, and the kinds first seen in the last day. */
export async function errorStats(now = new Date()): Promise<ErrorStats> {
  const db = controlDb();
  const since = new Date(bucketOf(now).getTime() - SPIKE.windowMs + BUCKET_MS);
  const buckets = await db.platformErrorBucket.groupBy({ by: ["fingerprint"], where: { bucket: { gte: since } }, _sum: { count: true } });
  const recent = buckets.reduce((n, b) => n + (b._sum.count ?? 0), 0);
  const worst = buckets.sort((a, b) => (b._sum.count ?? 0) - (a._sum.count ?? 0)).slice(0, 3);
  const named = new Map((await db.platformError.findMany({ where: { fingerprint: { in: worst.map((w) => w.fingerprint) } }, select: { fingerprint: true, route: true, message: true } })).map((e) => [e.fingerprint, e]));
  const fresh = await db.platformError.findMany({
    where: { firstSeen: { gte: new Date(now.getTime() - NEW_FOR_MS) } },
    orderBy: { firstSeen: "desc" },
    take: 20,
    select: { fingerprint: true, route: true, method: true, message: true, count: true, firstSeen: true, lastTenant: true },
  });
  return {
    recent,
    topRecent: worst.map((w) => ({ fingerprint: w.fingerprint, route: named.get(w.fingerprint)?.route ?? "", message: named.get(w.fingerprint)?.message ?? "", count: w._sum.count ?? 0 })),
    fresh,
  };
}

/** The newest errors, for the console's Errors list. */
export async function listErrors(take = 100) {
  return controlDb().platformError.findMany({ orderBy: { lastSeen: "desc" }, take: Math.min(Math.max(take, 1), 500) });
}

/** Counts a week old go, and kinds not seen for 90 days — run with the platform tick's daily chores. */
export async function purgeErrors(now = new Date()): Promise<{ buckets: number; errors: number }> {
  const db = controlDb();
  const buckets = await db.platformErrorBucket.deleteMany({ where: { bucket: { lt: new Date(now.getTime() - 7 * 86_400_000) } } });
  const errors = await db.platformError.deleteMany({ where: { lastSeen: { lt: new Date(now.getTime() - 90 * 86_400_000) } } });
  return { buckets: buckets.count, errors: errors.count };
}
