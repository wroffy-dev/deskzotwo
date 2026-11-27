import { getSetting, setSetting } from "@/lib/platform/settings";

/**
 * The platform worker's pulse (owner, 30 Oct 2026): each turn of its loop (scripts/platform-worker.ts) writes the
 * time, at most once a minute; the console's alerts and the uptime check (/api/platform/health) read it. A worker
 * that never ran leaves nothing — then nothing is said, as where no worker is set up yet.
 */

/** Past this, the worker is taken to have stopped. */
export const WORKER_STALE_MS = 5 * 60_000;
const WRITE_EVERY_MS = 60_000;

let lastWrite = 0;

export async function markWorkerAlive(now = new Date()): Promise<void> {
  if (now.getTime() - lastWrite < WRITE_EVERY_MS) return;
  lastWrite = now.getTime();
  await setSetting("worker.lastSeen", now.toISOString(), "worker");
}

export async function workerLastSeen(): Promise<Date | null> {
  const raw = await getSetting("worker.lastSeen");
  const at = raw ? new Date(raw) : null;
  return at && !Number.isNaN(at.getTime()) ? at : null;
}
