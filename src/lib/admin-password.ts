import { randomInt } from "node:crypto";

/**
 * An admin resetting somebody's password (src/actions/user.ts `sendPasswordResetEmail`,
 * `resetPasswordToTemporary`): the temporary password and the link's lifetime. The two emails are the
 * `account.admin-reset` and `account.temporary-reset` templates (owner, 1 Nov 2026 —
 * src/lib/console-shared/mail-templates/signing-in.ts).
 *
 * The owner chose (3 Oct 2026) that an admin may reset a password two ways: a one-click email with a link
 * to choose a new one, or a temporary password the app makes up and shows the admin once. The admin never
 * picks the password, so it is never a weak or reused one. The person is signed out everywhere and must
 * choose their own when they next sign in.
 */

/** No 0/O, 1/l/I: it is read off a screen and typed by somebody else. */
const UPPER = "ABCDEFGHJKLMNPQRSTUVWXYZ";
const LOWER = "abcdefghijkmnpqrstuvwxyz";
const DIGITS = "23456789";
const ALL = UPPER + LOWER + DIGITS;

/** How long the emailed link works. Longer than "Forgot your password?"'s hour: the admin sent it, not the person. */
export const ADMIN_RESET_LINK_TTL_MS = 24 * 60 * 60_000;

/**
 * Twelve characters in three groups — `Kq7m-Xp4t-9Rwz` — about 69 bits, with a capital, a small letter
 * and a digit always among them. Made with the system's secure random numbers, never `Math.random`.
 */
export function temporaryPassword(): string {
  for (;;) {
    const chars = Array.from({ length: 12 }, () => ALL[randomInt(ALL.length)]!);
    const has = (set: string) => chars.some((c) => set.includes(c));
    if (has(UPPER) && has(LOWER) && has(DIGITS)) return `${chars.slice(0, 4).join("")}-${chars.slice(4, 8).join("")}-${chars.slice(8).join("")}`;
  }
}
