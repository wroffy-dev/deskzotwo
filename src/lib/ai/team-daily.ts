import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";
import { copilotConfig } from "@/lib/copilot/settings";
import { isTeammateKey, type Teammate, type TeammateKey } from "@/lib/ai/teammates";
import { workspaceTeammates } from "@/lib/ai/teammates-server";
import { weekInWords } from "@/lib/ai/team-weekly";
import { waitingForYou, type WaitingForYou } from "@/lib/ai/waiting";

/**
 * The AI team's morning note (owner, 20 Nov 2026 — "Tara sent 6 follow-ups yesterday; 2 replies; 1 waiting for you"):
 * each working morning, Monday to Friday after nine on the workspace's clock, each person whose teammates did something
 * for them since the last working day began — or left something waiting — is told so, in one line. Monday's covers
 * Friday and the weekend. Counted from the work's own rows (src/lib/ai/teammate-work.ts), the emails that actually went
 * and the replies that came, and "Waiting for you" (src/lib/ai/waiting.ts). Once a morning (DailyJobRun); nothing for
 * somebody with nothing to say. Sent as the weekly note is, so it shows in the bell and is muted the same way.
 */

const JOB = "ai-team-daily";
const SEND_HOUR = 9;
const DAY = 86_400_000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

export type DayFacts = {
  /** Jobs finished, by "teammate|kind" — as the weekly note counts them. */
  done: Map<string, number>;
  /** Tara's follow-ups that went, and the replies that came to them. */
  taraSent: number;
  taraReplies: number;
  /** Arjun's chase emails that went. */
  arjunSent: number;
  waiting: WaitingForYou;
};

/** The note in words — or null when there is nothing to say. */
export function morningInWords(f: DayFacts, teammates: Record<TeammateKey, Teammate>, since: string): string | null {
  const parts: string[] = [];
  if (f.taraSent || f.taraReplies) {
    const said = [f.taraSent ? `sent ${plural(f.taraSent, "follow-up", "follow-ups")}` : null, f.taraReplies ? `${plural(f.taraReplies, "reply", "replies")} came in` : null].filter(Boolean);
    parts.push(`${teammates.tara.name}: ${said.join(", ")}`);
  }
  if (f.arjunSent) parts.push(`${teammates.arjun.name}'s chase emails sent: ${f.arjunSent}`);
  // What each finished, as the weekly note says it — Tara's drafts left out where her sends already speak.
  const done = weekInWords(f.done, teammates);
  if (done) parts.push(done);
  const waitingBits = (Object.entries(f.waiting.byTeammate) as [TeammateKey, number][]).map(([k, n]) => `${teammates[k].name} ${n}`);
  const waiting = f.waiting.total ? `Waiting for you: ${f.waiting.total}${waitingBits.length > 1 ? ` (${waitingBits.join(" · ")})` : ""}.` : null;
  if (!parts.length && !waiting) return null;
  return [parts.length ? `${since}: ${parts.join(" · ")}.` : null, waiting].filter(Boolean).join(" ");
}

/** When the note's window begins: the start of the last working day — Friday's on a Monday. */
export function windowStart(todayKey: string, weekday: number): string {
  const back = weekday === 1 ? 3 : weekday === 0 ? 2 : 1;
  const d = new Date(`${todayKey}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

/** Who might have something: work for them lately, nurtures they own, chases they drafted, chats given to them, HR. */
async function candidates(since: Date): Promise<string[]> {
  const sets = await Promise.all([
    db.aiTeammateWork.findMany({ where: { startedAt: { gte: since } }, distinct: ["userId"], select: { userId: true } }).then((r) => r.map((x) => x.userId)),
    db.nurtureEnrolment.findMany({ where: { OR: [{ status: "ACTIVE" }, { updatedAt: { gte: since } }] }, distinct: ["ownerId"], select: { ownerId: true } }).then((r) => r.map((x) => x.ownerId)).catch(() => [] as string[]),
    db.collectionChase.findMany({ where: { OR: [{ status: "WAITING" }, { sentAt: { gte: since } }] }, distinct: ["createdById"], select: { createdById: true } }).then((r) => r.map((x) => x.createdById)).catch(() => [] as string[]),
    db.conversation.findMany({ where: { status: "OPEN", assignedToUserId: { not: null } }, distinct: ["assignedToUserId"], select: { assignedToUserId: true } }).then((r) => r.flatMap((x) => (x.assignedToUserId ? [x.assignedToUserId] : []))).catch(() => [] as string[]),
    // HR questions Priya passed on: the people the HR desk hands them to (Settings › HR desk).
    db.hrDeskQuestion.count({ where: { status: "WITH_HR" } }).then(async (n) => (n ? ((await db.hrDeskSettings.findFirst({ select: { handTo: true } }))?.handTo ?? []) : [])).catch(() => [] as string[]),
  ]);
  return [...new Set(sets.flat())].slice(0, 500);
}

/** What one person's team did for them in the window, and what waits. */
export async function dayFactsFor(userId: string, from: Date, to: Date): Promise<DayFacts> {
  const [work, taraSent, taraReplies, arjunSent, waiting] = await Promise.all([
    db.aiTeammateWork.groupBy({ by: ["teammate", "kind"], where: { userId, status: "DONE", startedAt: { gte: from, lt: to } }, _count: { _all: true } }),
    db.nurtureTouch.count({ where: { status: "SENT", sentAt: { gte: from, lt: to }, enrolment: { ownerId: userId } } }).catch(() => 0),
    db.nurtureReply.count({ where: { createdAt: { gte: from, lt: to }, kind: { not: "OUT_OF_OFFICE" }, enrolment: { ownerId: userId } } }).catch(() => 0),
    db.collectionChase.count({ where: { status: "SENT", sentAt: { gte: from, lt: to }, OR: [{ sentById: userId }, { sentById: null, createdById: userId }] } }).catch(() => 0),
    waitingForYou(userId),
  ]);
  const done = new Map<string, number>();
  for (const r of work) if (isTeammateKey(r.teammate)) done.set(`${r.teammate}|${r.kind}`, r._count._all);
  // Her drafts are told by what went: "drafted 6" and "sent 6" on one line says it twice.
  if (taraSent) done.delete("tara|nurture.draft");
  return { done, taraSent, taraReplies, arjunSent, waiting };
}

export type DailyRun = { told: number; reason?: string };

/** The heartbeat's turn: on a working morning after nine, once, each person's note. */
export async function runTeamDaily(now = new Date()): Promise<DailyRun> {
  try {
    const clock = await workspaceClock();
    const p = clock.parts(now);
    if (p.weekday === 0 || p.weekday === 6) return { told: 0, reason: "weekend" };
    if (p.hour < SEND_HOUR) return { told: 0, reason: "before nine" };
    if (!(await copilotConfig()).enabled) return { told: 0, reason: "Deskzo AI is off" };
    try {
      await db.dailyJobRun.create({ data: { job: JOB, day: clock.calendarDate(now), ranAt: now } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { told: 0, reason: "already sent" };
      throw err;
    }
    const today = clock.today(now);
    const fromKey = windowStart(today, p.weekday);
    const from = clock.startOfDay(fromKey) ?? new Date(now.getTime() - DAY);
    const to = clock.startOfDay(today) ?? now;
    const since = p.weekday === 1 ? "Since Friday" : "Yesterday";
    const people = await candidates(new Date(from.getTime() - 13 * DAY));
    if (!people.length) return { told: 0 };
    const active = new Set((await db.user.findMany({ where: { id: { in: people }, active: true }, select: { id: true } })).map((u) => u.id));
    const teammates = await workspaceTeammates();
    let told = 0;
    for (const userId of people) {
      if (!active.has(userId)) continue;
      try {
        const words = morningInWords(await dayFactsFor(userId, from, to), teammates, since);
        if (!words) continue;
        await notifyUser({ userId, type: "LEAD_ACTIVITY", title: "Good morning from your AI team", message: words, link: "/today" });
        told += 1;
      } catch (err) {
        console.error("[ai-team-daily] a note failed", err instanceof Error ? err.message : err);
      }
    }
    return { told };
  } catch (err) {
    if (notMigratedYet(err)) return { told: 0, reason: "not ready" };
    throw err;
  }
}
