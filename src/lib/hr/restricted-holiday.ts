import { toKey, type HolidayLike } from "@/lib/hr/calendar";

/**
 * Restricted holidays as leave (owner, 26 Nov 2026 — "RH option is not there"). A restricted holiday is a day on the
 * holiday list marked Restricted: the office stays open, and whoever takes it spends a day of their RH allowance — the
 * leave type with the code RH, whose yearly quota HR sets in Leave settings like any other. It can be taken only on such
 * a day. Pure and client-safe.
 */

/** The code of the leave type restricted holidays are taken from. */
export const RH_CODE = "RH";

export const isRestrictedHolidayType = (type: { code: string }) => type.code.trim().toUpperCase() === RH_CODE;

/** The days marked Restricted, "yyyy-mm-dd". */
export const restrictedDates = (holidays: HolidayLike[]) => new Set(holidays.filter((h) => h.optional).map((h) => toKey(h.date)));

/** Why RH can't be taken on these working days — the first that isn't a restricted holiday — or null. */
export function restrictedHolidayRefusal(workingDates: string[], restricted: Set<string>): string | null {
  const wrong = workingDates.find((d) => !restricted.has(d));
  if (!wrong) return null;
  return `RH is only for the restricted holidays on the holiday list, and ${wrong} isn't one. Pick another leave type for that day.`;
}
