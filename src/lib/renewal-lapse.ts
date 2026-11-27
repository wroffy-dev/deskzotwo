import { db } from "@/lib/db";
import { lapsedWhere, UNMARKED_EXCEPT } from "@/lib/renewal-lapse-rules";
import { DEFAULT_WATCH, type RenewalWatch } from "@/lib/renewal-watch-rules";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/not-migrated";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { automationUserId } from "@/lib/automation-user";
import { workspaceClock } from "@/lib/time/workspace";
import { formatOrderId } from "@/lib/order-id";
import { companyPath } from "@/lib/record-links";
import { renewalManagersHere } from "@/lib/companies/renewal-manager";
import { teamReminderCopies, type TeamCopies } from "@/lib/renewal-team-copies";

/**
 * A subscription that ended and wasn't renewed (owner, 26 Oct 2026).
 *
 *   · The day after it ends, its account's owner is told it lapsed (the bell's renewal notices, src/lib/notify.ts).
 *   · Renewals › "Lapsed — not renewed" lists every one ended, not renewed and not marked Lost.
 *   · `lapseLostAfterDays` after its end with still nothing — no renewal order, nobody marking it — it is marked
 *     Lost, "Lapsed — not renewed", by the Automation account: its auto-renew is switched off with it, and the
 *     account's owner and their manager are told. Settings › Renewals sets the days; empty never does.
 *
 * A renewal somebody marked (Negotiating, On hold…) is somebody's call: it's left alone, only the unmarked are.
 */

export const DEFAULT_LAPSE_DAYS = 15;
export const LAPSED_NOTE = "Lapsed — not renewed";

/**
 * `watch`: who is reminded and told about renewals coming up (src/lib/renewal-watch-rules.ts), and whether this
 * workspace has those settings yet (`watchMigrated`, 20261130150000_renewal_watch) — the defaults until it does.
 */
/**
 * `nobodyRecipientIds`: who is reminded about a renewal nobody looks after (owner, 30 Oct 2026); empty, every admin.
 * `nobodyMigrated`: whether the workspace has the column yet (20261130170000_renewal_nobody_recipients).
 */
export type RenewalConfig = {
  migrated: boolean;
  lapseLostAfterDays: number | null;
  watch: RenewalWatch;
  watchMigrated: boolean;
  nobodyRecipientIds: string[];
  nobodyMigrated: boolean;
  /** Days before its end the customer is reminded by itself (owner, 30 Oct 2026); empty, never. */
  customerReminderDays: number[];
  customerMigrated: boolean;
  /** Who is copied on it (owner, 13 Nov 2026); none until 20261213110000_renewal_customer_cc. */
  customerCopies: CustomerCopies;
  /** Who is copied on the team's renewal reminder emails (owner, 23 Nov 2026); none until 20261223500000_renewal_team_cc. */
  teamCopies: TeamCopies;
};

/** Copied on the customer's reminder sent by itself: these addresses, and the renewal's manager when `manager`. */
export type CustomerCopies = { emails: string[]; manager: boolean; migrated: boolean };
const NO_COPIES: CustomerCopies = { emails: [], manager: false, migrated: false };
const NO_TEAM_COPIES: TeamCopies = { emails: [], migrated: false };

/** Who is copied on the customer's reminder sent by itself; nobody before the columns are there. */
export async function customerReminderCopies(): Promise<CustomerCopies> {
  try {
    const row = await db.renewalSettings.findUnique({ where: { id: "default" }, select: { customerReminderCc: true, customerReminderCcManager: true } });
    return { emails: row?.customerReminderCc ?? [], manager: row?.customerReminderCcManager === true, migrated: true };
  } catch (err) {
    if (notMigratedYet(err)) return NO_COPIES;
    throw err;
  }
}

/** The days the customer is reminded by itself; none before 20261130180000_renewal_customer_reminders. */
export async function customerReminderDays(): Promise<{ days: number[]; migrated: boolean }> {
  try {
    const row = await db.renewalSettings.findUnique({ where: { id: "default" }, select: { customerReminderDays: true } });
    return { days: row?.customerReminderDays ?? [], migrated: true };
  } catch (err) {
    if (notMigratedYet(err)) return { days: [], migrated: false };
    throw err;
  }
}

/** Who is reminded about a renewal nobody looks after; empty (every admin) before the column is there. */
export async function nobodyRecipients(): Promise<{ ids: string[]; migrated: boolean }> {
  try {
    const row = await db.renewalSettings.findUnique({ where: { id: "default" }, select: { nobodyRecipientIds: true } });
    return { ids: row?.nobodyRecipientIds ?? [], migrated: true };
  } catch (err) {
    if (notMigratedYet(err)) return { ids: [], migrated: false };
    throw err;
  }
}

export async function renewalConfig(): Promise<RenewalConfig> {
  let row: { lapseLostAfterDays: number | null } | null;
  try {
    row = await db.renewalSettings.findUnique({ where: { id: "default" }, select: { lapseLostAfterDays: true } });
  } catch (err) {
    if (notMigratedYet(err)) return { migrated: false, lapseLostAfterDays: null, watch: DEFAULT_WATCH, watchMigrated: false, nobodyRecipientIds: [], nobodyMigrated: false, customerReminderDays: [], customerMigrated: false, customerCopies: NO_COPIES, teamCopies: NO_TEAM_COPIES };
    throw err;
  }
  const lapseLostAfterDays = row ? row.lapseLostAfterDays : DEFAULT_LAPSE_DAYS;
  try {
    const watch = await db.renewalSettings.findUnique({
      where: { id: "default" },
      select: { reminderDays: true, escalateManagerDays: true, escalateAdminDays: true, taskLeadDays: true, weeklyList: true },
    });
    const [nobody, customer, customerCopies, teamCopies] = await Promise.all([nobodyRecipients(), customerReminderDays(), customerReminderCopies(), teamReminderCopies()]);
    return { migrated: true, lapseLostAfterDays, watch: watch ?? DEFAULT_WATCH, watchMigrated: true, nobodyRecipientIds: nobody.ids, nobodyMigrated: nobody.migrated, customerReminderDays: customer.days, customerMigrated: customer.migrated, customerCopies, teamCopies };
  } catch (err) {
    if (notMigratedYet(err)) return { migrated: true, lapseLostAfterDays, watch: DEFAULT_WATCH, watchMigrated: false, nobodyRecipientIds: [], nobodyMigrated: false, customerReminderDays: [], customerMigrated: false, customerCopies: NO_COPIES, teamCopies: NO_TEAM_COPIES };
    throw err;
  }
}

export type LapseRun = { marked: number; reason?: string };

/**
 * Who hears that a customer's subscription lapsed (owner, 11 Nov 2026): whoever its renewals land with — its renewal
 * manager while they're still here, else its account manager — and that person's manager. It was the account manager
 * and theirs, so a renewal manager chased it to the last day and then never heard it had been called lost.
 */
async function lapseAudience(companyIds: string[]): Promise<Map<string, string[]>> {
  const out = new Map<string, string[]>();
  if (companyIds.length === 0) return out;
  const ids = [...new Set(companyIds)];
  const person = { select: { id: true, active: true, managerId: true } } as const;
  const [owners, managers] = await Promise.all([
    db.company.findMany({ where: { id: { in: ids } }, select: { id: true, owner: person } }),
    (await renewalManagersHere()) ? db.company.findMany({ where: { id: { in: ids }, renewalManagerId: { not: null } }, select: { id: true, renewalManager: person } }) : [],
  ]);
  const renewalManagerOf = new Map(managers.map((m) => [m.id, m.renewalManager]));
  for (const c of owners) {
    const manager = renewalManagerOf.get(c.id);
    const theirs = manager?.active ? manager : c.owner;
    out.set(c.id, [theirs?.id, theirs?.managerId].filter((id): id is string => !!id));
  }
  return out;
}

/** How far before the cut-off a lapse is still announced: the rule's own window, not the whole past. */
const RECENT_DAYS = 30;

export async function runRenewalLapses(now = new Date()): Promise<LapseRun> {
  if (!(await moduleAvailableForTenant("renewals"))) return { marked: 0, reason: "renewals are off" };
  const config = await renewalConfig();
  if (!config.migrated || !config.lapseLostAfterDays) return { marked: 0, reason: "off" };
  const today = (await workspaceClock()).calendarDate(now);
  const cutoff = new Date(today.getTime() - config.lapseLostAfterDays * 86_400_000);
  // Only what ended lately: a subscription that ended long before this rule could act on it is history, not a lapse to
  // announce — thousands of them, from an import, would each tell an owner and a manager (owner, 31 Oct 2026). Renewals ›
  // Clean up old settles those, quietly (src/lib/renewal-tidy.ts).
  const since = new Date(cutoff.getTime() - RECENT_DAYS * 86_400_000);
  const lapsed = await db.companyProduct.findMany({
    where: { AND: [lapsedWhere(cutoff), { endDate: { gte: since } }] },
    orderBy: { endDate: "asc" },
    take: 200,
    select: { id: true, orderSeq: true, endDate: true, item: { select: { name: true } }, company: { select: { id: true, name: true, companySeq: true } } },
  });
  if (lapsed.length === 0) return { marked: 0 };
  const audience = await lapseAudience(lapsed.map((o) => o.company.id));
  const automation = await automationUserId();
  let marked = 0;
  for (const order of lapsed) {
    // Marked only if still unmarked — a person marking it at the same moment wins.
    const took = await db.companyProduct.updateMany({
      where: { id: order.id, OR: [{ renewalStage: null }, { renewalStage: { notIn: UNMARKED_EXCEPT } }] },
      data: { renewalStage: "LOST", renewalStageNote: LAPSED_NOTE, renewalStageAt: now, renewalStageById: automation },
    });
    if (took.count === 0) continue;
    const stopped = (await db.recurringBilling.deleteMany({ where: { companyProductId: order.id, mode: "AUTO_RENEW" } })).count > 0;
    marked += 1;
    const label = `${formatOrderId(order.orderSeq)} (${order.item.name} — ${order.company.name})`;
    await recordAudit({
      userId: automation,
      action: "UPDATE",
      entityType: "CompanyProduct",
      entityId: order.id,
      entityLabel: `Renewal of ${label} marked Lost — ${LAPSED_NOTE}, ${config.lapseLostAfterDays} days after it ended${stopped ? "; auto-renew switched off" : ""}`,
    });
    const message = `${order.company.name} — ${order.item.name}: ended ${config.lapseLostAfterDays}+ days ago and nobody renewed it, so it's marked Lost. Win it back, or mark it yourself with the real reason.`;
    const link = `${companyPath(order.company.companySeq)}?tab=renewals`;
    for (const userId of new Set(audience.get(order.company.id) ?? [])) await notifyUser({ userId, type: "RENEWAL_EXPIRING", title: "A subscription lapsed", message, link });
  }
  return { marked };
}
