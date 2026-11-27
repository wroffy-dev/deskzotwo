/**
 * Service cycles' rules, plain (owner, 9 Nov 2026 — src/lib/service-cycles/server.ts does the rest): the timeline a plan
 * makes between a start and an end, what each job's state is, and how a timeline is brought in step when the dates move.
 * Days are `yyyy-mm-dd`, the workspace's calendar.
 */

export type StepPlan = { id: string; firstAfterMonths: number; everyMonths: number | null };
export type TimelineJob = { stepId: string; seq: number; due: string };
export type JobState = "PLANNED" | "OPEN" | "OVERDUE" | "DONE" | "SKIPPED";

/** More than a lifetime of monthly visits: a plan typed wrong doesn't fill the database. */
export const MAX_JOBS = 600;
export const MAX_MONTHS = 120;

const DAY_MS = 86_400_000;
const lastDay = (year: number, month: number) => new Date(Date.UTC(year, month, 0)).getUTCDate();

/** A day moved by whole months, kept to the month's last day: 31 Jan and a month is 28 or 29 Feb. */
export function addMonths(day: string, months: number): string {
  const [y, m, d] = day.split("-").map(Number) as [number, number, number];
  const index = y * 12 + (m - 1) + months;
  const year = Math.floor(index / 12);
  const month = (index % 12) + 1;
  return `${year}-${String(month).padStart(2, "0")}-${String(Math.min(d, lastDay(year, month))).padStart(2, "0")}`;
}

/** A real calendar day as `yyyy-mm-dd` — not 2026-13-01 or 30 February. */
export const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().slice(0, 10) === v;

export const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10);

/**
 * Every job a plan makes from `start` to `end`, both days in, soonest first. A step comes first so many months after the
 * start and then every so many months; one with no repeat comes once. Each time round counts from the start, not from the
 * one before, so a long cycle doesn't drift.
 */
export function timeline(steps: readonly StepPlan[], start: string, end: string): TimelineJob[] {
  const out: TimelineJob[] = [];
  for (const step of steps) {
    for (let seq = 1; out.length < MAX_JOBS; seq += 1) {
      const due = addMonths(start, step.firstAfterMonths + (seq - 1) * (step.everyMonths ?? 0));
      if (due > end) break;
      out.push({ stepId: step.id, seq, due });
      if (!step.everyMonths) break;
    }
  }
  return out.sort((a, b) => a.due.localeCompare(b.due) || a.seq - b.seq);
}

/** The day a job becomes somebody's task. */
export const opensOn = (due: string, showDaysBefore: number) => addDays(due, -Math.max(0, showDaysBefore));

/** Where a job stands: skipped, done with its task, overdue, a task to do, or still ahead with no task yet. */
export function jobState(job: { due: string; skipped: boolean; task: { done: boolean } | null }, today: string): JobState {
  if (job.skipped) return "SKIPPED";
  if (job.task?.done) return "DONE";
  if (job.due < today) return "OVERDUE";
  return job.task ? "OPEN" : "PLANNED";
}

export const STATE_WORDS: Record<JobState, string> = { PLANNED: "Planned", OPEN: "To do", OVERDUE: "Overdue", DONE: "Done", SKIPPED: "Skipped" };

export type ExistingJob = { id: string; stepId: string; seq: number; due: string; kept: boolean };
/**
 * A timeline brought in step with new dates or steps. A job that has started — a task made, or skipped — stays as it is;
 * one still only planned moves to its new day, or goes when the new timeline hasn't got it; what's new is added.
 */
export function reconcile(existing: readonly ExistingJob[], wanted: readonly TimelineJob[]): { add: TimelineJob[]; move: { id: string; due: string }[]; remove: string[] } {
  const key = (j: { stepId: string; seq: number }) => `${j.stepId}#${j.seq}`;
  const want = new Map(wanted.map((w) => [key(w), w]));
  const have = new Map(existing.map((e) => [key(e), e]));
  const add = wanted.filter((w) => !have.has(key(w)));
  const move: { id: string; due: string }[] = [];
  const remove: string[] = [];
  for (const e of existing) {
    if (e.kept) continue;
    const w = want.get(key(e));
    if (!w) remove.push(e.id);
    else if (w.due !== e.due) move.push({ id: e.id, due: w.due });
  }
  return { add, move, remove };
}

export type StepInput = { id?: string; name: string; firstAfterMonths: number; everyMonths: number | null; showDaysBefore: number; checklist: string[] };
export type TemplateInput = { name: string; description?: string | null; months: number; steps: StepInput[] };

/** Why a plan can't be saved, or null. */
export function templateProblem(t: TemplateInput): string | null {
  if (!t.name.trim()) return "Give the plan a name.";
  if (!Number.isInteger(t.months) || t.months < 1 || t.months > MAX_MONTHS) return `A cycle runs from 1 to ${MAX_MONTHS} months.`;
  if (t.steps.length === 0) return "Add at least one step.";
  if (t.steps.length > 30) return "At most 30 steps.";
  for (const s of t.steps) {
    const named = s.name.trim() || "A step";
    if (!s.name.trim()) return "Every step needs a name.";
    if (!Number.isInteger(s.firstAfterMonths) || s.firstAfterMonths < 0 || s.firstAfterMonths > MAX_MONTHS) return `${named}: when it first comes is 0 to ${MAX_MONTHS} months after the start.`;
    if (s.everyMonths !== null && (!Number.isInteger(s.everyMonths) || s.everyMonths < 1 || s.everyMonths > MAX_MONTHS)) return `${named}: it repeats every 1 to ${MAX_MONTHS} months, or once.`;
    if (!Number.isInteger(s.showDaysBefore) || s.showDaysBefore < 0 || s.showDaysBefore > 365) return `${named}: it becomes a task 0 to 365 days before it's due.`;
    if (s.checklist.length > 50) return `${named}: at most 50 checklist lines.`;
  }
  return null;
}

/** "Every 3 months", "Once", "Every year" — how a step comes round. */
export function cadenceWords(s: { firstAfterMonths: number; everyMonths: number | null }): string {
  const every = s.everyMonths === null ? "Once" : s.everyMonths === 1 ? "Every month" : s.everyMonths === 12 ? "Every year" : s.everyMonths % 12 === 0 ? `Every ${s.everyMonths / 12} years` : `Every ${s.everyMonths} months`;
  const first = s.firstAfterMonths === 0 ? "from the start" : `from month ${s.firstAfterMonths}`;
  return `${every}, ${first}`;
}
