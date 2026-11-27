import { authenticator } from "otplib";
import QRCode from "qrcode";
import { broadcast, onBroadcast } from "@/lib/cluster/hub";

authenticator.options = { window: 1 };

export function generateTotpSecret() {
  return authenticator.generateSecret();
}

export function verifyTotpCode(secret: string, code: string): boolean {
  try {
    return authenticator.check(code.trim(), secret);
  } catch {
    return false;
  }
}

/**
 * A code checked once only. Security audit round two, 13 Nov 2026 (R2-16, low): with a window of one step
 * either side, a code seen over a shoulder or caught in a log worked again for ninety seconds. Now the
 * time step a code was accepted for is remembered per account (`who`, e.g. "staff:<id>"), and that step
 * or any earlier one is refused for that account after.
 *
 * In memory, as the lockout is (src/lib/security/lockout.ts): each acceptance is told to the container's
 * other web processes (src/lib/cluster/hub.ts). A restart forgets it, which reopens at most the ninety
 * seconds of the code then current. Bounded: entries older than the window are dropped as it fills.
 */
const STEP_MS = 30_000;
const USED_MAX = 10_000;
const used = (() => {
  const g = globalThis as { [key: symbol]: Map<string, number> | undefined };
  return (g[Symbol.for("deskzo.totp.used")] ??= new Map<string, number>());
})();

function rememberStep(who: string, step: number): void {
  const before = used.get(who);
  if (before !== undefined && before >= step) return;
  used.delete(who);
  if (used.size >= USED_MAX) {
    const stale = Math.floor(Date.now() / STEP_MS) - 2;
    for (const [key, value] of used) if (value < stale) used.delete(key);
    while (used.size >= USED_MAX) {
      const oldest = used.keys().next();
      if (oldest.done) break;
      used.delete(oldest.value);
    }
  }
  used.set(who, step);
}

onBroadcast("totp:used", (payload) => {
  const { who, step } = payload as { who: string; step: number };
  if (typeof who === "string" && typeof step === "number") rememberStep(who, step);
});

/** True, once, for a right code whose time step is later than the last one accepted for `who`. */
export function verifyTotpCodeOnce(who: string, secret: string, code: string, now: number = Date.now()): boolean {
  let delta: number | null;
  try {
    delta = authenticator.checkDelta(code.trim(), secret);
  } catch {
    return false;
  }
  if (delta === null) return false;
  const step = Math.floor(now / STEP_MS) + delta;
  const last = used.get(who);
  if (last !== undefined && step <= last) return false;
  rememberStep(who, step);
  broadcast("totp:used", { who, step });
  return true;
}

/** Only for the check script. */
export function forgetUsedTotpSteps(): void {
  used.clear();
}

export async function totpQrCodeDataUrl(email: string, secret: string) {
  const uri = authenticator.keyuri(email, "Deskzo One", secret);
  return QRCode.toDataURL(uri);
}
