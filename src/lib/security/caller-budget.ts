/**
 * So many requests an hour from one caller, counted in memory — for public forms that have no database column to
 * count a caller's address by (security audit, 11 Nov 2026, SEC-35).
 *
 * The same trade-off as src/lib/security/lockout.ts: state is per process and a restart forgets it. The database
 * counts beside it (per typed address, per form) still stand; this only adds the one a script can't change by typing
 * a new email.
 */

import { groupKeyIps } from "@/lib/client-ip";

type Window = { count: number; since: number };

const windows = new Map<string, Window>();
const MAX_TRACKED = 20_000;

/**
 * Whether one more request fits every limit given — and if it does, it is counted against all of them. A request
 * refused by one limit is counted against none.
 */
export function withinCallerBudget(limits: { key: string; max: number }[], windowMs: number, now: number = Date.now()): boolean {
  // An IPv6 address in a key is counted by its /64 (security review, 15 Nov 2026 — RL-04; src/lib/client-ip.ts).
  const current = limits.map(({ key: raw, max }) => {
    const key = groupKeyIps(raw);
    const window = windows.get(key);
    return { key, max, window: window && now - window.since < windowMs ? window : null };
  });
  if (current.some(({ max, window }) => max <= 0 || (window && window.count >= max))) return false;
  const fresh = current.filter((c) => !c.window).length;
  if (fresh && windows.size + fresh > MAX_TRACKED) {
    for (const [key, window] of windows) if (now - window.since >= windowMs) windows.delete(key);
    // Still full: the oldest go, rather than every new caller being refused.
    while (windows.size + fresh > MAX_TRACKED) {
      const oldest = windows.keys().next().value;
      if (oldest === undefined) break;
      windows.delete(oldest);
    }
  }
  for (const c of current) {
    if (c.window) c.window.count += 1;
    else windows.set(c.key, { count: 1, since: now });
  }
  return true;
}

/** Only for check scripts. */
export function resetCallerBudgets() {
  windows.clear();
}
