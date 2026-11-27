/**
 * check:service-cycles — service cycles (owner, 9 Nov 2026 — src/lib/service-cycles, src/actions/service-cycles.ts):
 *
 *   1. The rules by hand-worked cases: months added to a day, the timeline a plan makes, a job's state, keeping a
 *      timeline in step, what a plan can't be.
 *   2. On the database, a fixture of its own (ZZPROBE_SC, removed in a finally): a plan made, a cycle started — its
 *      jobs, the near one a task with its checklist; the task done is the job done; new dates move only planned jobs;
 *      a skipped job; a stopped cycle opens nothing; a step with jobs can't be removed; and the keys and the page link.
 *
 *   npm run check:service-cycles
 */
import "dotenv/config";
import Module from "node:module";
import { readFileSync } from "node:fs";
import { addDays, addMonths, cadenceWords, isDay, jobState, opensOn, reconcile, templateProblem, timeline } from "../src/lib/service-cycles/rules";

const TAG = "ZZPROBE_SC";
let failures = 0;
let passes = 0;
const ok = (label: string, pass: boolean, detail: unknown = "") => {
  console.log(`${pass ? "  ok  " : " FAIL "} ${label}${detail !== "" && !pass ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail)}` : ""}`);
  if (pass) passes += 1;
  else failures += 1;
};
const section = (t: string) => console.log(`\n— ${t} —\n`);

let actorId = "";
const internals = Module as unknown as { _load(req: string, parent: unknown, isMain: boolean): unknown };
const original = internals._load;
internals._load = function (this: unknown, request: string, parent: unknown, isMain: boolean) {
  if (request === "next/cache") return { revalidatePath: () => {}, revalidateTag: () => {}, unstable_cache: (fn: unknown) => fn };
  if (request.endsWith("lib/session") || request === "@/lib/session") {
    const u = async () => ({ id: actorId, name: "Probe", role: "ADMIN" });
    return { requireUser: u, currentUser: u, getCurrentUser: u };
  }
  return original.call(this, request, parent, isMain);
} as typeof original;

async function main() {
  section("1. The rules");
  ok("a month on: the same day", addMonths("2026-03-15", 1) === "2026-04-15");
  ok("31 Jan and a month is the last of February, leap or not", addMonths("2026-01-31", 1) === "2026-02-28" && addMonths("2028-01-31", 1) === "2028-02-29");
  ok("across a year, and backwards", addMonths("2026-11-30", 3) === "2027-02-28" && addMonths("2026-01-15", -1) === "2025-12-15");
  const steps = [
    { id: "visit", firstAfterMonths: 0, everyMonths: 3 },
    { id: "audit", firstAfterMonths: 12, everyMonths: 12 },
    { id: "renew", firstAfterMonths: 33, everyMonths: null },
  ];
  const t = timeline(steps, "2027-01-01", "2029-12-31");
  ok("a quarterly step over three years: twelve times", t.filter((j) => j.stepId === "visit").length === 12);
  ok("a yearly one from month 12: twice inside three years", JSON.stringify(t.filter((j) => j.stepId === "audit").map((j) => j.due)) === JSON.stringify(["2028-01-01", "2029-01-01"]));
  ok("one with no repeat: once", t.filter((j) => j.stepId === "renew").length === 1 && t.find((j) => j.stepId === "renew")?.due === "2029-10-01");
  ok("soonest first, each time counted", t[0]?.due === "2027-01-01" && t.at(-1)?.due === "2029-10-01" && t.filter((j) => j.stepId === "visit").at(-1)?.seq === 12);
  ok("counted from the start, so the 31st doesn't drift", JSON.stringify(timeline([{ id: "m", firstAfterMonths: 0, everyMonths: 1 }], "2026-01-31", "2026-04-30").map((j) => j.due)) === JSON.stringify(["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30"]));
  ok("nothing past the end", timeline([{ id: "x", firstAfterMonths: 24, everyMonths: null }], "2026-01-01", "2026-12-31").length === 0);
  ok("a task 14 days ahead opens two weeks before", opensOn("2026-12-15", 14) === "2026-12-01" && addDays("2026-12-31", 1) === "2027-01-01");
  const today = "2026-11-09";
  ok("states: skipped, done, overdue, to do, planned", [
    jobState({ due: "2026-11-01", skipped: true, task: null }, today) === "SKIPPED",
    jobState({ due: "2026-11-01", skipped: false, task: { done: true } }, today) === "DONE",
    jobState({ due: "2026-11-01", skipped: false, task: { done: false } }, today) === "OVERDUE",
    jobState({ due: "2026-11-20", skipped: false, task: { done: false } }, today) === "OPEN",
    jobState({ due: "2026-12-20", skipped: false, task: null }, today) === "PLANNED",
  ].every(Boolean));
  const plan = reconcile(
    [
      { id: "a", stepId: "visit", seq: 1, due: "2027-01-01", kept: true },
      { id: "b", stepId: "visit", seq: 2, due: "2027-04-01", kept: false },
      { id: "c", stepId: "visit", seq: 12, due: "2029-10-01", kept: false },
      { id: "d", stepId: "visit", seq: 13, due: "2030-01-01", kept: true },
    ],
    timeline([{ id: "visit", firstAfterMonths: 0, everyMonths: 3 }], "2027-02-01", "2028-01-31"),
  );
  ok("in step: a started job stays, a planned one moves, one past the new end goes", plan.move.some((m) => m.id === "b" && m.due === "2027-05-01") && plan.remove.includes("c") && !plan.remove.includes("a") && !plan.remove.includes("d") && !plan.move.some((m) => m.id === "a"));
  ok("  and what's new is added", plan.add.length === 2 && plan.add.every((a) => a.seq === 3 || a.seq === 4));
  const good = { name: "AMC", months: 12, steps: [{ name: "Visit", firstAfterMonths: 0, everyMonths: 3, showDaysBefore: 14, checklist: [] }] };
  ok("a plan saves when it's whole", templateProblem(good) === null);
  ok("not with no name, no step, a step unnamed, 0 months, a repeat of 0, or a lead of a year and more", [
    { ...good, name: " " },
    { ...good, steps: [] },
    { ...good, steps: [{ ...good.steps[0]!, name: "" }] },
    { ...good, months: 0 },
    { ...good, steps: [{ ...good.steps[0]!, everyMonths: 0 }] },
    { ...good, steps: [{ ...good.steps[0]!, showDaysBefore: 400 }] },
  ].every((t2) => templateProblem(t2) !== null));
  ok("a real day, not month 13 or 30 February", isDay("2026-02-28") && !isDay("2026-13-01") && !isDay("2026-02-30") && !isDay("09-11-2026"));
  ok("its words", cadenceWords({ firstAfterMonths: 0, everyMonths: 3 }) === "Every 3 months, from the start" && cadenceWords({ firstAfterMonths: 12, everyMonths: 12 }) === "Every year, from month 12" && cadenceWords({ firstAfterMonths: 33, everyMonths: null }) === "Once, from month 33");

  section("2. On the database");
  const { db } = await import("../src/lib/db");
  const admin = await db.user.findFirst({ where: { active: true, kind: "MEMBER", role: "ADMIN" }, select: { id: true } });
  const company = await db.company.findFirst({ where: { deletedAt: null } as never, select: { id: true, name: true } }).catch(() => db.company.findFirst({ select: { id: true, name: true } }));
  if (!admin || !company) {
    ok("an admin and a company to try it on", false);
    return;
  }
  actorId = admin.id;
  const actions = await import("../src/actions/service-cycles");
  const { openDueJobs } = await import("../src/lib/service-cycles/server");
  const { moveTask } = await import("../src/lib/tasks/server");
  const { workspaceClock } = await import("../src/lib/time/workspace");
  const now = (await workspaceClock()).today();
  const made: { templates: string[]; cycles: string[]; itemPlans: string[]; orders: string[] } = { templates: [], cycles: [], itemPlans: [], orders: [] };
  try {
    const saved = await actions.saveTemplate({
      name: `${TAG} Lift AMC`,
      months: 36,
      steps: [
        { name: "Preventive visit", firstAfterMonths: 0, everyMonths: 3, showDaysBefore: 14, checklist: ["Doors", "Brakes", ""] },
        { name: "Safety inspection", firstAfterMonths: 12, everyMonths: 12, showDaysBefore: 30, checklist: [] },
        { name: "Renewal quote", firstAfterMonths: 33, everyMonths: null, showDaysBefore: 30, checklist: [] },
      ],
    });
    ok("a plan made", saved.ok, saved);
    if (!saved.ok) return;
    const template = await actions.getTemplate(saved.data.seq);
    made.templates.push(template!.id);
    ok("  its steps in order, the blank checklist line dropped", template?.steps.map((s) => s.name).join() === "Preventive visit,Safety inspection,Renewal quote" && template.steps[0]?.checklist.join() === "Doors,Brakes");
    const refused = await actions.startCycle({ templateId: template!.id, companyId: company.id, startDate: "2026-13-01" });
    ok("a start that isn't a day is refused", !refused.ok);

    // Started a month ago: the first visit is due already, the next is two months off.
    const start = addMonths(now, -1);
    const started = await actions.startCycle({ templateId: template!.id, companyId: company.id, startDate: start, ownerUserId: admin.id });
    ok("a cycle started", started.ok, started);
    if (!started.ok) return;
    const detail = await actions.getCycle(started.data.seq);
    made.cycles.push(detail!.cycle.id);
    ok("  its end is the plan's length, less a day", detail?.cycle.end === addDays(addMonths(start, 36), -1), detail?.cycle.end);
    ok("  its timeline: 12 visits, 2 inspections, 1 renewal", detail?.jobs.length === 15, detail?.jobs.length);
    const first = detail!.jobs[0]!;
    ok("  the visit already due is a task, overdue, its owner's", !!first.taskId && first.state === "OVERDUE" && first.assignee?.id === admin.id, first);
    ok("  the rest are only planned", detail!.jobs.slice(1).every((j) => !j.taskId && j.state === "PLANNED"));
    const task = await db.task.findUnique({ where: { id: first.taskId! }, select: { title: true, companyId: true, assignedToUserId: true, dueDate: true, checklist: { orderBy: { sortOrder: "asc" }, select: { title: true } } } });
    ok("  the task: about the customer, due on the job's day, with the checklist", task?.companyId === company.id && task.title.startsWith("Preventive visit") && task.dueDate?.toISOString().slice(0, 10) === first.due && task.checklist.map((c) => c.title).join() === "Doors,Brakes", task);
    ok("  a second heartbeat makes no second task", (await openDueJobs({ cycleId: detail!.cycle.id })) === 0 && (await db.serviceJob.count({ where: { cycleId: detail!.cycle.id, taskId: { not: null } } })) === 1);
    // A job due in ten days, with its step a task 14 days ahead: a task now, not on its day.
    const soon = detail!.jobs.find((j) => j.stepName === "Preventive visit" && j.seq === 2)!;
    await db.serviceJob.update({ where: { id: soon.id }, data: { dueDate: new Date(`${addDays(now, 10)}T00:00:00Z`) } });
    ok("a job inside its lead is a task ahead of its day", (await openDueJobs({ cycleId: detail!.cycle.id })) === 1 && !!(await db.serviceJob.findUnique({ where: { id: soon.id }, select: { taskId: true } }))?.taskId);
    ok("  and Next 30 days lists it, as This month does when it falls in it", !!(await actions.listDueWork("next30", false))?.rows.some((r) => r.id === soon.id));
    const due = await actions.listDueWork("overdue", false);
    ok("Work due lists it as overdue", !!due?.rows.some((r) => r.id === first.id && r.state === "OVERDUE"));

    await moveTask(first.taskId!, "DONE");
    const afterDone = await actions.getCycle(started.data.seq);
    ok("the task done is the job done", afterDone?.jobs[0]?.state === "DONE" && afterDone.cycle.progress.done === 1);
    ok("  and it leaves Work due", !(await actions.listDueWork("all", false))?.rows.some((r) => r.id === first.id));

    const second = afterDone!.jobs[1]!;
    const skipNoWhy = await actions.skipJob(second.id, true, " ");
    const skipped = await actions.skipJob(second.id, true, "Site closed for renovation");
    ok("skipping needs a reason, and keeps it", !skipNoWhy.ok && skipped.ok && (await actions.getCycle(started.data.seq))?.jobs[1]?.state === "SKIPPED");
    ok("  a done job can't be skipped", !(await actions.skipJob(first.id, true, "x")).ok);

    // A month later: planned jobs follow, the done and skipped ones stay.
    const moved = await actions.updateCycle({ id: detail!.cycle.id, startDate: addMonths(start, 1), endDate: addDays(addMonths(start, 37), -1), ownerUserId: admin.id });
    const afterMove = await actions.getCycle(started.data.seq);
    const third = afterMove!.jobs.find((j) => j.stepName === "Preventive visit" && j.seq === 3);
    ok("new dates: planned jobs move", moved.ok && third?.due === addMonths(addMonths(start, 1), 6), third);
    ok("  the done and the skipped stay where they were", afterMove!.jobs.some((j) => j.id === first.id && j.due === first.due && j.state === "DONE") && afterMove!.jobs.some((j) => j.id === second.id && j.state === "SKIPPED"));

    const removeUsed = await actions.saveTemplate({ id: template!.id, name: `${TAG} Lift AMC`, months: 36, steps: template!.steps.filter((s) => s.name !== "Preventive visit") });
    ok("a step with jobs can't be removed", !removeUsed.ok && /can't be removed/.test(removeUsed.ok ? "" : removeUsed.error), removeUsed);

    await actions.setCycleStopped(detail!.cycle.id, true);
    await db.serviceJob.updateMany({ where: { cycleId: detail!.cycle.id, taskId: null, skipped: false }, data: { dueDate: new Date(`${now}T00:00:00Z`) } });
    ok("a stopped cycle opens nothing", (await openDueJobs({ cycleId: detail!.cycle.id })) === 0);
    ok("  and Work due leaves it out", !(await actions.listDueWork("all", false))?.rows.some((r) => r.cycle.id === detail!.cycle.id));

    section("3. Started by an approved order");
    const { startCycleForOrder } = await import("../src/lib/service-cycles/server");
    const order = await db.companyProduct.findFirst({
      where: { serviceCycles: { none: {} }, item: { servicePlan: null }, company: { ownerUserId: { not: null } } },
      select: { id: true, itemId: true, companyId: true, startDate: true, endDate: true, company: { select: { ownerUserId: true } } },
    });
    if (!order) ok("an order to try it on", false);
    else {
      made.itemPlans.push(order.itemId);
      made.orders.push(order.id);
      ok("an item with no plan: its order starts nothing", (await startCycleForOrder(order.id, admin.id)) === null);
      const named = await actions.setItemServicePlan(order.itemId, template!.id);
      const plan = await actions.itemServicePlan(order.itemId);
      ok("an item names its plan", named.ok && plan?.templateId === template!.id && plan.templateName === `${TAG} Lift AMC`, plan);
      const seq = await startCycleForOrder(order.id, admin.id);
      const auto = seq ? await actions.getCycle(seq) : null;
      if (auto) made.cycles.push(auto.cycle.id);
      const expectStart = order.startDate ? order.startDate.toISOString().slice(0, 10) : now;
      ok("approved, its cycle starts: the customer's, tied to the order, from the order's start", !!auto && auto.cycle.company.id === order.companyId && auto.cycle.start === expectStart && (await db.serviceCycle.count({ where: { orderId: order.id } })) === 1, auto?.cycle);
      ok("  its jobs the customer's account manager's", auto?.ownerUserId === order.company.ownerUserId, auto?.ownerUserId);
      ok("  approved again: no second cycle", (await startCycleForOrder(order.id, admin.id)) === null && (await db.serviceCycle.count({ where: { orderId: order.id } })) === 1);
      const byOrder = await actions.listCycles({ orderId: order.id });
      const byCompany = await actions.listCycles({ companyId: order.companyId });
      ok("the order's page and the customer's find it", byOrder?.rows.length === 1 && !!byCompany?.rows.some((r) => r.seq === seq) && (byOrder?.plansInUse ?? 0) >= 1);
      await actions.setTemplateActive(template!.id, false);
      await db.serviceCycle.deleteMany({ where: { orderId: order.id } });
      ok("a plan put away starts nothing", (await startCycleForOrder(order.id, admin.id)) === null);
      await actions.setTemplateActive(template!.id, true);
      const cleared = await actions.setItemServicePlan(order.itemId, null);
      ok("an item's plan can be taken off", cleared.ok && (await actions.itemServicePlan(order.itemId))?.templateId === null);
    }
    ok("approving an order starts it", /if \(approved\) await startCycleForOrder\(orderId, user\.id\)/.test(readFileSync("src/actions/order.ts", "utf8")));
    ok("the cards are on the customer, order and item pages", readFileSync("src/components/companies/company-detail.tsx", "utf8").includes("<CompanyServiceCycles") && readFileSync("src/components/orders/order-detail.tsx", "utf8").includes("<OrderServiceCycles") && readFileSync("src/app/(dashboard)/items/[id]/page.tsx", "utf8").includes("<ItemServicePlanCard"));

    section("4. Who and where");
    const perms = readFileSync("src/lib/permissions.ts", "utf8");
    ok("the two keys are declared", /key: "cycles.view"/.test(perms) && /key: "cycles.manage"/.test(perms));
    ok("  under Tasks", /"cycles.view": "tasks"/.test(readFileSync("src/lib/staff/permission-modules.ts", "utf8")) && /"service-cycles\.ts": \["tasks"\]/.test(readFileSync("src/lib/module-actions.ts", "utf8")));
    ok("the link is in the menu, for whoever sees them", /href: "\/service-cycles"[^\n]*permission: \["cycles.view", "cycles.manage"\]/.test(readFileSync("src/lib/modules.ts", "utf8")));
    ok("the heartbeat opens jobs", /openDueJobs\(\)/.test(readFileSync("src/lib/marketing/heartbeat.ts", "utf8")));
  } finally {
    const tasks = (await db.serviceJob.findMany({ where: { cycleId: { in: made.cycles } }, select: { taskId: true } })).flatMap((j) => (j.taskId ? [j.taskId] : []));
    const orderTasks = (await db.serviceJob.findMany({ where: { cycle: { orderId: { in: made.orders } } }, select: { taskId: true } })).flatMap((j) => (j.taskId ? [j.taskId] : []));
    tasks.push(...orderTasks);
    await db.serviceCycle.deleteMany({ where: { OR: [{ id: { in: made.cycles } }, { orderId: { in: made.orders } }] } });
    await db.itemServicePlan.deleteMany({ where: { itemId: { in: made.itemPlans } } });
    if (tasks.length) await db.task.deleteMany({ where: { id: { in: tasks } } });
    await db.serviceCycleTemplate.deleteMany({ where: { OR: [{ id: { in: made.templates } }, { name: { startsWith: TAG } }] } });
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
