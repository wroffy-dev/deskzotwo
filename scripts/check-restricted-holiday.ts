/**
 * Restricted holidays as leave, and HR recording RH and short leave from the attendance grid (owner, 26 Nov 2026 —
 * "RH option is not there … and short leave also"; src/lib/hr/restricted-holiday.ts, src/actions/attendance-day.ts).
 *
 *   1. The rule: RH only on a day marked Restricted.
 *   2. Applying: an RH application on an ordinary day is refused, on a restricted holiday it goes in.
 *   3. HR records RH: approved, one day off the balance, the day marked leave and read back as RH; not twice, not with
 *      none left, not on an ordinary day; not by the person themselves, nor somebody without the right.
 *   4. HR records a short leave: approved, the limits kept, removed again.
 *   5. The printed month says RH.
 *
 * The real actions, with the session substituted. Fixtures are named ZZRH / @zzrh-check.invalid, on days in 2031 so no
 * real payroll or holiday is touched, and removed in a finally — the RH leave type too, when this made it.
 *
 *   npm run check:restricted-holiday
 */
import "dotenv/config";
import Module from "node:module";

const TAG = "ZZRH";
const MAIL = "@zzrh-check.invalid";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${!pass && detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

type Person = { id: string; name: string; email: string; role: string };
let actor: Person | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("/lib/session")) {
    class UnauthorizedError extends Error {}
    const me = async () => {
      if (!actor) throw new UnauthorizedError("signed out");
      return actor;
    };
    return { UnauthorizedError, requireUser: me, currentUser: async () => actor, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/modules-access" || request.endsWith("/lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    return { ...real, requireModuleUser: async () => actor, requireModuleAccess: async () => actor };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

/** The first Monday-to-Friday on or after a day, as "yyyy-mm-dd". */
const weekday = (from: string, skip = 0) => {
  const d = new Date(`${from}T00:00:00Z`);
  let left = skip;
  for (;;) {
    const w = d.getUTCDay();
    if (w !== 0 && w !== 6) {
      if (left === 0) return d.toISOString().slice(0, 10);
      left -= 1;
    }
    d.setUTCDate(d.getUTCDate() + 1);
  }
};

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const rules = require("../src/lib/hr/restricted-holiday") as typeof import("../src/lib/hr/restricted-holiday");
  const LEAVE = require("../src/actions/leave") as typeof import("../src/actions/leave");
  const DAY = require("../src/actions/attendance-day") as typeof import("../src/actions/attendance-day");
  const ATT = require("../src/actions/attendance") as typeof import("../src/actions/attendance");
  const { ensureBalance } = require("../src/lib/hr/leave-balance") as typeof import("../src/lib/hr/leave-balance");
  const { leaveYearOfDay } = require("../src/lib/hr/leave-year-server") as typeof import("../src/lib/hr/leave-year-server");
  const { printCode } = require("../src/lib/hr/attendance-print") as typeof import("../src/lib/hr/attendance-print");
  /* eslint-enable @typescript-eslint/no-require-imports */

  const RH_DAY = weekday("2031-03-10");
  const RH_DAY_2 = weekday("2031-03-10", 1);
  const PLAIN = weekday("2031-03-10", 2);
  const SHORT_DAY = weekday("2031-03-17");
  let madeType: string | null = null;
  let reactivated: string | null = null;

  const cleanup = async () => {
    const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
    await db.approvalEvent.deleteMany({ where: { OR: [{ requestedById: { in: ids } }, { decidedById: { in: ids } }] } }).catch(() => {});
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { OR: [{ userId: { in: ids } }, { entityId: { in: ids } }] } });
    await db.attendanceDay.deleteMany({ where: { userId: { in: ids } } });
    await db.shortLeaveRequest.deleteMany({ where: { userId: { in: ids } } });
    await db.leaveRequest.deleteMany({ where: { userId: { in: ids } } });
    await db.leaveBalance.deleteMany({ where: { userId: { in: ids } } });
    await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
    await db.employeeProfile.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
    await db.holiday.deleteMany({ where: { name: { startsWith: TAG } } });
  };
  await cleanup();
  try {
    section("1. The rule");
    const restricted = rules.restrictedDates([{ date: "2031-03-10", optional: true }, { date: "2031-03-11", optional: false }]);
    ok("only the days marked Restricted count", restricted.has("2031-03-10") && !restricted.has("2031-03-11"));
    ok("  a span with an ordinary day in it is refused, naming the day", /2031-03-12 isn't one/.test(rules.restrictedHolidayRefusal(["2031-03-10", "2031-03-12"], restricted) ?? ""));
    ok("  RH by its code, whatever its case", rules.isRestrictedHolidayType({ code: " rh " }) && !rules.isRestrictedHolidayType({ code: "CL" }));

    // Fixtures.
    const superAdmin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
    if (!superAdmin) throw new Error("no super admin");
    const mk = (local: string) => db.user.create({ data: { name: `${TAG} ${local}`, email: `${local}${MAIL}`, role: "EMPLOYEE", passwordHash: "zz-fixture-placeholder" }, select: { id: true, name: true, email: true, role: true } });
    const hr = await mk("hr");
    const asha = await mk("asha");
    const nobody = await mk("nobody");
    for (const permission of ["hr.manage", "hr.viewAll", "hr.approveLeave"]) await db.userPermission.create({ data: { userId: hr.id, permission, allowed: true, grantedById: superAdmin.id } });
    await db.holiday.create({ data: { name: `${TAG} Restricted`, date: new Date(`${RH_DAY}T00:00:00Z`), optional: true } });
    await db.holiday.create({ data: { name: `${TAG} Restricted 2`, date: new Date(`${RH_DAY_2}T00:00:00Z`), optional: true } });
    let type = await db.leaveType.findFirst({ where: { code: { equals: "RH", mode: "insensitive" } } });
    if (!type) {
      type = await db.leaveType.create({ data: { code: "RH", name: "Restricted holiday", annualQuota: 2, paid: true } });
      madeType = type.id;
    }
    const wasActive = type.active;
    if (!wasActive) {
      await db.leaveType.update({ where: { id: type.id }, data: { active: true } });
      reactivated = type.id;
    }
    // One day of RH for Asha, whatever the type's quota here.
    const fy = await leaveYearOfDay(RH_DAY);
    const balance = await ensureBalance(asha.id, type.id, fy, new Date(`${RH_DAY}T00:00:00Z`));
    const n = (v: unknown) => Number(v ?? 0);
    const start = balance ? n(balance.opening) + n(balance.credited) + n(balance.adjustment) - n(balance.used) : 0;
    await db.leaveBalance.update({ where: { userId_typeId_year: { userId: asha.id, typeId: type.id, year: fy } }, data: { adjustment: { increment: 1 - start } } });
    const leftOf = async () => {
      const b = await db.leaveBalance.findUniqueOrThrow({ where: { userId_typeId_year: { userId: asha.id, typeId: type!.id, year: fy } } });
      return n(b.opening) + n(b.credited) + n(b.adjustment) - n(b.used);
    };

    section("2. Applying for RH");
    actor = asha;
    const plain = await LEAVE.applyForLeave({ typeId: type.id, fromDate: PLAIN, toDate: PLAIN, reason: "Zz family function" });
    ok("RH on an ordinary day: refused, saying so", !plain.ok && /only for the restricted holidays/.test(plain.error), plain.ok ? "applied" : plain.error);
    const applied = await LEAVE.applyForLeave({ typeId: type.id, fromDate: RH_DAY_2, toDate: RH_DAY_2, reason: "Zz family function" });
    ok("RH on a restricted holiday: it goes in, waiting for approval", applied.ok && applied.data.days === 1, applied.ok ? applied.data : applied.error);
    if (applied.ok) await db.leaveRequest.delete({ where: { id: applied.data.id } });

    section("3. HR records RH from the grid");
    const extras = await (async () => {
      actor = hr;
      return DAY.dayExtras({ userId: asha.id, date: RH_DAY });
    })();
    ok("the dialog is told it's a restricted holiday, with one left", extras.ok && extras.data.restricted === `${TAG} Restricted` && !!extras.data.rh && "left" in extras.data.rh && extras.data.rh.left === 1, extras.ok ? extras.data : extras.error);
    const plainExtras = await DAY.dayExtras({ userId: asha.id, date: PLAIN });
    ok("  an ordinary day offers no RH", plainExtras.ok && plainExtras.data.restricted === null && plainExtras.data.rh === null);
    const onPlain = await DAY.recordRestrictedHoliday({ userId: asha.id, date: PLAIN });
    ok("RH on an ordinary day: refused", !onPlain.ok && /isn't a restricted holiday/.test(onPlain.error));
    actor = asha;
    const self = await DAY.recordRestrictedHoliday({ userId: asha.id, date: RH_DAY });
    actor = nobody;
    const stranger = await DAY.recordRestrictedHoliday({ userId: asha.id, date: RH_DAY });
    ok("not by the person themselves, nor somebody without the right", !self.ok && !stranger.ok && /can't record/.test(stranger.ok ? "" : stranger.error));
    actor = hr;
    const recorded = await DAY.recordRestrictedHoliday({ userId: asha.id, date: RH_DAY, note: "Zz Holi" });
    ok("HR records it", recorded.ok, recorded.ok ? "" : recorded.error);
    const request = await db.leaveRequest.findFirst({ where: { userId: asha.id, typeId: type.id }, select: { id: true, status: true, approverId: true, days: true } });
    const dayRow = await db.attendanceDay.findUnique({ where: { userId_date: { userId: asha.id, date: new Date(`${RH_DAY}T00:00:00Z`) } } });
    ok("  approved, by HR, one day", request?.status === "APPROVED" && request.approverId === hr.id && n(request.days) === 1, request);
    ok("  one day off the balance", (await leftOf()) === 0, await leftOf());
    ok("  the day is leave from that request", dayRow?.status === "ON_LEAVE" && dayRow.leaveRequestId === request?.id);
    const month = await ATT.attendanceMonth({ year: Number(RH_DAY.slice(0, 4)), month: Number(RH_DAY.slice(5, 7)), userId: asha.id });
    const cell = month.rows.find((r) => r.userId === asha.id)?.cells.find((c) => c.date === RH_DAY);
    ok("  the month reads it back as RH", cell?.status === "ON_LEAVE" && cell.leaveCode?.toUpperCase() === "RH", cell);
    ok("  and the printed month says RH", !!cell && printCode(cell).code === "RH");
    const twice = await DAY.recordRestrictedHoliday({ userId: asha.id, date: RH_DAY });
    ok("not twice on one day", !twice.ok && /already has approved leave/.test(twice.error), twice.ok ? "twice" : twice.error);
    const none = await DAY.recordRestrictedHoliday({ userId: asha.id, date: RH_DAY_2 });
    ok("none left: refused", !none.ok && /no .* left/.test(none.error), none.ok ? "recorded" : none.error);

    section("4. HR records a short leave");
    const first = await DAY.recordShortLeave({ userId: asha.id, date: SHORT_DAY, from: "10:00", to: "11:00", reason: "Zz bank visit" });
    ok("HR records it, approved", first.ok, first.ok ? "" : first.error);
    const row = await db.shortLeaveRequest.findFirst({ where: { userId: asha.id, date: new Date(`${SHORT_DAY}T00:00:00Z`) }, select: { id: true, status: true, approverId: true } });
    ok("  approved, by HR", row?.status === "APPROVED" && row.approverId === hr.id, row);
    const shown = await DAY.dayExtras({ userId: asha.id, date: SHORT_DAY });
    ok("  the dialog shows it", shown.ok && shown.data.shortLeave?.id === row?.id && shown.data.shortLeave.approved);
    const sameDay = await DAY.recordShortLeave({ userId: asha.id, date: SHORT_DAY, from: "15:00", to: "15:30", reason: "Zz again" });
    ok("  a second that day: refused", !sameDay.ok && /already have a short leave/.test(sameDay.error), sameDay.ok ? "recorded" : sameDay.error);
    const long = await DAY.recordShortLeave({ userId: asha.id, date: weekday(SHORT_DAY, 1), from: "10:00", to: "15:00", reason: "Zz long" });
    ok("  longer than allowed: refused", !long.ok && /at most/.test(long.error), long.ok ? "recorded" : long.error);
    const onLeave = await DAY.recordShortLeave({ userId: asha.id, date: RH_DAY, from: "10:00", to: "11:00", reason: "Zz on leave" });
    ok("  on a leave day: refused", !onLeave.ok && /already have leave/.test(onLeave.error), onLeave.ok ? "recorded" : onLeave.error);
    if (row) {
      const removed = await DAY.removeShortLeave({ userId: asha.id, date: SHORT_DAY, id: row.id });
      const after = await db.shortLeaveRequest.findUnique({ where: { id: row.id }, select: { status: true } });
      ok("HR removes it again", removed.ok && after?.status === "CANCELLED", removed.ok ? after : removed.error);
    }
  } finally {
    actor = null;
    await cleanup();
    if (reactivated) await db.leaveType.update({ where: { id: reactivated }, data: { active: false } }).catch(() => {});
    if (madeType) await db.leaveType.delete({ where: { id: madeType } }).catch(() => {});
    ok("the fixtures are gone", (await db.user.count({ where: { email: { endsWith: MAIL } } })) === 0);
  }
  console.log(failures === 0 ? `\nAll ${passes} restricted holiday checks passed.\n` : `\n${failures} check(s) FAILED (${passes} passed).\n`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
