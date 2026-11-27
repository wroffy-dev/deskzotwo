import type { Prisma, PrismaClient } from "@prisma/client";
import { db as defaultDb } from "@/lib/db";
import { scoreLead, type LeadScore, type LeadSignals } from "@/lib/leads/score";
import { channelSettings } from "@/lib/inbox/settings";
import { isKeyPage } from "@/lib/inbox/activity-rules";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Lead scores, gathered from the database and kept on the lead.
 *
 * `scoreLead` is pure; this is where its inputs come from. The result is stored on `leads.score` so
 * the list can sort and filter by it — which means it has to be kept current:
 *
 *   · every action that changes a lead calls `refreshLeadScore` afterwards;
 *   · the lead page recomputes on view, so what it shows is never stale;
 *   · the periodic tick refreshes anything not scored in the last 12 hours (`refreshStaleLeadScores`),
 *     because part of the score is time itself — a lead nobody has touched gets colder by the day
 *     without anything about it changing.
 */

type Db = PrismaClient | Prisma.TransactionClient;
const DAY = 24 * 60 * 60 * 1000;

const signalSelect = {
  id: true,
  status: true,
  source: true,
  estimatedValue: true,
  expectedCloseDate: true,
  createdAt: true,
  contact: { select: { id: true, designation: true } },
  company: { select: { employeeCount: true, _count: { select: { products: true } } } },
  requirements: { select: { renewalDate: true } },
} satisfies Prisma.LeadSelect;

/**
 * The contacts' visits to the website: how many in 30 days, and the key page last opened in 14 (website activity,
 * owner, 6 Nov 2026). A person with two browsers has their visits added up. Behind a savepoint in a transaction, so a
 * workspace without the tables yet scores without them and never loses the change being made.
 */
async function websiteSignals(db: Db, contactIds: string[], now: Date): Promise<Map<string, { visits: number; keyPage: string | null }>> {
  const out = new Map<string, { visits: number; keyPage: string | null }>();
  if (!contactIds.length) return out;
  // Asked by reading it: `db` is a wrapper that picks the workspace, and `in` can't see through it.
  const inTransaction = typeof (db as { $transaction?: unknown }).$transaction !== "function";
  if (inTransaction) await db.$executeRawUnsafe(`SAVEPOINT "score_website"`);
  try {
    const views = await db.webPageView.findMany({
      where: { at: { gte: new Date(now.getTime() - 30 * DAY) }, visitor: { OR: [{ contactId: { in: contactIds } }, { conversation: { contactId: { in: contactIds } } }] } },
      orderBy: { at: "desc" },
      take: 2000,
      select: { path: true, at: true, visitNo: true, visitorId: true, visitor: { select: { contactId: true, channelId: true, conversation: { select: { contactId: true } } } } },
    });
    if (!views.length) return out;
    const channels = await db.inboxChannel.findMany({ where: { id: { in: [...new Set(views.map((v) => v.visitor.channelId))] } }, select: { id: true, settings: true } });
    const keyPages = new Map(channels.map((c) => [c.id, channelSettings(c.settings, "WEB").activity.keyPages]));
    const visits = new Map<string, Set<string>>();
    const fortnight = now.getTime() - 14 * DAY;
    for (const view of views) {
      const contactId = view.visitor.contactId ?? view.visitor.conversation?.contactId;
      if (!contactId) continue;
      visits.set(contactId, (visits.get(contactId) ?? new Set<string>()).add(`${view.visitorId}:${view.visitNo}`));
      const known = out.get(contactId) ?? { visits: 0, keyPage: null };
      // Newest first, so the first one found is the latest.
      if (!known.keyPage && view.at.getTime() >= fortnight && isKeyPage(view.path, keyPages.get(view.visitor.channelId) ?? [])) known.keyPage = view.path;
      out.set(contactId, known);
    }
    for (const [contactId, seen] of visits) out.get(contactId)!.visits = seen.size;
    if (inTransaction) await db.$executeRawUnsafe(`RELEASE SAVEPOINT "score_website"`);
    return out;
  } catch (err) {
    if (inTransaction) await db.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT "score_website"`);
    if (!notMigratedYet(err)) console.error("[score] website activity left out", err instanceof Error ? err.message : "");
    return new Map();
  }
}

async function signalsFor(db: Db, leadIds: string[], now: Date): Promise<Map<string, LeadSignals>> {
  if (leadIds.length === 0) return new Map();
  const since = new Date(now.getTime() - 14 * DAY);

  const [leads, recentActivities, recentCalls, meetings, lastActivity, lastCall] = await Promise.all([
    db.lead.findMany({ where: { id: { in: leadIds } }, select: signalSelect }),
    db.activity.groupBy({ by: ["leadId"], where: { leadId: { in: leadIds }, occurredAt: { gte: since }, type: { not: "STAGE_CHANGE" } }, _count: true }),
    db.callLog.groupBy({ by: ["leadId"], where: { leadId: { in: leadIds }, startedAt: { gte: since } }, _count: true }),
    db.activity.groupBy({ by: ["leadId"], where: { leadId: { in: leadIds }, type: "MEETING" }, _count: true }),
    db.activity.groupBy({ by: ["leadId"], where: { leadId: { in: leadIds }, type: { not: "STAGE_CHANGE" } }, _max: { occurredAt: true } }),
    db.callLog.groupBy({ by: ["leadId"], where: { leadId: { in: leadIds } }, _max: { startedAt: true } }),
  ]);

  // The contacts' opens and clicks on our marketing email in the last 30 days (owner, 1 Nov 2026).
  const contactIds = [...new Set(leads.map((l) => l.contact?.id).filter((id): id is string => !!id))];
  const events = contactIds.length
    ? await db.messageEvent.findMany({
        where: { type: { in: ["OPEN", "CLICK"] }, occurredAt: { gte: new Date(now.getTime() - 30 * DAY) }, message: { contactId: { in: contactIds }, messageClass: "MARKETING" } },
        select: { type: true, messageId: true, message: { select: { contactId: true } } },
      })
    : [];
  const opens = new Map<string, Set<string>>();
  const clicks = new Map<string, number>();
  for (const e of events) {
    const id = e.message.contactId;
    if (!id) continue;
    if (e.type === "CLICK") clicks.set(id, (clicks.get(id) ?? 0) + 1);
    else opens.set(id, (opens.get(id) ?? new Set<string>()).add(e.messageId));
  }

  const website = await websiteSignals(db, contactIds, now);

  const count = (rows: { leadId: string | null; _count: number }[], id: string) => rows.find((r) => r.leadId === id)?._count ?? 0;
  const latest = (a: Date | null | undefined, b: Date | null | undefined) => (a && b ? (a > b ? a : b) : (a ?? b ?? null));

  const out = new Map<string, LeadSignals>();
  for (const lead of leads) {
    const renewals = lead.requirements.map((r) => r.renewalDate).filter((d): d is Date => d !== null && d.getTime() >= now.getTime() - DAY);
    out.set(lead.id, {
      status: lead.status,
      source: lead.source,
      estimatedValue: lead.estimatedValue === null ? null : Number(lead.estimatedValue),
      expectedCloseDate: lead.expectedCloseDate,
      createdAt: lead.createdAt,
      employeeCount: lead.company.employeeCount,
      isExistingCustomer: lead.company._count.products > 0,
      contactDesignation: lead.contact?.designation ?? null,
      requirementCount: lead.requirements.length,
      nearestRenewal: renewals.length ? new Date(Math.min(...renewals.map((d) => d.getTime()))) : null,
      touchesLast14Days: count(recentActivities, lead.id) + count(recentCalls, lead.id),
      meetingsHeld: count(meetings, lead.id),
      lastTouchAt: latest(
        lastActivity.find((r) => r.leadId === lead.id)?._max.occurredAt,
        lastCall.find((r) => r.leadId === lead.id)?._max.startedAt,
      ),
      emailOpens30: lead.contact ? (opens.get(lead.contact.id)?.size ?? 0) : 0,
      emailClicks30: lead.contact ? (clicks.get(lead.contact.id) ?? 0) : 0,
      siteVisits30: lead.contact ? (website.get(lead.contact.id)?.visits ?? 0) : 0,
      keyPage14: lead.contact ? (website.get(lead.contact.id)?.keyPage ?? null) : null,
      now,
    });
  }
  return out;
}

/** Recompute one lead's score, store it, and return the full breakdown for display. */
export async function refreshLeadScore(leadId: string, db: Db = defaultDb, now = new Date()): Promise<LeadScore | null> {
  const signals = (await signalsFor(db, [leadId], now)).get(leadId);
  if (!signals) return null;
  const result = scoreLead(signals);
  await db.lead.update({ where: { id: leadId }, data: { score: result.score, scoreUpdatedAt: now } });
  return result;
}

/**
 * The same, when nobody has worked the lead: it was opened, or the customer clicked an email. The list's Updated keeps
 * its date (owner, 5 Nov 2026 — "why all leads showing 5th Nov?"): `updatedAt` moves on any write unless it is given.
 */
export async function refreshLeadScoreQuietly(leadId: string, db: Db = defaultDb, now = new Date()): Promise<LeadScore | null> {
  const [signals, lead] = await Promise.all([signalsFor(db, [leadId], now), db.lead.findUnique({ where: { id: leadId }, select: { updatedAt: true } })]);
  const found = signals.get(leadId);
  if (!found || !lead) return null;
  const result = scoreLead(found);
  await db.lead.update({ where: { id: leadId }, data: { score: result.score, scoreUpdatedAt: now, updatedAt: lead.updatedAt } });
  return result;
}

/**
 * Leads whose score is older than `olderThanMs` — or has never been computed — rescored in a batch.
 *
 * Closed leads are skipped once scored: their score is null for good and will not decay.
 */
export async function refreshStaleLeadScores(
  options: { limit?: number; olderThanMs?: number; now?: Date } = {},
  db: Db = defaultDb,
): Promise<number> {
  const now = options.now ?? new Date();
  const cutoff = new Date(now.getTime() - (options.olderThanMs ?? 12 * 60 * 60 * 1000));
  const stale = await db.lead.findMany({
    where: {
      OR: [
        { scoreUpdatedAt: null },
        { scoreUpdatedAt: { lt: cutoff }, status: { notIn: ["WON", "LOST", "DISQUALIFIED"] } },
      ],
    },
    select: { id: true, updatedAt: true },
    orderBy: { scoreUpdatedAt: { sort: "asc", nulls: "first" } },
    take: options.limit ?? 500,
  });
  if (stale.length === 0) return 0;

  const signals = await signalsFor(db, stale.map((l) => l.id), now);
  // A sweep is nobody's work: each lead's Updated stays as it was (`refreshLeadScoreQuietly`).
  const updatedAt = new Map(stale.map((l) => [l.id, l.updatedAt]));
  for (const [id, s] of signals) {
    await db.lead.update({ where: { id }, data: { score: scoreLead(s).score, scoreUpdatedAt: now, updatedAt: updatedAt.get(id) } });
  }
  return signals.size;
}
