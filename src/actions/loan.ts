"use server";

import { revalidatePath } from "next/cache";
import { plainError } from "@/lib/plain-error";
import type { LoanKind, LoanStatus } from "@prisma/client";
import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess, requireModuleUser, moduleAvailableForTenant } from "@/lib/modules-access";
import { hasEffectivePermission } from "@/actions/permission";
import { recordAudit } from "@/lib/audit";
import { notifyUser } from "@/lib/notify";
import { toPlain } from "@/lib/serialize";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay } from "@/lib/time/zone";
import { formatCurrency } from "@/lib/utils";
import { peopleHolding } from "@/lib/orders/handoff";
import { PEOPLE_ONLY } from "@/lib/people";
import { ensureChartOfAccounts, postLoanMovementToLedger } from "@/lib/ledger/journal";
import { owedLoans } from "@/lib/hr/loans";
import { refuseWhileViewingAs } from "@/lib/session";
import { instalmentFor, loanProblem, monthStart, outstandingOf } from "@/lib/hr/loan-rules";
import type { ActionResult } from "@/actions/company";
import { clip, clipOrNull, TEXT_MAX } from "@/lib/text/bounded";

/**
 * Loans and salary advances to employees (owner, 31 Oct 2026: Deskzo People as a complete HRMS — as Kredily's Loans).
 *
 * An employee asks from My HR; whoever runs payroll (`payroll.manage`) approves it — the amount, how many months and
 * from which month — or turns it down, or sets one up directly. Recorded as paid out (from the bank or cash — posted to
 * Loans & Advances to Staff where the books are kept here), it is recovered from each month's payslip by the payroll run
 * (src/actions/payroll.ts, src/lib/hr/loan-rules.ts `recoveriesFor`), paid back by hand, or — what is left when they
 * leave — in the full and final's advance recovery. Nobody decides their own.
 */

const KINDS: LoanKind[] = ["LOAN", "ADVANCE"];
const MONTH = /^\d{4}-\d{2}$/;
const DAY = /^\d{4}-\d{2}-\d{2}$/;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const money = (n: number) => new Prisma.Decimal(Math.round(n * 100) / 100);

export type LoanView = {
  id: string;
  kind: LoanKind;
  status: LoanStatus;
  amount: number;
  instalments: number;
  instalmentAmount: number;
  firstMonth: string;
  reason: string;
  decisionNote: string | null;
  decidedBy: string | null;
  disbursedOn: string | null;
  recovered: number;
  outstanding: number;
  person: { id: string; name: string };
  createdAt: Date;
};

async function views(where: Prisma.EmployeeLoanWhereInput): Promise<LoanView[]> {
  const rows = await db.employeeLoan.findMany({
    where,
    orderBy: { createdAt: "desc" },
    take: 300,
    select: {
      id: true, kind: true, status: true, amount: true, instalments: true, instalmentAmount: true, firstMonth: true, reason: true,
      decisionNote: true, disbursedOn: true, createdAt: true, userId: true,
      decidedBy: { select: { name: true } },
      user: { select: { id: true, name: true } },
    },
  });
  const owed = new Map((await owedLoans([...new Set(rows.map((r) => r.userId))])).map((l) => [l.id, l]));
  return rows.map((r) => {
    const o = owed.get(r.id);
    const amount = Number(r.amount);
    return {
      id: r.id,
      kind: r.kind,
      status: r.status,
      amount,
      instalments: r.instalments,
      instalmentAmount: Number(r.instalmentAmount),
      firstMonth: iso(r.firstMonth).slice(0, 7),
      reason: r.reason,
      decisionNote: r.decisionNote,
      decidedBy: r.decidedBy?.name ?? null,
      disbursedOn: r.disbursedOn ? iso(r.disbursedOn) : null,
      recovered: o?.recovered ?? 0,
      outstanding: r.status === "APPROVED" ? (o?.outstanding ?? amount) : 0,
      person: r.user,
      createdAt: r.createdAt,
    };
  });
}

async function payrollUser() {
  const user = await requireModuleUser("payroll");
  return { user, manage: await hasEffectivePermission(user.id, "payroll.manage") };
}

/**
 * `payrollUser` for the actions only Payroll's own pages use: Payroll open to the person as well. The actions other
 * screens use keep `payrollUser` alone (owner, 3 Nov 2026 — Phase 2 permission fixes, audit L-6).
 */
async function payrollUserIfOpen(...args: Parameters<typeof payrollUser>) {
  await requireModuleAccess("payroll");
  return payrollUser(...args);
}

/** The month after this one, as "YYYY-MM" — where a new loan's recovery starts unless somebody says otherwise. */
async function nextMonth(): Promise<string> {
  const today = (await workspaceClock()).calendarDate(new Date());
  return iso(new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth() + 1, 1))).slice(0, 7);
}

function firstMonthOf(value: string | undefined, fallback: string): Date {
  const m = value && MONTH.test(value) ? value : fallback;
  return monthStart(Number(m.slice(0, 4)), Number(m.slice(5, 7)));
}

/** My HR's card: my loans and advances, and what a new one would start from. */
export async function myLoans(): Promise<{ loans: LoanView[]; startsFrom: string }> {
  const user = await requireModuleUser("payroll");
  return toPlain({ loans: await views({ userId: user.id, status: { not: "CANCELLED" } }), startsFrom: await nextMonth() });
}

export async function requestLoan(input: { kind: string; amount: number; instalments: number; reason: string }): Promise<ActionResult<{ id: string }>> {
  const user = await requireModuleUser("payroll");
  const kind = KINDS.find((k) => k === input?.kind);
  if (!kind) return { ok: false, error: "Choose a loan or a salary advance." };
  const amount = Number(input.amount);
  const instalments = kind === "ADVANCE" ? Math.max(1, Math.min(3, Number(input.instalments) || 1)) : Number(input.instalments);
  const problem = loanProblem({ amount, instalments });
  if (problem) return { ok: false, error: problem };
  const reason = String(input.reason ?? "").trim();
  if (reason.length < 3) return { ok: false, error: "Say what it's for — a line is enough." };
  if ((await db.employeeLoan.count({ where: { userId: user.id, status: "REQUESTED" } })) > 0) return { ok: false, error: "You've already asked for one — wait for it to be decided, or withdraw it." };

  const created = await db.employeeLoan.create({
    data: { userId: user.id, kind, amount: money(amount), instalments, instalmentAmount: money(instalmentFor(amount, instalments)), firstMonth: firstMonthOf(undefined, await nextMonth()), reason },
    select: { id: true, user: { select: { name: true } } },
  });
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "EmployeeLoan", entityId: created.id, entityLabel: `${created.user.name} asked for a ${kind === "LOAN" ? "loan" : "salary advance"} of ${formatCurrency(amount)}` });
  for (const id of await peopleHolding("payroll.manage", [user.id])) {
    await notifyUser({ userId: id, type: "LOAN_REQUESTED", title: `${created.user.name} asks for a ${kind === "LOAN" ? "loan" : "salary advance"}`, message: `${formatCurrency(amount)} over ${instalments} month${instalments === 1 ? "" : "s"} — ${reason}`, link: "/people/loans" });
  }
  revalidatePath("/people/me");
  revalidatePath("/people/loans");
  return { ok: true, data: { id: created.id } };
}

/** Withdraw my own request while it waits; payroll may cancel one approved but never paid out. */
export async function cancelLoan(id: string): Promise<ActionResult<null>> {
  const { user, manage } = await payrollUser();
  const loan = await db.employeeLoan.findUnique({ where: { id: String(id ?? "") }, select: { userId: true, status: true, disbursedOn: true, user: { select: { name: true } } } });
  if (!loan) return { ok: false, error: "That loan no longer exists." };
  const mine = loan.userId === user.id && loan.status === "REQUESTED";
  const payroll = manage && loan.userId !== user.id && (loan.status === "REQUESTED" || (loan.status === "APPROVED" && !loan.disbursedOn));
  if (!mine && !payroll) return { ok: false, error: loan.disbursedOn ? "It has been paid out — record it as repaid instead." : "You can't cancel this one." };
  // Security audit, 11 Nov 2026 (SEC-31): only while it is as read — never one paid out or decided in between.
  const cancelled = await db.employeeLoan.updateMany({ where: { id, status: loan.status, disbursedOn: null }, data: { status: "CANCELLED" } });
  if (cancelled.count === 0) return { ok: false, error: "It changed a moment ago — refresh and look again." };
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "EmployeeLoan", entityId: id, entityLabel: `${loan.user.name}'s loan cancelled` });
  revalidatePath("/people/me");
  revalidatePath("/people/loans");
  return { ok: true, data: null };
}

/** People › Loans & advances: requests waiting, loans running, and the rest — for whoever runs payroll. */
export async function loansOverview(): Promise<{ waiting: LoanView[]; running: LoanView[]; done: LoanView[]; people: { id: string; name: string }[]; startsFrom: string } | null> {
  const { manage } = await payrollUserIfOpen();
  if (!manage) return null;
  const [all, people] = await Promise.all([
    views({ status: { in: ["REQUESTED", "APPROVED", "REJECTED"] } }),
    db.user.findMany({ where: { active: true, ...PEOPLE_ONLY }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
  ]);
  return toPlain({
    waiting: all.filter((l) => l.status === "REQUESTED"),
    running: all.filter((l) => l.status === "APPROVED" && l.outstanding > 0),
    done: all.filter((l) => l.status === "REJECTED" || (l.status === "APPROVED" && l.outstanding <= 0)).slice(0, 50),
    people,
    startsFrom: await nextMonth(),
  });
}

type Terms = { amount?: number; instalments?: number; firstMonth?: string };

async function terms(t: Terms, fallback: { amount: number; instalments: number }): Promise<{ amount: number; instalments: number; firstMonth: Date } | string> {
  const amount = t.amount === undefined ? fallback.amount : Number(t.amount);
  const instalments = t.instalments === undefined ? fallback.instalments : Number(t.instalments);
  const problem = loanProblem({ amount, instalments });
  if (problem) return problem;
  return { amount, instalments, firstMonth: firstMonthOf(t.firstMonth, await nextMonth()) };
}

export async function decideLoan(input: { id: string; approve: boolean; note?: string } & Terms): Promise<ActionResult<null>> {
  const { user, manage } = await payrollUserIfOpen();
  if (!manage) return { ok: false, error: "Only whoever runs payroll can decide loans." };
  // Security audit, 11 Nov 2026 (SEC-19): "your own" compared the borrowed person while viewing as somebody.
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const loan = await db.employeeLoan.findUnique({ where: { id: String(input?.id ?? "") }, select: { id: true, userId: true, status: true, kind: true, amount: true, instalments: true, user: { select: { name: true } } } });
  if (!loan) return { ok: false, error: "That request no longer exists." };
  if (loan.userId === user.id) return { ok: false, error: "Somebody else has to decide your own." };
  if (loan.status !== "REQUESTED") return { ok: false, error: "It has been decided or withdrawn already." };
  // Typed text capped before it is stored (owner, 15 Nov 2026 — input bounds).
  const note = clipOrNull(input.note, TEXT_MAX.paragraph);
  const what = loan.kind === "LOAN" ? "loan" : "salary advance";

  if (!input.approve) {
    if (!note) return { ok: false, error: "Say why — they'll see it." };
    // SEC-31: decided only while still a request — two decisions at once land once.
    const claim = await db.employeeLoan.updateMany({ where: { id: loan.id, status: "REQUESTED" }, data: { status: "REJECTED", decidedById: user.id, decidedAt: new Date(), decisionNote: note } });
    if (claim.count === 0) return { ok: false, error: "It has been decided or withdrawn a moment ago." };
    await notifyUser({ userId: loan.userId, type: "LOAN_DECIDED", title: `Your ${what} wasn't approved`, message: note, link: "/people/me" });
  } else {
    const t = await terms(input, { amount: Number(loan.amount), instalments: loan.instalments });
    if (typeof t === "string") return { ok: false, error: t };
    const claim = await db.employeeLoan.updateMany({
      where: { id: loan.id, status: "REQUESTED" },
      data: { status: "APPROVED", amount: money(t.amount), instalments: t.instalments, instalmentAmount: money(instalmentFor(t.amount, t.instalments)), firstMonth: t.firstMonth, decidedById: user.id, decidedAt: new Date(), decisionNote: note },
    });
    if (claim.count === 0) return { ok: false, error: "It has been decided or withdrawn a moment ago." };
    await notifyUser({
      userId: loan.userId,
      type: "LOAN_DECIDED",
      title: `Your ${what} is approved`,
      message: `${formatCurrency(t.amount)}, recovered from your pay at ${formatCurrency(instalmentFor(t.amount, t.instalments))} a month from ${formatCalendarDay(t.firstMonth).replace(/^\d+ /, "")}.`,
      link: "/people/me",
    });
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "EmployeeLoan", entityId: loan.id, entityLabel: `${loan.user.name}'s ${what} ${input.approve ? "approved" : "turned down"}` });
  revalidatePath("/people/loans");
  revalidatePath("/people/me");
  return { ok: true, data: null };
}

/** Payroll sets one up directly — approved as it is made. */
export async function createLoan(input: { userId: string; kind: string; reason: string } & Terms): Promise<ActionResult<{ id: string }>> {
  const { user, manage } = await payrollUserIfOpen();
  if (!manage) return { ok: false, error: "Only whoever runs payroll can set up loans." };
  // SEC-19: "your own" below has to compare the real person, not one being viewed as.
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const kind = KINDS.find((k) => k === input?.kind);
  if (!kind) return { ok: false, error: "Choose a loan or a salary advance." };
  if (input.userId === user.id) return { ok: false, error: "Somebody else has to set up your own." };
  const person = await db.user.findUnique({ where: { id: String(input.userId ?? "") }, select: { id: true, name: true, active: true } });
  if (!person?.active) return { ok: false, error: "Choose who it's for." };
  const t = await terms(input, { amount: 0, instalments: 1 });
  if (typeof t === "string") return { ok: false, error: t };
  const reason = clip(input.reason, TEXT_MAX.paragraph) || (kind === "LOAN" ? "Loan" : "Salary advance");
  const created = await db.employeeLoan.create({
    data: { userId: person.id, kind, status: "APPROVED", amount: money(t.amount), instalments: t.instalments, instalmentAmount: money(instalmentFor(t.amount, t.instalments)), firstMonth: t.firstMonth, reason, decidedById: user.id, decidedAt: new Date() },
    select: { id: true },
  });
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "EmployeeLoan", entityId: created.id, entityLabel: `${kind === "LOAN" ? "Loan" : "Salary advance"} of ${formatCurrency(t.amount)} for ${person.name}` });
  revalidatePath("/people/loans");
  return { ok: true, data: { id: created.id } };
}

/** Books a movement where the books are kept here; a failure there never loses the record — it says so. */
async function book(kind: "DISBURSAL" | "REPAYMENT", amount: number, label: string, cash: boolean, on: Date, userId: string): Promise<{ journalEntryId: string | null; warning: string | null }> {
  if (!(await moduleAvailableForTenant("accounting"))) return { journalEntryId: null, warning: null };
  try {
    await ensureChartOfAccounts();
    const entry = await db.$transaction((tx) => postLoanMovementToLedger(tx, { kind, amount, label, cash, on, userId }));
    return { journalEntryId: entry.id, warning: null };
  } catch (err) {
    return { journalEntryId: null, warning: `Saved, but not posted to the books: ${plainError(err, "the entry failed")}.` };
  }
}

/** It has been paid out to them — from then on, it is recovered from pay. */
export async function recordDisbursal(input: { id: string; on: string; cash: boolean }): Promise<ActionResult<{ warning: string | null }>> {
  const { user, manage } = await payrollUserIfOpen();
  if (!manage) return { ok: false, error: "Only whoever runs payroll can record this." };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!DAY.test(String(input?.on ?? ""))) return { ok: false, error: "Choose the day it was paid out." };
  const loan = await db.employeeLoan.findUnique({ where: { id: String(input.id ?? "") }, select: { id: true, kind: true, status: true, userId: true, amount: true, disbursedOn: true, user: { select: { name: true } } } });
  if (!loan || loan.status !== "APPROVED") return { ok: false, error: "Only an approved loan can be paid out." };
  // Security audit, 11 Nov 2026 (SEC-43): nobody records money moving on their own loan — somebody else in payroll does.
  if (loan.userId === user.id) return { ok: false, error: "Somebody else in payroll has to record your own loan." };
  if (loan.disbursedOn) return { ok: false, error: "It is already recorded as paid out." };
  const on = new Date(`${input.on}T00:00:00Z`);
  const label = `${loan.kind === "LOAN" ? "loan" : "salary advance"} to ${loan.user.name}`;
  // SEC-31: claimed before it is booked, so two presses at once pay it out — and post it — once.
  const claim = await db.employeeLoan.updateMany({ where: { id: loan.id, status: "APPROVED", disbursedOn: null }, data: { disbursedOn: on, disbursedFromCash: !!input.cash } });
  if (claim.count === 0) return { ok: false, error: "It is already recorded as paid out." };
  const booked = await book("DISBURSAL", Number(loan.amount), label, !!input.cash, on, user.id);
  if (booked.journalEntryId) await db.employeeLoan.update({ where: { id: loan.id }, data: { journalEntryId: booked.journalEntryId } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "EmployeeLoan", entityId: loan.id, entityLabel: `Paid out: ${label}, ${formatCurrency(Number(loan.amount))}` });
  revalidatePath("/people/loans");
  return { ok: true, data: { warning: booked.warning } };
}

/** Paid back by hand — cash or a transfer — rather than from pay. */
export async function recordRepayment(input: { id: string; amount: number; on: string; cash: boolean; note?: string }): Promise<ActionResult<{ warning: string | null }>> {
  const { user, manage } = await payrollUserIfOpen();
  if (!manage) return { ok: false, error: "Only whoever runs payroll can record this." };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!DAY.test(String(input?.on ?? ""))) return { ok: false, error: "Choose the day it was paid back." };
  const loan = await db.employeeLoan.findUnique({ where: { id: String(input.id ?? "") }, select: { id: true, kind: true, status: true, userId: true, disbursedOn: true, user: { select: { name: true } } } });
  if (!loan || loan.status !== "APPROVED" || !loan.disbursedOn) return { ok: false, error: "Only a loan that has been paid out can be repaid." };
  // Security audit, 11 Nov 2026 (SEC-43): nobody records money moving on their own loan — somebody else in payroll does.
  if (loan.userId === user.id) return { ok: false, error: "Somebody else in payroll has to record your own loan." };
  const amount = Math.round(Number(input.amount) * 100) / 100;
  if (!(amount > 0)) return { ok: false, error: "Enter the amount paid back." };
  const on = new Date(`${input.on}T00:00:00Z`);
  const label = `${loan.kind === "LOAN" ? "loan" : "salary advance"} of ${loan.user.name}`;
  // SEC-31: what is owed is read and the repayment written under one lock per loan — two at once each saw the whole
  // balance owed and both went in.
  const recorded = await db.$transaction(async (tx) => {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`deskzo:loan-repay:${loan.id}`}))`;
    const owedNow = (await owedLoans([loan.userId], { client: tx })).find((l) => l.id === loan.id)?.outstanding ?? 0;
    if (amount > owedNow) return { ok: false as const, owed: owedNow };
    await tx.loanRepayment.create({ data: { loanId: loan.id, amount: money(amount), on, note: String(input.note ?? "").trim() || null } });
    return { ok: true as const, owed: owedNow };
  });
  if (!recorded.ok) return { ok: false, error: `Only ${formatCurrency(recorded.owed)} is still owed.` };
  const owed = recorded.owed;
  const booked = await book("REPAYMENT", amount, label, !!input.cash, on, user.id);
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "EmployeeLoan", entityId: loan.id, entityLabel: `Repaid ${formatCurrency(amount)} of the ${label}; ${formatCurrency(outstandingOf(owed, amount))} left` });
  revalidatePath("/people/loans");
  revalidatePath("/people/me");
  return { ok: true, data: { warning: booked.warning } };
}
