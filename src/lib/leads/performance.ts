import type { Prisma, PrismaClient } from "@prisma/client";

/**
 * How well each salesperson works the leads they're given (owner, 26 Oct 2026) — for the PERFORMANCE way of
 * choosing in an assignment rule (src/lib/leads/assign.ts), and shown in Settings › Lead assignment.
 *
 *   · Closing — of their leads decided in the last 90 days, how many were won. Half the score.
 *   · Answering — how long, the middle value, from being given a lead to first doing something with it
 *     (src/lib/leads/response.ts), over the last 90 days. Faster is better. Three tenths.
 *   · Keeping at it — calls and activities on leads in the last 30 days, for each lead they have open. A fifth.
 *
 * Each is measured against the best in the rule's pool, so the score says "how this person compares with the
 * others who could take it", from 0 to 1. Too little to go on — fewer than five leads decided, fewer than
 * three answered — and that part is the pool's average: a new joiner starts in the middle, not at the bottom.
 *
 * The share: a weighted turn. Each lead goes to whoever has had the fewest leads in the last 30 days for their
 * weight, and the weight is a quarter plus the score — so the best get up to five times the weakest, and
 * nobody gets none. Pure, so a suite can check the sums.
 */

export const WEIGHTS = { closing: 0.5, answering: 0.3, activity: 0.2 } as const;
export const MIN_DECIDED = 5;
export const MIN_ANSWERED = 3;
export const SHARE_FLOOR = 0.25;
export const CLOSING_DAYS = 90;
export const ACTIVITY_DAYS = 30;

export type PersonFigures = {
  userId: string;
  /** Leads decided (won, lost or disqualified) in the last 90 days, and how many of them were won. */
  decided: number;
  won: number;
  /** Minutes from being given each lead to first touching it, over the last 90 days. */
  answerMinutes: number[];
  /** Calls and activities on leads in the last 30 days. */
  touches: number;
  openLeads: number;
  /** Leads they were given in the last 30 days — whatever gave them. */
  givenRecently: number;
};

export type PersonScore = {
  userId: string;
  /** Won of decided, as a fraction; null with too few decided. */
  closeRate: number | null;
  /** The middle answer time in minutes; null with too few answered. */
  answerMinutes: number | null;
  /** Touches for each open lead; null with nothing open and nothing done. */
  activity: number | null;
  /** 0 to 1, against the rest of the pool. */
  score: number;
  /** What their share is weighted by. */
  weight: number;
};

const median = (values: number[]) => {
  if (values.length === 0) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
};
const mean = (values: number[]) => (values.length ? values.reduce((a, b) => a + b, 0) / values.length : null);

export function performanceScores(people: PersonFigures[]): Map<string, PersonScore> {
  const raw = people.map((p) => ({
    userId: p.userId,
    closeRate: p.decided >= MIN_DECIDED ? p.won / p.decided : null,
    answerMinutes: p.answerMinutes.length >= MIN_ANSWERED ? Math.max(1, median(p.answerMinutes)!) : null,
    activity: p.openLeads > 0 || p.touches > 0 ? p.touches / Math.max(1, p.openLeads) : null,
  }));
  const best = {
    close: Math.max(0, ...raw.map((r) => r.closeRate ?? 0)),
    answer: Math.min(Infinity, ...raw.map((r) => r.answerMinutes ?? Infinity)),
    activity: Math.max(0, ...raw.map((r) => r.activity ?? 0)),
  };
  // Each part against the best; missing parts are filled with the pool's average of that part.
  const parts = raw.map((r) => ({
    closing: r.closeRate === null ? null : best.close > 0 ? r.closeRate / best.close : 0,
    answering: r.answerMinutes === null || !Number.isFinite(best.answer) ? null : best.answer / r.answerMinutes,
    activity: r.activity === null ? null : best.activity > 0 ? r.activity / best.activity : 0,
  }));
  const fill = {
    closing: mean(parts.map((p) => p.closing).filter((v): v is number => v !== null)) ?? 0.5,
    answering: mean(parts.map((p) => p.answering).filter((v): v is number => v !== null)) ?? 0.5,
    activity: mean(parts.map((p) => p.activity).filter((v): v is number => v !== null)) ?? 0.5,
  };
  const out = new Map<string, PersonScore>();
  raw.forEach((r, i) => {
    const p = parts[i]!;
    const score = WEIGHTS.closing * (p.closing ?? fill.closing) + WEIGHTS.answering * (p.answering ?? fill.answering) + WEIGHTS.activity * (p.activity ?? fill.activity);
    const rounded = Math.round(score * 1000) / 1000;
    out.set(r.userId, { ...r, score: rounded, weight: SHARE_FLOOR + rounded });
  });
  return out;
}

/** Whose turn it is: the fewest leads given lately for their weight; ties to whoever is earlier in the pool. */
export function weightedTurn(pool: string[], figures: Map<string, PersonFigures>, scores: Map<string, PersonScore>): string {
  const owed = (id: string) => ((figures.get(id)?.givenRecently ?? 0) + 1) / (scores.get(id)?.weight ?? SHARE_FLOOR);
  return pool.reduce((best, id) => (owed(id) < owed(best) ? id : best), pool[0]!);
}

type Db = PrismaClient | Prisma.TransactionClient;
const CLOSED = ["WON", "LOST", "DISQUALIFIED"] as const;

/** The figures for a pool, read in a handful of grouped queries. */
export async function loadFigures(db: Db, pool: string[], now = new Date()): Promise<Map<string, PersonFigures>> {
  const since90 = new Date(now.getTime() - CLOSING_DAYS * 86_400_000);
  const since30 = new Date(now.getTime() - ACTIVITY_DAYS * 86_400_000);
  const decidedWhere = { ownerUserId: { in: pool }, status: { in: [...CLOSED] }, OR: [{ stageChangedAt: { gte: since90 } }, { stageChangedAt: null, updatedAt: { gte: since90 } }] };
  const [decided, open, activities, calls, answered, given] = await Promise.all([
    db.lead.groupBy({ by: ["ownerUserId", "status"], where: decidedWhere, _count: true }),
    db.lead.groupBy({ by: ["ownerUserId"], where: { ownerUserId: { in: pool }, status: { notIn: [...CLOSED] } }, _count: true }),
    db.activity.groupBy({ by: ["userId"], where: { userId: { in: pool }, occurredAt: { gte: since30 } }, _count: true }),
    db.callLog.groupBy({ by: ["userId"], where: { userId: { in: pool }, leadId: { not: null }, startedAt: { gte: since30 } }, _count: true }),
    db.leadAssignment.findMany({ where: { userId: { in: pool }, assignedAt: { gte: since90 }, respondedAt: { not: null } }, select: { userId: true, assignedAt: true, respondedAt: true }, take: 20_000 }),
    db.leadAssignment.groupBy({ by: ["userId"], where: { userId: { in: pool }, assignedAt: { gte: since30 } }, _count: true }),
  ]);
  const out = new Map<string, PersonFigures>();
  for (const id of pool) {
    const mine = decided.filter((d) => d.ownerUserId === id);
    out.set(id, {
      userId: id,
      decided: mine.reduce((n, d) => n + d._count, 0),
      won: mine.filter((d) => d.status === "WON").reduce((n, d) => n + d._count, 0),
      answerMinutes: answered.filter((a) => a.userId === id).map((a) => Math.max(0, Math.round((a.respondedAt!.getTime() - a.assignedAt.getTime()) / 60_000))),
      touches: (activities.find((a) => a.userId === id)?._count ?? 0) + (calls.find((c) => c.userId === id)?._count ?? 0),
      openLeads: open.find((o) => o.ownerUserId === id)?._count ?? 0,
      givenRecently: given.find((g) => g.userId === id)?._count ?? 0,
    });
  }
  return out;
}
