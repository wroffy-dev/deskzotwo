/**
 * check:leave-types — the super admin edits and deletes leave types (owner, 26 Nov 2026: "delete / edit option of leaves
 * type for super admin"; src/actions/hr.ts saveLeaveType, deleteLeaveType).
 *
 *   1. HR adds one, as before.
 *   2. Only the super admin changes it, and a change keeps what the form doesn't send.
 *   3. Only the super admin deletes it; one anybody has applied for is refused, switching it off is the way.
 *
 * Against the local workspace, on a type of its own (code ZZT), which it removes after.
 *
 *   npm run check:leave-types
 */
import "dotenv/config";
import Module from "node:module";

let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== undefined ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (title: string) => console.log(`\n— ${title} —\n`);

type Actor = { id: string; name: string; email: string; role: string; isSuperAdmin?: boolean };
let actor: Actor | null = null;
const who = async () => {
  if (!actor) throw new Error("The check called an action without saying who was calling it.");
  return actor;
};
const session = { requireUser: who, currentUser: async () => actor, requireModuleUser: who, requireModuleAccess: who, viewAsContext: async () => null, refuseWhileViewingAs: async () => null };
class NotFound extends Error {}
const navigation = {
  useRouter: () => ({ push: () => {}, refresh: () => {}, back: () => {} }),
  useSearchParams: () => new URLSearchParams(),
  usePathname: () => "/",
  notFound: () => {
    throw new NotFound("not found");
  },
  redirect: (to: string) => {
    throw new Error(`redirect ${to}`);
  },
};
const nextCache = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T,>(fn: T) => fn };
const load = Module.createRequire(__filename);
const react = { ...(load("react") as object), cache: <T,>(fn: T) => fn };
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
const byName = new Map<string, unknown>([
  ["next/cache", nextCache],
  ["next/navigation", navigation],
  ["@/lib/session", session],
  ["react", react],
]);
const byFile = new Map<string, unknown>([
  [load.resolve("next/cache"), nextCache],
  [load.resolve("next/navigation"), navigation],
  [load.resolve("../src/lib/session"), session],
  [load.resolve("react"), react],
]);
const realLoad = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (byName.has(request)) return byName.get(request);
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && byFile.has(resolved)) return byFile.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

async function main() {
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { db } = require("../src/lib/db") as typeof import("../src/lib/db");
  const { can } = require("../src/lib/authz/resolve") as typeof import("../src/lib/authz/resolve");
  const hr = require("../src/actions/hr") as typeof import("../src/actions/hr");
  /* eslint-enable @typescript-eslint/no-require-imports */
  const CODE = "ZZT";
  const cleanUp = async () => {
    const t = await db.leaveType.findMany({ where: { code: { in: [CODE, "ZZT2"] } }, select: { id: true } });
    await db.leaveRequest.deleteMany({ where: { typeId: { in: t.map((x) => x.id) } } });
    await db.leaveType.deleteMany({ where: { id: { in: t.map((x) => x.id) } } });
  };

  try {
    await cleanUp();
    const boss = await db.user.findFirst({ where: { isSuperAdmin: true, active: true }, select: { id: true, name: true, email: true, role: true } });
    if (!boss) throw new Error("No super admin in this workspace.");
    const others = await db.user.findMany({ where: { active: true, kind: "MEMBER", isSuperAdmin: false }, select: { id: true, name: true, email: true, role: true }, take: 80 });
    let hrPerson: (typeof others)[number] | null = null;
    for (const u of others) if (await can(u.id, "hr.manage")) {
      hrPerson = u;
      break;
    }
    if (!hrPerson) throw new Error("Nobody but the super admin manages people records here.");

    section("1. HR adds one");
    actor = hrPerson;
    const made = await hr.saveLeaveType({ code: CODE, name: "Zz probe leave", annualQuota: 3, accrual: "ANNUAL", paid: true, proofAfterDays: 2 });
    ok(`${hrPerson.name} adds a leave type`, made.ok, made.ok ? "" : made.error);
    if (!made.ok) return;
    const id = made.data.id;

    section("2. Changing it");
    const hrEdit = await hr.saveLeaveType({ id, code: CODE, name: "Zz renamed by HR", annualQuota: 3 });
    ok("HR can't change one", !hrEdit.ok && /super admin/.test(hrEdit.error), hrEdit.ok ? "it saved" : hrEdit.error);
    actor = { ...boss, isSuperAdmin: true };
    const edited = await hr.saveLeaveType({ id, code: CODE, name: "Zz probe leave, edited", annualQuota: 5, accrual: "MONTHLY", paid: false, active: false });
    const row = await db.leaveType.findUnique({ where: { id } });
    ok("the super admin can", edited.ok && row?.name === "Zz probe leave, edited" && Number(row.annualQuota) === 5 && row.accrual === "MONTHLY" && !row.paid && !row.active, row);
    ok("  and what the form doesn't send stays", row?.proofAfterDays === 2, row?.proofAfterDays);
    const log = await db.auditLog.findFirst({ where: { entityType: "LeaveType", entityId: id, action: "UPDATE" }, orderBy: { createdAt: "desc" }, select: { entityLabel: true } });
    ok("  written to the audit log, saying what changed", !!log && /3 → 5 days a year/.test(log.entityLabel ?? "") && /switched off/.test(log.entityLabel ?? ""), log?.entityLabel);
    const other = await hr.saveLeaveType({ code: "ZZT2", name: "Zz second", annualQuota: 1 });
    const clash = other.ok ? await hr.saveLeaveType({ id, code: "ZZT2", name: "Zz clash", annualQuota: 1 }) : null;
    ok("  a code another type has is refused", !!clash && !clash.ok && /already used/.test(clash.error), clash);

    section("3. Deleting it");
    actor = hrPerson;
    const hrDelete = await hr.deleteLeaveType(id);
    ok("HR can't delete one", !hrDelete.ok && (await db.leaveType.count({ where: { id } })) === 1, hrDelete.ok ? "deleted" : hrDelete.error);
    actor = { ...boss, isSuperAdmin: true };
    const day = new Date(Date.UTC(2026, 0, 5));
    await db.leaveRequest.create({ data: { userId: hrPerson.id, typeId: id, fromDate: day, toDate: day, days: 1, reason: "Zz probe", status: "PENDING" } as never });
    const usedDelete = await hr.deleteLeaveType(id);
    ok("one somebody applied for is refused, saying what to do", !usedDelete.ok && /1 leave request, which keeps its type/.test(usedDelete.error) && /Offered to people/.test(usedDelete.error), usedDelete.ok ? "deleted" : usedDelete.error);
    await db.leaveRequest.deleteMany({ where: { typeId: id } });
    const gone = await hr.deleteLeaveType(id);
    ok("one nobody used, the super admin deletes", gone.ok && (await db.leaveType.count({ where: { id } })) === 0, gone.ok ? "" : gone.error);
    const logged = await db.auditLog.count({ where: { entityType: "LeaveType", entityId: id, action: "DELETE" } });
    ok("  written to the audit log", logged === 1);
  } finally {
    actor = null;
    await cleanUp();
    await db.$disconnect();
  }
  console.log(failures ? `
${failures} of ${failures + passes} leave-type checks FAILED.` : `
All ${passes} leave-type checks passed.`);
  process.exit(failures ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
