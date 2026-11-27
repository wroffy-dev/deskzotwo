/**
 * Tara re-engaging an existing customer (owner, 20 Nov 2026 — AI team step 4). Pure: who is quiet, when a customer is
 * somebody else's to talk to, the reply address, and what the model is asked. src/lib/reengage/server.ts does the rest.
 *
 *   · Quiet: no order or invoice for so many months (Settings › Deskzo AI, six by default), going by the customer's
 *     own stats (`CustomerStats.lastPurchaseAt`, src/lib/customers/stats.ts).
 *   · One voice per customer: no check-in while a renewal is coming, Arjun is chasing money, a lead is open, a campaign
 *     or journey email went in the last week, or one of Tara's check-ins went (or was turned down) not long ago.
 *   · One email, from the account manager's own mailbox, approved by them first. A cross-sell from what they bought —
 *     names, quantities and when, never a price.
 */

export const DEFAULT_MONTHS = 6;
export const MONTHS_MIN = 2;
export const MONTHS_MAX = 36;
export const PER_DAY_MAX = 100;
/** A subscription ending this soon belongs to its renewal manager. */
export const RENEWAL_WINDOW_DAYS = 60;
/** Arjun chased them this recently: money first. */
export const CHASE_QUIET_DAYS = 14;
/** A campaign, journey or any email from the workspace this recently: enough for now. */
export const MAIL_QUIET_DAYS = 7;
/** A check-in turned down ("Don't send") is not offered again for this long. */
export const SKIPPED_QUIET_DAYS = 90;

export const REENGAGE_STATUS_LABELS: Record<string, string> = { WAITING: "Waiting for you", SCHEDULED: "Approved", SENT: "Sent", SKIPPED: "Not sent" };

/** What the one-voice check reads of a customer — each a count or a date, gathered by the server. */
export type VoiceFacts = {
  hasAccountManager: boolean;
  /** Its last order or invoice, null when it never bought. */
  lastPurchaseAt: Date | null;
  renewalsDueSoon: number;
  chasedRecently: number;
  overdue: number;
  openLeads: number;
  mailedRecently: number;
  /** One of Tara's check-ins waiting, approved, or sent within the quiet months. */
  checkInLive: boolean;
  /** One turned down within SKIPPED_QUIET_DAYS. */
  checkInTurnedDown: boolean;
};

/** Why Tara shouldn't write to this customer now, in words — or null when she may. The first reason that holds wins. */
export function voiceReason(f: VoiceFacts, now: Date, months: number): string | null {
  if (!f.hasAccountManager) return "It has no account manager to send from";
  if (!f.lastPurchaseAt) return "It hasn't bought from you yet";
  if (f.lastPurchaseAt > monthsBefore(now, months)) return `It bought within the last ${months} months`;
  if (f.checkInLive) return "Tara has checked in with them already";
  if (f.checkInTurnedDown) return "A check-in was turned down not long ago";
  if (f.renewalsDueSoon) return `A renewal is due within ${RENEWAL_WINDOW_DAYS} days — that's its renewal manager's`;
  if (f.overdue > 0) return "Money is overdue — Arjun's first";
  if (f.chasedRecently) return `Arjun chased them in the last ${CHASE_QUIET_DAYS} days`;
  if (f.openLeads) return "A lead is open with them — that's the salesperson's";
  if (f.mailedRecently) return `They had an email from you in the last ${MAIL_QUIET_DAYS} days`;
  return null;
}

/** The same day `months` months earlier (the 31st becomes the month's last day). */
export function monthsBefore(now: Date, months: number): Date {
  const d = new Date(now);
  const day = d.getUTCDate();
  d.setUTCDate(1);
  d.setUTCMonth(d.getUTCMonth() - months);
  const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate();
  d.setUTCDate(Math.min(day, last));
  return d;
}

/** "8 months" / "a year" / "2 years and 3 months" — how long since, for the prompt and the card. */
export function sinceInWords(from: Date, now: Date): string {
  const months = Math.max(0, (now.getUTCFullYear() - from.getUTCFullYear()) * 12 + now.getUTCMonth() - from.getUTCMonth() - (now.getUTCDate() < from.getUTCDate() ? 1 : 0));
  if (months < 12) return months === 1 ? "a month" : `${months} months`;
  const years = Math.floor(months / 12);
  const rest = months % 12;
  const y = years === 1 ? "a year" : `${years} years`;
  return rest ? `${y} and ${rest === 1 ? "a month" : `${rest} months`}` : y;
}

// ─── The reply-to address ─────────────────────────────────────────────────────────────────────────────────────────

/** `<slug>+e-<token>@<domain>`: the workspace's own inbound address, as a nurture's `+n-`. */
export function checkInReplyAddress(slug: string, token: string, domain: string): string {
  return `${slug}+e-${token}@${domain}`;
}

/** The token in an address the inbound receiver was posted for, or null when it isn't a check-in reply. */
export function checkInTokenOf(recipient: string): string | null {
  const local = recipient.trim().toLowerCase().split("@")[0] ?? "";
  const m = /\+e-([0-9a-f]{24})$/.exec(local);
  return m ? m[1]! : null;
}

// ─── Writing it ───────────────────────────────────────────────────────────────────────────────────────────────────

export type Bought = { name: string; quantity: number; lastOn: string };

/** Tara's instructions — India's, or without India in them for a workspace elsewhere. */
export const checkInSystemFor = (india: boolean) =>
  [
    `You write one short check-in email from a B2B account manager${india ? " in India" : ""} to an existing customer who hasn't bought for a while.`,
    "Use ONLY the facts given. Never invent a fact, a name, a number, a price, a discount, an offer or a deadline. Never mention prices or money.",
    "Warm and specific: name one or two things they bought from us, ask how it is going, and — only if it fits — mention one of the",
    "other products given as something they might find useful. One clear, easy question to answer. Not a sales pitch, no pressure.",
    `Plain, polite ${india ? "Indian " : ""}business English.` + " Subject under 70 characters, no \"Re:\"; body under 110 words.",
    "Start the body with \"Hi {{firstName}},\" and end it with \"{{senderName}}\" on its own line. No links, attachments or signatures.",
    "Call propose_email exactly once.",
  ].join(" ");

/** What the model reads: what they bought, how long since, and a few other things the workspace sells. Names only. */
export function checkInPrompt(input: { companyName: string; since: string; bought: Bought[]; others: string[] }): string {
  const lines = [`Customer: ${input.companyName}. Their last order or invoice was ${input.since} ago.`];
  lines.push("", "What they bought from us (product, quantity, when last):");
  for (const b of input.bought) lines.push(`— ${b.name} × ${b.quantity}, last ${b.lastOn}`);
  if (!input.bought.length) lines.push("— (no product lines on file — keep it general)");
  if (input.others.length) lines.push("", `Other things we sell that customers like them buy: ${input.others.join("; ")}.`);
  lines.push("", "Write the check-in email.");
  return lines.join("\n");
}
