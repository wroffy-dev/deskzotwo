import { db } from "@/lib/db";
import { deliverNow, emailRouteFor } from "@/lib/marketing/pipeline";
import { escapeHtml } from "@/lib/marketing/html";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { deskzoAllowance, recordDeskzoSend } from "@/lib/documents/deskzo-mail-allowance";
import { senderDisplayName } from "@/lib/documents/mail-route-labels";
import { getOrganisation } from "@/lib/organisation";
import { workspaceClock } from "@/lib/time/workspace";
import { inviteMessage } from "@/lib/visitors/invite-code";

/**
 * A visitor's invitation, emailed to them (owner, 18 Nov 2026: "once the invitation code is generated for visitors
 * automatically mail to the visitor if mail id is provided; also mail and WhatsApp button there").
 *
 * The same words as the message the page copies (`inviteMessage`), the code set out large. It goes as the company's
 * other customer mail does: through the company's own mail server when one carries transactional mail, else through
 * Deskzo's, inside the person's and the company's daily allowance for it. Replies go to the host.
 */

export type InviteMailResult = { ok: true; to: string } | { ok: false; error: string };

/** Test seam: a check sees the email instead of anything being sent. */
let testMailer: ((mail: { to: string; subject: string; text: string; html: string; replyTo: string | null }) => Promise<void>) | null = null;
export function setInviteTestMailer(fn: typeof testMailer): void {
  testMailer = fn;
}

export async function emailVisitorInvite(inviteId: string, senderId: string): Promise<InviteMailResult> {
  const invite = await db.visitorInvite.findUnique({
    where: { id: inviteId },
    select: { name: true, email: true, code: true, status: true, expectedAt: true, host: { select: { name: true, email: true } } },
  });
  if (!invite) return { ok: false, error: "That invitation isn't there any more." };
  if (invite.status !== "PENDING") return { ok: false, error: "Only an invitation still waiting can be sent — this one has been used or cancelled." };
  const to = invite.email?.trim();
  if (!to || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to)) return { ok: false, error: "There's no email address for this visitor." };

  const [org, clock, sender] = await Promise.all([getOrganisation(), workspaceClock(), db.user.findUnique({ where: { id: senderId }, select: { name: true } })]);
  const business = org.tradeName || org.legalName || "our office";
  const when = clock.dateTimeShort(invite.expectedAt);
  const text = inviteMessage({ name: invite.name, code: invite.code, hostName: invite.host.name, companyName: business, expectedAt: invite.expectedAt, formatWhen: (d) => clock.dateTimeShort(d) });
  const subject = `Your visit to ${business} on ${when} — code ${invite.code}`;
  const html = [
    `<p>Hello ${escapeHtml(invite.name)},</p>`,
    `<p>You're expected at ${escapeHtml(business)} on <strong>${escapeHtml(when)}</strong> to see ${escapeHtml(invite.host.name)}.</p>`,
    `<p>When you arrive, enter this code on the tablet at reception:</p>`,
    `<p style="margin:16px 0;font:600 28px/1.2 'Courier New',monospace;letter-spacing:6px;color:#0f172a;background:#f1f5f9;border-radius:8px;padding:14px 18px;display:inline-block">${escapeHtml(invite.code)}</p>`,
    `<p>That's all you'll need — it saves filling the form in on the day. The code works on the day and the following morning.</p>`,
  ].join("\n");
  const replyTo = invite.host.email || null;
  const fromName = senderDisplayName(sender?.name ?? invite.host.name, business);

  if (testMailer) {
    await testMailer({ to, subject, text, html, replyTo });
    return { ok: true, to };
  }
  if (await emailRouteFor("TRANSACTIONAL")) {
    const sent = await deliverNow({ to, toName: invite.name, fromName, replyTo, subject, html, text }, "TRANSACTIONAL", { delivering: true });
    return sent.ok ? { ok: true, to } : { ok: false, error: `The email didn't go: ${sent.error}` };
  }
  // Deskzo's mail carries Deskzo's reputation: inside the person's and the company's daily limits.
  if ((await deskzoAllowance(senderId)).left < 1) return { ok: false, error: "Today's allowance for email sent through Deskzo is used up — copy the message and send it yourself." };
  try {
    await sendPlatformMail({ type: "DOCUMENTS", to, fromName: `${fromName} via Deskzo`, ...(replyTo ? { replyTo } : {}), subject, text, html, logSubject: "A workspace's visitor invitation" });
  } catch (err) {
    return { ok: false, error: `The email didn't go: ${err instanceof Error ? err.message : String(err)}` };
  }
  await recordDeskzoSend(senderId, null, 1);
  return { ok: true, to };
}
