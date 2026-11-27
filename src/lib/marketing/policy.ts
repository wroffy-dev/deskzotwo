import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import type { Clock } from "@/lib/time/zone";

/**
 * Workspace-wide marketing rules beyond the organisation's settings (owner, 1 Nov 2026 — the gaps against Klaviyo,
 * ActiveCampaign, Mailchimp): the sunset — stop marketing to people who keep being sent email and never open it, which
 * protects the domain's name with every mailbox provider — and each person's usual hour for opening, for a campaign
 * that sends each of them then.
 */

export const SUNSET_MIN_SENDS = 3;
export const SUNSET_CHOICES = [90, 180, 365] as const;

/** The sunset window in days, or null where there's no rule (or the table isn't there yet). */
export async function sunsetDays(): Promise<number | null> {
  try {
    return (await db.marketingPolicy.findUnique({ where: { id: "global" }, select: { sunsetDays: true } }))?.sunsetDays ?? null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/**
 * Whether marketing asks for an opt-in to the topic (owner, 2 Nov 2026: "lets remove optin conditions" — off unless a
 * workspace turns it on). False where there's no row, or the column isn't there yet.
 */
export async function requireOptIn(): Promise<boolean> {
  try {
    return (await db.marketingPolicy.findUnique({ where: { id: "global" }, select: { requireOptIn: true } }))?.requireOptIn ?? false;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

/**
 * Who has gone quiet under the sunset rule: sent at least three marketing emails in its window and opened (or clicked)
 * none. Null where there's no rule.
 */
export async function quietContacts(contactIds: string[]): Promise<{ days: number; ids: Set<string> } | null> {
  const days = await sunsetDays();
  if (!days || contactIds.length === 0) return null;
  const since = new Date(Date.now() - days * 86_400_000);
  const [sent, engaged] = await Promise.all([
    db.marketingMessage.groupBy({ by: ["contactId"], where: { contactId: { in: contactIds }, messageClass: "MARKETING", sentAt: { gte: since } }, _count: { _all: true } }),
    db.marketingMessage.findMany({
      where: { contactId: { in: contactIds }, messageClass: "MARKETING", events: { some: { type: { in: ["OPEN", "CLICK"] }, occurredAt: { gte: since } } } },
      select: { contactId: true },
      distinct: ["contactId"],
    }),
  ]);
  const opened = new Set(engaged.map((m) => m.contactId));
  return { days, ids: new Set(sent.filter((r) => r.contactId && r._count._all >= SUNSET_MIN_SENDS && !opened.has(r.contactId)).map((r) => r.contactId!)) };
}

/** The hour each person most often opens our email at, on the workspace's clock, over the last 180 days. */
export async function usualOpenHours(contactIds: string[], clock: Clock): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  if (contactIds.length === 0) return out;
  const events = await db.messageEvent.findMany({
    where: { type: { in: ["OPEN", "CLICK"] }, occurredAt: { gte: new Date(Date.now() - 180 * 86_400_000) }, message: { contactId: { in: contactIds } } },
    select: { occurredAt: true, message: { select: { contactId: true } } },
    take: 50_000,
  });
  const tally = new Map<string, number[]>();
  for (const e of events) {
    const id = e.message.contactId;
    if (!id) continue;
    const hours = tally.get(id) ?? new Array<number>(24).fill(0);
    hours[clock.parts(e.occurredAt).hour] += 1;
    tally.set(id, hours);
  }
  for (const [id, hours] of tally) out.set(id, hours.indexOf(Math.max(...hours)));
  return out;
}

/** The first moment at or after `from` that is `hour` o'clock on the workspace's clock. */
export function atHour(from: Date, hour: number, clock: Clock): Date {
  const p = clock.parts(from);
  const ahead = (hour - p.hour + 24) % 24;
  const start = new Date(from.getTime() - p.minute * 60_000 - from.getSeconds() * 1000 - from.getMilliseconds());
  const at = new Date(start.getTime() + ahead * 3_600_000);
  return at < from ? new Date(at.getTime() + 24 * 3_600_000) : at;
}
