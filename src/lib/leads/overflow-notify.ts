import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { PEOPLE_ONLY } from "@/lib/people";
import { wants } from "@/lib/notifications/catalogue";
import { sendEmailNotification } from "@/lib/email";
import { pushNoticeToPhones } from "@/lib/app/push";
import { workspaceClock } from "@/lib/time/workspace";
import { leadPath } from "@/lib/record-links";

/**
 * Telling the people who hand out leads that some came in with nobody free to take them (owner, 12 Nov 2026 —
 * Phase 4 lead limits, audit H.6.5).
 *
 * When every person a rule could choose is at their lead limit (or a named owner is), the lead is never lost: it is
 * created unassigned (src/lib/leads/assign.ts `decideOwner`, src/lib/leads/limits.ts). Somebody then has to give it
 * out by hand, so the people who manage assignment are told — whoever holds `leads.assign` or `accounts.reassign`.
 *
 * ## One notification per burst, not one per lead
 *
 * A campaign that overflows sends dozens of leads in a minute; dozens of bells and emails would bury the one that
 * matters. So each manager has at most one *open* overflow notification a business day: while it is unread (and not
 * archived) further overflow counts it up — "7 new leads have nobody free" — and puts the latest reason in it, without
 * another email or phone push. Once they have read it, the next overflow starts a new one, which does email and push.
 * Somebody who muted the kind in their bell gets no bell row; an archived, read one is written for the record and
 * batches their emails for an hour instead.
 *
 * The find-or-create is decided under an advisory lock per manager, in one short transaction, so two requests that
 * overflow at the same moment add to one notification rather than both creating one. That is why the notification is
 * written here rather than through `notifyUser` (src/lib/notify.ts): `notifyUser` writes through the global client
 * and couldn't be held under the lock. Everything else is `notifyUser`'s own parts, in its order — the person's muting
 * (`wants`), the workspace's email (`sendEmailNotification`) and the phone push (`pushNoticeToPhones`).
 *
 * Call it AFTER the transaction that created the leads has committed, never inside it: it reads through the global
 * client and takes a connection of its own (a workspace's pool is two). It never throws — a notification is a side
 * effect and must not fail the intake that called it.
 */

/** The `dedupeKey` prefix of overflow notifications; the business day follows, then the moment it was first raised. */
export const LEAD_OVERFLOW_KEY = "lead-overflow:";

/** The notification type used — the sales kind people mute or keep for "a lead is assigned"; the catalogue has no other lead kind for managers. */
const TYPE = "LEAD_ASSIGNED" as const;

/** How long a muted person's emails are batched for (they have no unread notification to batch on). */
const MUTED_BATCH_MS = 60 * 60 * 1000;

const leadsWord = (n: number) => `${n.toLocaleString("en-IN")} new ${n === 1 ? "lead has" : "leads have"}`;

/** The count an earlier overflow notification carries, from the title this module wrote ("7 new leads have …"). */
function countIn(title: string): number {
  const found = /^([\d,]+) new lead/.exec(title);
  return found ? Number(found[1].replace(/,/g, "")) || 0 : 0;
}

/** The people told: active people (not support or Automation accounts) holding `leads.assign` or `accounts.reassign`, less `except`. */
export async function overflowManagers(except: (string | null | undefined)[] = []): Promise<string[]> {
  const skip = new Set(except.filter((id): id is string => !!id));
  const people = await db.user.findMany({ where: { active: true, ...PEOPLE_ONLY }, select: { id: true }, orderBy: { id: "asc" } });
  const out: string[] = [];
  for (const person of people) {
    if (skip.has(person.id)) continue;
    if ((await can(person.id, "leads.assign")) || (await can(person.id, "accounts.reassign"))) out.push(person.id);
  }
  return out;
}

/**
 * Tells the lead managers that these leads were created with nobody free to take them. `reason` is one sentence for
 * them ("Everybody on the Website rule is at their limit."). `options.except`: people not to tell — whoever created
 * the lead by hand, who was told on the spot. Returns how many people now have a new or counted-up notification.
 */
export async function notifyLeadOverflow(leadIds: string[], reason: string, options: { except?: (string | null | undefined)[] } = {}): Promise<number> {
  try {
    const ids = [...new Set((leadIds ?? []).filter((id): id is string => typeof id === "string" && id.length > 0))];
    if (ids.length === 0) return 0;
    const why = String(reason ?? "").trim().slice(0, 300) || "Everybody who could take them is at their lead limit.";
    const managers = await overflowManagers(options.except ?? []);
    if (managers.length === 0) return 0;
    const day = (await workspaceClock()).dateKey(new Date());
    const single = ids.length === 1 ? await db.lead.findUnique({ where: { id: ids[0] }, select: { leadSeq: true } }) : null;
    const prefix = `${LEAD_OVERFLOW_KEY}${day}:`;

    let told = 0;
    for (const userId of managers) {
      const preference = await db.notificationPreference.findUnique({ where: { userId_type: { userId, type: TYPE } }, select: { inApp: true, email: true } });
      const inApp = wants(TYPE, "inApp", preference);
      const outcome = await db.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deskzo:lead-overflow:${userId}`}))`;
        // Somebody who muted the kind has no bell row to count up; a silent, archived one stands in, for an hour, so their emails are batched too.
        const open = await tx.notification.findFirst({
          where: inApp
            ? { userId, type: TYPE, read: false, archivedAt: null, dedupeKey: { startsWith: prefix } }
            : { userId, type: TYPE, dedupeKey: { startsWith: prefix }, createdAt: { gte: new Date(Date.now() - MUTED_BATCH_MS) } },
          orderBy: { createdAt: "desc" },
          select: { id: true, title: true },
        });
        if (open) {
          const total = countIn(open.title) + ids.length;
          await tx.notification.update({ where: { id: open.id }, data: { title: `${leadsWord(total)} nobody free to take them`, message: `Latest: ${why} They're unassigned — give them out from Leads.`, link: "/leads?owner=unassigned" } });
          return { added: false as const, id: open.id };
        }
        const title = `${leadsWord(ids.length)} nobody free to take ${ids.length === 1 ? "it" : "them"}`;
        const message = `${why} ${ids.length === 1 ? "It's" : "They're"} unassigned — give ${ids.length === 1 ? "it" : "them"} out from Leads.`;
        const link = single ? leadPath(single.leadSeq) : "/leads?owner=unassigned";
        const now = new Date();
        const silent = inApp ? {} : { read: true, readAt: now, archivedAt: now };
        const created = await tx.notification.create({ data: { userId, type: TYPE, title, message, link, dedupeKey: `${prefix}${now.getTime()}:${ids[0]}`, ...silent }, select: { id: true } });
        return { added: true as const, id: inApp ? created.id : null, title, message, link };
      });
      told++;
      if (outcome.added) {
        // As notifyUser: the email is the workspace's choice, sent whether or not the bell is muted; the push only when it rang.
        await sendEmailNotification({ userId, type: TYPE, subject: outcome.title, body: outcome.message, link: outcome.link }).catch((err) => console.error("[leads] overflow email failed", err));
        if (outcome.id) await pushNoticeToPhones(userId, { id: outcome.id, type: TYPE, title: outcome.title, link: outcome.link }).catch((err) => console.error("[leads] overflow push failed", err));
      }
    }
    return told;
  } catch (err) {
    console.error("notifyLeadOverflow failed", err);
    return 0;
  }
}
