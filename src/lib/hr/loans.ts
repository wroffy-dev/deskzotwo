import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { outstandingOf } from "@/lib/hr/loan-rules";

/**
 * What is still owed on employees' loans and advances (owner, 31 Oct 2026). Not a "use server" file: the payroll run,
 * the settlement and src/actions/loan.ts ask it.
 *
 * Owed is the amount less every recovery recorded against it — from payslips and by hand — and less what a full and
 * final that is approved or paid recovered for the person (its advance recovery, set against their loans oldest first).
 * `exceptRun` leaves a payroll run's own recoveries out, for that run to work them out afresh.
 */
export type OwedLoan = { id: string; userId: string; kind: "LOAN" | "ADVANCE"; amount: number; recovered: number; outstanding: number; instalmentAmount: number; firstMonth: Date; disbursed: boolean };

export async function owedLoans(userIds: string[], opts: { exceptRun?: string; client?: Prisma.TransactionClient } = {}): Promise<OwedLoan[]> {
  if (userIds.length === 0) return [];
  // `client`: read inside the caller's transaction, under its lock (src/actions/loan.ts recordRepayment, SEC-31).
  const c = opts.client ?? db;
  const loans = await c.employeeLoan
    .findMany({
      where: { userId: { in: userIds }, status: "APPROVED" },
      orderBy: { firstMonth: "asc" },
      select: {
        id: true,
        userId: true,
        kind: true,
        amount: true,
        instalmentAmount: true,
        firstMonth: true,
        disbursedOn: true,
        repayments: { where: opts.exceptRun ? { OR: [{ payslipId: null }, { payslip: { runId: { not: opts.exceptRun } } }] } : {}, select: { amount: true } },
      },
    })
    .catch((err) => {
      // A workspace not migrated yet has no loans.
      if (notMigratedYet(err)) return [];
      throw err;
    });
  if (loans.length === 0) return [];

  // A full and final that recovered advances, set against what they still owe, oldest first.
  const settled = new Map(
    (
      await c.finalSettlement.findMany({
        where: { userId: { in: [...new Set(loans.map((l) => l.userId))] }, status: { in: ["APPROVED", "PAID"] } },
        select: { userId: true, advanceRecovery: true },
      })
    ).map((s) => [s.userId, Number(s.advanceRecovery)]),
  );

  return loans.map((l) => {
    const recoveredHere = l.repayments.reduce((t, r) => t + Number(r.amount), 0);
    const before = outstandingOf(Number(l.amount), recoveredHere);
    const fromSettlement = Math.min(before, settled.get(l.userId) ?? 0);
    if (fromSettlement > 0) settled.set(l.userId, (settled.get(l.userId) ?? 0) - fromSettlement);
    const recovered = Math.round((recoveredHere + fromSettlement) * 100) / 100;
    return {
      id: l.id,
      userId: l.userId,
      kind: l.kind,
      amount: Number(l.amount),
      recovered,
      outstanding: outstandingOf(Number(l.amount), recovered),
      instalmentAmount: Number(l.instalmentAmount),
      firstMonth: l.firstMonth,
      disbursed: !!l.disbursedOn,
    };
  });
}

/** What one person still owes in all — for the full and final's advance recovery. */
export async function owedBy(userId: string): Promise<number> {
  const loans = await owedLoans([userId]);
  return Math.round(loans.reduce((t, l) => t + (l.disbursed ? l.outstanding : 0), 0) * 100) / 100;
}
