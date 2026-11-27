import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { leaveYearOf, parseLeaveYearRules, type LeaveYearRule } from "@/lib/hr/leave-year";

/**
 * The company's leave year rules (src/lib/hr/leave-year.ts) — none, April throughout, while nobody has changed it or
 * the table isn't there yet. Server only.
 */
export async function leaveYearRules(): Promise<LeaveYearRule[]> {
  try {
    const row = await db.leaveYearSettings.findUnique({ where: { id: "global" }, select: { rules: true } });
    return parseLeaveYearRules(row?.rules);
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** The leave year a day falls in, by the company's rules. */
export async function leaveYearOfDay(day: Date | string): Promise<number> {
  return leaveYearOf(day, await leaveYearRules());
}
