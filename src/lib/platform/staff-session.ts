import { INTERNAL_SESSION_PREFIX, internalActor } from "@/lib/internal-api/actor";
import { createHash, randomBytes } from "node:crypto";
import bcrypt from "bcryptjs";
import { cookies, headers } from "next/headers";
import type { StaffRole } from "@deskzo/control-client";
import { cidrContains, parseCidr, parseIp } from "@/lib/access/ip";
import { controlDb } from "@/lib/platform/control-db";
import { openForPlatform, sealForPlatform } from "@/lib/platform/kek";
import { clearFailures, lockoutState, recordFailure } from "@/lib/security/lockout";
import { staffTwoFactorPolicy } from "@/lib/platform/settings";
import { clientIpFrom } from "@/lib/client-ip";
import { protocolFor, requestHost } from "@/lib/tenancy/host";
import { totpQrCodeDataUrl, verifyTotpCode, verifyTotpCodeOnce } from "@/lib/totp";
import { sessionPendingSecret } from "@/lib/totp-enrolment";

/**
 * Signing platform staff in to the console (admin.<domain>) — a sign-in of its own, nothing to do with
 * any workspace's.
 *
 *   · The cookie is `__Host-deskzo-console` over https: this host only, never a workspace's.
 *   · It holds a random token; the control plane holds its SHA-256 as a PlatformSession, checked on
 *     every request — thirty minutes idle, twelve hours at most, revocable from the console.
 *   · Two-factor, when an owner requires it (src/lib/platform/settings.ts — required in production
 *     unless they say otherwise): a first sign-in opens only the enrolment page, and a session is
 *     not a console session until its second factor is passed (`mfaAt`). When it is off, everybody
 *     signs in with their password alone — owners, and whoever set up an authenticator, included;
 *     the authenticators are kept for when it is required again, and a session begun while it was
 *     off must sign in again then. The policy is read on every request, so a change applies at once.
 *   · Failed attempts lock out by address and by caller, in a namespace of their own ("console|").
 *   · PLATFORM_CONSOLE_IP_ALLOWLIST (comma-separated CIDRs), when set, refuses everywhere else. It
 *     needs TRUST_PROXY=1: the caller's address is only known from our own reverse proxy (callerIp).
 */

const COOKIE_SECURE = "__Host-deskzo-console";
const COOKIE_PLAIN = "deskzo-console";
const IDLE_MS = 30 * 60_000;
const MAX_MS = 12 * 60 * 60_000;
/** How often lastSeenAt is written — often enough for the idle limit, not on every request. */
const TOUCH_MS = 60_000;

export type Staff = { id: string; email: string; name: string; role: StaffRole };
export type StaffSession = {
  staff: Staff;
  sessionId: string;
  /** Through the second factor — or not asked for one: two-factor is off. */
  mfaDone: boolean;
  enrolled: boolean;
  twoFactorRequired: boolean;
};

export class StaffRefused extends Error {}

/** Compared against when the address has no account, so both refusals take a bcrypt's time. */
const NOBODY_HASH = bcrypt.hashSync(randomBytes(16).toString("hex"), 10);

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

async function secureRequest(): Promise<boolean> {
  const host = requestHost(await headers());
  return typeof host === "string" && protocolFor(host) === "https";
}

/**
 * The caller's address as our own reverse proxy saw it, or null without one (src/lib/client-ip.ts)
 * — an allowlist then refuses everybody rather than trusting a header anyone can write.
 */
async function callerIp(): Promise<string | null> {
  return clientIpFrom(await headers());
}

/** Whether the caller's address may reach the console at all. */
export async function consoleAddressAllowed(): Promise<boolean> {
  const list = process.env.PLATFORM_CONSOLE_IP_ALLOWLIST?.trim();
  if (!list) return true;
  const ip = parseIp(await callerIp());
  if (!ip) return false;
  return list
    .split(",")
    .map((c) => parseCidr(c.trim()))
    .some((cidr) => !!cidr && cidrContains(cidr, ip));
}

async function cookieName(): Promise<string> {
  return (await secureRequest()) ? COOKIE_SECURE : COOKIE_PLAIN;
}

export async function currentStaffSession(): Promise<StaffSession | null> {
  // Inside a verified call from the admin app (src/lib/internal-api/actor.ts): its staff member, whose
  // sign-in and second factor the admin app checked. No cookie and no address rule apply here.
  const actor = internalActor();
  if (actor) {
    return {
      staff: { id: actor.id, email: actor.email, name: actor.name, role: actor.role },
      sessionId: `${INTERNAL_SESSION_PREFIX}${actor.sessionRef}`,
      mfaDone: true,
      enrolled: true,
      twoFactorRequired: true,
    };
  }
  if (!(await consoleAddressAllowed())) return null;
  const token = (await cookies()).get(await cookieName())?.value;
  if (!token || token.length > 100) return null;
  const session = await controlDb().platformSession.findUnique({ where: { id: sha256(token) }, include: { user: true } });
  if (!session || session.revokedAt || !session.user.active) return null;
  const now = Date.now();
  if (session.expiresAt.getTime() <= now || now - session.lastSeenAt.getTime() > IDLE_MS) return null;
  if (now - session.lastSeenAt.getTime() > TOUCH_MS) {
    await controlDb().platformSession.update({ where: { id: session.id }, data: { lastSeenAt: new Date(now) } }).catch(() => {});
  }
  const { user } = session;
  const required = (await staffTwoFactorPolicy()).mode === "required";
  return {
    staff: { id: user.id, email: user.email, name: user.name, role: user.role },
    sessionId: session.id,
    mfaDone: !!session.mfaAt || !required,
    enrolled: !!user.totpEnabledAt,
    twoFactorRequired: required,
  };
}

/** A console session with its second factor passed, in one of `roles` (any, when none are named). */
export async function requireStaff(roles?: readonly StaffRole[]): Promise<Staff> {
  const session = await currentStaffSession();
  if (!session || !session.mfaDone) throw new StaffRefused("Sign in to the console.");
  if (roles && roles.length && !roles.includes(session.staff.role)) throw new StaffRefused("Your role cannot do that.");
  return session.staff;
}

export type SignInResult = { ok: true; enrol: boolean } | { ok: false; error: string; needsCode?: boolean };

export async function signInStaff(input: { email: string; password: string; code?: string }): Promise<SignInResult> {
  if (!(await consoleAddressAllowed())) return { ok: false, error: "The console cannot be reached from this address." };
  const email = String(input.email ?? "").trim().toLowerCase();
  // By caller only when the caller is known: one shared "unknown" bucket would let anybody lock everybody out.
  const ip = await callerIp();
  const accountKey = `console|account:${email}`;
  const callerKeys = ip ? [`console|caller:${ip}`] : [];
  const keys = [accountKey, ...callerKeys];
  const lockedText = (seconds: number) => `Too many attempts. Try again in ${Math.ceil(seconds / 60)} minute(s).`;
  /**
   * Security audit round two, 13 Nov 2026 (P6): eight wrong passwords from anywhere locked the account itself, so
   * anybody who knew a staff email could keep that person out of the console. The caller's own lock still refuses
   * outright; a lock on the account alone lets through a sign-in with the right password AND a right authenticator
   * code — which a stranger doesn't have. Without a code to check (two-factor off, or not set up) it still refuses.
   */
  const callerLocked = callerKeys.length ? lockoutState(callerKeys) : null;
  if (callerLocked?.lockedOut) return { ok: false, error: lockedText(callerLocked.retryInSeconds) };
  const accountLocked = lockoutState([accountKey]);
  const refuse = (needsCode = false): SignInResult => {
    recordFailure(keys);
    return { ok: false, error: "That email, password or code is not right.", needsCode };
  };

  const user = await controlDb().platformUser.findUnique({ where: { email } });
  // Compared either way, so a wrong address and a wrong password take the same time.
  const passwordOk = await bcrypt.compare(String(input.password ?? ""), user?.passwordHash ?? NOBODY_HASH);
  const required = (await staffTwoFactorPolicy()).mode === "required";
  const code = String(input.code ?? "").trim();
  /**
   * Security audit round two, 13 Nov 2026 (R2-16, low): with two-factor required, a sign-in without a code
   * was asked for one only when the password was right — which told a guesser it was. Now every sign-in
   * without a code, right password or wrong, gets the same answer and counts as a failure; the code comes
   * back with the password. Only a right password for somebody yet to set up an authenticator goes on, to
   * the enrolment page, which is all such a session opens.
   */
  // Locked account, and no authenticator code that could prove it is its owner: refused, as before (P6).
  if (accountLocked.lockedOut && !(required && user?.totpEnabledAt && code)) return { ok: false, error: lockedText(accountLocked.retryInSeconds) };
  if (required && !code && !(user && user.active && passwordOk && !user.totpEnabledAt)) {
    recordFailure(keys);
    return { ok: false, error: "Enter your password again with the code from your authenticator.", needsCode: true };
  }
  if (!user || !user.active || !passwordOk) {
    // On a locked account the lock's own words, whichever was wrong — nothing is learned from a locked account.
    if (accountLocked.lockedOut) {
      recordFailure(keys);
      return { ok: false, error: lockedText(accountLocked.retryInSeconds) };
    }
    return refuse(required);
  }
  let mfaAt: Date | null = null;
  if (required && user.totpEnabledAt) {
    // Once only (R2-16): a code already used for this account, or an older one, is refused.
    if (!user.totpSecretCipher || !verifyTotpCodeOnce(`staff:${user.id}`, openForPlatform("staff-totp", user.totpSecretCipher), code)) {
      if (accountLocked.lockedOut) {
        recordFailure(keys);
        return { ok: false, error: lockedText(accountLocked.retryInSeconds) };
      }
      return refuse(true);
    }
    mfaAt = new Date();
  }
  clearFailures(keys);

  const token = randomBytes(32).toString("base64url");
  const now = new Date();
  const head = await headers();
  await controlDb().platformSession.create({
    data: { id: sha256(token), userId: user.id, expiresAt: new Date(now.getTime() + MAX_MS), mfaAt, ip, userAgent: head.get("user-agent")?.slice(0, 300) ?? null },
  });
  await controlDb().platformUser.update({ where: { id: user.id }, data: { lastSignInAt: now } });
  await controlDb().platformAuditLog.create({ data: { actorKind: "STAFF", actor: user.id, action: "staff.sign-in", detail: { twoFactor: !!mfaAt } } });
  (await cookies()).set(await cookieName(), token, { httpOnly: true, sameSite: "strict", path: "/", secure: await secureRequest(), maxAge: MAX_MS / 1000 });
  // Sent to enrol only where the policy asks for it; otherwise straight in.
  return { ok: true, enrol: required && !mfaAt };
}

/**
 * The enrolment page: a secret for this staff member's authenticator, kept sealed on *this session*
 * (src/lib/totp-enrolment.ts). A reload shows the same one; another session — say one that only knew
 * the password — never sees it.
 */
export async function enrolmentChallenge(): Promise<{ qr: string; secret: string } | null> {
  const session = await currentStaffSession();
  if (!session || session.enrolled) return null;
  const row = await controlDb().platformSession.findUniqueOrThrow({ where: { id: session.sessionId }, select: { pendingTotpCipher: true } });
  const secret = await sessionPendingSecret({
    stored: row.pendingTotpCipher,
    open: (sealed) => openForPlatform("staff-totp", sealed),
    seal: (plain) => sealForPlatform("staff-totp", plain),
    save: (sealed) => controlDb().platformSession.update({ where: { id: session.sessionId }, data: { pendingTotpCipher: sealed } }),
  });
  return { qr: await totpQrCodeDataUrl(`${session.staff.email} (console)`, secret), secret };
}

/** Turns on the secret this session was shown — only that one — and signs out the user's other sessions. */
export async function finishEnrolment(code: string): Promise<{ ok: true } | { ok: false; error: string }> {
  const session = await currentStaffSession();
  if (!session || session.enrolled) return { ok: false, error: "Sign in again." };
  const row = await controlDb().platformSession.findUniqueOrThrow({ where: { id: session.sessionId }, select: { pendingTotpCipher: true } });
  const pending = row.pendingTotpCipher;
  if (!pending || !verifyTotpCode(openForPlatform("staff-totp", pending), String(code ?? ""))) {
    return { ok: false, error: "That code is not right — check the time on your phone." };
  }
  const now = new Date();
  await controlDb().$transaction(async (tx) => {
    await tx.platformUser.update({ where: { id: session.staff.id }, data: { totpSecretCipher: pending, totpEnabledAt: now } });
    await tx.platformSession.update({ where: { id: session.sessionId }, data: { mfaAt: now, pendingTotpCipher: null } });
    // Any other session of this account began on the password alone; it signs in again, with the code.
    await tx.platformSession.updateMany({
      where: { userId: session.staff.id, id: { not: session.sessionId }, revokedAt: null },
      data: { revokedAt: now },
    });
    await tx.platformAuditLog.create({ data: { actorKind: "STAFF", actor: session.staff.id, action: "staff.two-factor.enrolled" } });
  });
  return { ok: true };
}

export async function signOutStaff(): Promise<void> {
  const session = await currentStaffSession();
  if (session) await controlDb().platformSession.update({ where: { id: session.sessionId }, data: { revokedAt: new Date() } });
  (await cookies()).delete(await cookieName());
}
