"use server";

import { revalidatePath } from "next/cache";
import bcrypt from "bcryptjs";
import { db } from "@/lib/db";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { encryptSecret, decryptSecret } from "@/lib/crypto";
import { generateTotpSecret, verifyTotpCode, totpQrCodeDataUrl } from "@/lib/totp";
import {
  beginTwoFactorSchema,
  changePasswordSchema,
  confirmTwoFactorSchema,
  disableTwoFactorSchema,
  updateOwnContactSchema,
} from "@/lib/validation/profile";
import { notifyUser } from "@/lib/notify";
import { recordAudit } from "@/lib/audit";
import { logActivity } from "@/lib/activity";
import type { ActionResult } from "@/actions/company";
import { accountsChanged } from "@/lib/platform/account-hooks";
import { auth, signIn } from "@/lib/auth";
import { SIGN_IN_IDS, SIGN_IN_NAMES, providerOfSignIn, type WorkplaceProvider } from "@/lib/workplace/providers";
import { ACT_CONFIRM_MS, OPEN_SECRET_CONFIRM_MS, confirmLocked, countConfirmFailure, justConfirmedWithProvider } from "@/lib/security/confirm-identity";
import { endSignInsFor } from "@/lib/security/end-sign-ins";
import { signInProviders } from "@/lib/workplace/settings";
import { signInPolicyFor } from "@/lib/workplace/sign-in-rules-server";
import { waysIn } from "@/lib/workplace/sign-in-rules";
import { requestPasswordReset } from "@/actions/password-reset";

export async function getOwnProfile() {
  const user = await requireUser();
  const dbUser = await db.user.findUnique({
    where: { id: user.id },
    select: {
      id: true,
      name: true,
      email: true,
      phone: true,
      role: true,
      // The role's own name, as the header shows it ("HR head" rather than HR_HEAD).
      roleRef: { select: { name: true } },
      department: { select: { name: true } },
      manager: { select: { name: true } },
      mustChangePassword: true,
      twoFactorEnabledAt: true,
      photoUpdatedAt: true,
    },
  });
  return dbUser;
}

/**
 * Somebody's own work number.
 *
 * Their own only — there is no id parameter, and there should not be. Editing a colleague's
 * contact details is a Users & Access job, and an action that took an id would be a way for
 * anybody signed in to change whose number appears on whose quotes.
 */
export async function updateOwnContact(input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  const parsed = updateOwnContactSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  await db.user.update({
    where: { id: user.id },
    data: { phone: parsed.data.phone?.trim() || null },
  });

  revalidatePath("/profile");
  return { ok: true, data: null };
}

export async function changeOwnPassword(input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  // Changing the credentials of a borrowed account turns "see their screen" into "take their
  // account", and would be filed as the user doing it to themselves.
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const parsed = changePasswordSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }
  const { currentPassword, newPassword } = parsed.data;

  const setup = await passwordChange();
  if (!setup.allowed) return { ok: false, error: `You sign in with ${setup.ways} only — your administrator set it — so a Deskzo password wouldn't let you in.` };
  const refused = await confirmedIdentity(user.id, currentPassword);
  if (refused) return { ok: false, error: refused };

  const dbUser = await db.user.findUniqueOrThrow({ where: { id: user.id } });

  const passwordHash = await bcrypt.hash(newPassword, 10);
  await db.user.update({ where: { id: user.id }, data: { passwordHash, mustChangePassword: false } });
  // Security audit, 11 Nov 2026 (SEC-22, SEC-25): every other sign-in, phone and API key ends — whoever had the old
  // password is out — and this session stays.
  await endOtherSignIns(user.id, false);
  // A new password unlinks this account from its other workspaces too (owner decision 4): "change your password" is the way to be safe.
  await accountsChanged([user.id], { revoke: "credentials", by: `user:${user.id}` });

  // Written down, as a reset from an emailed link and an admin's reset already were: after a takeover, "when
  // did the password change" is the first question (owner, 2 Nov 2026 — "Phase 1 security fixes", audit
  // M-9). Never the password itself.
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "User", entityId: user.id, entityLabel: "Changed their own password" });
  await logActivity({ kind: "PASSWORD_CHANGED", userId: dbUser.id, userName: dbUser.name, userEmail: dbUser.email, summary: `${dbUser.name} changed their own password` });

  revalidatePath("/profile");
  return { ok: true, data: null };
}

/**
 * What the Password card offers (owner, 3 Nov 2026 — "user should set own password from profile without the current
 * password; but if admin has set Microsoft login only, disable password change"). Nothing, where their sign-in rule
 * (person, role or company — src/lib/workplace/sign-in-rules.ts) leaves no password; otherwise the current password
 * only where it's the proof — an account with one, not just signed in with Microsoft or Google.
 */
export async function passwordChange(): Promise<{ allowed: boolean; ways: string; hasPassword: boolean; needsCurrent: boolean; needsReconfirm: boolean; provider: string | null; providerName: string | null }> {
  const user = await requireUser();
  const account = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { id: true, role: true, isSuperAdmin: true } });
  const [policy, who] = await Promise.all([signInPolicyFor(account), twoFactorIdentity()]);
  return {
    allowed: policy.password,
    // "Microsoft"; a rule naming a sign-in the company has since switched off names none.
    ways: waysIn(policy) || "single sign-on",
    hasPassword: who.hasPassword,
    needsCurrent: who.hasPassword && !who.freshSignIn,
    // Leads with "Confirm with Microsoft" (owner, 3 Nov 2026 — "to set a new password the user needs a current password
    // he doesn't have"): no password of their own, or signed in with Microsoft — a password set for them, an old one,
    // isn't theirs to know. The current password stays offered where they have one.
    needsReconfirm: !who.freshSignIn && (!who.hasPassword || who.signedInWithProvider),
    provider: who.provider,
    providerName: who.providerName,
  };
}

/**
 * "Don't know your current password?" — the sign-in page's emailed link, to their own address (requestPasswordReset,
 * with its limits). Setting a password from it proves the mailbox; nothing here changes until the link is used.
 */
export async function emailMyPasswordLink(): Promise<ActionResult<{ to: string }>> {
  const user = await requireUser();
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const setup = await passwordChange();
  if (!setup.allowed) return { ok: false, error: `You sign in with ${setup.ways} only, so there's no Deskzo password to set.` };
  const account = await db.user.findUniqueOrThrow({ where: { id: user.id }, select: { email: true } });
  await requestPasswordReset(account.email);
  return { ok: true, data: { to: account.email } };
}

/** How long a Microsoft or Google sign-in counts as having just proved who somebody is. */
const FRESH_SIGN_IN_MS = 15 * 60_000;

/**
 * How this person can prove it's them before changing their second factor (owner, 3 Nov 2026 — "when a user signs in
 * with Microsoft, two-factor setup asks for a password? how will they know it?"). Their password, if the account has
 * one of its own; or a Microsoft or Google sign-in on this very session in the last 15 minutes — an account that only
 * ever signs in with Microsoft has no Deskzo password to type.
 */
export async function twoFactorIdentity(): Promise<{ hasPassword: boolean; freshSignIn: boolean; signedInWithProvider: boolean; provider: string | null; providerName: string | null }> {
  const user = await requireUser();
  const sid = (await auth())?.user?.sid ?? null;
  const [account, session] = await Promise.all([
    db.user.findUnique({ where: { id: user.id }, select: { passwordHash: true } }),
    sid ? db.signIn.findUnique({ where: { sid }, select: { provider: true, at: true } }) : null,
  ]);
  const via = providerOfSignIn(session?.provider);
  // A bcrypt hash is 60 characters; an account still waiting for its password holds a placeholder (src/lib/no-password.ts).
  const hasPassword = account?.passwordHash.length === 60;
  // The way in to offer again: the one used now, else the company's first, where one is switched on.
  const offered = via ?? (await signInProviders())[0] ?? null;
  return {
    hasPassword,
    freshSignIn: !!via && !!session && Date.now() - session.at.getTime() < FRESH_SIGN_IN_MS,
    // This session came through Microsoft or Google, however long ago: the password, if any, may be one they never knew.
    signedInWithProvider: !!via,
    provider: offered ? SIGN_IN_IDS[offered] : null,
    providerName: offered ? SIGN_IN_NAMES[offered] : null,
  };
}

/**
 * Signs this person out everywhere but this session (security audit, 11 Nov 2026, SEC-22): after their password or
 * two-factor changes, a session somebody else holds must not outlive it. API keys go too unless `keepApiKeys` —
 * a key never answered to two-factor, so a change there leaves them; a new password ends them.
 */
async function endOtherSignIns(userId: string, keepApiKeys: boolean): Promise<void> {
  const sid = (await auth())?.user?.sid ?? null;
  await endSignInsFor(userId, { keepSid: sid, byId: userId, keepApiKeys });
}

/** Null when it's them; otherwise what to tell them. */
async function confirmedIdentity(userId: string, password: string): Promise<string | null> {
  const proof = await twoFactorIdentity();
  if (proof.freshSignIn) return null;
  if (password) {
    // Security audit, 11 Nov 2026 (SEC-23): the same limit as confirming a restore — a stolen session can't grind
    // the current password down here either.
    const locked = await confirmLocked(userId);
    if (locked) return locked;
    const dbUser = await db.user.findUniqueOrThrow({ where: { id: userId }, select: { passwordHash: true } });
    if (await bcrypt.compare(password, dbUser.passwordHash)) return null;
    return (await countConfirmFailure(userId)) ?? "Current password is incorrect.";
  }
  return proof.hasPassword
    ? "Enter your current password."
    : `Your account signs in with ${proof.providerName ?? "Microsoft"} and has no Deskzo password. Confirm with ${proof.providerName ?? "Microsoft"} first.`;
}

/**
 * Sign in again with Microsoft (or Google) and come straight back — the proof `confirmedIdentity` takes from an account
 * without a password. Only a way in the company has switched on.
 */
export async function reconfirmWithProvider(provider: string, returnTo: string): Promise<void> {
  await requireUser();
  const which = providerOfSignIn(provider);
  if (!which || !(await signInProviders()).includes(which)) return;
  const back = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/profile";
  await signIn(SIGN_IN_IDS[which], { redirectTo: back });
}

/**
 * How this person can confirm it's them before a stored password opens (`open`), or a restore or reset goes ahead (`act`):
 * the password, if the account has one of its own, or signing in again. Offered to those who have no password, and to those
 * signed in with Microsoft or Google, whose password, if any, may be one they never knew. Not while viewing as somebody.
 */
export async function secretConfirmation(what: "open" | "act") {
  const user = await requireUser();
  const [who, viewingAs, justConfirmed] = await Promise.all([
    twoFactorIdentity(),
    refuseWhileViewingAs(),
    justConfirmedWithProvider(user.id, what === "open" ? OPEN_SECRET_CONFIRM_MS : ACT_CONFIRM_MS),
  ]);
  return {
    hasPassword: who.hasPassword,
    justConfirmed,
    mayReconfirm: !viewingAs && !!who.provider && (!who.hasPassword || who.signedInWithProvider),
    provider: who.provider,
    providerName: who.providerName,
  };
}

/**
 * What makes each sign-in page ask again, rather than pass straight through on a browser still signed in to it — without
 * which, a laptop left open would be enough. Each provider has its own word for it.
 */
const ASK_AGAIN: Record<WorkplaceProvider, Record<string, string>> = {
  MICROSOFT: { prompt: "login" },
  GOOGLE: { prompt: "select_account", max_age: "0" },
  ZOHO: { prompt: "consent" },
};

/** Sign in again and come straight back, made to type it: the proof for opening a secret, a restore and a reset. */
export async function reconfirmForSecret(provider: string, returnTo: string): Promise<void> {
  const user = await requireUser();
  if (await refuseWhileViewingAs()) return;
  const which = providerOfSignIn(provider);
  if (!which || !(await signInProviders()).includes(which)) return;
  const back = returnTo.startsWith("/") && !returnTo.startsWith("//") ? returnTo : "/profile";
  await signIn(SIGN_IN_IDS[which], { redirectTo: back }, { ...ASK_AGAIN[which], login_hint: user.email });
}

/**
 * Start enrolling an authenticator.
 *
 * ## Why this asks for the password
 *
 * Because it is a credential change, and `disableOwnTwoFactor` two functions below has always
 * asked. Without it, a stolen session cookie was enough to take the account: the old version wrote
 * a fresh secret and set `twoFactorEnabledAt: null` in the same update, which silently switched the
 * victim's second factor **off**, and a follow-up confirm with a code from the attacker's own phone
 * switched it back on pointing at them. The victim was never told, their authenticator simply
 * stopped verifying, and because the confirm step re-satisfied `enforceTwoFactor` even the
 * re-enrolment prompt in the dashboard layout never fired.
 *
 * ## Why the new secret goes somewhere else
 *
 * An enrolment that is started and abandoned must leave the account exactly as it was. The pending
 * secret is proved first and promoted second.
 */
export async function beginTwoFactorSetup(input?: unknown): Promise<ActionResult<{ secret: string; qrCodeDataUrl: string }>> {
  const user = await requireUser();
  // Changing the credentials of a borrowed account turns "see their screen" into "take their
  // account", and would be filed as the user doing it to themselves.
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };

  const parsed = beginTwoFactorSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const refused = await confirmedIdentity(user.id, parsed.data.currentPassword);
  if (refused) return { ok: false, error: refused };

  const secret = generateTotpSecret();
  await db.user.update({
    where: { id: user.id },
    data: { twoFactorPendingCipher: await encryptSecret(secret) },
  });
  const qrCodeDataUrl = await totpQrCodeDataUrl(user.email, secret);
  return { ok: true, data: { secret, qrCodeDataUrl } };
}

export async function confirmTwoFactorSetup(input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  // Changing the credentials of a borrowed account turns "see their screen" into "take their
  // account", and would be filed as the user doing it to themselves.
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const parsed = confirmTwoFactorSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const dbUser = await db.user.findUniqueOrThrow({ where: { id: user.id } });
  if (!dbUser.twoFactorPendingCipher) {
    return { ok: false, error: "Start setup again — no pending authenticator to confirm." };
  }
  const secret = await decryptSecret(dbUser.twoFactorPendingCipher);
  if (!verifyTotpCode(secret, parsed.data.code)) {
    return { ok: false, error: "That code didn't match. Check the time on your phone and try again." };
  }

  // Promoted only now: until this line the account was still answering to whatever it had before.
  await db.user.update({
    where: { id: user.id },
    data: {
      twoFactorSecretCipher: dbUser.twoFactorPendingCipher,
      twoFactorPendingCipher: null,
      twoFactorEnabledAt: new Date(),
    },
  });
  // Security audit, 11 Nov 2026 (SEC-22): a session signed in without this authenticator ends.
  await endOtherSignIns(user.id, true);

  // Told, not just recorded. Somebody whose second factor changed without them doing it is the one
  // person who can raise the alarm, and they cannot if nothing reaches them.
  await notifyUser({
    userId: user.id,
    type: "SECURITY_ALERT",
    title: "Your authenticator was changed",
    message: "A new authenticator app was set up on your account. If this wasn't you, change your password now.",
    link: "/profile",
  });
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "User",
    entityId: user.id,
    entityLabel: "Enrolled a new two-factor authenticator",
  });

  revalidatePath("/profile");
  return { ok: true, data: null };
}

export async function disableOwnTwoFactor(input: unknown): Promise<ActionResult<null>> {
  const user = await requireUser();
  // Changing the credentials of a borrowed account turns "see their screen" into "take their
  // account", and would be filed as the user doing it to themselves.
  const blocked = await refuseWhileViewingAs();
  if (blocked) return { ok: false, error: blocked };
  const parsed = disableTwoFactorSchema.safeParse(input);
  if (!parsed.success) {
    return { ok: false, error: parsed.error.issues[0]?.message ?? "Invalid input" };
  }

  const refused = await confirmedIdentity(user.id, parsed.data.currentPassword);
  if (refused) return { ok: false, error: refused };

  await db.user.update({
    where: { id: user.id },
    data: { twoFactorSecretCipher: null, twoFactorPendingCipher: null, twoFactorEnabledAt: null },
  });
  // Security audit, 11 Nov 2026 (SEC-22): every other sign-in ends with it.
  await endOtherSignIns(user.id, true);
  await accountsChanged([user.id], { revoke: "two-factor-reset", by: `user:${user.id}` });
  // Recorded as enrolling one is (`confirmTwoFactorSetup` above): a second factor switched off is the step
  // before a takeover, and was the one change to it nothing wrote down (owner, 2 Nov 2026 — "Phase 1
  // security fixes", audit M-9).
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "User", entityId: user.id, entityLabel: "Switched off their own two-factor authentication" });

  await notifyUser({
    userId: user.id,
    type: "SECURITY_ALERT",
    title: "Two-factor was switched off",
    message: "Two-factor authentication was turned off on your account. If this wasn't you, change your password now.",
    link: "/profile",
  });

  revalidatePath("/profile");
  return { ok: true, data: null };
}
