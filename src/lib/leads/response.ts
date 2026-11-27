import type { Clock } from "@/lib/time/zone";
import type { OfficeHours } from "@/lib/hr/office-hours-rules";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/not-migrated";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { officeHours } from "@/lib/hr/office-hours";
import { workspaceClock } from "@/lib/time/workspace";
import { leadPath } from "@/lib/record-links";
import { automationUserId } from "@/lib/automation-user";
import { activeRules, decideOwner, ruleMatches, signalsForLead, whoCouldOpen } from "@/lib/leads/assign";
import { claimLeadCapacity, leadCapacityError, markLeadWrite } from "@/lib/leads/limits";

/**
 * Leads answered, and leads left (owner, 26 Oct 2026). On the heartbeat, for the last week's assignments
 * (`LeadAssignment`, kept by a trigger on `leads`):
 *
 *   · Answered: the person's first touch after the lead came to them — a call, an activity, any edit the
 *     audit log puts on the lead — is its `respondedAt`. That's what the PERFORMANCE share's answering time is.
 *   · Left: a lead an assignment rule with response hours gave somebody, untouched for that many office hours,
 *     moves on to the next person by the same rule, never back to anybody who's had it. They're told, and so
 *     is their manager. Nobody left in the rule: it stays, and their manager is told — once.
 *
 * Office hours are the company's (Settings › Attendance), Monday to Saturday, holidays off; with none set, the
 * hours are the clock's. A rule without response hours never moves anything.
 *
 * Moving a lead on (owner, 12 Nov 2026 — Phase 4 lead limits, audit H.6.5 and D.5): the next person is chosen inside the
 * transaction that moves it, so the rule's turn and their room are taken with the move or not at all — somebody at their
 * lead limit is passed over, and with nobody free it stays and is escalated as before. The move is made only while the
 * lead is still with the person the sweep read: its row is locked and its owner compared, so a reassignment made in
 * between stands and this lead is left for the next sweep.
 */

/** The lead changed hands after the sweep read it: nothing moved. */
class OwnerChanged extends Error {}

const LOOK_BACK_DAYS = 7;
const BATCH = 300;
const CLOSED = ["WON", "LOST", "DISQUALIFIED"] as const;

/**
 * Minutes of office time between two moments: the company's hours each working day, Sundays and holidays
 * off; every minute when no hours are set. Pure — the suite checks it.
 */
export function officeMinutesBetween(from: Date, to: Date, clock: Clock, hours: OfficeHours | null, holiday: (dayKey: string) => boolean): number {
  if (to <= from) return 0;
  if (!hours) return Math.floor((to.getTime() - from.getTime()) / 60_000);
  let total = 0;
  for (let day = clock.dateKey(from); ; ) {
    const start = clock.startOfDay(day)!;
    if (start > to) break;
    const p = clock.parts(start);
    if (p.weekday !== 0 && !holiday(day)) {
      const open = clock.at(p.year, p.month, p.day, Math.floor(hours.startMinute / 60), hours.startMinute % 60);
      const shut = clock.at(p.year, p.month, p.day, Math.floor(hours.endMinute / 60), hours.endMinute % 60);
      const a = Math.max(open.getTime(), from.getTime());
      const b = Math.min(shut.getTime(), to.getTime());
      if (b > a) total += Math.floor((b - a) / 60_000);
    }
    day = clock.dateKey(new Date(start.getTime() + 36 * 3_600_000));
  }
  return total;
}

/** The person's first touch on the lead since a moment — or null. */
async function firstTouch(leadId: string, userId: string, since: Date): Promise<Date | null> {
  const [activity, call, audit] = await Promise.all([
    db.activity.findFirst({ where: { leadId, userId, createdAt: { gte: since } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    db.callLog.findFirst({ where: { leadId, userId, createdAt: { gte: since } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
    db.auditLog.findFirst({ where: { leadId, userId, createdAt: { gte: since } }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);
  const times = [activity?.createdAt, call?.createdAt, audit?.createdAt].filter((d): d is Date => !!d);
  return times.length ? new Date(Math.min(...times.map((t) => t.getTime()))) : null;
}

export type ResponseSweep = { checked: number; answered: number; moved: number; escalated: number };

export async function leadResponseChores(now = new Date(), opts: { budgetMs?: number } = {}): Promise<ResponseSweep | null> {
  if (!(await moduleAvailableForTenant("leads"))) return null;
  const deadline = Date.now() + (opts.budgetMs ?? 30_000);
  const out: ResponseSweep = { checked: 0, answered: 0, moved: 0, escalated: 0 };
  let pending;
  try {
    pending = await db.leadAssignment.findMany({
      where: { respondedAt: null, endedAt: null, userId: { not: null }, assignedAt: { gte: new Date(now.getTime() - LOOK_BACK_DAYS * 86_400_000) }, lead: { status: { notIn: [...CLOSED] } } },
      orderBy: { assignedAt: "asc" },
      take: BATCH,
      select: { id: true, leadId: true, userId: true, assignedAt: true, escalatedAt: true },
    });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
  if (pending.length === 0) return out;

  const rules = (await activeRules()).filter((r) => !!r.responseHours && r.strategy !== "ACCOUNT_MANAGER");
  const [clock, hours] = await Promise.all([workspaceClock(), officeHours()]);
  const holidays = rules.length
    ? new Set((await db.holiday.findMany({ where: { optional: false, date: { gte: new Date(now.getTime() - 10 * 86_400_000) } }, select: { date: true } })).map((h) => h.date.toISOString().slice(0, 10)))
    : new Set<string>();

  for (const a of pending) {
    if (Date.now() > deadline) break;
    out.checked += 1;
    const touched = await firstTouch(a.leadId, a.userId!, a.assignedAt);
    if (touched) {
      await db.leadAssignment.update({ where: { id: a.id }, data: { respondedAt: touched } });
      out.answered += 1;
      continue;
    }
    if (rules.length === 0 || a.escalatedAt) continue;
    const signals = await signalsForLead(a.leadId);
    // The rule that answers for it: the first with response hours that matches the lead and has this person in it.
    const rule = signals ? rules.find((r) => r.userIds.includes(a.userId!) && ruleMatches(r, signals)) : undefined;
    if (!rule || !signals) continue;
    if (officeMinutesBetween(a.assignedAt, now, clock, hours, (d) => holidays.has(d)) < rule.responseHours! * 60) continue;

    const had = await db.leadAssignment.findMany({ where: { leadId: a.leadId, userId: { not: null } }, select: { userId: true } });
    const lead = await db.lead.findUnique({ where: { id: a.leadId }, select: { leadSeq: true, title: true, ownerUserId: true } });
    if (!lead || lead.ownerUserId !== a.userId) continue;
    const from = await db.user.findUnique({ where: { id: a.userId! }, select: { name: true, managerId: true } });
    const link = leadPath(lead.leadSeq);
    const hoursWords = `${rule.responseHours} office hour${rule.responseHours === 1 ? "" : "s"}`;
    // Read before the transaction, which reads nothing through the global client (src/lib/leads/limits.ts says why).
    const mayOpen = await whoCouldOpen(signals, { rules: [rule] });

    let next: { userId: string } | null;
    try {
      next = await db.$transaction(
        async (tx) => {
          await markLeadWrite(tx, "responseSweep");
          const decided = await decideOwner(signals, { db: tx, onlyRuleId: rule.id, exclude: [...new Set(had.map((h) => h.userId!))], now, mayOpen });
          if (decided.kind !== "chosen") return null;
          await claimLeadCapacity(tx, [decided.userId], { creating: false });
          // D.5: still the owner the sweep read? Locked first, so a reassignment in flight finishes and is seen.
          const [current] = await tx.$queryRaw<{ ownerUserId: string | null }[]>`SELECT "ownerUserId" FROM "leads" WHERE "id" = ${a.leadId} FOR UPDATE`;
          if (current?.ownerUserId !== a.userId) throw new OwnerChanged();
          // Marked first: the owner change ends this row (the trigger), and this says why it ended.
          await tx.leadAssignment.update({ where: { id: a.id }, data: { timedOutAt: now } });
          const moved = await tx.lead.updateMany({
            where: { id: a.leadId, ownerUserId: a.userId },
            data: { ownerUserId: decided.userId, assignmentNote: `Moved from ${from?.name ?? "the last owner"}: no response in ${hoursWords} — rule “${rule.name}”`.slice(0, 300) },
          });
          if (moved.count === 0) throw new OwnerChanged();
          return { userId: decided.userId };
        },
        { maxWait: 10_000, timeout: 20_000 },
      );
    } catch (err) {
      // Moved by somebody else meanwhile, or the person chosen filled up at that moment: left for the next sweep.
      if (err instanceof OwnerChanged || leadCapacityError(err)) continue;
      throw err;
    }

    if (next) {
      const to = await db.user.findUnique({ where: { id: next.userId }, select: { name: true } });
      await recordAudit({ userId: await automationUserId(), action: "UPDATE", entityType: "Lead", entityId: a.leadId, entityLabel: `${lead.title} — owner: ${from?.name ?? "—"} → ${to?.name ?? "—"} (no response in ${hoursWords})` });
      await notifyUser({ userId: next.userId, type: "LEAD_ASSIGNED", title: "A lead was assigned to you", message: `${lead.title} — ${from?.name ?? "its owner"} didn't respond in ${hoursWords}.`, link });
      await notifyUser({ userId: a.userId!, type: "LEAD_ASSIGNED", title: "A lead moved on from you", message: `${lead.title} went to ${to?.name ?? "a colleague"} — nothing was done with it in ${hoursWords}.`, link });
      if (from?.managerId && from.managerId !== next.userId) {
        await notifyUser({ userId: from.managerId, type: "LEAD_ASSIGNED", title: `A lead moved from ${from.name}`, message: `${lead.title} went to ${to?.name ?? "a colleague"} — no response in ${hoursWords}.`, link });
      }
      out.moved += 1;
    } else {
      // Nobody left to give it to: it stays, and somebody who can act is told — once.
      await db.leadAssignment.update({ where: { id: a.id }, data: { escalatedAt: now } });
      const tell = from?.managerId ?? null;
      if (tell) await notifyUser({ userId: tell, type: "LEAD_ASSIGNED", title: `${from?.name ?? "Somebody"} hasn't touched a lead`, message: `${lead.title} — no response in ${hoursWords}, and nobody else in “${rule.name}” is free to take it.`, link });
      await notifyUser({ userId: a.userId!, type: "LEAD_ASSIGNED", title: "A lead is waiting on you", message: `${lead.title} — nothing done with it in ${hoursWords}.`, link });
      out.escalated += 1;
    }
  }
  return out;
}
