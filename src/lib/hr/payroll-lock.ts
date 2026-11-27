import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { MONTH_NAMES } from "@/lib/hr/calendar";

/**
 * Whether a month's attendance is still open to change.
 *
 * A payroll run past DRAFT (LOCKED or PAID) has turned that month's days into payslips; a day changed after that is
 * a payslip that no longer matches what it was paid on. Security audit, 11 Nov 2026 (SEC-06 for terminal punches,
 * SEC-44 for marking, corrections and leave): every writer of attendance asks here first. HR reopens the run to
 * DRAFT (setPayrollStatus) when a locked month really needs correcting, and it is worked out again.
 *
 * Not a "use server" module: an export here would become a client-callable endpoint.
 */
export async function payrollMonthLocked(month: number, year: number): Promise<boolean> {
  try {
    const run = await db.payrollRun.findUnique({ where: { month_year: { month, year } }, select: { status: true } });
    return !!run && run.status !== "DRAFT";
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

/** The month a `@db.Date` day falls in, read as the calendar day it stores (UTC midnight). */
export function payrollLockedOn(date: Date): Promise<boolean> {
  return payrollMonthLocked(date.getUTCMonth() + 1, date.getUTCFullYear());
}

/** Why a day can't be changed for its payroll, or null when it can. */
export async function payrollLockRefusal(date: Date): Promise<string | null> {
  if (!(await payrollLockedOn(date))) return null;
  const label = `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCFullYear()}`;
  return `${label}'s payroll is already run, so its attendance is fixed. Ask whoever runs payroll to reopen ${label} first.`;
}
