import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { aiTurn, AiRefusal } from "@/lib/ai/gateway";
import type { Turn } from "@/lib/copilot/types";
import { STILL_THERE } from "@/lib/contacts/left";
import { workspaceClock } from "@/lib/time/workspace";
import { refreshResearch, researchOf } from "@/lib/research/gather";
import { briefPrompt } from "@/lib/research/brief";
import { briefInputFor } from "@/lib/research/view";
import { FIT_LABELS, PROPOSE_PLAN, planSystemFor, planFromCall, planPrompt, type PlanBody, type PlanInput, type StoredPlan } from "@/lib/research/plan";
import { teammateWork } from "@/lib/ai/teammate-work";
import { companyPath, leadPath } from "@/lib/record-links";
import { planSteps } from "@/lib/ai/teammate-steps";
import { workspacePack } from "@/lib/country-pack";

/**
 * "Research & plan" on the server (owner, 18 Nov 2026 — src/lib/research/plan.ts): the facts gathered as the person may
 * see them, the research refreshed first when it's old (free), one Deskzo AI turn as "Research: qualify and plan" on the
 * workspace's credits, and the plan kept — the latest one a lead or company has, written over each time.
 */

export type PlanTarget = { kind: "lead"; id: string } | { kind: "company"; id: string };

const DAY = 86_400_000;
/** Research older than this is refreshed before planning — free, and the plan is only as good as it. */
const RESEARCH_STALE_MS = 7 * DAY;
const CLOSED: ("WON" | "LOST" | "DISQUALIFIED")[] = ["WON", "LOST", "DISQUALIFIED"];

const words = (v: string) => v.charAt(0) + v.slice(1).toLowerCase().replace(/_/g, " ");
/** The built-in designations as people write them. */
const DESIGNATION_TITLES: Record<string, string> = {
  IT_MANAGER: "IT Manager",
  PURCHASE_MANAGER: "Purchase Manager",
  IT_HEAD: "IT Head",
  DIRECTOR: "Director",
  CEO: "CEO",
  CIO: "CIO",
  HR: "HR",
};
const daysBetween = (from: Date, to: Date) => Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY));
export const planKey = (t: PlanTarget) => `${t.kind}:${t.id}`;

/** Thrown with words for the person: why there's no plan. */
export class PlanRefusal extends Error {}

/** Contacts' job titles, primary first — the workspace's own designation where set, else the built-in one. Never who. */
async function contactTitles(companyId: string): Promise<string[]> {
  const people = await db.contact.findMany({
    where: { companyId, ...STILL_THERE },
    orderBy: [{ isPrimary: "desc" }, { createdAt: "asc" }],
    take: 12,
    select: { designation: true, designationRef: { select: { name: true } } },
  });
  const titles = people.map((p) => p.designationRef?.name?.trim() || DESIGNATION_TITLES[p.designation] || null).filter((t): t is string => !!t);
  return [...new Set(titles)].slice(0, 6);
}

/** Everything the plan is made from, as this person may see it. Null when the record isn't there. */
export async function gatherPlanInput(target: PlanTarget, userId: string): Promise<{ input: PlanInput; companyId: string; leadId: string | null } | null> {
  const clock = await workspaceClock();
  const now = new Date();
  const today = clock.today(now);
  const lead =
    target.kind === "lead"
      ? await db.lead.findUnique({
          where: { id: target.id },
          select: {
            id: true,
            companyId: true,
            title: true,
            status: true,
            source: true,
            createdAt: true,
            stageChangedAt: true,
            expectedCloseDate: true,
            score: true,
            stage: { select: { label: true } },
            requirements: { take: 10, select: { item: { select: { name: true } } } },
          },
        })
      : null;
  if (target.kind === "lead" && !lead) return null;
  const companyId = lead?.companyId ?? target.id;
  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, relationshipType: true, stage: true, locations: { orderBy: { isPrimary: "desc" }, take: 1, select: { city: true } } },
  });
  if (!company) return null;

  // The public research, only as the person may see it (null where the company's website is masked from them).
  const brief = await briefInputFor(company.id, userId);
  const publicFacts = brief ? briefPrompt(brief).split("\n").filter((l) => l.startsWith("[")) : [];
  const briefText = brief ? ((await researchOf(company.id))?.brief ?? null) : null;

  const [titles, openLeads, renewingSoon] = await Promise.all([
    contactTitles(company.id),
    db.lead.count({ where: { companyId: company.id, status: { notIn: CLOSED }, ...(lead ? { id: { not: lead.id } } : {}) } }),
    db.companyProduct
      .count({ where: { companyId: company.id, parentId: null, orderStatus: { notIn: ["CANCELLED", "REJECTED"] }, endDate: { gte: now, lte: new Date(now.getTime() + 90 * DAY) } } })
      .catch(() => null),
  ]);

  let leadFacts: PlanInput["lead"] = null;
  if (lead) {
    const since = new Date(now.getTime() - 30 * DAY);
    const [byType, last, proposals, documents] = await Promise.all([
      db.activity.groupBy({ by: ["type"], where: { leadId: lead.id, occurredAt: { gte: since } }, _count: { _all: true } }),
      db.activity.findFirst({ where: { leadId: lead.id, type: { in: ["CALL", "EMAIL", "MEETING", "NOTE"] } }, orderBy: { occurredAt: "desc" }, select: { occurredAt: true } }),
      db.proposal.count({ where: { leadId: lead.id, status: { in: ["SENT", "ACCEPTED"] } } }).catch(() => 0),
      db.tradeDocument.count({ where: { leadId: lead.id, status: { not: "DRAFT" } } }).catch(() => 0),
    ]);
    const count = (t: string) => byType.find((b) => b.type === t)?._count._all ?? 0;
    leadFacts = {
      title: lead.title,
      stage: lead.stage?.label ?? words(lead.status),
      status: words(lead.status),
      source: words(lead.source),
      openForDays: daysBetween(lead.createdAt, now),
      inStageDays: lead.stageChangedAt ? daysBetween(lead.stageChangedAt, now) : null,
      lastTouchDaysAgo: last ? daysBetween(last.occurredAt, now) : null,
      touchesLast30: { calls: count("CALL"), emails: count("EMAIL"), meetings: count("MEETING"), notes: count("NOTE") },
      products: [...new Set(lead.requirements.map((r) => r.item.name))],
      proposalSent: proposals + documents > 0,
      expectedCloseInDays: lead.expectedCloseDate ? Math.round((lead.expectedCloseDate.getTime() - now.getTime()) / DAY) : null,
      score: lead.score ?? null,
    };
  }

  return {
    companyId: company.id,
    leadId: lead?.id ?? null,
    input: {
      kind: target.kind,
      today,
      company: {
        name: company.name,
        relationship: words(company.relationshipType).toLowerCase(),
        stage: words(company.stage).toLowerCase(),
        city: company.locations[0]?.city ?? null,
        publicFacts,
        brief: briefText,
        renewingSoon: renewingSoon || null,
        openLeads,
      },
      lead: leadFacts,
      contactTitles: titles,
    },
  };
}

/** Research gathered first when there's none, or it's more than a week old — free, from public sources. */
async function freshResearch(companyId: string, userId: string): Promise<void> {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { id: true, name: true, website: true } });
  if (!company?.website) return;
  const row = await researchOf(companyId);
  if (row?.refreshedAt && Date.now() - row.refreshedAt.getTime() < RESEARCH_STALE_MS) return;
  await refreshResearch(company, userId).catch((err) => console.error("[research-plan] refresh failed", err instanceof Error ? err.message : err));
}

/** Asks Deskzo AI for the plan, once more if it doesn't come back as one. Throws PlanRefusal with words for the person. */
export async function askForPlan(input: PlanInput, userId: string): Promise<{ plan: PlanBody; model: string; credits: number }> {
  const history: Turn[] = [{ role: "user", text: planPrompt(input) }];
  let credits = 0;
  for (let attempt = 0; attempt < 2; attempt++) {
    let outcome;
    try {
      outcome = await aiTurn({ userId, feature: "research.plan", system: planSystemFor(workspacePack().india), history, tools: [PROPOSE_PLAN] });
    } catch (err) {
      if (err instanceof AiRefusal) throw new PlanRefusal(err.message);
      throw err;
    }
    credits += outcome.charge.credits;
    if (outcome.stop === "refused") throw new PlanRefusal("Deskzo AI declined to plan this one.");
    const call = outcome.toolCalls.find((c) => c.name === PROPOSE_PLAN.name);
    const read = call ? planFromCall(call.input) : null;
    if (read?.ok) return { plan: read.plan, model: outcome.modelKey, credits };
    history.push({ role: "assistant", text: outcome.text, toolCalls: outcome.toolCalls, ...(outcome.native ? { native: { provider: outcome.family, model: outcome.model, content: outcome.native, masked: outcome.masked } } : {}) });
    if (outcome.toolCalls.length) {
      const fix = read && !read.ok ? `The plan has these problems. Call propose_plan again with all of it:\n- ${read.problems.join("\n- ")}` : "Only propose_plan is available.";
      history.push({ role: "tool", results: outcome.toolCalls.map((c) => ({ id: c.id, name: c.name, output: fix, isError: true })) });
    } else {
      history.push({ role: "user", text: "Call propose_plan now with the whole plan." });
    }
  }
  throw new PlanRefusal("Deskzo AI didn't come back with a plan. Try again in a minute.");
}

/** Gathers, asks and keeps the plan — recorded as Ved's work as it goes, for whoever it is for. */
export async function makePlan(target: PlanTarget, userId: string): Promise<{ plan: StoredPlan; at: Date }> {
  return teammateWork(
    { teammate: "ved", userId, kind: "research.plan", subject: `${target.kind}:${target.id}`, label: target.kind === "lead" ? "a lead" : "a company", steps: planSteps(workspacePack().india) },
    async (work) => {
      const first = await gatherPlanInput(target, userId);
      if (!first) throw new PlanRefusal(target.kind === "lead" ? "That lead isn't there any more." : "That company isn't there any more.");
      // Named once it's read: the company, and where its record is.
      const [company, lead] = await Promise.all([
        db.company.findUnique({ where: { id: first.companyId }, select: { name: true, companySeq: true } }),
        first.leadId ? db.lead.findUnique({ where: { id: first.leadId }, select: { leadSeq: true } }) : null,
      ]);
      if (company) await work.about(company.name, lead ? leadPath(lead.leadSeq) : companyPath(company.companySeq));
      await work.step(1);
      await freshResearch(first.companyId, userId);
      const gathered = (await gatherPlanInput(target, userId)) ?? first;
      await work.step(2);
      const { plan, model, credits } = await askForPlan(gathered.input, userId);
      await work.step(3);
      const stored: StoredPlan = { ...plan, tasks: {}, model, credits };
      const at = new Date();
      await db.researchPlan.upsert({
        where: { key: planKey(target) },
        create: { key: planKey(target), companyId: gathered.companyId, leadId: gathered.leadId, plan: stored as unknown as Prisma.InputJsonValue, createdById: userId },
        update: { companyId: gathered.companyId, leadId: gathered.leadId, plan: stored as unknown as Prisma.InputJsonValue, createdById: userId, createdAt: at },
        select: { id: true },
      });
      return { plan: stored, at };
    },
    ({ plan }) => `${FIT_LABELS[plan.fit]} — ${plan.steps.length} next step${plan.steps.length === 1 ? "" : "s"}${plan.email ? " and a first email" : ""}`,
  );
}

export type PlanView = { id: string; plan: StoredPlan; at: string; by: string | null };

/** The latest plan on a lead or company, if any. */
export async function latestPlan(target: PlanTarget): Promise<PlanView | null> {
  const row = await db.researchPlan
    .findUnique({ where: { key: planKey(target) }, select: { id: true, plan: true, createdAt: true, createdBy: { select: { name: true } } } })
    .catch(() => null);
  if (!row) return null;
  const stored = row.plan as unknown as StoredPlan;
  return { id: row.id, plan: { ...stored, tasks: stored.tasks ?? {} }, at: row.createdAt.toISOString(), by: row.createdBy?.name ?? null };
}

/** Records the tasks made from a plan's steps, so a step is added once. */
export async function recordPlanTasks(planId: string, made: Record<string, string>): Promise<StoredPlan | null> {
  const row = await db.researchPlan.findUnique({ where: { id: planId }, select: { plan: true } });
  if (!row) return null;
  const stored = row.plan as unknown as StoredPlan;
  const next: StoredPlan = { ...stored, tasks: { ...(stored.tasks ?? {}), ...made } };
  await db.researchPlan.update({ where: { id: planId }, data: { plan: next as unknown as Prisma.InputJsonValue }, select: { id: true } });
  return next;
}
