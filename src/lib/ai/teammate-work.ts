import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { TEAMMATE_KEYS, isTeammateKey, type TeammateKey } from "@/lib/ai/teammates";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * The AI teammates' work, as it happens (owner, 19 Nov 2026 — "user can see agents working on screen"): a job writes a
 * row as it starts, moves it on at each real step and closes it with what came of it. The header's team strip, the cards'
 * live steps and Today's "Your AI team today" all read these rows — so everything shown is work really being done, never
 * an animation of its own.
 *
 * A row is seen only by the person it is for (`userId`): whoever pressed the button, or the lead's owner for work done by
 * itself. Recording never stops the job: every write here swallows its own failure. Rows are kept 30 days.
 */

export type WorkKind = "research.plan" | "research.brief" | "nurture.draft" | "reengage.draft" | "workflow.draft" | "collections.chase" | "collections.reply" | "hr.answer" | "bills.read" | "receipts.read" | "bank.match";

export type WorkStart = {
  teammate: TeammateKey;
  userId: string;
  kind: WorkKind;
  /** "lead:<id>" / "company:<id>" / "workflow:draft" — how a card finds its own job. */
  subject?: string | null;
  /** What it is about, as its person may see it. */
  label: string;
  href?: string | null;
  steps: string[];
};

/** A job left RUNNING longer than this crashed or was cut off: nobody is shown it as working. */
export const WORK_STALE_MS = 5 * 60_000;
const KEEP_MS = 30 * 24 * 60 * 60_000;

const quiet = (err: unknown) => {
  if (!notMigratedYet(err)) console.error("[teammate-work]", err instanceof Error ? err.message : err);
};

/** How a job reports itself as it goes. */
export type WorkHandle = {
  /** Now on step `index` — those before it are done. */
  step: (index: number) => Promise<void>;
  /** A better name for what it is about, once the job has read it. */
  about: (label: string, href?: string | null) => Promise<void>;
};

/**
 * Runs `job` as a teammate's work: recorded as it starts, at each step it reports, and as it ends — DONE with `summary`
 * of what came back, FAILED with the error's own words when they are meant for a person.
 */
export async function teammateWork<T>(start: WorkStart, job: (work: WorkHandle) => Promise<T>, summary?: (result: T) => string | null): Promise<T> {
  let id: string | null = null;
  try {
    id = (await db.aiTeammateWork.create({ data: { ...start, subject: start.subject ?? null, href: start.href ?? null, label: start.label.slice(0, 200) }, select: { id: true } })).id;
  } catch (err) {
    quiet(err);
  }
  const write = async (data: Record<string, unknown>) => {
    if (!id) return;
    await db.aiTeammateWork.update({ where: { id }, data }).catch(quiet);
  };
  const handle: WorkHandle = {
    step: (index) => write({ step: Math.max(0, Math.min(index, start.steps.length - 1)) }),
    about: (label, href) => write({ label: label.slice(0, 200), ...(href !== undefined ? { href } : {}) }),
  };
  try {
    const result = await job(handle);
    await write({ status: "DONE", step: start.steps.length, finishedAt: new Date(), summary: summary?.(result)?.slice(0, 300) ?? null });
    return result;
  } catch (err) {
    // Only words written for a person (the jobs' own refusals) are kept; anything else is just "didn't finish".
    const meant = err instanceof Error && /Refusal$/.test(err.constructor.name) ? err.message : null;
    await write({ status: "FAILED", finishedAt: new Date(), summary: (meant ?? "It didn't finish — try again.").slice(0, 300) });
    throw err;
  }
}

export type WorkRow = {
  id: string;
  teammate: TeammateKey;
  kind: string;
  subject: string | null;
  label: string;
  href: string | null;
  steps: string[];
  step: number;
  status: "RUNNING" | "DONE" | "FAILED";
  summary: string | null;
  startedAt: string;
  finishedAt: string | null;
};

type Stored = { id: string; teammate: string; kind: string; subject: string | null; label: string; href: string | null; steps: unknown; step: number; status: string; summary: string | null; startedAt: Date; finishedAt: Date | null };

function view(r: Stored, now: Date): WorkRow | null {
  if (!isTeammateKey(r.teammate)) return null;
  // A job cut off mid-way reads as one that didn't finish, not as work still going.
  const stale = r.status === "RUNNING" && now.getTime() - r.startedAt.getTime() > WORK_STALE_MS;
  return {
    id: r.id,
    teammate: r.teammate,
    kind: r.kind,
    subject: r.subject,
    label: r.label,
    href: r.href,
    steps: Array.isArray(r.steps) ? r.steps.filter((s): s is string => typeof s === "string") : [],
    step: r.step,
    status: stale ? "FAILED" : r.status === "DONE" ? "DONE" : r.status === "FAILED" ? "FAILED" : "RUNNING",
    summary: stale ? "It didn't finish." : r.summary,
    startedAt: r.startedAt.toISOString(),
    finishedAt: r.finishedAt?.toISOString() ?? null,
  };
}

const SELECT = { id: true, teammate: true, kind: true, subject: true, label: true, href: true, steps: true, step: true, status: true, summary: true, startedAt: true, finishedAt: true } as const;

export type TeamActivity = {
  /** Jobs going now, newest first. */
  running: WorkRow[];
  /** The last few that ended, newest first. */
  recent: WorkRow[];
  /** How many each teammate finished since `since`. */
  done: Record<TeammateKey, number>;
};

const NONE: TeamActivity = { running: [], recent: [], done: Object.fromEntries(TEAMMATE_KEYS.map((k) => [k, 0])) as Record<TeammateKey, number> };

/** This person's AI team: what is going, what just ended, and how much each finished since `since` (the day's start). */
export async function teamActivityFor(userId: string, since: Date, now = new Date()): Promise<TeamActivity> {
  try {
    const [live, ended, counts] = await Promise.all([
      db.aiTeammateWork.findMany({ where: { userId, status: "RUNNING", startedAt: { gte: new Date(now.getTime() - WORK_STALE_MS) } }, orderBy: { startedAt: "desc" }, take: 10, select: SELECT }),
      db.aiTeammateWork.findMany({ where: { userId, status: { in: ["DONE", "FAILED"] } }, orderBy: { startedAt: "desc" }, take: 8, select: SELECT }),
      db.aiTeammateWork.groupBy({ by: ["teammate"], where: { userId, status: "DONE", startedAt: { gte: since } }, _count: { _all: true } }),
    ]);
    const done = { ...NONE.done };
    for (const c of counts) if (isTeammateKey(c.teammate)) done[c.teammate] = c._count._all;
    return {
      running: live.flatMap((r) => view(r, now) ?? []),
      recent: ended.flatMap((r) => view(r, now) ?? []),
      done,
    };
  } catch (err) {
    if (notMigratedYet(err)) return NONE;
    throw err;
  }
}

/** When the workspace's own day began. */
export async function teamDayStart(now = new Date()): Promise<Date> {
  const clock = await workspaceClock();
  return clock.startOfDay(clock.today()) ?? new Date(now.getTime() - 24 * 60 * 60_000);
}

/** The same, counted since the workspace's own day began. */
export async function teamActivityToday(userId: string): Promise<TeamActivity> {
  const now = new Date();
  return teamActivityFor(userId, await teamDayStart(now), now);
}

/** The last jobs done for this person, newest first — the Team room's feed. */
export async function teamFeedFor(userId: string, take = 40, now = new Date()): Promise<WorkRow[]> {
  try {
    const rows = await db.aiTeammateWork.findMany({ where: { userId }, orderBy: { startedAt: "desc" }, take: Math.min(Math.max(take, 1), 100), select: SELECT });
    return rows.flatMap((r) => view(r, now) ?? []);
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** The job this person has going on one record, or the one that just ended there (within a minute) — for its card. */
export async function workOn(userId: string, subject: string, now = new Date()): Promise<WorkRow | null> {
  try {
    const row = await db.aiTeammateWork.findFirst({ where: { userId, subject, startedAt: { gte: new Date(now.getTime() - WORK_STALE_MS) } }, orderBy: { startedAt: "desc" }, select: SELECT });
    return row ? view(row, now) : null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** Rows past their 30 days go — run from the heartbeat. */
export async function pruneTeammateWork(now = new Date()): Promise<number> {
  try {
    return (await db.aiTeammateWork.deleteMany({ where: { startedAt: { lt: new Date(now.getTime() - KEEP_MS) } } })).count;
  } catch (err) {
    quiet(err);
    return 0;
  }
}
