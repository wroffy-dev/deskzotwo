import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { notMigratedYet } from "@/lib/not-migrated";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { copilotConfig } from "@/lib/copilot/settings";
import { workspaceClock } from "@/lib/time/workspace";
import { notifyUser } from "@/lib/notify";
import { noteFrom } from "@/lib/ai/teammates";
import { teammate } from "@/lib/ai/teammates-server";
import { RECEIVABLE_DOC_TYPE } from "@/lib/trade-documents";
import { collectionInsights } from "@/lib/collect/insights";
import { collectionsScopeIds, invoiceScope, loadDues, mayLogFollowUps } from "@/lib/collections/load";
import { shortMoney } from "@/lib/collections/chase";
import { shortDay } from "@/lib/collections/rules";
import { ChaseRefusal, chaseListFor, draftChase, recentlyChased } from "@/lib/collections/chase-server";

/**
 * Arjun working by himself (owner, 19 Nov 2026 — phase 3, "build phase 3"; phases 1 and 2 are ./chase-server.ts).
 * Off until an admin switches it on in Settings › Deskzo AI.
 *
 *   · **Morning drafts.** Each working morning (not Sundays), once the workspace's day is past nine, he makes the day's
 *     list: for every account manager who follows payments up, the customers on their own accounts that are hard cases —
 *     late at least `minDaysLate` days, or a promise broken (`brokenAlways`), owing at least `minAmount` — and not
 *     emailed in the last five days, paused, or already waiting on a draft. The most pressing `perDay` across the
 *     workspace are queued, and a few are drafted each heartbeat, into the account manager's Drafts to check, as the
 *     button would draft them. Each customer at most once a day. Charged to the account manager where they may use
 *     Deskzo AI, else to whoever switched Arjun on; with neither, passed over, saying why. When Deskzo AI says no (credits
 *     out, paused) the rest of the day's list is let go. Each person is told once their morning's drafts are done.
 *     **Nothing goes to a customer by itself** — every draft waits for a person to send it.
 *   · **The Monday note.** On Mondays, to each person chosen (who follows payments up): last week's payments in, promises
 *     made, kept and broken, chase emails and replies, what's overdue now and how fast customers pay, and who to chase
 *     first — each in their own collections, from the books. No AI, no credits. In the bell, and by email.
 */

const DAY = 86_400_000;
export const ARJUN_PER_DAY_MAX = 200;
const FROM_HOUR = 9;
/** Customers drafted in one heartbeat, at most — each is a model turn of a few seconds. */
const PER_TICK = 3;
const STALE_RUN_MS = 30 * 60_000;
const KEEP_RUNS_DAYS = 30;
const MORNING_JOB = "arjun-morning";
const WEEKLY_JOB = "arjun-weekly";

const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

// ─── Settings ─────────────────────────────────────────────────────────────────────────────────────────────────────

export type ArjunConfig = {
  enabled: boolean;
  perDay: number;
  minDaysLate: number;
  minAmount: number;
  brokenAlways: boolean;
  weeklyTo: string[];
  onSince: Date | null;
  enabledById: string | null;
  migrated: boolean;
};

const DEFAULTS: Omit<ArjunConfig, "migrated"> = { enabled: false, perDay: 20, minDaysLate: 15, minAmount: 0, brokenAlways: true, weeklyTo: [], onSince: null, enabledById: null };

export async function arjunConfig(): Promise<ArjunConfig> {
  try {
    const row = await db.collectionAgentSettings.findUnique({ where: { id: "global" } });
    if (!row) return { ...DEFAULTS, migrated: true };
    return {
      enabled: row.enabled,
      perDay: row.perDay,
      minDaysLate: row.minDaysLate,
      minAmount: Number(row.minAmount),
      brokenAlways: row.brokenAlways,
      weeklyTo: row.weeklyTo,
      onSince: row.onSince,
      enabledById: row.enabledById,
      migrated: true,
    };
  } catch (err) {
    if (notMigratedYet(err)) return { ...DEFAULTS, migrated: false };
    throw err;
  }
}

export type ArjunConfigInput = Pick<ArjunConfig, "enabled" | "perDay" | "minDaysLate" | "minAmount" | "brokenAlways" | "weeklyTo">;

/** Switched on (from off), it counts from now and is charged, by default, to whoever switched it on. */
export async function saveArjunConfig(input: ArjunConfigInput, userId: string): Promise<void> {
  const before = await arjunConfig();
  const turningOn = input.enabled && !before.enabled;
  const data = {
    enabled: input.enabled,
    perDay: input.perDay,
    minDaysLate: input.minDaysLate,
    minAmount: new Prisma.Decimal(input.minAmount),
    brokenAlways: input.brokenAlways,
    weeklyTo: input.weeklyTo,
    updatedById: userId,
  };
  await db.collectionAgentSettings.upsert({
    where: { id: "global" },
    create: { id: "global", ...data, onSince: input.enabled ? new Date() : null, enabledById: input.enabled ? userId : null },
    update: { ...data, ...(turningOn ? { onSince: new Date(), enabledById: userId } : {}) },
    select: { id: true },
  });
}

// ─── Morning drafts ───────────────────────────────────────────────────────────────────────────────────────────────

/** Once a day per job: the first heartbeat to claim the day runs it. */
async function claimDay(job: string, day: Date, now: Date): Promise<boolean> {
  try {
    await db.dailyJobRun.create({ data: { job, day, ranAt: now } });
    return true;
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") return false;
    throw err;
  }
}

/** Who a draft is charged to: the account manager if they may use Deskzo AI, else whoever switched Arjun on, else nobody. */
async function payerFor(forUserId: string, switchedOnBy: string | null): Promise<string | null> {
  for (const id of [forUserId, switchedOnBy]) {
    if (!id) continue;
    const user = await db.user.findUnique({ where: { id }, select: { active: true, kind: true } });
    if (user?.active && user.kind === "MEMBER" && (await can(id, "copilot.use"))) return id;
  }
  return null;
}

/** May this person have drafts waiting for them: an active member who follows payments up. */
async function followsUp(userId: string): Promise<boolean> {
  const user = await db.user.findUnique({ where: { id: userId }, select: { active: true, kind: true } });
  return !!user?.active && user.kind === "MEMBER" && (await mayLogFollowUps(userId));
}

/** The day's list: the hard cases on each account manager's own accounts, the most pressing `perDay` of them. */
export async function queueMorning(config: Pick<ArjunConfig, "perDay" | "minDaysLate" | "minAmount" | "brokenAlways">, day: Date, now: Date): Promise<number> {
  const late = await db.tradeDocument.findMany({
    where: { docType: RECEIVABLE_DOC_TYPE, status: { notIn: ["DRAFT", "CANCELLED", "PAID"] }, dueDate: { lt: day }, company: { ownerUserId: { not: null } } },
    distinct: ["companyId"],
    select: { companyId: true, company: { select: { ownerUserId: true } } },
  });
  const ownerOf = new Map(late.map((d) => [d.companyId, d.company.ownerUserId!]));
  const waiting = new Set((await db.collectionChase.findMany({ where: { status: "WAITING" }, select: { companyId: true }, distinct: ["companyId"] })).map((c) => c.companyId));
  const candidates: { companyId: string; forUserId: string; score: number }[] = [];
  for (const ownerId of new Set(ownerOf.values())) {
    if (!(await followsUp(ownerId))) continue;
    // Wide enough that a manager's own customers aren't crowded out by their team's, which are their reports' to draft.
    const list = await chaseListFor(ownerId, now, 100);
    for (const item of list.items) {
      if (ownerOf.get(item.companyId) !== ownerId || waiting.has(item.companyId)) continue;
      if (!item.mayEmail || item.emailedLately) continue;
      const hard = item.oldestDaysLate >= config.minDaysLate || (config.brokenAlways && item.broken);
      if (!hard || item.chaseInr < config.minAmount) continue;
      candidates.push({ companyId: item.companyId, forUserId: ownerId, score: item.score });
    }
  }
  const chosen = candidates.sort((a, b) => b.score - a.score).slice(0, config.perDay);
  if (!chosen.length) return 0;
  const made = await db.collectionAutoRun.createMany({ data: chosen.map((c) => ({ ...c, day })), skipDuplicates: true });
  return made.count;
}

export type MorningRun = { queued: number; drafted: number; skipped: number; failed: number; reason?: string };

/** The heartbeat's turn: the day's list made once, then a few of it drafted. */
export async function runArjunMorning(now = new Date()): Promise<MorningRun> {
  const out: MorningRun = { queued: 0, drafted: 0, skipped: 0, failed: 0 };
  const config = await arjunConfig();
  if (!config.enabled) return { ...out, reason: "off" };
  if (!(await moduleAvailableForTenant("receivables"))) return { ...out, reason: "receivables are off" };
  if (!(await copilotConfig()).enabled) return { ...out, reason: "Deskzo AI is off" };
  const clock = await workspaceClock();
  const parts = clock.parts(now);
  if (parts.weekday === 0) return { ...out, reason: "Sunday" };
  if (parts.hour < FROM_HOUR) return { ...out, reason: "before nine" };
  const day = clock.calendarDate(now);

  try {
    if (await claimDay(MORNING_JOB, day, now)) {
      await db.collectionAutoRun.deleteMany({ where: { day: { lt: new Date(day.getTime() - KEEP_RUNS_DAYS * DAY) } } });
      out.queued = await queueMorning(config, day, now);
    }
    // A run a restart cut off is closed, not counted as going on for ever.
    await db.collectionAutoRun.updateMany({ where: { status: "RUNNING", updatedAt: { lt: new Date(now.getTime() - STALE_RUN_MS) } }, data: { status: "FAILED", reason: "Stopped part way — the server restarted." } });

    const rows = await db.collectionAutoRun.findMany({ where: { day, status: "QUEUED" }, orderBy: { score: "desc" }, take: PER_TICK });
    const touched = new Set<string>();
    for (const row of rows) {
      // Claimed first: two heartbeats at once draft a customer once.
      const claimed = await db.collectionAutoRun.updateMany({ where: { id: row.id, status: "QUEUED" }, data: { status: "RUNNING" } });
      if (claimed.count !== 1) continue;
      touched.add(row.forUserId);
      const settle = (status: "DRAFTED" | "SKIPPED" | "FAILED", extra: { reason?: string; chaseId?: string; chargedTo?: string } = {}) =>
        db.collectionAutoRun.update({ where: { id: row.id }, data: { status, reason: extra.reason?.slice(0, 300) ?? null, chaseId: extra.chaseId ?? null, chargedTo: extra.chargedTo ?? null } });
      // Still worth it, an hour or two after the list was made?
      if (await db.paymentReminderPause.count({ where: { companyId: row.companyId } })) {
        await settle("SKIPPED", { reason: "Their reminders were paused." });
        out.skipped += 1;
        continue;
      }
      if (await db.collectionChase.count({ where: { companyId: row.companyId, status: "WAITING" } })) {
        await settle("SKIPPED", { reason: "A draft for them is already waiting." });
        out.skipped += 1;
        continue;
      }
      if ((await recentlyChased([row.companyId], now)).has(row.companyId)) {
        await settle("SKIPPED", { reason: "They were emailed in the last few days." });
        out.skipped += 1;
        continue;
      }
      const payer = await payerFor(row.forUserId, config.enabledById);
      if (!payer) {
        await settle("SKIPPED", { reason: "Neither their account manager nor whoever switched Arjun on may use Deskzo AI." });
        out.skipped += 1;
        continue;
      }
      try {
        const chaseId = await draftChase(row.forUserId, row.companyId, null, now, { chargeTo: payer });
        await settle("DRAFTED", { chaseId, chargedTo: payer });
        out.drafted += 1;
      } catch (err) {
        const why = err instanceof Error ? err.message : String(err);
        if (err instanceof ChaseRefusal && !err.fromAi) {
          // Paid since, nothing left on an invoice, out of their collections: nothing to draft — not a failure.
          await settle("SKIPPED", { reason: why, chargedTo: payer });
          out.skipped += 1;
          continue;
        }
        await settle("FAILED", { reason: why, chargedTo: payer });
        out.failed += 1;
        if (err instanceof ChaseRefusal) {
          // Deskzo AI said no — credits out, paused: the rest of today's list would only be told the same.
          const rest = await db.collectionAutoRun.updateMany({ where: { day, status: "QUEUED" }, data: { status: "SKIPPED", reason: why.slice(0, 300) } });
          out.skipped += rest.count;
          break;
        }
        console.error("[arjun] a morning draft failed", why);
      }
    }

    // Each person told once, when their morning's drafts are all done.
    if (touched.size) {
      const name = (await teammate("arjun")).name;
      for (const userId of touched) {
        const left = await db.collectionAutoRun.count({ where: { day, forUserId: userId, status: { in: ["QUEUED", "RUNNING"] } } });
        if (left) continue;
        const drafted = await db.collectionAutoRun.count({ where: { day, forUserId: userId, status: "DRAFTED" } });
        if (!drafted) continue;
        await notifyUser({
          userId,
          type: "PAYMENT_FOLLOW_UP_DUE",
          title: noteFrom(name, `I've drafted ${plural(drafted, "chase email", "chase emails")} for you this morning — have a look?`),
          message: "Nothing goes until you send it.",
          link: "/collections",
        }).catch(() => {});
      }
    }
    return out;
  } catch (err) {
    if (notMigratedYet(err)) return { ...out, reason: "not ready" };
    throw err;
  }
}

/** Drafts made by himself since the workspace's midnight. */
export async function draftedToday(now = new Date()): Promise<number> {
  const day = (await workspaceClock()).calendarDate(now);
  return db.collectionAutoRun.count({ where: { day, status: "DRAFTED" } }).catch(() => 0);
}

// ─── The Monday note ──────────────────────────────────────────────────────────────────────────────────────────────

export type WeekNote = {
  from: string;
  to: string;
  received: number;
  payments: number;
  promisesMade: number;
  promisesKept: number;
  promisesBroken: number;
  chasesSent: number;
  replies: number;
  overdue: number;
  overdueDues: number;
  daysToPay: number | null;
  daysToPayBefore: number | null;
  first: { companyName: string; why: string }[];
  text: string;
};

/** Last week in this person's collections, from the books: what came in, the promises, the chasing, and what's next. */
export async function weekNote(userId: string, now = new Date()): Promise<WeekNote> {
  const clock = await workspaceClock();
  const today = clock.calendarDate(now);
  const end = clock.startOfDay(clock.today(now)) ?? now;
  const start = new Date(end.getTime() - 7 * DAY);
  const ids = await collectionsScopeIds(userId);
  const companyWhere: Prisma.CompanyWhereInput = ids === null ? {} : { ownerUserId: { in: ids } };
  const window = { gte: start, lt: end };
  const [payments, made, kept, broken, sent, replies, dues, insights, list] = await Promise.all([
    db.payment.findMany({ where: { direction: "RECEIVED", paidOn: window, company: companyWhere }, select: { amount: true, exchangeRate: true } }),
    db.paymentFollowUp.count({ where: { createdAt: window, promisedOn: { not: null }, company: companyWhere } }),
    db.paymentFollowUp.count({ where: { promiseStatus: "KEPT", promiseResolvedAt: window, company: companyWhere } }),
    db.paymentFollowUp.count({ where: { promiseStatus: "BROKEN", promiseResolvedAt: window, company: companyWhere } }),
    db.collectionChase.count({ where: { status: "SENT", sentAt: window, company: companyWhere } }),
    db.collectionReply.count({ where: { createdAt: window, chase: { company: companyWhere } } }),
    loadDues(userId, { now }),
    collectionInsights(invoiceScope(ids), today),
    chaseListFor(userId, now, 5),
  ]);
  const received = Math.round(payments.reduce((t, p) => t + Number(p.amount) * Number(p.exchangeRate), 0) * 100) / 100;
  const late = dues.rows.filter((r) => r.daysOverdue > 0);
  const overdue = Math.round(late.reduce((t, r) => t + r.balanceInr, 0) * 100) / 100;
  const months = insights.dso.filter((m) => m.dso !== null);
  const before = months.length >= 2 ? months[months.length - 2]!.dso : null;
  const first = list.items.map((i) => ({ companyName: i.companyName, why: i.reasons[0] ?? "" }));

  // The week as calendar days: the Monday a week ago to yesterday.
  const from = shortDay(new Date(today.getTime() - 7 * DAY));
  const to = shortDay(new Date(today.getTime() - DAY));
  const lines = [
    `Last week (${from} – ${to}):`,
    `• Came in: ${payments.length ? `${shortMoney(received)} from ${plural(payments.length, "payment", "payments")}` : "nothing recorded"}.`,
    `• Promises to pay: ${made} made, ${kept} kept, ${broken} broken.`,
    `• Chase emails: ${sent} sent, ${plural(replies, "reply", "replies")}.`,
    `Now: ${shortMoney(overdue)} overdue on ${plural(late.length, "due", "dues")}.${insights.current !== null ? ` Customers take about ${insights.current} days to pay${before !== null ? ` (${before} the month before)` : ""}.` : ""}`,
  ];
  if (first.length) lines.push(`Chase first: ${first.map((f, i) => `${i + 1}. ${f.companyName} — ${f.why}`).join("; ")}.`);
  return {
    from,
    to,
    received,
    payments: payments.length,
    promisesMade: made,
    promisesKept: kept,
    promisesBroken: broken,
    chasesSent: sent,
    replies,
    overdue,
    overdueDues: late.length,
    daysToPay: insights.current,
    daysToPayBefore: before,
    first,
    text: lines.join("\n"),
  };
}

/** The heartbeat's turn: on a Monday past nine, once, the note to each person chosen. */
export async function runArjunWeekly(now = new Date()): Promise<{ told: number; reason?: string }> {
  try {
    const config = await arjunConfig();
    if (!config.enabled) return { told: 0, reason: "off" };
    if (!config.weeklyTo.length) return { told: 0, reason: "nobody chosen" };
    if (!(await moduleAvailableForTenant("receivables"))) return { told: 0, reason: "receivables are off" };
    const clock = await workspaceClock();
    const parts = clock.parts(now);
    if (parts.weekday !== 1) return { told: 0, reason: "not Monday" };
    if (parts.hour < FROM_HOUR) return { told: 0, reason: "before nine" };
    if (!(await claimDay(WEEKLY_JOB, clock.calendarDate(now), now))) return { told: 0, reason: "already sent" };
    const name = (await teammate("arjun")).name;
    let told = 0;
    for (const userId of config.weeklyTo) {
      if (!(await followsUp(userId))) continue;
      try {
        const note = await weekNote(userId, now);
        await notifyUser({ userId, type: "COLLECTIONS_WEEKLY", title: noteFrom(name, "your week in collections"), message: note.text.slice(0, 1800), link: "/collections" });
        told += 1;
      } catch (err) {
        console.error("[arjun] a Monday note failed", err instanceof Error ? err.message : err);
      }
    }
    return { told };
  } catch (err) {
    if (notMigratedYet(err)) return { told: 0, reason: "not ready" };
    throw err;
  }
}

// ─── For the settings card ────────────────────────────────────────────────────────────────────────────────────────

export type ArjunReport = { draftedToday: number; drafted: number; sent: number; setAside: number; waiting: number; skipped: number; noManager: number };

/** The last 30 days of his mornings, and customers owing with no account manager — whom he can't draft for. */
export async function arjunReport(now = new Date()): Promise<ArjunReport> {
  const since = new Date(now.getTime() - 30 * DAY);
  try {
    const [today, runs, noManager] = await Promise.all([
      draftedToday(now),
      db.collectionAutoRun.findMany({ where: { createdAt: { gte: since } }, select: { status: true, chaseId: true } }),
      db.tradeDocument.findMany({
        where: { docType: RECEIVABLE_DOC_TYPE, status: { notIn: ["DRAFT", "CANCELLED", "PAID"] }, dueDate: { lt: now }, company: { ownerUserId: null } },
        distinct: ["companyId"],
        select: { companyId: true },
      }),
    ]);
    const chaseIds = runs.flatMap((r) => (r.chaseId ? [r.chaseId] : []));
    const chases = chaseIds.length ? await db.collectionChase.findMany({ where: { id: { in: chaseIds } }, select: { status: true } }) : [];
    return {
      draftedToday: today,
      drafted: runs.filter((r) => r.status === "DRAFTED").length,
      sent: chases.filter((c) => c.status === "SENT").length,
      setAside: chases.filter((c) => c.status === "DISCARDED").length,
      waiting: chases.filter((c) => c.status === "WAITING").length,
      skipped: runs.filter((r) => r.status === "SKIPPED" || r.status === "FAILED").length,
      noManager: noManager.length,
    };
  } catch (err) {
    if (notMigratedYet(err)) return { draftedToday: 0, drafted: 0, sent: 0, setAside: 0, waiting: 0, skipped: 0, noManager: 0 };
    throw err;
  }
}
