import { db } from "@/lib/db";
import { emitTask } from "@/lib/automate/emit-records";
import { notifyUser } from "@/lib/notify";
import { notMigratedYet } from "@/lib/not-migrated";
import { storedDay } from "@/lib/tasks/server";
import { workspaceClock } from "@/lib/time/workspace";
import { addDays, addMonths, jobState, opensOn, reconcile, timeline, type JobState } from "./rules";

/**
 * Service cycles on the database (owner, 9 Nov 2026 — the rules are ./rules.ts). A cycle's timeline is kept as jobs; a job
 * becomes its owner's task when it's near — on the heartbeat, and as soon as a cycle starts — and is done when that task
 * is. The task is the work: the phone app, reminders, the checklist and Automate all come with it.
 */

const dayOf = (d: Date) => d.toISOString().slice(0, 10);
const OPEN_A_TIME = 200;

/** Brings a cycle's jobs in step with its plan and dates. Started jobs — a task made, or skipped — are never touched. */
export async function syncCycle(cycleId: string): Promise<void> {
  const cycle = await db.serviceCycle.findUnique({
    where: { id: cycleId },
    select: { startDate: true, endDate: true, template: { select: { steps: { select: { id: true, firstAfterMonths: true, everyMonths: true } } } }, jobs: { select: { id: true, stepId: true, seq: true, dueDate: true, taskId: true, skipped: true } } },
  });
  if (!cycle) return;
  const wanted = timeline(cycle.template.steps, dayOf(cycle.startDate), dayOf(cycle.endDate));
  const plan = reconcile(
    cycle.jobs.map((j) => ({ id: j.id, stepId: j.stepId, seq: j.seq, due: dayOf(j.dueDate), kept: !!j.taskId || j.skipped })),
    wanted,
  );
  await db.$transaction(async (tx) => {
    if (plan.remove.length) await tx.serviceJob.deleteMany({ where: { id: { in: plan.remove } } });
    for (const m of plan.move) await tx.serviceJob.update({ where: { id: m.id }, data: { dueDate: storedDay(m.due) } });
    if (plan.add.length) await tx.serviceJob.createMany({ data: plan.add.map((a) => ({ cycleId, stepId: a.stepId, seq: a.seq, dueDate: storedDay(a.due) })), skipDuplicates: true });
  });
}

/** The end a cycle gets when it isn't given one: the plan's length, less a day. */
export const defaultEnd = (start: string, months: number) => {
  const next = addMonths(start, months);
  return new Date(Date.parse(`${next}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);
};

/**
 * Makes the task for every job now near — every active cycle's, or one cycle's — a few hundred at a time. Each task is in
 * the owner's name, about the customer, due on the job's day, with the step's checklist. Never throws for a workspace
 * without the tables yet.
 */
export async function openDueJobs(options: { cycleId?: string } = {}): Promise<number> {
  try {
    const today = (await workspaceClock()).today();
    // Near enough for the largest lead any step has; each job is checked against its own below.
    const horizon = storedDay(addDays(today, 366));
    const jobs = await db.serviceJob.findMany({
      where: { taskId: null, skipped: false, dueDate: { lte: horizon }, cycle: { status: "ACTIVE", ...(options.cycleId ? { id: options.cycleId } : {}) } },
      orderBy: { dueDate: "asc" },
      take: OPEN_A_TIME * 3,
      select: {
        id: true,
        seq: true,
        dueDate: true,
        step: { select: { name: true, showDaysBefore: true, checklist: true } },
        cycle: { select: { id: true, seq: true, ownerUserId: true, createdById: true, companyId: true, endDate: true, company: { select: { name: true } }, template: { select: { name: true } } } },
      },
    });
    let opened = 0;
    for (const job of jobs) {
      if (opened >= OPEN_A_TIME) break;
      const due = dayOf(job.dueDate);
      if (opensOn(due, job.step.showDaysBefore) > today) continue;
      const title = `${job.step.name} — ${job.cycle.company.name}`.slice(0, 200);
      const task = await db.$transaction(async (tx) => {
        // Claimed first, so two heartbeats at once make one task.
        const made = await tx.task.create({
          data: {
            title,
            description: `${job.cycle.template.name}, cycle #${job.cycle.seq}: ${job.step.name}, time ${job.seq}. Done here when this task is done.`,
            dueDate: storedDay(due),
            assignedToUserId: job.cycle.ownerUserId,
            createdByUserId: job.cycle.createdById,
            companyId: job.cycle.companyId,
            status: "TODO",
          },
          select: { id: true },
        });
        const claimed = await tx.serviceJob.updateMany({ where: { id: job.id, taskId: null }, data: { taskId: made.id } });
        if (claimed.count === 0) throw new AlreadyOpened();
        if (job.step.checklist.length) await tx.taskChecklistItem.createMany({ data: job.step.checklist.map((line, sortOrder) => ({ taskId: made.id, title: line.slice(0, 300), sortOrder })) });
        await emitTask(tx, "task.created", made.id, null);
        return made;
      }).catch((err) => {
        if (err instanceof AlreadyOpened) return null;
        throw err;
      });
      if (!task) continue;
      opened += 1;
      if (job.cycle.ownerUserId) await notifyUser({ userId: job.cycle.ownerUserId, type: "TASK_ASSIGNED", title: "A service job is coming up", message: title, link: "/tasks" });
    }
    return opened;
  } catch (err) {
    if (notMigratedYet(err)) return 0;
    throw err;
  }
}

class AlreadyOpened extends Error {}

/**
 * An approved order whose item names a plan starts that plan's cycle for the customer (owner, 9 Nov 2026): from the
 * order's start (else today) to its end (else the plan's length), its jobs the customer's account manager's (else
 * whoever punched the order). Once an order: a second approval, or one started by hand, makes no second cycle. A renewal
 * is its own order, so it starts its own cycle. Never throws — the order is approved either way.
 */
export async function startCycleForOrder(orderId: string, actorId: string): Promise<number | null> {
  try {
    const order = await db.companyProduct.findUnique({
      where: { id: orderId },
      select: { id: true, companyId: true, startDate: true, endDate: true, addedByUserId: true, company: { select: { ownerUserId: true } }, item: { select: { servicePlan: { select: { template: { select: { id: true, months: true, active: true } } } } } } },
    });
    const template = order?.item.servicePlan?.template;
    if (!order || !template?.active) return null;
    if (await db.serviceCycle.findFirst({ where: { orderId }, select: { id: true } })) return null;
    const start = order.startDate ? dayOf(order.startDate) : (await workspaceClock()).today();
    const end = order.endDate && dayOf(order.endDate) >= start ? dayOf(order.endDate) : defaultEnd(start, template.months);
    const owner = order.company.ownerUserId ?? order.addedByUserId;
    const ownerActive = owner ? await db.user.findFirst({ where: { id: owner, active: true }, select: { id: true } }) : null;
    const cycle = await db.serviceCycle.create({
      data: { templateId: template.id, companyId: order.companyId, orderId, startDate: storedDay(start), endDate: storedDay(end), ownerUserId: ownerActive?.id ?? null, createdById: actorId },
      select: { id: true, seq: true },
    });
    await syncCycle(cycle.id);
    await openDueJobs({ cycleId: cycle.id });
    return cycle.seq;
  } catch (err) {
    if (!notMigratedYet(err)) console.error("[service cycles] an order's cycle couldn't start", err instanceof Error ? err.message : err);
    return null;
  }
}

export type JobRow = {
  id: string;
  due: string;
  state: JobState;
  stepName: string;
  seq: number;
  taskId: string | null;
  skippedReason: string | null;
  cycle: { id: string; seq: number; templateName: string };
  company: { id: string; name: string; companySeq: number };
  assignee: { id: string; name: string } | null;
};

const JOB_SELECT = {
  id: true,
  seq: true,
  dueDate: true,
  skipped: true,
  skippedReason: true,
  taskId: true,
  task: { select: { done: true, assignedTo: { select: { id: true, name: true } } } },
  step: { select: { name: true } },
  cycle: { select: { id: true, seq: true, ownerUserId: true, template: { select: { name: true } }, company: { select: { id: true, name: true, companySeq: true } } } },
} as const;

type JobRecord = {
  id: string;
  seq: number;
  dueDate: Date;
  skipped: boolean;
  skippedReason: string | null;
  taskId: string | null;
  task: { done: boolean; assignedTo: { id: string; name: string } | null } | null;
  step: { name: string };
  cycle: { id: string; seq: number; ownerUserId: string | null; template: { name: string }; company: { id: string; name: string; companySeq: number } };
};

function rowOf(j: JobRecord, today: string, owners: Map<string, { id: string; name: string }>): JobRow {
  const due = dayOf(j.dueDate);
  return {
    id: j.id,
    due,
    state: jobState({ due, skipped: j.skipped, task: j.task }, today),
    stepName: j.step.name,
    seq: j.seq,
    taskId: j.taskId,
    skippedReason: j.skippedReason,
    cycle: { id: j.cycle.id, seq: j.cycle.seq, templateName: j.cycle.template.name },
    company: j.cycle.company,
    assignee: j.task?.assignedTo ?? (j.cycle.ownerUserId ? (owners.get(j.cycle.ownerUserId) ?? null) : null),
  };
}

async function ownersOf(jobs: JobRecord[]) {
  const ids = [...new Set(jobs.flatMap((j) => (j.cycle.ownerUserId ? [j.cycle.ownerUserId] : [])))];
  const people = ids.length ? await db.user.findMany({ where: { id: { in: ids } }, select: { id: true, name: true } }) : [];
  return new Map(people.map((p) => [p.id, p]));
}

export type DueWindow = "overdue" | "month" | "next30" | "all";

/** The work owed across every customer: overdue, this month's, the next 30 days', or everything still to do. Done and skipped ones are the cycle's to show. */
export async function dueWork(window: DueWindow, ownerId?: string): Promise<JobRow[]> {
  const today = (await workspaceClock()).today();
  const monthEnd = addMonths(`${today.slice(0, 7)}-01`, 1);
  const lt = window === "overdue" ? today : window === "month" ? monthEnd : window === "next30" ? addDays(today, 31) : null;
  const jobs = (await db.serviceJob.findMany({
    where: {
      skipped: false,
      OR: [{ taskId: null }, { task: { done: false } }],
      cycle: { status: "ACTIVE", ...(ownerId ? { ownerUserId: ownerId } : {}) },
      ...(lt ? { dueDate: { lt: storedDay(lt) } } : {}),
    },
    orderBy: [{ dueDate: "asc" }],
    take: 1000,
    select: JOB_SELECT,
  })) as JobRecord[];
  const owners = await ownersOf(jobs);
  return jobs.map((j) => rowOf(j, today, owners));
}

/** One cycle's whole timeline, soonest first. */
export async function cycleJobs(cycleId: string): Promise<JobRow[]> {
  const today = (await workspaceClock()).today();
  const jobs = (await db.serviceJob.findMany({ where: { cycleId }, orderBy: [{ dueDate: "asc" }, { seq: "asc" }], select: JOB_SELECT })) as JobRecord[];
  const owners = await ownersOf(jobs);
  return jobs.map((j) => rowOf(j, today, owners));
}

/** Done and still to do, for a cycle's progress. */
export function progressOf(rows: readonly JobRow[]): { done: number; total: number; overdue: number } {
  const counted = rows.filter((r) => r.state !== "SKIPPED");
  return { done: counted.filter((r) => r.state === "DONE").length, total: counted.length, overdue: counted.filter((r) => r.state === "OVERDUE").length };
}
