/**
 * Loans and salary advances to employees, in figures (owner, 31 Oct 2026). Pure, for src/lib/hr/loans.ts, the payroll
 * run and scripts/check-loans.ts.
 *
 * Money is rounded to the paisa once, where it is decided. A month is its first day, at midnight UTC.
 */

const round2 = (n: number) => Math.round(n * 100) / 100;

/** At most this many monthly instalments — five years. */
export const MAX_INSTALMENTS = 60;

/** Each month's instalment: the amount spread evenly, rounded up to the rupee so the last one is the smallest. */
export function instalmentFor(amount: number, instalments: number): number {
  if (amount <= 0 || instalments <= 0) return 0;
  return Math.min(round2(amount), Math.ceil(amount / instalments));
}

export const outstandingOf = (amount: number, recovered: number): number => Math.max(0, round2(amount - recovered));

/** The 1st of a "YYYY-MM" month, or of a date's month. */
export const monthStart = (year: number, month: number): Date => new Date(Date.UTC(year, month - 1, 1));

export type LoanForPayroll = { id: string; approved: boolean; disbursed: boolean; firstMonth: Date; instalmentAmount: number; outstanding: number };

/**
 * What a month's payslip recovers on each loan: an approved loan, paid out, from its first month on — its instalment, or
 * what is left if less. Then held to what the pay can bear: never more than `payable` in all (the pay after every other
 * deduction), the oldest loan first, so a short month leaves the rest for the next rather than a negative payslip.
 */
export function recoveriesFor(loans: LoanForPayroll[], month: Date, payable: number): { loanId: string; amount: number }[] {
  let room = Math.max(0, round2(payable));
  const out: { loanId: string; amount: number }[] = [];
  for (const l of [...loans].sort((a, b) => a.firstMonth.getTime() - b.firstMonth.getTime())) {
    if (!l.approved || !l.disbursed || l.firstMonth > month || l.outstanding <= 0) continue;
    const amount = round2(Math.min(l.instalmentAmount, l.outstanding, room));
    if (amount <= 0) continue;
    out.push({ loanId: l.id, amount });
    room = round2(room - amount);
  }
  return out;
}

/** Why a loan or advance can't be asked for or approved as set out, or null when it can. */
export function loanProblem(input: { amount: number; instalments: number }): string | null {
  if (!Number.isFinite(input.amount) || input.amount <= 0) return "Enter the amount.";
  if (input.amount > 10_000_000) return "That amount is too large for a loan from pay.";
  if (!Number.isInteger(input.instalments) || input.instalments < 1) return "Choose how many months to recover it over.";
  if (input.instalments > MAX_INSTALMENTS) return `At most ${MAX_INSTALMENTS} monthly instalments.`;
  return null;
}
