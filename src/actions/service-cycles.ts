"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { recordAudit } from "@/lib/audit";
import { can } from "@/lib/authz/resolve";
import { mayAccess } from "@/lib/authz/access";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { formatOrderId } from "@/lib/order-id";
import { storedDay } from "@/lib/tasks/server";
import { workspaceClock } from "@/lib/time/workspace";
import { isDay, MAX_MONTHS, templateProblem, type TemplateInput } from "@/lib/service-cycles/rules";
import { cycleJobs, defaultEnd, dueWork, openDueJobs, progressOf, syncCycle, type DueWindow, type JobRow } from "@/lib/service-cycles/server";
import type { ActionResult } from "@/actions/company";

/**
 * Service cycles (owner, 9 Nov 2026 — src/lib/service-cycles): plans of repeating steps, run for a customer, each job
 * becoming its owner's task when near. Under Tasks, which every plan has. "See service cycles" reads the due work and the
 * cycles; "Run service cycles" makes plans and starts, changes and stops cycles. Each job's task is its own person's as
 * any task is.
 */

const dayOf = (d: Date) => d.toISOString().slice(0, 10);

async function viewer() {
  const user = await requireModuleAccess("tasks");
  return (await can(user.id, "cycles.view")) || (await can(user.id, "cycles.manage")) ? user : null;
}
async function manager() {
  const user = await requireModuleAccess("tasks");
  return (await can(user.id, "cycles.manage")) ? user : null;
}
/**
 * The same, for the cards on other modules' pages — a customer's, an order's, an item's: Tasks in the plan is enough,
 * as the page asks after its own module (SHARED_ACTIONS, src/lib/module-actions.ts).
 */
async function sharedViewer() {
  const user = await requireModuleUser("tasks");
  return (await can(user.id, "cycles.view")) || (await can(user.id, "cycles.manage")) ? user : null;
}
async function sharedManager() {
  const user = await requireModuleUser("tasks");
  return (await can(user.id, "cycles.manage")) ? user : null;
}
const NO_RIGHT: ActionResult<never> = { ok: false, error: "Running service cycles needs the right to." };

function revalidate() {
  revalidatePath("/service-cycles");
  revalidatePath("/tasks");
}

// ─── Plans ────────────────────────────────────────────────────────────────

export type TemplateRow = { id: string; seq: number; name: string; months: number; active: boolean; steps: number; cycles: number };

export async function listTemplates(): Promise<{ rows: TemplateRow[]; mayManage: boolean } | null> {
  const user = await viewer();
  if (!user) return null;
  const rows = await db.serviceCycleTemplate.findMany({ orderBy: [{ active: "desc" }, { name: "asc" }], select: { id: true, seq: true, name: true, months: true, active: true, _count: { select: { steps: true, cycles: true } } } });
  return { rows: rows.map((r) => ({ id: r.id, seq: r.seq, name: r.name, months: r.months, active: r.active, steps: r._count.steps, cycles: r._count.cycles })), mayManage: await can(user.id, "cycles.manage") };
}

export type TemplateDetail = Omit<TemplateInput, "steps"> & { id: string; seq: number; active: boolean; inUse: boolean; steps: (TemplateInput["steps"][number] & { id: string; used: boolean })[] };

export async function getTemplate(seq: number): Promise<TemplateDetail | null> {
  if (!(await viewer())) return null;
  const t = await db.serviceCycleTemplate.findUnique({
    where: { seq },
    select: { id: true, seq: true, name: true, description: true, months: true, active: true, _count: { select: { cycles: true } }, steps: { orderBy: { sortOrder: "asc" }, select: { id: true, name: true, firstAfterMonths: true, everyMonths: true, showDaysBefore: true, checklist: true, _count: { select: { jobs: true } } } } },
  });
  if (!t) return null;
  return {
    id: t.id,
    seq: t.seq,
    name: t.name,
    description: t.description,
    months: t.months,
    active: t.active,
    inUse: t._count.cycles > 0,
    steps: t.steps.map((s) => ({ id: s.id, name: s.name, firstAfterMonths: s.firstAfterMonths, everyMonths: s.everyMonths, showDaysBefore: s.showDaysBefore, checklist: s.checklist, used: s._count.jobs > 0 })),
  };
}

/** Saves a plan. A step a cycle has jobs for can be changed but not removed; each running cycle is brought in step. */
export async function saveTemplate(input: TemplateInput & { id?: string }): Promise<ActionResult<{ seq: number }>> {
  const user = await manager();
  if (!user) return NO_RIGHT;
  const clean: TemplateInput = {
    name: String(input.name ?? "").trim().slice(0, 120),
    description: input.description ? String(input.description).trim().slice(0, 1000) : null,
    months: Number(input.months),
    steps: (Array.isArray(input.steps) ? input.steps : []).map((s) => ({
      id: typeof s.id === "string" && s.id ? s.id : undefined,
      name: String(s.name ?? "").trim().slice(0, 120),
      firstAfterMonths: Number(s.firstAfterMonths),
      everyMonths: s.everyMonths === null || s.everyMonths === undefined || String(s.everyMonths) === "" ? null : Number(s.everyMonths),
      showDaysBefore: Number(s.showDaysBefore),
      checklist: (Array.isArray(s.checklist) ? s.checklist : []).map((l) => String(l).trim()).filter(Boolean),
    })),
  };
  const problem = templateProblem(clean);
  if (problem) return { ok: false, error: problem };

  const existing = input.id ? await db.serviceCycleTemplate.findUnique({ where: { id: input.id }, select: { id: true, steps: { select: { id: true, _count: { select: { jobs: true } } } } } }) : null;
  if (input.id && !existing) return { ok: false, error: "That plan is gone." };
  const kept = new Set(clean.steps.flatMap((s) => (s.id ? [s.id] : [])));
  const dropped = existing?.steps.filter((s) => !kept.has(s.id)) ?? [];
  if (dropped.some((s) => s._count.jobs > 0)) return { ok: false, error: "A step that cycles already have jobs for can't be removed. Change it instead, or stop those cycles first." };
  if (clean.steps.some((s) => s.id && !existing?.steps.some((e) => e.id === s.id))) return { ok: false, error: "That plan changed while you had it open. Reload it." };

  const saved = await db.$transaction(async (tx) => {
    const t = existing
      ? await tx.serviceCycleTemplate.update({ where: { id: existing.id }, data: { name: clean.name, description: clean.description, months: clean.months }, select: { id: true, seq: true } })
      : await tx.serviceCycleTemplate.create({ data: { name: clean.name, description: clean.description, months: clean.months, createdById: user.id }, select: { id: true, seq: true } });
    if (dropped.length) await tx.serviceCycleStep.deleteMany({ where: { id: { in: dropped.map((s) => s.id) } } });
    for (const [sortOrder, s] of clean.steps.entries()) {
      const data = { name: s.name, firstAfterMonths: s.firstAfterMonths, everyMonths: s.everyMonths, showDaysBefore: s.showDaysBefore, checklist: s.checklist, sortOrder };
      if (s.id) await tx.serviceCycleStep.update({ where: { id: s.id }, data });
      else await tx.serviceCycleStep.create({ data: { ...data, templateId: t.id } });
    }
    return t;
  });
  if (existing) for (const c of await db.serviceCycle.findMany({ where: { templateId: saved.id, status: "ACTIVE" }, select: { id: true } })) await syncCycle(c.id);
  await openDueJobs();
  await recordAudit({ userId: user.id, action: existing ? "UPDATE" : "CREATE", entityType: "ServiceCycleTemplate", entityId: saved.id, entityLabel: clean.name });
  revalidate();
  return { ok: true, data: { seq: saved.seq } };
}

export async function setTemplateActive(id: string, active: boolean): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return NO_RIGHT;
  const t = await db.serviceCycleTemplate.update({ where: { id: String(id) }, data: { active: !!active }, select: { name: true } }).catch(() => null);
  if (!t) return { ok: false, error: "That plan is gone." };
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ServiceCycleTemplate", entityId: String(id), entityLabel: `${t.name} → ${active ? "in use" : "put away"}` });
  revalidate();
  return { ok: true, data: null };
}

// ─── Cycles ───────────────────────────────────────────────────────────────

export type StartInput = { templateId: string; companyId: string; orderId?: string | null; startDate: string; endDate?: string | null; ownerUserId?: string | null };

/** Starts a plan for a customer: its timeline made, and the jobs already near made tasks. */
export async function startCycle(input: StartInput): Promise<ActionResult<{ seq: number }>> {
  const user = await manager();
  if (!user) return NO_RIGHT;
  const template = await db.serviceCycleTemplate.findUnique({ where: { id: String(input.templateId ?? "") }, select: { id: true, name: true, months: true, active: true } });
  if (!template?.active) return { ok: false, error: "Choose a plan that's in use." };
  const company = await db.company.findUnique({ where: { id: String(input.companyId ?? "") }, select: { id: true, name: true } });
  // A customer out of this person's reach answers as one that isn't there (check:record-scope, 12 Nov 2026): running
  // cycles isn't a way to name a customer one can't open, nor to list its orders.
  if (!company || !(await mayAccess(user.id, "companies", "view", company.id))) return { ok: false, error: "Choose the customer." };
  const order = input.orderId ? await db.companyProduct.findUnique({ where: { id: String(input.orderId) }, select: { id: true, companyId: true } }) : null;
  if (input.orderId && order?.companyId !== company.id) return { ok: false, error: "That order isn't this customer's." };
  const start = String(input.startDate ?? "");
  if (!isDay(start)) return { ok: false, error: "Choose when it starts." };
  const end = input.endDate ? String(input.endDate) : defaultEnd(start, template.months);
  if (!isDay(end) || end < start) return { ok: false, error: "It has to end on or after the day it starts." };
  if (Date.parse(end) - Date.parse(start) > MAX_MONTHS * 31 * 86_400_000) return { ok: false, error: `A cycle runs ${MAX_MONTHS / 12} years at most.` };
  const owner = input.ownerUserId ? await db.user.findFirst({ where: { id: String(input.ownerUserId), active: true }, select: { id: true } }) : null;
  if (input.ownerUserId && !owner) return { ok: false, error: "Choose somebody still working here." };

  const cycle = await db.serviceCycle.create({
    data: { templateId: template.id, companyId: company.id, orderId: order?.id ?? null, startDate: storedDay(start), endDate: storedDay(end), ownerUserId: owner?.id ?? null, createdById: user.id },
    select: { id: true, seq: true },
  });
  await syncCycle(cycle.id);
  await openDueJobs({ cycleId: cycle.id });
  await recordAudit({ userId: user.id, action: "CREATE", entityType: "ServiceCycle", entityId: cycle.id, entityLabel: `${template.name} for ${company.name}, ${start} to ${end}` });
  revalidate();
  return { ok: true, data: { seq: cycle.seq } };
}

export type CycleRow = {
  id: string;
  seq: number;
  templateName: string;
  company: { id: string; name: string; companySeq: number };
  start: string;
  end: string;
  status: "ACTIVE" | "STOPPED" | "ENDED";
  owner: { id: string; name: string } | null;
  order: { orderSeq: number } | null;
  progress: { done: number; total: number; overdue: number };
};

async function cycleRows(where: object): Promise<CycleRow[]> {
  const today = (await workspaceClock()).today();
  const cycles = await db.serviceCycle.findMany({
    where,
    orderBy: [{ status: "asc" }, { startDate: "desc" }],
    take: 500,
    select: { id: true, seq: true, startDate: true, endDate: true, status: true, ownerUserId: true, template: { select: { name: true } }, company: { select: { id: true, name: true, companySeq: true } }, order: { select: { orderSeq: true } }, jobs: { select: { dueDate: true, skipped: true, task: { select: { done: true } } } } },
  });
  const ownerIds = [...new Set(cycles.flatMap((c) => (c.ownerUserId ? [c.ownerUserId] : [])))];
  const owners = new Map((ownerIds.length ? await db.user.findMany({ where: { id: { in: ownerIds } }, select: { id: true, name: true } }) : []).map((u) => [u.id, u]));
  return cycles.map((c) => {
    const counted = c.jobs.filter((j) => !j.skipped);
    return {
      id: c.id,
      seq: c.seq,
      templateName: c.template.name,
      company: c.company,
      start: dayOf(c.startDate),
      end: dayOf(c.endDate),
      status: c.status === "STOPPED" ? "STOPPED" : dayOf(c.endDate) < today ? "ENDED" : "ACTIVE",
      owner: c.ownerUserId ? (owners.get(c.ownerUserId) ?? null) : null,
      order: c.order,
      progress: { done: counted.filter((j) => j.task?.done).length, total: counted.length, overdue: counted.filter((j) => !j.task?.done && dayOf(j.dueDate) < today).length },
    };
  });
}

export async function listCycles(filter: { companyId?: string; orderId?: string } = {}): Promise<{ rows: CycleRow[]; mayManage: boolean; plansInUse: number } | null> {
  const user = await sharedViewer();
  if (!user) return null;
  // Asked for one customer's or one order's cycles — their page's panel — it answers for somebody who can open them.
  if (filter.companyId && !(await mayAccess(user.id, "companies", "view", String(filter.companyId)))) return null;
  if (filter.orderId && !(await mayAccess(user.id, "orders", "view", String(filter.orderId)))) return null;
  const where = { ...(filter.companyId ? { companyId: String(filter.companyId) } : {}), ...(filter.orderId ? { orderId: String(filter.orderId) } : {}) };
  const [rows, mayManage, plansInUse] = await Promise.all([cycleRows(where), can(user.id, "cycles.manage"), db.serviceCycleTemplate.count({ where: { active: true } })]);
  return { rows, mayManage, plansInUse };
}

/** The plan an item's orders start, with the plans to choose from for whoever runs cycles. */
export async function itemServicePlan(itemId: string): Promise<{ templateId: string | null; templateName: string | null; templates: { id: string; name: string }[]; mayManage: boolean } | null> {
  const user = await sharedViewer();
  if (!user) return null;
  const [plan, templates, mayManage] = await Promise.all([
    db.itemServicePlan.findUnique({ where: { itemId: String(itemId) }, select: { template: { select: { id: true, name: true } } } }),
    db.serviceCycleTemplate.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true } }),
    can(user.id, "cycles.manage"),
  ]);
  return { templateId: plan?.template.id ?? null, templateName: plan?.template.name ?? null, templates, mayManage };
}

/** Names the plan an item's approved orders start, or none. Orders already approved aren't touched. */
export async function setItemServicePlan(itemId: string, templateId: string | null): Promise<ActionResult<null>> {
  const user = await sharedManager();
  if (!user) return NO_RIGHT;
  const item = await db.item.findUnique({ where: { id: String(itemId) }, select: { id: true, name: true } });
  if (!item) return { ok: false, error: "That item is gone." };
  if (!templateId) {
    await db.itemServicePlan.deleteMany({ where: { itemId: item.id } });
  } else {
    const template = await db.serviceCycleTemplate.findUnique({ where: { id: String(templateId) }, select: { id: true, active: true } });
    if (!template?.active) return { ok: false, error: "Choose a plan that's in use." };
    await db.itemServicePlan.upsert({ where: { itemId: item.id }, create: { itemId: item.id, templateId: template.id }, update: { templateId: template.id } });
  }
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "Item", entityId: item.id, entityLabel: `${item.name}: service plan ${templateId ? "set" : "removed"}` });
  revalidatePath("/items");
  return { ok: true, data: null };
}

export async function getCycle(seq: number): Promise<{ cycle: CycleRow; ownerUserId: string | null; jobs: JobRow[]; mayManage: boolean } | null> {
  const user = await viewer();
  if (!user) return null;
  const [row] = await cycleRows({ seq });
  if (!row) return null;
  const jobs = await cycleJobs(row.id);
  return { cycle: { ...row, progress: progressOf(jobs) }, ownerUserId: row.owner?.id ?? null, jobs, mayManage: await can(user.id, "cycles.manage") };
}

/** New dates or owner: the jobs still only planned follow; tasks already made keep their own owner and day. */
export async function updateCycle(input: { id: string; startDate: string; endDate: string; ownerUserId: string | null }): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return NO_RIGHT;
  const cycle = await db.serviceCycle.findUnique({ where: { id: String(input.id) }, select: { id: true, status: true, companyId: true } });
  if (!cycle || !(await mayAccess(user.id, "companies", "view", cycle.companyId))) return { ok: false, error: "That cycle is gone." };
  if (!isDay(input.startDate) || !isDay(input.endDate) || input.endDate < input.startDate) return { ok: false, error: "It has to end on or after the day it starts." };
  const owner = input.ownerUserId ? await db.user.findFirst({ where: { id: input.ownerUserId, active: true }, select: { id: true } }) : null;
  if (input.ownerUserId && !owner) return { ok: false, error: "Choose somebody still working here." };
  await db.serviceCycle.update({ where: { id: cycle.id }, data: { startDate: storedDay(input.startDate), endDate: storedDay(input.endDate), ownerUserId: owner?.id ?? null } });
  await syncCycle(cycle.id);
  if (cycle.status === "ACTIVE") await openDueJobs({ cycleId: cycle.id });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ServiceCycle", entityId: cycle.id, entityLabel: `Dates ${input.startDate} to ${input.endDate}` });
  revalidate();
  return { ok: true, data: null };
}

/** Stopped: nothing more becomes a task. Tasks already made stay with whoever has them. Started again, it carries on. */
export async function setCycleStopped(id: string, stopped: boolean): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return NO_RIGHT;
  const found = await db.serviceCycle.findUnique({ where: { id: String(id) }, select: { id: true, companyId: true } });
  if (!found || !(await mayAccess(user.id, "companies", "view", found.companyId))) return { ok: false, error: "That cycle is gone." };
  const cycle = await db.serviceCycle.update({ where: { id: found.id }, data: { status: stopped ? "STOPPED" : "ACTIVE", stoppedAt: stopped ? new Date() : null }, select: { id: true } }).catch(() => null);
  if (!cycle) return { ok: false, error: "That cycle is gone." };
  if (!stopped) await openDueJobs({ cycleId: cycle.id });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ServiceCycle", entityId: cycle.id, entityLabel: stopped ? "Stopped" : "Started again" });
  revalidate();
  return { ok: true, data: null };
}

/** A job that won't happen, with why — or back again. One whose task is done can't be skipped. */
export async function skipJob(id: string, skip: boolean, reason?: string): Promise<ActionResult<null>> {
  const user = await manager();
  if (!user) return NO_RIGHT;
  const job = await db.serviceJob.findUnique({ where: { id: String(id) }, select: { id: true, task: { select: { done: true } }, step: { select: { name: true } } } });
  if (!job) return { ok: false, error: "That job is gone." };
  if (skip && job.task?.done) return { ok: false, error: "It's done already." };
  const why = reason?.trim().slice(0, 300) || null;
  if (skip && !why) return { ok: false, error: "Say why it's skipped." };
  await db.serviceJob.update({ where: { id: job.id }, data: { skipped: skip, skippedReason: skip ? why : null } });
  await recordAudit({ userId: user.id, action: "UPDATE", entityType: "ServiceJob", entityId: job.id, entityLabel: `${job.step.name}: ${skip ? `skipped — ${why}` : "not skipped"}` });
  revalidate();
  return { ok: true, data: null };
}

export async function listDueWork(window: DueWindow, mine: boolean): Promise<{ rows: JobRow[]; mayManage: boolean } | null> {
  const user = await viewer();
  if (!user) return null;
  return { rows: await dueWork(window, mine ? user.id : undefined), mayManage: await can(user.id, "cycles.manage") };
}

/** For the start form: the plans in use, and the customer's orders to tie a cycle to. */
export async function startOptions(companyId?: string): Promise<{ templates: { id: string; name: string; months: number }[]; orders: { id: string; label: string; start: string | null; end: string | null }[] } | null> {
  const user = await manager();
  if (!user) return null;
  if (companyId && !(await mayAccess(user.id, "companies", "view", String(companyId)))) companyId = undefined;
  const [templates, orders] = await Promise.all([
    db.serviceCycleTemplate.findMany({ where: { active: true }, orderBy: { name: "asc" }, select: { id: true, name: true, months: true } }),
    companyId ? db.companyProduct.findMany({ where: { companyId, orderStatus: { notIn: ["CANCELLED", "REJECTED"] } }, orderBy: { createdAt: "desc" }, take: 100, select: { id: true, orderSeq: true, startDate: true, endDate: true, item: { select: { name: true } } } }) : Promise.resolve([]),
  ]);
  return {
    templates,
    orders: orders.map((o) => ({ id: o.id, label: `${formatOrderId(o.orderSeq)} · ${o.item.name}`, start: o.startDate ? dayOf(o.startDate) : null, end: o.endDate ? dayOf(o.endDate) : null })),
  };
}
