import { INTERNAL_SESSION_PREFIX, internalActor } from "@/lib/internal-api/actor";
import { controlDb } from "@/lib/platform/control-db";
import { openForPlatform } from "@/lib/platform/kek";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { consoleOrigin, StaffChangeRefused } from "@/lib/platform/staff";
import type { Staff } from "@/lib/platform/staff-session";
import { clearFailures, lockoutState, recordFailure } from "@/lib/security/lockout";
import { verifyTotpCodeOnce } from "@/lib/totp";

/**
 * A fresh authenticator code for the console's most dangerous changes, and word to every other owner.
 *
 * Security audit round two, 13 Nov 2026 (R2-08): an owner's session alone — stolen, or left open — could
 * turn off staff two-factor, reset another owner's authenticator, issue a password link for any staff
 * member, change a staff role, change the payment gateways' keys or close a workspace. Each of those now
 * asks the acting owner for a code from their own authenticator, checked against their own secret, once
 * only (src/lib/totp.ts `verifyTotpCodeOnce`, so the code they signed in with doesn't count again), with
 * wrong codes locked out like a sign-in. And every other active owner is emailed when the two-factor
 * policy, an owner's account or the gateway keys change, so a change nobody meant is seen.
 *
 * An owner with no authenticator set up can't give a code, and is told to set one up — with one
 * exception: turning two-factor *on* (`allowWithoutAuthenticator`), which only makes the console safer
 * and is how an owner gets to set one up when it was off.
 */

export const STEP_UP_REFUSED = "That code is not right — enter a fresh code from your authenticator.";

export async function confirmStaffCode(staff: Pick<Staff, "id">, code: unknown, options: { allowWithoutAuthenticator?: boolean } = {}): Promise<void> {
  // Inside a call from the admin app, it checked the code against its own authenticators and says
  // when, signed (src/lib/internal-api/actor.ts). A step-up older than the window does not count.
  const actor = internalActor();
  if (actor) {
    if (actor.id !== staff.id || !actor.stepUpAt || Date.now() - actor.stepUpAt.getTime() > STEP_UP_WINDOW_MS || actor.stepUpAt.getTime() > Date.now() + 5000) {
      throw new StaffChangeRefused(STEP_UP_REFUSED);
    }
    return;
  }
  const keys = [`console|step-up:${staff.id}`];
  const locked = lockoutState(keys);
  if (locked.lockedOut) throw new StaffChangeRefused(`Too many wrong codes. Try again in ${Math.ceil(locked.retryInSeconds / 60)} minute(s).`);
  const user = await controlDb().platformUser.findUnique({ where: { id: staff.id }, select: { totpSecretCipher: true, totpEnabledAt: true, active: true } });
  if (!user?.active) throw new StaffChangeRefused("Sign in to the console.");
  if (!user.totpEnabledAt || !user.totpSecretCipher) {
    if (options.allowWithoutAuthenticator) return;
    throw new StaffChangeRefused("This needs a code from your authenticator. Turn two-factor on and set one up first.");
  }
  const typed = typeof code === "string" ? code.replace(/\s+/g, "") : "";
  if (!/^\d{6}$/.test(typed) || !verifyTotpCodeOnce(`staff:${staff.id}`, openForPlatform("staff-totp", user.totpSecretCipher), typed)) {
    recordFailure(keys);
    throw new StaffChangeRefused(STEP_UP_REFUSED);
  }
  clearFailures(keys);
}

/** Every active owner but the one acting, told what changed and by whom. Never throws. */
export async function tellOtherOwners(actor: Pick<Staff, "id" | "name" | "email">, what: string): Promise<number> {
  try {
    const owners = await controlDb().platformUser.findMany({ where: { role: "OWNER", active: true, NOT: { id: actor.id } }, select: { email: true } });
    const text = [
      `${actor.name} (${actor.email}) made this change on the Deskzo console:`,
      "",
      what,
      "",
      `If nobody meant it, sign in at ${consoleOrigin()} at once, put it back, and end that person's sessions.`,
    ].join("\n");
    await Promise.all(
      owners.map((o) =>
        sendPlatformMail({ type: "ALERTS", to: o.email, subject: `Console security change: ${what.split("\n")[0]!.slice(0, 120)}`, text }).catch((err) =>
          console.error("[step-up] an owner could not be told", err),
        ),
      ),
    );
    return owners.length;
  } catch (err) {
    console.error("[step-up] owners could not be told", err);
    return 0;
  }
}

/**
 * How long a fresh code counts for something that asks for one shortly before it is done — a Backup & Restore bundle's
 * download (owner, 26 Nov 2026), which is a plain link the browser follows rather than a form that could carry a code.
 */
export const STEP_UP_WINDOW_MS = 10 * 60_000;

/**
 * A fresh code checked (`confirmStaffCode`), and remembered on this console session alone — another session of the
 * same person, or the same cookie after the window, does not count.
 */
export async function recordStepUp(staff: Pick<Staff, "id">, sessionId: string, code: unknown): Promise<Date> {
  // The admin app records its own step-ups; inside its call, the one it vouched for is the answer.
  if (sessionId.startsWith(INTERNAL_SESSION_PREFIX)) {
    await confirmStaffCode(staff, code);
    return internalActor()?.stepUpAt ?? new Date();
  }
  await confirmStaffCode(staff, code);
  const at = new Date();
  await controlDb().platformSession.update({ where: { id: sessionId }, data: { stepUpAt: at } });
  return at;
}

/** Whether this console session gave a fresh code within the window. */
export async function recentStepUp(sessionId: string, now: number = Date.now()): Promise<boolean> {
  if (sessionId.startsWith(INTERNAL_SESSION_PREFIX)) {
    const at = internalActor()?.stepUpAt?.getTime();
    return at !== undefined && at <= now + 1000 && now - at <= STEP_UP_WINDOW_MS;
  }
  const session = await controlDb().platformSession.findUnique({ where: { id: sessionId }, select: { stepUpAt: true } });
  const at = session?.stepUpAt?.getTime();
  return at !== undefined && at <= now + 1000 && now - at <= STEP_UP_WINDOW_MS;
}
