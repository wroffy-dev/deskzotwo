import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { notifyUser } from "@/lib/notify";
import { workspaceClock } from "@/lib/time/workspace";
import { PEOPLE_ONLY } from "@/lib/people";
import { notMigratedYet } from "@/lib/not-migrated";
import { daysTo, deadlinesDue, REMIND_BEFORE, type Deadline, type Liable } from "./deadlines";

/**
 * The filing calendar as this workspace owes it (owner, 29 Oct 2026; ./deadlines.ts): what is coming, what was missed,
 * what was marked filed — and the bell, for whoever keeps the books (`payments.manage`, as the GST page asks).
 */

/** What this business is liable for, from what it has: a GST registration, TDS on a bill or a salary, TCS on a sale. */
export async function liability(): Promise<Liable> {
  const [gst, tdsBills, challans, salaries, tcs] = await Promise.all([
    db.gstRegistration.count(),
    db.tradeDocument.count({ where: { direction: "PURCHASE", withholdingMode: "TDS" } }),
    db.tdsChallan.count(),
    db.payslip.count({ where: { incomeTax: { gt: 0 } } }),
    db.tradeDocument.count({ where: { direction: "SALES", withholdingMode: "TCS" } }),
  ]);
  return { gst: gst > 0, tds: tdsBills > 0 || challans > 0, salaryTds: salaries > 0, tcs: tcs > 0 };
}

export type FilingRow = Deadline & { daysLeft: number; filed: { on: string; reference: string | null } | null };

/** How far back a missed filing stays on the list, and how far ahead the list looks. */
const BACK_DAYS = 60;
const AHEAD_DAYS = 45;

const shift = (today: string, days: number) => new Date(Date.parse(`${today}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

/** The filings from two months back to six weeks ahead, each with whether it was marked filed. */
export async function filingCalendar(today?: string): Promise<{ today: string; liable: Liable; rows: FilingRow[] }> {
  const clock = await workspaceClock();
  const on = today ?? clock.today();
  const liable = await liability();
  const deadlines = deadlinesDue(shift(on, -BACK_DAYS), shift(on, AHEAD_DAYS), liable);
  const marks = await db.complianceFiling
    .findMany({ where: { key: { in: deadlines.map((d) => d.key) } }, select: { key: true, filedOn: true, reference: true } })
    .catch((err) => {
      // A workspace not migrated yet has no marks: everything shows as not filed.
      if (notMigratedYet(err)) return [];
      throw err;
    });
  const filed = new Map(marks.map((m) => [m.key, { on: m.filedOn.toISOString().slice(0, 10), reference: m.reference }]));
  const rows = deadlines
    .map((d) => ({ ...d, daysLeft: daysTo(on, d.due), filed: filed.get(d.key) ?? null }))
    // What passed long ago and was filed is history, not a reminder; a missed one stays until marked.
    .filter((r) => r.daysLeft >= 0 || !r.filed);
  return { today: on, liable, rows };
}

/**
 * The bell (the heartbeat, once a day in effect): each filing not marked filed, three days before it is due and the day
 * after it was missed, told once each to whoever keeps the books.
 */
export async function filingChores(now = new Date()): Promise<{ told: number }> {
  const clock = await workspaceClock();
  const today = clock.today(now);
  const { rows } = await filingCalendar(today);
  const ringing = rows.filter((r) => !r.filed && (r.daysLeft === REMIND_BEFORE || r.daysLeft === -1));
  if (ringing.length === 0) return { told: 0 };
  const people = await db.user.findMany({ where: { active: true, ...PEOPLE_ONLY }, select: { id: true }, take: 2000 });
  const keepers: string[] = [];
  for (const p of people) if (await can(p.id, "payments.manage")) keepers.push(p.id);
  let told = 0;
  for (const r of ringing) {
    const missed = r.daysLeft < 0;
    // Once a filing, a moment: its link names it, so a second beat the same day finds it told.
    const link = `/accounting?filing=${encodeURIComponent(r.key)}${missed ? "&missed=1" : ""}`;
    for (const userId of keepers) {
      if (await db.notification.count({ where: { userId, type: "FILING_DUE", link } })) continue;
      await notifyUser({
        userId,
        type: "FILING_DUE",
        title: missed ? `${r.form} for ${r.period} was due yesterday` : `${r.form} for ${r.period} is due in ${REMIND_BEFORE} days`,
        message: `${r.what} Due ${r.due}. Mark it filed under Accounting once it is.`,
        link,
      });
      told += 1;
    }
  }
  return { told };
}

/** Marks a filing done — the reminder for it stops — or, with `filedOn` null, not done after all. */
export async function markFiling(key: string, filedOn: string | null, reference: string | null, userId: string) {
  if (!filedOn) return db.complianceFiling.deleteMany({ where: { key } });
  return db.complianceFiling.upsert({
    where: { key },
    create: { key, filedOn: new Date(`${filedOn}T00:00:00Z`), reference, filedById: userId },
    update: { filedOn: new Date(`${filedOn}T00:00:00Z`), reference, filedById: userId },
  });
}
