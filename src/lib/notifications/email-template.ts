import { fieldsIn, fillTemplate } from "@/lib/console-shared/mail-template-engine";

/**
 * Notification emails as templates (owner, 16 Nov 2026: "make notification emails editable template"). The
 * workspace's admins edit them under Settings › Email notifications: each kind's subject and body, and the frame
 * every one goes in — the greeting, the sign-off and the footer. Pure and client-safe, so the settings screen
 * previews with exactly what src/lib/email.ts sends.
 *
 * The rules are the console's (src/lib/console-shared/mail-template-engine.ts): {field} is filled in, and [[ … ]]
 * is an optional part, left out when a field inside it is empty. What Deskzo would have said is a field of its
 * own — {title} and {message} — so a kind's wording can be put around it and still carry the customer, the item
 * and the days left that change with every email.
 *
 * {customer} (owner, 18 Nov 2026) is the company the notification is about, read from the record its link opens
 * (src/lib/notifications/customer-of-link.ts) — empty for one about no customer, so put it inside [[ … ]].
 */

export const NOTIFICATION_FIELDS = {
  name: { about: "the person it's for", sample: "Sachin Chauhan" },
  company: { about: "your company's name", sample: "Wroffy Technologies Pvt Ltd" },
  title: { about: "the notification's heading, as the bell shows it", sample: "Subscription ends in 15 days — nobody looks after it" },
  message: { about: "the notification's words, as the bell shows them", sample: "Sentra.world Technologies — Microsoft 365 Business Premium: no renewal manager or account manager still here. Give the customer one." },
  customer: { about: "the customer it's about, where there is one", sample: "Sentra.world Technologies" },
  reason: { about: "why this person gets it, where Deskzo knows", sample: "You're getting this because it was addressed to you in Deskzo." },
} as const;
export type NotificationField = keyof typeof NOTIFICATION_FIELDS;

/** Which fields each part may use. */
export const PART_FIELDS = {
  subject: ["title", "customer", "company", "name"],
  body: ["message", "title", "customer", "company", "name"],
  greeting: ["name", "company"],
  signOff: ["company", "name"],
  footer: ["reason", "company"],
} as const satisfies Record<string, readonly NotificationField[]>;
export type NotificationPart = keyof typeof PART_FIELDS;

/** Deskzo's own wording: what goes out until an admin writes their own. */
export const DEFAULT_PARTS: Record<NotificationPart, string> = {
  subject: "{title}",
  body: "{message}",
  greeting: "Hello {name},",
  signOff: "— {company}, on Deskzo",
  footer: "{reason} Your workspace's admins choose which notifications are emailed, under Settings › Email notifications.",
};

/** The longest each part may be. */
export const PART_LIMITS: Record<NotificationPart, number> = { subject: 200, body: 4000, greeting: 200, signOff: 300, footer: 600 };

export type NotificationEmailWords = { subject?: string | null; body?: string | null };
/** The frame: every email's greeting, sign-off and footer, and a subject and message for the kinds without their own. */
export type NotificationEmailFrame = { subject?: string | null; body?: string | null; greeting?: string | null; signOff?: string | null; footer?: string | null };

/** What's wrong with an admin's wording for one part; null when it can be saved. Blank means Deskzo's. */
export function partProblem(part: NotificationPart, text: string): string | null {
  const value = text.trim();
  if (!value) return null;
  if (value.length > PART_LIMITS[part]) return `Keep it to ${PART_LIMITS[part]} characters.`;
  const allowed = PART_FIELDS[part] as readonly string[];
  const unknown = fieldsIn(value).filter((f) => !allowed.includes(f));
  if (unknown.length) return `${unknown.map((f) => `{${f}}`).join(", ")} can't be used here. You can use ${allowed.map((f) => `{${f}}`).join(", ")}.`;
  if (part === "subject" && /[\r\n]/.test(value)) return "A subject is one line.";
  return null;
}

/** An admin's wording for a part, or Deskzo's where it's blank or can't be used. */
export function partText(part: NotificationPart, stored: string | null | undefined): string {
  const value = (stored ?? "").trim();
  return value && partProblem(part, value) === null ? value : DEFAULT_PARTS[part];
}

export type ComposedNotificationEmail = { subject: string; text: string; html: string };

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const paragraphsHtml = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");

/**
 * The email for one notification: the kind's wording inside the workspace's frame. A subject that comes out empty
 * is the notification's own heading, and a body that comes out empty is its own words, so an email is never blank.
 */
export function composeNotificationEmail(input: {
  words?: NotificationEmailWords | null;
  frame?: NotificationEmailFrame | null;
  values: { name: string; company: string; title: string; message: string; reason: string; customer?: string };
  url: string | null;
}): ComposedNotificationEmail {
  const v = { ...input.values, customer: input.values.customer ?? "" };
  const fill = (part: NotificationPart, stored: string | null | undefined) => fillTemplate(partText(part, stored), v).trim();
  // The kind's own subject, else the frame's — each only where it can be used — else Deskzo's, "{title}".
  const ownSubject = (input.words?.subject ?? "").trim();
  const subjectTemplate = ownSubject && partProblem("subject", ownSubject) === null ? ownSubject : input.frame?.subject;
  const subject = fill("subject", subjectTemplate).replace(/\s+/g, " ") || v.title;
  // The same for the message: the kind's own, else the frame's (owner, 18 Nov 2026), else Deskzo's, "{message}".
  const ownBody = (input.words?.body ?? "").trim();
  const bodyTemplate = ownBody && partProblem("body", ownBody) === null ? ownBody : input.frame?.body;
  const body = fill("body", bodyTemplate) || v.message.trim();
  const greeting = fill("greeting", input.frame?.greeting);
  const signOff = fill("signOff", input.frame?.signOff);
  const footer = fill("footer", input.frame?.footer);

  const text = [greeting, body, input.url ? `Open it: ${input.url}` : "", signOff, footer].filter(Boolean).join("\n\n");
  const html = [
    `<div style="font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:1.5;color:#1f2937">`,
    greeting ? `<p>${escapeHtml(greeting)}</p>` : "",
    paragraphsHtml(body),
    input.url ? `<p><a href="${escapeHtml(input.url)}">Open it in Deskzo</a></p>` : "",
    signOff ? `<p>${escapeHtml(signOff).replace(/\n/g, "<br>")}</p>` : "",
    footer ? `<p style="font-size:12px;color:#6b7280">${escapeHtml(footer).replace(/\n/g, "<br>")}</p>` : "",
    `</div>`,
  ].join("");
  return { subject, text, html };
}
