/**
 * check:kredily-attendance — Kredily's attendance history brought into Deskzo (owner, 31 Oct 2026 —
 * src/lib/kredily/attendance.ts, src/lib/kredily/attendance-days.ts, the Kredily import).
 *
 *   1. Dates: day headings with no year walked from the title's "1 Jan 25", the year turning at the second
 *      "1 Jan"; without a title, the year that ends on or before today; headings with a year; 29 Feb.
 *   2. Marks: P, A, WO, H, L, HL, LOP and two halves as Deskzo statuses; NA and unknown marks left out.
 *   3. The report read from a workbook built like Kredily's: title row, headings, totals columns not taken as days.
 *   4. The days: found by employee code, absent marks left out where nobody was ever present (and brought
 *      when asked), a day already in Deskzo kept as it is, nothing past today, a code not here listed,
 *      a second run writing nothing.
 *
 * Its own people (…@zz-katt.in) and days in 1999, removed afterwards.
 *
 *   npm run check:kredily-attendance
 */
import "dotenv/config";
import ExcelJS from "exceljs";
import { directClient } from "../src/lib/tenancy/direct-client";

const db = directClient();
const MAIL = "@zz-katt.in";
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
  if (!users.length) return;
  const mine = { userId: { in: users } };
  await db.attendanceDay.deleteMany({ where: mine });
  await db.employeeProfile.deleteMany({ where: mine });
  await db.user.deleteMany({ where: { id: { in: users } } });
}

async function main() {
  const { columnDates, markMeaning, tidyMark } = await import("../src/lib/kredily/attendance");
  const { readKredily } = await import("../src/lib/kredily/read");
  const { attendancePlan, writeAttendance } = await import("../src/lib/kredily/attendance-days");

  section("1. Dates");
  const MON = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const yearOfDays = (y: number) => {
    const out: string[] = [];
    for (let t = Date.UTC(y, 0, 1); new Date(t).getUTCFullYear() === y; t += 86400000) out.push(`${new Date(t).getUTCDate()} ${MON[new Date(t).getUTCMonth()]}`);
    return out;
  };
  const heads = ["Employee ID", "Employee Name", ...yearOfDays(2025), "1 Jan", "2 Jan", "A", "P", "Total Payable Days"];
  const dates = columnDates(heads, "Wroffy Technologies Pvt Ltd - Consolidated Attendance Report - 1 Jan 25 - 31 Oct", "2026-10-31");
  ok("the first day is the title's", dates[2] === "2025-01-01", dates[2]);
  ok("31 Dec is 2025's", dates[2 + 364] === "2025-12-31", dates[2 + 364]);
  ok("the second 1 Jan turns the year", dates[2 + 365] === "2026-01-01" && dates[2 + 366] === "2026-01-02", dates.slice(367, 369));
  ok("headings that aren't days have no date", dates[0] === null && dates[1] === null && dates.slice(-3).every((x) => x === null));
  const noTitle = columnDates(["Employee ID", "30 Oct", "31 Oct", "1 Nov"], "", "2026-10-31");
  ok("no title: the year that ends on or before today", noTitle[1] === "2025-10-30" && noTitle[3] === "2025-11-01", noTitle);
  const noTitle2 = columnDates(["Employee ID", "1 Oct", "31 Oct"], "", "2026-10-31");
  ok("no title: this year when it fits", noTitle2[2] === "2026-10-31", noTitle2);
  const withYear = columnDates(["Employee ID", "1 Oct 2026", "02/10/2026", "3-Oct-2026"], "", "2026-10-31");
  ok("headings with a year", withYear.slice(1).join() === "2026-10-01,2026-10-02,2026-10-03", withYear);
  const leap = columnDates(["Employee ID", "28 Feb", "29 Feb", "1 Mar"], "Report - 28 Feb 23 - 1 Mar", "2026-10-31");
  ok("29 Feb in a year without one is no day", leap[1] === "2023-02-28" && leap[2] === null && leap[3] === "2023-03-01", leap);

  section("2. Marks");
  const as = (m: string) => markMeaning(m)?.status ?? null;
  ok("P present, A absent, WO week off, H holiday", as("P") === "PRESENT" && as("A") === "ABSENT" && as("WO") === "WEEK_OFF" && as("H") === "HOLIDAY");
  ok("L leave, HL half day, LOP absent", as("L") === "ON_LEAVE" && as("HL") === "HALF_DAY" && as("LOP") === "ABSENT");
  ok("A and LOP are absences, the rest aren't", !!markMeaning("A")?.absent && !!markMeaning("LOP")?.absent && !markMeaning("P")?.absent && !markMeaning("HL")?.absent);
  ok("two halves with a half leave are a half day", ["P / HL", "HL / P", "A / HL", "HL / LOP", "p/hl"].every((m) => as(m) === "HALF_DAY"));
  ok("NA, blank and unknown marks aren't days", as("NA") === null && as("") === null && as("AN") === null && as("P / A") === null);
  ok("marks tidied to one spelling", tidyMark(" p/hl ") === "P / HL");

  section("3. The report read as Kredily writes it");
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet("Sheet");
  const days = ["1 Jan", "2 Jan", "3 Jan", "4 Jan", "5 Jan", "6 Jan", "7 Jan", "8 Jan"];
  const width = 5 + days.length + 3;
  ws.addRow(Array(width).fill("Zz Co - Consolidated Attendance Report - 1 Jan 1999 - 8 Jan"));
  ws.addRow(["Employee ID", "Employee Name", "Work Location", "Department", "Designation", ...days, "A", "P", "Total Payable Days"]);
  ws.addRow(["ZZK/01", "Zz One", "Office", "", "", "A", "WO", "H", "L", "HL / LOP", "A", "NA", "AN", 2, 0, 5]);
  ws.addRow(["ZZK/02", "Zz Two", "Office", "", "", "A", "A", "A", "A", "A", "A", "A", "A", 8, 0, 0]);
  ws.addRow(["ZZK/99", "Zz Not Here", "Office", "", "", "A", "WO", "", "", "", "", "", "", 1, 0, 1]);
  const read = await readKredily([{ name: "Consolidated_Attendance_Report.xlsx", bytes: Buffer.from(await wb.xlsx.writeBuffer()) }]);
  const att = read.attendance;
  ok("read as attendance history", !!att && read.read.some((r) => r.as === "Attendance history"), read.read);
  ok("not taken for the leave balance report", read.leaveTypes.length === 0);
  ok("the span is the day columns'", att?.from === "1999-01-01" && att?.to === "1999-01-08", att && [att.from, att.to]);
  ok("every filled day cell, totals left out", att?.marks.length === 8 + 8 + 2, att?.marks.length);
  if (!att) throw new Error("No attendance read.");

  section("4. The days");
  await cleanup();
  try {
    const mk = (name: string, local: string) => db.user.create({ data: { name, email: `${local}${MAIL}`, passwordHash: "!", role: "SALES" }, select: { id: true } });
    const one = await mk("Zz Katt One", "one");
    const two = await mk("Zz Katt Two", "two");
    await db.employeeProfile.create({ data: { userId: one.id, employeeCode: "zzk/01" } });
    await db.employeeProfile.create({ data: { userId: two.id, employeeCode: "ZZK/02" } });
    // A day Deskzo already has: kept as it is.
    await db.attendanceDay.create({ data: { userId: one.id, date: d("1999-01-03"), status: "PRESENT", note: "Deskzo's own" } });
    const only = { userIds: [one.id, two.id] };

    const first = await attendancePlan(att, undefined, only);
    ok("more absent than present: absent marks left out by default", first.plan.presentDays === 0 && first.plan.absentDays === 11 && !first.plan.withAbsent, [first.plan.presentDays, first.plan.absentDays]);
    ok("found by employee code, whatever its case", first.plan.people === 1 && first.rows.every((r) => r.userId === one.id), first.plan.people);
    ok("WO, L and the half day come; the day already here is kept", first.plan.days === 3 && first.plan.kept === 1, { days: first.plan.days, kept: first.plan.kept });
    ok("a code with no record here is listed", first.plan.notHere.join() === "ZZK/99", first.plan.notHere);
    ok("unknown marks are counted, not brought", first.plan.marks.some((m) => m.mark === "AN" && !m.known && m.days === 1) && !first.plan.marks.some((m) => m.mark === "NA"));

    const withAbsent = await attendancePlan(att, true, only);
    ok("asked: absent days come too", withAbsent.plan.days === 3 + 2 + 8, withAbsent.plan.days);

    const wrote = await writeAttendance(att, true, only);
    ok("written", wrote.created === 13 && wrote.kept === 1, wrote);
    const mineNow = await db.attendanceDay.findMany({ where: { userId: one.id }, orderBy: { date: "asc" }, select: { date: true, status: true, note: true } });
    const on = (k: string) => mineNow.find((x) => x.date.toISOString().slice(0, 10) === k);
    ok("Deskzo's own day untouched", on("1999-01-03")?.status === "PRESENT" && on("1999-01-03")?.note === "Deskzo's own");
    ok("statuses as marked, with Kredily's mark noted", on("1999-01-02")?.status === "WEEK_OFF" && on("1999-01-05")?.status === "HALF_DAY" && on("1999-01-05")?.note === "From Kredily (HL / LOP)" && on("1999-01-04")?.status === "ON_LEAVE");
    ok("NA and AN days not written", !on("1999-01-07") && !on("1999-01-08"));

    const again = await writeAttendance(att, true, only);
    ok("a second run writes nothing", again.created === 0 && again.kept === 14, again);

    // Mostly present: absences are real, and come without asking.
    const punched = { from: "1999-02-01", to: "1999-02-03", marks: ["P", "P / HL", "A"].map((mark, i) => ({ code: "ZZK/02", date: `1999-02-0${i + 1}`, mark })) };
    const punchedPlan = await attendancePlan(punched, undefined, only);
    ok("more present than absent: absences come by default", punchedPlan.plan.withAbsent && punchedPlan.plan.days === 3, punchedPlan.plan);

    // A day past today never comes.
    const ahead = { from: "2999-01-01", to: "2999-01-01", marks: [{ code: "ZZK/02", date: "2999-01-01", mark: "P" }] };
    ok("nothing past today", (await attendancePlan(ahead, true, only)).plan.days === 0);
  } finally {
    await cleanup();
  }

  console.log(`\n${passes} passed, ${failures} failed`);
  process.exit(failures ? 1 : 0);
}

main().catch(async (e) => {
  console.error(e);
  await cleanup().catch(() => {});
  process.exit(1);
});
