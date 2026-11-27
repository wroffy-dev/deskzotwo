/**
 * check:leave-year — the leave year setting (owner, 18 Nov 2026): April to March, or January to December.
 *
 *   1. The rules alone: which year a day is in, each year's start, months and name, and a change — going to the
 *      calendar year makes the running April year a 9-month changeover; going back makes the running January year
 *      15 months; a change made in January to March leaves the running year whole; one not begun can be taken back.
 *   2. What a year grants under them: all at once and a twelfth a month, a joiner, a leaver, the changeover.
 *   3. Real balances: the workspace's rule set to the calendar year from 2002, a probe person's April 2001 all-at-once
 *      balance comes down from 12 to the changeover's 9, a monthly one stops at 9 months, and 2002 opens on 1 January
 *      with what the changeover carried. The workspace's own rule is put back as it was found.
 *
 * Probes are Zzly…@zzprobe-leave-year.invalid, removed in a finally.
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_LY";
const MAIL = "@zzprobe-leave-year.invalid";
const CODES = ["ZZLYA", "ZZLYM"];

let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const day = (x: Date) => x.toISOString().slice(0, 10);
const num = (v: unknown) => Number(v ?? 0);

async function cleanup() {
  await db.leaveType.deleteMany({ where: { code: { in: CODES } } });
  await db.user.deleteMany({ where: { email: { endsWith: MAIL } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const ly = require("../src/lib/hr/leave-year") as typeof import("../src/lib/hr/leave-year");
  const { accruedTo, ensureBalance } = require("../src/lib/hr/leave-balance") as typeof import("../src/lib/hr/leave-balance");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const { changeLeaveYear, leaveYearLabel, leaveYearOf, leaveYearStart, monthsInLeaveYear, parseLeaveYearRules } = ly;

  section("1. The rules");
  const april: never[] = [];
  ok("no rules: April to March, as always", leaveYearOf(d("2026-11-18"), april) === 2026 && leaveYearOf(d("2027-03-31"), april) === 2026 && leaveYearOf(d("2027-04-01"), april) === 2027);
  ok("  named FY 2026-27, 12 months", leaveYearLabel(2026, april) === "FY 2026-27" && monthsInLeaveYear(2026, april) === 12);

  const toJan = changeLeaveYear([], 0, d("2026-11-18"));
  ok("to the calendar year in November: from 1 January 2027", toJan?.firstYear === 2027 && day(toJan.firstYearFrom) === "2027-01-01", toJan && day(toJan.firstYearFrom));
  ok("  this April year is the changeover, April to December, 9 months", toJan?.changeoverYear === 2026 && toJan.changeoverMonths === 9 && day(toJan.changeoverFrom) === "2026-04-01" && day(toJan.changeoverTo) === "2026-12-31");
  const jan = toJan!.rules;
  ok("  named Apr 2026 – Dec 2026, then 2027", leaveYearLabel(2026, jan) === "Apr 2026 – Dec 2026" && leaveYearLabel(2027, jan) === "2027", `${leaveYearLabel(2026, jan)} / ${leaveYearLabel(2027, jan)}`);
  ok("  a day in December 2026 is 2026, in February 2027 is 2027", leaveYearOf(d("2026-12-31"), jan) === 2026 && leaveYearOf(d("2027-02-10"), jan) === 2027);
  ok("  years before stay April to March", day(leaveYearStart(2025, jan)) === "2025-04-01" && monthsInLeaveYear(2025, jan) === 12);

  const inFebruary = changeLeaveYear([], 0, d("2027-02-10"));
  ok("made in February: the running April year stays whole, the next one is the changeover", inFebruary?.changeoverYear === 2027 && inFebruary.changeoverMonths === 9 && inFebruary.firstYear === 2028 && monthsInLeaveYear(2026, inFebruary.rules) === 12);

  const back = changeLeaveYear(parseLeaveYearRules([{ fromYear: 2025, startMonth: 0 }]), 3, d("2026-11-18"));
  ok("back to April in November: this January year runs to March, 15 months", back?.changeoverYear === 2026 && back.changeoverMonths === 15 && day(back.changeoverTo) === "2027-03-31" && back.firstYear === 2027 && day(back.firstYearFrom) === "2027-04-01");
  ok("  named Jan 2026 – Mar 2027, then FY 2027-28", leaveYearLabel(2026, back!.rules) === "Jan 2026 – Mar 2027" && leaveYearLabel(2027, back!.rules) === "FY 2027-28");

  ok("the same start again changes nothing", changeLeaveYear([], 3, d("2026-11-18")) === null && changeLeaveYear(jan, 0, d("2026-11-18")) === null);
  const undo = changeLeaveYear(jan, 3, d("2026-12-01"));
  ok("a change not begun can be taken back: no rules, and 2026 a whole April year again", !!undo?.cancelsPending && undo.rules.length === 0 && monthsInLeaveYear(2026, undo.rules) === 12);
  ok("stored rules that make no sense are left out", parseLeaveYearRules([{ fromYear: 2027, startMonth: 5 }, { fromYear: "x", startMonth: 0 }, null]).length === 0);

  section("2. What a year grants");
  const allAtOnce = { annualQuota: 12, accrual: "ANNUAL" };
  const monthly = { annualQuota: 18, accrual: "MONTHLY" };
  ok("April year, all at once: 12 from April", accruedTo(allAtOnce, 2026, d("2026-04-01"), undefined, april) === 12);
  ok("  the changeover: 9", accruedTo(allAtOnce, 2026, d("2026-04-01"), undefined, jan) === 9);
  ok("  the calendar year: 12 from 1 January", accruedTo(allAtOnce, 2027, d("2027-01-01"), undefined, jan) === 12);
  ok("  joining in October 2027: 3", accruedTo(allAtOnce, 2027, d("2027-11-01"), { joinedOn: d("2027-10-05") }, jan) === 3);
  ok("  joining in November 2026, in the changeover: 2", accruedTo(allAtOnce, 2026, d("2026-11-20"), { joinedOn: d("2026-11-10") }, jan) === 2);
  ok("1.5 a month: 3 by May in an April year, 3 by February in a calendar one", accruedTo(monthly, 2026, d("2026-05-02"), undefined, april) === 3 && accruedTo(monthly, 2027, d("2027-02-02"), undefined, jan) === 3);
  ok("  the changeover stops at 9 months: 13.5", accruedTo(monthly, 2026, d("2027-06-01"), undefined, jan) === 13.5);
  ok("  the long changeover goes to 15 months: 22.5", accruedTo(monthly, 2026, d("2027-03-15"), undefined, back!.rules) === 22.5);
  ok("  leaving in March 2027 stops at March: 4.5", accruedTo(monthly, 2027, d("2027-12-01"), { exitedOn: d("2027-03-20") }, jan) === 4.5);

  section("3. Real balances");
  await cleanup();
  const found = await db.leaveYearSettings.findUnique({ where: { id: "global" } });
  try {
    const person = await db.user.create({ data: { name: `${TAG} Person`, email: `zzly-person${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    await db.employeeProfile.create({ data: { userId: person.id, joinedOn: d("2000-01-10") } });
    const make = (code: string, data: { annualQuota: number; accrual: "ANNUAL" | "MONTHLY" }) =>
      db.leaveType.create({ data: { code, name: `${TAG} ${code}`, active: false, paid: true, carryForward: true, createdAt: d("2000-06-01"), ...data } });
    const once = await make("ZZLYA", { annualQuota: 12, accrual: "ANNUAL" });
    const each = await make("ZZLYM", { annualQuota: 18, accrual: "MONTHLY" });

    await db.leaveYearSettings.deleteMany({ where: { id: "global" } });
    const before = await ensureBalance(person.id, once.id, 2001, d("2001-05-01"));
    ok("April 2001 under April to March: 12 at once", num(before?.credited) === 12, num(before?.credited));
    await db.leaveBalance.update({ where: { id: before!.id }, data: { used: 4 } });

    await db.leaveYearSettings.create({ data: { id: "global", rules: [{ fromYear: 2002, startMonth: 0 }] } });
    const cut = await ensureBalance(person.id, once.id, 2001, d("2001-11-01"));
    ok("the calendar year from 2002: April 2001's all-at-once grant comes down to 9", num(cut?.credited) === 9, num(cut?.credited));
    const monthlyCut = await ensureBalance(person.id, each.id, 2001, d("2001-12-20"));
    ok("  a twelfth a month stops at December: 13.5", num(monthlyCut?.credited) === 13.5, num(monthlyCut?.credited));
    const next = await ensureBalance(person.id, once.id, 2002, d("2002-01-01"));
    // The changeover closes at what it opened with (2000's 12, carried) + its 9 − the 4 taken.
    const closing = num(cut?.opening) + 9 - 4;
    ok("2002 opens on 1 January: 12 granted, what the changeover left carried", num(next?.credited) === 12 && num(next?.opening) === closing && closing === 17, `${num(next?.credited)} / ${num(next?.opening)}`);
  } finally {
    await db.leaveYearSettings.deleteMany({ where: { id: "global" } });
    if (found) await db.leaveYearSettings.create({ data: { id: "global", rules: found.rules ?? [], updatedById: found.updatedById } });
    await cleanup();
  }
  const after = await db.leaveYearSettings.findUnique({ where: { id: "global" } });
  ok("the workspace's own leave year is as it was found", JSON.stringify(after?.rules ?? null) === JSON.stringify(found?.rules ?? null));
}

main()
  .then(() => {
    console.log(failures ? `\n${failures} check(s) FAILED.` : "\nAll leave-year checks passed.");
    process.exitCode = failures ? 1 : 0;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
