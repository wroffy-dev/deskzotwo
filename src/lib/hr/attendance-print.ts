import type { MonthCell } from "@/actions/attendance";
import { isRestrictedHolidayType } from "@/lib/hr/restricted-holiday";

/**
 * How a day reads on the printed month (src/app/(print)/people/attendance/print): a short code on everybody's sheet,
 * words on a person's own page. A recorded day says what was recorded, even on a holiday; an unrecorded one says
 * whether it was a day off, still to come, or a working day nobody recorded.
 */
export const PRINT_CODES = [
  { code: "P", label: "Present" },
  { code: "WFH", label: "Work from home" },
  { code: "½", label: "Half day" },
  { code: "L", label: "On leave" },
  { code: "RH", label: "Restricted holiday" },
  { code: "A", label: "Absent" },
  { code: "H", label: "Holiday" },
  { code: "WO", label: "Week off" },
  { code: "–", label: "Not recorded" },
] as const;

const BY_STATUS = { PRESENT: "P", WORK_FROM_HOME: "WFH", HALF_DAY: "½", ON_LEAVE: "L", ABSENT: "A", HOLIDAY: "H", WEEK_OFF: "WO" } as const;

type PrintDay = Pick<MonthCell, "status" | "offDay" | "future"> & { leaveCode?: string | null };

export function printCode(cell: PrintDay): { code: string; tone: string } {
  // A restricted holiday taken, from the RH allowance (owner, 26 Nov 2026 — src/lib/hr/restricted-holiday.ts).
  if (cell.status === "ON_LEAVE" && cell.leaveCode && isRestrictedHolidayType({ code: cell.leaveCode })) return { code: "RH", tone: "" };
  if (cell.status) return { code: BY_STATUS[cell.status], tone: cell.status === "ABSENT" ? "font-semibold" : cell.status === "HOLIDAY" || cell.status === "WEEK_OFF" ? "text-neutral-500" : "" };
  if (cell.offDay) return { code: cell.offDay === "holiday" ? "H" : "WO", tone: "text-neutral-500" };
  if (cell.future) return { code: "", tone: "" };
  return { code: "–", tone: "text-neutral-500" };
}

export function printDayWords(cell: PrintDay): string {
  const code = printCode(cell).code;
  if (!code) return "";
  return PRINT_CODES.find((c) => c.code === code)!.label;
}
