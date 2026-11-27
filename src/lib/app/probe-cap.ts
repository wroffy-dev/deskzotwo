/**
 * Security audit round two, 13 Nov 2026 (R2-11): a phone may ask who a number is (caller ID, call sync), and the
 * answer says whether the number is a customer's. For somebody who sees contacts' phones masked, that is a way to
 * recover a masked number: send guesses ending in the four digits shown until one matches. Real calls are a few
 * hundred different numbers a day at most, and most guesses miss, so the numbers that matched nobody are counted —
 * per phone, per day (UTC) — and once a phone has asked about UNMATCHED_NUMBERS_PER_DAY of them it gets no more
 * answers that day, matched or not (refusing only the misses would itself say which guesses hit).
 *
 * Only for people who see phones masked or restricted: anybody else can read the numbers anyway. Counted in memory,
 * as src/lib/security/caller-budget.ts is — a restart forgets the day's count, and each web process keeps its own, so
 * the real ceiling is this times the processes. No table records lookups, and a schema change wasn't wanted for this.
 */

export const UNMATCHED_NUMBERS_PER_DAY = 300;

const MAX_TRACKED = 20_000;
const byPhone = new Map<string, { day: string; keys: Set<string> }>();

const today = (now: number) => new Date(now).toISOString().slice(0, 10);

function entry(appDeviceId: string, now: number) {
  const day = today(now);
  const found = byPhone.get(appDeviceId);
  if (found && found.day === day) return found;
  if (!found && byPhone.size >= MAX_TRACKED) {
    // Yesterday's go first; still full, the oldest.
    for (const [id, e] of byPhone) if (e.day !== day) byPhone.delete(id);
    while (byPhone.size >= MAX_TRACKED) {
      const oldest = byPhone.keys().next().value;
      if (oldest === undefined) break;
      byPhone.delete(oldest);
    }
  }
  const fresh = { day, keys: new Set<string>() };
  byPhone.set(appDeviceId, fresh);
  return fresh;
}

/** Whether this phone has used up today's unmatched numbers. */
export function probeBudgetSpent(appDeviceId: string, now: number = Date.now()): boolean {
  return entry(appDeviceId, now).keys.size >= UNMATCHED_NUMBERS_PER_DAY;
}

/** Numbers (their ten-digit keys) this phone asked about that matched nobody it may see. A number counts once a day. */
export function noteUnmatched(appDeviceId: string, keys: string[], now: number = Date.now()): void {
  const e = entry(appDeviceId, now);
  for (const k of keys) e.keys.add(k);
}

/** Only for check scripts. */
export function resetProbeCaps(): void {
  byPhone.clear();
}
