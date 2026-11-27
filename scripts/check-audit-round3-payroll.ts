/**
 * check:audit-round3-payroll — the security audit's round three (docs/reports/security-audit-2026-11-11.md §12), group P:
 * payroll and HR, each fix shown to hold the way it was broken — by calling the server's own actions, as a hand-made
 * request would.
 *
 *   R3-03  recalculating a draft run keeps its approved incentives on the new payslips
 *   R3-04  a paid run never leaves PAID; reopening reverses the wage entry, locking again posts it once
 *   R3-11  the salary bank file pays the account copied at lock; bank edits are refused while a run is locked, and
 *          told to the employee and payroll when made
 *   R3-12  nobody in payroll sets their own income tax declaration; previous TDS needs a note
 *   R3-13  a line manager reads a letter without its pay; pay is frozen only by somebody who runs payroll
 *   R3-14  settlement overrides can't be negative; the preparer can't approve; PF fixed below the law needs a reason;
 *          PF on with nothing contributed is an ECR problem
 *   lows   a negative net is refused and listed in the bank file; leave in a locked month isn't approved; HR can't type
 *          their own opening leave balance; ESI coverage holds for the contribution period
 *
 * A fixture of its own, ZZR3P (users @zzr3p-audit.invalid, leave type ZZR3P, payroll runs in November and December
 * 2001), removed in a finally. Assertions are about the fixture's own rows: the local database is full.
 *
 *   npx tsx scripts/check-audit-round3-payroll.ts
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

const VIEW_AS_REFUSAL = "ZZR3P: refused while viewing as somebody";
let actor: { id: string; name: string; email: string; role: string } | null = null;
let viewingAs = false;
const told: { userId: string; title: string; message?: string }[] = [];
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = async () => {
      if (!actor) throw new Error("Unauthorized");
      return actor;
    };
    return {
      requireUser: user,
      currentUser: async () => actor,
      viewAsContext: async () => (viewingAs && actor ? { user: actor, admin: { id: "zzr3p-admin", name: "ZZR3P Admin" } } : null),
      refuseWhileViewingAs: async () => (viewingAs ? VIEW_AS_REFUSAL : null),
    };
  }
  if (request === "@/lib/notify") return { notifyUser: async (n: { userId: string; title: string; message?: string }) => void told.push(n) };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZR3P";
const MAIL = "@zzr3p-audit.invalid";
const NOV = { month: 11, year: 2001 };
const DEC = { month: 12, year: 2001 };
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const num = (v: unknown) => Number(v ?? 0);
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "" : (r.error ?? ""));
let madeRuns = false;

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  if (madeRuns) {
    const runs = await db.payrollRun.findMany({ where: { OR: [NOV, DEC] }, select: { id: true } });
    const runIds = runs.map((r) => r.id);
    // Anybody else's earning a fixture run happened to pay goes back to approved before its payslip goes.
    await db.incentiveEarning.updateMany({ where: { payslip: { runId: { in: runIds } }, userId: { notIn: ids } }, data: { status: "APPROVED", paidAt: null, payslipId: null } });
    await db.journalEntry.deleteMany({ where: { payrollRunId: { in: runIds }, reversesId: { not: null } } });
    await db.journalEntry.deleteMany({ where: { payrollRunId: { in: runIds } } });
    await db.payslip.deleteMany({ where: { runId: { in: runIds } } });
    await db.payrollRun.deleteMany({ where: { id: { in: runIds } } });
  }
  await db.incentiveEarning.deleteMany({ where: { userId: { in: ids } } });
  await db.employeeDocument.deleteMany({ where: { userId: { in: ids } } });
  await db.employeeLetter.deleteMany({ where: { userId: { in: ids } } });
  await db.leaveRequest.deleteMany({ where: { userId: { in: ids } } });
  await db.leaveBalance.deleteMany({ where: { userId: { in: ids } } });
  await db.leaveType.deleteMany({ where: { code: TAG } });
  await db.attendanceDay.deleteMany({ where: { userId: { in: ids } } });
  await db.finalSettlement.deleteMany({ where: { userId: { in: ids } } });
  await db.taxDeclaration.deleteMany({ where: { userId: { in: ids } } });
  await db.salaryStructure.deleteMany({ where: { userId: { in: ids } } });
  await db.approvalEvent.deleteMany({ where: { OR: [{ decidedById: { in: ids } }, { requestedById: { in: ids } }] } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.notification.deleteMany({ where: { userId: { in: ids } } });
  await db.employeeProfile.deleteMany({ where: { userId: { in: ids } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.user.updateMany({ where: { id: { in: ids } }, data: { managerId: null } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const payroll = require("../src/actions/payroll") as typeof import("../src/actions/payroll");
  const settlement = require("../src/actions/settlement") as typeof import("../src/actions/settlement");
  const hr = require("../src/actions/hr") as typeof import("../src/actions/hr");
  const docs = require("../src/actions/employee-docs") as typeof import("../src/actions/employee-docs");
  const leave = require("../src/actions/leave") as typeof import("../src/actions/leave");
  const openings = require("../src/actions/leave-openings") as typeof import("../src/actions/leave-openings");
  const { isModuleEnabled } = require("../src/actions/module") as typeof import("../src/actions/module");
  const { statutoryFilesOfRun } = require("../src/lib/hr/statutory-data") as typeof import("../src/lib/hr/statutory-data");
  const files = require("../src/lib/hr/statutory-files") as typeof import("../src/lib/hr/statutory-files");
  const engine = require("../src/lib/hr/payroll") as typeof import("../src/lib/hr/payroll");
  const { financialYearOf } = require("../src/lib/hr/calendar") as typeof import("../src/lib/hr/calendar");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("By hand: ESI's contribution period, the ECR and the bank file");
  ok("January's period began the October before", JSON.stringify(engine.esiContributionPeriodStart(2002, 1)) === JSON.stringify({ year: 2001, month: 10 }));
  ok("  and June's in April", JSON.stringify(engine.esiContributionPeriodStart(2002, 6)) === JSON.stringify({ year: 2002, month: 4 }));
  const raisedComponents = { basic: 25000, hra: 0, conveyance: 0, medical: 0, specialAllowance: 0, otherAllowance: 0 };
  const slipAt = (esiPeriodRate?: number) =>
    engine.computePayslip({ components: raisedComponents, flags: { pfApplicable: false, esiApplicable: true, ptApplicable: false }, monthDays: 30, lopDays: 0, month: 6, year: 2002, incomeTax: 0, incomeTaxWorkedOut: true, esiPeriodRate });
  ok("raised to ₹25,000 in June from ₹18,000 in April: ESI still taken (covered for the period)", slipAt(18000).esiEmployee === 188, slipAt(18000).esiEmployee);
  ok("  above the limit since April: none", slipAt(25000).esiEmployee === 0 && slipAt().esiEmployee === 0);
  const row = (more: Partial<import("../src/lib/hr/statutory-files").StatutoryRow>): import("../src/lib/hr/statutory-files").StatutoryRow => ({
    name: `${TAG} Row`, employeeCode: null, uan: "100000000001", esicNumber: null, dateOfBirth: null, exitedOn: null, monthDays: 30, paidDays: 30, lopDays: 0,
    grossEarnings: 20000, pfEmployee: 0, pfEmployer: 0, pfWages: 0, epsWages: 0, epsEmployer: 0, esiEmployee: 0, esiEmployer: 0, netPay: 20000,
    bankAccountNumber: "123456789", bankIfsc: "HDFC0000001", bankName: null, ...more,
  });
  ok("PF on with ₹0 contributed is an ECR problem line", files.buildEcr([row({ pfApplicable: true })], { year: 2001, month: 11 }, 15000).problems.some((p) => /PF is on/.test(p)));
  ok("  PF off with nothing is no problem", files.buildEcr([row({ pfApplicable: false })], { year: 2001, month: 11 }, 15000).problems.length === 0);
  const negativeBank = files.buildBank([row({ netPay: -250 })]);
  ok("a negative net is listed as a bank-file problem, not dropped", negativeBank.included === 0 && negativeBank.problems.some((p) => /below nothing/.test(p)), negativeBank.problems);

  await cleanup();
  const clashing = await db.payrollRun.count({ where: { OR: [NOV, DEC] } });
  if (clashing > 0) throw new Error("November or December 2001 already has a payroll run in this database — the check uses those months.");
  try {
    const make = async (key: string, extra: Record<string, unknown> = {}) => {
      const u = await db.user.create({ data: { name: `${TAG} ${key}`, email: `${key.toLowerCase()}${MAIL}`, role: "PROFILE" as never, passwordHash: "x".repeat(60), ...extra } });
      return { id: u.id, name: u.name, email: u.email, role: "PROFILE" };
    };
    const grant = (userId: string, ...permissions: string[]) => db.userPermission.createMany({ data: permissions.map((permission) => ({ userId, permission, allowed: true, reason: TAG })) });
    const clerk = await make("Clerk");
    await grant(clerk.id, "payroll.manage", "hr.manage", "hr.approveLeave");
    const second = await make("Second");
    await grant(second.id, "payroll.manage");
    const hrOnly = await make("HrOnly");
    await grant(hrOnly.id, "hr.manage");
    const boss = await make("Boss");
    const emp = await make("Employee", { managerId: boss.id });
    await db.employeeProfile.create({ data: { userId: emp.id, joinedOn: d("2000-01-10"), designation: "Analyst", bankName: `${TAG} Bank`, bankAccountNumber: "11112222", bankIfsc: "HDFC0000001" } });
    await db.employeeProfile.create({ data: { userId: clerk.id, joinedOn: d("2000-01-10") } });
    await db.salaryStructure.create({ data: { userId: emp.id, effectiveFrom: d("2000-01-10"), basic: 30000, pfApplicable: false, esiApplicable: false, ptApplicable: false } });
    const award = await db.incentiveEarning.create({
      data: { userId: emp.id, createdById: clerk.id, fromDate: d("2001-11-01"), toDate: d("2001-11-30"), label: `${TAG} award`, amount: 5000, workings: TAG, status: "APPROVED" },
    });
    const as = (u: { id: string; name: string; email: string; role: string }) => (actor = u);
    const slipOf = (userId: string, m: { month: number; year: number }) => db.payslip.findFirst({ where: { userId, run: m } });

    section("R3-03: a recalculation keeps the incentive");
    as(clerk);
    madeRuns = true;
    const first = await payroll.runPayroll(NOV);
    const firstSlip = await slipOf(emp.id, NOV);
    const afterFirst = await db.incentiveEarning.findUniqueOrThrow({ where: { id: award.id } });
    ok("the run pays the award on the payslip", first.ok && num(firstSlip?.incentive) === 5000 && afterFirst.payslipId === firstSlip?.id && afterFirst.status === "PAID", { incentive: num(firstSlip?.incentive), status: afterFirst.status });
    const again = await payroll.runPayroll(NOV);
    const secondSlip = await slipOf(emp.id, NOV);
    const afterAgain = await db.incentiveEarning.findUniqueOrThrow({ where: { id: award.id } });
    ok("recalculated, the award is on the new payslip — not left Paid with no payslip", again.ok && secondSlip?.id !== firstSlip?.id && num(secondSlip?.incentive) === 5000 && afterAgain.payslipId === secondSlip?.id && afterAgain.status === "PAID", { incentive: num(secondSlip?.incentive), payslipId: afterAgain.payslipId, status: afterAgain.status });
    const strays = await db.incentiveEarning.count({ where: { userId: emp.id, status: "PAID", payslipId: null } });
    ok("  and no earning of theirs is Paid without a payslip", strays === 0, strays);

    section("Lows: a negative net");
    const draftSlip = secondSlip!;
    const tooMuch = await payroll.adjustPayslip({ id: draftSlip.id, incomeTax: 0, otherDeduction: 99999 });
    ok("a deduction past the gross is refused, saying by how much", !tooMuch.ok && /more than the gross/.test(errorOf(tooMuch)), tooMuch);
    ok("  and a deduction over any salary by the schema", !(await payroll.adjustPayslip({ id: draftSlip.id, incomeTax: 1e9, otherDeduction: 0 })).ok);
    await db.payslip.update({ where: { id: draftSlip.id }, data: { otherDeduction: 50000, otherDeductionNote: `${TAG} recovery` } });
    await payroll.runPayroll(NOV);
    const trimmed = await slipOf(emp.id, NOV);
    ok("a carried deduction is held to the pay on a recalculation, and the payslip says so", num(trimmed?.netPay) === 0 && num(trimmed?.otherDeduction) === 35000 && /wasn't taken/.test(trimmed?.note ?? ""), { net: num(trimmed?.netPay), other: num(trimmed?.otherDeduction) });
    await db.payslip.update({ where: { id: trimmed!.id }, data: { otherDeduction: 0, netPay: -100 } });
    const run = await db.payrollRun.findUniqueOrThrow({ where: { month_year: NOV } });
    const negativeLock = await payroll.setPayrollStatus(run.id, "LOCKED");
    ok("a run with a negative net can't be locked, naming who", !negativeLock.ok && negativeLock.error.includes(emp.name), negativeLock);
    await payroll.runPayroll(NOV);

    section("R3-04: locking, reopening and paying");
    const accounting = await isModuleEnabled("accounting");
    const entries = async (runId: string) => {
      const rows = await db.journalEntry.findMany({ where: { payrollRunId: runId, source: "PAYROLL" }, select: { id: true, reversesId: true, reversedBy: { select: { id: true } } } });
      return { live: rows.filter((r) => !r.reversesId && !r.reversedBy).length, reversals: rows.filter((r) => r.reversesId).length, originals: rows.filter((r) => !r.reversesId).length };
    };
    const both = await Promise.all([payroll.setPayrollStatus(run.id, "LOCKED"), payroll.setPayrollStatus(run.id, "LOCKED")]);
    ok("two locks at once: one lands", both.filter((r) => r.ok || /ledger/.test(errorOf(r))).length === 1, both);
    const locked = await entries(run.id);
    if (accounting) ok("  and the wage bill is posted once", locked.live === 1 && locked.originals === 1, locked);
    else console.log("  (accounting is off here: the ledger checks are skipped)");
    const reopened = await payroll.setPayrollStatus(run.id, "DRAFT");
    const afterReopen = await entries(run.id);
    ok("reopened to draft", reopened.ok, reopened);
    if (accounting) ok("  its wage entry is reversed — nothing of it stands", afterReopen.live === 0 && afterReopen.reversals === 1, afterReopen);
    await payroll.runPayroll(NOV);
    const relocked = await payroll.setPayrollStatus(run.id, "LOCKED");
    const afterRelock = await entries(run.id);
    ok("locked again", relocked.ok, relocked);
    if (accounting) ok("  posts afresh, once: one standing entry, two posted in all", afterRelock.live === 1 && afterRelock.originals === 2 && afterRelock.reversals === 1, afterRelock);
    const slipAtLock = await db.payslip.findFirstOrThrow({ where: { userId: emp.id, runId: run.id }, omit: { bankAccountNumber: false, bankIfsc: false, bankHolderName: false } });
    ok("R3-11: locking copies the account onto the payslip", slipAtLock.bankAccountNumber === "11112222" && slipAtLock.bankIfsc === "HDFC0000001" && slipAtLock.bankHolderName === emp.name, slipAtLock.bankAccountNumber);
    const paid = await payroll.setPayrollStatus(run.id, "PAID");
    ok("marked paid", paid.ok, paid);
    const backToLocked = await payroll.setPayrollStatus(run.id, "LOCKED");
    const backToDraft = await payroll.setPayrollStatus(run.id, "DRAFT");
    ok("a paid run can't go back to locked", !backToLocked.ok && /stays paid/.test(errorOf(backToLocked)), backToLocked);
    ok("  nor to draft", !backToDraft.ok && (await db.payrollRun.findUniqueOrThrow({ where: { id: run.id } })).status === "PAID", backToDraft);
    ok("  nor be recalculated", !(await payroll.runPayroll(NOV)).ok);
    ok("  and a payslip in it can't be adjusted", !(await payroll.adjustPayslip({ id: slipAtLock.id, incomeTax: 0, otherDeduction: 0 })).ok);
    const awardAtEnd = await db.incentiveEarning.findUniqueOrThrow({ where: { id: award.id } });
    ok("R3-03: through all of it the award stayed on the month's payslip", awardAtEnd.payslipId === slipAtLock.id && awardAtEnd.status === "PAID", awardAtEnd.payslipId);

    section("R3-11: the bank file pays the account that was locked");
    const decRun = await payroll.runPayroll(DEC);
    const decRunId = decRun.ok ? decRun.data.id : "";
    ok("December runs", decRun.ok, decRun);
    ok("December locks", (await payroll.setPayrollStatus(decRunId, "LOCKED")).ok);
    told.length = 0;
    const refusedBank = await hr.saveEmployeeProfile({ userId: emp.id, bankAccountNumber: "99998888" });
    ok("changing the bank account while December is locked is refused", !refusedBank.ok && /locked/.test(errorOf(refusedBank)), refusedBank);
    await db.employeeProfile.update({ where: { userId: emp.id }, data: { bankAccountNumber: "99998888", bankIfsc: "ICIC0000002" } });
    const decFiles = await statutoryFilesOfRun(decRunId);
    const decLine = decFiles?.bank.content.find((l) => l.name === emp.name);
    ok("the record changed behind the lock: the bank file still pays the locked account", decLine?.accountNumber === "11112222" && decLine.ifsc === "HDFC0000001", decLine);
    await db.payslip.updateMany({ where: { runId: decRunId, userId: emp.id }, data: { bankAccountNumber: null, bankIfsc: null, bankName: null, bankHolderName: null } });
    const olderLine = (await statutoryFilesOfRun(decRunId))?.bank.content.find((l) => l.name === emp.name);
    ok("  a payslip locked before the copy existed reads the record, as before", olderLine?.accountNumber === "99998888", olderLine);
    await db.employeeProfile.update({ where: { userId: emp.id }, data: { bankAccountNumber: "11112222", bankIfsc: "HDFC0000001" } });
    ok("December is paid", (await payroll.setPayrollStatus(decRunId, "PAID")).ok);
    const changed = await hr.saveEmployeeProfile({ userId: emp.id, bankAccountNumber: "77776666", designation: "Analyst" });
    const audit = await db.auditLog.findFirst({ where: { entityType: "EmployeeProfile", entityId: emp.id, userId: clerk.id }, orderBy: { createdAt: "desc" }, select: { entityLabel: true } });
    ok("once paid, the change is saved", changed.ok, changed);
    ok("  the audit names the field changed, never its value", /changed: account number$/.test(audit?.entityLabel ?? "") && !(audit?.entityLabel ?? "").includes("7777"), audit?.entityLabel);
    ok("  the employee is told", told.some((n) => n.userId === emp.id && /bank account/i.test(n.title)));
    ok("  and so is somebody else in payroll — not whoever changed it", told.some((n) => n.userId === second.id) && !told.some((n) => n.userId === clerk.id));
    ok("  the account itself is in no message", !told.some((n) => `${n.title} ${n.message ?? ""}`.includes("7777")));

    section("R3-12: income tax declarations");
    const ownDeclaration = await payroll.saveTaxDeclaration({ userId: clerk.id, taxYear: 2026, regime: "NEW", previousTds: 1000, note: "mine" });
    ok("payroll can't set their own declaration", !ownDeclaration.ok && /your own income tax declaration/.test(errorOf(ownDeclaration)), ownDeclaration);
    viewingAs = true;
    ok("  nor anybody's while viewing as somebody", errorOf(await payroll.saveTaxDeclaration({ userId: emp.id, taxYear: 2026, regime: "NEW" })) === VIEW_AS_REFUSAL);
    viewingAs = false;
    const noNote = await payroll.saveTaxDeclaration({ userId: emp.id, taxYear: 2026, regime: "NEW", previousTds: 5000 });
    ok("previous TDS without a note of where it comes from is refused", !noNote.ok && /Form 16/.test(errorOf(noNote)), noNote);
    ok("  with one it's saved", (await payroll.saveTaxDeclaration({ userId: emp.id, taxYear: 2026, regime: "NEW", previousTds: 5000, note: "Form 16, last employer" })).ok);

    section("R3-13: letters and their pay");
    as(hrOnly);
    const hrDraft = await docs.draftLetter(emp.id, "SALARY_CERTIFICATE");
    const hrRow = hrDraft.ok ? await db.employeeLetter.findUnique({ where: { id: hrDraft.data.id }, select: { payload: true } }) : null;
    const hrPayload = (hrRow?.payload ?? {}) as Record<string, unknown>;
    ok("HR without payroll rights freezes a salary certificate with no pay in it", hrDraft.ok && hrPayload.annualCtc == null && hrPayload.netPay == null && hrPayload.monthlyGross == null, hrPayload);
    as(clerk);
    const payDraft = await docs.draftLetter(emp.id, "SALARY_CERTIFICATE");
    const payRow = payDraft.ok ? await db.employeeLetter.findUnique({ where: { id: payDraft.data.id }, select: { payload: true } }) : null;
    ok("somebody who runs payroll freezes it with the pay", payDraft.ok && num((payRow?.payload as Record<string, unknown>)?.annualCtc) > 0, payRow?.payload);
    const thanks = await docs.draftLetter(emp.id, "APPRECIATION");
    const thanksRow = thanks.ok ? await db.employeeLetter.findUnique({ where: { id: thanks.data.id }, select: { payload: true } }) : null;
    ok("a letter that states no pay freezes none, whoever drafts it", thanks.ok && (thanksRow?.payload as Record<string, unknown>)?.annualCtc == null);
    const issued = payDraft.ok ? await docs.issueLetter(payDraft.data.id) : payDraft;
    ok("the certificate is issued", issued.ok, issued);
    const letterId = payDraft.ok ? payDraft.data.id : "";
    as(boss);
    const managerView = await docs.getLetter(letterId);
    const managerPayload = (managerView?.payload ?? {}) as Record<string, unknown>;
    ok("their line manager opens it without its pay", !!managerView && managerPayload.annualCtc === undefined && managerPayload.netPay === undefined, managerPayload);
    ok("  and without the text that states it", !!managerView && /only HR and/.test(managerView.body) && !/₹/.test(managerView.body), managerView?.body);
    as(emp);
    const ownView = await docs.getLetter(letterId);
    ok("the employee reads their own in full", num((ownView?.payload as Record<string, unknown>)?.annualCtc) > 0 && /₹/.test(ownView?.body ?? ""));

    section("R3-14: settlements and fixed PF");
    as(clerk);
    const leaver = await make("Leaver");
    await db.employeeProfile.create({ data: { userId: leaver.id, joinedOn: d("2000-01-10"), exitedOn: d("2001-09-15") } });
    await db.salaryStructure.create({ data: { userId: leaver.id, effectiveFrom: d("2000-01-10"), basic: 30000, pfApplicable: false, esiApplicable: false, ptApplicable: false } });
    const negativeTax = await settlement.buildSettlement(leaver.id, { incomeTax: -5000 });
    ok("a negative income tax override is refused", !negativeTax.ok && /negative/.test(errorOf(negativeTax)), negativeTax);
    ok("  other earnings need a note", /other earnings/.test(errorOf(await settlement.buildSettlement(leaver.id, { otherEarnings: 1000 }))));
    ok("  a bonus needs a reason", /Say why/.test(errorOf(await settlement.buildSettlement(leaver.id, { bonusAmount: 1000 }))));
    ok("  and a field nobody knows is refused", !(await settlement.buildSettlement(leaver.id, { salaryAmount: 1 } as never)).ok);
    const built = await settlement.buildSettlement(leaver.id, { bonusAmount: 1000, note: "Festival bonus owed" });
    ok("built with a reason", built.ok, built);
    const selfApproved = await settlement.setSettlementStatus(leaver.id, "APPROVED");
    ok("whoever prepared it can't approve it", !selfApproved.ok && /somebody else in payroll/.test(errorOf(selfApproved)), selfApproved);
    as(second);
    const approved = await settlement.setSettlementStatus(leaver.id, "APPROVED");
    ok("  somebody else in payroll can", approved.ok, approved);
    as(clerk);
    const fixedLow = { userId: leaver.id, effectiveFrom: "2099-01-01", basic: 20000, pfApplicable: true, esiApplicable: false, ptApplicable: false, statutoryFixed: { pfEmployee: 100, pfEmployer: 100 } };
    const lowNoNote = await payroll.saveSalaryStructure(fixedLow);
    ok("PF fixed below 12% of basic without a reason is refused, saying the law's figure", !lowNoNote.ok && /statutory/.test(errorOf(lowNoNote)) && /₹2,400/.test(errorOf(lowNoNote)), lowNoNote);
    const lowWithNote = await payroll.saveSalaryStructure({ ...fixedLow, note: "Contributes on a lower wage by agreement" });
    ok("  with the reason in the note it's saved", lowWithNote.ok, lowWithNote);

    section("Lows: leave in a locked month, and opening balances");
    const type = await db.leaveType.create({ data: { code: TAG, name: `${TAG} leave`, annualQuota: 12, paid: true } });
    await db.payrollRun.update({ where: { id: decRunId }, data: { status: "LOCKED" } });
    const pending = await db.leaveRequest.create({ data: { userId: emp.id, typeId: type.id, fromDate: d("2001-12-10"), toDate: d("2001-12-11"), days: 2, reason: `${TAG} old request` } });
    as(boss);
    const approveLocked = await leave.decideLeave({ id: pending.id, approve: true });
    ok("leave in a month whose payroll is locked isn't approved", !approveLocked.ok && /payroll is already run/.test(errorOf(approveLocked)), approveLocked);
    ok("  and stays pending, with no attendance written", (await db.leaveRequest.findUniqueOrThrow({ where: { id: pending.id } })).status === "PENDING" && (await db.attendanceDay.count({ where: { userId: emp.id } })) === 0);
    await db.payrollRun.update({ where: { id: decRunId }, data: { status: "PAID" } });
    as(clerk);
    const thisYear = financialYearOf((await workspaceClock()).calendarDate(new Date()));
    const ownOpening = await openings.saveLeaveOpenings({ year: thisYear, rows: [{ userId: clerk.id, typeId: type.id, opening: 30, usedBefore: 0 }] });
    ok("HR can't type their own opening balance", !ownOpening.ok && /your own opening balance/.test(errorOf(ownOpening)), ownOpening);
    viewingAs = true;
    ok("  nor anybody's while viewing as somebody", errorOf(await openings.saveLeaveOpenings({ year: thisYear, rows: [{ userId: emp.id, typeId: type.id, opening: 3, usedBefore: 0 }] })) === VIEW_AS_REFUSAL);
    viewingAs = false;
    ok("  somebody else's is saved", (await openings.saveLeaveOpenings({ year: thisYear, rows: [{ userId: emp.id, typeId: type.id, opening: 3, usedBefore: 0 }] })).ok);
  } finally {
    actor = null;
    viewingAs = false;
    await cleanup();
    const left = (await db.user.count({ where: { email: { endsWith: MAIL } } })) + (await db.payrollRun.count({ where: { OR: [NOV, DEC] } }));
    ok("nothing of the fixture is left behind", left === 0, left);
    await db.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} round-three payroll checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
