import { db } from "@/lib/db";
import { daysInMonth } from "@/lib/hr/calendar";
import { lossOfPayDays } from "@/lib/hr/loss-of-pay";
import { employmentInMonth } from "@/lib/hr/payroll";
import { bankOfIban, uaeIban } from "@/lib/uae/wps-banks";

/**
 * UAE payroll's working (owner, 15 Nov 2026 — "Separate UAE payroll": salary + WPS file, gratuity, UAE leave, document
 * expiries). Deliberately NOT a "use server" module: it reads anybody's absences and pay. src/actions/uae-payroll.ts
 * asks for payroll.manage first.
 *
 * A month's pay is the person's monthly AED — basic, housing, transport, other — for the days they were here, less the
 * unpaid ones (an absence, unpaid leave, and half of each half-pay leave day: UAE sick and maternity leave are partly
 * half pay), less any deduction typed; overtime and bonus on top. The salary file takes the first as its fixed part and
 * the second as its variable part (src/lib/uae/sif.ts).
 */

export type Components = { basic: number; housing: number; transport: number; otherAllowance: number };
export const monthlyTotal = (c: Components) => c.basic + c.housing + c.transport + c.otherAllowance;
const round2 = (n: number) => Math.round(n * 100) / 100;

/** A payslip's fixed pay and net, from its full-month components and the days. */
export function payFor(c: Components, opts: { monthDays: number; daysHere: number; unpaidDays: number; deductions: number; overtime: number; bonus: number }) {
  const payable = Math.max(0, opts.daysHere - Math.max(0, opts.unpaidDays));
  const earned = round2((monthlyTotal(c) * payable) / opts.monthDays);
  const fixed = round2(Math.max(0, earned - Math.max(0, opts.deductions)));
  return { fixed, net: round2(fixed + Math.max(0, opts.overtime) + Math.max(0, opts.bonus)) };
}

/** Leave types whose days are paid at half (src/lib/uae/leave.ts names them …_HALF). */
const isHalfPay = (code: string) => code.endsWith("_HALF");

/** Half-pay leave days in a stretch, each counted as half a day unpaid. */
async function halfPayDays(userId: string, from: Date, to: Date): Promise<number> {
  const rows = await db.attendanceDay.findMany({ where: { userId, date: { gte: from, lte: to }, leaveRequestId: { not: null } }, select: { status: true, leaveRequestId: true } });
  if (!rows.length) return 0;
  const half = new Set(
    (await db.leaveRequest.findMany({ where: { id: { in: rows.map((r) => r.leaveRequestId!) } }, select: { id: true, type: { select: { code: true, paid: true } } } }))
      .filter((r) => r.type.paid && isHalfPay(r.type.code))
      .map((r) => r.id),
  );
  return rows.reduce((t, r) => t + (half.has(r.leaveRequestId!) ? (r.status === "HALF_DAY" ? 0.25 : 0.5) : 0), 0);
}

/** Unpaid days in a month, for the run: absences, unpaid leave, half of half-pay leave. */
export async function uaeUnpaidDays(userId: string, year: number, month: number, employed: { firstDay: number; lastDay: number }): Promise<number> {
  const from = new Date(Date.UTC(year, month - 1, employed.firstDay));
  const to = new Date(Date.UTC(year, month - 1, employed.lastDay));
  const [lop, half] = await Promise.all([lossOfPayDays(userId, year, month, employed), halfPayDays(userId, from, to)]);
  return round2(lop + half);
}

/** Unpaid days over a whole stretch of service — gratuity leaves them out. Absences and unpaid leave only. */
export async function unpaidDaysBetween(userId: string, from: Date, to: Date): Promise<number> {
  const rows = await db.attendanceDay.findMany({ where: { userId, date: { gte: from, lte: to } }, select: { status: true, leaveRequestId: true } });
  const unpaid = new Set(
    (await db.leaveRequest.findMany({ where: { id: { in: rows.map((r) => r.leaveRequestId).filter((v): v is string => !!v) }, type: { paid: false } }, select: { id: true } })).map((r) => r.id),
  );
  return rows.reduce((t, r) => t + (r.status === "ABSENT" ? 1 : r.leaveRequestId && unpaid.has(r.leaveRequestId) ? (r.status === "HALF_DAY" ? 0.5 : 1) : 0), 0);
}

/** The routing code a person is paid through: typed, else read from the IBAN. */
export function routingOf(row: { iban: string | null; routingCode: string | null }): string | null {
  return row.routingCode || bankOfIban(row.iban)?.routingCode || null;
}

export type DraftSlip = {
  userId: string;
  name: string;
  monthDays: number;
  payStart: Date;
  payEnd: Date;
  unpaidDays: number;
  components: Components;
  mohrePersonId: string | null;
  iban: string | null;
  routingCode: string | null;
};

/** Everybody to pay in a month: here for some of it, with UAE pay set. And who was left out, and why. */
export async function uaeMonth(year: number, month: number): Promise<{ slips: DraftSlip[]; skipped: string[] }> {
  const rows = await db.uaeEmployee.findMany();
  const users = await db.user.findMany({
    where: { id: { in: rows.map((r) => r.userId) } },
    select: { id: true, name: true, employeeProfile: { select: { joinedOn: true, exitedOn: true } } },
  });
  const byId = new Map(users.map((u) => [u.id, u]));
  const monthDays = daysInMonth(year, month);
  const slips: DraftSlip[] = [];
  const skipped: string[] = [];
  for (const r of rows) {
    const u = byId.get(r.userId);
    if (!u) continue;
    const components = { basic: Number(r.basic), housing: Number(r.housing), transport: Number(r.transport), otherAllowance: Number(r.otherAllowance) };
    if (monthlyTotal(components) <= 0) {
      skipped.push(`${u.name}: no UAE salary set`);
      continue;
    }
    const employed = employmentInMonth(year, month, u.employeeProfile?.joinedOn, u.employeeProfile?.exitedOn);
    if (!employed) continue;
    slips.push({
      userId: u.id,
      name: u.name,
      monthDays,
      payStart: new Date(Date.UTC(year, month - 1, employed.firstDay)),
      payEnd: new Date(Date.UTC(year, month - 1, employed.lastDay)),
      unpaidDays: await uaeUnpaidDays(u.id, year, month, employed),
      components,
      mohrePersonId: r.mohrePersonId,
      iban: uaeIban(r.iban) ?? r.iban,
      routingCode: routingOf(r),
    });
  }
  slips.sort((a, b) => a.name.localeCompare(b.name));
  return { slips, skipped };
}

export type Expiry = { userId: string; name: string; document: string; on: Date; daysLeft: number };
const DOCUMENTS = [
  ["passportExpiry", "Passport"],
  ["visaExpiry", "Residence visa"],
  ["emiratesIdExpiry", "Emirates ID"],
  ["labourCardExpiry", "Labour card / work permit"],
  ["insuranceExpiry", "Health insurance"],
] as const;

/** Documents expired or expiring within `days`, soonest first. */
export async function uaeExpiries(todayKey: string, days = 60): Promise<Expiry[]> {
  const rows = await db.uaeEmployee.findMany();
  const names = new Map((await db.user.findMany({ where: { id: { in: rows.map((r) => r.userId) } }, select: { id: true, name: true } })).map((u) => [u.id, u.name]));
  const today = Date.parse(`${todayKey}T00:00:00Z`);
  const out: Expiry[] = [];
  for (const r of rows) {
    for (const [field, document] of DOCUMENTS) {
      const on = r[field];
      if (!on) continue;
      const daysLeft = Math.round((on.getTime() - today) / 86_400_000);
      if (daysLeft <= days) out.push({ userId: r.userId, name: names.get(r.userId) ?? "Somebody", document, on, daysLeft });
    }
  }
  return out.sort((a, b) => a.daysLeft - b.daysLeft);
}
