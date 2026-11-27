/**
 * What the phone holds to send when it's back online (owner, 6 Nov 2026 — phase 2 of offline), as plain rules (check:pwa
 * holds them). Only what's safe to send late: adding a task, moving a task along, a call's notes. Not a visit's check-in:
 * it carries where and when as proof, which a late send would make untrue.
 */

export type Pending = { id: string; method: "POST" | "PATCH"; path: string; body: unknown; label: string; queuedAt: number };
export type Held = { pending: Pending[]; failed: { id: string; label: string; why: string }[] };

export const EMPTY: Held = { pending: [], failed: [] };
/** Held at most: a phone offline for weeks isn't a queue to replay unseen. */
export const MAX_PENDING = 100;

const SAFE = [/^POST \/api\/app\/tasks$/, /^PATCH \/api\/app\/tasks\/[^/?]+$/, /^PATCH \/api\/app\/calls\/[^/?]+$/];

/** Whether this action may wait to be sent. */
export function mayWait(method: string, path: string): boolean {
  return SAFE.some((rule) => rule.test(`${method} ${path}`));
}

/** What an attempt's outcome means: gone, try later (no connection, the server's own trouble), or never (it was refused). */
export function afterTry(outcome: { status: number } | "sent"): "sent" | "later" | "refused" {
  if (outcome === "sent") return "sent";
  return outcome.status === 0 || outcome.status >= 500 || outcome.status === 429 ? "later" : "refused";
}

/**
 * A later status for a task replaces one still waiting — done, then reopened, offline: only the last goes. Anything else
 * joins the end, in the order it was done.
 */
export function added(held: Held, item: Pending): Held {
  const rest = item.method === "PATCH" ? held.pending.filter((p) => !(p.method === "PATCH" && p.path === item.path)) : held.pending;
  return { ...held, pending: [...rest, item].slice(-MAX_PENDING) };
}

/** Read back from the file, or nothing if it's damaged. */
export function parseHeld(text: string): Held {
  try {
    const held = JSON.parse(text) as Partial<Held>;
    return { pending: Array.isArray(held.pending) ? held.pending : [], failed: Array.isArray(held.failed) ? held.failed : [] };
  } catch {
    return EMPTY;
  }
}

/** A task's status still waiting to go, over what the server last said. */
export function waitingStatus(held: Held, taskId: string): string | null {
  const item = held.pending.find((p) => p.method === "PATCH" && p.path === `/api/app/tasks/${taskId}`);
  const status = (item?.body as { status?: unknown } | undefined)?.status;
  return typeof status === "string" ? status : null;
}
