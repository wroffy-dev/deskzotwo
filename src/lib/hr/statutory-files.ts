/**
 * A payroll month's statutory and bank files (owner, 31 Oct 2026: Deskzo People as a complete HRMS — "bank advice,
 * PF ECR, ESI return"). Pure: rows in, file contents and what kept anybody out; src/lib/hr/statutory-data.ts reads the
 * rows, src/app/api/payroll/[runId]/files/[kind] serves them, scripts/check-statutory-files.ts checks them by hand.
 *
 * Nobody is left out quietly: a missing UAN, IP number or bank account keeps that person out of the file and says so.
 */

import { sanitizeCsvCell } from "@/lib/csv";

export type StatutoryRow = {
  name: string;
  employeeCode: string | null;
  uan: string | null;
  esicNumber: string | null;
  dateOfBirth: Date | null;
  exitedOn: Date | null;
  monthDays: number;
  paidDays: number;
  lopDays: number;
  grossEarnings: number;
  pfEmployee: number;
  pfEmployer: number;
  pfWages: number;
  epsWages: number;
  epsEmployer: number;
  esiEmployee: number;
  esiEmployer: number;
  netPay: number;
  bankAccountNumber: string | null;
  bankIfsc: string | null;
  bankName: string | null;
  /** The account holder copied at lock (R3-11) — the beneficiary the bank file names; the person's name without one. */
  bankHolderName?: string | null;
  /** PF on for them that month (the salary structure in force at its end) — a PF month with nothing in it is a problem. */
  pfApplicable?: boolean;
};

export type Month = { year: number; month: number };
export type Built<T> = { content: T; included: number; problems: string[] };

const rupees = (n: number) => Math.round(n);
const digits = (s: string | null) => (s ?? "").replace(/\s+/g, "");
const label = (r: StatutoryRow) => (r.employeeCode ? `${r.name} (${r.employeeCode})` : r.name);

/** Their age on the 1st of the month: the pension stops at 58, and the employer's whole 12% then goes to EPF. */
export function ageOn(dateOfBirth: Date | null, m: Month): number | null {
  if (!dateOfBirth) return null;
  let age = m.year - dateOfBirth.getUTCFullYear();
  if (m.month - 1 < dateOfBirth.getUTCMonth() || (m.month - 1 === dateOfBirth.getUTCMonth() && dateOfBirth.getUTCDate() > 1)) age -= 1;
  return age;
}

/**
 * EPFO's ECR 2.0 text file: one member a line, eleven fields joined by `#~#`, in whole rupees — UAN, name as on the UAN,
 * gross wages, EPF wages, EPS wages, EDLI wages, the employee's EPF, the employer's EPS, the employer's EPF (their 12%
 * less the EPS), NCP days (loss of pay), and refund of advances. `ceiling` is the month's PF wage ceiling, for EDLI.
 */
export function buildEcr(rows: StatutoryRow[], m: Month, ceiling: number): Built<string> {
  const problems: string[] = [];
  const lines: string[] = [];
  for (const r of rows) {
    if (r.pfEmployee <= 0 && r.pfEmployer <= 0) {
      // Security audit round three, 14 Nov 2026 (R3-14): PF on, wages paid, and nothing contributed — fixed at ₹0 on
      // the structure, say — left them out of the return without a word. Said now; the employer decides.
      if (r.pfApplicable && r.paidDays > 0 && r.grossEarnings > 0) problems.push(`${label(r)} — PF is on for them but nothing was contributed this month`);
      continue;
    }
    const uan = digits(r.uan);
    if (!/^\d{12}$/.test(uan)) {
      problems.push(`${label(r)} — ${uan ? "the UAN isn't 12 digits" : "no UAN on their record"}`);
      continue;
    }
    const pensionable = (ageOn(r.dateOfBirth, m) ?? 0) < 58;
    // Payslips from before the run kept these (20261201210000) carry none: worked back from the 12% the same way.
    const kept = r.pfWages > 0;
    const pfWages = kept ? r.pfWages : Math.max(r.pfEmployee, r.pfEmployer) / 0.12;
    const epsBase = kept ? r.epsWages : Math.min(pfWages, ceiling);
    const epsShare = kept ? r.epsEmployer : Math.min(r.pfEmployer, epsBase * 0.0833);
    const epfWages = rupees(pfWages);
    const epsWages = pensionable ? rupees(epsBase) : 0;
    const edliWages = rupees(Math.min(pfWages, ceiling));
    const eps = pensionable ? rupees(epsShare) : 0;
    const name = r.name.replace(/[^A-Za-z .]/g, " ").replace(/\s+/g, " ").trim().toUpperCase();
    lines.push([uan, name, rupees(r.grossEarnings), epfWages, epsWages, edliWages, rupees(r.pfEmployee), eps, rupees(r.pfEmployer) - eps, Math.round(r.lopDays), 0].join("#~#"));
  }
  return { content: lines.join("\n"), included: lines.length, problems };
}

export type EsiLine = { ipNumber: string; name: string; days: number; wages: number; reasonCode: number; lastWorkingDay: string };

/**
 * ESIC's monthly contribution upload: for each insured person covered this month, their IP number, name, the days wages
 * were paid for, the month's wages in whole rupees, a reason code for zero days (0 otherwise), and the last working day
 * of somebody who left in the month (dd/mm/yyyy).
 */
export function buildEsi(rows: StatutoryRow[], m: Month): Built<EsiLine[]> {
  const problems: string[] = [];
  const out: EsiLine[] = [];
  for (const r of rows) {
    if (r.esiEmployee <= 0 && r.esiEmployer <= 0) continue;
    const ip = digits(r.esicNumber);
    if (!/^\d{10}$/.test(ip)) {
      problems.push(`${label(r)} — ${ip ? "the ESI IP number isn't 10 digits" : "no ESI IP number on their record"}`);
      continue;
    }
    const leftThisMonth = !!r.exitedOn && r.exitedOn.getUTCFullYear() === m.year && r.exitedOn.getUTCMonth() + 1 === m.month;
    const days = Math.round(r.paidDays);
    out.push({
      ipNumber: ip,
      name: r.name.replace(/[^A-Za-z ]/g, " ").replace(/\s+/g, " ").trim(),
      days,
      wages: rupees(r.grossEarnings),
      // ESIC's codes: 2 is left service, which takes the last working day; 1 is on leave (no days paid); 0 otherwise.
      reasonCode: leftThisMonth ? 2 : days > 0 ? 0 : 1,
      lastWorkingDay: leftThisMonth && r.exitedOn ? `${String(r.exitedOn.getUTCDate()).padStart(2, "0")}/${String(r.exitedOn.getUTCMonth() + 1).padStart(2, "0")}/${r.exitedOn.getUTCFullYear()}` : "",
    });
  }
  return { content: out, included: out.length, problems };
}

export type BankLine = { name: string; accountNumber: string; ifsc: string; amount: number; bankName: string | null };
const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;

/** Everybody paid a net this month, with the account it goes to — for the bank advice and the transfer file. */
export function buildBank(rows: StatutoryRow[]): Built<BankLine[]> & { total: number } {
  const problems: string[] = [];
  const out: BankLine[] = [];
  for (const r of rows) {
    // Security audit round three, 14 Nov 2026 (low): a negative net was dropped from the file without a word.
    if (r.netPay < 0) {
      problems.push(`${label(r)} — the net pay is below nothing (₹${r.netPay.toLocaleString("en-IN")}), so nothing can be paid`);
      continue;
    }
    if (r.netPay === 0) continue;
    const account = digits(r.bankAccountNumber);
    const ifsc = digits(r.bankIfsc).toUpperCase();
    if (!/^\d{6,20}$/.test(account)) {
      problems.push(`${label(r)} — ${account ? "the bank account number isn't 6–20 digits" : "no bank account on their record"}`);
      continue;
    }
    if (!IFSC.test(ifsc)) {
      problems.push(`${label(r)} — ${ifsc ? "the IFSC isn't valid" : "no IFSC on their record"}`);
      continue;
    }
    out.push({ name: r.bankHolderName?.trim() || r.name, accountNumber: account, ifsc, amount: Math.round(r.netPay * 100) / 100, bankName: r.bankName });
  }
  const total = Math.round(out.reduce((t, l) => t + l.amount, 0) * 100) / 100;
  return { content: out, included: out.length, problems, total };
}

/**
 * The transfer file most banks' bulk upload takes: beneficiary, account, IFSC, amount, narration — one a line.
 * The name and the narration are typed text, so they pass the formula guard (security audit, 11 Nov 2026 — SEC-57);
 * the account number, IFSC and amount are checked digits and stay exactly as the bank expects them.
 */
export function bankCsv(lines: BankLine[], narration: string): string {
  const cell = (v: string | number) => `"${String(v).replace(/"/g, '""')}"`;
  return [["Beneficiary Name", "Account Number", "IFSC", "Amount", "Narration"].map(cell).join(","), ...lines.map((l) => [sanitizeCsvCell(l.name), l.accountNumber, l.ifsc, l.amount.toFixed(2), sanitizeCsvCell(narration)].map(cell).join(","))].join("\r\n");
}
