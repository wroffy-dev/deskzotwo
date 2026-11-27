import { AsyncLocalStorage } from "node:async_hooks";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { currentTenantOrNull } from "@/lib/tenancy/resolve";

/**
 * The most emails one customer gets in any 24 hours (owner, 13 Nov 2026: "a max mail count which can be sent to a
 * customer in 24 hours which admin can set from settings — nothing can override this").
 *
 * Kept where mail leaves, not where it is written, so no feature can go round it — campaigns, journeys, renewal and
 * order notices, documents, payment reminders, statements, quick messages, workflows, helpdesk replies, chat
 * follow-ups, meeting invitations, portal codes. All of them end in one of three senders, and each asks here first:
 *   · the company's own provider (src/lib/marketing/providers/index.ts, `gated`);
 *   · the person's own mailbox (src/lib/mail/mailbox.ts, `sendAsUser`);
 *   · Deskzo's own mail, sent for a workspace (src/lib/platform/mailer.ts, `deliverMail`).
 *
 * Only renewal, automation and marketing emails count, and only they are stopped (owner, 13 Nov 2026: "only renewal,
 * automation and marketing mails should count") — an invoice, a payment reminder, a helpdesk reply or a sign-in code
 * goes whatever the count. Which an email is, is said where it starts (`countedAs`), not trusted to the sender:
 *   · marketing: a campaign's or a journey's email, or any marketing-class one, as the queue sends it
 *     (src/lib/marketing/pipeline.ts, `sendQueued`);
 *   · renewal: a renewal reminder or confirmation, by itself or by hand, as the queue sends it;
 *   · automation: everything a workflow's step sends, by any route — its email, its document (src/lib/automate/engine.ts).
 *
 * Counted per address, over the last 24 hours, from what really went: each address an email is to or copied to is a
 * row in `customer_mail_sends`. Somebody in this workspace isn't a customer and isn't counted; nor is a blind copy,
 * which is always the sender's own. An email that would take any address past the limit isn't sent at all — to nobody
 * — and says who and why. The rows are written before the email goes, under a lock on each address, so two sends at
 * once can't both slip under; one that then fails gives its rows back.
 */

const DAY = 86_400_000;

/** The kinds of email the limit counts. */
export type CountedMail = "renewal" | "automation" | "marketing";
export const COUNTED_MAIL: Record<CountedMail, string> = { renewal: "renewal", automation: "workflow", marketing: "marketing" };

// One for the process: a dev server's reloaded module, or two bundles, still see the same.
const g = globalThis as { __deskzoCountedMail?: AsyncLocalStorage<CountedMail> };
const counting = (g.__deskzoCountedMail ??= new AsyncLocalStorage<CountedMail>());

/** Runs `fn` with whatever it emails counted as `kind` — the queue around a message, the engine around a step. */
export function countedAs<T>(kind: CountedMail | null | undefined, fn: () => Promise<T>): Promise<T> {
  return kind ? counting.run(kind, fn) : fn();
}

/** What the email being sent now counts as; undefined, it doesn't count. */
export function countedKind(): CountedMail | undefined {
  return counting.getStore();
}
/** The highest limit Settings takes: above it, there is no limit worth the name. */
export const MAX_DAILY_LIMIT = 500;

/** The limit set in Settings › Customer emails; null, none. None before 20261213140000_customer_mail_cap. */
export async function customerMailLimit(): Promise<number | null> {
  try {
    const row = await db.customerEmailSettings.findUnique({ where: { id: "global" }, select: { maxPerRecipientPerDay: true } });
    return row?.maxPerRecipientPerDay ?? null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

export type CapRefusal = { address: string; limit: number; sentence: string };
export type MailReservation = { ok: true; ids: string[] } | { ok: false; refusal: CapRefusal };

const NOTHING: MailReservation = { ok: true, ids: [] };

/** The sentence a refused email carries: in the mail log, in the queue, and to whoever pressed send. */
export function capSentence(address: string, limit: number): string {
  return `${address} has had ${limit} renewal, workflow or marketing email${limit === 1 ? "" : "s"} from you in the last 24 hours, the most Settings › Customer emails allows. No more of those go to them until 24 hours after the earliest.`;
}

/**
 * Asks to send one email to `addresses` (its to and its copies — never its blind copies). Either the rows are written
 * and their ids come back, to give back with `releaseCustomerMail` if the email then fails, or it is refused.
 * Outside a workspace (Deskzo's own mail to its customers' admins) there is nothing to count.
 */
export async function reserveCustomerMail(addresses: (string | null | undefined)[], via: string, now = new Date()): Promise<MailReservation> {
  const list = [...new Set(addresses.map((a) => a?.trim().toLowerCase()).filter((a): a is string => !!a && a.includes("@")))];
  const kind = countedKind();
  if (!kind) return NOTHING;
  if (list.length === 0) return NOTHING;
  if (!(await currentTenantOrNull())) return NOTHING;
  const limit = await customerMailLimit();
  if (limit === null) return NOTHING;
  // The workspace's own people — a copy to a colleague, an account email — aren't customers.
  const staff = await db.user.findMany({ where: { email: { in: list, mode: "insensitive" } }, select: { email: true } });
  const ours = new Set(staff.map((u) => u.email?.toLowerCase()));
  const outside = list.filter((a) => !ours.has(a)).sort();
  if (outside.length === 0) return NOTHING;
  try {
    return await db.$transaction(async (tx) => {
      // One at a time per address, in the same order everywhere so two sends can't wait on each other.
      for (const address of outside) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`customer-mail:${address}`}))`;
      const counts = await tx.customerMailSend.groupBy({
        by: ["address"],
        where: { address: { in: outside }, sentAt: { gt: new Date(now.getTime() - DAY) } },
        _count: { _all: true },
      });
      const full = counts.find((c) => c._count._all >= limit);
      if (full) return { ok: false as const, refusal: { address: full.address, limit, sentence: capSentence(full.address, limit) } };
      const rows = await tx.customerMailSend.createManyAndReturn({ data: outside.map((address) => ({ address, via: `${kind}:${via}`, sentAt: now })), select: { id: true } });
      // What no window will look at again.
      await tx.customerMailSend.deleteMany({ where: { address: { in: outside }, sentAt: { lt: new Date(now.getTime() - 2 * DAY) } } });
      return { ok: true as const, ids: rows.map((r) => r.id) };
    });
  } catch (err) {
    // A workspace not migrated yet has no limit to keep.
    if (notMigratedYet(err)) return NOTHING;
    throw err;
  }
}

/** An email that was counted and then didn't go: its rows back, so it doesn't use up the day. */
export async function releaseCustomerMail(reservation: MailReservation): Promise<void> {
  if (!reservation.ok || reservation.ids.length === 0) return;
  await db.customerMailSend.deleteMany({ where: { id: { in: reservation.ids } } }).catch(() => undefined);
}

/** Who is at the limit now, for Settings: the addresses, most emailed first. */
export async function addressesAtLimit(now = new Date()): Promise<{ address: string; count: number }[]> {
  const limit = await customerMailLimit();
  if (limit === null) return [];
  try {
    const counts = await db.customerMailSend.groupBy({
      by: ["address"],
      where: { sentAt: { gt: new Date(now.getTime() - DAY) } },
      _count: { _all: true },
      having: { address: { _count: { gte: limit } } },
      orderBy: { _count: { address: "desc" } },
      take: 20,
    });
    return counts.map((c) => ({ address: c.address, count: c._count._all }));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}
