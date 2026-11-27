import { generateTotpSecret } from "@/lib/totp";

/**
 * The secret shown while somebody sets up an authenticator — kept on the *session* that asked, never on
 * the account (security audit, Nov 2026).
 *
 * It used to be kept on the account: made once, sealed onto the user row, and shown again to every
 * session of that user until enrolment finished. A session that had only passed the password step
 * could open the enrolment page, copy the secret and leave; when the real person later enrolled, they
 * scanned that same secret and whoever copied it held their second factor for good. A password reset
 * did not discard it either.
 *
 * Now each session gets a secret of its own, kept sealed on its own row. A reload in the same session
 * shows the same one (so a half-scanned QR code still works), another session never sees it, and only
 * the session that was shown it can turn it on. Used by the console, the CMS and the partner portal.
 */
export async function sessionPendingSecret(input: {
  /** The session row's sealed pending secret, when it has one. */
  stored: string | null;
  open: (sealed: string) => string;
  seal: (secret: string) => string;
  /** Saves a newly sealed secret onto the session row. */
  save: (sealed: string) => Promise<unknown>;
}): Promise<string> {
  if (input.stored) return input.open(input.stored);
  const secret = generateTotpSecret();
  await input.save(input.seal(secret));
  return secret;
}
