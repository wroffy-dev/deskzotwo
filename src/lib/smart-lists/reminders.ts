import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/not-migrated";
import { companyInList } from "@/lib/smart-lists/membership";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { workspaceClock } from "@/lib/time/workspace";
import { mayOpenList } from "@/lib/smart-lists/links";
import { calendarDay } from "@/lib/smart-lists/values";
import { MAX_DAYS_BEFORE, whenWords } from "@/lib/smart-lists/reminder-words";

export { MAX_DAYS_BEFORE, NOTIFY_LABELS, NOTIFY_WHO, whenWords, type NotifyWho } from "@/lib/smart-lists/reminder-words";

/**
 * Reminders from a Smart List's Date columns (owner, 20 Nov 2026 — Smart Lists phase 2: "Renews on", "Expires on",
 * "Insurance till", "Next service due", "Bid due"). Whoever may change a list's columns sets, on a Date column, how
 * many days before each row's date somebody is told — a Person column's person, whoever added the row, the list's
 * builder, or a company's account owner — in Deskzo and by email (SMART_LIST_REMINDER, emailed unless an admin turns it
 * off in Settings › Email notifications).
 *
 * Each row's date is reminded once (`workbook_reminder_sent`, claimed before anybody is told, so two heartbeats never
 * both send it); a date changed later is reminded again. Only dates still to come, and only people who may open the
 * list — and, in a list of companies, for whom the company is still in it — are told. The dates are the ones typed in; nothing is
 * looked up. Run from the heartbeat; never throws.
 */

const pad = (n: number) => String(n).padStart(2, "0");
function plusDays(day: string, n: number): string {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

const longDay = (day: string) => new Date(`${day}T00:00:00Z`).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });

export type ReminderRun = { sent: number; reminded: number; reason?: string };

export async function runListReminders(now = new Date()): Promise<ReminderRun> {
  try {
    if (!(await moduleAvailableForTenant("workspace"))) return { sent: 0, reminded: 0, reason: "Smart Lists are off" };
    const today = (await workspaceClock()).calendarDate(now).toISOString().slice(0, 10);
    let reminders;
    try {
      reminders = await db.workbookReminder.findMany({
        select: { propertyId: true, workbookId: true, daysBefore: true, notify: true, personPropertyId: true, property: { select: { name: true, kind: true } } },
      });
    } catch (err) {
      if (notMigratedYet(err)) return { sent: 0, reminded: 0, reason: "not migrated" };
      throw err;
    }
    let sent = 0;
    let reminded = 0;
    for (const r of reminders) {
      if (r.property.kind !== "DATE") continue;
      const done = await remindFor(r, today);
      sent += done.sent;
      reminded += done.reminded;
    }
    return { sent, reminded };
  } catch (err) {
    console.error("[smart-lists] reminders failed", err instanceof Error ? err.message : err);
    return { sent: 0, reminded: 0, reason: "failed" };
  }
}

type Reminder = { propertyId: string; workbookId: string; daysBefore: number; notify: string; personPropertyId: string | null; property: { name: string } };

async function remindFor(r: Reminder, today: string): Promise<{ sent: number; reminded: number }> {
  const wb = await db.workbook.findUnique({ where: { id: r.workbookId }, select: { id: true, name: true, mode: true, ownerUserId: true, filters: true } });
  if (!wb || wb.mode === "COLD_CALLING") return { sent: 0, reminded: 0 };
  const own = wb.mode === "ROWS";
  const last = plusDays(today, Math.max(0, Math.min(MAX_DAYS_BEFORE, r.daysBefore)));
  // Dates from today out to the reminder's lead: each is due now.
  const window = { gte: today, lte: last } as Prisma.JsonFilter;
  const due: { rowKey: string; day: string }[] = own
    ? (await db.workbookRowValue.findMany({ where: { propertyId: r.propertyId, value: window }, select: { rowId: true, value: true }, take: 2000 })).map((v) => ({ rowKey: v.rowId, day: String(v.value) }))
    : (await db.workbookValue.findMany({ where: { propertyId: r.propertyId, value: window }, select: { companyId: true, value: true }, take: 2000 })).map((v) => ({ rowKey: v.companyId, day: String(v.value) }));
  const ready = due.filter((d) => calendarDay(d.day));
  if (!ready.length) return { sent: 0, reminded: 0 };
  const already = new Set(
    (await db.workbookReminderSent.findMany({ where: { propertyId: r.propertyId, rowKey: { in: ready.map((d) => d.rowKey) } }, select: { rowKey: true, day: true } })).map((s) => `${s.rowKey}:${s.day}`),
  );
  const fresh = ready.filter((d) => !already.has(`${d.rowKey}:${d.day}`));
  if (!fresh.length) return { sent: 0, reminded: 0 };

  // The rows' names, who added them, their account owners and Person-column people.
  const keys = fresh.map((d) => d.rowKey);
  const rows = own
    ? new Map((await db.workbookRow.findMany({ where: { id: { in: keys } }, select: { id: true, title: true, createdByUserId: true } })).map((x) => [x.id, { name: x.title, adder: x.createdByUserId, owner: null as string | null }]))
    : new Map((await db.company.findMany({ where: { id: { in: keys } }, select: { id: true, name: true, ownerUserId: true } })).map((x) => [x.id, { name: x.name, adder: null as string | null, owner: x.ownerUserId }]));
  const persons = new Map<string, string>();
  if (r.notify === "PERSON" && r.personPropertyId) {
    const cells = own
      ? (await db.workbookRowValue.findMany({ where: { propertyId: r.personPropertyId, rowId: { in: keys } }, select: { rowId: true, value: true } })).map((c) => [c.rowId, c.value] as const)
      : (await db.workbookValue.findMany({ where: { propertyId: r.personPropertyId, companyId: { in: keys } }, select: { companyId: true, value: true } })).map((c) => [c.companyId, c.value] as const);
    for (const [k, v] of cells) if (typeof v === "string") persons.set(k, v);
  }
  const active = new Set((await db.user.findMany({ where: { active: true }, select: { id: true } })).map((u) => u.id));
  const opens = new Map<string, boolean>();
  const mayOpen = async (userId: string) => opens.get(userId) ?? (opens.set(userId, await mayOpenList(userId, wb.id)), opens.get(userId)!);

  let sent = 0;
  let reminded = 0;
  for (const d of fresh) {
    const row = rows.get(d.rowKey);
    if (!row) continue;
    const who = r.notify === "PERSON" ? persons.get(d.rowKey) : r.notify === "ADDER" ? row.adder : r.notify === "ACCOUNT_OWNER" ? row.owner : wb.ownerUserId;
    // Claimed first: a second heartbeat finds it taken and tells nobody.
    try {
      await db.workbookReminderSent.create({ data: { propertyId: r.propertyId, rowKey: d.rowKey, day: d.day }, select: { id: true } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }
    reminded += 1;
    if (!who || !active.has(who) || !(await mayOpen(who))) continue;
    // A company no longer in the list for them — or not theirs to see — isn't reminded about.
    if (!own && !(await companyInList(who, wb, d.rowKey))) continue;
    const name = row.name;
    await notifyUser({
      userId: who,
      type: "SMART_LIST_REMINDER",
      title: `${r.property.name} ${whenWords(d.day, today)}: ${name}`.slice(0, 200),
      message: `${name} — ${r.property.name} is ${longDay(d.day)}, in the Smart List "${wb.name}".`,
      link: `/smart-lists/${wb.id}?q=${encodeURIComponent(row.name)}`,
    });
    sent += 1;
  }
  return { sent, reminded };
}

/** Sent marks older than a year go: a date that far back is never reminded again anyway. */
export async function pruneReminderMarks(now = new Date()): Promise<number> {
  try {
    return (await db.workbookReminderSent.deleteMany({ where: { sentAt: { lt: new Date(now.getTime() - 400 * 86_400_000) } } })).count;
  } catch {
    return 0;
  }
}
