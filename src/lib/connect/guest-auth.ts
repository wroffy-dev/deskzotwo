import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { connectInPlan, recordGuestActivity } from "@/lib/connect/activity";

/**
 * Deskzo Connect — how a guest signs in (owner, 20 Nov 2026: "admin invite the email goes to the workmail and otp for
 * verification on mail"). An admin invites a work email; every sign-in is a fresh code mailed to that inbox. No
 * passwords, no other way in. Built as the customer portal's codes are (src/lib/portal/device.ts):
 *
 *   · **Eight digits, ten minutes, five tries**, kept only as a hash; a try is claimed before the code is compared, so a
 *     burst of guesses can't share one. Five codes an hour a guest; twenty wrong codes in a day stop codes for the day.
 *   · **Nothing tells who is a guest**: any address asking for a code gets the same "check your inbox", and a code for
 *     an address that isn't a guest is "not the code" like any wrong one.
 *   · **A session** is an httpOnly cookie on /connect holding a random secret, the database only its hash: 8 hours idle,
 *     7 days at most, never past the guest's access date. Every page and action looks it up again, so suspending the
 *     guest, their access running out or a share revoked takes effect on the next click.
 *
 * Server only.
 */

const CODE_MINUTES = 10;
const CODE_TRIES = 5;
const CODES_AN_HOUR = 5;
export const CODE_DIGITS = 8;
export const FAILED_CODES_A_DAY = 20;
const IDLE_MS = 8 * 3_600_000;
const SESSION_MS = 7 * 86_400_000;
const DAY = 86_400_000;
export const INVITE_DAYS = 7;
export const GUEST_COOKIE = "dzg";
const COOKIE_PATH = "/connect";

export const CHECK_INBOX = "If that address has been invited, a code is on its way. Check the inbox (and spam).";
const WRONG = "That's not the code — check the email and try again.";
const RAN_OUT = "That code has run out — send yourself a new one.";
const LOCKED = "Too many wrong codes today, so sign-in is paused for this address until tomorrow.";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const codeHash = (guestId: string, code: string) => sha(`guest-code:${guestId}:${code}`);

/** Free mail services: a guest is invited by a work address, which their company closes when they leave. */
const PERSONAL_DOMAINS = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.in", "ymail.com", "outlook.com", "hotmail.com", "live.com", "msn.com",
  "icloud.com", "me.com", "mac.com", "aol.com", "rediffmail.com", "rediff.com", "proton.me", "protonmail.com", "zoho.com", "zohomail.in",
  "gmx.com", "mail.com", "yandex.com", "inbox.com", "tutanota.com",
]);

/** A work email as kept — lower case, trimmed — or null when it isn't one. */
export function workEmail(input: unknown): { ok: true; email: string } | { ok: false; error: string } {
  const email = String(input ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email) || email.length > 200) return { ok: false, error: "That isn't an email address." };
  const domain = email.split("@")[1]!;
  if (PERSONAL_DOMAINS.has(domain)) return { ok: false, error: `Invite a work address — ${domain} is a personal mail service, which nobody closes when the person leaves their company.` };
  return { ok: true, email };
}

/** "a****@autodesk.com". */
export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!user || !domain) return "your email";
  return `${user.slice(0, 2)}${"•".repeat(Math.max(3, user.length - 2))}@${domain}`;
}

type GuestRow = { id: string; name: string; email: string; status: string; inviteExpiresAt: Date; accessUntil: Date | null };

/** Whether this guest may sign in now: not stopped, access not over, and an unused invitation still fresh. */
export function guestMaySignIn(g: Pick<GuestRow, "status" | "inviteExpiresAt" | "accessUntil">, now = new Date()): boolean {
  if (g.status === "SUSPENDED") return false;
  if (g.accessUntil && g.accessUntil <= now) return false;
  if (g.status === "INVITED" && g.inviteExpiresAt <= now) return false;
  return true;
}

async function findGuest(email: string): Promise<GuestRow | null> {
  try {
    return await db.guest.findUnique({ where: { email }, select: { id: true, name: true, email: true, status: true, inviteExpiresAt: true, accessUntil: true } });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** Wrong codes typed for this guest in the last day: every try, less the one try of each code that was right. */
export async function failedCodesToday(guestId: string, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - DAY);
  const [tries, right] = await Promise.all([
    db.guestCode.aggregate({ where: { guestId, createdAt: { gt: since } }, _sum: { attempts: true } }),
    db.guestSession.count({ where: { guestId, createdAt: { gt: since } } }),
  ]);
  return Math.max(0, (tries._sum.attempts ?? 0) - right);
}

/**
 * A code to `email`, when it is a guest who may sign in. The answer is the same either way, so the page can't be used
 * to find out who is a guest. `send` is the mailer (src/lib/connect/mail.ts), passed in so a check can stand in for it.
 */
export async function sendGuestCode(input: unknown, send: (to: GuestRow, code: string, minutes: number) => Promise<void>, now = new Date()): Promise<{ ok: true; message: string } | { ok: false; error: string }> {
  const parsed = String(input ?? "").trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(parsed)) return { ok: false, error: "Type the work email you were invited on." };
  const guest = await findGuest(parsed);
  // A workspace whose plan dropped Connect lets no guest in — the same answer, so it says nothing either.
  if (!guest || !guestMaySignIn(guest, now) || !(await connectInPlan())) return { ok: true, message: CHECK_INBOX };
  if ((await failedCodesToday(guest.id, now)) >= FAILED_CODES_A_DAY) return { ok: true, message: CHECK_INBOX };
  const lastHour = await db.guestCode.count({ where: { guestId: guest.id, createdAt: { gt: new Date(now.getTime() - 3_600_000) } } });
  if (lastHour >= CODES_AN_HOUR) return { ok: false, error: "That's a lot of codes in an hour — use the last one, or try again later." };
  const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
  await db.$transaction(async (tx) => {
    await tx.guestCode.updateMany({ where: { guestId: guest.id, usedAt: null }, data: { usedAt: now } });
    await tx.guestCode.create({ data: { guestId: guest.id, codeHash: codeHash(guest.id, code), expiresAt: new Date(now.getTime() + CODE_MINUTES * 60_000) } });
  });
  await send(guest, code, CODE_MINUTES);
  return { ok: true, message: CHECK_INBOX };
}

/** The code typed for `email`: right, and this browser is signed in. */
export async function verifyGuestCode(input: unknown, typed: unknown, now = new Date()): Promise<{ ok: true } | { ok: false; error: string }> {
  const email = String(input ?? "").trim().toLowerCase();
  const code = String(typed ?? "").replace(/\D/g, "");
  const guest = email ? await findGuest(email) : null;
  if (!guest || !guestMaySignIn(guest, now)) return { ok: false, error: WRONG };
  if ((await failedCodesToday(guest.id, now)) >= FAILED_CODES_A_DAY) return { ok: false, error: LOCKED };
  const live = await db.guestCode.findFirst({ where: { guestId: guest.id, usedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" }, select: { id: true, codeHash: true } });
  if (!live) return { ok: false, error: RAN_OUT };
  // The try is claimed before the code is compared, in one conditional write (SEC-32, as the portal).
  const claimedTry = await db.guestCode.updateMany({ where: { id: live.id, usedAt: null, attempts: { lt: CODE_TRIES } }, data: { attempts: { increment: 1 } } });
  if (!claimedTry.count) return { ok: false, error: RAN_OUT };
  const right = code.length === CODE_DIGITS && timingSafeEqual(Buffer.from(live.codeHash), Buffer.from(codeHash(guest.id, code)));
  if (!right) {
    await db.guestCode.updateMany({ where: { id: live.id, usedAt: null, attempts: { gte: CODE_TRIES } }, data: { usedAt: now } });
    if ((await failedCodesToday(guest.id, now)) >= FAILED_CODES_A_DAY) {
      await db.guestCode.updateMany({ where: { guestId: guest.id, usedAt: null }, data: { usedAt: now } });
      return { ok: false, error: LOCKED };
    }
    return { ok: false, error: WRONG };
  }
  const claimed = await db.guestCode.updateMany({ where: { id: live.id, usedAt: null }, data: { usedAt: now } });
  if (!claimed.count) return { ok: false, error: RAN_OUT };

  const secret = randomBytes(32).toString("base64url");
  const cap = now.getTime() + SESSION_MS;
  const expiresAt = new Date(guest.accessUntil ? Math.min(cap, guest.accessUntil.getTime()) : cap);
  await db.$transaction(async (tx) => {
    await tx.guestSession.create({ data: { guestId: guest.id, secretHash: sha(secret), expiresAt, lastSeenAt: now }, select: { id: true } });
    await tx.guest.update({ where: { id: guest.id }, data: { status: "ACTIVE", lastSignInAt: now }, select: { id: true } });
  });
  (await cookies()).set(GUEST_COOKIE, secret, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: COOKIE_PATH, expires: expiresAt });
  await recordGuestActivity(guest.id, "SIGN_IN");
  return { ok: true };
}

export type SignedInGuest = { id: string; name: string; email: string; connectionName: string; sessionId: string };

/** The guest this browser is signed in as — looked up afresh, so a stop, an end date or idling takes effect now. */
export async function currentGuest(now = new Date()): Promise<SignedInGuest | null> {
  const secret = (await cookies()).get(GUEST_COOKIE)?.value;
  if (!secret || secret.length < 20) return null;
  let session;
  try {
    session = await db.guestSession.findUnique({
      where: { secretHash: sha(secret) },
      select: {
        id: true,
        expiresAt: true,
        lastSeenAt: true,
        revokedAt: true,
        guest: { select: { id: true, name: true, email: true, status: true, inviteExpiresAt: true, accessUntil: true, connection: { select: { name: true } } } },
      },
    });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
  if (!session || session.revokedAt || session.expiresAt <= now) return null;
  if (now.getTime() - session.lastSeenAt.getTime() > IDLE_MS) return null;
  const g = session.guest;
  if (g.status !== "ACTIVE" || !guestMaySignIn(g, now)) return null;
  if (!(await connectInPlan())) return null;
  // Seen — at most once a minute, so a page of server calls is one write.
  if (now.getTime() - session.lastSeenAt.getTime() > 60_000) await db.guestSession.update({ where: { id: session.id }, data: { lastSeenAt: now } }).catch(() => {});
  return { id: g.id, name: g.name, email: g.email, connectionName: g.connection.name, sessionId: session.id };
}

export async function signOutGuest(): Promise<void> {
  const jar = await cookies();
  const secret = jar.get(GUEST_COOKIE)?.value;
  if (secret) await db.guestSession.updateMany({ where: { secretHash: sha(secret), revokedAt: null }, data: { revokedAt: new Date() } }).catch(() => {});
  jar.set(GUEST_COOKIE, "", { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: COOKIE_PATH, expires: new Date(0) });
}

/** Every session of a guest ended — when they are suspended or their access is cut. */
export async function endGuestSessions(guestId: string, now = new Date()): Promise<void> {
  await db.guestSession.updateMany({ where: { guestId, revokedAt: null }, data: { revokedAt: now } });
}
