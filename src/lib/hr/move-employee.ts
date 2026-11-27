import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { accountsChanged } from "@/lib/platform/account-hooks";
import { actorContext, assertMayChangeManager, AuthzError } from "@/lib/authz/guards";

/**
 * Moving an employee record to another account (owner, 31 Oct 2026).
 *
 * The case that asked for it: the Kredily import put WT/154's record on `jitender.kumar@…`, while
 * the person signs in as `jitender@…`. Everything HR is keyed by the account (`userId`), so the fix
 * is a re-keying of the person's HR life — record, attendance, leave, payroll, claims, file, assets —
 * from one account to the other, in one transaction, with a preview first.
 *
 * What moves is the person's HR life only. What the old account *did* — leads it owns, approvals it
 * gave, audit and sign-ins, notifications, devices, chats — stays with it: those are the account's
 * history, and the account the person really uses already carries their working life.
 *
 * Server only. The caller (src/actions/move-employee.ts) decides who may.
 */

type Client = Prisma.TransactionClient;

/** A table that moves as a plain re-keying: nothing unique hangs on the person in it. */
type SimpleModel =
  | "attendanceLocation"
  | "attendanceException"
  | "attendanceRegularisation"
  | "biometricPunch"
  | "leaveRequest"
  | "shortLeaveRequest"
  | "salaryStructure"
  | "employeeLoan"
  | "incentiveEarning"
  | "expense"
  | "employeeDocument"
  | "employmentHistory"
  | "employeeLetter"
  | "employeeFileVisibility"
  | "task"
  | "resignation"
  | "goal"
  | "asset"
  | "fixedAsset"
  | "assetMovement"
  | "candidate";

type Delegate = {
  count(args: { where: Record<string, unknown> }): Promise<number>;
  updateMany(args: { where: Record<string, unknown>; data: Record<string, unknown> }): Promise<{ count: number }>;
};

const SIMPLE: { key: string; area: string; label: string; model: SimpleModel; field: string }[] = [
  { key: "attendanceLocations", area: "Attendance", label: "Check-in locations", model: "attendanceLocation", field: "userId" },
  { key: "attendanceExceptions", area: "Attendance", label: "Location exceptions", model: "attendanceException", field: "userId" },
  { key: "regularisations", area: "Attendance", label: "Regularisation requests", model: "attendanceRegularisation", field: "userId" },
  { key: "biometricPunches", area: "Attendance", label: "Biometric punches", model: "biometricPunch", field: "userId" },
  { key: "leaveRequests", area: "Leave", label: "Leave requests", model: "leaveRequest", field: "userId" },
  { key: "shortLeaves", area: "Leave", label: "Short leave requests", model: "shortLeaveRequest", field: "userId" },
  { key: "salaryStructures", area: "Payroll", label: "Salary structures", model: "salaryStructure", field: "userId" },
  { key: "loans", area: "Payroll", label: "Loans and advances", model: "employeeLoan", field: "userId" },
  { key: "incentives", area: "Payroll", label: "Incentive earnings", model: "incentiveEarning", field: "userId" },
  { key: "expenses", area: "Expenses", label: "Expense claims", model: "expense", field: "userId" },
  { key: "documents", area: "Employee file", label: "Documents", model: "employeeDocument", field: "userId" },
  { key: "employmentHistory", area: "Employee file", label: "Previous employment", model: "employmentHistory", field: "userId" },
  { key: "letters", area: "Employee file", label: "Letters", model: "employeeLetter", field: "userId" },
  { key: "fileVisibility", area: "Employee file", label: "Payslip and letter visibility", model: "employeeFileVisibility", field: "userId" },
  { key: "hrTasks", area: "Employee file", label: "Onboarding and offboarding tasks", model: "task", field: "aboutUserId" },
  { key: "resignations", area: "Employee file", label: "Resignations", model: "resignation", field: "userId" },
  { key: "goals", area: "Performance & learning", label: "Goals", model: "goal", field: "userId" },
  { key: "itAssets", area: "Assets", label: "IT assets held", model: "asset", field: "custodianUserId" },
  { key: "fixedAssets", area: "Assets", label: "Fixed assets held", model: "fixedAsset", field: "custodianUserId" },
  { key: "assetMovesFrom", area: "Assets", label: "Asset hand-backs", model: "assetMovement", field: "fromUserId" },
  { key: "assetMovesTo", area: "Assets", label: "Asset hand-outs", model: "assetMovement", field: "toUserId" },
  { key: "referrals", area: "Referrals", label: "Candidates referred", model: "candidate", field: "referredById" },
];

const delegate = (c: Client, model: SimpleModel) => c[model] as unknown as Delegate;

export type MoveLine = { key: string; area: string; label: string; moving: number; dropped: number };
/** A row of the old account's that can't move because the new one already has its own for that day. */
export type DroppedRow = { kind: "Attendance day" | "Roster day" | "Shift from"; date: string; source: string; kept: string };
export type MovePerson = { id: string; name: string; email: string };

export type MovePlan = {
  from: MovePerson & { active: boolean; isSuperAdmin: boolean; employeeCode: string | null };
  to: MovePerson;
  lines: MoveLine[];
  dropped: DroppedRow[];
  /** Rows of the new account's that give way to the old one's — each empty, or the lesser of the two. */
  replaced: string[];
  /** User-level fields the person record reads, put on the new account where it has none. */
  carried: { label: string; value: string }[];
  reportees: { id: string; name: string }[];
  /** Reportees left where they are: handing them over would make a loop in the reporting lines. */
  reporteesLooping: { id: string; name: string }[];
  /**
   * Reportees left where they are: whoever moves the record may not make the new account their manager, and why
   * (src/lib/authz/guards.ts `assertMayChangeManager`; owner, 3 Nov 2026 — "Phase 2 permission fixes", audit M-5
   * follow-up). `reportees` is only the ones who do move.
   */
  reporteesRefused: { id: string; name: string; reason: string }[];
  pendingApprovals: number;
  /** Payslips in locked or paid months, which move with their figures untouched. */
  lockedMonths: string[];
  /** Why the move can't go ahead as it stands. Empty when it can. */
  blockers: string[];
};

export type PlanResult = { ok: true; plan: MovePlan } | { ok: false; error: string };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const monthLabel = (month: number, year: number) => `${MONTHS[month - 1]} ${year}`;
const day = (d: Date) => d.toISOString().slice(0, 10);
const n = (v: Prisma.Decimal | number | null | undefined) => Number(v ?? 0);

/**
 * A record with nothing in it but a job title or work location — what Add staff and Edit profile make for
 * an account given a job title. It isn't a second record of the person's, so it doesn't stop a move: the
 * moved record takes its place (owner, 31 Oct 2026: jitender@ had one, and the picker left him out).
 * Anything else filled in — a code, a joining date, a bank account — is a real record and still refuses.
 */
export const BLANK_RECORD = {
  employeeCode: null,
  biometricId: null,
  joinedOn: null,
  probationEndsOn: null,
  confirmedOn: null,
  exitedOn: null,
  exitType: null,
  exitReason: null,
  dateOfBirth: null,
  gender: null,
  bloodGroup: null,
  maritalStatus: null,
  personalEmail: null,
  personalPhone: null,
  addressLine1: null,
  addressLine2: null,
  city: null,
  state: null,
  pincode: null,
  emergencyContactName: null,
  emergencyContactPhone: null,
  emergencyContactRelation: null,
  panNumber: null,
  aadhaarLast4: null,
  uanNumber: null,
  pfNumber: null,
  esicNumber: null,
  bankName: null,
  bankAccountNumber: null,
  bankIfsc: null,
} satisfies Prisma.EmployeeProfileWhereInput;

type Analysis = {
  plan: MovePlan;
  /** The new account's blank record (BLANK_RECORD), deleted for the moved one to take its place. */
  toBlankRecordId: string | null;
  /** What the move deletes before re-keying: the old account's duplicate days, the new one's emptier rows. */
  drop: {
    attendanceDays: string[];
    rosterDays: string[];
    shiftAssignments: string[];
    leaveBalances: string[];
    reviews: string[];
    courses: string[];
  };
  toManagerId: string | null | undefined;
  carry: { departmentId?: string; branchId?: string };
};

const personSelect = { id: true, name: true, email: true, active: true, isSuperAdmin: true, departmentId: true, branchId: true, managerId: true } as const;

/** The managers above `userId`, nearest first, read inside the transaction. */
async function ancestorsOf(c: Client, userId: string | null): Promise<Set<string>> {
  const seen = new Set<string>();
  let current = userId;
  for (let depth = 0; current && depth < 50 && !seen.has(current); depth += 1) {
    seen.add(current);
    const row: { managerId: string | null } | null = await c.user.findUnique({ where: { id: current }, select: { managerId: true } });
    current = row?.managerId ?? null;
  }
  return seen;
}

async function analyse(c: Client, fromUserId: string, toUserId: string, actorId: string): Promise<{ ok: true; analysis: Analysis } | { ok: false; error: string }> {
  if (fromUserId === toUserId) return { ok: false, error: "That is the account the record is already on." };
  const [from, to] = await Promise.all([
    c.user.findUnique({ where: { id: fromUserId }, select: { ...personSelect, kind: true, employeeProfile: { select: { id: true, employeeCode: true } }, department: { select: { name: true } }, branch: { select: { name: true } }, manager: { select: { name: true } } } }),
    c.user.findUnique({ where: { id: toUserId }, select: { ...personSelect, kind: true, employeeProfile: { select: { id: true } } } }),
  ]);
  const toBlank = to?.employeeProfile ? await c.employeeProfile.findFirst({ where: { id: to.employeeProfile.id, ...BLANK_RECORD }, select: { id: true } }) : null;
  if (!from) return { ok: false, error: "The account the record is on no longer exists." };
  if (!to || to.kind !== "MEMBER") return { ok: false, error: "That account no longer exists." };
  if (!from.employeeProfile) return { ok: false, error: `${from.name} has no employee record to move.` };
  // Two records for one person is a judgement call — which joining date, which bank account — not
  // something to settle by picking one automatically (owner, 31 Oct 2026).
  if (to.employeeProfile && !toBlank) {
    return { ok: false, error: `${to.name} (${to.email}) already has an employee record of their own. Two records for one person have to be put together by hand — move nothing until one of them is cleared.` };
  }
  if (!to.active) return { ok: false, error: `${to.email} is switched off. Switch it on first — the record should go to the account the person signs in with.` };

  const blockers: string[] = [];
  const lines: MoveLine[] = [];
  const dropped: DroppedRow[] = [];
  const replaced: string[] = [];
  if (toBlank) replaced.push(`${to.email}'s blank employee record (a job title at most)`);
  const drop: Analysis["drop"] = { attendanceDays: [], rosterDays: [], shiftAssignments: [], leaveBalances: [], reviews: [], courses: [] };

  lines.push({ key: "employeeProfile", area: "Employee record", label: "Employee record", moving: 1, dropped: 0 });

  // Attendance days: one a day each. Where both accounts kept one, the account the person really signs
  // in with was the one they punched on, so its day stands and the old account's is reported dropped.
  // Its check-in locations still move — they are the raw evidence, and keyed by no day.
  const targetDays = await c.attendanceDay.findMany({ where: { userId: toUserId }, select: { date: true, status: true } });
  const targetDayByDate = new Map(targetDays.map((d) => [day(d.date), d.status as string]));
  const sourceDays = await c.attendanceDay.findMany({ where: { userId: fromUserId }, select: { id: true, date: true, status: true } });
  for (const d of sourceDays) {
    const kept = targetDayByDate.get(day(d.date));
    if (kept === undefined) continue;
    drop.attendanceDays.push(d.id);
    dropped.push({ kind: "Attendance day", date: day(d.date), source: d.status, kept });
  }
  lines.push({ key: "attendanceDays", area: "Attendance", label: "Attendance days", moving: sourceDays.length - drop.attendanceDays.length, dropped: drop.attendanceDays.length });

  const targetRoster = new Map((await c.rosterDay.findMany({ where: { userId: toUserId }, select: { date: true, shiftId: true } })).map((r) => [day(r.date), r.shiftId ? "a shift" : "off"]));
  const sourceRoster = await c.rosterDay.findMany({ where: { userId: fromUserId }, select: { id: true, date: true, shiftId: true } });
  for (const r of sourceRoster) {
    const kept = targetRoster.get(day(r.date));
    if (kept === undefined) continue;
    drop.rosterDays.push(r.id);
    dropped.push({ kind: "Roster day", date: day(r.date), source: r.shiftId ? "a shift" : "off", kept });
  }
  lines.push({ key: "rosterDays", area: "Attendance", label: "Roster days", moving: sourceRoster.length - drop.rosterDays.length, dropped: drop.rosterDays.length });

  const targetShifts = new Map((await c.shiftAssignment.findMany({ where: { userId: toUserId }, select: { fromDate: true, shift: { select: { name: true } } } })).map((s) => [day(s.fromDate), s.shift.name]));
  const sourceShifts = await c.shiftAssignment.findMany({ where: { userId: fromUserId }, select: { id: true, fromDate: true, shift: { select: { name: true } } } });
  for (const s of sourceShifts) {
    const kept = targetShifts.get(day(s.fromDate));
    if (kept === undefined) continue;
    drop.shiftAssignments.push(s.id);
    dropped.push({ kind: "Shift from", date: day(s.fromDate), source: s.shift.name, kept });
  }
  lines.push({ key: "shiftAssignments", area: "Attendance", label: "Shift assignments", moving: sourceShifts.length - drop.shiftAssignments.length, dropped: drop.shiftAssignments.length });

  // Leave balances: one a type a year. The new account's, never having had an employee record, is
  // normally the empty row the leave page opens on first look — that gives way to the old account's,
  // which carries the openings brought from the old system. One something was taken or corrected
  // against is a real balance, and two real balances are HR's to reconcile, not this.
  // Selected column by column: the typed-opening columns are not in every workspace yet.
  const balanceSelect = { id: true, typeId: true, year: true, used: true, adjustment: true, type: { select: { name: true } } } as const;
  const [sourceBalances, targetBalances] = await Promise.all([
    c.leaveBalance.findMany({ where: { userId: fromUserId }, select: balanceSelect }),
    c.leaveBalance.findMany({ where: { userId: toUserId }, select: balanceSelect }),
  ]);
  const targetBalance = new Map(targetBalances.map((b) => [`${b.typeId}|${b.year}`, b]));
  for (const b of sourceBalances) {
    const theirs = targetBalance.get(`${b.typeId}|${b.year}`);
    if (!theirs) continue;
    if (n(theirs.used) === 0 && n(theirs.adjustment) === 0) {
      drop.leaveBalances.push(theirs.id);
      replaced.push(`${to.email}'s empty ${b.type.name} balance for ${b.year}`);
    } else {
      blockers.push(`Both accounts have a ${b.type.name} balance for ${b.year} with leave taken or adjusted. Settle one of them first.`);
    }
  }
  lines.push({ key: "leaveBalances", area: "Leave", label: "Leave balances", moving: sourceBalances.length, dropped: 0 });

  // Payslips: one a payroll month each. A month's payslip can't be dropped or merged, so two of them
  // refuse the move. A locked or paid month does not: its lock keeps the figures from changing
  // (setPayrollStatus, lockedRunFrom), and re-keying the payslip's owner changes no figure and no
  // posting — the payroll journal's lines name no person, only accounts and a cost centre. Payslips
  // from locked months are listed so whoever moves them knows (owner, 31 Oct 2026).
  const sourcePayslips = await c.payslip.findMany({ where: { userId: fromUserId }, select: { runId: true, run: { select: { month: true, year: true, status: true } } } });
  const targetRuns = new Set((await c.payslip.findMany({ where: { userId: toUserId }, select: { runId: true } })).map((p) => p.runId));
  const lockedMonths: string[] = [];
  for (const p of sourcePayslips) {
    if (targetRuns.has(p.runId)) blockers.push(`Both accounts have a payslip for ${monthLabel(p.run.month, p.run.year)}. One of them has to come out of that payroll first.`);
    if (p.run.status !== "DRAFT") lockedMonths.push(monthLabel(p.run.month, p.run.year));
  }
  lines.push({ key: "payslips", area: "Payroll", label: "Payslips", moving: sourcePayslips.length, dropped: 0 });

  const sourceTax = await c.taxDeclaration.findMany({ where: { userId: fromUserId }, select: { taxYear: true } });
  const targetTax = new Set((await c.taxDeclaration.findMany({ where: { userId: toUserId }, select: { taxYear: true } })).map((t) => t.taxYear));
  for (const t of sourceTax) {
    if (targetTax.has(t.taxYear)) blockers.push(`Both accounts have a tax declaration for ${t.taxYear}–${String((t.taxYear + 1) % 100).padStart(2, "0")}. Keep one first.`);
  }
  lines.push({ key: "taxDeclarations", area: "Payroll", label: "Tax declarations", moving: sourceTax.length, dropped: 0 });

  const [sourceSettlement, targetSettlement] = await Promise.all([
    c.finalSettlement.count({ where: { userId: fromUserId } }),
    c.finalSettlement.count({ where: { userId: toUserId } }),
  ]);
  if (sourceSettlement && targetSettlement) blockers.push("Both accounts have a full & final settlement. Keep one first.");
  lines.push({ key: "settlement", area: "Payroll", label: "Full & final settlement", moving: sourceSettlement, dropped: 0 });

  // Reviews: one a cycle each. One nobody has started gives way to the other; two worked on refuse.
  const reviewSelect = { id: true, cycleId: true, status: true, selfRating: true, managerRating: true, cycle: { select: { name: true } } } as const;
  const [sourceReviews, targetReviews] = await Promise.all([
    c.performanceReview.findMany({ where: { userId: fromUserId }, select: reviewSelect }),
    c.performanceReview.findMany({ where: { userId: toUserId }, select: reviewSelect }),
  ]);
  const started = (r: (typeof sourceReviews)[number]) => r.status !== "AWAITING_SELF" || r.selfRating != null || r.managerRating != null;
  const targetReview = new Map(targetReviews.map((r) => [r.cycleId, r]));
  let reviewsDropped = 0;
  for (const r of sourceReviews) {
    const theirs = targetReview.get(r.cycleId);
    if (!theirs) continue;
    if (!started(r)) {
      drop.reviews.push(r.id);
      reviewsDropped += 1;
    } else if (!started(theirs)) {
      drop.reviews.push(theirs.id);
      replaced.push(`${to.email}'s unstarted review in ${r.cycle.name}`);
    } else {
      blockers.push(`Both accounts have a review under way in ${r.cycle.name}. Close one first.`);
    }
  }
  lines.push({ key: "reviews", area: "Performance & learning", label: "Performance reviews", moving: sourceReviews.length - reviewsDropped, dropped: reviewsDropped });

  const [sourceInsurance, targetInsurance] = await Promise.all([
    c.insuranceMember.findMany({ where: { userId: fromUserId }, select: { policyId: true, policy: { select: { name: true } } } }),
    c.insuranceMember.findMany({ where: { userId: toUserId }, select: { policyId: true } }),
  ]);
  const insured = new Set(targetInsurance.map((m) => m.policyId));
  for (const m of sourceInsurance) {
    if (insured.has(m.policyId)) blockers.push(`Both accounts are covered under ${m.policy.name}. Take one off the policy first.`);
  }
  lines.push({ key: "insurance", area: "Performance & learning", label: "Insurance cover", moving: sourceInsurance.length, dropped: 0 });

  // Courses: one assignment a course. The completed one stands; otherwise the new account's.
  const courseSelect = { id: true, courseId: true, completedAt: true } as const;
  const [sourceCourses, targetCourses] = await Promise.all([
    c.courseAssignment.findMany({ where: { userId: fromUserId }, select: courseSelect }),
    c.courseAssignment.findMany({ where: { userId: toUserId }, select: courseSelect }),
  ]);
  const targetCourse = new Map(targetCourses.map((a) => [a.courseId, a]));
  let coursesDropped = 0;
  for (const a of sourceCourses) {
    const theirs = targetCourse.get(a.courseId);
    if (!theirs) continue;
    if (a.completedAt && !theirs.completedAt) {
      drop.courses.push(theirs.id);
      replaced.push(`${to.email}'s unfinished assignment of a course the old account completed`);
    } else {
      drop.courses.push(a.id);
      coursesDropped += 1;
    }
  }
  lines.push({ key: "courses", area: "Performance & learning", label: "Courses assigned", moving: sourceCourses.length - coursesDropped, dropped: coursesDropped });

  const [sourceHire, targetHire] = await Promise.all([
    c.candidate.count({ where: { convertedUserId: fromUserId } }),
    c.candidate.count({ where: { convertedUserId: toUserId } }),
  ]);
  if (sourceHire && targetHire) blockers.push("Both accounts were hired from a candidate record. Unlink one first.");
  lines.push({ key: "hiredFrom", area: "Referrals", label: "Hired-from candidate", moving: sourceHire, dropped: 0 });

  for (const s of SIMPLE) {
    lines.push({ key: s.key, area: s.area, label: s.label, moving: await delegate(c, s.model).count({ where: { [s.field]: fromUserId } }), dropped: 0 });
  }

  // The user-level fields the person record reads: department, works-at branch, manager. Put on the
  // new account where it has none; a value it already has is the person's current one.
  const carried: MovePlan["carried"] = [];
  const carry: Analysis["carry"] = {};
  if (!to.departmentId && from.departmentId) {
    carry.departmentId = from.departmentId;
    carried.push({ label: "Department", value: from.department?.name ?? "" });
  }
  if (!to.branchId && from.branchId) {
    carry.branchId = from.branchId;
    carried.push({ label: "Works at", value: from.branch?.name ?? "" });
  }
  // The same person can't report to themselves: a new account that reported to the old one takes the
  // old one's manager. One with no manager takes it too — unless that would make a loop.
  let toManagerId: string | null | undefined;
  if (to.managerId === fromUserId || (!to.managerId && from.managerId)) {
    const candidate = from.managerId && from.managerId !== toUserId ? from.managerId : null;
    const loops = candidate ? (await ancestorsOf(c, candidate)).has(toUserId) : false;
    toManagerId = loops ? null : candidate;
    if (to.managerId !== toManagerId) carried.push({ label: "Reports to", value: toManagerId ? (from.manager?.name ?? "") : "nobody" });
    else toManagerId = undefined;
  }

  // Reportees, offered as part of the move. Anybody above the new account stays where they are:
  // reporting to it would close a loop.
  const above = await ancestorsOf(c, toManagerId !== undefined ? toManagerId : to.managerId);
  const directs = await c.user.findMany({ where: { managerId: fromUserId, id: { not: toUserId } }, select: { id: true, name: true, isSuperAdmin: true, managerId: true }, orderBy: { name: "asc" } });
  const reporteesLooping = directs.filter((r) => above.has(r.id)).map(({ id, name }) => ({ id, name }));
  /**
   * Each reportee handed over is a manager change, and a manager change is a grant: the new account, and everybody
   * above it who didn't have them already, reach their records wherever they reach by Team. So each is asked what the
   * user screen asks of one person (src/actions/user.ts `assignUser`) — never into the mover's own line, never under an
   * account reaching wider by team than the mover does. Here, in the plan, so the preview names only the people the
   * move will take and the move takes exactly those; anybody refused stays with the old account, as a loop does
   * (owner, 3 Nov 2026 — "Phase 2 permission fixes", audit M-5 follow-up).
   */
  const actor = await actorContext(actorId);
  const reportees: MovePlan["reportees"] = [];
  const reporteesRefused: MovePlan["reporteesRefused"] = [];
  for (const r of directs) {
    if (above.has(r.id)) continue;
    try {
      // Succession: the old account's own Team reach over them passes on with them (guards.ts `succeeding`).
      await assertMayChangeManager(actor, r, toUserId, { succeeding: fromUserId });
      reportees.push({ id: r.id, name: r.name });
    } catch (err) {
      if (!(err instanceof AuthzError)) throw err;
      reporteesRefused.push({ id: r.id, name: r.name, reason: err.message });
    }
  }
  const pending = { approverId: fromUserId, status: "PENDING" as const };
  const pendingApprovals =
    (await c.leaveRequest.count({ where: pending })) + (await c.attendanceRegularisation.count({ where: pending })) + (await c.shortLeaveRequest.count({ where: pending }));

  return {
    ok: true,
    analysis: {
      toBlankRecordId: toBlank?.id ?? null,
      plan: {
        from: { id: from.id, name: from.name, email: from.email, active: from.active, isSuperAdmin: from.isSuperAdmin, employeeCode: from.employeeProfile.employeeCode },
        to: { id: to.id, name: to.name, email: to.email },
        lines,
        dropped: dropped.sort((a, b) => a.date.localeCompare(b.date)),
        replaced,
        carried,
        reportees,
        reporteesLooping,
        reporteesRefused,
        pendingApprovals,
        lockedMonths: [...new Set(lockedMonths)],
        blockers,
      },
      drop,
      toManagerId,
      carry,
    },
  };
}

/**
 * The preview: per area, what moves and what is dropped, and anything that stops the move. `actorId` is whoever would
 * move it — which reportees go with the record depends on what they reach (`reporteesRefused`).
 */
export async function planEmployeeMove(fromUserId: string, toUserId: string, actorId: string): Promise<PlanResult> {
  const result = await db.$transaction((tx) => analyse(tx, fromUserId, toUserId, actorId), { timeout: 60_000 });
  return result.ok ? { ok: true, plan: result.analysis.plan } : result;
}

export type MoveOptions = {
  /** Switch the old account off afterwards. Never deleted: what it did stays attributed to it. */
  switchOffSource: boolean;
  /** The old account's reportees, and the leave it was asked to decide, go to the new account. */
  handOverReportees: boolean;
};

export type MoveResult = { ok: true; plan: MovePlan; switchedOff: boolean; reporteesMoved: number; approvalsMoved: number } | { ok: false; error: string };

/**
 * The move, in one transaction: the plan is worked out again inside it (so what is moved is what was
 * checked, not what the preview saw), duplicates dropped, every table re-keyed, the employee record
 * last — by then nothing else of the person's is left on the old account.
 */
export async function moveEmployee(fromUserId: string, toUserId: string, actorId: string, options: MoveOptions): Promise<MoveResult> {
  let switchedOff = false;
  let reporteesMoved = 0;
  let approvalsMoved = 0;
  const outcome = await db.$transaction(
    async (tx): Promise<{ ok: true; plan: MovePlan } | { ok: false; error: string }> => {
      // Both accounts held for the length of the move, so two moves can't cross.
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${fromUserId} FOR UPDATE`;
      await tx.$queryRaw`SELECT "id" FROM "users" WHERE "id" = ${toUserId} FOR UPDATE`;
      const analysed = await analyse(tx, fromUserId, toUserId, actorId);
      if (!analysed.ok) return analysed;
      const { plan, drop, carry, toManagerId, toBlankRecordId } = analysed.analysis;
      if (plan.blockers.length) return { ok: false, error: plan.blockers.join(" ") };
      if (options.switchOffSource && plan.from.isSuperAdmin) {
        return { ok: false, error: "The old account is the super admin's, which can't be switched off here. Untick “Switch off the old account”." };
      }
      if (options.switchOffSource && fromUserId === actorId) {
        return { ok: false, error: "That would switch off your own account. Untick “Switch off the old account”, or ask somebody else." };
      }

      if (drop.attendanceDays.length) await tx.attendanceDay.deleteMany({ where: { id: { in: drop.attendanceDays } } });
      if (drop.rosterDays.length) await tx.rosterDay.deleteMany({ where: { id: { in: drop.rosterDays } } });
      if (drop.shiftAssignments.length) await tx.shiftAssignment.deleteMany({ where: { id: { in: drop.shiftAssignments } } });
      if (drop.leaveBalances.length) await tx.leaveBalance.deleteMany({ where: { id: { in: drop.leaveBalances } } });
      if (drop.reviews.length) await tx.performanceReview.deleteMany({ where: { id: { in: drop.reviews } } });
      if (drop.courses.length) await tx.courseAssignment.deleteMany({ where: { id: { in: drop.courses } } });

      const from = { userId: fromUserId };
      const to = { userId: toUserId };
      await tx.attendanceDay.updateMany({ where: from, data: to });
      await tx.rosterDay.updateMany({ where: from, data: to });
      await tx.shiftAssignment.updateMany({ where: from, data: to });
      await tx.leaveBalance.updateMany({ where: from, data: to });
      await tx.payslip.updateMany({ where: from, data: to });
      await tx.taxDeclaration.updateMany({ where: from, data: to });
      await tx.finalSettlement.updateMany({ where: from, data: to });
      await tx.performanceReview.updateMany({ where: from, data: to });
      await tx.insuranceMember.updateMany({ where: from, data: to });
      await tx.courseAssignment.updateMany({ where: from, data: to });
      await tx.candidate.updateMany({ where: { convertedUserId: fromUserId }, data: { convertedUserId: toUserId } });
      for (const s of SIMPLE) await delegate(tx, s.model).updateMany({ where: { [s.field]: fromUserId }, data: { [s.field]: toUserId } });

      // Last: employeeCode and biometricId are unique, and travel on the row itself, so the record
      // keeps both — the person's code doesn't change because their login did.
      // The new account's blank record (a job title at most) makes way for the real one.
      if (toBlankRecordId) await tx.employeeProfile.delete({ where: { id: toBlankRecordId } });
      await tx.employeeProfile.update({ where: { userId: fromUserId }, data: { userId: toUserId } });

      const userData: Prisma.UserUncheckedUpdateInput = { ...carry };
      if (toManagerId !== undefined) userData.managerId = toManagerId;
      if (Object.keys(userData).length) await tx.user.update({ where: { id: toUserId }, data: userData });

      if (options.handOverReportees && plan.reportees.length) {
        reporteesMoved = (await tx.user.updateMany({ where: { id: { in: plan.reportees.map((r) => r.id) }, managerId: fromUserId }, data: { managerId: toUserId } })).count;
      }
      if (options.handOverReportees) {
        const pending = { approverId: fromUserId, status: "PENDING" as const };
        const next = { approverId: toUserId };
        approvalsMoved =
          (await tx.leaveRequest.updateMany({ where: pending, data: next })).count +
          (await tx.attendanceRegularisation.updateMany({ where: pending, data: next })).count +
          (await tx.shortLeaveRequest.updateMany({ where: pending, data: next })).count;
      }

      if (options.switchOffSource && plan.from.active) {
        await tx.user.update({ where: { id: fromUserId }, data: { active: false } });
        switchedOff = true;
      }
      return { ok: true, plan };
    },
    { timeout: 120_000 },
  );
  if (!outcome.ok) return outcome;
  const { plan } = outcome;

  if (switchedOff) await accountsChanged([fromUserId], { revoke: "deactivated", by: `admin:${actorId}` });

  const moved = plan.lines.filter((l) => l.moving > 0 && l.key !== "employeeProfile").map((l) => `${l.moving} ${l.label.toLowerCase()}`);
  const droppedCount = plan.dropped.length + plan.lines.filter((l) => l.key === "reviews" || l.key === "courses").reduce((sum, l) => sum + l.dropped, 0);
  await recordAudit({
    userId: actorId,
    action: "UPDATE",
    entityType: "EmployeeProfile",
    entityId: toUserId,
    entityLabel:
      `Employee record${plan.from.employeeCode ? ` ${plan.from.employeeCode}` : ""} moved from ${plan.from.email} to ${plan.to.email}` +
      (moved.length ? ` — ${moved.join(", ")}` : "") +
      (droppedCount ? `; ${droppedCount} duplicate${droppedCount === 1 ? "" : "s"} of the old account's dropped` : "") +
      (plan.replaced.length ? `; ${plan.replaced.length} empty row${plan.replaced.length === 1 ? "" : "s"} of the new account's replaced` : "") +
      (reporteesMoved ? `; ${reporteesMoved} reportee${reporteesMoved === 1 ? "" : "s"} handed over` : "") +
      (options.handOverReportees && plan.reporteesRefused.length ? `; ${plan.reporteesRefused.map((r) => r.name).join(", ")} left with the old account — outside the mover's reach` : "") +
      (approvalsMoved ? `; ${approvalsMoved} pending approval${approvalsMoved === 1 ? "" : "s"} handed over` : "") +
      (switchedOff ? "; old account switched off" : ""),
    changes: [{ field: "userId", label: "Account", from: plan.from.email, to: plan.to.email }],
  });

  return { ok: true, plan, switchedOff, reporteesMoved, approvalsMoved };
}
