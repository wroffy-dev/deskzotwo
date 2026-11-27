import { db } from "@/lib/db";
import { getCachedSecuritySettings } from "@/lib/security-settings";
import { isSsoSignIn } from "@/lib/workplace/providers";

/**
 * What a person must do on My profile before anything else: choose their own password after signing in with a
 * temporary one, or set up two-factor authentication where the administrator requires it. The dashboard layout sends
 * them to /profile on a full page load, and ForcedSetupGuard (src/components/layout/forced-setup-guard.tsx) on every
 * move after it — a layout isn't drawn again when somebody clicks from page to page, so the redirect alone let them
 * roam until the next refresh threw them back (owner, 3 Nov 2026).
 *
 * Both are about the Deskzo password, so both apply only to a session that signed in with it (owner, 3 Nov 2026: "lets
 * make two factor only for password" — the authenticator code is only ever asked at password sign-in, src/lib/auth.ts).
 * Somebody who signed in with Microsoft, Google or Zoho was checked by them, and is held for neither.
 */
export async function forcedSetupFor(userId: string, sid: string | null | undefined): Promise<boolean> {
  if (!(await signedInWithPassword(sid))) return false;
  const [user, security] = await Promise.all([
    db.user.findUnique({ where: { id: userId }, select: { mustChangePassword: true, twoFactorEnabledAt: true } }),
    getCachedSecuritySettings(),
  ]);
  return !!user?.mustChangePassword || (!!security?.enforceTwoFactor && !user?.twoFactorEnabledAt);
}

/**
 * Whether this session signed in with a password. A session issued before sign-ins were recorded has no `sid`, and
 * counts as a password one — the careful answer.
 */
export async function signedInWithPassword(sid: string | null | undefined): Promise<boolean> {
  if (!sid) return true;
  const signIn = await db.signIn.findUnique({ where: { sid }, select: { provider: true } }).catch(() => null);
  return !signIn || !isSsoSignIn(signIn.provider);
}
