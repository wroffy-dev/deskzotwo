import { queuePlatformMail } from "@/lib/platform/mail/queue";
import { brandedHtml, viaDeskzo } from "@/lib/platform/mail/templates";
import { platformMailerReplaced } from "@/lib/platform/mailer";

/** An address at a domain no mail reaches (RFC 2606/6761) — as src/lib/email.ts `undeliverable`: check fixtures live there. */
const undeliverable = (address: string) => /(^|\.)(invalid|test|example|localhost)$/i.test(address.slice(address.lastIndexOf("@") + 1)) || /(^|\.)example\.(com|net|org)$/i.test(address.slice(address.lastIndexOf("@") + 1));
import { currentTenant, tenantOrigin } from "@/lib/tenancy/resolve";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Security audit round two, 13 Nov 2026 (R2-12): every phone or tablet signed in to somebody's account — by a pairing
 * code or through the phone's browser — is told to them by email at once, with the phone, the time and the place, so a
 * sign-in they didn't make (another app on the phone starting the browser sign-in, a code read over a shoulder) is seen
 * the same day and can be signed out in Settings › Deskzo app.
 *
 * Always sent, whatever Settings › Email notifications says: it is account security, like a password reset. Deskzo's
 * own ACCOUNT mail, queued (src/lib/platform/mail/queue.ts), "<Workspace> via Deskzo". Written here rather than as a
 * console template because the template catalogue belongs to another part of the code; it should become a template
 * key ("account.new-phone") when that is next opened. Never throws: the sign-in has already happened.
 */
export async function tellOfPhoneSignIn(input: {
  user: { name: string; email: string };
  label: string;
  kind: "MOBILE" | "TABLET";
  via: "code" | "browser";
  at: Date;
  place: string | null;
  ip: string | null;
  needsApproval: boolean;
}): Promise<boolean> {
  try {
    if (!input.user.email || (!platformMailerReplaced() && undeliverable(input.user.email))) return false;
    const [tenant, origin, clock] = await Promise.all([currentTenant(), tenantOrigin(), workspaceClock()]);
    const what = input.kind === "TABLET" ? "tablet" : "phone";
    const where = [input.place, input.ip ? `address ${input.ip}` : null].filter(Boolean).join(", ") || "not known";
    const text = [
      `Hello ${input.user.name},`,
      `A ${what} ${input.via === "browser" ? "signed in to" : "was paired with"} your Deskzo account in ${tenant.name}.`,
      [`Device: ${input.label}`, `When: ${clock.dateTime(input.at)}`, `Where: ${where}`, `How: ${input.via === "browser" ? "through the phone's browser" : "with a pairing code"}`].join("\n"),
      input.needsApproval ? "It is waiting for an administrator to approve it before it can be used." : "",
      `If this was you, there's nothing to do. If it wasn't, sign it out now in Settings › Deskzo app (${origin}/settings/phone), change your password, and tell your administrator.`,
    ]
      .filter(Boolean)
      .join("\n\n");
    await queuePlatformMail(
      { type: "ACCOUNT", to: input.user.email, fromName: viaDeskzo(tenant.name), subject: `A ${what} signed in to your Deskzo account`, text, html: brandedHtml(text) },
      { tenant: tenant.id },
    );
    return true;
  } catch (err) {
    console.error("[app] the new-phone email could not be queued", err instanceof Error ? err.message : err);
    return false;
  }
}
