import { z } from "zod";
import type { ToolSpec } from "@/lib/copilot/types";

/**
 * "Research & plan" (owner, 18 Nov 2026 — phase 1 of the lead-nurturing agent: "yes build phase 1"). One click on a lead
 * or a company: Deskzo AI reads the company's public research and where the lead stands, says how warm it is and why,
 * and proposes the next few steps and a first email. Nothing is done by itself — the person ticks the steps they want
 * as tasks and copies the email; src/lib/research/plan-server.ts reads the facts and keeps the plan.
 *
 * Pure: what is sent is built here, so a check reads exactly what leaves. What goes is the public research (as the brief
 * sends it) and, of the workspace's own dealings, only the shape of the lead — its title, stage, source, the products
 * asked about, how long it has been open, how recently and how often it was touched — and contacts' job titles. Never a
 * person's name, phone or email, an amount, a note or a document.
 */

export const PLAN_FITS = ["HOT", "WARM", "COLD"] as const;
export type PlanFit = (typeof PLAN_FITS)[number];
export const PLAN_STEP_KINDS = ["CALL", "EMAIL", "MEETING", "TASK"] as const;
export type PlanStepKind = (typeof PLAN_STEP_KINDS)[number];

export const FIT_LABELS: Record<PlanFit, string> = { HOT: "Hot", WARM: "Warm", COLD: "Cold" };
export const STEP_LABELS: Record<PlanStepKind, string> = { CALL: "Call", EMAIL: "Email", MEETING: "Meeting", TASK: "Task" };

/** What the plan is made from. Every field is something the person may already see on the page. */
export type PlanInput = {
  kind: "lead" | "company";
  /** The workspace's day, "2026-11-18": the model counts due days from it. */
  today: string;
  company: {
    name: string;
    /** "client", "reseller", "vendor"… */
    relationship: string;
    /** "prospect", "customer"… */
    stage: string;
    city: string | null;
    /** The research's labelled public lines ("[Website] About page: …"), as the brief is written from. */
    publicFacts: string[];
    /** The brief Deskzo AI wrote from them, when there is one. */
    brief: string | null;
    /** Subscriptions with us renewing in the next 90 days: how many, not what or for how much. */
    renewingSoon: number | null;
    /** How many other open leads the company has — a count: their titles may be somebody else's to see. */
    openLeads: number;
  };
  lead: {
    title: string;
    stage: string;
    status: string;
    source: string;
    openForDays: number;
    inStageDays: number | null;
    lastTouchDaysAgo: number | null;
    touchesLast30: { calls: number; emails: number; meetings: number; notes: number };
    products: string[];
    proposalSent: boolean;
    expectedCloseInDays: number | null;
    /** The lead score Deskzo keeps, 0–100. */
    score: number | null;
  } | null;
  /** Contacts' job titles only, the primary first — never who they are. */
  contactTitles: string[];
};

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Ved's instructions — India's, or the same without India in them for a workspace elsewhere (the UAE). */
export const planSystemFor = (india: boolean) => [
  `You help a B2B salesperson${india ? " in India" : ""} decide what to do next with one lead or company.`,
  "Use ONLY the facts given. Never invent a fact, a name, a number, a product, a price, a discount or a deadline.",
  "If the facts are thin, say so in the reasons and keep the plan simple.",
  "Call propose_plan exactly once with:",
  "fit — HOT (clear need, recent interest, moving), WARM (some interest or fit, not moving) or COLD (little sign of need or no response);",
  "fitReasons — two to four short reasons, each naming the fact it rests on;",
  "summary — one sentence on where things stand;",
  "steps — one to four concrete next steps, most important first, each with kind (CALL, EMAIL, MEETING or TASK), a short",
  "title a salesperson would write on a to-do list (under 90 characters), why (the fact that prompts it), and dueInDays",
  "(0 for today, at most 30);",
  "questions — up to three questions to ask on the next call;",
  "email — a short first email for the next step (subject under 80 characters; body under 140 words) in plain, polite",
  `${india ? "Indian " : ""}business English.` + " Start the body with \"Hi {{firstName}},\" and end it with \"{{senderName}}\" on its own line.",
  "No prices, discounts, offers, attachments or promises in it, and no claims the facts don't support.",
  "If an email isn't the right next step, still write the one you would send after the first step.",
].join(" ");

export const PLAN_SYSTEM = planSystemFor(true);

/** The facts as the model reads them. */
export function planPrompt(input: PlanInput): string {
  const c = input.company;
  const lines: string[] = [`Today: ${input.today}`, `Company: ${c.name} (${c.relationship}, ${c.stage}${c.city ? `, ${c.city}` : ""})`];
  if (c.renewingSoon) lines.push(`Subscriptions with us renewing in the next 90 days: ${c.renewingSoon}`);
  if (c.openLeads) lines.push(`Other open leads on this company: ${c.openLeads}`);
  if (input.contactTitles.length) lines.push(`Contacts' job titles: ${input.contactTitles.join(", ")}`);
  else lines.push("Contacts: none on file");
  const l = input.lead;
  if (l) {
    lines.push("", `Lead: ${clip(l.title, 200)}`);
    lines.push(`Stage: ${l.stage} (${l.status})${l.inStageDays !== null ? `, for ${l.inStageDays} days` : ""}`);
    lines.push(`Source: ${l.source}`, `Open for: ${l.openForDays} days`);
    lines.push(l.lastTouchDaysAgo === null ? "Last call, email, meeting or note: none yet" : `Last call, email, meeting or note: ${l.lastTouchDaysAgo} days ago`);
    const t = l.touchesLast30;
    lines.push(`In the last 30 days — calls: ${t.calls}, emails: ${t.emails}, meetings: ${t.meetings}, notes: ${t.notes}`);
    if (l.products.length) lines.push(`Products asked about: ${l.products.map((p) => clip(p, 80)).join(", ")}`);
    lines.push(`Proposal or quote sent: ${l.proposalSent ? "yes" : "no"}`);
    if (l.expectedCloseInDays !== null) lines.push(l.expectedCloseInDays >= 0 ? `Expected to close in: ${l.expectedCloseInDays} days` : `Expected close date passed ${-l.expectedCloseInDays} days ago`);
    if (l.score !== null) lines.push(`Lead score (0–100): ${l.score}`);
  }
  if (c.publicFacts.length) lines.push("", "Public research:", ...c.publicFacts.map((f) => clip(f, 600)));
  if (c.brief) lines.push("", "Research brief:", clip(c.brief, 2500));
  if (!c.publicFacts.length && !c.brief) lines.push("", "Public research: none found yet");
  lines.push("", input.kind === "lead" ? "Plan the next steps for this lead." : "Plan the next steps for this company.");
  return lines.join("\n");
}

export const PROPOSE_PLAN: ToolSpec = {
  name: "propose_plan",
  description: "Hand back the plan. Call it once, with all of it.",
  parameters: {
    type: "object",
    properties: {
      fit: { type: "string", enum: [...PLAN_FITS] },
      fitReasons: { type: "array", items: { type: "string" }, description: "Two to four short reasons, each naming its fact." },
      summary: { type: "string", description: "One sentence on where things stand." },
      steps: {
        type: "array",
        description: "One to four next steps, most important first.",
        items: {
          type: "object",
          properties: {
            kind: { type: "string", enum: [...PLAN_STEP_KINDS] },
            title: { type: "string" },
            why: { type: "string" },
            dueInDays: { type: "integer", minimum: 0, maximum: 30 },
          },
          required: ["kind", "title", "why", "dueInDays"],
        },
      },
      questions: { type: "array", items: { type: "string" }, description: "Up to three questions for the next call." },
      email: {
        type: "object",
        properties: { subject: { type: "string" }, body: { type: "string" } },
        required: ["subject", "body"],
      },
    },
    required: ["fit", "fitReasons", "summary", "steps", "email"],
  },
};

const text = (max: number) => z.string().trim().min(1).transform((s) => clip(s, max));

/** What a plan may be — anything else the model hands back is refused, and the longest texts clipped. */
export const planSchema = z.object({
  fit: z.enum(PLAN_FITS),
  fitReasons: z.array(text(240)).min(1).transform((a) => a.slice(0, 4)),
  summary: text(300),
  steps: z
    .array(
      z.object({
        kind: z.enum(PLAN_STEP_KINDS),
        title: text(120),
        why: text(240),
        dueInDays: z.coerce.number().int().transform((n) => Math.max(0, Math.min(30, n))),
      }),
    )
    .min(1)
    .transform((a) => a.slice(0, 4)),
  questions: z
    .array(text(200))
    .optional()
    .transform((a) => (a ?? []).slice(0, 3)),
  email: z.object({ subject: text(120), body: text(2000) }).nullable().optional(),
});

export type PlanBody = z.infer<typeof planSchema>;

/** The plan as kept: what the model said, and what the person has done with it since. */
export type StoredPlan = PlanBody & {
  /** Step index → the task made from it. */
  tasks: Record<string, string>;
  /** Deskzo AI's model key, and what it cost. */
  model: string;
  credits: number;
};

/** A plan from the model's tool call, or the reason it isn't one. */
export function planFromCall(input: unknown): { ok: true; plan: PlanBody } | { ok: false; problems: string[] } {
  const parsed = planSchema.safeParse(input);
  if (parsed.success) return { ok: true, plan: parsed.data };
  return { ok: false, problems: parsed.error.issues.slice(0, 10).map((i) => `${i.path.join(".") || "plan"}: ${i.message}`) };
}

/** The email with its two placeholders filled for the person about to send it. */
export function fillEmail(body: string, values: { firstName: string | null; senderName: string | null }): string {
  return body
    .replace(/\{\{\s*firstName\s*\}\}/g, values.firstName?.trim() || "there")
    .replace(/\{\{\s*senderName\s*\}\}/g, values.senderName?.trim() || "");
}

/** "2026-11-18" plus a few days, as the task's due day. Pure — no clock, no zone: calendar days. */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split("-").map(Number);
  const at = new Date(Date.UTC(y!, m! - 1, d! + days));
  return at.toISOString().slice(0, 10);
}
