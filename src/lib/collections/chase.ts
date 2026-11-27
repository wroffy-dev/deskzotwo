import { z } from "zod";
import type { FollowUpChannel } from "@prisma/client";
import type { ToolSpec } from "@/lib/copilot/types";
import { baseCurrency, formatMoney, formatMoneyWhole } from "@/lib/currency";
import { dayKey, followUpChannelLabels, shortDay } from "@/lib/collections/rules";

/**
 * Arjun, the Collections teammate (owner, 19 Nov 2026 — "Build phases 1 and 2"), without a database: who to chase today
 * and why, the brief for a call, the words of a chase email and what a customer's reply means. Pure, so the page, the
 * server (./chase-server.ts) and check:collection-chase read the same answers.
 *
 *   · **Who to chase today** is worked out by rules, not AI — free, the same for everybody, and every line of it can be
 *     checked against the books: how much is overdue and how late, a promise broken or due today, a follow-up planned,
 *     nobody in touch for a while, and whether this customer usually pays on time.
 *   · **The call brief** is the same facts, written for the person about to phone. Also rules.
 *   · **The chase email** is Deskzo AI's, from facts it is handed: amounts, dates, invoice numbers, promises and what the
 *     customer said in follow-ups — never a person's name, email address or phone number. The list of invoices, with
 *     their pay-now links, is put in by Deskzo where the email says {{invoices}}, so its numbers are the books' own; and
 *     an email naming an amount that isn't one of the facts is sent back to be written again.
 *   · **A reply** is read by Deskzo AI for a promise to pay, a payment they say they made, a dispute or a question —
 *     nothing is done with it until a person says so.
 */

const DAY = 86_400_000;

// ─── Facts about one customer ─────────────────────────────────────────────────────────────────────────────────────

/** How a promise on a due stands today: still ahead, due today, broken, or kept. */
export type PromiseNow = "ahead" | "today" | "broken" | "kept";

export type DueFact = {
  id: string;
  kind: "invoice" | "order";
  /** INV-0012 / ORD-000034. */
  label: string;
  dueOn: Date;
  daysLate: number;
  /** Still to pay, in its own currency. */
  balance: number;
  currency: string;
  /** Still to pay in the base currency, at its own rate — for totals. */
  balanceInr: number;
  promise: { on: string; amount: number | null; now: PromiseNow } | null;
};

export type CompanyFacts = {
  companyId: string;
  companySeq: number;
  companyName: string;
  ownerName: string | null;
  /** In the person's own account scope — the company page opens for them. */
  onTheirAccount: boolean;
  dues: DueFact[];
  lastFollowUp: { at: Date; channel: FollowUpChannel; remarks: string; byName: string | null } | null;
  /** `yyyy-mm-dd` of the next follow-up somebody planned, if any. */
  plannedOn: string | null;
  promisesKept: number;
  promisesBroken: number;
  /** Reminders paused for this customer (a dispute, an arrangement) — never chased while they are. */
  paused: { reason: string | null } | null;
  /** The schedule's last reminder to them, and Arjun's last email sent. */
  lastReminderAt: Date | null;
  lastChaseAt: Date | null;
  /** Typical days between due date and payment on their invoices paid this past year; null without enough of them. */
  usualDaysLate: number | null;
};

/** "₹3.2L", "₹45,000", "₹1.2Cr" — the base currency, short; lakhs and crores for rupees. */
export function shortMoney(n: number, code = baseCurrency()): string {
  const v = Math.round(n);
  if (code !== "INR") return formatMoneyWhole(v, code);
  const one = (x: number) => String(Math.round(x * 10) / 10);
  if (v >= 1e7) return `₹${one(v / 1e7)}Cr`;
  if (v >= 1e5) return `₹${one(v / 1e5)}L`;
  return `₹${v.toLocaleString("en-IN")}`;
}

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;
const ago = (days: number) => (days <= 0 ? "today" : days === 1 ? "yesterday" : `${days} days ago`);
const daysBetween = (from: Date, to: Date) => Math.floor((to.getTime() - from.getTime()) / DAY);

/** The dues worth chasing now: late, and not covered by a promise still ahead — plus any whose promise was broken. */
export function chaseDues(f: CompanyFacts): DueFact[] {
  return f.dues.filter((d) => d.balance >= 0.5 && (d.promise?.now === "broken" || (d.daysLate > 0 && d.promise?.now !== "ahead" && d.promise?.now !== "today")));
}

// ─── Who to chase today ───────────────────────────────────────────────────────────────────────────────────────────

export type ChaseAction = "CALL" | "EMAIL" | "CHECK";
export const CHASE_ACTION_LABELS: Record<ChaseAction, string> = { CALL: "Call", EMAIL: "Email", CHECK: "Check it came in" };

export type ChaseItem = {
  companyId: string;
  companySeq: number;
  companyName: string;
  ownerName: string | null;
  onTheirAccount: boolean;
  action: ChaseAction;
  score: number;
  /** Why, a fact a line — the first is always how much and how late. */
  reasons: string[];
  /** Overdue (and broken-promise) money, in the base currency. */
  chaseInr: number;
  oldestDaysLate: number;
  /** An email can be written: at least one invoice to put in it. */
  mayEmail: boolean;
  /** A promise to pay on one of the dues was broken. */
  broken: boolean;
  /** A chase email or the schedule's reminder went to them in the last five days. */
  emailedLately: boolean;
};

/**
 * Who to chase today, most pressing first. `today` is the workspace's calendar day (midnight UTC); `now` the moment.
 * A customer whose reminders are paused, or with nothing late, broken or promised for today, isn't listed.
 */
export function rankChases(list: CompanyFacts[], today: Date, now: Date, take = 10): ChaseItem[] {
  const todayKey = dayKey(today);
  const out: ChaseItem[] = [];
  for (const f of list) {
    if (f.paused) continue;
    const dues = chaseDues(f);
    const broken = f.dues.filter((d) => d.promise?.now === "broken" && d.balance >= 0.5);
    const dueToday = f.dues.filter((d) => d.promise?.now === "today" && d.balance >= 0.5);
    if (dues.length === 0 && dueToday.length === 0) continue;

    const chaseInr = Math.round(dues.reduce((t, d) => t + d.balanceInr, 0) * 100) / 100;
    const oldest = dues.reduce((m, d) => Math.max(m, d.daysLate), 0);
    let score = (dues.length ? 10 * Math.log10(chaseInr + 1) : 0) + Math.min(oldest, 120) / 3;
    const reasons: string[] = [];
    if (dues.length) {
      const what = dues.every((d) => d.kind === "invoice") ? plural(dues.length, "invoice", "invoices") : plural(dues.length, "due", "dues");
      reasons.push(`${shortMoney(chaseInr)} overdue on ${what}${oldest > 0 ? `, the oldest ${plural(oldest, "day", "days")} late` : ""}`);
    }
    let action: ChaseAction | null = null;

    if (broken.length) {
      const p = broken[0]!.promise!;
      const amount = p.amount !== null ? formatMoney(p.amount, broken[0]!.currency) : null;
      score += 30;
      reasons.push(`Promised ${amount ? `${amount} ` : "to pay "}by ${shortDay(p.on)} — it didn't come`);
      action = "CALL";
    }
    if (dueToday.length) {
      const p = dueToday[0]!.promise!;
      score += 20;
      reasons.push(`Promised to pay ${p.amount !== null ? `${formatMoney(p.amount, dueToday[0]!.currency)} ` : ""}today — check it came in`);
      action ??= "CHECK";
    }
    if (f.plannedOn && f.plannedOn <= todayKey) {
      score += 15;
      reasons.push(f.plannedOn === todayKey ? "You planned to follow up today" : `You planned to follow up on ${shortDay(f.plannedOn)}`);
    }

    // The last time anybody was in touch: a follow-up logged, the schedule's reminder, or a chase email.
    const touches = [
      f.lastFollowUp ? { at: f.lastFollowUp.at, what: `Followed up by ${followUpChannelLabels[f.lastFollowUp.channel].toLowerCase()}` } : null,
      f.lastReminderAt ? { at: f.lastReminderAt, what: "The schedule's reminder went" } : null,
      f.lastChaseAt ? { at: f.lastChaseAt, what: "Emailed" } : null,
    ].filter((t): t is { at: Date; what: string } => !!t);
    const last = touches.sort((a, b) => b.at.getTime() - a.at.getTime())[0] ?? null;
    if (!last) {
      score += 10;
      reasons.push("Nobody has followed up yet");
    } else {
      const since = daysBetween(last.at, now);
      if (since >= 14) {
        score += 10;
        reasons.push(`Nobody in touch for ${since} days`);
      } else if (since <= 2) {
        score -= 25;
        reasons.push(`${last.what} ${ago(since)}`);
      }
    }

    const unusual = f.usualDaysLate !== null && f.usualDaysLate <= 5 && oldest >= 15;
    if (unusual) {
      score += 10;
      reasons.push("Usually pays on time — this isn't like them");
    } else if (f.usualDaysLate !== null && f.usualDaysLate >= 30) {
      reasons.push(`Usually pays about ${f.usualDaysLate} days late`);
    }

    // What to do: a phone for a broken promise, a big or very late sum, a good payer gone quiet, or anybody emailed in
    // the last few days; an email otherwise.
    const emailedLately = [f.lastChaseAt, f.lastReminderAt].some((at) => at && daysBetween(at, now) <= 5);
    action ??= oldest >= 45 || chaseInr >= 500_000 || unusual || emailedLately ? "CALL" : "EMAIL";

    out.push({
      companyId: f.companyId,
      companySeq: f.companySeq,
      companyName: f.companyName,
      ownerName: f.ownerName,
      onTheirAccount: f.onTheirAccount,
      action,
      score: Math.round(score * 10) / 10,
      reasons,
      chaseInr,
      oldestDaysLate: oldest,
      mayEmail: f.dues.some((d) => d.kind === "invoice" && d.balance >= 0.5 && (d.daysLate > 0 || d.promise?.now === "broken")),
      broken: broken.length > 0,
      emailedLately,
    });
  }
  return out.sort((a, b) => b.score - a.score || b.chaseInr - a.chaseInr).slice(0, take);
}

// ─── The call brief ───────────────────────────────────────────────────────────────────────────────────────────────

export type CallBrief = {
  headline: string;
  dues: { label: string; due: string; late: string; balance: string; promise: string | null }[];
  lines: { label: string; text: string }[];
  /** What to ask for, in a sentence. */
  ask: string;
};

/** The calendar day `n` days after `day`, moved off a Sunday. */
export function askByDay(day: Date, n = 3): Date {
  const d = new Date(day.getTime() + n * DAY);
  return d.getUTCDay() === 0 ? new Date(d.getTime() + DAY) : d;
}

const WEEKDAY = new Intl.DateTimeFormat("en-IN", { weekday: "long", day: "numeric", month: "short", timeZone: "UTC" });

/** What somebody about to phone the customer needs, from the books and the follow-ups. */
export function callBrief(f: CompanyFacts, today: Date, now: Date): CallBrief {
  const dues = chaseDues(f);
  const owed = f.dues.reduce((t, d) => t + d.balanceInr, 0);
  const overdue = dues.reduce((t, d) => t + d.balanceInr, 0);
  const oldest = dues.reduce((m, d) => Math.max(m, d.daysLate), 0);
  const headline =
    overdue > 0
      ? `${shortMoney(owed)} owed, ${shortMoney(overdue)} of it overdue${oldest > 0 ? ` — the oldest ${plural(oldest, "day", "days")} late` : ""}.`
      : `${shortMoney(owed)} owed, none of it overdue.`;

  const lines: CallBrief["lines"] = [];
  const promised = f.dues.find((d) => d.promise && d.promise.now !== "kept")?.promise ?? null;
  const history = f.promisesKept + f.promisesBroken > 0 ? `${plural(f.promisesKept, "promise", "promises")} kept, ${f.promisesBroken} broken` : "No promises before";
  lines.push({
    label: "Promises",
    text: promised
      ? `${history}. Now: ${promised.amount !== null ? "an amount" : "to pay"} by ${shortDay(promised.on)} — ${promised.now === "broken" ? "broken" : promised.now === "today" ? "due today" : "not due yet"}.`
      : `${history}.`,
  });
  if (f.lastFollowUp) {
    const by = f.lastFollowUp.byName ? `, ${f.lastFollowUp.byName}` : "";
    lines.push({ label: "Last time", text: `${shortDay(f.lastFollowUp.at.toISOString())} by ${followUpChannelLabels[f.lastFollowUp.channel].toLowerCase()}${by}: “${f.lastFollowUp.remarks}”` });
  } else {
    lines.push({ label: "Last time", text: "Nobody has followed up yet." });
  }
  if (f.usualDaysLate !== null) {
    lines.push({ label: "Usually", text: f.usualDaysLate <= 5 ? "Pays on time." : `Pays about ${f.usualDaysLate} days after the due date.` });
  }
  const emails = [
    f.lastReminderAt ? `the schedule's reminder ${ago(daysBetween(f.lastReminderAt, now))}` : null,
    f.lastChaseAt ? `a chase email ${ago(daysBetween(f.lastChaseAt, now))}` : null,
  ].filter(Boolean);
  if (emails.length) lines.push({ label: "Emails", text: `Last: ${emails.join("; ")}.` });

  const by = WEEKDAY.format(askByDay(today));
  const labels = dues.filter((d) => d.kind === "invoice").map((d) => d.label);
  const which = labels.length ? ` (${labels.slice(0, 4).join(", ")}${labels.length > 4 ? ` and ${labels.length - 4} more` : ""})` : "";
  const brokenDue = f.dues.find((d) => d.promise?.now === "broken");
  const todayDue = f.dues.find((d) => d.promise?.now === "today");
  const ask = brokenDue
    ? `Remind them they promised ${brokenDue.promise!.amount !== null ? formatMoney(brokenDue.promise!.amount, brokenDue.currency) : "to pay"} by ${shortDay(brokenDue.promise!.on)}. Ask for ${shortMoney(overdue)}${which} — or a part today and a new date they'll keep.`
    : todayDue && overdue === 0
      ? `They promised to pay today. Check it came in before you call; if it didn't, ask when it went and its UTR.`
      : `Ask for ${shortMoney(overdue)}${which} by ${by}.`;

  return {
    headline,
    dues: [...f.dues]
      .sort((a, b) => b.daysLate - a.daysLate)
      .map((d) => ({
        label: d.label,
        due: shortDay(d.dueOn.toISOString()),
        late: d.daysLate > 0 ? `${plural(d.daysLate, "day", "days")} late` : "Not yet due",
        balance: formatMoney(d.balance, d.currency),
        promise: d.promise && d.promise.now !== "kept" ? `Promised by ${shortDay(d.promise.on)}${d.promise.now === "broken" ? " — broken" : ""}` : null,
      })),
    lines,
    ask,
  };
}

// ─── The chase email ──────────────────────────────────────────────────────────────────────────────────────────────

export type ChaseTone = "gentle" | "firm" | "broken" | "final";
export const CHASE_TONES: ChaseTone[] = ["gentle", "firm", "broken", "final"];
export const TONE_LABELS: Record<ChaseTone, string> = {
  gentle: "Gentle reminder",
  firm: "Firm",
  broken: "About a promise not kept",
  final: "Final notice",
};
export const isChaseTone = (v: unknown): v is ChaseTone => typeof v === "string" && (CHASE_TONES as string[]).includes(v);

/** The tone the facts call for: a broken promise said plainly; firm after two weeks; a final notice after 45 days. */
export function toneFor(f: CompanyFacts): ChaseTone {
  const dues = chaseDues(f);
  if (dues.some((d) => d.promise?.now === "broken")) return "broken";
  const oldest = dues.reduce((m, d) => Math.max(m, d.daysLate), 0);
  return oldest >= 45 ? "final" : oldest >= 15 ? "firm" : "gentle";
}

const TONE_WORDS: Record<ChaseTone, string> = {
  gentle: "A friendly reminder. Assume it slipped through; ask them to arrange payment, or to say if anything is holding it up.",
  firm: "Firm and clear, still courteous: the money is well overdue. Ask for payment, or a firm date this week.",
  broken: "Mention, without blame, that the payment they promised by the date given hasn't come. Ask for it, or a new date they can keep.",
  final:
    "A final reminder, serious and courteous. Say this is the last reminder, and ask them to settle within seven days or call to discuss. No threats, penalties or consequences beyond that.",
};

export const CHASE_SYSTEM = [
  "You write one email from an Indian B2B company to a customer about money it owes.",
  "Use ONLY the facts given. Never invent an amount, a date, an invoice, a discount, a penalty, interest or a consequence.",
  "Mention an amount only exactly as the facts write it — better, refer to \"the invoices below\". Deskzo puts the list of invoices, with their amounts and pay-now links, where you write {{invoices}} on a line of its own; don't list them yourself.",
  "Plain, polite Indian business English. Subject under 80 characters; body under 130 words.",
  "Start the body with \"Dear {{firstName}},\" and end it with \"Regards,\" then \"{{senderName}}\" on its own line. No other signature, no links.",
  "Never mention Deskzo, AI, or that the email was drafted for anybody.",
  "Call propose_email exactly once.",
].join(" ");

export type ChasePromptInput = {
  ours: string;
  companyName: string;
  tone: ChaseTone;
  /** The invoices in the email, oldest first. */
  invoices: { number: string; due: string; daysLate: number; balance: string }[];
  /** "₹1,20,000.00" — one per currency. */
  totals: string[];
  notYetDue: string | null;
  promise: { amount: string | null; on: string; broken: boolean } | null;
  promisesKept: number;
  lastSaid: { on: string; channel: string; remarks: string } | null;
  usualDaysLate: number | null;
  earlier: { subject: string; daysAgo: number }[];
  remindersSent: number;
};

/** What the model reads for a chase email. */
export function chasePrompt(i: ChasePromptInput): string {
  const lines = [`From: ${i.ours}. To: ${i.companyName}.`, `Tone: ${TONE_LABELS[i.tone]}. ${TONE_WORDS[i.tone]}`, ""];
  lines.push(`Overdue: ${i.totals.join(" and ")} on ${plural(i.invoices.length, "invoice", "invoices")}:`);
  for (const inv of i.invoices) lines.push(`— ${inv.number}, due ${inv.due}, ${inv.daysLate > 0 ? `${plural(inv.daysLate, "day", "days")} late` : "not yet due"}, ${inv.balance} still to pay`);
  if (i.notYetDue) lines.push(`Also open but not yet due: ${i.notYetDue}.`);
  if (i.promise) lines.push(`They promised to pay ${i.promise.amount ?? "it"} by ${i.promise.on}${i.promise.broken ? ", and it hasn't come" : ""}.`);
  if (i.promisesKept > 0) lines.push(`They have kept ${plural(i.promisesKept, "promise", "promises")} to pay before.`);
  if (i.lastSaid) lines.push(`What they said last time (${i.lastSaid.on}, ${i.lastSaid.channel}): "${i.lastSaid.remarks}"`);
  if (i.usualDaysLate !== null) lines.push(i.usualDaysLate <= 5 ? "They usually pay on time." : `They usually pay about ${i.usualDaysLate} days after the due date.`);
  if (i.remindersSent > 0) lines.push(`Automatic reminders already sent for these invoices: ${i.remindersSent}.`);
  if (i.earlier.length) {
    lines.push("Emails like this one already sent:");
    for (const e of i.earlier) lines.push(`— ${ago(e.daysAgo)}: "${e.subject}"`);
    lines.push("Don't repeat them; move it on.");
  }
  lines.push("", "Write the email.");
  return lines.join("\n");
}

export const PROPOSE_CHASE: ToolSpec = {
  name: "propose_email",
  description: "Hand back the email. Call it once.",
  parameters: { type: "object", properties: { subject: { type: "string" }, body: { type: "string" } }, required: ["subject", "body"] },
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const chaseEmailSchema = z.object({
  subject: z.string().trim().min(3).transform((s) => clip(s.replace(/\s+/g, " "), 150)),
  body: z.string().trim().min(20).transform((s) => clip(s, 3000)),
});

/** Email addresses and phone numbers out of somebody's notes before they go to the model. */
export function scrubRemarks(text: string): string {
  return text
    .replace(/[\w.+-]+@[\w-]+(\.[\w-]+)+/g, "[email]")
    .replace(/(\+?\d[\d\s-]{8,}\d)/g, "[phone]")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 400);
}

const MONEY_TOKEN = /(?:₹|rs\.?|inr|usd|aed|eur|gbp|\$|€|£)\s?\d[\d,]*(?:\.\d+)?|\b\d{1,3}(?:,\d{2,3})+(?:\.\d+)?\b/gi;
const WORDED = /\b\d+(?:\.\d+)?\s?(?:lakhs?|lacs?|crores?|cr)\b/gi;
const valueOf = (s: string) => Number(s.replace(/[^\d.]/g, "").replace(/^\.+|\.+$/g, ""));

/** Amounts in `text` that aren't one of `allowed` (as formatted strings) — what an email may not say. */
export function strayAmounts(text: string, allowed: string[]): string[] {
  const ok = allowed.map(valueOf).filter((n) => Number.isFinite(n));
  const stray = (text.match(MONEY_TOKEN) ?? []).filter((m) => {
    const n = valueOf(m);
    return Number.isFinite(n) && !ok.some((a) => Math.abs(a - n) < 0.01);
  });
  return [...stray, ...(text.match(WORDED) ?? [])];
}

/** The body with {{invoices}} in it: where the model left it, else before the sign-off. */
export function withInvoicesPlace(body: string): string {
  if (/\{\{\s*invoices\s*\}\}/.test(body)) return body;
  const lines = body.split("\n");
  const at = lines.findIndex((l) => /^\s*(regards|warm regards|best regards|thanks|thank you)\b/i.test(l));
  const i = at >= 0 ? at : Math.max(lines.findIndex((l) => /\{\{\s*senderName\s*\}\}/.test(l)), lines.length);
  lines.splice(i, 0, "{{invoices}}", "");
  return lines.join("\n");
}

export type ChaseLine = { number: string; due: string; late: string; balance: string; payUrl: string | null };

function fill(body: string, v: { names: string; senderName: string }): string {
  return body.replace(/\{\{\s*firstName\s*\}\}/g, v.names.trim() || "Sir/Madam").replace(/\{\{\s*senderName\s*\}\}/g, v.senderName);
}

/** The email as plain text: names filled, the invoices listed where it says, then any note added below (the MSME line). */
export function chaseText(body: string, v: { names: string; senderName: string }, lines: ChaseLine[], note: string | null): string {
  const list = lines.map((l) => `${l.number} · due ${l.due} · ${l.late} · ${l.balance}${l.payUrl ? ` — pay online: ${l.payUrl}` : ""}`).join("\n");
  const text = fill(withInvoicesPlace(body), v).replace(/\{\{\s*invoices\s*\}\}/g, list);
  return note ? `${text}\n\n${note}` : text;
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const paragraphs = (s: string) =>
  s
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, "<br>")}</p>`)
    .join("\n");

/** The same as HTML: the text escaped into paragraphs, the invoices as a table with a Pay now link on each. */
export function chaseHtml(body: string, v: { names: string; senderName: string }, lines: ChaseLine[], note: string | null): string {
  const [before, after = ""] = fill(withInvoicesPlace(body), v).split(/\{\{\s*invoices\s*\}\}/);
  const cell = 'style="padding:6px 10px;border-bottom:1px solid #e5e7eb;text-align:left"';
  const table = `<table style="border-collapse:collapse;font-size:14px"><thead><tr><th ${cell}>Invoice</th><th ${cell}>Due</th><th ${cell}></th><th ${cell}>Still to pay</th><th ${cell}></th></tr></thead><tbody>
${lines.map((l) => `<tr><td ${cell}>${esc(l.number)}</td><td ${cell}>${esc(l.due)}</td><td ${cell}>${esc(l.late)}</td><td ${cell}>${esc(l.balance)}</td><td ${cell}>${l.payUrl ? `<a href="${esc(l.payUrl)}">Pay now</a>` : ""}</td></tr>`).join("\n")}
</tbody></table>`;
  return [paragraphs(before ?? ""), table, paragraphs(after), note ? paragraphs(note) : ""].filter(Boolean).join("\n");
}

// ─── The reply-to address ─────────────────────────────────────────────────────────────────────────────────────────

/** `<slug>+c-<token>@<domain>`: the workspace's own inbound address, as a nurture's is (`+n-`), with the chase's secret. */
export function chaseReplyAddress(slug: string, token: string, domain: string): string {
  return `${slug}+c-${token}@${domain}`;
}

/** The chase's secret in an address the inbound receiver was posted for, or null when it isn't a reply to one. */
export function chaseTokenOf(recipient: string): string | null {
  const local = recipient.trim().toLowerCase().split("@")[0] ?? "";
  const m = /\+c-([0-9a-f]{24})$/.exec(local);
  return m ? m[1]! : null;
}

// ─── Reading a reply ──────────────────────────────────────────────────────────────────────────────────────────────

export const READINGS = ["PROMISE", "PAID", "DISPUTE", "QUESTION", "OTHER"] as const;
export type Reading = (typeof READINGS)[number];
export const READING_LABELS: Record<Reading | "UNREAD", string> = {
  PROMISE: "Promise to pay",
  PAID: "Says they've paid",
  DISPUTE: "Disputes it",
  QUESTION: "Asks for something",
  OTHER: "Reply",
  UNREAD: "Reply — not read",
};

/** The customer's own words, without the email they answered quoted under them. */
export function stripQuoted(text: string): string {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const cut = lines.findIndex(
    (l, i) =>
      i > 0 &&
      (/^\s*On .{4,200}wrote:\s*$/i.test(l) || /^\s*-{2,}\s*(Original|Forwarded) Message/i.test(l) || /^\s*From:\s.+/i.test(l) || /^\s*_{10,}\s*$/.test(l)),
  );
  const kept = (cut > 0 ? lines.slice(0, cut) : lines).filter((l) => !/^\s*>/.test(l));
  return kept.join("\n").trim();
}

export const READ_SYSTEM = [
  "You read a customer's reply to an email asking them to pay overdue invoices, and say what it means for collecting the money.",
  "Use only the reply. kind: PROMISE when they say they will pay by a day (give promisedOn as yyyy-mm-dd, working out words like \"next Friday\" or \"end of the month\" from today's date given); PAID when they say they have already paid (paidOn, paidAmount and reference — a UTR, cheque or transaction number — only when they give them); DISPUTE when they question an invoice, the amount, the goods or the service, or ask for a credit note (detail: what); QUESTION when they ask for something, such as a copy of an invoice, a statement or bank details (detail: what); OTHER for anything else.",
  "promisedAmount and paidAmount only when they write a number. invoices: those of the listed invoice numbers the reply names, else none.",
  "summary: one short sentence about what they said, in the third person, without names.",
  "Call propose_reading exactly once.",
].join(" ");

/** What the model reads for one reply. */
export function readPrompt(i: { today: Date; invoices: { number: string; balance: string }[]; subject: string; text: string }): string {
  return [
    `Today is ${WEEKDAY.format(i.today)} ${i.today.getUTCFullYear()} (${dayKey(i.today)}).`,
    `The email asked them to pay: ${i.invoices.map((v) => `${v.number} (${v.balance})`).join(", ") || "overdue invoices"}.`,
    "",
    `Their reply — subject: ${i.subject.slice(0, 200)}`,
    i.text.slice(0, 4000),
  ].join("\n");
}

export const PROPOSE_READING: ToolSpec = {
  name: "propose_reading",
  description: "Say what the reply means. Call it once.",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...READINGS] },
      summary: { type: "string" },
      promisedOn: { type: "string", description: "yyyy-mm-dd" },
      promisedAmount: { type: "number" },
      paidOn: { type: "string", description: "yyyy-mm-dd" },
      paidAmount: { type: "number" },
      reference: { type: "string" },
      detail: { type: "string" },
      invoices: { type: "array", items: { type: "string" } },
    },
    required: ["kind", "summary"],
  },
};

const isoDay = z
  .string()
  .trim()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .optional()
  .catch(undefined);
const amount = z.number().positive().max(1e12).optional().catch(undefined);
export const readingSchema = z.object({
  kind: z.enum(READINGS),
  summary: z.string().trim().min(3).transform((s) => clip(s.replace(/\s+/g, " "), 300)),
  promisedOn: isoDay,
  promisedAmount: amount,
  paidOn: isoDay,
  paidAmount: amount,
  reference: z.string().trim().max(80).optional().catch(undefined),
  detail: z.string().trim().optional().catch(undefined).transform((s) => (s ? clip(s, 300) : undefined)),
  invoices: z.array(z.string()).optional().catch(undefined),
});
export type ReadingRead = z.infer<typeof readingSchema>;

/**
 * A reading kept only where it holds: a promised day from today to a year ahead, a paid day not in the future and not
 * more than three months back, the invoices among those emailed. Anything else is dropped, not guessed.
 */
export function settleReading(r: ReadingRead, today: Date, invoices: { id: string; number: string }[]) {
  const day = (s: string | undefined) => (s ? new Date(`${s}T00:00:00Z`) : null);
  const promised = day(r.promisedOn);
  const paid = day(r.paidOn);
  const keepPromised = promised && !Number.isNaN(promised.getTime()) && promised >= today && promised.getTime() - today.getTime() <= 366 * DAY ? promised : null;
  const keepPaid = paid && !Number.isNaN(paid.getTime()) && paid <= today && today.getTime() - paid.getTime() <= 92 * DAY ? paid : null;
  const named = new Set((r.invoices ?? []).map((n) => n.trim().toLowerCase()));
  return {
    reading: r.kind as Reading,
    summary: r.summary,
    promisedOn: r.kind === "PROMISE" ? keepPromised : null,
    promisedAmount: r.kind === "PROMISE" && keepPromised ? (r.promisedAmount ?? null) : null,
    paidOn: r.kind === "PAID" ? keepPaid : null,
    paidAmount: r.kind === "PAID" ? (r.paidAmount ?? null) : null,
    reference: r.kind === "PAID" ? (r.reference?.replace(/\s+/g, " ").slice(0, 80) ?? null) : null,
    detail: r.kind === "DISPUTE" || r.kind === "QUESTION" ? (r.detail ?? null) : null,
    documentIds: invoices.filter((i) => named.has(i.number.trim().toLowerCase())).map((i) => i.id),
  };
}
