import { db } from "@/lib/db";
import { deliverNow, emailRouteFor } from "@/lib/marketing/pipeline";
import { escapeHtml } from "@/lib/marketing/html";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { deskzoAllowance, recordDeskzoSend } from "@/lib/documents/deskzo-mail-allowance";
import { senderDisplayName } from "@/lib/documents/mail-route-labels";
import { currentTenant } from "@/lib/tenancy/resolve";
import { channelSettings } from "@/lib/inbox/settings";

/**
 * A reply to a website visitor who has left (owner, 24 Oct 2026): emailed to them, where the channel says
 * so and they gave an email — through the company's mail server when it has one, else Deskzo's mail on
 * the company's behalf, inside the same daily limits as documents sent that way. No more than one in a
 * quarter of an hour, so a run of replies is one email. Replies to it go to whoever answered.
 */

/** Without the bubble on their screen this long, they've left. */
const GONE_MS = 2 * 60_000;
/** One email in this long, however many replies. */
const EVERY_MS = 15 * 60_000;

export type FollowUpMail = { to: string; subject: string; text: string; html: string; fromName: string; replyTo: string | null };
type Mailer = (mail: FollowUpMail) => Promise<void>;
let testMailer: Mailer | null = null;

/** For the checks: every follow-up comes here instead of a mail server. Null puts the mail back. */
export function setTestFollowUpMailer(mailer: Mailer | null) {
  testMailer = mailer;
}

/** The page they wrote from, without what came after it — the way back to the chat. */
function siteOf(pageUrl: string | null): string | null {
  if (!pageUrl) return null;
  try {
    const url = new URL(pageUrl);
    return url.protocol === "https:" || url.protocol === "http:" ? `${url.origin}${url.pathname}` : null;
  } catch {
    return null;
  }
}

/** Emails the reply when the visitor has left — the address it went to, or null when it didn't go. Throws only what a mail server said. */
export async function emailFollowUp(conversationId: string, senderId: string, reply: string, now = new Date()): Promise<string | null> {
  const c = await db.conversation.findUnique({ where: { id: conversationId }, select: { kind: true, customerName: true, customerEmail: true, pageUrl: true, channel: { select: { settings: true } } } });
  if (!c || c.kind !== "WEB" || !c.customerEmail || !channelSettings(c.channel.settings, "WEB").emailFollowUp) return null;
  // Read by name on its own: a workspace not migrated yet sends none.
  const seen = await db.conversation.findUnique({ where: { id: conversationId }, select: { lastSeenAt: true, followUpAt: true } }).catch(() => null);
  if (!seen?.lastSeenAt || now.getTime() - seen.lastSeenAt.getTime() < GONE_MS) return null;
  if (seen.followUpAt && now.getTime() - seen.followUpAt.getTime() < EVERY_MS) return null;
  // Claimed first, so two replies at once make one email.
  const claimed = await db.conversation.updateMany({
    where: { id: conversationId, OR: [{ followUpAt: null }, { followUpAt: { lt: new Date(now.getTime() - EVERY_MS) } }] },
    data: { followUpAt: now },
  });
  if (!claimed.count) return null;

  const sender = await db.user.findUnique({ where: { id: senderId }, select: { name: true, email: true } });
  let business = "the team";
  try {
    business = (await currentTenant()).name || business;
  } catch {
    // Named generically.
  }
  const agent = sender?.name?.trim().split(/\s+/)[0] || "Somebody";
  const first = c.customerName?.trim().split(/\s+/)[0] || null;
  const site = siteOf(c.pageUrl);
  const subject = `${agent} from ${business} replied to your chat`;
  const back = site ? `To answer, go back to ${site} and open the chat — your conversation is still there.` : "To answer, go back to the website and open the chat — your conversation is still there.";
  const text = [`Hi${first ? ` ${first}` : ""},`, "", `${agent} from ${business} replied while you were away:`, "", reply, "", back].join("\n");
  const html = [
    `<p>Hi${first ? ` ${escapeHtml(first)}` : ""},</p>`,
    `<p>${escapeHtml(agent)} from ${escapeHtml(business)} replied while you were away:</p>`,
    `<blockquote style="margin:12px 0;padding:10px 14px;border-left:3px solid #d0d5dd;color:#344054;white-space:pre-wrap">${escapeHtml(reply)}</blockquote>`,
    site ? `<p>To answer, go back to <a href="${escapeHtml(site)}">${escapeHtml(site)}</a> and open the chat — your conversation is still there.</p>` : `<p>${escapeHtml(back)}</p>`,
  ].join("\n");
  const mail: FollowUpMail = { to: c.customerEmail, subject, text, html, fromName: senderDisplayName(sender?.name ?? agent, business), replyTo: sender?.email || null };

  const unclaim = () => db.conversation.updateMany({ where: { id: conversationId, followUpAt: now }, data: { followUpAt: seen.followUpAt } }).catch(() => {});
  if (testMailer) {
    await testMailer(mail);
    return c.customerEmail;
  }
  if (await emailRouteFor("TRANSACTIONAL")) {
    const sent = await deliverNow({ to: mail.to, toName: c.customerName, fromName: mail.fromName, replyTo: mail.replyTo, subject, html, text }, "TRANSACTIONAL", { delivering: true });
    if (!sent.ok) {
      await unclaim();
      throw new Error(sent.error);
    }
    return c.customerEmail;
  }
  // Deskzo's mail carries Deskzo's reputation: inside the person's and the company's daily limits.
  if ((await deskzoAllowance(senderId)).left < 1) {
    await unclaim();
    return null;
  }
  try {
    await sendPlatformMail({ type: "DOCUMENTS", to: mail.to, fromName: `${mail.fromName} via Deskzo`, ...(mail.replyTo ? { replyTo: mail.replyTo } : {}), subject, text, html, logSubject: "A workspace's chat reply" });
  } catch (err) {
    await unclaim();
    throw err;
  }
  await recordDeskzoSend(senderId, null, 1);
  return c.customerEmail;
}
