import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { cookies } from "next/headers";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * A code before a new browser opens a customer's portal link (owner, 29 Oct 2026). The link stays the way in — no
 * password to forget — but once the workspace asks for it (Settings › Portal › "Ask for a code"), a browser the link's
 * person hasn't confirmed sees only "we'll email you a code". The code goes to the address the link was made for, so
 * a forwarded link, or one left in a former employee's mailbox, opens nothing without that mailbox.
 *
 *   · **Eight digits, ten minutes, five tries**, kept only as a hash. Five codes an hour a link, so the mail can't be
 *     used to flood somebody's inbox; twenty wrong codes in a day pause the link for the day (R2-20, below).
 *   · **A confirmed browser is trusted for thirty days**: an httpOnly cookie holds a random secret, the database only
 *     its hash. Revoking the link ends it, as the link's own check comes first.
 *   · **Every portal action asks** (src/actions/portal-public.ts `resolve`), not only the page: an action called by
 *     hand from an unconfirmed browser gets nothing.
 */

const CODE_MINUTES = 10;
const CODE_TRIES = 5;
const CODES_AN_HOUR = 5;
export const TRUST_DAYS = 30;
const DAY = 86_400_000;
/**
 * Security audit round two, 13 Nov 2026 (R2-20): five tries a code and five codes an hour still let somebody guess 25
 * times an hour, for ever, on a link that never ran out. Now the codes are eight digits, and a link whose codes were
 * guessed wrong this many times in a day takes no more codes, and checks none, until the day is out — its customer's
 * account manager is told.
 */
export const CODE_DIGITS = 8;
export const FAILED_CODES_A_DAY = 20;
export const LOCKED_TEXT = "Too many wrong codes on this link today, so it's paused for 24 hours. Ask us if you need in sooner.";

/**
 * Wrong codes typed on this link in the last 24 hours, across every code sent: each code's tries, less the one try of
 * each code that was right — every right code made a confirmed browser.
 */
export async function failedCodesToday(loginId: string, now = new Date()): Promise<number> {
  const since = new Date(now.getTime() - DAY);
  const [tries, rightOnes] = await Promise.all([
    db.portalCode.aggregate({ where: { loginId, createdAt: { gt: since } }, _sum: { attempts: true } }),
    db.portalDevice.count({ where: { loginId, createdAt: { gt: since } } }),
  ]);
  return Math.max(0, (tries._sum.attempts ?? 0) - rightOnes);
}

/** Whether the link is paused for too many wrong codes (R2-20). */
export async function codesLocked(loginId: string, now = new Date()): Promise<boolean> {
  return (await failedCodesToday(loginId, now)) >= FAILED_CODES_A_DAY;
}

/** The customer's account manager — else whoever made the link — told once, when the link pauses. */
async function tellLinkLocked(loginId: string) {
  const login = await db.portalLogin.findUnique({ where: { id: loginId }, select: { personName: true, createdById: true, company: { select: { name: true, companySeq: true, ownerUserId: true } } } });
  const userId = login?.company.ownerUserId ?? login?.createdById;
  if (!login || !userId) return;
  const [{ notifyUser }, { companyPath }] = await Promise.all([import("@/lib/notify"), import("@/lib/record-links")]);
  await notifyUser({
    userId,
    type: "SECURITY_ALERT",
    title: `${login.personName}'s portal link is paused for 24 hours`,
    message: `${FAILED_CODES_A_DAY} wrong sign-in codes were typed on it today. If that wasn't them, revoke the link and send a new one.`,
    link: `${companyPath(login.company.companySeq)}?tab=portal`,
  }).catch(() => undefined);
}

const sha = (text: string) => createHash("sha256").update(text).digest("hex");
const codeHash = (loginId: string, code: string) => sha(`portal-code:${loginId}:${code}`);
/** One cookie a link, so two customers' links opened in one browser are confirmed apart. */
export const cookieName = (loginId: string) => `dzp_${loginId}`;

/** Whether the workspace asks for a code; a workspace not migrated yet asks for none. */
export async function portalRequiresCode(): Promise<boolean> {
  try {
    const row = await db.portalSettings.findUnique({ where: { id: "global" }, select: { requireCode: true } });
    return !!row?.requireCode;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

/** "s****@acme.com": enough to know which mailbox to look in. */
export function maskEmail(email: string): string {
  const [user, domain] = email.split("@");
  if (!user || !domain) return "your email";
  return `${user[0]}${"*".repeat(Math.max(3, user.length - 1))}@${domain}`;
}

/** Whether this browser was confirmed for the link, from its cookie. */
export async function deviceTrusted(loginId: string, now = new Date()): Promise<boolean> {
  const secret = (await cookies()).get(cookieName(loginId))?.value;
  if (!secret || secret.length < 20) return false;
  const device = await db.portalDevice.findUnique({ where: { secretHash: sha(secret) }, select: { id: true, loginId: true, expiresAt: true } }).catch(() => null);
  if (!device || device.loginId !== loginId || device.expiresAt <= now) return false;
  await db.portalDevice.update({ where: { id: device.id }, data: { lastSeenAt: now } }).catch(() => {});
  return true;
}

export type CodeSent = { ok: true; to: string } | { ok: false; error: string };

/** A new code, mailed to the link's person. The last one stops working. */
export async function sendCode(login: { id: string; personName: string; personEmail: string | null }, business: string, now = new Date()): Promise<CodeSent> {
  if (!login.personEmail) return { ok: false, error: "This link has no email address to send a code to — ask us for a new link." };
  // R2-20: a link paused for wrong codes takes no new ones.
  if (await codesLocked(login.id, now)) return { ok: false, error: LOCKED_TEXT };
  const lastHour = await db.portalCode.count({ where: { loginId: login.id, createdAt: { gt: new Date(now.getTime() - 3_600_000) } } });
  if (lastHour >= CODES_AN_HOUR) return { ok: false, error: "That's a lot of codes in an hour — check your inbox (and spam) for the last one, or try again later." };
  const code = String(randomInt(0, 10 ** CODE_DIGITS)).padStart(CODE_DIGITS, "0");
  await db.$transaction(async (tx) => {
    await tx.portalCode.updateMany({ where: { loginId: login.id, usedAt: null }, data: { usedAt: now } });
    await tx.portalCode.create({ data: { loginId: login.id, codeHash: codeHash(login.id, code), expiresAt: new Date(now.getTime() + CODE_MINUTES * 60_000) } });
  });
  await mailCode(login.personEmail, login.personName, business, code);
  return { ok: true, to: maskEmail(login.personEmail) };
}

/**
 * The code's email, in the wording of the `account.portal-code` template (owner, 1 Nov 2026) on both paths: the
 * company's own mail, in its plain layout, when it has one for such mail; Deskzo's otherwise, as
 * "<business> via Deskzo" in Deskzo's layout.
 */
async function mailCode(to: string, name: string, business: string, code: string) {
  // Loaded here, not at the top: the public portal page needs none of the mail code until a code is sent.
  const [{ deliverNow, emailRouteFor }, { textToHtml }, { sendPlatformMail }, { renderPlatformMail, templateMail }] = await Promise.all([
    import("@/lib/marketing/pipeline"),
    import("@/lib/marketing/html"),
    import("@/lib/platform/mailer"),
    import("@/lib/platform/mail/templates"),
  ]);
  const values = { firstName: name.trim().split(/\s+/)[0] || "", business, code, minutes: String(CODE_MINUTES) };
  if (await emailRouteFor("TRANSACTIONAL").catch(() => null)) {
    const { subject, text } = await renderPlatformMail("account.portal-code", values);
    const sent = await deliverNow({ to, toName: name, fromName: business, replyTo: null, subject, html: textToHtml(text), text }, "TRANSACTIONAL", { delivering: true });
    if (sent.ok) return;
  }
  await sendPlatformMail({ type: "ACCOUNT", to, ...(await templateMail("account.portal-code", values, { workspace: business })), logSubject: "A customer portal's sign-in code" });
}

export type CodeChecked = { ok: true } | { ok: false; error: string };

/** The code typed: right, and this browser is trusted for thirty days. */
export async function checkCode(loginId: string, typed: string, now = new Date()): Promise<CodeChecked> {
  const code = String(typed ?? "").replace(/\D/g, "");
  // R2-20: paused for too many wrong codes today — not even the right one is checked until it lifts.
  if (await codesLocked(loginId, now)) return { ok: false, error: LOCKED_TEXT };
  const live = await db.portalCode.findFirst({ where: { loginId, usedAt: null, expiresAt: { gt: now } }, orderBy: { createdAt: "desc" }, select: { id: true, codeHash: true, attempts: true } });
  if (!live) return { ok: false, error: "That code has run out — send yourself a new one." };
  /**
   * Security audit, 11 Nov 2026 (SEC-32): the try is claimed before the code is compared, in one conditional
   * statement — read-then-write let a burst of guesses sent at once all read the same count and each get a try, so the
   * limit held only for guesses sent one by one. Only a code with tries left gets one, whoever's request lands first.
   */
  const claimedTry = await db.portalCode.updateMany({ where: { id: live.id, usedAt: null, attempts: { lt: CODE_TRIES } }, data: { attempts: { increment: 1 } } });
  if (!claimedTry.count) return { ok: false, error: "That code has run out — send yourself a new one." };
  const right = code.length === CODE_DIGITS && timingSafeEqual(Buffer.from(live.codeHash), Buffer.from(codeHash(loginId, code)));
  if (!right) {
    const spent = await db.portalCode.updateMany({ where: { id: live.id, usedAt: null, attempts: { gte: CODE_TRIES } }, data: { usedAt: now } });
    // R2-20: this wrong code the one that pauses the link — the code goes, and the account manager hears, once.
    if ((await failedCodesToday(loginId, now)) === FAILED_CODES_A_DAY) {
      await db.portalCode.updateMany({ where: { loginId, usedAt: null }, data: { usedAt: now } });
      await tellLinkLocked(loginId);
      return { ok: false, error: LOCKED_TEXT };
    }
    const last = spent.count > 0 || ((await db.portalCode.findUnique({ where: { id: live.id }, select: { attempts: true } }))?.attempts ?? CODE_TRIES) >= CODE_TRIES;
    return { ok: false, error: last ? "That's not it, and that was the last try — send yourself a new code." : "That's not the code — check the email and try again." };
  }
  // Used once, here: of two tries at once with the right code, only one is let through.
  const claimed = await db.portalCode.updateMany({ where: { id: live.id, usedAt: null }, data: { usedAt: now } });
  if (!claimed.count) return { ok: false, error: "That code has run out — send yourself a new one." };
  const secret = randomBytes(32).toString("base64url");
  const expiresAt = new Date(now.getTime() + TRUST_DAYS * DAY);
  await db.portalDevice.create({ data: { loginId, secretHash: sha(secret), expiresAt } });
  (await cookies()).set(cookieName(loginId), secret, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", path: "/", expires: expiresAt });
  return { ok: true };
}
