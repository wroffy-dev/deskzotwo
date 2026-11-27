/**
 * check:resignation — resignations, handed in and decided (src/actions/resignation.ts), and the exit they record
 * (src/lib/hr/exit.ts), which HR recording one by hand shares.
 *
 * The notice arithmetic first, then a fixture of its own: an employee, their manager, HR, an outsider. Notifications
 * are caught rather than sent, so nobody real hears of it. Everything is named ZZPROBE_RS and removed in a finally.
 *
 *   npm run check:resignation
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actor: { id: string; name: string; email: string } | null = null;
const told: { userId: string; type: string; title: string }[] = [];
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => (actor ? { ...actor, role: "SALES" } : null);
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/notify") return { notifyUser: async (n: { userId: string; type: string; title: string }) => void told.push(n) };
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_RS";
const MAIL = "@zzprobe-rs.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);
const d = (iso: string) => new Date(`${iso}T00:00:00Z`);
const iso = (x: Date) => x.toISOString().slice(0, 10);

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  await db.task.deleteMany({ where: { OR: [{ aboutUserId: { in: ids } }, { createdByUserId: { in: ids } }] } });
  await db.resignation.deleteMany({ where: { userId: { in: ids } } });
  await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
  await db.employeeProfile.deleteMany({ where: { userId: { in: ids } } });
  await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
  await db.user.updateMany({ where: { id: { in: ids } }, data: { managerId: null } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const rules = require("../src/lib/hr/resignation-rules") as typeof import("../src/lib/hr/resignation-rules");
  const actions = require("../src/actions/resignation") as typeof import("../src/actions/resignation");
  const hr = require("../src/actions/hr") as typeof import("../src/actions/hr");
  /* eslint-enable @typescript-eslint/no-require-imports */

  section("Notice");
  ok("30 days' notice from 1 November: the last working day is 1 December", iso(rules.lastDayForNotice(d("2026-11-01"), 30)) === "2026-12-01");
  ok("leaving on 21 November: 10 days short", rules.noticeShortfall(d("2026-11-01"), 30, d("2026-11-21")) === 10);
  ok("leaving after the notice ends: none short", rules.noticeShortfall(d("2026-11-01"), 30, d("2026-12-15")) === 0);
  ok("a last day before handing it in, or over a year away, is refused", !!rules.lastDayProblem(d("2026-11-01"), d("2026-10-31")) && !!rules.lastDayProblem(d("2026-11-01"), d("2027-11-02")) && rules.lastDayProblem(d("2026-11-01"), d("2026-11-01")) === null);

  await cleanup();
  try {
    section("The fixture");
    const make = (name: string) => db.user.create({ data: { name: `${TAG} ${name}`, email: `${name.toLowerCase()}${MAIL}`, role: "SALES", passwordHash: "x".repeat(60) } });
    const boss = await make("Boss");
    const emp = await make("Employee");
    const hrPerson = await make("Hr");
    const outsider = await make("Outsider");
    const leaver = await make("Leaver");
    await db.user.update({ where: { id: emp.id }, data: { managerId: boss.id } });
    await db.employeeProfile.create({ data: { userId: emp.id, noticePeriodDays: 45 } });
    await db.userPermission.create({ data: { userId: hrPerson.id, permission: "hr.manage", allowed: true, reason: TAG } });
    const as = (u: { id: string; name: string; email: string }) => (actor = { id: u.id, name: u.name, email: u.email });
    ok("an employee with 45 days' notice, their manager, HR and an outsider", true);

    section("Handing it in");
    as(emp);
    const mine = await actions.myResignation();
    ok("My HR offers it: 45 days' notice, the last day it makes", mine.latest === null && mine.noticeDays === 45 && mine.suggestedLastDay === iso(rules.lastDayForNotice(d(mine.today), 45)));
    ok("a reason is asked for", !(await actions.submitResignation({ reason: "", lastDay: mine.suggestedLastDay })).ok);
    const early = iso(new Date(d(mine.today).getTime() + 15 * 86_400_000));
    const handed = await actions.submitResignation({ reason: "Moving to Pune", lastDay: early });
    ok("handed in, asking to leave in 15 days", handed.ok, handed.ok ? "" : handed.error);
    ok("  their manager is told — and HR", told.some((t) => t.userId === boss.id && t.type === "RESIGNATION_SUBMITTED") && told.some((t) => t.userId === hrPerson.id), told.map((t) => t.userId === boss.id ? "boss" : t.userId === hrPerson.id ? "hr" : "other"));
    ok("  a second while one waits is refused", !(await actions.submitResignation({ reason: "Again", lastDay: early })).ok);
    const now = await actions.myResignation();
    ok("  it waits, 30 days of notice short", now.latest?.status === "PENDING" && now.latest.shortfall === 30, now.latest);

    section("Withdrawing");
    const id1 = handed.ok ? handed.data.id : "";
    as(outsider);
    ok("nobody else withdraws it", !(await actions.withdrawResignation(id1)).ok);
    as(emp);
    ok("they may, while it waits", (await actions.withdrawResignation(id1)).ok);
    const again = await actions.submitResignation({ reason: "Moving to Pune, for good", lastDay: mine.suggestedLastDay });
    ok("…and hand in another", again.ok);
    const id2 = again.ok ? again.data.id : "";

    section("Deciding");
    as(emp);
    ok("not their own", !(await actions.decideResignation({ id: id2, accept: true })).ok);
    as(outsider);
    ok("not somebody they don't report to", !(await actions.decideResignation({ id: id2, accept: true })).ok);
    as(boss);
    const queue = await actions.resignationsToDecide();
    ok("their manager has it waiting", queue.some((r) => r.id === id2));
    ok("turning it down needs a reason", !(await actions.decideResignation({ id: id2, accept: false })).ok);
    const accepted = await actions.decideResignation({ id: id2, accept: true, note: "All the best" });
    ok("accepted for the day the notice ends", accepted.ok, accepted.ok ? "" : accepted.error);
    const profile = await db.employeeProfile.findUnique({ where: { userId: emp.id }, select: { exitedOn: true, exitType: true, exitReason: true } });
    ok("  the exit is recorded: that day, resigned, the reason", !!profile?.exitedOn && iso(profile.exitedOn) === mine.suggestedLastDay && profile.exitType === "RESIGNED" && profile.exitReason === "Moving to Pune, for good", profile);
    ok("  the offboarding tasks are raised", (await db.task.count({ where: { aboutUserId: emp.id, hrStage: "OFFBOARDING" } })) > 0);
    ok("  their login stays on until then", (await db.user.findUniqueOrThrow({ where: { id: emp.id }, select: { active: true } })).active);
    ok("  they hear it's accepted", told.some((t) => t.userId === emp.id && t.type === "RESIGNATION_DECIDED"));
    as(emp);
    const after = await actions.myResignation();
    ok("  My HR shows it accepted, and offers no new one", after.latest?.status === "ACCEPTED" && after.exited);
    ok("  a new one is refused once the exit is recorded", !(await actions.submitResignation({ reason: "x x x", lastDay: after.suggestedLastDay })).ok);
    as(hrPerson);
    ok("HR sees it on their record and may decide such things", (await actions.resignationFor(emp.id)).canDecide && (await actions.resignationFor(emp.id)).resignation?.status === "ACCEPTED");
    as(outsider);
    ok("an outsider sees nothing of it", (await actions.resignationFor(emp.id)).resignation === null);

    section("HR recording an exit by hand still does all of it");
    as(hrPerson);
    const recorded = await hr.recordExit({ userId: leaver.id, exitedOn: "2026-12-31", exitType: "TERMINATED", exitReason: "  ", deactivateLogin: true });
    const lp = await db.employeeProfile.findUnique({ where: { userId: leaver.id }, select: { exitedOn: true, exitType: true, exitReason: true } });
    ok("recorded: the day, the type, no reason for blanks", recorded.ok && !!lp?.exitedOn && iso(lp.exitedOn) === "2026-12-31" && lp.exitType === "TERMINATED" && lp.exitReason === null, recorded.ok ? lp : recorded.error);
    ok("  the login switched off, and the offboarding tasks raised", !(await db.user.findUniqueOrThrow({ where: { id: leaver.id }, select: { active: true } })).active && (await db.task.count({ where: { aboutUserId: leaver.id, hrStage: "OFFBOARDING" } })) > 0);
  } finally {
    actor = null;
    await cleanup();
    const left = await db.user.count({ where: { email: { endsWith: MAIL } } });
    ok("nothing of the fixture is left behind", left === 0, left);
    await db.$disconnect();
  }

  console.log(failures === 0 ? "\nAll resignation checks passed." : `\n${failures} check(s) FAILED.`);
  if (failures > 0) process.exit(1);
}

main().catch(async (err) => {
  console.error(err);
  await cleanup().catch(() => {});
  await db.$disconnect();
  process.exit(1);
});
