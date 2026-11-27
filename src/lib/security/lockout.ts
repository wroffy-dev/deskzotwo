/**
 * Counting failed credential guesses, and refusing to keep answering.
 *
 * ## What this is for
 *
 * `checkCredentials` answers "is this password right?" without creating a session, so the login
 * form can decide whether to show the authenticator step. Useful, and until now it was also an
 * unlimited, unlogged password oracle: an attacker could put a credential-stuffing list through it
 * at whatever rate the server would take, get a truthful answer every time, and leave no trace —
 * the security screen showed a quiet night. Worse, a correct password was confirmed **even for an
 * account with an authenticator enrolled**, so two-factor protected the session and not the
 * credential, and the attacker learned exactly which harvested password was worth a phishing or
 * SIM-swap step.
 *
 * ## The trade-off, stated
 *
 * State is in memory and does not survive a restart, the same trade-off `throttle` in this
 * directory already makes. The web processes of one container share it — each failure is told to the
 * others (src/lib/cluster/hub.ts) — so several processes still give an attacker one budget. Across
 * several *containers* behind a load balancer an attacker would get one budget per container, and a
 * deploy resets the counters. That is a real weakening and it is worth saying out loud — but a shared
 * store in the path of every sign-in is its own availability risk, and the alternative on offer was no
 * limit at all. If this ever runs as several containers, move the counter to Postgres or Redis rather
 * than raising the limit.
 *
 * ## Why it counts two keys
 *
 * Per account, so one person's password cannot be ground down; and per caller, so a list of
 * thousands of accounts tried once each is also stopped. Either tripping is enough to refuse.
 *
 * ## Per account *and caller*, then per account at a higher bar (security review, 15 Nov 2026 — RL-07)
 *
 * The per-account key used to lock at eight from everywhere, so anybody who knew a person's address could
 * keep them locked out for good. Now the eight are counted per (account + caller) — `perCallerLockKeys` —
 * and the account on its own is locked everywhere only at ACCOUNT_WIDE_MAX_FAILURES, which still stops a
 * guessing run spread over many addresses. A key can carry its own threshold (`{ key, max }`); a plain
 * string counts to MAX_FAILURES as it always has. With no known caller the account key alone counts to
 * eight, as before — the safe default.
 */

import { broadcast, onBroadcast } from "@/lib/cluster/hub";
import { callerKeyIp, groupKeyIps } from "@/lib/client-ip";

type Bucket = { failures: number; first: number; lockedUntil: number };

const buckets = new Map<string, Bucket>();

/** Bounds a pathological spread of keys. A real attack is a handful; this is for the ten-thousandth. */
const MAX_TRACKED = 20_000;

export const MAX_FAILURES = 8;
export const WINDOW_MS = 10 * 60 * 1000;
export const LOCKOUT_MS = 15 * 60 * 1000;
/** Failures across every caller that lock an account everywhere, when each caller is counted on its own. */
export const ACCOUNT_WIDE_MAX_FAILURES = 50;

/** A key counted to MAX_FAILURES, or one with a threshold of its own. */
export type LockKey = string | { key: string; max: number };

const keyOf = (k: LockKey): string => (typeof k === "string" ? k : k.key);
const maxOf = (k: LockKey): number =>
  typeof k === "string" || !Number.isFinite(k.max) || k.max < 1 ? MAX_FAILURES : Math.floor(k.max);

/**
 * The keys for one account's budget: `<scope>|caller:<ip>` at MAX_FAILURES, which is what a stranger can
 * spend, and `<scope>` across all callers at `wideMax`. No caller: `<scope>` alone at MAX_FAILURES.
 */
export function perCallerLockKeys(
  scope: string,
  caller: string | null | undefined,
  wideMax: number = ACCOUNT_WIDE_MAX_FAILURES,
): LockKey[] {
  return caller ? [`${scope}|caller:${caller}`, { key: scope, max: wideMax }] : [scope];
}

/**
 * Security audit round two, 13 Nov 2026 (R2-16): the map used to drop its oldest bucket once it held
 * MAX_TRACKED, locked or not, so a flood of made-up tries (30,000 invented addresses) erased a victim's
 * live lock. Now, when it is full:
 *
 *   1. buckets whose window has passed and that hold no live lock are swept;
 *   2. failing that, the oldest bucket without a live lock goes;
 *   3. a live lock is never dropped. If every bucket is locked, a per-account key (anything that isn't
 *      a `caller:` key) may still be tracked up to HARD_MAX, so a person's own account can always be
 *      locked; a new per-caller key is then counted but not kept — the flood itself is what loses.
 *
 * Sign-in is never refused for want of room: a key that can't be kept simply isn't counted.
 */
const HARD_MAX = MAX_TRACKED * 2;
/** Until when a full map is known to hold nothing evictable — so a flood doesn't rescan it on every try. */
let nothingEvictableUntil = 0;

const liveLock = (bucket: Bucket, now: number) => bucket.lockedUntil > now;
const perCaller = (key: string) => /caller:/.test(key);

/**
 * A per-caller key with an IPv6 address in it, reduced to the address's /64 (R2-16, src/lib/client-ip.ts
 * `callerKeyIp`) — so every caller building `<scope>|caller:<ip>` shares one bucket per subscriber.
 */
export function lockoutKey(key: string): string {
  const at = key.lastIndexOf("caller:");
  if (at !== -1) {
    const address = key.slice(at + "caller:".length);
    return address.includes(":") ? `${key.slice(0, at + "caller:".length)}${callerKeyIp(address)}` : key;
  }
  // Every other key with an address in it too (security review, 15 Nov 2026 — RL-04): "platform|signup:<ip>",
  // "<t>|api|<ip>", "<t>|app|<ip>", "iclock-miss|<ip>" were counted per full IPv6 address.
  return groupKeyIps(key);
}

function makeRoom(now: number): boolean {
  if (buckets.size < MAX_TRACKED) return true;
  if (now < nothingEvictableUntil) return false;
  for (const [key, bucket] of buckets) {
    if (!liveLock(bucket, now) && now - bucket.first >= WINDOW_MS) buckets.delete(key);
  }
  if (buckets.size < MAX_TRACKED) return true;
  let soonest = Infinity;
  for (const [key, bucket] of buckets) {
    if (!liveLock(bucket, now)) {
      buckets.delete(key);
      return true;
    }
    soonest = Math.min(soonest, bucket.lockedUntil);
  }
  nothingEvictableUntil = soonest;
  return false;
}

function bucketFor(key: string, now: number): Bucket {
  const existing = buckets.get(key);
  // A live lock outlasts its counting window (fifteen minutes against ten): it is kept, never restarted.
  if (existing && (now - existing.first < WINDOW_MS || liveLock(existing, now))) return existing;
  if (existing) buckets.delete(key);

  const fresh: Bucket = { failures: 0, first: now, lockedUntil: 0 };
  if (makeRoom(now) || (!perCaller(key) && buckets.size < HARD_MAX)) buckets.set(key, fresh);
  return fresh;
}

/** How many buckets are kept now — for check:audit-round2-platform. */
export function trackedLockouts(): number {
  return buckets.size;
}

export type LockoutState = { lockedOut: boolean; retryInSeconds: number; failures: number };

/** Whether any of these keys is currently locked out. Checked before the password is looked at. */
export function lockoutState(keys: LockKey[], now: number = Date.now()): LockoutState {
  let worst: LockoutState = { lockedOut: false, retryInSeconds: 0, failures: 0 };
  for (const key of keys) {
    const bucket = buckets.get(lockoutKey(keyOf(key)));
    if (!bucket) continue;
    if (bucket.lockedUntil > now) {
      const retryInSeconds = Math.ceil((bucket.lockedUntil - now) / 1000);
      if (retryInSeconds > worst.retryInSeconds) {
        worst = { lockedOut: true, retryInSeconds, failures: bucket.failures };
      }
    }
  }
  return worst;
}

/** Records a failure against every key, and locks them once the budget is spent. */
/**
 * With several web processes (src/lib/cluster/hub.ts) each counts every failure: one recorded here is
 * told to the rest, so eight wrong passwords lock the account whichever process each landed on — not
 * eight in each.
 */
onBroadcast("lockout:failure", (payload) => {
  const { keys, now } = payload as { keys: LockKey[]; now: number };
  countFailure(keys, now);
});
onBroadcast("lockout:clear", (payload) => clearFailuresHere(payload as LockKey[]));

export function recordFailure(keys: LockKey[], now: number = Date.now()): LockoutState {
  broadcast("lockout:failure", { keys, now });
  return countFailure(keys, now);
}

function countFailure(keys: LockKey[], now: number): LockoutState {
  let locked = false;
  let retryInSeconds = 0;
  let failures = 0;

  for (const key of keys) {
    const bucket = bucketFor(lockoutKey(keyOf(key)), now);
    bucket.failures += 1;
    failures = Math.max(failures, bucket.failures);
    if (bucket.failures >= maxOf(key)) {
      bucket.lockedUntil = now + LOCKOUT_MS;
      locked = true;
      retryInSeconds = Math.ceil(LOCKOUT_MS / 1000);
    }
  }

  return { lockedOut: locked, retryInSeconds, failures };
}

/**
 * Forgets the failures on a successful sign-in.
 *
 * Without this, somebody who mistypes their password seven times and then gets it right is still
 * one mistake away from a lockout for the rest of the window.
 */
export function clearFailures(keys: LockKey[]) {
  broadcast("lockout:clear", keys);
  clearFailuresHere(keys);
}

function clearFailuresHere(keys: LockKey[]) {
  for (const key of keys) buckets.delete(lockoutKey(keyOf(key)));
}

/**
 * Wrong authenticator codes at sign-in, counted per workspace and account under a key of their own (security audit,
 * 11 Nov 2026, SEC-21): the password check clears nothing, and only a complete sign-in clears this, so proving the
 * password again never buys more code guesses.
 */
export function twoFactorLockKey(workspace: string | null | undefined, address: string): string {
  return `${workspace}|totp:${address.trim().toLowerCase()}`;
}

/** Only for the check script — module state shared between tests is what makes them flaky. */
export function resetLockouts() {
  buckets.clear();
  nothingEvictableUntil = 0;
}
