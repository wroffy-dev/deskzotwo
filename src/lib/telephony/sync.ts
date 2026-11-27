import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { CALL_PAGE, callerdesk, callerdeskDay } from "@/lib/telephony/callerdesk";
import { connectionKey } from "@/lib/telephony/connection";
import { recordCall } from "@/lib/telephony/ingest";
import { balanceWarning, TelephonyError, type ReportedCall } from "@/lib/telephony/types";
import { can } from "@/lib/authz/resolve";
import { notifyUser } from "@/lib/notify";
import { PEOPLE_ONLY } from "@/lib/people";
import { workspaceClock } from "@/lib/time/workspace";

/**
 * Reading the provider's call list (owner, 26 Oct 2026 — src/lib/telephony): the record every call is believed
 * from, webhook or none. On the five-minute heartbeat, day by day from where the last read got to.
 *
 *   · A day whose count of calls matches the calls already confirmed for it is skipped with one request — so
 *     reading today again every five minutes costs one request a quiet day, and a page a busy one.
 *   · The first read goes back `BACKFILL_DAYS`, so the business line's figures start with history.
 *   · As much as the time allowed, the rest on the next beat: a day is only passed once it is read to the end.
 *   · A click-to-call the provider never reported is closed after six hours, and a live notice never
 *     confirmed is dropped after a day — it was a call that never happened, or a notice somebody made up.
 */

export const BACKFILL_DAYS = 30;
const DAY_MS = 86_400_000;
const IST_MS = 330 * 60_000;
const UNREPORTED_MS = 6 * 3_600_000;

/** India's midnight starting a day, and the next. */
function istDayBounds(day: string): { gte: Date; lt: Date } {
  const start = new Date(Date.parse(`${day}T00:00:00Z`) - IST_MS);
  return { gte: start, lt: new Date(start.getTime() + DAY_MS) };
}
const nextDay = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) + DAY_MS).toISOString().slice(0, 10);

export type SyncOutcome = {
  connectionId: string;
  days: number;
  requests: number;
  calls: number;
  logged: number;
  done: boolean;
  error: string | null;
  /** What happened when the dated list brought nothing — for "Read calls now" to say. */
  note: string | null;
};

export async function syncConnection(connectionId: string, opts: { budgetMs?: number; now?: Date } = {}): Promise<SyncOutcome> {
  const now = opts.now ?? new Date();
  const deadline = Date.now() + (opts.budgetMs ?? 45_000);
  const out: SyncOutcome = { connectionId, days: 0, requests: 0, calls: 0, logged: 0, done: false, error: null, note: null };
  let said: string | null = null;
  let rowsSeen = 0;
  const connection = await db.telephonyConnection.findUnique({ where: { id: connectionId }, select: { id: true, active: true, syncedThrough: true, connectedAt: true } });
  const key = connection?.active ? await connectionKey(connectionId) : null;
  if (!connection || !key) return { ...out, error: "not connected" };

  const today = callerdeskDay(now);
  // A little before where the last read got to, so a call reported late on the day before is caught.
  const from = connection.syncedThrough ? callerdeskDay(new Date(connection.syncedThrough.getTime() - 2 * 3_600_000)) : callerdeskDay(new Date(now.getTime() - BACKFILL_DAYS * DAY_MS));
  let syncedThrough = connection.syncedThrough;

  try {
    for (let day = from; day <= today; day = nextDay(day)) {
      if (Date.now() > deadline) break;
      const first = await callerdesk.callsOn(key, day, 1);
      out.requests += 1;
      said ??= first.said;
      rowsSeen += first.rows;
      const held = await db.telephonyCall.count({ where: { connectionId, confirmedAt: { not: null }, startedAt: istDayBounds(day) } });
      let finished = true;
      if (first.total > held || (first.total === 0 && first.calls.length > 0)) {
        // No count given: page on until a short page says it's the last.
        const pages = first.total > 0 ? Math.ceil(first.total / CALL_PAGE) : 400;
        for (let page = 1; page <= pages; page += 1) {
          if (page > 1 && Date.now() > deadline) {
            finished = false;
            break;
          }
          const batch = page === 1 ? first.calls : (await callerdesk.callsOn(key, day, page)).calls;
          if (page > 1) out.requests += 1;
          for (const call of batch) {
            const r = await recordCall(connectionId, call, "list");
            out.calls += 1;
            if (r.logged) out.logged += 1;
          }
          if (batch.length < CALL_PAGE) break;
        }
      }
      if (!finished) break;
      out.days += 1;
      // A day before today is read for good; today is read again next time.
      syncedThrough = day < today ? istDayBounds(day).lt : istDayBounds(today).gte;
    }
    out.done = syncedThrough !== null && syncedThrough.getTime() >= istDayBounds(today).gte.getTime();

    // Not one row by date, over every day read: CallerDesk may not take the date filter. Its recent calls, asked with the
    // key alone — as another integration reads them live — kept from where this read began. (A day already held still
    // sends its first page, so an ordinary quiet read never comes here.)
    if (rowsSeen === 0 && out.days > 0 && Date.now() < deadline) {
      const recent = await callerdesk.recentCalls(key);
      out.requests += 1;
      const since = istDayBounds(from).gte.getTime();
      for (const call of recent.calls) {
        if (call.startedAt.getTime() < since) continue;
        const r = await recordCall(connectionId, call, "list");
        out.calls += 1;
        if (r.logged) out.logged += 1;
      }
      out.note = [
        `the dated call list gave ${rowsSeen} row(s)${said ? ` (CallerDesk: "${said}")` : ""}`,
        `its recent-calls list gave ${recent.rows}, ${recent.calls.length} of them readable as calls`,
        recent.rows > recent.calls.length && recent.fields.length ? `fields it sent: ${recent.fields.join(", ")}` : null,
      ]
        .filter(Boolean)
        .join("; ");
    }
  } catch (err) {
    out.error = err instanceof Error ? err.message : String(err);
  }

  await db.telephonyCall.updateMany({
    where: { connectionId, state: "REQUESTED", createdAt: { lt: new Date(now.getTime() - UNREPORTED_MS) } },
    data: { state: "ENDED", status: "Not reported", outcome: "NO_ANSWER" },
  });
  await db.telephonyCall.deleteMany({ where: { connectionId, state: "LIVE", confirmedAt: null, updatedAt: { lt: new Date(now.getTime() - DAY_MS) } } });
  await db.telephonyConnection.update({
    where: { id: connectionId },
    data: { syncedThrough, lastSyncAt: now, lastError: out.error ? out.error.slice(0, 300) : null },
  });
  return out;
}

/**
 * A webhook's report, checked against the provider's call list straight away — the customer's calls that day,
 * a page or two. Not there yet (the list can lag the webhook), the heartbeat's read confirms it later.
 */
export async function confirmFromList(connectionId: string, call: ReportedCall): Promise<string | null> {
  const key = await connectionKey(connectionId);
  if (!key) return null;
  let logged: string | null = null;
  for (let page = 1; page <= 2; page += 1) {
    const { calls } = await callerdesk.callsOn(key, callerdeskDay(call.startedAt), page, { callerNumber: call.customerNumber });
    for (const listed of calls) {
      const r = await recordCall(connectionId, listed, "list");
      if (listed.providerCallId === call.providerCallId || Math.abs(listed.startedAt.getTime() - call.startedAt.getTime()) < 120_000) logged = r.logged ?? logged;
    }
    if (calls.length < CALL_PAGE) break;
  }
  return logged;
}

/** When each account's balance was last asked about, in this process — an hour apart is often enough. */
const balanceAsked: Map<string, number> = ((globalThis as { __telephonyBalanceAsked?: Map<string, number> }).__telephonyBalanceAsked ??= new Map());
const BALANCE_EVERY_MS = 3_600_000;

/**
 * The account's balance asked about once an hour; running low — under a tenth of its credits, or its plan
 * ending within a week — told to whoever manages settings, once a day each.
 */
export async function checkBalance(connectionId: string, now = new Date()): Promise<string | null> {
  const last = balanceAsked.get(connectionId) ?? 0;
  if (now.getTime() - last < BALANCE_EVERY_MS) return null;
  balanceAsked.set(connectionId, now.getTime());
  const key = await connectionKey(connectionId);
  if (!key) return null;
  const warning = balanceWarning(await callerdesk.balance(key), now);
  if (!warning) return null;

  const clock = await workspaceClock();
  const since = clock.startOfDay(clock.today(now))!;
  const people = await db.user.findMany({ where: { active: true, ...PEOPLE_ONLY }, select: { id: true }, take: 2000 });
  for (const p of people) {
    if (!(await can(p.id, "settings.manage"))) continue;
    const told = await db.notification.count({ where: { userId: p.id, type: "CLOUD_CALLING_ALERT", createdAt: { gte: since } } });
    if (!told) await notifyUser({ userId: p.id, type: "CLOUD_CALLING_ALERT", title: "CallerDesk is running low", message: warning, link: "/settings/telephony" });
  }
  return warning;
}

/** The heartbeat's part: every connected account read, where Calls is on. */
export async function telephonyChores(opts: { budgetMs?: number } = {}): Promise<SyncOutcome[] | null> {
  if (!(await moduleAvailableForTenant("calls"))) return null;
  let connections: { id: string }[];
  try {
    connections = await db.telephonyConnection.findMany({ where: { active: true }, select: { id: true } });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
  const results: SyncOutcome[] = [];
  for (const c of connections) {
    results.push(
      await syncConnection(c.id, opts).catch((err) => ({
        connectionId: c.id,
        days: 0,
        requests: 0,
        calls: 0,
        logged: 0,
        done: false,
        error: err instanceof TelephonyError || err instanceof Error ? err.message : String(err),
        note: null,
      })),
    );
    await checkBalance(c.id).catch((err) => console.error("telephony balance check failed", err));
  }
  return results;
}
