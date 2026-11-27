/**
 * check:attendance-rate — the dashboard's Team Attendance counts every working day so far, recorded or not (owner,
 * 2 Nov 2026: "why showing 100% attendance?" — six clocked in out of 37, and the rest weren't counted).
 *
 * A department of its own (ZZPROBE_AR) on one past weekday: one present, one with no record, one on leave, one half
 * day, one who joined after it. Removed in a finally.
 *
 *   npm run check:attendance-rate
 */
import "dotenv/config";
import Module from "node:module";
import { directClient } from "../src/lib/tenancy/direct-client";

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const user = () => ({ id: actorId, role: "ADMIN", name: "Zzprobe", email: "actor@zzprobe-ar.invalid" });
    return { requireUser: async () => user(), currentUser: async () => user(), viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const db = directClient();
const TAG = "ZZPROBE_AR";
const MAIL = "@zzprobe-ar.invalid";
let failures = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (!pass) failures += 1;
};

async function cleanup() {
  const ids = (await db.user.findMany({ where: { email: { endsWith: MAIL } }, select: { id: true } })).map((u) => u.id);
  await db.attendanceDay.deleteMany({ where: { userId: { in: ids } } });
  await db.employeeProfile.deleteMany({ where: { userId: { in: ids } } });
  await db.user.deleteMany({ where: { id: { in: ids } } });
  await db.department.deleteMany({ where: { name: { startsWith: TAG } } });
}

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { attendanceRate, dashboardContext } = require("../src/lib/dashboard/data") as typeof import("../src/lib/dashboard/data");

  await cleanup();
  try {
    // The latest weekday at least a week back that isn't a holiday — a working day for anybody on the office's week.
    const holidays = new Set((await db.holiday.findMany({ select: { date: true } })).map((h) => h.date.toISOString().slice(0, 10)));
    const d = new Date();
    d.setUTCHours(0, 0, 0, 0);
    d.setUTCDate(d.getUTCDate() - 7);
    while ([0, 6].includes(d.getUTCDay()) || holidays.has(d.toISOString().slice(0, 10))) d.setUTCDate(d.getUTCDate() - 1);
    const day = new Date(d);
    const key = day.toISOString().slice(0, 10);
    const next = new Date(day);
    next.setUTCDate(next.getUTCDate() + 1);
    const nextKey = next.toISOString().slice(0, 10);

    const dept = await db.department.create({ data: { name: `${TAG} team` } });
    const mk = (local: string) =>
      db.user.create({ data: { name: `Zzprobe ${local}`, email: `${local}${MAIL}`, role: "SALES", passwordHash: "!", departmentId: dept.id }, select: { id: true } });
    const present = await mk("present");
    const missing = await mk("missing");
    const leave = await mk("leave");
    const half = await mk("half");
    const late = await mk("joined-later");
    await db.employeeProfile.create({ data: { userId: late.id, joinedOn: next } });
    const rec = (userId: string, status: "PRESENT" | "ON_LEAVE" | "HALF_DAY") => db.attendanceDay.create({ data: { userId, date: day, status } });
    await Promise.all([rec(present.id, "PRESENT"), rec(leave.id, "ON_LEAVE"), rec(half.id, "HALF_DAY")]);

    const admin = await db.user.findFirstOrThrow({ where: { isSuperAdmin: true }, select: { id: true } });
    actorId = admin.id;
    const ctx = await dashboardContext(admin.id);
    // Noon UTC on the day: that calendar day on any workspace clock from UTC−11 to UTC+11.
    const at = (k: string) => new Date(`${k}T12:00:00Z`);
    const rate = await attendanceRate(ctx, dept.id, at(key), new Date(at(key).getTime() + 60_000));
    // Present 1 of 1, half day ½ of 1, no record 0 of 1; on leave and not yet joined aren't due: 1.5 of 3.
    ok(`${key}: one present, one half day, one with no record — 50%`, rate === 50, rate);

    const after = await attendanceRate(await dashboardContext(admin.id), dept.id, at(nextKey), new Date(at(nextKey).getTime() + 60_000));
    ok(`${nextKey}: nobody recorded, the one who joined that day due too — 0%`, after === 0 || [0, 6].includes(next.getUTCDay()), after);

    const none = await attendanceRate(await dashboardContext(admin.id), "zz-no-department", at(key), new Date(at(key).getTime() + 60_000));
    ok("nobody to count is no figure, not 100%", none === null, none);
  } finally {
    await cleanup();
    await db.$disconnect();
  }
  console.log(failures ? `\n${failures} failed` : "\nAll passed");
  process.exit(failures ? 1 : 0);
}

void main();
