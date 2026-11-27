/**
 * End-of-service gratuity under the UAE Labour Law (Federal Decree-Law 33 of 2021, Art. 51; owner, 15 Nov 2026):
 * nothing under a year's service; 21 days' basic pay for each of the first five years, 30 days' for each year after;
 * part years pro rata; days of unpaid leave left out of the service; never more than two years' basic. A day's pay is
 * the monthly basic ÷ 30, as MOHRE's own calculator works it. Since 2022 resigning no longer cuts it.
 *
 * Pure; the page asks it for anybody's last day (src/actions/uae-payroll.ts).
 */

export type Gratuity = {
  serviceDays: number;
  years: number;
  dailyBasic: number;
  firstFiveDays: number;
  afterFiveDays: number;
  amount: number;
  capped: boolean;
  note: string | null;
};

const DAY = 86_400_000;
const utcDay = (d: Date) => Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());

export function uaeGratuity(input: { basicMonthly: number; joinedOn: Date; lastDay: Date; unpaidDays?: number }): Gratuity {
  const raw = Math.floor((utcDay(input.lastDay) - utcDay(input.joinedOn)) / DAY) + 1;
  const serviceDays = Math.max(0, raw - Math.max(0, Math.round(input.unpaidDays ?? 0)));
  const years = serviceDays / 365;
  const dailyBasic = Math.max(0, input.basicMonthly) / 30;
  if (years < 1) return { serviceDays, years, dailyBasic, firstFiveDays: 0, afterFiveDays: 0, amount: 0, capped: false, note: "Under a year's service earns no gratuity." };
  const firstFiveDays = Math.min(years, 5) * 21;
  const afterFiveDays = Math.max(0, years - 5) * 30;
  const uncapped = (firstFiveDays + afterFiveDays) * dailyBasic;
  const cap = Math.max(0, input.basicMonthly) * 24;
  const capped = uncapped > cap;
  return { serviceDays, years, dailyBasic, firstFiveDays, afterFiveDays, amount: Math.round((capped ? cap : uncapped) * 100) / 100, capped, note: capped ? "Capped at two years' basic pay." : null };
}
