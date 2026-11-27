import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type { ToolSpec } from "@/lib/copilot/types";
import type { PlanInput, StoredPlan } from "@/lib/research/plan";

/**
 * Deskzo AI nurturing a lead (owner, 18 Nov 2026 — phase 3, "go with your recommendations": approve every email first,
 * email only, from the salesperson's own mailbox, only the leads somebody switches on, replies caught through a Deskzo
 * reply-to address). Pure: the cadence, the reply address, and what the model is asked — src/lib/nurture/server.ts does
 * the rest.
 *
 * Four emails over two weeks, each written for where things stand and checked by the lead's owner before it goes. A
 * reply, a call or meeting somebody logs, the lead closing — any of them ends it, and the salesperson takes it from there.
 */

/** Days from enrolling that each email falls due: the first at once (the plan's own draft), then 3, 7 and 14. */
export const STEP_DAYS = [0, 3, 7, 14] as const;
export const TOUCHES = STEP_DAYS.length;
/** After the last email, how long to wait for an answer before handing it back. */
export const WAIT_AFTER_LAST_DAYS = 7;
/** However late an approval, the next email is at least this far behind the last one. */
const MIN_GAP_DAYS = 2;
const DAY = 86_400_000;

export const NURTURE_STATUS_LABELS: Record<string, string> = { ACTIVE: "Nurturing", STOPPED: "Stopped", DONE: "Finished" };

/** When the email after `sentCount` emails falls due: on the cadence from enrolling, but never sooner than two days after the last. */
export function nextTouchAt(enrolledAt: Date, sentCount: number, lastSentAt: Date | null): Date {
  const onCadence = new Date(enrolledAt.getTime() + (sentCount < TOUCHES ? STEP_DAYS[sentCount]! : STEP_DAYS[TOUCHES - 1]! + WAIT_AFTER_LAST_DAYS) * DAY);
  const earliest = lastSentAt ? new Date(lastSentAt.getTime() + (sentCount >= TOUCHES ? WAIT_AFTER_LAST_DAYS : MIN_GAP_DAYS) * DAY) : onCadence;
  return onCadence > earliest ? onCadence : earliest;
}

// ─── The reply-to address ─────────────────────────────────────────────────────────────────────────────────────────

/** A new secret for an enrolment's reply-to address; only its digest is kept. */
export function newReplyToken(): string {
  return randomBytes(12).toString("hex");
}
export const tokenDigest = (token: string) => createHash("sha256").update(token).digest("hex");

/** `<slug>+n-<token>@<domain>`: the workspace's own inbound address, which the helpdesk's receiver routes by its slug. */
export function replyAddress(slug: string, token: string, domain: string): string {
  return `${slug}+n-${token}@${domain}`;
}

/** The token in an address the inbound receiver was posted for, or null when it isn't a nurture reply. */
export function replyTokenOf(recipient: string): string | null {
  const local = recipient.trim().toLowerCase().split("@")[0] ?? "";
  const m = /\+n-([0-9a-f]{24})$/.exec(local);
  return m ? m[1]! : null;
}

// ─── Writing the next email ───────────────────────────────────────────────────────────────────────────────────────

export type SentTouch = { step: number; subject: string; body: string; daysAgo: number };

/** Tara's instructions — India's, or without India in them for a workspace elsewhere (the UAE). */
export const nurtureSystemFor = (india: boolean) => [
  `You write the next follow-up email in a short sequence from a B2B salesperson${india ? " in India" : ""} to one lead.`,
  "Use ONLY the facts given. Never invent a fact, a name, a number, a product, a price, a discount, an offer or a deadline.",
  "Don't repeat an earlier email: move the conversation on — a useful question, a short reason to talk, or a gentle check-in.",
  `Plain, polite ${india ? "Indian " : ""}business English.` + " Subject under 80 characters; body under 120 words.",
  "Start the body with \"Hi {{firstName}},\" and end it with \"{{senderName}}\" on its own line. No links, attachments or signatures.",
  "The last email of the sequence says, kindly, that this is the last note for now and how to reach back.",
  "Call propose_email exactly once.",
].join(" ");

export const NURTURE_SYSTEM = nurtureSystemFor(true);

/** What the model reads for email `step` (0-based) of the sequence. */
export function nurturePrompt(input: { plan: Pick<StoredPlan, "fit" | "summary" | "fitReasons" | "questions" | "steps">; lead: PlanInput["lead"]; companyName: string; step: number; sent: SentTouch[] }): string {
  const lines = [`Email ${input.step + 1} of ${TOUCHES} to ${input.companyName}.`, `Where things stand: ${input.plan.summary}`];
  lines.push(`Read as: ${input.plan.fit}. ${input.plan.fitReasons.join("; ")}`);
  const l = input.lead;
  if (l) {
    lines.push(`Lead: ${l.title}. Stage: ${l.stage}. Products asked about: ${l.products.join(", ") || "none named"}.`);
  }
  if (input.plan.questions.length) lines.push(`Questions worth asking: ${input.plan.questions.join(" / ")}`);
  if (input.sent.length) {
    lines.push("", "Sent so far, with no reply:");
    for (const s of input.sent) lines.push(`— Email ${s.step + 1}, ${s.daysAgo} days ago. Subject: ${s.subject}\n${s.body.slice(0, 1200)}`);
  }
  if (input.step === TOUCHES - 1) lines.push("", "This is the last email of the sequence.");
  lines.push("", "Write the next email.");
  return lines.join("\n");
}

export const PROPOSE_EMAIL: ToolSpec = {
  name: "propose_email",
  description: "Hand back the email. Call it once.",
  parameters: {
    type: "object",
    properties: { subject: { type: "string" }, body: { type: "string" } },
    required: ["subject", "body"],
  },
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
export const emailSchema = z.object({
  subject: z.string().trim().min(3).transform((s) => clip(s, 120)),
  body: z.string().trim().min(20).transform((s) => clip(s, 2000)),
});
export type DraftEmail = z.infer<typeof emailSchema>;

/** The text that goes: placeholders filled, the "manage what we send you" line after it, as a quick message carries. */
export function finalText(body: string, values: { firstName: string | null; senderName: string }, preferencesUrl: string): string {
  const filled = body.replace(/\{\{\s*firstName\s*\}\}/g, values.firstName?.trim() || "there").replace(/\{\{\s*senderName\s*\}\}/g, values.senderName);
  return `${filled}\n\n—\nManage what we send you: ${preferencesUrl}`;
}
