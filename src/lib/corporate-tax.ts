/**
 * The UAE's Corporate Tax for a tax period (owner, 14 Nov 2026 — "Corporate Tax report"): a working from the books'
 * profit to the tax, for the business (or its adviser) to file on EmaraTax. Pure: the page and the check read it.
 *
 *   · Taxable income is the accounting profit with the adjustments added back or taken off: half of entertainment,
 *     fines and penalties, donations to bodies that aren't qualifying public benefit entities, and other add-backs;
 *     less exempt income (qualifying dividends, participation gains) and other deductions.
 *   · 0% on the first AED 375,000 of taxable income, 9% above it.
 *   · Small Business Relief, for a business that elects it: revenue of AED 3,000,000 or less in the period (and every
 *     period before — Deskzo can't see those), and not a Qualifying Free Zone Person or part of a large multinational
 *     group. Extended to tax periods ending on or before 31 December 2029. Its taxable income is treated as nil.
 *   · A loss carries forward; this working shows no tax on it and says so.
 *
 * Nothing here is advice and nothing is filed: the page says to check it with the adviser.
 */

export const CT_ZERO_BAND = 375_000;
export const CT_RATE = 9;
export const SBR_REVENUE_LIMIT = 3_000_000;
/** Small Business Relief covers tax periods ending on or before this day (Federal Decree-Law extending it to 2029). */
export const SBR_LAST_PERIOD_END = "2029-12-31";

export type CorporateTaxAdjustments = {
  /** Entertainment of clients and the like — half of it isn't deductible. */
  entertainment: number;
  /** Fines and penalties — none of it is deductible. */
  finesAndPenalties: number;
  /** Donations to bodies that aren't qualifying public benefit entities. */
  nonQualifyingDonations: number;
  /** Anything else the adviser adds back. */
  otherAddBacks: number;
  /** Qualifying dividends and participation gains, already in the profit, not taxed. */
  exemptIncome: number;
  /** Anything else the adviser takes off. */
  otherDeductions: number;
};

export const NO_ADJUSTMENTS: CorporateTaxAdjustments = {
  entertainment: 0,
  finesAndPenalties: 0,
  nonQualifyingDonations: 0,
  otherAddBacks: 0,
  exemptIncome: 0,
  otherDeductions: 0,
};

export type CorporateTaxWorking = {
  revenue: number;
  accountingProfit: number;
  addBacks: number;
  deductions: number;
  taxableIncome: number;
  /** Small Business Relief: may it be elected for this period, and why not when it can't. */
  relief: { available: boolean; why: string | null; elected: boolean };
  /** At 0% and at 9%. */
  zeroBand: number;
  taxedAt9: number;
  tax: number;
  /** A loss to carry forward, when taxable income is below nothing. */
  loss: number;
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const pos = (n: number) => (Number.isFinite(n) && n > 0 ? n : 0);

export function corporateTaxWorking(input: {
  revenue: number;
  accountingProfit: number;
  adjustments: CorporateTaxAdjustments;
  /** The last day of the tax period, yyyy-mm-dd. */
  periodEnd: string;
  electRelief: boolean;
  /** A Qualifying Free Zone Person, or part of a large multinational group: no relief. */
  excludedFromRelief?: boolean;
}): CorporateTaxWorking {
  const a = input.adjustments;
  const addBacks = round2(pos(a.entertainment) * 0.5 + pos(a.finesAndPenalties) + pos(a.nonQualifyingDonations) + pos(a.otherAddBacks));
  const deductions = round2(pos(a.exemptIncome) + pos(a.otherDeductions));
  const taxableIncome = round2(input.accountingProfit + addBacks - deductions);

  const why =
    input.periodEnd > SBR_LAST_PERIOD_END
      ? "Small Business Relief covers tax periods ending on or before 31 December 2029."
      : input.excludedFromRelief
        ? "A Qualifying Free Zone Person or a member of a large multinational group can't elect it."
        : input.revenue > SBR_REVENUE_LIMIT
          ? `Revenue of AED ${Math.round(input.revenue).toLocaleString("en-US")} is above AED 3,000,000.`
          : null;
  const available = why === null;
  const elected = available && input.electRelief;

  const loss = taxableIncome < 0 ? round2(-taxableIncome) : 0;
  const base = elected ? 0 : Math.max(0, taxableIncome);
  const zeroBand = round2(Math.min(base, CT_ZERO_BAND));
  const taxedAt9 = round2(Math.max(0, base - CT_ZERO_BAND));
  return {
    revenue: round2(input.revenue),
    accountingProfit: round2(input.accountingProfit),
    addBacks,
    deductions,
    taxableIncome,
    relief: { available, why, elected },
    zeroBand,
    taxedAt9,
    tax: round2((taxedAt9 * CT_RATE) / 100),
    loss,
  };
}

/** When the return and the tax are due: nine months after the period ends. */
export function corporateTaxDue(periodEnd: string): string {
  const [y, m, d] = periodEnd.split("-").map(Number) as [number, number, number];
  // The last day of the ninth month after: a period ending 31 December 2026 is due 30 September 2027.
  const due = new Date(Date.UTC(y, m - 1 + 9 + 1, 0));
  return d >= new Date(Date.UTC(y, m, 0)).getUTCDate() ? due.toISOString().slice(0, 10) : new Date(Date.UTC(y, m - 1 + 9, d)).toISOString().slice(0, 10);
}
