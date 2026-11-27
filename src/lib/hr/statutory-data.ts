import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { pfWageCeilingOn } from "@/lib/hr/payroll";
import { buildBank, buildEcr, buildEsi, type StatutoryRow } from "@/lib/hr/statutory-files";

/**
 * A payroll month's statutory and bank files, from its payslips as they were locked (src/lib/hr/statutory-files.ts
 * builds them). The caller decides who may see them; src/actions/statutory-files.ts does.
 */
export async function statutoryFilesOfRun(runId: string) {
  const run = await db.payrollRun.findUnique({ where: { id: runId }, select: { id: true, year: true, month: true, status: true } });
  if (!run) return null;
  const monthEnd = new Date(Date.UTC(run.year, run.month, 0));
  // Named one by one: the PF split and the bank copy are in NOT_YET_EVERYWHERE (src/lib/tenancy/clients.ts).
  const select = {
    userId: true,
    monthDays: true,
    paidDays: true,
    lopDays: true,
    grossEarnings: true,
    pfEmployee: true,
    pfEmployer: true,
    pfWages: true,
    epsWages: true,
    epsEmployer: true,
    esiEmployee: true,
    esiEmployer: true,
    netPay: true,
    user: {
      select: {
        name: true,
        employeeProfile: {
          select: { employeeCode: true, uanNumber: true, esicNumber: true, dateOfBirth: true, exitedOn: true, bankName: true, bankAccountNumber: true, bankIfsc: true },
        },
        // Whether PF was on for them that month: the structure in force at its end, as the run read it (R3-14).
        salaryStructures: { where: { effectiveFrom: { lte: monthEnd } }, orderBy: { effectiveFrom: "desc" as const }, take: 1, select: { pfApplicable: true } },
      },
    },
  } as const;
  // Security audit round three, 14 Nov 2026 (R3-11): the account copied onto the payslip when the run was locked —
  // what the bank file pays. The record is read only for payslips locked before the copy existed, or in a workspace
  // whose database doesn't have it yet.
  const slips = await db.payslip.findMany({ where: { runId }, orderBy: { user: { name: "asc" } }, select });
  const copies = new Map<string, { bankAccountNumber: string | null; bankIfsc: string | null; bankName: string | null; bankHolderName: string | null }>();
  try {
    const copied = await db.payslip.findMany({ where: { runId }, select: { userId: true, bankAccountNumber: true, bankIfsc: true, bankName: true, bankHolderName: true } });
    for (const { userId, ...copy } of copied) copies.set(userId, copy);
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  const n = (v: unknown) => Number(v ?? 0);
  const rows: StatutoryRow[] = slips.map((s) => {
    const p = s.user.employeeProfile;
    // A payslip with a copy pays the copy — every field of it, even one left empty — never half the record.
    const copy = copies.get(s.userId);
    const copied = !!(copy && (copy.bankAccountNumber || copy.bankIfsc || copy.bankHolderName));
    return {
      name: s.user.name ?? "",
      employeeCode: p?.employeeCode ?? null,
      uan: p?.uanNumber ?? null,
      esicNumber: p?.esicNumber ?? null,
      dateOfBirth: p?.dateOfBirth ?? null,
      exitedOn: p?.exitedOn ?? null,
      monthDays: n(s.monthDays),
      paidDays: n(s.paidDays),
      lopDays: n(s.lopDays),
      grossEarnings: n(s.grossEarnings),
      pfEmployee: n(s.pfEmployee),
      pfEmployer: n(s.pfEmployer),
      pfWages: n(s.pfWages),
      epsWages: n(s.epsWages),
      epsEmployer: n(s.epsEmployer),
      esiEmployee: n(s.esiEmployee),
      esiEmployer: n(s.esiEmployer),
      netPay: n(s.netPay),
      bankAccountNumber: copied ? (copy?.bankAccountNumber ?? null) : (p?.bankAccountNumber ?? null),
      bankIfsc: copied ? (copy?.bankIfsc ?? null) : (p?.bankIfsc ?? null),
      bankName: copied ? (copy?.bankName ?? null) : (p?.bankName ?? null),
      bankHolderName: copied ? (copy?.bankHolderName ?? null) : null,
      pfApplicable: s.user.salaryStructures[0]?.pfApplicable ?? false,
    };
  });
  const month = { year: run.year, month: run.month };
  const ceiling = pfWageCeilingOn(run.year, run.month, 1);
  return { run, ecr: buildEcr(rows, month, ceiling), esi: buildEsi(rows, month), bank: buildBank(rows) };
}

export type StatutoryFiles = NonNullable<Awaited<ReturnType<typeof statutoryFilesOfRun>>>;
