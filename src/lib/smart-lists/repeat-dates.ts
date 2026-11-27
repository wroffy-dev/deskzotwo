/**
 * Repeating rows' dates and titles (owner, 20 Nov 2026 — Smart Lists phase 4: "a row that comes back — a monthly
 * check, a quarterly filing"). Pure, so the screen can say when the next one comes. Days are "YYYY-MM-DD" in the
 * workspace's own calendar (src/lib/time/workspace.ts); the rules are src/lib/smart-lists/repeats.ts.
 */

export const REPEAT_EVERY = ["day", "week", "month", "quarter", "year"] as const;
export type RepeatEvery = (typeof REPEAT_EVERY)[number];
export const EVERY_LABELS: Record<RepeatEvery, string> = { day: "Every day", week: "Every week", month: "Every month", quarter: "Every quarter", year: "Every year" };
export const REPEAT_LIMITS = { perList: 50, title: 300 } as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
export const isDay = (v: unknown): v is string => typeof v === "string" && DAY.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
export const isEvery = (v: unknown): v is RepeatEvery => typeof v === "string" && (REPEAT_EVERY as readonly string[]).includes(v);

const toDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);
const parts = (day: string) => day.split("-").map(Number) as [number, number, number];
const monthDays = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate();

/** `start` moved by `months`, its day kept — or the month's last day, when the month is shorter (31 Jan → 28 Feb → 31 Mar). */
export function addMonths(start: string, months: number): string {
  const [y, m, d] = parts(start);
  const total = y * 12 + (m - 1) + months;
  const ny = Math.floor(total / 12);
  const nm = (total % 12) + 1;
  return `${String(ny).padStart(4, "0")}-${String(nm).padStart(2, "0")}-${String(Math.min(d, monthDays(ny, nm))).padStart(2, "0")}`;
}

const STEP_MONTHS: Partial<Record<RepeatEvery, number>> = { month: 1, quarter: 3, year: 12 };

/** The first date of the repeat after `day`, counted from its first date `start` — so a month's 31st doesn't drift to the 28th. */
export function nextAfter(start: string, every: RepeatEvery, day: string): string {
  if (day < start) return start;
  const step = STEP_MONTHS[every];
  if (!step) {
    const n = every === "week" ? 7 : 1;
    const startMs = Date.parse(`${start}T00:00:00Z`);
    const passed = Math.floor((Date.parse(`${day}T00:00:00Z`) - startMs) / 86_400_000 / n) + 1;
    return toDay(startMs + passed * n * 86_400_000);
  }
  const [sy, sm] = parts(start);
  const [dy, dm] = parts(day);
  let k = Math.floor(((dy - sy) * 12 + (dm - sm)) / step);
  while (addMonths(start, k * step) <= day) k += 1;
  while (k > 0 && addMonths(start, (k - 1) * step) > day) k -= 1;
  return addMonths(start, k * step);
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** A repeat's title for one of its dates: {date} "1 Dec 2026", {month} "Dec 2026", {year} "2026". */
export function titleFor(pattern: string, day: string): string {
  const [y, m, d] = parts(day);
  return pattern
    .replace(/\{date\}/gi, `${d} ${MONTHS[m - 1]} ${y}`)
    .replace(/\{month\}/gi, `${MONTHS[m - 1]} ${y}`)
    .replace(/\{year\}/gi, String(y))
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, REPEAT_LIMITS.title);
}
