"use server";

import { db } from "@/lib/db";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { mayAccess } from "@/lib/authz/access";
import { canSeeCompany } from "@/lib/authz/company-scope";
import { recordAudit } from "@/lib/audit";
import { copilotConfig } from "@/lib/copilot/settings";
import { workspaceClock } from "@/lib/time/workspace";
import { createTask } from "@/actions/task";
import { addDays, STEP_LABELS } from "@/lib/research/plan";
import { latestPlan, makePlan, PlanRefusal, recordPlanTasks, type PlanTarget, type PlanView } from "@/lib/research/plan-server";
import { autoPlanConfig, plannedToday, saveAutoPlanConfig, PER_DAY_MAX } from "@/lib/research/auto-plan";
import type { ActionResult } from "@/actions/company";

/**
 * "Research & plan" (owner, 18 Nov 2026 — src/lib/research/plan.ts): Deskzo AI says how warm a lead or company is and
 * proposes the next steps and a first email; the person adds the steps they want as tasks. Making a plan takes "Use
 * Deskzo AI" and spends the workspace's credits; it, and adding its steps, needs the lead or company to be theirs to see.
 * Nothing is sent, and nothing is changed but the tasks the person asks for.
 */

const NO_AI = "Research & plan takes the “Use Deskzo AI” permission.";
const AI_OFF = "Deskzo AI is switched off. An admin can switch it on in Settings → Deskzo AI.";

/** Whether this person may see the lead or company the plan is about. */
async function reaches(userId: string, target: PlanTarget): Promise<boolean> {
  if (target.kind === "lead") return mayAccess(userId, "leads", "view", target.id);
  const company = await db.company.findUnique({ where: { id: target.id }, select: { id: true, ownerUserId: true, relationshipType: true } });
  return canSeeCompany(userId, company);
}

function targetOf(input: unknown): PlanTarget | null {
  const t = input as { kind?: unknown; id?: unknown } | null;
  if (!t || typeof t.id !== "string" || !t.id) return null;
  return t.kind === "lead" ? { kind: "lead", id: t.id } : t.kind === "company" ? { kind: "company", id: t.id } : null;
}

export async function makeResearchPlan(input: { kind: "lead" | "company"; id: string }): Promise<ActionResult<PlanView>> {
  const user = await requireUser();
  const target = targetOf(input);
  if (!target) return { ok: false, error: "Nothing to plan." };
  if (!(await can(user.id, "copilot.use"))) return { ok: false, error: NO_AI };
  if (!(await copilotConfig()).enabled) return { ok: false, error: AI_OFF };
  if (!(await reaches(user.id, target))) return { ok: false, error: target.kind === "lead" ? "Lead not found." : "Company not found." };
  try {
    await makePlan(target, user.id);
  } catch (err) {
    if (err instanceof PlanRefusal) return { ok: false, error: err.message };
    throw err;
  }
  const view = await latestPlan(target);
  if (!view) return { ok: false, error: "The plan couldn't be kept. Try again." };
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: target.kind === "lead" ? "Lead" : "Company",
    entityId: target.id,
    entityLabel: `Deskzo AI's research & plan: ${view.plan.fit.toLowerCase()}, ${view.plan.steps.length} next step${view.plan.steps.length === 1 ? "" : "s"} suggested`,
  });
  return { ok: true, data: view };
}

/** The ticked steps of a plan as tasks for the person — each step once, due as the plan said, linked to the lead or company. */
export async function addResearchPlanTasks(input: { planId: string; steps: number[] }): Promise<ActionResult<{ added: number; plan: PlanView }>> {
  const user = await requireUser();
  const row = await db.researchPlan.findUnique({ where: { id: String(input?.planId ?? "") }, select: { id: true, key: true, companyId: true, leadId: true } });
  if (!row) return { ok: false, error: "That plan isn't there any more — make a new one." };
  const target: PlanTarget = row.leadId ? { kind: "lead", id: row.leadId } : { kind: "company", id: row.companyId };
  if (!(await reaches(user.id, target))) return { ok: false, error: "That plan isn't yours to use." };
  const view = await latestPlan(target);
  if (!view || view.id !== row.id) return { ok: false, error: "That plan isn't there any more — make a new one." };
  const wanted = [...new Set((Array.isArray(input?.steps) ? input.steps : []).filter((n) => Number.isInteger(n) && n >= 0 && n < view.plan.steps.length))];
  const fresh = wanted.filter((n) => !view.plan.tasks[String(n)]);
  if (fresh.length === 0) return { ok: false, error: wanted.length ? "Those steps are tasks already." : "Tick the steps to add." };

  const today = (await workspaceClock()).today();
  const made: Record<string, string> = {};
  for (const n of fresh) {
    const step = view.plan.steps[n]!;
    const kind = STEP_LABELS[step.kind];
    const title = step.title.toLowerCase().startsWith(kind.toLowerCase()) ? step.title : `${kind}: ${step.title}`;
    const result = await createTask({
      title: title.slice(0, 500),
      description: `${step.why}\n\nSuggested by Deskzo AI's research & plan.`,
      dueDate: addDays(today, step.dueInDays),
      assignedToUserId: user.id,
      ...(row.leadId ? { leadId: row.leadId } : { companyId: row.companyId }),
      priority: view.plan.fit === "HOT" ? "HIGH" : "MEDIUM",
    });
    if (!result.ok) {
      if (Object.keys(made).length) await recordPlanTasks(row.id, made);
      return { ok: false, error: result.error };
    }
    made[String(n)] = result.data.id;
  }
  const plan = await recordPlanTasks(row.id, made);
  return { ok: true, data: { added: fresh.length, plan: { ...view, plan: plan ?? view.plan } } };
}

// ─── By itself (phase 2) ───────────────────────────────────────────────────────────────────────────────────────────

export type AutoPlanSettingsView = { enabled: boolean; perDay: number; onSince: string | null; plannedToday: number; migrated: boolean; aiOn: boolean };

/** Settings › Deskzo AI's "Research & plan new leads by itself" — for whoever changes the workspace's settings. */
export async function getAutoPlanSettings(): Promise<AutoPlanSettingsView | null> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return null;
  const [config, today, ai] = await Promise.all([autoPlanConfig(), plannedToday(), copilotConfig()]);
  return { enabled: config.enabled, perDay: config.perDay, onSince: config.onSince?.toISOString() ?? null, plannedToday: today, migrated: config.migrated, aiOn: ai.enabled };
}

export async function saveAutoPlanSettings(input: { enabled: boolean; perDay: number }): Promise<ActionResult<AutoPlanSettingsView>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "Only somebody who can change the workspace's settings can change this." };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const perDay = Number(input?.perDay);
  if (!Number.isInteger(perDay) || perDay < 1 || perDay > PER_DAY_MAX) return { ok: false, error: `Leads a day: a whole number from 1 to ${PER_DAY_MAX}.` };
  const enabled = input?.enabled === true;
  if (enabled && !(await copilotConfig()).enabled) return { ok: false, error: "Switch Deskzo AI on first, above." };
  const before = await autoPlanConfig();
  if (!before.migrated) return { ok: false, error: "This workspace is still being updated. Try again in a few minutes." };
  const after = await saveAutoPlanConfig({ enabled, perDay }, user.id);
  const said = enabled ? `New leads are researched and planned by Deskzo AI by itself, at most ${perDay} a day` : "New leads are no longer planned by Deskzo AI by itself";
  if (enabled !== before.enabled || perDay !== before.perDay) {
    await recordAudit({ userId: user.id, action: "UPDATE", entityType: "AutoPlanSettings", entityId: "global", entityLabel: said });
  }
  return { ok: true, data: { enabled: after.enabled, perDay: after.perDay, onSince: after.onSince?.toISOString() ?? null, plannedToday: await plannedToday(), migrated: true, aiOn: true } };
}
