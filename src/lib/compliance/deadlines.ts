/**
 * The statutory filings a business in India runs to a calendar (owner, 29 Oct 2026): GSTR-1 by the 11th and GSTR-3B by
 * the 20th of the month after, TDS deposited by the 7th (March's by 30 April — the TDS rules, src/lib/tds/challan-rules.ts),
 * the quarterly TDS returns — 26Q for what was deducted from vendors, 24Q from salaries — by 31 July, 31 October,
 * 31 January and 31 May, and the TCS return 27EQ by the 15th of the month after the quarter.
 *
 * Deskzo doesn't file them. It says what is coming and what was missed, to whoever keeps the books, until somebody marks
 * each filed (ComplianceFiling). Monthly GST filers' dates: a QRMP filer's quarterly GSTR-1 (the 13th) and its GSTR-3B
 * by state (the 22nd or 24th) aren't told apart yet, and a date the government extends isn't known here.
 *
 * Pure: the page, the reminders and check:filing-deadlines read the same calendar.
 */

export type FilingKind = "GSTR1" | "GSTR3B" | "TDS_DEPOSIT" | "TDS26Q" | "TDS24Q" | "TCS27EQ";

export type Deadline = {
  /** "GSTR1:2026-10" — the filing and its period, which ComplianceFiling keeps once it's done. */
  key: string;
  kind: FilingKind;
  form: string;
  /** "October 2026", "Q2 2026-27 (July–September)". */
  period: string;
  /** The last day, "2026-11-11". */
  due: string;
  what: string;
  href: string;
};

/** What a business is liable for: GST registered, TDS deducted from vendors or from salaries, TCS collected. */
export type Liable = { gst: boolean; tds: boolean; salaryTds: boolean; tcs: boolean };

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const pad = (n: number) => String(n).padStart(2, "0");
const day = (y: number, m: number, d: number) => `${y}-${pad(m)}-${pad(d)}`;
/** The month after `y-m` (1-based months). */
const next = (y: number, m: number): [number, number] => (m === 12 ? [y + 1, 1] : [y, m + 1]);

/** A financial year's quarter of a month: April–June is Q1. */
const quarterOf = (y: number, m: number) => {
  const q = m >= 4 ? Math.floor((m - 4) / 3) + 1 : 4;
  const fy = m >= 4 ? y : y - 1;
  return { q, fy, label: `Q${q} ${fy}-${String((fy + 1) % 100).padStart(2, "0")}` };
};
const QUARTER_MONTHS = ["April–June", "July–September", "October–December", "January–March"];
/** When each quarter's TDS return is due: 31 July, 31 October, 31 January, 31 May. */
const TDS_RETURN_DUE = (fy: number, q: number) => [day(fy, 7, 31), day(fy, 10, 31), day(fy + 1, 1, 31), day(fy + 1, 5, 31)][q - 1]!;
/** And the TCS return: 15 July, 15 October, 15 January, 15 May. */
const TCS_RETURN_DUE = (fy: number, q: number) => [day(fy, 7, 15), day(fy, 10, 15), day(fy + 1, 1, 15), day(fy + 1, 5, 15)][q - 1]!;

/** Every filing of the month `y-m` (its period) that a business so liable owes. */
function ofMonth(y: number, m: number, liable: Liable): Deadline[] {
  const [ny, nm] = next(y, m);
  const period = `${MONTHS[m - 1]} ${y}`;
  const month = `${y}-${pad(m)}`;
  const out: Deadline[] = [];
  if (liable.gst) {
    out.push({ key: `GSTR1:${month}`, kind: "GSTR1", form: "GSTR-1", period, due: day(ny, nm, 11), what: "Outward supplies — every invoice, credit and debit note of the month.", href: `/accounting/gst?month=${m}&year=${y}` });
    out.push({ key: `GSTR3B:${month}`, kind: "GSTR3B", form: "GSTR-3B", period, due: day(ny, nm, 20), what: "The month's summary, and the tax paid.", href: `/accounting/gst?month=${m}&year=${y}` });
  }
  if (liable.tds || liable.salaryTds) {
    // March's TDS by 30 April; every other month's by the 7th.
    out.push({ key: `TDS_DEPOSIT:${month}`, kind: "TDS_DEPOSIT", form: "TDS deposit", period, due: m === 3 ? day(y, 4, 30) : day(ny, nm, 7), what: "The month's TDS paid into the government's account (challan ITNS 281).", href: "/accounting/tds" });
  }
  // A quarter's returns, with the quarter's last month.
  if ([6, 9, 12, 3].includes(m)) {
    const { q, fy, label } = quarterOf(y, m);
    const quarter = `${label} (${QUARTER_MONTHS[q - 1]})`;
    const qkey = `${fy}-Q${q}`;
    if (liable.tds) out.push({ key: `TDS26Q:${qkey}`, kind: "TDS26Q", form: "TDS return 26Q", period: quarter, due: TDS_RETURN_DUE(fy, q), what: "TDS deducted from vendors' bills in the quarter.", href: "/accounting/tds" });
    if (liable.salaryTds) out.push({ key: `TDS24Q:${qkey}`, kind: "TDS24Q", form: "TDS return 24Q", period: quarter, due: TDS_RETURN_DUE(fy, q), what: "TDS deducted from salaries in the quarter.", href: "/people/payroll" });
    if (liable.tcs) out.push({ key: `TCS27EQ:${qkey}`, kind: "TCS27EQ", form: "TCS return 27EQ", period: quarter, due: TCS_RETURN_DUE(fy, q), what: "TCS collected on sales in the quarter.", href: "/accounting/tds" });
  }
  return out;
}

/** The filings due from `from` to `to` (days, inclusive), soonest first. */
export function deadlinesDue(from: string, to: string, liable: Liable): Deadline[] {
  // A filing falls due up to five months after its period (a quarter's return): those periods are looked at.
  let [y, m] = from.split("-").map(Number) as [number, number];
  for (let i = 0; i < 6; i++) [y, m] = m === 1 ? [y - 1, 12] : [y, m - 1];
  const [ty, tm] = to.split("-").map(Number) as [number, number];
  const out: Deadline[] = [];
  while (y < ty || (y === ty && m <= tm)) {
    out.push(...ofMonth(y, m, liable).filter((d) => d.due >= from && d.due <= to));
    [y, m] = next(y, m);
  }
  return out.sort((a, b) => a.due.localeCompare(b.due) || a.form.localeCompare(b.form));
}

/** Days from `today` to `due`: negative once it has passed. */
export function daysTo(today: string, due: string): number {
  return Math.round((Date.parse(`${due}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000);
}

/** When the bell rings for a filing: three days before it is due, and once the day after it was missed. */
export const REMIND_BEFORE = 3;
