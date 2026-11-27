/**
 * A day as an old system's export writes it, read as "yyyy-mm-dd" (src/lib/migration; owner, 27 Oct 2026). Zoho
 * Books writes dates in the organisation's own format — "2017-08-06", "06/08/2017", "06 Aug 2017", "Aug 06, 2017",
 * "06.08.2017" — sometimes with a time after it; a backup a spreadsheet opened may have any of them. Day first where
 * it can't tell, as Indian organisations write it; month first only when the first number can't be a month's day
 * order otherwise (13/08/2017 is the 13th; 08/13/2017 is 13 August).
 */

const MONTHS: Record<string, number> = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

const pad = (n: number) => String(n).padStart(2, "0");
function day(y: number, m: number, d: number): string | null {
  if (!(y >= 1900 && y <= 2200 && m >= 1 && m <= 12 && d >= 1 && d <= 31)) return null;
  const at = new Date(Date.UTC(y, m - 1, d));
  return at.getUTCMonth() === m - 1 ? `${y}-${pad(m)}-${pad(d)}` : null;
}

export function readDay(text: string | null | undefined): string | null {
  const raw = (text ?? "").trim();
  if (!raw) return null;
  // The date, without a time after it: "2026-07-13 10:22:00", "2026-07-13T10:22:00+0530", "Aug 6, 2017 10:22 AM".
  const t = raw.replace(/[T ]\d{1,2}:\d{2}(:\d{2})?(\.\d+)?\s*([AP]M)?\s*(Z|[+-]\d{2}:?\d{2})?$/i, "").trim();
  let m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})$/.exec(t);
  if (m) return day(+m[1]!, +m[2]!, +m[3]!);
  m = /^(\d{1,2})[-/.](\d{1,2})[-/.](\d{4})$/.exec(t);
  if (m) {
    const a = +m[1]!;
    const b = +m[2]!;
    // Day first; month first only when the second can't be a month.
    return b > 12 && a <= 12 ? day(+m[3]!, a, b) : day(+m[3]!, b, a);
  }
  // "06 Aug 2017", "06-Aug-2017", "6 August, 2017"
  m = /^(\d{1,2})[\s\-/.]+([A-Za-z]{3,9})[\s\-/.,]+(\d{4})$/.exec(t);
  if (m) {
    const month = MONTHS[m[2]!.slice(0, 4).toLowerCase()] ?? MONTHS[m[2]!.slice(0, 3).toLowerCase()];
    return month ? day(+m[3]!, month, +m[1]!) : null;
  }
  // "Aug 06, 2017", "August 6 2017"
  m = /^([A-Za-z]{3,9})[\s\-/.]+(\d{1,2})(?:st|nd|rd|th)?[\s,\-/.]+(\d{4})$/.exec(t);
  if (m) {
    const month = MONTHS[m[1]!.slice(0, 4).toLowerCase()] ?? MONTHS[m[1]!.slice(0, 3).toLowerCase()];
    return month ? day(+m[3]!, month, +m[2]!) : null;
  }
  return null;
}
