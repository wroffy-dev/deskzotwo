import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { verifyTotpCode } from "@/lib/totp";
import { logActivity } from "@/lib/activity";
import { auth } from "@/lib/auth";
import { providerOfSignIn } from "@/lib/workplace/providers";
import { clearFailures, lockoutState, recordFailure } from "@/lib/security/lockout";
import { tenantKey } from "@/lib/tenancy/cache";

/**
 * "Is this really you?" before something that can't be taken back — restoring a backup over the
 * workspace, resetting it (owner, 22 Oct 2026). The person types their own password again, and their
 * two-factor code when they have two-factor on: a session left open on somebody's desk, or a stolen
 * cookie, is then not enough to wipe a company's records.
 *
 * Their own password rather than a password on each backup: a nightly backup has nobody to set one,
 * and a backup whose password is forgotten is a backup nobody can restore.
 *
 * Every failure is logged, and each answer says only what to fix — not whether the account exists,
 * which the caller already knows, nor anything about the secret.
 */
export type IdentityProof = { password?: unknown; code?: unknown };

/**
 * How long signing in again with Microsoft, Google or Zoho counts, for an account that may have no password to type
 * (owner, 4 Nov 2026). Opening a stored password asks every time, so that's barely long enough to come back and click;
 * a restore or a reset has a file to upload and a phrase to type first, and a two-factor code still after it.
 */
export const OPEN_SECRET_CONFIRM_MS = 2 * 60_000;
export const ACT_CONFIRM_MS = 15 * 60_000;

/**
 * Whether this very session is a Microsoft, Google or Zoho sign-in by this person, made in the last `withinMs`. By this
 * person: while viewing as somebody, the session is the viewer's, and their sign-in proves nothing about the other.
 */
export async function justConfirmedWithProvider(userId: string, withinMs: number): Promise<boolean> {
  const sid = await auth()
    .then((session) => session?.user?.sid ?? null)
    .catch(() => null);
  if (!sid) return false;
  const row = await db.signIn.findUnique({ where: { sid }, select: { userId: true, provider: true, at: true, endedAt: true } });
  return !!row && row.userId === userId && !row.endedAt && !!providerOfSignIn(row.provider) && Date.now() - row.at.getTime() < withinMs;
}

/**
 * The lockout key for confirming it's you — per person and workspace (security audit, 11 Nov 2026, SEC-23). Shared
 * with Profile's own password and two-factor changes (src/actions/profile.ts), which ask the same question.
 */
export async function confirmLockKey(userId: string): Promise<string> {
  return `${await tenantKey()}|confirm:${userId}`;
}

export const CONFIRM_LOCKED = (seconds: number) => `Too many wrong tries. You've been signed out; try again in ${Math.max(1, Math.ceil(seconds / 60))} minutes.`;

/**
 * One wrong password or code while confirming it's you: counted, and once the budget is spent the session that
 * guessed is ended (its SignIn row — the access gate signs it out on its next request). A stolen session can't then
 * keep guessing the password it doesn't know (security audit, 11 Nov 2026, SEC-23). Returns the refusal to give
 * when that just locked it, or null.
 */
export async function countConfirmFailure(userId: string): Promise<string | null> {
  const after = recordFailure([await confirmLockKey(userId)]);
  if (!after.lockedOut) return null;
  const sid = await auth()
    .then((session) => (session?.user?.id === userId ? session.user.sid ?? null : null))
    .catch(() => null);
  if (sid) await db.signIn.updateMany({ where: { sid, userId, endedAt: null }, data: { endedAt: new Date() } }).catch(() => {});
  await logActivity({ kind: "RATE_LIMITED", severity: "WARNING", userId, summary: `Confirming it's them locked out after ${after.failures} wrong tries — the session was ended`, metadata: { failures: after.failures } }).catch(() => {});
  return CONFIRM_LOCKED(after.retryInSeconds);
}

/** The refusal while locked out, or null. */
export async function confirmLocked(userId: string): Promise<string | null> {
  const locked = lockoutState([await confirmLockKey(userId)]);
  return locked.lockedOut ? CONFIRM_LOCKED(locked.retryInSeconds) : null;
}

export async function confirmIdentity(userId: string, proof: IdentityProof, what: string): Promise<{ ok: true } | { ok: false; error: string; needsCode?: boolean }> {
  const password = typeof proof.password === "string" ? proof.password : "";
  const code = typeof proof.code === "string" ? proof.code.replace(/\s+/g, "") : "";
  const user = await db.user.findUnique({ where: { id: userId }, select: { id: true, name: true, passwordHash: true, active: true, twoFactorEnabledAt: true, twoFactorSecretCipher: true } });
  if (!user?.active) return { ok: false, error: "Your account can't do this." };
  // Security audit, 11 Nov 2026 (SEC-23): a limit on guesses, checked before either secret is looked at.
  const locked = await confirmLocked(userId);
  if (locked) return { ok: false, error: locked };
  const confirmed = !password && (await justConfirmedWithProvider(userId, ACT_CONFIRM_MS));
  if (!confirmed) {
    if (!password) return { ok: false, error: "Type your password to confirm it's you." };
    if (!(await bcrypt.compare(password, user.passwordHash))) {
      await logActivity({ kind: "PERMISSION_DENIED", severity: "WARNING", summary: `${user.name} typed a wrong password confirming ${what}`, metadata: { what } });
      return { ok: false, error: (await countConfirmFailure(userId)) ?? "That password isn't right." };
    }
  }
  if (user.twoFactorEnabledAt && user.twoFactorSecretCipher) {
    if (!code) return { ok: false, error: "Type the 6-digit code from your authenticator app as well.", needsCode: true };
    if (!verifyTotpCode(await decryptSecret(user.twoFactorSecretCipher), code)) {
      await logActivity({ kind: "PERMISSION_DENIED", severity: "WARNING", summary: `${user.name} typed a wrong two-factor code confirming ${what}`, metadata: { what } });
      const lockedNow = await countConfirmFailure(userId);
      return lockedNow ? { ok: false, error: lockedNow } : { ok: false, error: "That two-factor code isn't right — codes change every 30 seconds.", needsCode: true };
    }
  }
  // Cleared only here, with both the password (or a fresh sign-in) and the code proved: a correct password alone must
  // not reset the count of wrong codes (as SEC-21 at sign-in).
  clearFailures([await confirmLockKey(userId)]);
  return { ok: true };
}

/** Whether the confirm form should ask for a code: the person has two-factor on. */
export async function identityNeedsCode(userId: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { twoFactorEnabledAt: true } });
  return !!user?.twoFactorEnabledAt;
}
