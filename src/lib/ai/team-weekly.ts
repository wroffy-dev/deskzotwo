import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";
import { copilotConfig } from "@/lib/copilot/settings";
import { isTeammateKey, type Teammate, type TeammateKey } from "@/lib/ai/teammates";
import { workspaceTeammates } from "@/lib/ai/teammates-server";

/**
 * "Your AI team last week" (owner, 19 Nov 2026 — phase 3): on Monday, by the workspace's own calendar, each person whose
 * teammates finished work for them in the seven days before is told what — counted from src/lib/ai/teammate-work.ts's
 * own rows, so it says only what was done. One note a person, once a Monday (claimed in DailyJobRun), nothing for
 * somebody with nothing done.
 *
 * It goes as a notification of the lead-activity kind — most of this work is on leads — so it shows in the bell, is
 * emailed wherever the workspace emails that kind (Settings › Notification emails) and is muted by whoever mutes it. A
 * kind of its own would touch every list of kinds; this one is the honest nearest.
 */

const JOB = "ai-team-weekly";
const WEEK_MS = 7 * 24 * 60 * 60_000;

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What each teammate did, as their own clause — in a fixed order. */
const DID: [TeammateKey, string, (n: number) => string][] = [
  ["ved", "research.plan", (n) => `researched and planned ${plural(n, "lead", "leads")}`],
  ["ved", "research.brief", (n) => `wrote ${plural(n, "research brief", "research briefs")}`],
  ["tara", "nurture.draft", (n) => `drafted ${plural(n, "follow-up email", "follow-up emails")}`],
  ["tara", "reengage.draft", (n) => `drafted ${plural(n, "check-in to a quiet customer", "check-ins to quiet customers")}`],
  ["mira", "workflow.draft", (n) => `drafted ${plural(n, "workflow", "workflows")}`],
  ["arjun", "collections.chase", (n) => `drafted ${plural(n, "chase email", "chase emails")}`],
  ["arjun", "collections.reply", (n) => `read ${plural(n, "customer's reply", "customers' replies")}`],
  ["arjun", "bills.read", (n) => `read ${plural(n, "vendor bill", "vendor bills")}`],
  ["arjun", "receipts.read", (n) => `read ${plural(n, "expense receipt", "expense receipts")}`],
  ["arjun", "bank.match", (n) => `read the bank statement ${plural(n, "time", "times")}`],
  ["priya", "hr.answer", (n) => `answered ${plural(n, "HR question", "HR questions")}`],
];

/** The week in a sentence — "Ved researched and planned 12 leads · Tara drafted 8 follow-up emails" — or null for none. */
export function weekInWords(counts: Map<string, number>, teammates: Record<TeammateKey, Teammate>): string | null {
  const parts = DID.flatMap(([who, kind, say]) => {
    const n = counts.get(`${who}|${kind}`) ?? 0;
    return n > 0 ? [`${teammates[who].name} ${say(n)}`] : [];
  });
  return parts.length ? parts.join(" · ") : null;
}

export type WeeklyRun = { told: number; reason?: string };

/** The heartbeat's turn: on a Monday, once, everybody's week. */
export async function runTeamWeekly(now = new Date()): Promise<WeeklyRun> {
  try {
    const clock = await workspaceClock();
    if (clock.parts(now).weekday !== 1) return { told: 0, reason: "not Monday" };
    if (!(await copilotConfig()).enabled) return { told: 0, reason: "Deskzo AI is off" };
    try {
      await db.dailyJobRun.create({ data: { job: JOB, day: clock.calendarDate(now), ranAt: now } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return { told: 0, reason: "already sent" };
      throw err;
    }
    const rows = await db.aiTeammateWork.groupBy({
      by: ["userId", "teammate", "kind"],
      where: { status: "DONE", startedAt: { gte: new Date(now.getTime() - WEEK_MS), lt: now } },
      _count: { _all: true },
    });
    const byUser = new Map<string, Map<string, number>>();
    for (const r of rows) {
      if (!isTeammateKey(r.teammate)) continue;
      const mine = byUser.get(r.userId) ?? new Map<string, number>();
      mine.set(`${r.teammate}|${r.kind}`, r._count._all);
      byUser.set(r.userId, mine);
    }
    if (byUser.size === 0) return { told: 0 };
    const teammates = await workspaceTeammates();
    const active = new Set((await db.user.findMany({ where: { id: { in: [...byUser.keys()] }, active: true }, select: { id: true } })).map((u) => u.id));
    let told = 0;
    for (const [userId, counts] of byUser) {
      if (!active.has(userId)) continue;
      const words = weekInWords(counts, teammates);
      if (!words) continue;
      await notifyUser({ userId, type: "LEAD_ACTIVITY", title: "Your AI team last week", message: `${words}.`, link: "/ai-team" });
      told += 1;
    }
    return { told };
  } catch (err) {
    if (notMigratedYet(err)) return { told: 0, reason: "not ready" };
    throw err;
  }
}
