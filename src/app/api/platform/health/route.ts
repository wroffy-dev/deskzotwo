import { NextResponse } from "next/server";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { platformTick } from "@/lib/platform/health";
import { WORKER_STALE_MS, workerLastSeen } from "@/lib/platform/worker-heartbeat";

/**
 * For an outside uptime checker (owner, 30 Oct 2026 — docs: Deskzo at scale, Part 3): the one alarm that still rings
 * when Deskzo's own alerts can't, because the server, its database or its worker has stopped.
 *
 *   GET https://deskzo.com/api/platform/health   → 200 {"ok":true,…} · 503 {"ok":false,…}
 *
 * On the platform's own addresses only (src/proxy.ts PLATFORM_API). Open to anybody, so it says only yes or no per
 * check — no versions, no counts, no error text. Checks:
 *   · database — the platform's database answers;
 *   · worker   — the platform worker ran in the last five minutes (not judged until it has run once);
 *   · tick     — the platform tick is not overdue (as the console's System health judges it).
 */

export const dynamic = "force-dynamic";

async function check<T>(work: () => Promise<T>): Promise<T | null> {
  try {
    return await work();
  } catch {
    return null;
  }
}

export async function GET() {
  const now = new Date();
  if (!controlConfigured()) return NextResponse.json({ ok: true, checks: { database: "not used" } }, { headers: { "cache-control": "no-store" } });
  const database = (await check(() => controlDb().$queryRaw`select 1`)) !== null;
  const seen = database ? await check(() => workerLastSeen()) : null;
  const worker = !database ? false : !seen ? true : now.getTime() - seen.getTime() <= WORKER_STALE_MS;
  const tick = database ? ((await check(() => platformTick(now)))?.stale ?? true) === false : false;
  const ok = database && worker && tick;
  return NextResponse.json({ ok, checks: { database, worker, tick } }, { status: ok ? 200 : 503, headers: { "cache-control": "no-store" } });
}
