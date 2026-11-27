/**
 * check:audit-fixes-c — the security audit of 11 Nov 2026 (docs/reports/security-audit-2026-11-11.md), group C: HR,
 * payroll, leave, attendance and visits, each fix shown to hold the way it was broken — by calling the server's own
 * actions, as a hand-made request would.
 *
 *   SEC-19  viewing as somebody, no decision, record or pay change is taken (their "never your own" was the borrowed one)
 *   SEC-20  an employee changes their own contact details only; a partial post keeps what it leaves out
 *   SEC-28  a leave span is a year at most, in a sane year — refused with why, never walked a day at a time
 *   SEC-31  two decisions at once land once: leave debits once, a loan is paid out and repaid once, and the rest
 *   SEC-38  switching the old account off when moving a record takes users.manage
 *   SEC-43  nobody in payroll sets their own salary, settlement or loan movement
 *   SEC-44  a month whose payroll is run keeps its attendance; a correction to "on leave" is refused
 *   SEC-53  a visit is completed, cancelled or marked a no-show only while it is still open
 *   SEC-66  a leaver's ID card says it is no longer valid
 *
 * A fixture of its own, named ZZC (users @zzc-audit.invalid, leave type ZZC, payroll runs in February 2001), removed in
 * a finally. Assertions are about the fixture's own rows: the local database is full.
 *
 *   npx tsx scripts/check-audit-fixes-c.ts
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

const VIEW_AS_REFUSAL = "ZZC: refused while viewing as somebody";
let actor: { id: string; name: string; email: string; role: string } | null = null;
let viewingAs = false;
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
      viewAsContext: async () => (viewingAs && actor ? { user: actor, admin: { id: "zzc-admin", name: "ZZC Admin" } } : null),
      refuseWhileViewingAs: async () => (viewingAs ? VIEW_AS_REFUSAL : null),
    };
  }
  if (request === "@/lib/notify") return { notifyUser: async () => {} };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZC";
const MAIL = "@zzc-audit.invalid";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const errorOf = (r: { ok: boolean; error?: string }) => (r.ok ? "" : (r.error ?? ""));
const LOCKED = { month: 2, year: 2001 };
let madeRun = false;

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  if (madeRun) await db.payrollRun.deleteMany({ where: { ...LOCKED, note: TAG } });
  const loans = (await db.employeeLoan.findMany({ where: { userId: { in: ids } }, select: { id: true, journalEntryId: true } }));
  await db.loanRepayment.deleteMany({ where: { loanId: { in: loans.map((l) => l.id) } } });
  await db.employeeLoan.deleteMany({ where: { id: { in: loans.map((l) => l.id) } } });
  await db.journalEntry.deleteMany({ where: { OR: [{ narration: { contains: TAG } }, { id: { in: loans.map((l) => l.journalEntryId).filter((x): x is string => !!x) } }] } });
  await db.leaveRequest.deleteMany({ where: { userId: { in: ids } } });
  await db.leaveBalance.deleteMany({ where: { userId: { in: ids } } });
  await db.leaveType.deleteMany({ where: { code: TAG } });
  await db.attendanceRegularisation.deleteMany({ where: { userId: { in: ids } } });
  await db.attendanceDay.deleteMany({ where: { userId: { in: ids } } });
  await db.resignation.deleteMany({ where: { userId: { in: ids } } });
  await db.visit.deleteMany({ where: { userId: { in: ids } } });
  await db.company.deleteMany({ where: { name: { startsWith: `${TAG} ` } } });
  await db.finalSettlement.deleteMany({ where: { userId: { in: ids } } });
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
  const calendar = require("../src/lib/hr/calendar") as typeof import("../src/lib/hr/calendar");
  const leave = require("../src/actions/leave") as typeof import("../src/actions/leave");
  const shortLeave = require("../src/actions/short-leave") as typeof import("../src/actions/short-leave");
  const regularisation = require("../src/actions/regularisation") as typeof import("../src/actions/regularisation");
  const attendance = require("../src/actions/attendance") as typeof import("../src/actions/attendance");
  const expense = require("../src/actions/expense") as typeof import("../src/actions/expense");
  const loans = require("../src/actions/loan") as typeof import("../src/actions/loan");
  const payroll = require("../src/actions/payroll") as typeof import("../src/actions/payroll");
  const settlement = require("../src/actions/settlement") as typeof import("../src/actions/settlement");
  const resignation = require("../src/actions/resignation") as typeof import("../src/actions/resignation");
  const hr = require("../src/actions/hr") as typeof import("../src/actions/hr");
  const move = require("../src/actions/move-employee") as typeof import("../src/actions/move-employee");
  const visit = require("../src/actions/visit") as typeof import("../src/actions/visit");
  const cards = require("../src/lib/id-cards/cards") as typeof import("../src/lib/id-cards/cards");
  const { workspaceClock } = require("../src/lib/time/workspace") as typeof import("../src/lib/time/workspace");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("SEC-28: a leave span, by hand");
  ok("a year is fine", calendar.leaveSpanProblem("2026-04-01", "2027-03-31") === null);
  ok("ten years is refused, saying the most", /at most 366 days/.test(calendar.leaveSpanProblem("2026-01-01", "2035-12-31") ?? ""));
  ok("  year 1, year 9999, and words are refused", [calendar.leaveSpanProblem("0001-01-01", "0001-01-02"), calendar.leaveSpanProblem("9999-01-01", "9999-01-02"), calendar.leaveSpanProblem("soon", "later")].every(Boolean));
  let threw = false;
  try {
    calendar.eachDay("1900-01-01", "2100-01-01");
  } catch (err) {
    threw = err instanceof RangeError;
  }
  ok("  eachDay refuses two centuries rather than building them", threw);
  ok("  and still walks a month", calendar.eachDay("2026-02-01", "2026-02-28").length === 28);

  await cleanup();
  try {
    const make = async (key: string, role: string, extra: Record<string, unknown> = {}) => {
      const u = await db.user.create({ data: { name: `${TAG} ${key}`, email: `${key.toLowerCase()}${MAIL}`, role: role as never, passwordHash: "x".repeat(60), ...extra } });
      return { id: u.id, name: u.name, email: u.email, role };
    };
    const grant = (userId: string, ...permissions: string[]) =>
      db.userPermission.createMany({ data: permissions.map((permission) => ({ userId, permission, allowed: true, reason: TAG })) });
    const hrHead = await make("HrHead", "PROFILE");
    await grant(hrHead.id, "hr.manage", "payroll.manage", "hr.approveLeave");
    const boss = await make("Boss", "PROFILE");
    const emp = await make("Employee", "PROFILE", { managerId: boss.id });
    const leaver = await make("Leaver", "PROFILE");
    await db.employeeProfile.create({
      data: { userId: emp.id, joinedOn: d("2020-01-01"), state: "Delhi", bankAccountNumber: "12345678", panNumber: "ABCDE1234F", personalPhone: "1111" },
    });
    await db.employeeProfile.create({ data: { userId: leaver.id, joinedOn: d("2020-01-01"), exitedOn: d("2001-01-31") } });
    const as = (u: typeof emp) => (actor = u);
    const clock = await workspaceClock();
    const today = clock.calendarDate(new Date());

    section("SEC-28 and SEC-69: through the actions");
    as(emp);
    const preview = (await leave.previewLeaveDays({ fromDate: "2026-01-01", toDate: "2035-12-31" })) as { days: number; error?: string };
    ok("the preview of ten years says why, and counts nothing", preview.days === 0 && /at most 366/.test(preview.error ?? ""), preview);
    const type = await db.leaveType.create({ data: { code: TAG, name: `${TAG} leave`, annualQuota: 12, paid: true } });
    const tenYears = await leave.applyForLeave({ typeId: type.id, fromDate: "2026-01-01", toDate: "2035-12-31", reason: "A long break" });
    ok("applying for ten years is refused with a message, not a crash", !tenYears.ok && /at most 366/.test(errorOf(tenYears)), tenYears);

    section("SEC-31: two approvals of one leave at once");
    // A working day a month or more ahead, in this financial year where it can be.
    const holidays = await db.holiday.findMany({ where: { date: { gte: calendar.addDays(today, 30), lte: calendar.addDays(today, 90) } }, select: { date: true, optional: true } });
    const closed = calendar.closedDates(holidays);
    const day = calendar.eachDay(calendar.addDays(today, 30), calendar.addDays(today, 90)).find((x) => !calendar.isWeekOff(x) && !closed.has(calendar.toKey(x)))!;
    const applied = await leave.applyForLeave({ typeId: type.id, fromDate: calendar.toKey(day), toDate: calendar.toKey(day), reason: "Family function" });
    ok("the employee applies for a day", applied.ok, applied);
    const requestId = applied.ok ? applied.data.id : "";
    const fy = calendar.financialYearOf(day);
    const usedBefore = Number((await db.leaveBalance.findUnique({ where: { userId_typeId_year: { userId: emp.id, typeId: type.id, year: fy } } }))?.used ?? 0);
    ok("  they can't decide their own", !(await leave.decideLeave({ id: requestId, approve: true })).ok);
    as(boss);
    viewingAs = true;
    const borrowed = await leave.decideLeave({ id: requestId, approve: true });
    ok("SEC-19: viewing as somebody, the decision is refused", errorOf(borrowed) === VIEW_AS_REFUSAL, borrowed);
    viewingAs = false;
    const both = await Promise.all([leave.decideLeave({ id: requestId, approve: true }), leave.decideLeave({ id: requestId, approve: true })]);
    const usedAfter = Number((await db.leaveBalance.findUnique({ where: { userId_typeId_year: { userId: emp.id, typeId: type.id, year: fy } } }))?.used ?? 0);
    ok("exactly one of two approvals at once lands", both.filter((r) => r.ok).length === 1, both);
    ok("  and the balance moved once", usedAfter - usedBefore === 1, { usedBefore, usedAfter });

    section("SEC-19: view-as in the other decisions");
    viewingAs = true;
    ok("short leave", errorOf(await shortLeave.decideShortLeave({ id: "x", approve: true })) === VIEW_AS_REFUSAL);
    ok("an attendance correction", errorOf(await regularisation.decideRegularisation({ id: "x", approve: true })) === VIEW_AS_REFUSAL);
    ok("an expense claim", errorOf(await expense.decideExpense({ id: "x", approved: true })) === VIEW_AS_REFUSAL);
    ok("a resignation", errorOf(await resignation.decideResignation({ id: "x", accept: true })) === VIEW_AS_REFUSAL);
    as(hrHead);
    ok("a loan", errorOf(await loans.decideLoan({ id: "x", approve: true })) === VIEW_AS_REFUSAL);
    ok("a salary", errorOf(await payroll.saveSalaryStructure({ userId: emp.id, effectiveFrom: "2001-01-01", basic: 1000 })) === VIEW_AS_REFUSAL);
    ok("a settlement", errorOf(await settlement.buildSettlement(emp.id)) === VIEW_AS_REFUSAL);
    ok("an employee record — the bank account included", errorOf(await hr.saveEmployeeProfile({ userId: emp.id, bankAccountNumber: "999" })) === VIEW_AS_REFUSAL);
    viewingAs = false;

    section("SEC-20: an employee's own record");
    as(emp);
    const bank = await hr.saveEmployeeProfile({ userId: emp.id, bankAccountNumber: "99999999" });
    ok("changing their own bank account is refused, saying who changes it", !bank.ok && /Ask HR/.test(errorOf(bank)), bank);
    ok("  so is their state, PAN or date of birth", [
      await hr.saveEmployeeProfile({ userId: emp.id, state: "Karnataka" }),
      await hr.saveEmployeeProfile({ userId: emp.id, panNumber: "ZZZZZ9999Z" }),
      await hr.saveEmployeeProfile({ userId: emp.id, dateOfBirth: "1990-01-01" }),
    ].every((r) => !r.ok));
    const phone = await hr.saveEmployeeProfile({ userId: emp.id, personalPhone: "2222" });
    const afterPhone = await db.employeeProfile.findUniqueOrThrow({ where: { userId: emp.id } });
    ok("their phone alone is saved", phone.ok && afterPhone.personalPhone === "2222", phone);
    ok("  and the post leaving the rest out nulls nothing", afterPhone.bankAccountNumber === "12345678" && afterPhone.state === "Delhi" && afterPhone.panNumber === "ABCDE1234F" && !!afterPhone.joinedOn, afterPhone);
    const whole = await hr.saveEmployeeProfile({ userId: emp.id, personalPhone: "3333", bankAccountNumber: "12345678", state: "Delhi", panNumber: "ABCDE1234F", gender: "" });
    ok("  a whole form sending the pay inputs unchanged is fine", whole.ok && (await db.employeeProfile.findUniqueOrThrow({ where: { userId: emp.id } })).personalPhone === "3333", whole);
    as(hrHead);
    const hrEdit = await hr.saveEmployeeProfile({ userId: emp.id, bankName: `${TAG} Bank` });
    const afterHr = await db.employeeProfile.findUniqueOrThrow({ where: { userId: emp.id } });
    ok("HR changes one field; the rest stay", hrEdit.ok && afterHr.bankName === `${TAG} Bank` && afterHr.bankAccountNumber === "12345678" && afterHr.personalPhone === "3333" && afterHr.state === "Delhi", afterHr);

    section("SEC-43: nobody in payroll moves their own pay");
    const ownSalary = await payroll.saveSalaryStructure({ userId: hrHead.id, effectiveFrom: "2001-01-01", basic: 825000 });
    ok("their own salary is refused", !ownSalary.ok && /your own pay/.test(errorOf(ownSalary)), ownSalary);
    const ownSettlement = await settlement.buildSettlement(hrHead.id);
    ok("their own settlement is refused", !ownSettlement.ok && /your own settlement/.test(errorOf(ownSettlement)), ownSettlement);
    const ownLoan = await db.employeeLoan.create({ data: { userId: hrHead.id, kind: "LOAN", status: "APPROVED", amount: 1000, instalments: 1, instalmentAmount: 1000, firstMonth: d("2001-05-01"), reason: `${TAG} own` } });
    ok("paying out their own loan is refused", /your own loan/.test(errorOf(await loans.recordDisbursal({ id: ownLoan.id, on: "2001-04-01", cash: true }))));
    await db.employeeLoan.update({ where: { id: ownLoan.id }, data: { disbursedOn: d("2001-04-01") } });
    ok("  and so is recording its repayment", /your own loan/.test(errorOf(await loans.recordRepayment({ id: ownLoan.id, amount: 100, on: "2001-04-02", cash: true }))));

    section("SEC-31: loans decided, paid out and repaid once");
    as(emp);
    const asked = await loans.requestLoan({ kind: "LOAN", amount: 2000, instalments: 2, reason: "Two at once" });
    const askedId = asked.ok ? asked.data.id : "";
    as(hrHead);
    const decided = await Promise.all([loans.decideLoan({ id: askedId, approve: true }), loans.decideLoan({ id: askedId, approve: true })]);
    ok("two approvals at once: one lands", decided.filter((r) => r.ok).length === 1, decided);
    const made = await loans.createLoan({ userId: emp.id, kind: "ADVANCE", amount: 1000, instalments: 1, firstMonth: "2001-05", reason: `${TAG} advance` });
    const madeId = made.ok ? made.data.id : "";
    const paidOut = await Promise.all([loans.recordDisbursal({ id: madeId, on: "2001-04-25", cash: true }), loans.recordDisbursal({ id: madeId, on: "2001-04-25", cash: true })]);
    ok("two pay-outs at once: one lands", paidOut.filter((r) => r.ok).length === 1, paidOut);
    const repaid = await Promise.all([
      loans.recordRepayment({ id: madeId, amount: 1000, on: "2001-04-28", cash: true }),
      loans.recordRepayment({ id: madeId, amount: 1000, on: "2001-04-28", cash: true }),
    ]);
    const repaidSum = (await db.loanRepayment.findMany({ where: { loanId: madeId }, select: { amount: true } })).reduce((t, r) => t + Number(r.amount), 0);
    ok("two repayments of the whole amount at once: one lands, 1,000 repaid not 2,000", repaid.filter((r) => r.ok).length === 1 && repaidSum === 1000, { repaid, repaidSum });
    await db.journalEntry.updateMany({ where: { narration: { contains: `${TAG} Employee` } }, data: { narration: `${TAG} loan` } });

    section("SEC-31: a resignation decided once");
    as(emp);
    const resigned = await resignation.submitResignation({ reason: "Moving city", lastDay: calendar.toKey(calendar.addDays(today, 30)) });
    ok("the employee resigns", resigned.ok, resigned);
    as(boss);
    const resignedId = resigned.ok ? resigned.data.id : "";
    const turned = await Promise.all([
      resignation.decideResignation({ id: resignedId, accept: false, note: "Stay" }),
      resignation.decideResignation({ id: resignedId, accept: false, note: "Stay" }),
    ]);
    ok("two decisions at once: one lands", turned.filter((r) => r.ok).length === 1, turned);

    section("SEC-44: a month whose payroll is run");
    const existingRun = await db.payrollRun.findUnique({ where: { month_year: LOCKED } });
    if (!existingRun) {
      await db.payrollRun.create({ data: { ...LOCKED, status: "LOCKED", note: TAG } });
      madeRun = true;
    }
    const lockedNow = (await db.payrollRun.findUnique({ where: { month_year: LOCKED } }))?.status !== "DRAFT";
    as(hrHead);
    const marked = await attendance.markAttendance({ userId: emp.id, date: "2001-02-05", status: "PRESENT" });
    ok("HR marking a day in it is refused", lockedNow && !marked.ok && /payroll is already run/.test(errorOf(marked)), marked);
    as(emp);
    const asking = await regularisation.requestRegularisation({ date: "2001-02-05", requestedStatus: "PRESENT", reason: "Was in" });
    ok("  asking to correct one is refused", !asking.ok && /payroll is already run/.test(errorOf(asking)), asking);
    const onLeave = await regularisation.requestRegularisation({ date: calendar.toKey(calendar.addDays(today, -1)), requestedStatus: "ON_LEAVE", reason: "Was off" });
    ok("a correction to 'on leave' is refused — leave is applied for", !onLeave.ok && /leave application/.test(errorOf(onLeave)), onLeave);
    const oldOnLeave = await db.attendanceRegularisation.create({ data: { userId: emp.id, date: d("2001-03-06"), requestedStatus: "ON_LEAVE", reason: `${TAG} old` } });
    as(boss);
    ok("  one raised before the rule can't be approved", /leave application/.test(errorOf(await regularisation.decideRegularisation({ id: oldOnLeave.id, approve: true }))));
    const marchRun = await db.payrollRun.findUnique({ where: { month_year: { month: 3, year: 2001 } } });
    const fix = await db.attendanceRegularisation.create({ data: { userId: emp.id, date: d("2001-03-05"), requestedStatus: "PRESENT", reason: `${TAG} race` } });
    const fixed = await Promise.all([regularisation.decideRegularisation({ id: fix.id, approve: true }), regularisation.decideRegularisation({ id: fix.id, approve: true })]);
    ok("SEC-31: two approvals of one correction at once — one lands", (marchRun && marchRun.status !== "DRAFT") || fixed.filter((r) => r.ok).length === 1, fixed);

    section("SEC-38: moving a record and switching the old login off");
    as(hrHead);
    const moved = await move.moveEmployeeRecord({ fromUserId: boss.id, toUserId: leaver.id, confirmEmail: leaver.email, switchOffSource: true, handOverReportees: false });
    ok("HR and payroll alone can't switch an account off this way", !moved.ok && /managing users/.test(errorOf(moved)), moved);
    ok("  and the account is still on", (await db.user.findUniqueOrThrow({ where: { id: boss.id } })).active);

    section("SEC-53: visits");
    as(emp);
    const company = await db.company.create({ data: { name: `${TAG} Customer`, normalizedName: "zzc customer", createdById: emp.id } });
    const visitOf = (status: "PLANNED" | "COMPLETED" | "CANCELLED") => db.visit.create({ data: { companyId: company.id, userId: emp.id, scheduledFor: new Date(), status, outcome: status === "COMPLETED" ? "Met the buyer" : null } });
    const done = await visitOf("COMPLETED");
    const cancelDone = await visit.setVisitStatus({ id: done.id, status: "CANCELLED", note: "Never mind" });
    ok("a completed visit can't be cancelled", !cancelDone.ok && (await db.visit.findUniqueOrThrow({ where: { id: done.id } })).outcome === "Met the buyer", cancelDone);
    ok("  nor completed again", !(await visit.completeVisit({ id: done.id, outcome: "Rewritten" })).ok);
    ok("  nor set back to planned", !(await visit.setVisitStatus({ id: done.id, status: "PLANNED", note: "Again" })).ok);
    const cancelled = await visitOf("CANCELLED");
    ok("a cancelled visit can't be completed", !(await visit.completeVisit({ id: cancelled.id, outcome: "Went anyway" })).ok);
    const open = await visitOf("PLANNED");
    ok("an open one is cancelled", (await visit.setVisitStatus({ id: open.id, status: "CANCELLED", note: "Customer away" })).ok);

    section("SEC-66: a leaver's ID card");
    const token = await cards.idCardToken(leaver.id);
    ok("the card's address still names them", (await cards.userOfIdCardToken(token)) === leaver.id);
    const check = await cards.idCardCheck(leaver.id);
    ok("  and says it is no longer valid, showing no photo or designation", check?.valid === false && check.photoDataUrl === null && check.designation === null, check);
    // A lost card: replaced, the old card's address stops naming anybody and the new one does.
    await cards.reissueIdCard(leaver.id);
    const replaced = await cards.idCardToken(leaver.id);
    ok("a replaced card has a new address", replaced !== token && (await cards.userOfIdCardToken(replaced)) === leaver.id);
    ok("  and the old card's no longer checks out", (await cards.userOfIdCardToken(token)) === null);
  } finally {
    actor = null;
    viewingAs = false;
    await cleanup();
    const left = await db.user.count({ where: { email: { endsWith: MAIL } } });
    ok("nothing of the fixture is left behind", left === 0, left);
    await db.$disconnect();
  }

  console.log(failures === 0 ? `\nAll ${passes} group C audit-fix checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
