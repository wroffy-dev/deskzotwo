import { createHash, randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { targetWithinActorAuthority } from "@/lib/authz/borrow";
import { AWAITING_SETUP } from "@/lib/no-password";
import { isAutomationKind, isSystemAddress, PEOPLE_ONLY } from "@/lib/people";
import { templateMail } from "@/lib/platform/mail/templates";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { credentialLinkOrigin, currentTenant } from "@/lib/tenancy/resolve";

/**
 * The setup email: how the person behind a new workspace account chooses their own password.
 *
 * Nobody hands anybody a password. Every account an admin adds (src/actions/user.ts, `createUser`), every
 * candidate HR converts (src/actions/candidate.ts) and every account an import creates
 * (src/lib/portability/importers/users.ts) starts with no usable password (src/lib/no-password.ts), and its
 * person chooses their own from a one-time link. Until they do, the account shows as "Invitation pending" on
 * Users & access, where "Resend setup email" replaces the link. The signup owner and a bootstrapped owner are
 * not made here: they chose their password themselves.
 *
 * `mustChangePassword` is not set on these accounts: there is no password to change, and the one the person
 * chooses is their own.
 *
 * ## The link
 *
 * A password link of the kind "Forgot your password?" sends (src/actions/password-reset.ts) — one row in
 * `password_reset_tokens`, only its SHA-256 kept, once, for three days (as the platform's other setup links).
 * Issuing one replaces any unused link the account has, as asking again from the sign-in page does. It goes
 * to `/reset-password?t=…&setup=1`, or with `&link=1` for the one-step invite of linked sign-in: somebody the
 * admin says already uses another workspace on this platform, whose page also offers to link the two. Both
 * flags only change what the page shows; neither proves or opens anything.
 *
 * The email goes only from Deskzo's own mail (src/lib/platform/mailer.ts), as "<Workspace> via Deskzo", in
 * the wording of the `account.setup` / `account.setup-linking` templates (owner, 1 Nov 2026) — never through
 * the workspace's own providers any more. When it can't be sent, the link comes back instead, once, for
 * whoever asked to pass on; it is never stored or logged.
 *
 * ## Who may be handed the link
 *
 * The link is the power to choose the account's password and sign in as it — more than adding the account
 * was. So it comes back only to somebody who could have made the account with everything it holds now:
 * a super admin, or somebody who holds all of it themselves (`mayPassOnSetupLink`, createUser's rule for a
 * new account's role applied to the account as it is). Anybody else is told the email couldn't be sent,
 * and the link stays with the email that failed. Resending the email itself, to the person's own address,
 * gives nobody anything.
 */

export const SETUP_LINK_TTL_MS = 3 * 24 * 60 * 60_000;

type Actor = { id: string; isSuperAdmin: boolean };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Whether this account is still waiting for its person to choose a password — asked of the database, so no stored value is read. */
export async function awaitingSetup(userId: string): Promise<boolean> {
  // A person's account only: the Automation account's placeholder is permanent, not an invitation.
  return (await db.user.count({ where: { id: userId, ...PEOPLE_ONLY, ...AWAITING_SETUP } })) > 0;
}

/**
 * The email's template (src/lib/console-shared/mail-templates/signing-in.ts). It names this workspace only.
 * `linking` is the one-step invite's wording, which never names the other workspace — nobody here knows it.
 */
function setupTemplate(linking: boolean): string {
  return linking ? "account.setup-linking" : "account.setup";
}

/** A failure described without anything it might quote: the error's code, or its kind. */
function codeOf(err: unknown): string {
  const code = (err as { code?: unknown } | null)?.code;
  if (typeof code === "string" && /^[\w.-]{1,40}$/.test(code)) return code;
  return err instanceof Error ? err.name : "error";
}

/**
 * Whether `actor` may be handed this account's setup link: a super admin may; anybody else only while they
 * hold everything the account holds — its permissions, its reach over records and its view of sensitive fields.
 */
export async function mayPassOnSetupLink(actor: Actor, userId: string): Promise<boolean> {
  // Keys, record reach and field policy alike (security audit, Nov 2026) — see targetWithinActorAuthority.
  return targetWithinActorAuthority(actor, userId);
}

/**
 * `emailed: true`, or the link for whoever asked to pass on — shown to them once, never stored. Without it
 * when the link couldn't be issued, or they may not be handed it (`mayPassOnSetupLink`): then "Resend setup
 * email" is the way to try again.
 */
export type SetupInvitation = { emailed: true } | { emailed: false; setupUrl?: string };

/**
 * Issues the account's setup link — replacing any unused password link it has — and emails it to the
 * account's own address. `by` is who asked: the one the link comes back to when the email can't be sent, if
 * they may have it. Never throws; a failure is logged by its code only.
 */
export async function sendSetupInvitation(user: { id: string; name: string; email: string }, options: { by: Actor; linking?: boolean }): Promise<SetupInvitation> {
  const linking = options.linking === true;
  let url: string;
  let workspace: string;
  try {
    // Never for the Automation account (src/lib/automation-user.ts): nobody chooses its password.
    const account = await db.user.findUnique({ where: { id: user.id }, select: { kind: true, email: true } });
    if (!account || isAutomationKind(account.kind) || isSystemAddress(account.email)) return { emailed: false };
    const tenant = await currentTenant();
    const token = randomBytes(32).toString("base64url");
    await db.$transaction(async (tx) => {
      await tx.passwordResetToken.deleteMany({ where: { userId: user.id, usedAt: null } });
      await tx.passwordResetToken.create({ data: { tokenHash: sha256(token), userId: user.id, expiresAt: new Date(Date.now() + SETUP_LINK_TTL_MS) } });
    });
    url = `${await credentialLinkOrigin(tenant)}/reset-password?t=${encodeURIComponent(token)}&${linking ? "link" : "setup"}=1`;
    workspace = tenant.name;
  } catch (err) {
    console.error(`[setup] a setup link could not be issued: ${codeOf(err)}`);
    return { emailed: false };
  }
  try {
    // Deskzo's mail only, as "<Workspace> via Deskzo" (owner, 1 Nov 2026).
    await sendPlatformMail({ type: "ACCOUNT", to: user.email, ...(await templateMail(setupTemplate(linking), { name: user.name, workspace, url }, { workspace })) });
    return { emailed: true };
  } catch (err) {
    console.error(`[setup] a setup email could not be sent: ${codeOf(err)}`);
  }
  try {
    return (await mayPassOnSetupLink(options.by, user.id)) ? { emailed: false, setupUrl: url } : { emailed: false };
  } catch (err) {
    console.error(`[setup] who may have a setup link could not be worked out: ${codeOf(err)}`);
    return { emailed: false };
  }
}
