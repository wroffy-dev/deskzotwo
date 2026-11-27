import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { getOrganisation } from "@/lib/organisation";
import { mailboxState, sendAsUser } from "@/lib/mail/mailbox";
import { deliverNow, emailRouteFor } from "@/lib/marketing/pipeline";
import { senderDisplayName } from "@/lib/documents/mail-route-labels";
import { textToHtml } from "@/lib/pipeline/automation-rules";

/**
 * A reseller's quote request link, emailed to them (src/lib/quote-requests.ts): from the sender's own mailbox when it is
 * connected, else the company's mail server with replies to them — as a project questionnaire goes. Logged in the email
 * log against the reseller, without the link, which is theirs alone.
 */
export async function emailRequestLink(input: {
  senderId: string;
  resellerId: string;
  contact: { id: string; name: string; email: string };
  link: string;
  note: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const [sender, mailbox, route, org] = await Promise.all([
    db.user.findUnique({ where: { id: input.senderId }, select: { id: true, name: true, email: true } }),
    mailboxState(input.senderId),
    emailRouteFor("TRANSACTIONAL"),
    getOrganisation(),
  ]);
  if (!sender) return { ok: false, error: "Your account wasn't found." };
  const first = input.contact.name.trim().split(/\s+/)[0] || "there";
  const ours = org.tradeName || org.legalName || "us";
  const subject = `Your link to ask ${ours} for a quotation`;
  const text = [
    `Hi ${first},`,
    "",
    input.note.trim() ||
      `Here is your own link to ask us for a quotation. Tell us what your customer needs, by when and where, and attach their RFQ if you have one — we'll send the quotation at your partner prices. Keep it: it works every time.`,
    "",
    input.link,
    "",
    "Thank you,",
    sender.name,
    ours,
  ].join("\n");
  const html = textToHtml(text);
  let from: string;
  if (mailbox.state === "connected") {
    const out = await sendAsUser(sender.id, { subject, html, to: [{ name: input.contact.name, email: input.contact.email }], attachments: [] });
    if (!out.ok) return { ok: false, error: `Your mailbox didn't send it: ${out.error}` };
    from = out.mailbox;
  } else if (route) {
    const out = await deliverNow({ to: input.contact.email, toName: input.contact.name, fromName: senderDisplayName(sender.name, ours), replyTo: sender.email, subject, html, text }, "TRANSACTIONAL", { delivering: true });
    if (!out.ok) return { ok: false, error: `The company's mail server didn't take it: ${out.error}` };
    from = out.fromEmail ?? out.provider;
  } else {
    return { ok: false, error: "You haven't a mailbox connected (My profile), and no mail server is set up for the company (Settings › Mail & messaging). Copy the link instead." };
  }
  const now = new Date();
  const logged = text.replace(input.link, "[their quote request link]");
  await db.marketingMessage.create({
    data: {
      token: randomBytes(24).toString("base64url"),
      companyId: input.resellerId,
      contactId: input.contact.id,
      channel: "EMAIL",
      messageClass: "TRANSACTIONAL",
      subject,
      body: textToHtml(logged),
      textBody: logged,
      toEmail: input.contact.email,
      status: "SENT",
      scheduledFor: now,
      sentAt: now,
      attempts: 1,
      sentByUserId: sender.id,
      fromEmail: from,
    },
  });
  return { ok: true };
}
