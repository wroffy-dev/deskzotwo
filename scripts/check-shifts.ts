/**
 * check:shifts — shifts and the roster (src/actions/shifts.ts, src/lib/hr/shift-rules.ts) and what attendance makes
 * of them (src/actions/attendance.ts, src/lib/hr/shifts.ts).
 *
 * The rules first, then a fixture of its own in January 2026 (no real roster there): a day-shift person, a
 * night-shift person, HR and somebody without HR. Times are India's (the workspace's clock). Everything is named
 * ZZPROBE_SH and removed in a finally.
 *
 *   npm run check:shifts
 */
import "dotenv/config";
import Module from "node:module";
import { cloneElement, isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor: { id: string; name: string; email: string } | null = null;
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => (actor ? { ...actor, role: "SALES" } : null);
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/notify") return { notifyUser: async () => {} };
  if (request === "next/navigation") {
    return {
      notFound: () => {
        throw new Error("notFound");
      },
      redirect: () => {
        throw new Error("redirect");
      },
      useRouter: () => ({ refresh() {}, push() {} }),
      usePathname: () => "/people/shifts",
      useSearchParams: () => new URLSearchParams(),
    };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_SH";
const MAIL = "@zzprobe-sh.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const ist = (isoLocal: string) => new Date(`${isoLocal}:00+05:30`);

async function resolveAsync(node: unknown): Promise<unknown> {
  if (Array.isArray(node)) return Promise.all(node.map(resolveAsync));
  if (!isValidElement(node)) return node;
  const el = node as ReactElement<{ children?: unknown }>;
  if (typeof el.type === "function" && el.type.constructor.name === "AsyncFunction") {
    return resolveAsync(await (el.type as (p: unknown) => Promise<unknown>)(el.props));
  }
  if (el.props && "children" in el.props) {
    const kids = await resolveAsync(el.props.children);
    return Array.isArray(kids) ? cloneElement(el, undefined, ...(kids as ReactNode[])) : cloneElement(el, undefined, kids as ReactNode);
  }
  return el;
}

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  await db.attendanceDay.deleteMany({ where: { userId: { in: ids } } });
  await db.rosterDay.deleteMany({ where: { userId: { in: ids } } });
  await db.shiftAssignment.deleteMany({ where: { userId: { in: ids } } });
  await db.shift.deleteMany({ where: { name: { startsWith: TAG } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const rules = require("../src/lib/hr/shift-rules") as typeof import("../src/lib/hr/shift-rules");
  const actions = require("../src/actions/shifts") as typeof import("../src/actions/shifts");
  const attendance = require("../src/actions/attendance") as typeof import("../src/actions/attendance");
  const lookups = require("../src/lib/hr/shifts") as typeof import("../src/lib/hr/shifts");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("The rules");
  const G = { id: "g", name: "General", code: "G", startMinute: 600, endMinute: 1140, graceMinutes: 10, weekOffs: [0] };
  const N = { id: "n", name: "Night", code: "N", startMinute: 1320, endMinute: 360, graceMinutes: 15, weekOffs: [5, 6] };
  ok("a night shift crosses midnight: 10 pm–6 am is 8 hours", rules.crossesMidnight(N) && rules.shiftMinutes(N) === 480);
  const assigned = [{ fromDate: d("2026-01-01"), shift: G }, { fromDate: d("2026-01-10"), shift: N }];
  ok("before any assignment: no shift, Sunday a week off", rules.shiftOn(d("2025-12-28"), assigned, undefined).source === "default" && rules.shiftOn(d("2025-12-28"), assigned, undefined).weekOff);
  ok("the standing shift from its day: G on Saturday 3 Jan, a working day", rules.shiftOn(d("2026-01-03"), assigned, undefined).shift?.code === "G" && !rules.shiftOn(d("2026-01-03"), assigned, undefined).weekOff);
  ok("the latest assignment wins: N from 10 Jan, Friday 16 Jan off", rules.shiftOn(d("2026-01-16"), assigned, undefined).shift?.code === "N" && rules.shiftOn(d("2026-01-16"), assigned, undefined).weekOff);
  ok("the roster's day wins over both: a week off on a Monday", rules.shiftOn(d("2026-01-05"), assigned, { shift: null }).weekOff && rules.shiftOn(d("2026-01-05"), assigned, { shift: null }).source === "roster");
  const minuteOf = (at: Date) => {
    const local = new Date(at.getTime() + 330 * 60_000);
    return local.getUTCHours() * 60 + local.getUTCMinutes();
  };
  const nightDay = (inAt: string, outAt: string | null) => ({ status: "PRESENT", checkInAt: ist(inAt), checkOutAt: outAt ? ist(outAt) : null, workedMinutes: null });
  const late = rules.shiftTiming(nightDay("2026-01-12T22:20", "2026-01-13T06:05"), N, minuteOf);
  ok("night: in at 10:20 pm is late, out at 6:05 am isn't early", late.late && !late.early && !late.overtime, late);
  const onTime = rules.shiftTiming(nightDay("2026-01-12T21:55", "2026-01-13T05:30"), N, minuteOf);
  ok("night: in at 9:55 pm on time, out at 5:30 am early", !onTime.late && onTime.early, onTime);
  const after = rules.shiftTiming(nightDay("2026-01-13T00:30", null), N, minuteOf);
  ok("night: in at 12:30 am is late, not twenty-one hours early", after.late && !after.early, after);
  const longNight = rules.shiftTiming(nightDay("2026-01-12T22:00", "2026-01-13T07:30"), N, minuteOf);
  ok("night: 9½ hours is overtime", longNight.overtime, longNight);
  ok("a day shift reads as office hours did", rules.shiftTiming({ status: "PRESENT", checkInAt: ist("2026-01-05T10:15"), checkOutAt: ist("2026-01-05T19:00"), workedMinutes: null }, G, minuteOf).late);
  ok("a shift under an hour, a bad code, or four days off is refused", !rules.shiftOrRefusal({ name: "X", code: "G", start: "09:00", end: "09:30", grace: 10, weekOffs: [] }).ok && !rules.shiftOrRefusal({ name: "General", code: "G-1", start: "09:00", end: "18:00", grace: 10, weekOffs: [] }).ok && !rules.shiftOrRefusal({ name: "General", code: "G", start: "09:00", end: "18:00", grace: 10, weekOffs: [0, 1, 2, 3] }).ok);
  const night = rules.shiftOrRefusal({ name: "Night", code: "n", start: "22:00", end: "06:00", grace: 15, weekOffs: [6, 5, 6] });
  ok("a night shift is kept, its code upper-cased and days sorted", night.ok && night.shift.code === "N" && night.shift.weekOffs.join() === "5,6", night);

  await cleanup();
  try {
    section("The fixture");
    const make = (name: string) => db.user.create({ data: { name: `${TAG} ${name}`, email: `${name.toLowerCase()}${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const dayPerson = await make("Day");
    const nightPerson = await make("Night");
    const hr = await make("Hr");
    const plain = await make("Plain");
    await db.userPermission.create({ data: { userId: hr.id, permission: "hr.manage", allowed: true, reason: TAG } });
    const as = (u: { id: string; name: string; email: string }) => (actor = { id: u.id, name: u.name, email: u.email });
    ok("two workers, HR and somebody without HR", true);

    section("Setting up shifts");
    as(plain);
    ok("only HR sets up a shift", !(await actions.saveShift({ name: `${TAG} General`, code: "ZQG", start: "10:00", end: "19:00", grace: 10, weekOffs: [0] })).ok);
    as(hr);
    const g = await actions.saveShift({ name: `${TAG} General`, code: "ZQG", start: "10:00", end: "19:00", grace: 10, weekOffs: [0] });
    const n = await actions.saveShift({ name: `${TAG} Night`, code: "ZQN", start: "22:00", end: "06:00", grace: 15, weekOffs: [5, 6] });
    ok("HR adds a day and a night shift", g.ok && n.ok, [g, n]);
    ok("a code already used is refused", !(await actions.saveShift({ name: `${TAG} Other`, code: "zqg", start: "08:00", end: "17:00", grace: 0, weekOffs: [] })).ok);
    if (!g.ok || !n.ok) throw new Error("no shifts");

    section("The roster");
    ok("assigning needs people", !(await actions.assignShift({ userIds: [], shiftId: g.data.id, fromDate: "2026-01-01" })).ok);
    ok("the day person on General from 1 Jan", (await actions.assignShift({ userIds: [dayPerson.id], shiftId: g.data.id, fromDate: "2026-01-01" })).ok);
    ok("the night person on Night from 1 Jan", (await actions.assignShift({ userIds: [nightPerson.id], shiftId: n.data.id, fromDate: "2026-01-01" })).ok);
    ok("Wednesday 7 Jan off for the day person", (await actions.setRosterDay({ userId: dayPerson.id, date: "2026-01-07", value: "OFF" })).ok);
    ok("Thursday 8 Jan on Night for them, then back as assigned", (await actions.setRosterDay({ userId: dayPerson.id, date: "2026-01-08", value: n.data.id })).ok && (await actions.setRosterDay({ userId: dayPerson.id, date: "2026-01-08", value: "" })).ok && (await db.rosterDay.count({ where: { userId: dayPerson.id } })) === 1);
    as(plain);
    ok("nobody else changes the roster", !(await actions.setRosterDay({ userId: dayPerson.id, date: "2026-01-09", value: "OFF" })).ok);

    section("What attendance makes of it");
    await db.attendanceDay.createMany({
      data: [
        // Monday 5 Jan, day shift: in 10:20 (late past 10 min grace), out 19:00.
        { userId: dayPerson.id, date: d("2026-01-05"), status: "PRESENT", checkInAt: ist("2026-01-05T10:20"), checkOutAt: ist("2026-01-05T19:00"), workedMinutes: 520 },
        // Monday 5 Jan, night shift: in 21:58, out 06:02 the next morning — on time, not early.
        { userId: nightPerson.id, date: d("2026-01-05"), status: "PRESENT", checkInAt: ist("2026-01-05T21:58"), checkOutAt: ist("2026-01-06T06:02"), workedMinutes: 484 },
        // Tuesday 6 Jan, night shift: in 22:40 — late.
        { userId: nightPerson.id, date: d("2026-01-06"), status: "PRESENT", checkInAt: ist("2026-01-06T22:40"), checkOutAt: ist("2026-01-07T06:00"), workedMinutes: 440 },
      ],
    });
    as(hr);
    const month = await attendance.attendanceMonth({ year: 2026, month: 1, search: TAG });
    const row = (u: { id: string }) => month.rows.find((r) => r.userId === u.id);
    const cell = (u: { id: string }, date: string) => row(u)?.cells.find((c) => c.date === date);
    ok("Saturday 3 Jan is a working day on General", cell(dayPerson, "2026-01-03")?.offDay === null && cell(dayPerson, "2026-01-03")?.shiftCode === "ZQG");
    ok("Sunday 4 Jan is its week off", cell(dayPerson, "2026-01-04")?.offDay === "week off");
    ok("the roster's Wednesday off is a week off", cell(dayPerson, "2026-01-07")?.offDay === "week off");
    ok("the day person late on Monday", cell(dayPerson, "2026-01-05")?.late === true);
    ok("the night person on time Monday, not early after midnight", cell(nightPerson, "2026-01-05")?.late === false && cell(nightPerson, "2026-01-05")?.early === false, cell(nightPerson, "2026-01-05"));
    ok("the night person late on Tuesday", cell(nightPerson, "2026-01-06")?.late === true);
    ok("Friday and Saturday off on Night", cell(nightPerson, "2026-01-09")?.offDay === "week off" && cell(nightPerson, "2026-01-10")?.offDay === "week off");
    // The workspace's own holidays in January, on a day each shift works (26 Jan, a Monday, in India).
    const holidays = (await db.holiday.findMany({ where: { date: { gte: d("2026-01-01"), lte: d("2026-01-31") }, optional: false }, select: { date: true } })).map((h) => h.date);
    const onG = holidays.filter((h) => h.getUTCDay() !== 0 && h.getUTCDate() !== 7).length;
    const onN = holidays.filter((h) => h.getUTCDay() !== 5 && h.getUTCDay() !== 6).length;
    // General: 31 days less 4 Sundays and the rostered Wednesday = 26, less holidays, of 9 h each.
    ok(`hours expected on General: ${26 - onG} days of 9 h`, row(dayPerson)?.workingDays === 26 - onG && row(dayPerson)?.expectedHours === (26 - onG) * 9, row(dayPerson) && { days: row(dayPerson)!.workingDays, expected: row(dayPerson)!.expectedHours });
    // Night: 31 days less 10 Fridays and Saturdays = 21, less holidays, of 8 h each.
    ok(`hours expected on Night: ${21 - onN} days of 8 h`, row(nightPerson)?.workingDays === 21 - onN && row(nightPerson)?.expectedHours === (21 - onN) * 8, row(nightPerson) && { days: row(nightPerson)!.workingDays, expected: row(nightPerson)!.expectedHours });

    section("A night shift's clock-out after midnight");
    await db.attendanceDay.createMany({
      data: [
        { userId: nightPerson.id, date: d("2026-01-12"), status: "PRESENT", checkInAt: ist("2026-01-12T22:00") },
        { userId: dayPerson.id, date: d("2026-01-12"), status: "PRESENT", checkInAt: ist("2026-01-12T10:00") },
      ],
    });
    ok("the night person's goes to the night it started", (await lookups.dayToClockOut(nightPerson.id, d("2026-01-13"))).getTime() === d("2026-01-12").getTime());
    ok("a day shift's stays on today", (await lookups.dayToClockOut(dayPerson.id, d("2026-01-13"))).getTime() === d("2026-01-13").getTime());
    await db.attendanceDay.create({ data: { userId: nightPerson.id, date: d("2026-01-13"), status: "PRESENT", checkInAt: ist("2026-01-13T21:59") } });
    ok("once they've clocked in again today, today's", (await lookups.dayToClockOut(nightPerson.id, d("2026-01-13"))).getTime() === d("2026-01-13").getTime());

    section("The page");
    /* eslint-disable @typescript-eslint/no-require-imports */
    const Page = require("../src/app/(dashboard)/people/shifts/page").default as (p: { searchParams: Promise<{ week?: string }> }) => Promise<unknown>;
    /* eslint-enable @typescript-eslint/no-require-imports */
    const html = renderToStaticMarkup((await resolveAsync(await Page({ searchParams: Promise.resolve({ week: "2026-01-07" }) }))) as ReactElement);
    ok("HR's page: the shifts, the week from Monday 5 Jan, the assign bar", html.includes(`${TAG} Night`) && html.includes("Week of 2026-01-05") && html.includes("Assign") && html.includes(`${TAG} Day`));
    as(plain);
    const own = await actions.shiftsPage({ week: "2026-01-07" });
    ok("somebody without HR sees only their own week, and can't edit", !own.canEdit && own.rows.length === 1 && own.rows[0]?.userId === plain.id);
  } finally {
    actor = null;
    await cleanup();
    const left = (await db.user.count({ where: { email: { endsWith: MAIL } } })) + (await db.shift.count({ where: { name: { startsWith: TAG } } }));
    ok("nothing of the fixture is left behind", left === 0, left);
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll shift checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
