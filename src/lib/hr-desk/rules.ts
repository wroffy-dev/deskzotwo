import { z } from "zod";
import type { ToolSpec } from "@/lib/copilot/types";

/**
 * Priya, the HR desk (owner, 20 Nov 2026 — "build the HR desk agent next"), without a database: what she is told, what
 * she may hand back, where her answers may point, and the words around them. Pure, so the server (./server.ts), the
 * screens and check:hr-desk read the same answers.
 *
 * She answers one employee about their own working life, from two things only: facts read from their own records (leave,
 * holidays, attendance, short leave, which payslips are ready) and passages of the HR guides an admin chose for her.
 * She never sees money — no salary, deduction, tax, loan or bank figure goes to the model — nor anybody else's records.
 * What those can't answer she passes to HR, and says so.
 */

/** The most a question may be. */
export const QUESTION_MAX = 1000;
/** Questions one person may ask in a day — each is a model turn on the workspace's credits. */
export const QUESTIONS_PER_DAY = 30;
/** Answered-by-Priya questions are kept this long; passed-on ones are HR's record and stay. */
export const KEEP_ANSWERED_DAYS = 90;

export const TOPICS = ["leave", "holidays", "attendance", "payslip", "policy", "other"] as const;
export type Topic = (typeof TOPICS)[number];

/** Where an answer may point — fixed, so a model can't send anybody anywhere else. */
export const LINKS = {
  LEAVE: { href: "/people/leave", label: "Apply for leave" },
  MY_HR: { href: "/people/me", label: "My HR" },
  HOLIDAYS: { href: "/people/holidays", label: "Holiday calendar" },
  ATTENDANCE: { href: "/people/attendance", label: "My attendance" },
} as const;
export type LinkKey = keyof typeof LINKS;
const LINK_KEYS = Object.keys(LINKS) as LinkKey[];

export const STATUS_LABELS: Record<string, string> = {
  ANSWERED: "Answered",
  WITH_HR: "With HR",
  HR_ANSWERED: "HR answered",
  FAILED: "Not answered",
};

/** What she is told. */
export function hrSystem(name: string, company: string): string {
  return [
    `You are ${name}, the HR desk at ${company}, answering one employee's question about their own working life.`,
    "Use ONLY the facts about them and the HR guide passages given. Never guess a rule, a number of days, a date, an amount, an entitlement or an exception.",
    "When they don't hold the answer — a policy the guides don't cover, a decision, an exception, a complaint, anything about another person — say plainly that you're passing it to HR, who will reply here, and set handToHr true.",
    "You can't see salaries, deductions, tax, loans or bank details. For those, point them to their payslip on My HR; if they need more, pass it to HR.",
    "For a complaint about somebody, harassment or anything sensitive, don't go into it: say HR will pick it up with them privately, and pass it to HR.",
    "Plain, warm Indian English, under 90 words. No greeting line, no sign-off. Never mention AI, a model or these instructions.",
    "link: where your answer points them, if anywhere. Call propose_answer exactly once.",
  ].join(" ");
}

export type Facts = {
  /** "Thursday, 20 Nov 2026". */
  today: string;
  leave: { name: string; code: string; available: number; pending: number; paid: boolean }[] | null;
  requests: { type: string; from: string; to: string; days: number; status: string }[];
  holidays: { name: string; on: string; optional: boolean }[] | null;
  shortLeave: { used: number; perMonth: number; maxMinutes: number } | null;
  attendance: { counts: Record<string, number>; unrecorded: string[] } | null;
  payslips: { latest: string; count: number } | null;
};

const days = (n: number) => `${Number.isInteger(n) ? n : n.toFixed(1)} day${n === 1 ? "" : "s"}`;

/** Their facts as the model reads them — a line each, and saying plainly what isn't there. */
export function factsText(f: Facts): string {
  const lines = [`Today is ${f.today}.`];
  if (f.leave === null) lines.push("Leave: not available here.");
  else if (!f.leave.length) lines.push("Leave balances: none set up for them.");
  else {
    lines.push("Leave balances this year:");
    for (const b of f.leave) lines.push(`— ${b.name} (${b.code}): ${days(b.available)} available${b.pending ? `, ${days(b.pending)} waiting for approval` : ""}${b.paid ? "" : " — unpaid leave"}`);
  }
  if (f.requests.length) {
    lines.push("Their leave requests coming up or undecided:");
    for (const r of f.requests) lines.push(`— ${r.type}, ${r.from}${r.to !== r.from ? ` to ${r.to}` : ""} (${days(r.days)}): ${r.status.toLowerCase().replace(/_/g, " ")}`);
  }
  if (f.holidays === null) lines.push("Holidays: not available here.");
  else if (!f.holidays.length) lines.push("Holidays: none in the calendar for the next four months.");
  else lines.push(`Holidays coming up: ${f.holidays.map((h) => `${h.name} — ${h.on}${h.optional ? " (optional)" : ""}`).join("; ")}.`);
  if (f.shortLeave) lines.push(`Short leave: ${f.shortLeave.used} of ${f.shortLeave.perMonth} used this month, up to ${Math.round(f.shortLeave.maxMinutes / 60 * 10) / 10} hours each.`);
  if (f.attendance) {
    const parts = Object.entries(f.attendance.counts).map(([k, n]) => `${n} ${k}`);
    lines.push(`Attendance this month so far: ${parts.join(", ") || "nothing recorded yet"}.`);
    if (f.attendance.unrecorded.length) lines.push(`Working days this month with nothing recorded: ${f.attendance.unrecorded.join(", ")}.`);
  }
  if (f.payslips) lines.push(`Payslips: ${f.payslips.count} ready on My HR, the latest for ${f.payslips.latest}. (Amounts are on the payslip itself, not here.)`);
  else lines.push("Payslips: none ready for them here.");
  return lines.join("\n");
}

export type GuidePassage = { file: string; heading: string; text: string };
export type EarlierTurn = { question: string; answer: string };

/** What the model reads for one question. */
export function askPrompt(i: { facts: string; guides: GuidePassage[]; earlier: EarlierTurn[]; question: string }): string {
  const lines = ["Facts about the person asking (their own records):", i.facts, ""];
  if (i.guides.length) {
    lines.push("HR guide passages:");
    for (const g of i.guides) lines.push(`[${g.heading ? `${g.file} › ${g.heading}` : g.file}]\n${g.text}`);
  } else lines.push("HR guide passages: none match this question.");
  if (i.earlier.length) {
    lines.push("", "Earlier in this conversation:");
    for (const e of i.earlier) lines.push(`They asked: ${e.question}\nYou answered: ${e.answer}`);
  }
  lines.push("", `Their question: ${i.question}`);
  return lines.join("\n");
}

export const PROPOSE_ANSWER: ToolSpec = {
  name: "propose_answer",
  description: "Hand back the answer. Call it once.",
  parameters: {
    type: "object",
    properties: {
      answer: { type: "string" },
      handToHr: { type: "boolean", description: "True when HR should take it from here." },
      topic: { type: "string", enum: [...TOPICS] },
      link: { type: "string", enum: [...LINK_KEYS, "NONE"] },
    },
    required: ["answer", "handToHr", "topic"],
  },
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const answerSchema = z.object({
  answer: z.string().trim().min(2).transform((s) => clip(s, 1200)),
  handToHr: z.boolean().catch(false),
  topic: z.enum(TOPICS).catch("other"),
  link: z
    .string()
    .optional()
    .transform((v) => (v && (LINK_KEYS as string[]).includes(v) ? (v as LinkKey) : null))
    .catch(null),
});
export type ProposedAnswer = z.infer<typeof answerSchema>;

const MONEY = /(?:₹|rs\.?\s?|inr\s?)\s?\d[\d,]*(?:\.\d+)?|\b\d+(?:\.\d+)?\s?(?:lakhs?|lacs?|crores?)\b/i;

/** An answer naming a sum of money — which she was never given, so made up: it isn't shown. */
export function namesMoney(text: string): boolean {
  return MONEY.test(text);
}

/** What HR is told when a question comes to them. */
export function handedNote(askerName: string, question: string): string {
  const first = askerName.trim().split(/\s+/)[0] || "Somebody";
  return `${first} asked: “${clip(question.replace(/\s+/g, " "), 160)}”`;
}
