import type { NotificationType } from "@prisma/client";
import { db } from "@/lib/db";
import { companyMailAllowed, platformMailerReplaced } from "@/lib/platform/mailer";
import { queuePlatformMail } from "@/lib/platform/mail/queue";
import { currentTenant, tenantOrigin } from "@/lib/tenancy/resolve";
import { holdNotificationEmail, isEmailed, notificationFrame, notificationWording } from "@/lib/notifications/email-settings";
import { inMailHours, mailHoursForChecks, nextMailHoursOpen } from "@/lib/notifications/email-hours";
import { workspaceClock } from "@/lib/time/workspace";
import { composeNotificationEmail } from "@/lib/notifications/email-template";
import { customerOfLink } from "@/lib/notifications/customer-of-link";
import { notificationLabel } from "@/lib/notifications/catalogue";

/**
 * A notification by email (owner, 18 Oct 2026): every kind the workspace's admins have switched on
 * under Settings › Email notifications (src/lib/notifications/email-settings.ts) — to begin with the
 * two that went by email before, a proforma issued on your deal and AI credits running low. One email
 * per notification, sent as it's raised, to the person's own address with a link to open it.
 *
 * It goes through the company's own mail server — Settings › Mail & messaging's route for
 * transactional mail — when one is set up, in the company's name; otherwise through Deskzo's "Alerts"
 * mail (console › Settings › Mail), in the company's name via Deskzo. If the company's server refuses
 * it, Deskzo sends it instead: the notification is for the person, and a broken server is the admin's
 * to fix, not the person's to miss it over.
 */

/** Why the person is getting it, at the foot of the email. AI_CREDITS: running low or used up (owner, 17 Oct 2026). */
const BECAUSE: Partial<Record<NotificationType, string>> = {
  PROFORMA_ISSUED: "You're getting this because it's one of your deals.",
  AI_CREDITS: "You're getting this because you manage this workspace's plan and billing.",
  FILING_DUE: "You're getting this because you keep this workspace's books.",
  CLOUD_CALLING_ALERT: "You're getting this because you manage this workspace's settings, where CallerDesk is connected.",
  COLLECTIONS_WEEKLY: "You're getting this because you were chosen for Arjun's Monday note in Settings › Deskzo AI.",
  SMART_LIST_REMINDER: "You're getting this because a Smart List's Date column was set to remind you.",
};

export type NotificationEmailRoute = "COMPANY" | "DESKZO";

/** The company's name as its mail shows it: its trade name, its legal name, or the workspace's own. */
async function companyName(): Promise<string> {
  const row = await db.organisationSettings.findUnique({ where: { id: "global" }, select: { tradeName: true, legalName: true } }).catch(() => null);
  return row?.tradeName?.trim() || row?.legalName.trim() || (await currentTenant()).name;
}

/**
 * An address at a domain reserved for examples and tests (RFC 2606, RFC 6761), which no mail reaches:
 * not sent at all, rather than bounced back to the company's server or Deskzo's. Check suites make
 * their people at these, so a run against a real workspace that emails a kind sends nothing — while
 * one that replaces the mailer still sees what would have gone.
 */
export function undeliverable(address: string): boolean {
  const domain = address.slice(address.lastIndexOf("@") + 1).toLowerCase();
  return /(^|\.)(invalid|test|example|localhost)$/.test(domain) || /(^|\.)example\.(com|net|org)$/.test(domain);
}

type Composed = { to: string; toName: string; subject: string; text: string; html: string; company: string; label: string; /** Copied (owner, 23 Nov 2026). */ cc?: string[] };

/**
 * The company's server when one is set up and takes it, Deskzo's otherwise; null for an address no mail
 * reaches. While a check has replaced Deskzo's mailer, its stand-in sees every address, and the company's
 * server is used only if the check says that server is a fake of its own (src/lib/platform/mailer.ts).
 * Throws only what Deskzo's says.
 */
async function deliver(mail: Composed): Promise<NotificationEmailRoute | null> {
  if (!platformMailerReplaced() && undeliverable(mail.to)) return null;
  // Each copy once, not the person it is to, and none to an address no mail reaches.
  const cc = [...new Set((mail.cc ?? []).map((e) => e.trim().toLowerCase()))].filter((e) => e && e !== mail.to.trim().toLowerCase() && (platformMailerReplaced() || !undeliverable(e)));
  const copied = cc.length ? { cc } : {};
  if (companyMailAllowed()) {
    const { emailRouteFor, deliverNow } = await import("@/lib/marketing/pipeline");
    if (await emailRouteFor("TRANSACTIONAL")) {
      const sent = await deliverNow({ to: mail.to, toName: mail.toName, fromName: mail.company, subject: mail.subject, html: mail.html, text: mail.text, ...copied }, "TRANSACTIONAL", { delivering: true });
      if (sent.ok) return "COMPANY";
      console.error("[email] the company's mail server didn't take a notification, so Deskzo sends it:", sent.error);
    }
  }
  // Queued (src/lib/platform/mail/queue.ts): tried at once in the background, then again if it fails.
  await queuePlatformMail({
    type: "ALERTS",
    to: mail.to,
    fromName: `${mail.company} via Deskzo`,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    ...copied,
    // The log keeps who it went to; what it said stays the workspace's.
    logSubject: `A workspace notification: ${mail.label}`,
  });
  return "DESKZO";
}

/**
 * Emails one notification if the workspace emails its kind; the way it went, or null when it didn't.
 * Never throws: a notification never fails the work that raised it.
 */
export async function sendEmailNotification(params: {
  userId: string;
  type: NotificationType;
  subject: string;
  body: string;
  link?: string | null;
  /** Sent now, whatever the hour: a held one going out when the hours open (src/lib/notifications/held-emails.ts). */
  release?: boolean;
  /**
   * Copied on it (owner, 23 Nov 2026 — Settings › Renewals' copies on the team's renewal reminders). Not kept on one held
   * for the hours: the reminder sweep, the one caller, sends a copied one only while they are open, with `release`.
   */
  cc?: string[];
}): Promise<NotificationEmailRoute | null> {
  try {
    if (!(await isEmailed(params.type))) return null;
    const user = await db.user.findUnique({ where: { id: params.userId }, select: { name: true, email: true, active: true, kind: true } });
    // Members only: a support login or the workspace's automation has no inbox of its own to tell.
    if (!user?.active || !user.email || user.kind !== "MEMBER") return null;
    // Between 10:00 and 17:45 on the workspace's clock (owner, 16 Nov 2026); outside them it waits until they open.
    if (!params.release) {
      const now = new Date();
      const checks = mailHoursForChecks();
      const clock = await workspaceClock();
      const open = checks ? checks(now) : platformMailerReplaced() || inMailHours(now, clock);
      if (!open && (await holdNotificationEmail({ userId: params.userId, type: params.type, subject: params.subject, body: params.body, link: params.link ?? null, sendAfter: nextMailHoursOpen(now, clock) }))) {
        return null;
      }
    }
    const [origin, company, words, frame, customer] = await Promise.all([tenantOrigin(), companyName(), notificationWording(params.type), notificationFrame(), customerOfLink(params.link)]);
    const url = params.link ? `${origin}${params.link}` : null;
    // The workspace's own wording where its admins wrote one (Settings › Email notifications), Deskzo's otherwise.
    const { subject, text, html } = composeNotificationEmail({
      words,
      frame,
      values: { name: user.name, company, customer, title: params.subject, message: params.body, reason: BECAUSE[params.type] ?? "You're getting this because it was addressed to you in Deskzo." },
      url,
    });
    return await deliver({ to: user.email, toName: user.name, subject, text, html, company, label: notificationLabel(params.type), ...(params.cc?.length ? { cc: params.cc } : {}) });
  } catch (err) {
    // The in-app one, where there is one, is already there.
    console.error("[email] notification email not sent", err instanceof Error ? err.message : err);
    return null;
  }
}
