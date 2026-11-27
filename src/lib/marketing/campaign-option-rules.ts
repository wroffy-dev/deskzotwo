/**
 * What a campaign does beyond one email to one audience (owner, 1 Nov 2026 — the gaps against Mailchimp, Brevo, Zoho
 * Campaigns): an A/B test, a resend to those who didn't open, and when each person gets it. Kept in CampaignOption, a
 * table of its own; this file — client-safe — checks it and does the arithmetic (campaign-options.ts reads it) — the sending is the pipeline's
 * (src/lib/marketing/pipeline.ts) and the follow-ups the tick's (src/lib/marketing/campaign-followups.ts).
 */

export type AbTest = {
  /** What differs between A and B: the subject line, or the whole email. */
  test: "subject" | "template";
  /** B's subject, for a subject test. */
  subjectB: string | null;
  /** B's email, for a template test. */
  templateBId: string | null;
  /** The share of the audience the test goes to, half each — the rest get the winner. */
  percent: number;
  /** What wins: more opens, or more clicks. */
  metric: "opens" | "clicks";
  /** How long the test runs before the winner is picked. */
  hours: number;
  decidedAt?: string | null;
  winner?: "A" | "B" | null;
  stats?: { A: VariantStats; B: VariantStats } | null;
};

export type VariantStats = { sent: number; opened: number; clicked: number };

export type Resend = {
  /** Hours after the campaign has gone. */
  afterHours: number;
  /** The new subject — the same subject twice is how a resend ends up in spam. */
  subject: string;
  doneAt?: string | null;
  childId?: string | null;
  count?: number | null;
};

export type CampaignOptions = {
  abTest: AbTest | null;
  resend: Resend | null;
  subject: string | null;
  recipientIds: string[] | null;
  parentId: string | null;
  sendTime: "best" | null;
};

export const NO_OPTIONS: CampaignOptions = { abTest: null, resend: null, subject: null, recipientIds: null, parentId: null, sendTime: null };

export const AB_LIMITS = { minPercent: 10, maxPercent: 50, minHours: 1, maxHours: 72 } as const;
export const RESEND_LIMITS = { minHours: 24, maxHours: 168 } as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, Math.round(n)));

export function abTestOf(raw: unknown): AbTest | null {
  if (!isObj(raw)) return null;
  const test = raw.test === "template" ? "template" : raw.test === "subject" ? "subject" : null;
  if (!test) return null;
  return {
    test,
    subjectB: typeof raw.subjectB === "string" && raw.subjectB.trim() ? raw.subjectB.trim().slice(0, 200) : null,
    templateBId: typeof raw.templateBId === "string" && raw.templateBId ? raw.templateBId : null,
    percent: clamp(Number(raw.percent) || 20, AB_LIMITS.minPercent, AB_LIMITS.maxPercent),
    metric: raw.metric === "clicks" ? "clicks" : "opens",
    hours: clamp(Number(raw.hours) || 4, AB_LIMITS.minHours, AB_LIMITS.maxHours),
    decidedAt: typeof raw.decidedAt === "string" ? raw.decidedAt : null,
    winner: raw.winner === "A" || raw.winner === "B" ? raw.winner : null,
    stats: isObj(raw.stats) ? (raw.stats as AbTest["stats"]) : null,
  };
}

export function resendOf(raw: unknown): Resend | null {
  if (!isObj(raw) || typeof raw.subject !== "string" || !raw.subject.trim()) return null;
  return {
    afterHours: clamp(Number(raw.afterHours) || 72, RESEND_LIMITS.minHours, RESEND_LIMITS.maxHours),
    subject: raw.subject.trim().slice(0, 200),
    doneAt: typeof raw.doneAt === "string" ? raw.doneAt : null,
    childId: typeof raw.childId === "string" ? raw.childId : null,
    count: typeof raw.count === "number" ? raw.count : null,
  };
}

/** The form's A/B test and resend, checked: the reason it can't be saved, or what to keep. */
export function checkOptions(input: { abTest?: unknown; resend?: unknown; sendTime?: unknown }, templateId: string): { ok: true; abTest: AbTest | null; resend: Resend | null; sendTime: "best" | null } | { ok: false; error: string } {
  const ab = input.abTest ? abTestOf(input.abTest) : null;
  if (input.abTest && !ab) return { ok: false, error: "Say what the A/B test compares: two subject lines, or two emails." };
  if (ab?.test === "subject" && !ab.subjectB) return { ok: false, error: "Give version B its subject line." };
  if (ab?.test === "template" && (!ab.templateBId || ab.templateBId === templateId)) return { ok: false, error: "Pick a different email for version B." };
  const resend = input.resend ? resendOf(input.resend) : null;
  if (input.resend && !resend) return { ok: false, error: "Give the resend its new subject line." };
  return { ok: true, abTest: ab ? { ...ab, decidedAt: null, winner: null, stats: null } : null, resend: resend ? { ...resend, doneAt: null, childId: null, count: null } : null, sendTime: input.sendTime === "best" ? "best" : null };
}

/** A stable number from a string — the same person lands in the same half every time the split is worked out. */
function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i += 1) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return h >>> 0;
}

/**
 * Who the test goes to, and with which version: `percent` of the people, shuffled by a hash of the campaign and each
 * person (so a re-run picks the same people), alternating A and B — at least one each where there are two people.
 */
export function splitTest(campaignId: string, contactIds: string[], percent: number): Map<string, "A" | "B"> {
  const shuffled = [...contactIds].sort((a, b) => hash(`${campaignId}:${a}`) - hash(`${campaignId}:${b}`) || a.localeCompare(b));
  const size = contactIds.length < 2 ? contactIds.length : Math.max(2, Math.round((contactIds.length * percent) / 100));
  const out = new Map<string, "A" | "B">();
  shuffled.slice(0, size).forEach((id, i) => out.set(id, i % 2 === 0 ? "A" : "B"));
  return out;
}

/** The rate a version won by — opens or clicks over those it went to. */
export const rateOf = (s: VariantStats, metric: AbTest["metric"]) => (s.sent ? (metric === "clicks" ? s.clicked : s.opened) / s.sent : 0);

/** The winner: the higher rate on the chosen measure; a tie goes to A, the email as it was written. */
export function pickWinner(stats: { A: VariantStats; B: VariantStats }, metric: AbTest["metric"]): "A" | "B" {
  return rateOf(stats.B, metric) > rateOf(stats.A, metric) ? "B" : "A";
}
