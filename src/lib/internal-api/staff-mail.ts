import { internalActor } from "@/lib/internal-api/actor";
import { ConsoleRefused } from "@/lib/platform/refused";
import { sendPlatformMail } from "@/lib/platform/mailer";
import { templateMail } from "@/lib/platform/mail/templates";

/**
 * Mail about the admin app's own staff accounts, sent through the CRM's mail (the admin app has none of its
 * own): a new starter's or a reset's password link, and the note every other owner gets when an owner's
 * account changes. Only these three templates and that one plain note; only inside a verified internal call.
 */

const TEMPLATES = ["staff.setup", "staff.reactivated", "staff.passwordLink"] as const;
type StaffTemplate = (typeof TEMPLATES)[number];

export type StaffMail =
  | { to: string; template: StaffTemplate; values: { name: string; link: string } }
  | { to: string; ownerNotice: { subject: string; text: string } };

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

export async function sendStaffMail(mail: StaffMail): Promise<{ ok: true; data: null } | { ok: false; error: string }> {
  if (!internalActor()) throw new ConsoleRefused("Only the admin app sends staff mail.");
  const to = String(mail?.to ?? "").trim().toLowerCase();
  if (!EMAIL.test(to) || to.length > 254) return { ok: false, error: "That address can't be mailed." };
  try {
    if ("template" in mail) {
      if (!TEMPLATES.includes(mail.template)) return { ok: false, error: "No such staff email." };
      const name = String(mail.values?.name ?? "").slice(0, 100);
      const link = String(mail.values?.link ?? "");
      if (!/^https?:\/\/[^\s]+$/.test(link) || link.length > 500) return { ok: false, error: "That link can't be sent." };
      await sendPlatformMail({ type: "ACCOUNT", to, ...(await templateMail(mail.template, { name, link })) });
    } else {
      const subject = String(mail.ownerNotice?.subject ?? "").slice(0, 160);
      const text = String(mail.ownerNotice?.text ?? "").slice(0, 4000);
      if (!subject || !text) return { ok: false, error: "Nothing to send." };
      await sendPlatformMail({ type: "ALERTS", to, subject, text });
    }
    return { ok: true, data: null };
  } catch (err) {
    console.error("[internal-api] a staff email could not be sent", err);
    return { ok: false, error: "The email could not be sent. Try again in a few minutes." };
  }
}
