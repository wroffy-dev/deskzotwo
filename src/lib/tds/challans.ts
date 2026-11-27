import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { RAISED_IN_DESKZO } from "@/lib/documents/imported";
import { SYSTEM_ACCOUNTS } from "@/lib/ledger/chart";
import { resolveAccounts, resolveMoneyAccount, reversedLines, reversibleLineSelect, writeEntry } from "@/lib/ledger/journal";
import { indiaClock } from "@/lib/time/zone";
import { sectionOf } from "./sections";
import {
  bsrCodeOf,
  challanCin,
  challanSectionLabel,
  challanSectionNumber,
  challanSerialOf,
  challanTotal,
  depositDueOn,
  depositGroups,
  isChallanSection,
  isMajorHead,
  isMinorHead,
  majorHeadFor,
  SALARY_SECTION,
  type TdsDeduction,
} from "./challan-rules";

/**
 * TDS deposits in the books (owner, 25 Oct 2026; the rules are challan-rules.ts): a month's deductions —
 * vendors' bills and payroll's income tax — the challans that paid them, and recording one. A challan is
 * posted as it's recorded (Dr TDS Payable, Dr Interest & Fees on Taxes, Cr the bank it was paid from) and
 * reversed if it's deleted; the deductions it paid are linked to it, one challan each, for the quarter's
 * statement to quote.
 */

type Tx = Prisma.TransactionClient;

/** A refusal to say to the person recording, as it is. */
export class ChallanRefusal extends Error {}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const asDate = (key: string) => new Date(`${key}T00:00:00Z`);
const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const round2 = (n: number) => Math.round((n + Number.EPSILON) * 100) / 100;
const rupees = (n: number) => `₹${n.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`;
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/** `yyyy-mm` read as a month, or null. */
export function readMonth(value: string | null | undefined): { year: number; month: number; key: string } | null {
  const m = /^(\d{4})-(\d{2})$/.exec(String(value ?? ""));
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  return month >= 1 && month <= 12 ? { year, month, key: `${m[1]}-${m[2]}` } : null;
}

/**
 * A month's deductions: every vendor bill's TDS dated in it (India's month, as the TDS page's), and the
 * income tax on its payroll once the run is locked — one line for what of it is on each challan, one for
 * what is on none.
 */
export async function monthDeductions(monthKey: string): Promise<TdsDeduction[]> {
  const month = readMonth(monthKey);
  if (!month) return [];
  const from = indiaClock.midnight(month.year, month.month - 1, 1);
  const before = indiaClock.midnight(month.year, month.month, 1);
  const [bills, runs] = await Promise.all([
    db.tradeDocument.findMany({
      where: { docType: "BILL", status: { notIn: ["DRAFT", "CANCELLED"] }, withholdingAmount: { lt: 0 }, issueDate: { gte: from, lt: before }, ...RAISED_IN_DESKZO },
      select: { id: true, docNumber: true, issueDate: true, withholdingAmount: true, withholdingSection: true, company: { select: { name: true, panNumber: true } }, tdsChallanLink: { select: { challanId: true } } },
      orderBy: [{ issueDate: "asc" }, { docNumber: "asc" }],
    }),
    db.payrollRun.findMany({
      where: { month: month.month, year: month.year, status: { in: ["LOCKED", "PAID"] } },
      select: { id: true, payslips: { where: { incomeTax: { gt: 0 } }, select: { incomeTax: true, tdsChallanLink: { select: { challanId: true } } } } },
    }),
  ]);

  const out: TdsDeduction[] = bills.map((b) => {
    const head = majorHeadFor(b.company.panNumber);
    return {
      ref: `bill:${b.id}`,
      kind: "BILL",
      sectionKey: sectionOf(b.withholdingSection)?.key ?? null,
      majorHead: head ?? "0021",
      headKnown: head !== null,
      amount: round2(-Number(b.withholdingAmount)),
      deductedOn: indiaClock.dateKey(b.issueDate),
      party: b.company.name,
      docNumber: b.docNumber,
      challanId: b.tdsChallanLink?.challanId ?? null,
    };
  });

  // Payroll is dated the month's last day (src/lib/ledger/journal.ts), and so is its tax.
  const lastDay = dayOf(new Date(Date.UTC(month.year, month.month, 0)));
  for (const run of runs) {
    const byChallan = new Map<string | null, { amount: number; people: number }>();
    for (const p of run.payslips) {
      const key = p.tdsChallanLink?.challanId ?? null;
      const sum = byChallan.get(key) ?? { amount: 0, people: 0 };
      byChallan.set(key, { amount: round2(sum.amount + Number(p.incomeTax)), people: sum.people + 1 });
    }
    for (const [challanId, sum] of byChallan) {
      out.push({
        ref: challanId ? `salary:${run.id}:${challanId}` : `salary:${run.id}`,
        kind: "SALARY",
        sectionKey: SALARY_SECTION.key,
        majorHead: "0021",
        headKnown: true,
        amount: sum.amount,
        deductedOn: lastDay,
        party: `Salaries for ${MONTHS[month.month - 1]} ${month.year} — ${sum.people} ${sum.people === 1 ? "person" : "people"}`,
        docNumber: null,
        challanId,
      });
    }
  }
  return out;
}

export type ChallanRow = {
  id: string;
  sectionKey: string;
  sectionLabel: string;
  majorHead: string;
  minorHead: string;
  periodMonth: string;
  paidOn: string;
  bsrCode: string;
  challanSerial: string;
  cin: string;
  crn: string | null;
  tax: number;
  interest: number;
  fee: number;
  others: number;
  total: number;
  /** What of its tax the deductions linked to it account for. */
  linked: number;
  bankName: string | null;
  note: string | null;
};

const challanSelect = {
  id: true, sectionKey: true, majorHead: true, minorHead: true, periodMonth: true, paidOn: true, bsrCode: true, challanSerial: true, crn: true,
  tax: true, interest: true, fee: true, others: true, note: true, bankAccount: { select: { name: true } }, links: { select: { amount: true } },
} satisfies Prisma.TdsChallanSelect;

function challanRow(c: Prisma.TdsChallanGetPayload<{ select: typeof challanSelect }>): ChallanRow {
  const amounts = { tax: Number(c.tax), interest: Number(c.interest), fee: Number(c.fee), others: Number(c.others) };
  const paidOn = dayOf(c.paidOn);
  return {
    id: c.id,
    sectionKey: c.sectionKey,
    sectionLabel: challanSectionLabel(c.sectionKey),
    majorHead: c.majorHead,
    minorHead: c.minorHead,
    periodMonth: dayOf(c.periodMonth).slice(0, 7),
    paidOn,
    bsrCode: c.bsrCode,
    challanSerial: c.challanSerial,
    cin: challanCin({ bsrCode: c.bsrCode, paidOn, challanSerial: c.challanSerial }),
    crn: c.crn,
    ...amounts,
    total: challanTotal(amounts),
    linked: round2(c.links.reduce((t, l) => t + Number(l.amount), 0)),
    bankName: c.bankAccount?.name ?? null,
    note: c.note,
  };
}

/**
 * The TDS page's deposits for a month: what was deducted by section and head, what challans paid, what is
 * left and by when, and the month's challans. Null on a workspace whose database hasn't the tables yet.
 */
export async function tdsDeposits(monthKey: string) {
  const month = readMonth(monthKey);
  if (!month) return null;
  try {
    const deductions = await monthDeductions(month.key);
    const onChallans = [...new Set(deductions.map((d) => d.challanId).filter((id): id is string => !!id))];
    const [challans, banks] = await Promise.all([
      db.tdsChallan.findMany({
        where: { OR: [{ periodMonth: asDate(`${month.key}-01`) }, { id: { in: onChallans } }] },
        orderBy: [{ paidOn: "asc" }, { createdAt: "asc" }],
        select: challanSelect,
      }),
      db.bankAccount.findMany({ where: { active: true }, orderBy: [{ isDefault: "desc" }, { name: "asc" }], select: { id: true, name: true } }),
    ]);
    const groups = depositGroups(deductions);
    const linked: Record<string, TdsDeduction[]> = {};
    for (const d of deductions) if (d.challanId) (linked[d.challanId] ??= []).push(d);
    return {
      month: month.key,
      dueOn: depositDueOn(`${month.key}-01`),
      groups,
      left: round2(groups.reduce((t, g) => t + g.left, 0)),
      deducted: round2(groups.reduce((t, g) => t + g.deducted, 0)),
      challans: challans.map(challanRow),
      /** The month's deductions on each challan. */
      linked,
      bankAccounts: banks,
    };
  } catch {
    return null;
  }
}

export type ChallanInput = {
  /** The month whose deductions it pays, `yyyy-mm`. */
  month: string;
  sectionKey: string;
  majorHead: string;
  minorHead?: string | null;
  paidOn: string;
  bsrCode: string;
  challanSerial: string;
  crn?: string | null;
  tax: number | string;
  interest?: number | string | null;
  fee?: number | string | null;
  others?: number | string | null;
  bankAccountId?: string | null;
  note?: string | null;
  /** The deductions it paid (TdsDeduction.ref). */
  refs?: string[];
};

function amountOf(value: number | string | null | undefined, label: string): number {
  const text = String(value ?? "").replace(/[,\s₹]/g, "");
  if (text === "") return 0;
  const n = Number(text);
  if (!Number.isFinite(n) || n < 0) throw new ChallanRefusal(`${label} is an amount in rupees, 0 or more.`);
  return round2(n);
}

/** Records a challan, links the deductions it paid and posts it — all or nothing. */
export async function recordChallan(input: ChallanInput, userId: string, today = indiaClock.today()): Promise<{ id: string; cin: string }> {
  const month = readMonth(input.month);
  if (!month) throw new ChallanRefusal("Choose the month whose TDS it pays.");
  if (!isChallanSection(input.sectionKey)) throw new ChallanRefusal("Choose the section it pays — the challan's nature of payment.");
  if (!isMajorHead(input.majorHead)) throw new ChallanRefusal("Choose the major head: 0020 for deductees that are companies, 0021 for the rest.");
  if (input.sectionKey === SALARY_SECTION.key && input.majorHead !== "0021") throw new ChallanRefusal("Salary's TDS is paid under 0021 — employees aren't companies.");
  const minorHead = input.minorHead || "200";
  if (!isMinorHead(minorHead)) throw new ChallanRefusal("The minor head is 200, or 400 for a demand the department raised.");
  const paidOn = String(input.paidOn ?? "");
  if (!DAY.test(paidOn)) throw new ChallanRefusal("Give the day it was paid, as on the counterfoil.");
  if (paidOn > today) throw new ChallanRefusal("It's dated after today — record a challan once it's paid.");
  if (paidOn < `${month.key}-01`) throw new ChallanRefusal("It's dated before the month it pays began.");
  const bsrCode = bsrCodeOf(input.bsrCode);
  if (!bsrCode) throw new ChallanRefusal("The BSR code is the bank branch's seven digits, as on the counterfoil.");
  const challanSerial = challanSerialOf(input.challanSerial);
  if (!challanSerial) throw new ChallanRefusal("The challan serial number is up to five digits, as on the counterfoil.");
  const crn = String(input.crn ?? "").replace(/\s/g, "").toUpperCase() || null;
  if (crn && !/^[A-Z0-9]{6,20}$/.test(crn)) throw new ChallanRefusal("The CRN is the e-Pay Tax challan reference number, letters and digits only — or leave it blank.");
  const amounts = { tax: amountOf(input.tax, "The tax"), interest: amountOf(input.interest, "Interest"), fee: amountOf(input.fee, "The fee"), others: amountOf(input.others, "Others") };
  if (challanTotal(amounts) <= 0) throw new ChallanRefusal("The challan's amounts come to nothing.");
  // A challan is paid in whole rupees, and the quarter's statement refuses paise on one (Form 140, CD fields 8-12).
  if (Object.values(amounts).some((n) => !Number.isInteger(n))) throw new ChallanRefusal("A challan is paid in whole rupees — give its amounts without paise, as on the counterfoil.");
  if (minorHead === "200" && amounts.tax <= 0) throw new ChallanRefusal("A challan under 200 pays tax — give the tax it paid.");
  const bankAccountId = input.bankAccountId || null;
  if (bankAccountId && !(await db.bankAccount.findUnique({ where: { id: bankAccountId }, select: { id: true } }))) throw new ChallanRefusal("Choose the bank account it was paid from.");

  try {
    return await db.$transaction(async (tx) => {
      const challan = await tx.tdsChallan.create({
        data: {
          sectionKey: input.sectionKey,
          majorHead: input.majorHead,
          minorHead,
          periodMonth: asDate(`${month.key}-01`),
          paidOn: asDate(paidOn),
          bsrCode,
          challanSerial,
          crn,
          ...amounts,
          bankAccountId,
          note: String(input.note ?? "").trim().slice(0, 500) || null,
          createdById: userId,
        },
        select: { id: true, sectionKey: true, majorHead: true, tax: true },
      });
      await linkRefs(tx, challan, input.refs ?? []);
      await postChallan(tx, challan.id, userId);
      return { id: challan.id, cin: challanCin({ bsrCode, paidOn, challanSerial }) };
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const target = String((err.meta as { target?: unknown } | undefined)?.target ?? "");
      throw new ChallanRefusal(
        /document|payslip/.test(target)
          ? "One of those deductions was linked to another challan just now — reload and choose again."
          : `A challan with BSR code ${bsrCode}, dated ${paidOn}, serial ${challanSerial} is already recorded.`,
      );
    }
    throw err;
  }
}

/**
 * Links deductions to a challan: each must be on no challan yet, of the challan's section (a bill whose typed
 * section isn't one from the list may go on any vendor section's), of its head where the deductee's PAN
 * says, and together no more than its tax.
 */
async function linkRefs(tx: Tx, challan: { id: string; sectionKey: string; majorHead: string; tax: Prisma.Decimal | number }, refs: string[]) {
  const links: { documentId?: string; payslipId?: string; amount: number }[] = [];
  const isSalary = challan.sectionKey === SALARY_SECTION.key;
  for (const ref of [...new Set(refs.map(String))]) {
    const [kind, id] = ref.split(":");
    if (kind === "bill" && id) {
      const bill = await tx.tradeDocument.findUnique({
        where: { id },
        select: { docNumber: true, docType: true, status: true, withholdingAmount: true, withholdingSection: true, company: { select: { panNumber: true } }, tdsChallanLink: { select: { id: true } } },
      });
      if (!bill || bill.docType !== "BILL" || bill.status === "DRAFT" || bill.status === "CANCELLED" || Number(bill.withholdingAmount) >= 0) {
        throw new ChallanRefusal("One of those isn't a bill with TDS deducted any more — reload and choose again.");
      }
      if (bill.tdsChallanLink) throw new ChallanRefusal(`${bill.docNumber}'s TDS is on another challan already.`);
      if (isSalary) throw new ChallanRefusal(`${bill.docNumber} is a vendor's bill; this challan pays salary's TDS.`);
      const section = sectionOf(bill.withholdingSection);
      if (section && section.key !== challan.sectionKey) {
        throw new ChallanRefusal(`${bill.docNumber} was deducted under ${section.oldSection}; this challan pays ${challanSectionNumber(challan.sectionKey)}.`);
      }
      const head = majorHeadFor(bill.company.panNumber);
      if (head && head !== challan.majorHead) {
        throw new ChallanRefusal(`${bill.docNumber}'s vendor ${head === "0020" ? "is a company" : "isn't a company"}, so its TDS goes under ${head}, not ${challan.majorHead}.`);
      }
      links.push({ documentId: id, amount: round2(-Number(bill.withholdingAmount)) });
    } else if (kind === "salary" && id) {
      if (!isSalary) throw new ChallanRefusal("Salary's TDS goes on a challan for salary (192).");
      const run = await tx.payrollRun.findUnique({
        where: { id },
        select: { status: true, payslips: { where: { incomeTax: { gt: 0 }, tdsChallanLink: { is: null } }, select: { id: true, incomeTax: true } } },
      });
      if (!run || run.status === "DRAFT") throw new ChallanRefusal("That payroll isn't locked — lock it before depositing its TDS.");
      if (run.payslips.length === 0) throw new ChallanRefusal("That payroll's income tax is all on challans already.");
      for (const p of run.payslips) links.push({ payslipId: p.id, amount: round2(Number(p.incomeTax)) });
    } else {
      throw new ChallanRefusal("One of those deductions isn't one this page knows — reload and choose again.");
    }
  }
  if (links.length === 0) return;
  const already = await tx.tdsChallanLink.aggregate({ where: { challanId: challan.id }, _sum: { amount: true } });
  const total = round2(Number(already._sum.amount ?? 0) + links.reduce((t, l) => t + l.amount, 0));
  if (total > Number(challan.tax) + 0.005) {
    throw new ChallanRefusal(`Those deductions come to ${rupees(total)}, more than the challan's tax of ${rupees(Number(challan.tax))}.`);
  }
  await tx.tdsChallanLink.createMany({ data: links.map((l) => ({ challanId: challan.id, documentId: l.documentId ?? null, payslipId: l.payslipId ?? null, amount: l.amount })) });
}

/** The challan's entry: Dr TDS Payable the tax, Dr Interest & Fees on Taxes the rest, Cr the bank. Once only. */
async function postChallan(tx: Tx, challanId: string, userId: string) {
  const c = await tx.tdsChallan.findUniqueOrThrow({ where: { id: challanId }, select: { sectionKey: true, majorHead: true, paidOn: true, bsrCode: true, challanSerial: true, tax: true, interest: true, fee: true, others: true, bankAccountId: true } });
  const accounts = await resolveAccounts(tx, [SYSTEM_ACCOUNTS.TDS_PAYABLE, SYSTEM_ACCOUNTS.TAX_INTEREST]);
  const money = await resolveMoneyAccount(tx, { method: "BANK_TRANSFER", bankAccountId: c.bankAccountId, clearedOn: c.paidOn, direction: "PAID" });
  const amounts = { tax: Number(c.tax), interest: Number(c.interest), fee: Number(c.fee), others: Number(c.others) };
  const extra = round2(amounts.interest + amounts.fee + amounts.others);
  const cin = challanCin({ bsrCode: c.bsrCode, paidOn: dayOf(c.paidOn), challanSerial: c.challanSerial });
  const lines = [
    { accountId: accounts.get(SYSTEM_ACCOUNTS.TDS_PAYABLE)!, debit: amounts.tax, credit: 0, narration: "TDS deposited" },
    { accountId: accounts.get(SYSTEM_ACCOUNTS.TAX_INTEREST)!, debit: extra, credit: 0, narration: "Interest and fees on the deposit" },
    { accountId: money.accountId, debit: 0, credit: challanTotal(amounts), narration: `Challan ${cin}` },
  ].filter((l) => l.debit !== 0 || l.credit !== 0);
  return writeEntry(tx, {
    date: c.paidOn,
    narration: `TDS deposited — ${challanSectionNumber(c.sectionKey)}, ${c.majorHead}, challan ${cin}`,
    source: "PAYMENT",
    userId,
    lines,
    postingKey: `tdschallan:${challanId}`,
  });
}

/** Links more deductions to a challan recorded already. */
export async function linkDeductions(challanId: string, refs: string[]) {
  try {
    await db.$transaction(async (tx) => {
      const challan = await tx.tdsChallan.findUnique({ where: { id: challanId }, select: { id: true, sectionKey: true, majorHead: true, tax: true } });
      if (!challan) throw new ChallanRefusal("That challan isn't there.");
      await linkRefs(tx, challan, refs);
    });
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") throw new ChallanRefusal("One of those deductions was linked to another challan just now — reload and choose again.");
    throw err;
  }
}

/** Takes a deduction off its challan: a bill's, or what of a payroll month is on it. */
export async function unlinkDeduction(challanId: string, ref: string) {
  const [kind, id] = String(ref ?? "").split(":");
  if (kind === "bill" && id) return (await db.tdsChallanLink.deleteMany({ where: { challanId, documentId: id } })).count;
  if (kind === "salary" && id) return (await db.tdsChallanLink.deleteMany({ where: { challanId, payslip: { runId: id } } })).count;
  return 0;
}

/** Deletes a challan recorded by mistake: its entry reversed today, its deductions free for another. */
export async function deleteChallan(challanId: string, userId: string): Promise<{ cin: string }> {
  return db.$transaction(async (tx) => {
    const c = await tx.tdsChallan.findUnique({ where: { id: challanId }, select: { bsrCode: true, paidOn: true, challanSerial: true } });
    if (!c) throw new ChallanRefusal("That challan isn't there.");
    const cin = challanCin({ bsrCode: c.bsrCode, paidOn: dayOf(c.paidOn), challanSerial: c.challanSerial });
    const entry = await tx.journalEntry.findUnique({
      where: { postingKey: `tdschallan:${challanId}` },
      select: { id: true, entryNumber: true, reversedBy: { select: { id: true } }, lines: { orderBy: { sortOrder: "asc" }, select: reversibleLineSelect } },
    });
    if (entry && !entry.reversedBy) {
      await writeEntry(tx, {
        date: new Date(),
        narration: `Reversal of ${entry.entryNumber} — TDS challan ${cin} deleted`,
        source: "MANUAL",
        userId,
        lines: reversedLines(entry.lines),
        reversesId: entry.id,
        postingKey: `tdschallan:${challanId}:reversal`,
      });
    }
    await tx.tdsChallan.delete({ where: { id: challanId } });
    return { cin };
  });
}
