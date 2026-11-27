import type { AttendanceStatus } from "@prisma/client";

/**
 * Kredily's attendance history (owner, 31 Oct 2026): the Consolidated Attendance Report — a title row ("… Consolidated
 * Attendance Report - 1 Jan 25 - 31 Oct"), then Employee ID, Name, Work Location, Department, Designation and a column
 * per day headed "1 Jan", "2 Jan" … with no year, then its totals. Each day holds a mark: P, A, WO, H, L, HL, LOP, NA,
 * or two halves ("P / HL"). The report has no in- or out-times — only the day's mark — so that is all that comes across.
 *
 * Read here into one mark per person per day; turned into Deskzo's attendance days by the Kredily import
 * (src/actions/kredily-import.ts), which never touches a day Deskzo already has.
 */

export type KredilyMark = { code: string; date: string; mark: string };
export type KredilyAttendance = { from: string; to: string; marks: KredilyMark[] };

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

const key = (y: number, m: number, d: number) => `${y}-${String(m + 1).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const real = (y: number, m: number, d: number) => {
  const at = new Date(Date.UTC(y, m, d));
  return at.getUTCFullYear() === y && at.getUTCMonth() === m && at.getUTCDate() === d;
};

/** A day heading: "1 Jan" (no year), "1 Jan 2025", "01-01-2025" or "01/01/2025"; null for anything else. */
export function dayHeading(h: string): { d: number; m: number; y: number | null } | null {
  const t = h.trim();
  const named = /^(\d{1,2})[\s-]([A-Za-z]{3})[a-z]*\.?(?:[\s,-]+(\d{2}|\d{4}))?$/.exec(t);
  if (named) {
    const m = MONTHS.indexOf(named[2]!.toLowerCase());
    if (m < 0) return null;
    const y = named[3] ? Number(named[3].length === 2 ? `20${named[3]}` : named[3]) : null;
    return { d: Number(named[1]), m, y };
  }
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(t);
  if (dmy) return { d: Number(dmy[1]), m: Number(dmy[2]) - 1, y: Number(dmy[3]) };
  return null;
}

/** The report's first day as the title gives it — "1 Jan 25" in "… Report - 1 Jan 25 - 31 Oct". */
export function titleStart(title: string): { d: number; m: number; y: number } | null {
  const at = /(\d{1,2})\s+([A-Za-z]{3})[a-z]*\.?,?\s+(\d{4}|\d{2})\b/.exec(title);
  if (!at) return null;
  const m = MONTHS.indexOf(at[2]!.toLowerCase());
  if (m < 0) return null;
  return { d: Number(at[1]), m, y: Number(at[3]!.length === 2 ? `20${at[3]}` : at[3]) };
}

/**
 * Each day column's date, YYYY-MM-DD. Headings without a year are walked in order from the title's first day — a year
 * turning over when the day comes round again — or, with no title, from whichever year puts the last day on or before
 * today. Null for a heading that isn't a day.
 */
export function columnDates(headers: string[], title: string, today: string): (string | null)[] {
  const parsed = headers.map(dayHeading);
  const walk = (startYear: number) => {
    let at: { y: number; m: number; d: number } | null = null;
    return parsed.map((p) => {
      if (!p) return null;
      if (p.y !== null) {
        if (!real(p.y, p.m, p.d)) return null;
        at = { y: p.y, m: p.m, d: p.d };
        return key(p.y, p.m, p.d);
      }
      let y: number = at ? at.y : startYear;
      if (at && key(y, p.m, p.d) <= key(at.y, at.m, at.d)) y += 1;
      if (!real(y, p.m, p.d)) return null;
      at = { y, m: p.m, d: p.d };
      return key(y, p.m, p.d);
    });
  };
  const first = parsed.find((p) => p);
  const start = titleStart(title);
  if (start && first && first.m === start.m && first.d === start.d) return walk(start.y);
  const year = Number(today.slice(0, 4));
  for (let y = year; y >= year - 5; y--) {
    const dates = walk(y).filter((x): x is string => !!x);
    if (dates.length && dates[dates.length - 1]! <= today) return walk(y);
  }
  return walk(year);
}

/** Kredily's mark tidied — "p / hl" as "P / HL" — so the preview counts one spelling. */
export const tidyMark = (raw: string) =>
  raw
    .trim()
    .toUpperCase()
    .split("/")
    .map((s) => s.trim())
    .filter(Boolean)
    .join(" / ");

export type MarkMeaning = { status: AttendanceStatus; absent: boolean } | null;

const SINGLE: Record<string, { status: AttendanceStatus; absent: boolean }> = {
  P: { status: "PRESENT", absent: false },
  OD: { status: "PRESENT", absent: false },
  WFH: { status: "WORK_FROM_HOME", absent: false },
  A: { status: "ABSENT", absent: true },
  LOP: { status: "ABSENT", absent: true },
  WO: { status: "WEEK_OFF", absent: false },
  H: { status: "HOLIDAY", absent: false },
  L: { status: "ON_LEAVE", absent: false },
  HL: { status: "HALF_DAY", absent: false },
  HD: { status: "HALF_DAY", absent: false },
};

/**
 * A mark as a Deskzo day: P present, A absent, WO week off, H holiday, L leave, HL half a day's leave, LOP unpaid (an
 * absence). Two halves with a half leave in them ("P / HL", "HL / LOP") are a half day. Null for what isn't a day
 * to record — NA (not employed then), blank — or a mark Deskzo doesn't know, which the preview lists.
 */
export function markMeaning(mark: string): MarkMeaning {
  const parts = tidyMark(mark).split(" / ");
  if (parts.length === 1) return SINGLE[parts[0]!] ?? null;
  if (parts.length === 2 && parts.every((p) => SINGLE[p]) && parts.some((p) => p === "HL" || p === "HD")) return { status: "HALF_DAY", absent: false };
  if (parts.length === 2 && parts[0] === parts[1]) return SINGLE[parts[0]!] ?? null;
  return null;
}

/** Marks that mean nothing to record, not marks to list as unknown. */
export const NOT_A_DAY = new Set(["", "NA", "-"]);
