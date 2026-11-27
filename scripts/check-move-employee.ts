/**
 * check:move-employee — "Move to another account" on an employee record (owner, 31 Oct 2026 —
 * src/lib/hr/move-employee.ts, src/actions/move-employee.ts).
 *
 *   1. The preview: what moves per area, the day both accounts have, the empty balance that gives way,
 *      the reportee, the locked month, the manager carried.
 *   2. Refusals: the same account, a target with a record of its own, a source with none, two payslips
 *      for one month, a mover without payroll, a wrong confirmation, viewing as somebody.
 *   3. The move: everything on the new account, the old account's duplicate day gone and the new one's
 *      kept, the reportee and their pending leave handed over, the old account off and not deleted,
 *      the audit written.
 *   4. Reportees go only where the mover may put them (owner, 3 Nov 2026 — "Phase 2 permission fixes", audit M-5
 *      follow-up): each one handed over is a manager change, held to `assertMayChangeManager` as the user screen
 *      holds one — so somebody running HR and payroll who reaches no visits can't put a salesperson's reportee under
 *      the salesperson's new account, and nobody puts one into their own line. The plan says so, and the move takes
 *      exactly the people the plan names.
 *
 * Its own people, leave type and payroll month (January 1999), removed afterwards.
 *
 *   npm run check:move-employee
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor: { id: string; role: string; name: string; email: string } | null = null;
let viewingAs = false;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    return {
      requireUser: async () => {
        if (!actor) throw new Error("Unauthorized");
        return actor;
      },
      currentUser: async () => actor,
      viewAsContext: async () => (viewingAs ? { by: "x" } : null),
      refuseWhileViewingAs: async () => (viewingAs ? "Not while viewing as somebody else." : null),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const MAIL = "@zz-move.in";
const YEAR = 1999;
const LEAVE_CODE = "ZZMV";
// A custom role holding nothing at all, for a mover who holds only what they're granted (as check:confer's).
const NARROW_ROLE = "ZZMV_NARROW";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const d = (s: string) => new Date(`${s}T00:00:00Z`);

async function cleanup() {
  const users = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  const runs = (await db.payrollRun.findMany({ where: { year: YEAR }, select: { id: true } })).map((r) => r.id);
  if (runs.length) {
    await db.payslip.deleteMany({ where: { runId: { in: runs } } });
    await db.payrollRun.deleteMany({ where: { id: { in: runs } } });
  }
  if (users.length) {
    const mine = { userId: { in: users } };
    await db.auditLog.deleteMany({ where: { OR: [mine, { entityId: { in: users } }] } });
    await db.activityLog.deleteMany({ where: mine }).catch(() => {});
    await db.notification.deleteMany({ where: mine });
    await db.leaveRequest.deleteMany({ where: { OR: [mine, { approverId: { in: users } }] } });
    await db.leaveBalance.deleteMany({ where: mine });
    await db.attendanceDay.deleteMany({ where: mine });
    await db.salaryStructure.deleteMany({ where: mine });
    await db.expense.deleteMany({ where: mine });
    await db.employeeProfile.deleteMany({ where: mine });
    await db.userPermission.deleteMany({ where: mine });
    await db.user.updateMany({ where: { id: { in: users } }, data: { managerId: null } });
    await db.user.deleteMany({ where: { id: { in: users } } });
  }
  await db.leaveType.deleteMany({ where: { code: LEAVE_CODE } });
  await db.rolePermission.deleteMany({ where: { role: NARROW_ROLE } });
  await db.role.deleteMany({ where: { key: NARROW_ROLE } });
}

async function main() {
  const { planEmployeeMove, moveEmployee } = await import("../src/lib/hr/move-employee");
  const { moveEmployeeRecord, moveTargets } = await import("../src/actions/move-employee");
  const { personPath } = await import("../src/lib/record-links");

  await cleanup();
  if (await db.payrollRun.count({ where: { year: YEAR } })) throw new Error(`A ${YEAR} payroll run is in the way.`);
  try {
    const mk = (name: string, local: string, role: string, extra: Record<string, unknown> = {}) =>
      db.user.create({ data: { name, email: `${local}${MAIL}`, passwordHash: "!", role, ...extra }, select: { id: true, name: true, email: true, role: true, userSeq: true } });
    const hr = await mk("Zz Move Hr", "hr", "ADMIN");
    const boss = await mk("Zz Move Boss", "boss", "SALES");
    const source = await mk("Zz Jitender Kumar", "jitender.kumar", "SALES", { managerId: boss.id });
    const target = await mk("Zz Jitender", "jitender", "SALES");
    const reportee = await mk("Zz Reportee", "reportee", "SALES", { managerId: source.id });
    const other = await mk("Zz Other With Record", "other", "SALES");
    const hrOnly = await mk("Zz Hr Only", "hronly", "SALES");
    await db.userPermission.create({ data: { userId: hrOnly.id, permission: "hr.manage", allowed: true, reason: "check:move-employee" } });

    await db.employeeProfile.create({ data: { userId: source.id, employeeCode: "ZZ-MV-154", designation: "Engineer" } });
    await db.employeeProfile.create({ data: { userId: other.id, employeeCode: "ZZ-MV-155" } });
    // As live's jitender@ had: the blank record Add staff makes for a job title. It gives way to the moved one.
    const blank = await db.employeeProfile.create({ data: { userId: target.id, designation: "IT Head" } });
    await db.salaryStructure.create({ data: { userId: source.id, effectiveFrom: d(`${YEAR}-01-01`), basic: 20000 } });
    const run = await db.payrollRun.create({ data: { month: 1, year: YEAR, status: "LOCKED", lockedAt: new Date() } });
    const figures = { monthDays: 31, paidDays: 31, basic: 20000, grossEarnings: 20000, totalDeductions: 0, netPay: 20000, employerCost: 20000 };
    await db.payslip.create({ data: { runId: run.id, userId: source.id, ...figures } });
    await db.attendanceDay.createMany({
      data: [
        { userId: source.id, date: d(`${YEAR}-01-04`), status: "PRESENT" },
        { userId: source.id, date: d(`${YEAR}-01-05`), status: "ABSENT" },
        { userId: source.id, date: d(`${YEAR}-01-06`), status: "PRESENT" },
        { userId: target.id, date: d(`${YEAR}-01-05`), status: "WORK_FROM_HOME" },
      ],
    });
    const type = await db.leaveType.create({ data: { code: LEAVE_CODE, name: "Zz Move Leave", annualQuota: 12 } });
    await db.leaveBalance.create({ data: { userId: source.id, typeId: type.id, year: YEAR, opening: 5 } });
    await db.leaveBalance.create({ data: { userId: target.id, typeId: type.id, year: YEAR, credited: 1 } });
    await db.leaveRequest.create({ data: { userId: source.id, typeId: type.id, fromDate: d(`${YEAR}-01-10`), toDate: d(`${YEAR}-01-10`), days: 1, reason: "zz", status: "APPROVED" } });
    const pendingFromReportee = await db.leaveRequest.create({
      data: { userId: reportee.id, typeId: type.id, fromDate: d(`${YEAR}-01-11`), toDate: d(`${YEAR}-01-11`), days: 1, reason: "zz", approverId: source.id },
    });
    const claim = await db.expense.create({ data: { userId: source.id, amount: 450, spentOn: d(`${YEAR}-01-07`), description: "Zz cab" } });

    section("1. The preview");
    const planned = await planEmployeeMove(source.id, target.id, hr.id);
    ok("a plan for the move", planned.ok, planned.ok ? "" : planned.error);
    if (!planned.ok) return;
    const plan = planned.plan;
    const line = (key: string) => plan.lines.find((l) => l.key === key);
    ok("  the record, its salary, its payslip and its claim move", line("employeeProfile")?.moving === 1 && line("salaryStructures")?.moving === 1 && line("payslips")?.moving === 1 && line("expenses")?.moving === 1, plan.lines.filter((l) => l.moving));
    ok("  two attendance days move, one is dropped", line("attendanceDays")?.moving === 2 && line("attendanceDays")?.dropped === 1, line("attendanceDays"));
    ok("  the dropped day is named, with what each account had", plan.dropped.length === 1 && plan.dropped[0].date === `${YEAR}-01-05` && plan.dropped[0].source === "ABSENT" && plan.dropped[0].kept === "WORK_FROM_HOME", plan.dropped);
    ok("  the new account's empty leave balance gives way", line("leaveBalances")?.moving === 1 && plan.replaced.some((r) => r.includes("Zz Move Leave")), plan.replaced);
    ok("  the new account's blank record gives way too, and says so", plan.replaced.some((r) => r.includes("blank employee record")) && plan.replaced.length === 2, plan.replaced);
    ok("  the leave request moves", line("leaveRequests")?.moving === 1);
    ok("  the reportee and the leave waiting on the old account", plan.reportees.length === 1 && plan.reportees[0].id === reportee.id && plan.pendingApprovals === 1, { reportees: plan.reportees, pending: plan.pendingApprovals });
    ok("  the locked month is listed, and doesn't stop the move", plan.lockedMonths.includes(`Jan ${YEAR}`) && plan.blockers.length === 0, { locked: plan.lockedMonths, blockers: plan.blockers });
    ok("  the new account takes the old one's manager", plan.carried.some((c) => c.label === "Reports to" && c.value === boss.name), plan.carried);
    ok("  the preview changed nothing", (await db.employeeProfile.findUnique({ where: { userId: source.id } })) !== null && (await db.attendanceDay.count({ where: { userId: source.id } })) === 3);

    section("2. Refusals");
    const same = await planEmployeeMove(source.id, source.id, hr.id);
    ok("the same account", !same.ok);
    const twoRecords = await planEmployeeMove(source.id, other.id, hr.id);
    ok("  a target with a record of its own: two records, nothing automatic", !twoRecords.ok && twoRecords.error.includes("already has an employee record"), twoRecords);
    const noRecord = await planEmployeeMove(reportee.id, boss.id, hr.id);
    ok("  a source with no record", !noRecord.ok && noRecord.error.includes("no employee record"), noRecord);
    const clash = await db.payslip.create({ data: { runId: run.id, userId: target.id, ...figures } });
    const twoPayslips = await moveEmployee(source.id, target.id, hr.id, { switchOffSource: true, handOverReportees: true });
    ok("  two payslips for one locked month refuse, naming it", !twoPayslips.ok && twoPayslips.error.includes(`Jan ${YEAR}`), twoPayslips);
    ok("    and nothing moved", (await db.employeeProfile.findUnique({ where: { userId: source.id } })) !== null);
    await db.payslip.delete({ where: { id: clash.id } });

    actor = { id: hrOnly.id, name: hrOnly.name, email: hrOnly.email, role: hrOnly.role };
    const noPayroll = await moveEmployeeRecord({ fromUserId: source.id, toUserId: target.id, confirmEmail: target.email, switchOffSource: true, handOverReportees: true });
    ok("  managing people records without payroll isn't enough", !noPayroll.ok, noPayroll);
    ok("    and offers nobody to move to", (await moveTargets(source.id)).length === 0);
    actor = { id: hr.id, name: hr.name, email: hr.email, role: hr.role };
    const offered = await moveTargets(source.id);
    ok("HR with payroll is offered the target, not an account with a record", offered.some((p) => p.id === target.id) && !offered.some((p) => p.id === other.id || p.id === source.id));
    const wrong = await moveEmployeeRecord({ fromUserId: source.id, toUserId: target.id, confirmEmail: source.email, switchOffSource: true, handOverReportees: true });
    ok("  the wrong email typed is refused", !wrong.ok && wrong.error.includes(target.email), wrong);
    viewingAs = true;
    const asOther = await moveEmployeeRecord({ fromUserId: source.id, toUserId: target.id, confirmEmail: target.email, switchOffSource: true, handOverReportees: true });
    viewingAs = false;
    ok("  not while viewing as somebody", !asOther.ok, asOther);

    section("3. The move");
    const moved = await moveEmployeeRecord({ fromUserId: source.id, toUserId: target.id, confirmEmail: ` ${target.email.toUpperCase()} `, switchOffSource: true, handOverReportees: true });
    ok("it moves, and goes to the person under the new account", moved.ok && moved.data.path === personPath(target.userSeq) && moved.data.switchedOff && moved.data.reporteesMoved === 1, moved);

    const profile = await db.employeeProfile.findFirst({ where: { employeeCode: "ZZ-MV-154" }, select: { userId: true, designation: true } });
    ok("  the record is on the new account, code and all", profile?.userId === target.id && profile.designation === "Engineer", profile);
    ok("  the blank record is gone, one record on the new account", (await db.employeeProfile.count({ where: { id: blank.id } })) === 0 && (await db.employeeProfile.count({ where: { userId: target.id } })) === 1);
    ok("  the old account has no record left", (await db.employeeProfile.count({ where: { userId: source.id } })) === 0);
    ok("  salary and the locked payslip are the new account's, figures untouched", (await db.salaryStructure.count({ where: { userId: target.id } })) === 1 && Number((await db.payslip.findFirst({ where: { runId: run.id, userId: target.id } }))?.netPay) === 20000);
    const days = await db.attendanceDay.findMany({ where: { userId: target.id, date: { gte: d(`${YEAR}-01-01`), lte: d(`${YEAR}-01-31`) } }, select: { date: true, status: true }, orderBy: { date: "asc" } });
    ok("  three days on the new account, its own on the 5th kept", days.length === 3 && days[1].status === "WORK_FROM_HOME", days);
    ok("  none left on the old account", (await db.attendanceDay.count({ where: { userId: source.id } })) === 0);
    const balances = await db.leaveBalance.findMany({ where: { typeId: type.id }, select: { userId: true, opening: true } });
    ok("  one leave balance, the old account's opening of 5, on the new account", balances.length === 1 && balances[0].userId === target.id && Number(balances[0].opening) === 5, balances);
    ok("  the leave request and the expense claim moved", (await db.leaveRequest.count({ where: { userId: target.id } })) === 1 && (await db.expense.findUnique({ where: { id: claim.id } }))?.userId === target.id);
    ok("  the reportee reports to the new account; their leave waits on it", (await db.user.findUnique({ where: { id: reportee.id } }))?.managerId === target.id && (await db.leaveRequest.findUnique({ where: { id: pendingFromReportee.id } }))?.approverId === target.id);
    ok("  the new account reports to the old one's manager", (await db.user.findUnique({ where: { id: target.id } }))?.managerId === boss.id);
    const old = await db.user.findUnique({ where: { id: source.id }, select: { active: true } });
    ok("  the old account is switched off, not deleted", old !== null && old.active === false, old);
    const audit = await db.auditLog.findFirst({ where: { userId: hr.id, entityType: "EmployeeProfile", entityId: target.id }, orderBy: { createdAt: "desc" } });
    ok("  the audit says what moved", Boolean(audit?.entityLabel.includes(source.email) && audit.entityLabel.includes(target.email) && audit.entityLabel.includes("attendance days") && audit.entityLabel.includes("switched off")), audit?.entityLabel);
    const again = await planEmployeeMove(source.id, target.id, hr.id);
    ok("  a second move finds nothing to move", !again.ok, again);

    section("4. Reportees go only where the mover may put them (audit M-5 follow-up)");
    // Runs HR and payroll and nothing else: reaches no visits, where a salesperson reaches their team's.
    await db.role.create({ data: { key: NARROW_ROLE, name: "Zz Move Narrow", isSystem: false } });
    const narrow = await mk("Zz Move Narrow", "narrow", NARROW_ROLE);
    await db.userPermission.createMany({ data: ["hr.manage", "payroll.manage"].map((permission) => ({ userId: narrow.id, permission, allowed: true, reason: "check:move-employee" })) });
    // The old account saw no visits by team either, so its reportee under the new (sales) account is a new reach — not
    // succession (guards.ts `succeeding`), which the next case shows.
    const oldLogin = await mk("Zz Second Old", "second.old", NARROW_ROLE);
    const newLogin = await mk("Zz Second New", "second.new", "SALES");
    const report2 = await mk("Zz Second Reportee", "second.reportee", "SALES", { managerId: oldLogin.id });
    await db.employeeProfile.create({ data: { userId: oldLogin.id, employeeCode: "ZZ-MV-156" } });

    const narrowPlan = await planEmployeeMove(oldLogin.id, newLogin.id, narrow.id);
    ok(
      "the plan for a mover reaching narrower by team than the new account, from an old account that didn't reach that far either, names no reportee to hand over",
      narrowPlan.ok && narrowPlan.plan.reportees.length === 0,
      narrowPlan.ok ? narrowPlan.plan.reportees : narrowPlan.error,
    );
    ok(
      "  and says who stays with the old account, and why",
      narrowPlan.ok && narrowPlan.plan.reporteesRefused?.length === 1 && narrowPlan.plan.reporteesRefused[0]!.id === report2.id && /by team, wider than you reach/.test(narrowPlan.plan.reporteesRefused[0]!.reason),
      narrowPlan.ok ? narrowPlan.plan.reporteesRefused : "",
    );
    ok("  the record itself still moves — nothing blocks it", narrowPlan.ok && narrowPlan.plan.blockers.length === 0, narrowPlan.ok ? narrowPlan.plan.blockers : "");
    const widePlan = await planEmployeeMove(oldLogin.id, newLogin.id, hr.id);
    ok("an admin reaching everything is offered the same reportee", widePlan.ok && widePlan.plan.reportees.some((r) => r.id === report2.id) && widePlan.plan.reporteesRefused.length === 0, widePlan.ok ? widePlan.plan.reportees : widePlan.error);

    actor = { id: narrow.id, name: narrow.name, email: narrow.email, role: narrow.role };
    // Security audit, 11 Nov 2026 (SEC-38): switching the old login off is users.manage's, which the narrow mover lacks.
    const switchingOff = await moveEmployeeRecord({ fromUserId: oldLogin.id, toUserId: newLogin.id, confirmEmail: newLogin.email, switchOffSource: true, handOverReportees: true });
    ok("the narrow mover can't switch the old login off — that takes managing users", !switchingOff.ok && /managing users/.test(switchingOff.error), switchingOff);
    const narrowMove = await moveEmployeeRecord({ fromUserId: oldLogin.id, toUserId: newLogin.id, confirmEmail: newLogin.email, switchOffSource: false, handOverReportees: true });
    actor = { id: hr.id, name: hr.name, email: hr.email, role: hr.role };
    ok("the narrow mover moves the record, handing over nobody", narrowMove.ok && narrowMove.data.reporteesMoved === 0, narrowMove);
    ok("  the reportee still reports to the old account", (await db.user.findUnique({ where: { id: report2.id } }))?.managerId === oldLogin.id);
    ok("  while the record is on the new one", (await db.employeeProfile.findFirst({ where: { employeeCode: "ZZ-MV-156" }, select: { userId: true } }))?.userId === newLogin.id);
    const narrowAudit = await db.auditLog.findFirst({ where: { userId: narrow.id, entityType: "EmployeeProfile", entityId: newLogin.id }, orderBy: { createdAt: "desc" } });
    ok("  and the audit says who was left, and why", Boolean(narrowAudit?.entityLabel.includes(`${report2.name} left with the old account`)), narrowAudit?.entityLabel);

    // Succession: a salesperson's record moving to their new sales login takes their reportee with it, whoever moves
    // it — the old login saw the reportee's visits by team, so the new one may.
    const fourOld = await mk("Zz Fourth Old", "fourth.old", "SALES");
    const fourNew = await mk("Zz Fourth New", "fourth.new", "SALES");
    const report4 = await mk("Zz Fourth Reportee", "fourth.reportee", "SALES", { managerId: fourOld.id });
    await db.employeeProfile.create({ data: { userId: fourOld.id, employeeCode: "ZZ-MV-158" } });
    const succession = await planEmployeeMove(fourOld.id, fourNew.id, narrow.id);
    ok("a salesperson's own reportee moves with them to their new sales login, even for the narrow mover — succession", succession.ok && succession.plan.reportees.some((r) => r.id === report4.id) && succession.plan.reporteesRefused.length === 0, succession.ok ? succession.plan : succession.error);

    // Nobody puts somebody into their own line: the new account reports to the admin moving the record.
    const thirdOld = await mk("Zz Third Old", "third.old", "SALES");
    const thirdNew = await mk("Zz Third New", "third.new", "SALES", { managerId: hr.id });
    const report3 = await mk("Zz Third Reportee", "third.reportee", "SALES", { managerId: thirdOld.id });
    await db.employeeProfile.create({ data: { userId: thirdOld.id, employeeCode: "ZZ-MV-157" } });
    const ownLine = await planEmployeeMove(thirdOld.id, thirdNew.id, hr.id);
    ok(
      "an admin reaching everything still can't hand a reportee to an account reporting to them",
      ownLine.ok && ownLine.plan.reportees.length === 0 && ownLine.plan.reporteesRefused?.[0]?.id === report3.id && /your own reporting line/.test(ownLine.plan.reporteesRefused[0]!.reason),
      ownLine.ok ? ownLine.plan.reporteesRefused : ownLine.error,
    );
  } finally {
    actor = null;
    await cleanup();
  }
}

main()
  .then(async () => {
    console.log(`\n${passes} passed, ${failures} failed`);
    await db.$disconnect();
    process.exit(failures ? 1 : 0);
  })
  .catch(async (err) => {
    console.error(err);
    await db.$disconnect().catch(() => {});
    process.exit(1);
  });
