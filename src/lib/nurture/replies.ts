import { z } from "zod";
import type { ToolSpec } from "@/lib/copilot/types";

/**
 * Nurture phase 4 (owner, 20 Nov 2026 — "go with your recommendations"), the pure parts: a reply read by Deskzo AI, the
 * working morning an approved email waits for, and the booking line at the foot of each email. src/lib/nurture/server.ts
 * acts on them.
 */

// ─── A reply, read ────────────────────────────────────────────────────────────────────────────────────────────────

export const REPLY_KINDS = ["INTERESTED", "CALL_ME", "NOT_NOW", "WRONG_PERSON", "NOT_INTERESTED", "UNSUBSCRIBE", "OUT_OF_OFFICE", "OTHER"] as const;
export type ReplyKind = (typeof REPLY_KINDS)[number] | "UNREAD";

export const REPLY_KIND_LABELS: Record<ReplyKind, string> = {
  INTERESTED: "Interested",
  CALL_ME: "Wants a call",
  NOT_NOW: "Not now",
  WRONG_PERSON: "Wrong person",
  NOT_INTERESTED: "Not interested",
  UNSUBSCRIBE: "Asked to stop",
  OUT_OF_OFFICE: "Away",
  OTHER: "Replied",
  UNREAD: "Replied",
};

/** The meanings a reply may suggest moving the lead to — a person decides, on the lead's card. */
export const SUGGESTED_STAGES = ["CONTACTED", "QUALIFIED", "PROPOSAL_SENT", "NEGOTIATION", "LOST"] as const;
export const SUGGESTED_STAGE_LABELS: Record<(typeof SUGGESTED_STAGES)[number], string> = {
  CONTACTED: "Contacted",
  QUALIFIED: "Qualified",
  PROPOSAL_SENT: "Proposal sent",
  NEGOTIATION: "Negotiation",
  LOST: "Lost",
};

const EMAIL_IN_TEXT = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
// A run of seven or more digits, with the spaces, dashes, dots and brackets numbers are written with.
const PHONE_IN_TEXT = /\+?\(?\d[\d\s().-]{5,}\d/g;

/**
 * What of a reply goes to the model: its own words, the earlier emails it quotes cut off, and every email address and
 * phone number taken out — what Deskzo AI needs to read the intent, and no more.
 */
export function scrubReply(text: string): string {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    // Where the quoted thread starts: "On Tue, … wrote:", "-----Original Message-----", "From: …" or "> …".
    if (/^\s*on .{4,200} wrote:\s*$/i.test(line) || /^\s*-{2,}\s*original message/i.test(line) || /^\s*from:\s.+/i.test(line) || /^\s*>/.test(line)) break;
    kept.push(line);
  }
  return kept
    .join("\n")
    .replace(EMAIL_IN_TEXT, "[email]")
    .replace(PHONE_IN_TEXT, (m) => (m.replace(/\D/g, "").length >= 7 ? "[number]" : m))
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 4000);
}

/** The addresses a reply names besides its sender's — "talk to priya@…" — for the person it suggests. */
export function otherAddresses(text: string, sender: string): string[] {
  const own = sender.trim().toLowerCase();
  const found = (text.match(EMAIL_IN_TEXT) ?? []).map((a) => a.toLowerCase()).filter((a) => a !== own);
  return [...new Set(found)];
}

export const REPLY_SYSTEM = [
  "You read one customer's reply to a short sales follow-up email and say what it means for the salesperson.",
  "Choose kind: INTERESTED (wants to go ahead, asks for a quote, details or a demo), CALL_ME (asks to be called or to talk),",
  "NOT_NOW (interested later — give resumeOn, the day to try again, if they name a time), WRONG_PERSON (points to somebody",
  "else — give suggestedName), NOT_INTERESTED (no need, bought elsewhere, too expensive), UNSUBSCRIBE (asks not to be emailed),",
  "OUT_OF_OFFICE (away — give resumeOn, the day they are back), or OTHER.",
  "summary: one sentence a busy salesperson reads, without names, numbers or addresses.",
  "suggestedStage: what the lead could move to — CONTACTED, QUALIFIED, PROPOSAL_SENT, NEGOTIATION or LOST — or left out.",
  "answer: a short reply for the salesperson to send — left out for UNSUBSCRIBE and OUT_OF_OFFICE. Plain,",
  "polite business English, under 90 words, no promises of prices or dates the reply didn't ask for. Start with",
  "'Hi {{firstName}},' and end with '{{senderName}}'. Never invent facts.",
  "Dates as YYYY-MM-DD, worked out from today's date given. Call read_reply once.",
].join(" ");

export const READ_REPLY: ToolSpec = {
  name: "read_reply",
  description: "What the customer's reply means, and a short answer for the salesperson to send.",
  parameters: {
    type: "object",
    properties: {
      kind: { type: "string", enum: [...REPLY_KINDS] },
      summary: { type: "string" },
      resumeOn: { type: "string", description: "YYYY-MM-DD — leave out when they name no day" },
      suggestedName: { type: "string", description: "leave out unless they point to somebody else" },
      suggestedStage: { type: "string", enum: [...SUGGESTED_STAGES], description: "leave out when nothing fits" },
      answer: {
        type: "object",
        description: "leave out for UNSUBSCRIBE and OUT_OF_OFFICE",
        properties: { subject: { type: "string" }, body: { type: "string" } },
        required: ["subject", "body"],
      },
    },
    required: ["kind", "summary"],
  },
};

const day = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => !Number.isNaN(new Date(`${d}T00:00:00Z`).getTime()));

export const readReplySchema = z.object({
  kind: z.enum(REPLY_KINDS),
  summary: z.string().trim().min(3).transform((s) => s.slice(0, 300)),
  resumeOn: day.nullish().catch(null),
  suggestedName: z
    .string()
    .trim()
    .transform((s) => s.slice(0, 120))
    .nullish()
    .catch(null),
  suggestedStage: z.enum(SUGGESTED_STAGES).nullish().catch(null),
  answer: z
    .object({ subject: z.string().trim().min(2).transform((s) => s.slice(0, 200)), body: z.string().trim().min(10).transform((s) => s.slice(0, 3000)) })
    .nullish()
    .catch(null),
});
export type ReadReply = z.infer<typeof readReplySchema>;

export function replyPrompt(input: { today: string; answered: string; reply: string; automated: boolean }): string {
  return [
    `Today is ${input.today}.`,
    `They answered our email titled: ${input.answered}`,
    input.automated ? "Their mail server marked this as an automatic reply." : "",
    "Their reply:",
    "<<<",
    input.reply || "(empty)",
    ">>>",
  ]
    .filter(Boolean)
    .join("\n");
}

/** A day the reply named, kept only when it is ahead — and no more than eighteen months ahead. */
export function usableResume(resumeOn: string | null | undefined, today: string): string | null {
  if (!resumeOn || resumeOn <= today) return null;
  const limit = new Date(`${today}T00:00:00Z`);
  limit.setUTCMonth(limit.getUTCMonth() + 18);
  return resumeOn <= limit.toISOString().slice(0, 10) ? resumeOn : null;
}

// ─── Working hours ────────────────────────────────────────────────────────────────────────────────────────────────

export const WORK_START_HOUR = 9;
export const WORK_END_HOUR = 17;
export const SEND_HOUR = 10;

function localParts(at: Date, zone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", weekday: "short", hourCycle: "h23" })
      .formatToParts(at)
      .map((p) => [p.type, p.value]),
  );
  return { y: Number(parts.year), m: Number(parts.month), d: Number(parts.day), hour: Number(parts.hour), minute: Number(parts.minute), weekday: String(parts.weekday) };
}

/** The instant a wall-clock time in a zone falls on. */
export function zonedInstant(y: number, m: number, d: number, hour: number, minute: number, zone: string): Date {
  const want = Date.UTC(y, m - 1, d, hour, minute);
  let guess = want;
  for (let i = 0; i < 3; i++) {
    const p = localParts(new Date(guess), zone);
    const seen = Date.UTC(p.y, p.m - 1, p.d, p.hour, p.minute);
    guess += want - seen;
  }
  return new Date(guess);
}

const WEEKEND = new Set(["Sat", "Sun"]);

/**
 * When an approved email goes (owner, 20 Nov 2026 — "sent in their working hours"): at once in a working day's hours,
 * Monday to Friday 9 to 5 on the workspace's clock; otherwise at 10 the next working morning.
 */
export function sendTimeFor(now: Date, zone: string): Date {
  const p = localParts(now, zone);
  if (!WEEKEND.has(p.weekday) && p.hour >= WORK_START_HOUR && p.hour < WORK_END_HOUR) return now;
  // Before nine on a working day: that morning. Otherwise the next working day's.
  let base = Date.UTC(p.y, p.m - 1, p.d);
  if (WEEKEND.has(p.weekday) || p.hour >= WORK_END_HOUR) base += 86_400_000;
  for (let i = 0; i < 7; i++) {
    const day = new Date(base);
    const weekday = new Intl.DateTimeFormat("en-GB", { timeZone: "UTC", weekday: "short" }).format(day);
    if (!WEEKEND.has(weekday)) return zonedInstant(day.getUTCFullYear(), day.getUTCMonth() + 1, day.getUTCDate(), SEND_HOUR, 0, zone);
    base += 86_400_000;
  }
  return now;
}

/** "Mon 24 Nov, 10:00" on the workspace's clock — what the button says it waits for. */
export function sendTimeLabel(at: Date, zone: string): string {
  return new Intl.DateTimeFormat("en-IN", { timeZone: zone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(at);
}

/** The working morning a day ("2027-03-01") starts at, for a nurture paused until then. */
export function morningOf(dayKey: string, zone: string): Date {
  const [y, m, d] = dayKey.split("-").map(Number) as [number, number, number];
  return sendTimeFor(zonedInstant(y, m, d, 0, 30, zone), zone);
}

// ─── The booking link ─────────────────────────────────────────────────────────────────────────────────────────────

/** The reference a booking link carries: the nurture's reply secret, so the booking lands on its lead. */
export const bookingRef = (replyToken: string) => `n-${replyToken}`;
export const tokenOfBookingRef = (ref: unknown): string | null => {
  const m = typeof ref === "string" ? /^n-([0-9a-f]{24})$/.exec(ref.trim()) : null;
  return m ? m[1]! : null;
};

/**
 * The email's body with the line to book a time added above its sign-off — the last paragraph, when it is the
 * sender's name ("{{senderName}}", "Regards, {{senderName}}") — or at the end when there is none.
 */
export function withBookingLine(body: string, url: string): string {
  const line = `If it's easier, pick a time to talk: ${url}`;
  const paragraphs = body.trimEnd().split(/\n{2,}/);
  const last = paragraphs[paragraphs.length - 1] ?? "";
  if (paragraphs.length > 1 && (/\{\{\s*senderName\s*\}\}/.test(last) || last.length <= 40)) {
    return [...paragraphs.slice(0, -1), line, last].join("\n\n");
  }
  return `${body.trimEnd()}\n\n${line}`;
}
