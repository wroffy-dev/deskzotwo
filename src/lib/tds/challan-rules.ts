import { sectionByKey, TDS_SECTIONS } from "./sections";

/**
 * Depositing TDS (owner, 25 Oct 2026): the challan, ITNS 281, and when and how late. Pure — the challan
 * form says it as you type, and the TDS page and the suite say the same thing. The books' side is
 * challans.ts.
 *
 *   · **One challan, one section, one kind of deductee.** The challan asks for the nature of payment and
 *     the major head: 0020 when the deductees are companies, 0021 for everyone else. A month's TDS is paid
 *     on as many challans as it has sections and heads; salary's is its own (192).
 *   · **Minor head 200** for TDS the company deducted; 400 for a demand the department raised.
 *   · **Due by the 7th** of the month after the deduction, March's by 30 April (Rule 218).
 *   · **Late, it costs 1.5% a month** (s.398) from the day the tax was deducted to the day it was paid,
 *     each month or part of one counted whole — by calendar month, both ends in, as TRACES counts it.
 *   · **The counterfoil's three numbers** — the bank branch's BSR code, the date, the challan serial —
 *     make its CIN, which the quarterly statement quotes for every deduction the challan paid.
 */

export type MajorHead = "0020" | "0021";
export type MinorHead = "200" | "400";

export const MAJOR_HEADS: Record<MajorHead, string> = {
  "0020": "0020 — deductees that are companies",
  "0021": "0021 — every other deductee",
};
export const MINOR_HEADS: Record<MinorHead, string> = {
  "200": "200 — TDS payable by the deductor",
  "400": "400 — a demand on regular assessment",
};
export const isMajorHead = (v: unknown): v is MajorHead => v === "0020" || v === "0021";
export const isMinorHead = (v: unknown): v is MinorHead => v === "200" || v === "400";

/** Salary's TDS (s.392, the old 192) is deposited on its own challan, beside the sections of src/lib/tds/sections.ts. */
export const SALARY_SECTION = { key: "SALARY", label: "Salary", oldSection: "192" } as const;

/** A section a challan can pay: one from the list, or salary. */
export function isChallanSection(key: string | null | undefined): boolean {
  return key === SALARY_SECTION.key || sectionByKey(key) !== null;
}

/** "194C — Payment to a contractor"; "192 — Salary"; what was stored, for anything else. */
export function challanSectionLabel(key: string | null | undefined): string {
  if (key === SALARY_SECTION.key) return `${SALARY_SECTION.oldSection} — ${SALARY_SECTION.label}`;
  const section = sectionByKey(key);
  return section ? `${section.oldSection} — ${section.label}` : (key ?? "No section");
}

/** The 1961 number alone: "194C", "192". */
export function challanSectionNumber(key: string | null | undefined): string {
  if (key === SALARY_SECTION.key) return SALARY_SECTION.oldSection;
  return sectionByKey(key)?.oldSection ?? key ?? "—";
}

/** 0020 for a company (C in the PAN's fourth place), 0021 for everyone else. Null without a valid PAN. */
export function majorHeadFor(pan: string | null | undefined): MajorHead | null {
  const valid = (pan ?? "").trim().toUpperCase();
  if (!/^[A-Z]{5}[0-9]{4}[A-Z]$/.test(valid)) return null;
  return valid[3] === "C" ? "0020" : "0021";
}

/** The BSR code, when it is one: seven digits. */
export function bsrCodeOf(value: string | null | undefined): string | null {
  const code = (value ?? "").replace(/\s/g, "");
  return /^\d{7}$/.test(code) ? code : null;
}

/** The challan serial as the statement writes it — five digits, zeros in front — when it is one. */
export function challanSerialOf(value: string | null | undefined): string | null {
  const serial = (value ?? "").replace(/\s/g, "");
  if (!/^\d{1,5}$/.test(serial) || Number(serial) === 0) return null;
  return serial.padStart(5, "0");
}

/** The challan identification number: BSR code, the day as DDMMYYYY, and the serial — twenty digits. */
export function challanCin(challan: { bsrCode: string; paidOn: string; challanSerial: string }): string {
  const [y, m, d] = challan.paidOn.split("-");
  return `${challan.bsrCode}${d}${m}${y}${challan.challanSerial}`;
}

/** The first day of the month a day falls in. */
export const monthStart = (day: string) => `${day.slice(0, 7)}-01`;

/** When TDS deducted on `day` is due: the 7th of the next month, March's by 30 April. */
export function depositDueOn(day: string): string {
  const year = Number(day.slice(0, 4));
  const month = Number(day.slice(5, 7));
  const next = new Date(Date.UTC(year, month, month === 3 ? 30 : 7));
  return next.toISOString().slice(0, 10);
}

/** The monthly rate for depositing late (s.398). */
export const LATE_DEPOSIT_RATE = 1.5;

const monthIndex = (day: string) => Number(day.slice(0, 4)) * 12 + Number(day.slice(5, 7)) - 1;

export type LateDeduction = { amount: number; deductedOn: string; dueOn: string; months: number; interest: number };

/**
 * Interest for paying `deductions` on `paidOn`: for each one paid after its due day, 1.5% for every month
 * or part of one from the month it was deducted to the month it was paid, both counted. The total is to
 * the rupee, as a challan is paid.
 */
export function lateDepositInterest(deductions: { amount: number; deductedOn: string }[], paidOn: string): { interest: number; late: LateDeduction[] } {
  const late: LateDeduction[] = [];
  for (const d of deductions) {
    const dueOn = depositDueOn(d.deductedOn);
    if (paidOn <= dueOn || d.amount <= 0) continue;
    const months = monthIndex(paidOn) - monthIndex(d.deductedOn) + 1;
    late.push({ amount: d.amount, deductedOn: d.deductedOn, dueOn, months, interest: (d.amount * LATE_DEPOSIT_RATE * months) / 100 });
  }
  return { interest: Math.round(late.reduce((t, l) => t + l.interest, 0)), late };
}

export type ChallanAmounts = { tax: number; interest: number; fee: number; others: number };

export const challanTotal = (a: ChallanAmounts) => Math.round((a.tax + a.interest + a.fee + a.others) * 100) / 100;

/**
 * One deduction to deposit: a vendor bill's TDS, or a payroll month's income tax — that one in a line for
 * each challan it is on and one for what is on none, never a line a person: what each of the staff had
 * deducted is payroll's to show.
 */
export type TdsDeduction = {
  /** "bill:<id>", or "salary:<run id>" for what of a payroll month is on no challan yet. */
  ref: string;
  kind: "BILL" | "SALARY";
  /** Its section, or null for a bill whose typed section isn't one from the list. */
  sectionKey: string | null;
  /** By the deductee's PAN; 0021 when there is none, which `headKnown` says. */
  majorHead: MajorHead;
  headKnown: boolean;
  amount: number;
  deductedOn: string;
  party: string;
  docNumber: string | null;
  challanId: string | null;
};

export type DepositGroup = {
  sectionKey: string | null;
  majorHead: MajorHead;
  deducted: number;
  deposited: number;
  left: number;
  /** The deductions on no challan yet. */
  open: TdsDeduction[];
};

const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;

/** A month's deductions by what a challan pays — section and head — with what is deposited and what is left. */
export function depositGroups(deductions: TdsDeduction[]): DepositGroup[] {
  const groups = new Map<string, DepositGroup>();
  for (const d of deductions) {
    const key = `${d.sectionKey ?? ""}|${d.majorHead}`;
    const group = groups.get(key) ?? { sectionKey: d.sectionKey, majorHead: d.majorHead, deducted: 0, deposited: 0, left: 0, open: [] };
    group.deducted = round2(group.deducted + d.amount);
    if (d.challanId) group.deposited = round2(group.deposited + d.amount);
    else {
      group.left = round2(group.left + d.amount);
      group.open.push(d);
    }
    groups.set(key, group);
  }
  // The list's order, then a section that isn't one, then salary; companies before everyone else.
  const rank = (key: string | null) => (key === SALARY_SECTION.key ? 1e4 : key === null ? 1e3 : TDS_SECTIONS.findIndex((s) => s.key === key));
  return [...groups.values()].sort((a, b) => rank(a.sectionKey) - rank(b.sectionKey) || a.majorHead.localeCompare(b.majorHead));
}
