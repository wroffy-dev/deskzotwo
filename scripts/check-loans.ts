/**
 * check:loans — loans and salary advances to employees (src/actions/loan.ts), recovered from pay by the payroll run
 * (src/actions/payroll.ts) and, what is left, by the full and final (src/lib/hr/loans.ts).
 *
 * The arithmetic first, then a fixture of its own: an employee with a salary in 2001 and somebody who runs payroll.
 * Payroll runs for May to August 2001 — nobody real had a salary then, so they are skipped — and are removed after.
 * Notifications are caught, not sent. Everything is named ZZPROBE_LN and removed in a finally.
 *
 *   npm run check:loans
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor: { id: string; name: string; email: string } | null = null;
const told: { userId: string; type: string }[] = [];
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => (actor ? { ...actor, role: "SALES" } : null);
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/notify") return { notifyUser: async (n: { userId: string; type: string }) => void told.push(n) };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_LN";
const MAIL = "@zzprobe-ln.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const MONTHS = [5, 6, 7, 8];

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  await db.payrollRun.deleteMany({ where: { year: 2001, month: { in: MONTHS } } });
  await db.journalEntry.deleteMany({ where: { narration: { contains: TAG } } });
  await db.employeeLoan.deleteMany({ where: { userId: { in: ids } } });
  await db.finalSettlement.deleteMany({ where: { userId: { in: ids } } });
  await db.salaryStructure.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.employeeProfile.deleteMany({ where: { userId: { in: ids } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const rules = require("../src/lib/hr/loan-rules") as typeof import("../src/lib/hr/loan-rules");
  const loans = require("../src/actions/loan") as typeof import("../src/actions/loan");
  const payroll = require("../src/actions/payroll") as typeof import("../src/actions/payroll");
  const { owedBy } = require("../src/lib/hr/loans") as typeof import("../src/lib/hr/loans");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("The arithmetic");
  ok("10,000 over 3 months: 3,334 a month, the last 3,332", rules.instalmentFor(10000, 3) === 3334);
  ok("an advance in one go: the whole of it", rules.instalmentFor(5000, 1) === 5000);
  const may = rules.monthStart(2001, 5);
  const loan = (id: string, over: Partial<import("../src/lib/hr/loan-rules").LoanForPayroll> = {}) => ({ id, approved: true, disbursed: true, firstMonth: may, instalmentAmount: 3000, outstanding: 9000, ...over });
  ok("due: its instalment", JSON.stringify(rules.recoveriesFor([loan("a")], may, 50000)) === JSON.stringify([{ loanId: "a", amount: 3000 }]));
  ok("the last one: only what's left", rules.recoveriesFor([loan("a", { outstanding: 1200 })], may, 50000)[0]?.amount === 1200);
  ok("not before its first month, not before it's paid out, not unapproved", rules.recoveriesFor([loan("a", { firstMonth: rules.monthStart(2001, 6) }), loan("b", { disbursed: false }), loan("c", { approved: false })], may, 50000).length === 0);
  const short = rules.recoveriesFor([loan("old", { firstMonth: rules.monthStart(2001, 1) }), loan("new")], may, 4000);
  ok("a short month: never more than the pay can bear, the oldest loan first", short.length === 2 && short[0]!.loanId === "old" && short[0]!.amount === 3000 && short[1]!.amount === 1000, short);
  ok("nothing to bear: nothing recovered", rules.recoveriesFor([loan("a")], may, -50).length === 0);
  ok("an amount and months are asked for, at most 60", !!rules.loanProblem({ amount: 0, instalments: 1 }) && !!rules.loanProblem({ amount: 100, instalments: 61 }) && rules.loanProblem({ amount: 100, instalments: 12 }) === null);

  await cleanup();
  try {
    section("The fixture");
    const make = (name: string) => db.user.create({ data: { name: `${TAG} ${name}`, email: `${name.toLowerCase()}${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const clerk = await make("Clerk");
    const emp = await make("Employee");
    await db.userPermission.create({ data: { userId: clerk.id, permission: "payroll.manage", allowed: true, reason: TAG } });
    await db.employeeProfile.create({ data: { userId: emp.id, joinedOn: d("2000-01-01") } });
    await db.salaryStructure.create({ data: { userId: emp.id, effectiveFrom: d("2000-01-01"), basic: 20000, hra: 8000, specialAllowance: 12000, pfApplicable: false, esiApplicable: false, ptApplicable: false, createdById: clerk.id } });
    const as = (u: { id: string; name: string; email: string }) => (actor = { id: u.id, name: u.name, email: u.email });
    ok("an employee on 40,000 a month in 2001, and a payroll clerk", true);

    section("Asking, and deciding");
    as(emp);
    const asked = await loans.requestLoan({ kind: "ADVANCE", amount: 5000, instalments: 1, reason: "Medical bills" });
    ok("the employee asks for an advance", asked.ok, asked.ok ? "" : asked.error);
    ok("  whoever runs payroll is told", told.some((t) => t.userId === clerk.id && t.type === "LOAN_REQUESTED"));
    ok("  a second while one waits is refused", !(await loans.requestLoan({ kind: "LOAN", amount: 1000, instalments: 2, reason: "Again" })).ok);
    const askedId = asked.ok ? asked.data.id : "";
    ok("  they can't decide their own — they don't run payroll", !(await loans.decideLoan({ id: askedId, approve: true })).ok);
    as(clerk);
    ok("turning it down needs a reason", !(await loans.decideLoan({ id: askedId, approve: false })).ok);
    const approved = await loans.decideLoan({ id: askedId, approve: true, firstMonth: "2001-08" });
    ok("approved, recovered from August 2001", approved.ok, approved.ok ? "" : approved.error);
    ok("  they're told", told.some((t) => t.userId === emp.id && t.type === "LOAN_DECIDED"));

    const made = await loans.createLoan({ userId: emp.id, kind: "LOAN", amount: 10000, instalments: 3, firstMonth: "2001-05", reason: `${TAG} bike` });
    ok("payroll sets up a loan: 10,000 over 3 months from May", made.ok, made.ok ? "" : made.error);
    const loanId = made.ok ? made.data.id : "";

    section("Paid out, then recovered from pay");
    as(clerk);
    const early = await payroll.runPayroll({ month: 5, year: 2001 });
    const slipBefore = await db.payslip.findFirst({ where: { userId: emp.id, run: { year: 2001, month: 5 } }, select: { loanRecovery: true, netPay: true } });
    ok("not paid out yet: May recovers nothing", early.ok && Number(slipBefore?.loanRecovery) === 0 && Number(slipBefore?.netPay) === 40000, slipBefore);
    const out = await loans.recordDisbursal({ id: loanId, on: "2001-04-25", cash: false });
    ok("recorded as paid out on 25 April", out.ok, out.ok ? "" : out.error);
    const disbursed = await db.employeeLoan.findUniqueOrThrow({ where: { id: loanId }, select: { journalEntryId: true } });
    if (disbursed.journalEntryId) {
      const lines = await db.journalLine.findMany({ where: { entryId: disbursed.journalEntryId }, select: { debit: true, credit: true, account: { select: { systemKey: true } } } });
      ok("  booked: Loans & Advances to Staff up, the bank down", lines.some((l) => l.account.systemKey === "STAFF_LOANS" && Number(l.debit) === 10000) && lines.some((l) => l.account.systemKey === "BANK" && Number(l.credit) === 10000), lines);
      await db.journalEntry.update({ where: { id: disbursed.journalEntryId }, data: { narration: `${TAG} paid out` } });
    } else ok("  (no books here: nothing to post)", true);
    ok("  paid out twice is refused", !(await loans.recordDisbursal({ id: loanId, on: "2001-04-26", cash: false })).ok);

    const slip = async (month: number) => db.payslip.findFirst({ where: { userId: emp.id, run: { year: 2001, month } }, select: { id: true, loanRecovery: true, totalDeductions: true, netPay: true, loanRepayments: { select: { loanId: true, amount: true } } } });
    await payroll.runPayroll({ month: 5, year: 2001 });
    const mayS = await slip(5);
    ok("May, run again: 3,334 recovered, in the deductions, out of the net", Number(mayS?.loanRecovery) === 3334 && Number(mayS?.totalDeductions) === 3334 && Number(mayS?.netPay) === 36666, mayS);
    ok("  tied to the loan", mayS?.loanRepayments.length === 1 && mayS.loanRepayments[0]!.loanId === loanId);
    await payroll.runPayroll({ month: 5, year: 2001 });
    ok("  recalculated: still the one recovery, not two", (await db.loanRepayment.count({ where: { loanId } })) === 1 && Number((await slip(5))?.loanRecovery) === 3334);
    await payroll.runPayroll({ month: 6, year: 2001 });
    await payroll.runPayroll({ month: 7, year: 2001 });
    ok("June 3,334, July the last 3,332", Number((await slip(6))?.loanRecovery) === 3334 && Number((await slip(7))?.loanRecovery) === 3332);
    const view = (await loans.loansOverview())!;
    ok("  repaid: off the running list", !view.running.some((l) => l.id === loanId) && view.done.some((l) => l.id === loanId && l.outstanding === 0 && l.recovered === 10000), view.done.map((l) => [l.reason, l.outstanding]));

    section("The advance, and leaving");
    ok("the advance isn't recovered before it's paid out", Number((await slip(7))?.loanRecovery) === 3332);
    await loans.recordDisbursal({ id: askedId, on: "2001-07-20", cash: true });
    await db.journalEntry.updateMany({ where: { narration: { contains: `${TAG} Employee` } }, data: { narration: `${TAG} advance` } });
    const part = await loans.recordRepayment({ id: askedId, amount: 2000, on: "2001-07-28", cash: true });
    ok("2,000 of it paid back by hand", part.ok, part.ok ? "" : part.error);
    await db.journalEntry.updateMany({ where: { narration: { contains: `${TAG} Employee` } }, data: { narration: `${TAG} repaid` } });
    ok("  more than is owed is refused", !(await loans.recordRepayment({ id: askedId, amount: 5000, on: "2001-07-29", cash: true })).ok);
    ok("what they owe: 3,000 — for the full and final's advance recovery", (await owedBy(emp.id)) === 3000, await owedBy(emp.id));
    await payroll.runPayroll({ month: 8, year: 2001 });
    ok("August recovers the 3,000 left on the advance", Number((await slip(8))?.loanRecovery) === 3000 && (await owedBy(emp.id)) === 0);

    as(emp);
    const mine = await loans.myLoans();
    ok("My HR shows both, repaid", mine.loans.length === 2 && mine.loans.every((l) => l.outstanding === 0 && l.status === "APPROVED"), mine.loans.map((l) => [l.kind, l.outstanding]));
  } finally {
    actor = null;
    await cleanup();
    const left = (await db.user.count({ where: { email: { endsWith: MAIL } } })) + (await db.payrollRun.count({ where: { year: 2001, month: { in: MONTHS } } }));
    ok("nothing of the fixture is left behind", left === 0, left);
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll loan checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
