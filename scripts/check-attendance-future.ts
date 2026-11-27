/**
 * check:attendance-future — attendance is never marked for a day still to come (owner, 18 Nov 2026: "no one can mark
 * future attendance"), by anybody — the super admin, who holds hr.manage, included. Today and earlier days still mark.
 * Its own person, removed in a finally with their days.
 *
 *   npm run check:attendance-future
 */
import "dotenv/config";
import Module from "node:module";
import { db } from "../src/lib/db";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};

let actorId = "";
const internals = Module as unknown as { _load(r: string, p: unknown, m: boolean): unknown };
const originalLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath() {}, revalidateTag() {}, unstable_cache: (fn: unknown) => fn };
  if (request === "@/lib/session" || request.endsWith("lib/session")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return { ...real, requireUser: user, currentUser: user, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
  }
  if (request === "@/lib/modules-access" || request.endsWith("lib/modules-access")) {
    const real = originalLoad.call(this, request, parent, isMain) as Record<string, unknown>;
    const user = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return { ...real, requireModuleUser: user, requireModuleAccess: user };
  }
  return originalLoad.call(this, request, parent, isMain);
} as typeof originalLoad;

const TAG = "ZZATTFUT";

async function main() {
  const admin = await db.user.findFirst({ where: { isSuperAdmin: true }, select: { id: true } });
  if (!admin) throw new Error("no super admin");
  actorId = admin.id;
  const { workspaceClock } = await import("../src/lib/time/workspace");
  const { markAttendance } = await import("../src/actions/attendance");
  const clock = await workspaceClock();
  const today = clock.today();
  const shift = (days: number) => {
    const d = new Date(`${today}T00:00:00Z`);
    d.setUTCDate(d.getUTCDate() + days);
    return d.toISOString().slice(0, 10);
  };
  const person = await db.user.create({ data: { name: `${TAG} person`, email: `p.${Date.now()}@zzattfut.invalid`, role: "SALES", passwordHash: "!" } as never, select: { id: true } });
  try {
    const mark = (date: string) => markAttendance({ userId: person.id, date, status: "PRESENT" });
    const tomorrow = await mark(shift(1));
    ok("tomorrow is refused, even for the super admin", !tomorrow.ok && /hasn't happened yet/.test(tomorrow.ok ? "" : tomorrow.error), tomorrow);
    const nextMonth = await mark(shift(40));
    ok("  and a day next month", !nextMonth.ok);
    const stored = await db.attendanceDay.count({ where: { userId: person.id } });
    ok("  nothing was written", stored === 0, stored);
    const todayMark = await mark(today);
    ok("today still marks", todayMark.ok, todayMark);
    const yesterday = await mark(shift(-1));
    ok("  and yesterday", yesterday.ok || /payroll/i.test(yesterday.ok ? "" : yesterday.error), yesterday);
  } finally {
    await db.attendanceDay.deleteMany({ where: { userId: person.id } });
    await db.user.delete({ where: { id: person.id } });
  }
}

main()
  .then(() => {
    console.log(`\n${passes} passed, ${failures} failed`);
    process.exit(failures ? 1 : 0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
