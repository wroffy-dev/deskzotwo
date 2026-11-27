import { db } from "@/lib/db";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { workspaceClock } from "@/lib/time/workspace";
import { tenantOrigin } from "@/lib/tenancy/resolve";
import { customerReminderCopies, customerReminderDays } from "@/lib/renewal-lapse";
import { renewalManagersOf } from "@/lib/companies/renewal-manager";
import { ladderStep, upForRenewalWhere } from "@/lib/renewal-watch-rules";
import { queueCustomerNotice, resolveNoticeRecipients } from "@/lib/marketing/order-notice";
import { sameDaySubscriptions } from "@/lib/subscriptions/same-day";

const DAY = 86_400_000;

/** A designation that pays the bills: the purchase manager type, or one the workspace named for accounts. */
const BILLING_WORDS = /account|financ|billing|purchas|procure/i;

export type CustomerReminderRun = { sent: number; subscriptions: number; reason?: string };

/**
 * The renewal reminder the customer gets by itself (owner, 30 Oct 2026: "customers also get renewal notifications" —
 * on a schedule, to the primary contact and the billing contacts).
 *
 *   · **When**: each of Settings › Renewals' customer days before a subscription ends (`customerReminderDays`; empty,
 *     never). The step it is at now, once: not where a renewal reminder — by itself or by hand — went since that step
 *     fell due, so an account manager's own reminder counts and the customer isn't told twice.
 *   · **Which**: up for renewal as the team's reminders read it (`upForRenewalWhere`) — not renewed, not Lost or On
 *     hold, not cancelled.
 *   · **Who**: the company's primary contact and its billing contacts (a purchase manager, or a designation about
 *     accounts, finance, billing or purchase) — the reseller's, on a reseller's order — else its first contact.
 *   · **Copied**: Settings › Renewals' addresses, and the renewal's manager when ticked (owner, 13 Nov 2026) — the
 *     customer's renewal manager, else its account manager — on the first contact's email, as a hand-sent one is.
 *   · **How**: exactly the hand-sent reminder (src/lib/marketing/order-notice.ts): its words, a contact who unticked
 *     renewal reminders or can't be written to skipped, in the mail log against the order, with nobody as its sender.
 *
 * On the heartbeat (src/lib/marketing/heartbeat.ts), as the renewal tasks are.
 */
export async function runCustomerRenewalReminders(now = new Date(), opts: { only?: string[] } = {}): Promise<CustomerReminderRun> {
  if (!(await moduleAvailableForTenant("renewals"))) return { sent: 0, subscriptions: 0, reason: "renewals are off" };
  const { days } = await customerReminderDays();
  const copies = await customerReminderCopies();
  if (days.length === 0) return { sent: 0, subscriptions: 0, reason: "off" };
  const clock = await workspaceClock();
  const today = clock.calendarDate(now);
  const furthest = Math.max(...days);
  const due = await db.companyProduct.findMany({
    // `only`: a check suite's own subscriptions, so a run never writes to the workspace's real customers.
    where: { AND: [upForRenewalWhere(today, new Date(today.getTime() + furthest * DAY)), ...(opts.only ? [{ id: { in: opts.only } }] : [])] },
    orderBy: { endDate: "asc" },
    take: 200,
    select: { id: true, endDate: true },
  });
  // Past orders entered within 15 days of their end (owner, 23 Nov 2026 — temporary, src/actions/past-order.ts): the team
  // sees them in renewals, the customer gets no automatic reminder. Later ones are reminded as any other.
  const quiet = await quietPastOrders(due.map((d) => ({ id: d.id, endDate: d.endDate! })));
  let sent = 0;
  let subscriptions = 0;
  let origin: string | null = null;
  /** Told already this sweep, in an email about another of the customer's subscriptions renewing that day. */
  const covered = new Set<string>();
  for (const sub of due) {
    if (covered.has(sub.id) || quiet.has(sub.id)) continue;
    const left = Math.round((sub.endDate!.getTime() - today.getTime()) / DAY);
    const step = ladderStep(left, days);
    if (step === null) continue;
    // The customer's other subscriptions up for renewal that same day, in one email (owner, 3 Nov 2026).
    const together = await sameDaySubscriptions(sub.id, upForRenewalWhere(today, new Date(today.getTime() + furthest * DAY)));
    const ids = together.length ? together.map((s) => s.id) : [sub.id];
    for (const id of ids) covered.add(id);
    // Since this step fell due, any renewal reminder about it — this sweep's or somebody's own, about any of them — is
    // the step done. It falls due when that day begins on the workspace's clock: the end date is a typed day kept as
    // its midnight UTC, and counting from that told a customer in India again every few minutes from midnight to 5.30 am
    // (13 Nov 2026), as a reminder sent before midnight UTC read as belonging to an earlier step.
    const stepDay = new Date(sub.endDate!.getTime() - step * DAY);
    const stepFrom = clock.startOfDay(stepDay.toISOString().slice(0, 10)) ?? stepDay;
    const told = await db.marketingMessage.findFirst({ where: { companyProductId: { in: ids }, noticeKind: "RENEWAL", createdAt: { gte: stepFrom } }, select: { id: true } });
    if (told) continue;
    const available = await resolveNoticeRecipients(sub.id, "RENEWAL");
    if (!available) continue;
    const contacts = available.contacts.filter((c) => c.canReceive);
    if (contacts.length === 0) continue;
    const named = await db.contact.findMany({ where: { id: { in: contacts.map((c) => c.id) } }, select: { id: true, designationRef: { select: { name: true } } } });
    const titleOf = new Map(named.map((c) => [c.id, c.designationRef?.name ?? ""]));
    const chosen = contacts.filter((c) => c.isPrimary || c.designation === "PURCHASE_MANAGER" || BILLING_WORDS.test(titleOf.get(c.id) ?? ""));
    const to = (chosen.length ? chosen : contacts.slice(0, 1)).map((c) => c.id);
    origin ??= await tenantOrigin();
    const cc = await copiesFor(sub.id, copies);
    const result = await queueCustomerNotice({ companyProductId: sub.id, contactIds: to, kind: "RENEWAL", origin, together, ...(cc.length ? { cc } : {}) });
    if (!result.ok) continue;
    sent += result.data.sent;
    if (result.data.sent > 0) subscriptions += ids.length;
  }
  return { sent, subscriptions };
}

/** Past orders entered with 15 days or less to go — no automatic customer reminder for them. */
export const PAST_ORDER_QUIET_DAYS = 15;
export async function quietPastOrders(subs: { id: string; endDate: Date }[]): Promise<Set<string>> {
  if (!subs.length) return new Set();
  const entries = await db.pastOrderEntry.findMany({ where: { orderId: { in: subs.map((s) => s.id) } }, select: { orderId: true, recordedAt: true } }).catch(() => []);
  const ends = new Map(subs.map((s) => [s.id, s.endDate.getTime()]));
  return new Set(entries.filter((e) => (ends.get(e.orderId) ?? 0) - e.recordedAt.getTime() <= PAST_ORDER_QUIET_DAYS * DAY).map((e) => e.orderId));
}

/** The addresses copied on one subscription's reminder: the fixed ones, and its renewal manager's when asked. */
async function copiesFor(companyProductId: string, copies: { emails: string[]; manager: boolean }): Promise<string[]> {
  const out = [...copies.emails];
  if (copies.manager) {
    const sub = await db.companyProduct.findUnique({ where: { id: companyProductId }, select: { company: { select: { id: true, owner: { select: { id: true, name: true } } } } } });
    if (sub) {
      const manager = (await renewalManagersOf([sub.company])).get(sub.company.id);
      if (manager) {
        const person = await db.user.findUnique({ where: { id: manager.id }, select: { email: true, active: true } });
        if (person?.active && person.email) out.push(person.email.toLowerCase());
      }
    }
  }
  return [...new Set(out.map((e) => e.trim().toLowerCase()).filter(Boolean))];
}
