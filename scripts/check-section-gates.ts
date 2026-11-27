/**
 * check:section-gates — a module's own actions ask what its pages ask (owner, 3 Nov 2026 — Phase 2 permission fixes,
 * audit L-6).
 *
 * The pages of a module refuse somebody whose role has the module's section unticked, or whose company switched the
 * module off (`decideModuleAccess`, src/lib/navigation.ts). A server action is a POST endpoint, so the actions only
 * those pages use ask the same (`requireModuleAccess`, src/lib/modules-access.ts); the actions another screen uses —
 * the side rail's tasks, the settings page's vault tags, the Deskzo app's attendance — ask only the plan
 * (`SHARED_ACTIONS`, src/lib/module-actions.ts), so unticking a section never breaks a page the person can still open.
 *
 * With the real resolver, the real actions and the real gate, as a person in a custom role:
 *
 *   1. every section ticked — Tasks, Vault, HR and Visitors' own actions, reads and writes, work;
 *   2. those four sections unticked for the role — each of them refuses ("Tasks isn't open to you."), writing nothing,
 *      while a shared action of each still works;
 *   3. the sections ticked again but Vault switched off by the company — Vault's own actions refuse, its shared one
 *      still works, and the switch is put back as it was.
 *
 * `check:module-guards` proves statically which actions ask what; this proves the gate itself holds.
 *
 * Everything is named ZZSECTIONS and removed again — the role, its person, their task, credential, holiday and kiosk,
 * and the company's module switch.
 *
 *   npm run check:section-gates
 */
import Module from "node:module";
import { db } from "../src/lib/db";
import { getModuleDefinition } from "../src/lib/modules";
import { sectionPermission } from "../src/lib/permissions";
import { SHARED_ACTIONS } from "../src/lib/module-actions";

const PREFIX = "ZZSECTIONS";
const ROLE = "ZZSECTIONS_GATES";
const EMAIL = "zzsections.gates@example.invalid";
/** The modules this suite unticks: three the audit names, and Visitors, whose actions are all its own pages'. */
const MODULES = ["tasks", "vault", "hr", "visitors"] as const;

let failures = 0;
function ok(label: string, pass: boolean, detail: unknown = "") {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && detail !== null && detail !== undefined ? ` — ${String(detail)}` : ""}`);
  if (!pass) failures += 1;
}
function section(title: string) {
  console.log(`\n— ${title} —\n`);
}

type Actor = { id: string; name: string; email: string; role: string; isSuperAdmin: boolean };
let actor: Actor | null = null;

const load = Module.createRequire(__filename);
const internals = Module as unknown as {
  _load(request: string, parent: unknown, isMain: boolean): unknown;
  _resolveFilename(request: string, parent: unknown, isMain: boolean): string;
};
class UnauthorizedError extends Error {}
const sessionStub = {
  UnauthorizedError,
  requireUser: async () => {
    if (!actor) throw new UnauthorizedError("The check called an action without saying who was calling it.");
    return actor;
  },
  currentUser: async () => actor,
  viewAsContext: async () => null,
  refuseWhileViewingAs: async () => null,
};
const cacheStub = { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: <T>(fn: T) => fn };
const substitutes = new Map<string, unknown>([
  [load.resolve("../src/lib/session"), sessionStub],
  [load.resolve("next/cache"), cacheStub],
]);
const realLoad = internals._load;
internals._load = function (request: string, parent: unknown, isMain: boolean) {
  let resolved: string | null = null;
  try {
    resolved = internals._resolveFilename(request, parent, isMain);
  } catch {
    resolved = null;
  }
  if (resolved !== null && substitutes.has(resolved)) return substitutes.get(resolved);
  return realLoad.call(this, request, parent, isMain);
};

const access = load("../src/lib/modules-access") as typeof import("../src/lib/modules-access");
const task = load("../src/actions/task") as typeof import("../src/actions/task");
const taskExtras = load("../src/actions/task-extras") as typeof import("../src/actions/task-extras");
const vault = load("../src/actions/vault") as typeof import("../src/actions/vault");
const hr = load("../src/actions/hr") as typeof import("../src/actions/hr");
const attendance = load("../src/actions/attendance") as typeof import("../src/actions/attendance");
const visitor = load("../src/actions/visitor") as typeof import("../src/actions/visitor");

/** What one call came to: its value, or what it threw. */
async function attempt(fn: () => Promise<unknown>): Promise<{ value?: unknown; error?: unknown }> {
  try {
    return { value: await fn() };
  } catch (error) {
    return { error };
  }
}
const label = (key: string) => getModuleDefinition(key)!.label;
const refusedFor = (r: { error?: unknown }, key: string) => r.error instanceof access.ModuleNotOpen && (r.error as Error).message === `${label(key)} isn't open to you.`;
/** A call that went through: no throw, and no "ok: false" or null where the action answers so. */
const worked = (r: { value?: unknown; error?: unknown }) => {
  if (r.error) return false;
  const v = r.value as { ok?: boolean } | null | undefined;
  return v !== null && v !== undefined && (typeof v !== "object" || !("ok" in v) || v.ok === true);
};
const why = (r: { value?: unknown; error?: unknown }) => (r.error ? String(r.error) : JSON.stringify(r.value)?.slice(0, 160));

async function cleanup() {
  const users = await db.user.findMany({ where: { email: EMAIL }, select: { id: true } });
  const ids = users.map((u) => u.id);
  if (ids.length) {
    await db.task.deleteMany({ where: { OR: [{ createdByUserId: { in: ids } }, { assignedToUserId: { in: ids } }] } });
    await db.vaultCredential.deleteMany({ where: { OR: [{ ownerId: { in: ids } }, { loginName: { startsWith: PREFIX } }] } });
    await db.notification.deleteMany({ where: { userId: { in: ids } } });
    await db.auditLog.deleteMany({ where: { userId: { in: ids } } });
    await db.userPermission.deleteMany({ where: { userId: { in: ids } } });
    await db.user.deleteMany({ where: { id: { in: ids } } });
  }
  await db.holiday.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.visitorKiosk.deleteMany({ where: { name: { startsWith: PREFIX } } });
  await db.rolePermission.deleteMany({ where: { role: ROLE } });
  await db.role.deleteMany({ where: { key: ROLE } });
}

/** Ticks or unticks the four sections for the role — a row saying no, or none (every role holds a section by default). */
async function setSections(ticked: boolean) {
  const keys = MODULES.map((m) => sectionPermission(m));
  if (ticked) await db.rolePermission.deleteMany({ where: { role: ROLE, permission: { in: keys } } });
  else for (const permission of keys) await db.rolePermission.upsert({ where: { role_permission: { role: ROLE, permission } }, create: { role: ROLE, permission, allowed: false }, update: { allowed: false } });
}

async function main() {
  section("What is under test");
  // The owned actions are asked of the section; the shared ones are listed as shared, and so ask only the plan.
  const owned = ["task.ts toggleTaskStar", "task-extras.ts addChecklistItem", "task-extras.ts taskFormOptions", "task-extras.ts listTaskChallenges", "vault.ts listVault", "vault.ts vaultOptions", "vault.ts saveCredential", "hr.ts listHolidays", "hr.ts saveHoliday", "attendance.ts myClockPolicy", "visitor.ts listVisitors", "visitor.ts listKiosks", "visitor.ts saveKiosk"];
  const shared = ["task.ts myOpenTasks", "vault.ts listCredentialTags", "attendance.ts myToday"];
  ok("the actions refused below are their modules' own — none is in SHARED_ACTIONS", owned.every((k) => !SHARED_ACTIONS[k]), owned.filter((k) => SHARED_ACTIONS[k]).join(", "));
  ok("  and the ones that must keep working are shared, each with its reason", shared.every((k) => !!SHARED_ACTIONS[k]), shared.filter((k) => !SHARED_ACTIONS[k]).join(", "));
  const entitled = await Promise.all(MODULES.map((m) => access.isModuleEntitled(m)));
  ok("this workspace's plan has Tasks, Vault, HR and Visitors", entitled.every(Boolean), MODULES.filter((_, i) => !entitled[i]).join(", "));
  if (!entitled.every(Boolean)) return;

  // The company's own switches for the four, put back as they were at the end.
  const before = await db.systemModule.findMany({ where: { key: { in: [...MODULES] } } });
  await cleanup();
  try {
    for (const key of MODULES) await db.systemModule.upsert({ where: { key }, create: { key, enabled: true }, update: { enabled: true } });

    section("The fixture");
    await db.role.create({ data: { key: ROLE, name: `${PREFIX} gates`, description: "check:section-gates — removed when it ends" } });
    // What the four modules' actions need beyond the section: Vault's use, HR's management, Visitors' both.
    for (const permission of ["vault.use", "hr.manage", "visitors.view", "visitors.manage"]) await db.rolePermission.create({ data: { role: ROLE, permission, allowed: true } });
    const user = await db.user.create({ data: { name: `${PREFIX} Person`, email: EMAIL, passwordHash: "x".repeat(60), role: ROLE, active: true } });
    actor = { id: user.id, name: user.name, email: user.email, role: user.role, isSuperAdmin: false };
    const theirTask = await db.task.create({ data: { title: `${PREFIX} task`, createdByUserId: user.id, assignedToUserId: user.id } });
    ok("a custom role holding Vault, HR's management and Visitors, a person in it, and their own task", true);

    // Each module's own actions, a read and a write at least; and a shared action of each that has one.
    let n = 0;
    const ownCalls: { module: (typeof MODULES)[number]; name: string; write: boolean; call: () => Promise<unknown> }[] = [
      { module: "tasks", name: "taskFormOptions", write: false, call: () => taskExtras.taskFormOptions() },
      { module: "tasks", name: "listTaskChallenges", write: false, call: () => taskExtras.listTaskChallenges() },
      { module: "tasks", name: "toggleTaskStar", write: true, call: () => task.toggleTaskStar(theirTask.id) },
      { module: "tasks", name: "addChecklistItem", write: true, call: () => taskExtras.addChecklistItem(theirTask.id, `${PREFIX} step ${(n += 1)}`) },
      { module: "vault", name: "listVault", write: false, call: () => vault.listVault() },
      { module: "vault", name: "vaultOptions", write: false, call: () => vault.vaultOptions() },
      { module: "vault", name: "saveCredential", write: true, call: () => vault.saveCredential({ loginName: `${PREFIX} login ${(n += 1)}`, secret: "zz-not-a-real-password" }) },
      { module: "hr", name: "listHolidays", write: false, call: () => hr.listHolidays() },
      { module: "hr", name: "myClockPolicy", write: false, call: () => attendance.myClockPolicy() },
      { module: "hr", name: "saveHoliday", write: true, call: () => hr.saveHoliday({ name: `${PREFIX} holiday ${(n += 1)}`, date: `2031-01-${String(n).padStart(2, "0")}` }) },
      { module: "visitors", name: "listVisitors", write: false, call: () => visitor.listVisitors() },
      { module: "visitors", name: "listKiosks", write: false, call: () => visitor.listKiosks() },
      { module: "visitors", name: "saveKiosk", write: true, call: () => visitor.saveKiosk({ name: `${PREFIX} desk ${(n += 1)}` }) },
    ];
    const sharedCalls: { module: string; name: string; call: () => Promise<unknown> }[] = [
      { module: "tasks", name: "myOpenTasks (the side rail)", call: () => task.myOpenTasks() },
      { module: "vault", name: "listCredentialTags (Settings › Lists)", call: () => vault.listCredentialTags() },
      { module: "hr", name: "myToday (the Deskzo app)", call: () => attendance.myToday().then((r) => r ?? "no row today") },
    ];
    /** What the person's writes have left behind — a refused write leaves nothing. */
    const written = async () => ({
      stars: await db.taskStar.count({ where: { userId: user.id } }),
      steps: await db.taskChecklistItem.count({ where: { taskId: theirTask.id } }),
      credentials: await db.vaultCredential.count({ where: { ownerId: user.id } }),
      holidays: await db.holiday.count({ where: { name: { startsWith: PREFIX } } }),
      kiosks: await db.visitorKiosk.count({ where: { name: { startsWith: PREFIX } } }),
    });

    section("1. Every section ticked");
    for (const key of MODULES) ok(`${label(key)} is open to them, by the rule the menu uses`, (await access.moduleAccessFor(user.id, key)) === "available");
    for (const c of ownCalls) {
      const r = await attempt(c.call);
      ok(`  ${label(c.module)}: ${c.name} ${c.write ? "(a write)" : "(a read)"} works`, worked(r), worked(r) ? "" : why(r));
    }
    for (const c of sharedCalls) {
      const r = await attempt(c.call);
      ok(`  ${label(c.module)}: ${c.name}, a shared action, works`, worked(r), worked(r) ? "" : why(r));
    }

    section("2. Tasks, Vault, HR and Visitors unticked for the role");
    await setSections(false);
    for (const key of MODULES) ok(`${label(key)} is not open to them — as their menu and pages say`, (await access.moduleAccessFor(user.id, key)) === "no-permission");
    const was = await written();
    for (const c of ownCalls) {
      const r = await attempt(c.call);
      ok(`  ${label(c.module)}: ${c.name} ${c.write ? "(a write)" : "(a read)"} is refused — "${label(c.module)} isn't open to you."`, refusedFor(r, c.module), refusedFor(r, c.module) ? "" : why(r));
    }
    const now = await written();
    ok("  and the refused writes wrote nothing", JSON.stringify(now) === JSON.stringify(was), `${JSON.stringify(was)} → ${JSON.stringify(now)}`);
    for (const c of sharedCalls) {
      const r = await attempt(c.call);
      ok(`  ${label(c.module)}: ${c.name}, a shared action, still works — another screen uses it`, worked(r), worked(r) ? "" : why(r));
    }
    const plan = await attempt(() => access.requireModuleUser("tasks"));
    ok("  the plan alone still lets them through — what a shared action asks", !plan.error, plan.error ? why(plan) : "");

    section("3. Ticked again, and Vault switched off by the company");
    await setSections(true);
    await db.systemModule.update({ where: { key: "vault" }, data: { enabled: false } });
    ok("Vault is switched off for them, as for everybody", (await access.moduleAccessFor(user.id, "vault")) === "switched-off");
    for (const c of ownCalls.filter((c) => c.module === "vault")) {
      const r = await attempt(c.call);
      ok(`  ${c.name} is refused`, refusedFor(r, "vault"), refusedFor(r, "vault") ? "" : why(r));
    }
    for (const c of sharedCalls.filter((c) => c.module === "vault")) {
      const r = await attempt(c.call);
      ok(`  ${c.name} still works`, worked(r), worked(r) ? "" : why(r));
    }
    const tasksStill = await attempt(() => taskExtras.taskFormOptions());
    ok("  while Tasks, still on and ticked, answers", worked(tasksStill), worked(tasksStill) ? "" : why(tasksStill));
  } finally {
    actor = null;
    await cleanup();
    // The company's switches as they were: a row put back, or none where there was none.
    await db.systemModule.deleteMany({ where: { key: { in: [...MODULES] } } });
    for (const row of before) await db.systemModule.create({ data: { key: row.key, enabled: row.enabled } });
    const after = await db.systemModule.findMany({ where: { key: { in: [...MODULES] } } });
    ok(
      "cleaned up — the role, its person and what they made are gone, and the switches are as they were",
      (await db.role.count({ where: { key: ROLE } })) === 0 &&
        (await db.user.count({ where: { email: EMAIL } })) === 0 &&
        JSON.stringify(after.map((r) => [r.key, r.enabled]).sort()) === JSON.stringify(before.map((r) => [r.key, r.enabled]).sort()),
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    failures += 1;
  })
  .finally(async () => {
    await db.$disconnect();
    console.log(failures === 0 ? "\nAll section gate checks passed." : `\n${failures} check(s) FAILED.`);
    process.exit(failures === 0 ? 0 : 1);
  });
