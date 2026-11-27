import { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { notMigratedYet } from "@/lib/not-migrated";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import { copilotConfig } from "@/lib/copilot/settings";
import { workspaceClock } from "@/lib/time/workspace";
import { leadPath } from "@/lib/record-links";
import { makePlan, PlanRefusal } from "@/lib/research/plan-server";
import type { PlanFit, StoredPlan } from "@/lib/research/plan";
import { notifyUser } from "@/lib/notify";
import { noteFrom } from "@/lib/ai/teammates";
import { teammate } from "@/lib/ai/teammates-server";

/**
 * "Research & plan" by itself (owner, 18 Nov 2026 — phase 2: "build phase 2"). Switched on in Settings › Deskzo AI, the
 * heartbeat plans each new lead once — the public research refreshed, how warm it is, the next steps and a first email —
 * just as the button does (src/lib/research/plan-server.ts). Then the person's hot and warm leads lead their Today.
 *
 * Bounded three ways, so the workspace's credits can't run away: only leads made since it was switched on (never the
 * whole book at once), at most `perDay` a day, and a few each heartbeat. Each lead is tried once, whatever happens —
 * a lead that failed isn't tried again by itself; its button still works. It is charged to the lead's owner where they
 * may use Deskzo AI, else to whoever switched it on; with neither, the lead is passed over and says why.
 * Nothing is sent and no task is made — the person still chooses.
 */

export const PER_DAY_MAX = 200;
export const PER_DAY_DEFAULT = 25;
/** Leads planned in one heartbeat, at most — each is a model turn of several seconds. */
const PER_TICK = 4;
/** A new lead older than this when first seen is left alone — the heartbeat was down, or it came in an import. */
const FRESH_MS = 3 * 86_400_000;
/** A RUNNING run older than this was cut off (a restart) and is closed as failed. */
const STALE_RUN_MS = 30 * 60_000;
const CLOSED: ("WON" | "LOST" | "DISQUALIFIED")[] = ["WON", "LOST", "DISQUALIFIED"];

export type AutoPlanConfig = { enabled: boolean; perDay: number; onSince: Date | null; updatedById: string | null; migrated: boolean };

export async function autoPlanConfig(): Promise<AutoPlanConfig> {
  try {
    const row = await db.autoPlanSettings.findUnique({ where: { id: "global" }, select: { enabled: true, perDay: true, onSince: true, updatedById: true } });
    return { enabled: row?.enabled ?? false, perDay: row?.perDay ?? PER_DAY_DEFAULT, onSince: row?.onSince ?? null, updatedById: row?.updatedById ?? null, migrated: true };
  } catch (err) {
    if (notMigratedYet(err)) return { enabled: false, perDay: PER_DAY_DEFAULT, onSince: null, updatedById: null, migrated: false };
    throw err;
  }
}

/** Switched on (from off), it counts from now; switched off, it stops at once. */
export async function saveAutoPlanConfig(input: { enabled: boolean; perDay: number }, userId: string): Promise<AutoPlanConfig> {
  const before = await autoPlanConfig();
  const turningOn = input.enabled && !before.enabled;
  await db.autoPlanSettings.upsert({
    where: { id: "global" },
    create: { id: "global", enabled: input.enabled, perDay: input.perDay, onSince: input.enabled ? new Date() : null, updatedById: userId },
    update: { enabled: input.enabled, perDay: input.perDay, ...(turningOn ? { onSince: new Date() } : {}), updatedById: userId },
    select: { id: true },
  });
  return autoPlanConfig();
}

/** Leads planned by itself since the workspace's midnight — every try counts, as each may have spent credits. */
export async function plannedToday(now = new Date()): Promise<number> {
  const clock = await workspaceClock();
  const midnight = clock.startOfDay(clock.today(now)) ?? new Date(now.getTime() - 86_400_000);
  return db.autoPlanRun.count({ where: { at: { gte: midnight }, status: { in: ["DONE", "FAILED", "RUNNING"] } } }).catch(() => 0);
}

/** Who a lead's plan is charged to: its owner if they may use Deskzo AI, else whoever switched it on, else nobody. */
async function chargeTo(ownerId: string | null, switchedOnBy: string | null): Promise<string | null> {
  for (const id of [ownerId, switchedOnBy]) {
    if (!id) continue;
    const user = await db.user.findUnique({ where: { id }, select: { active: true, kind: true } });
    if (user?.active && user.kind === "MEMBER" && (await can(id, "copilot.use"))) return id;
  }
  return null;
}

export type AutoPlanRun = { planned: number; failed: number; skipped: number; reason?: string };

/** The heartbeat's turn: a few new leads planned, inside the day's limit. */
export async function runAutoPlans(now = new Date()): Promise<AutoPlanRun> {
  const config = await autoPlanConfig();
  if (!config.enabled || !config.onSince) return { planned: 0, failed: 0, skipped: 0, reason: "off" };
  if (!(await moduleAvailableForTenant("leads"))) return { planned: 0, failed: 0, skipped: 0, reason: "leads are off" };
  if (!(await copilotConfig()).enabled) return { planned: 0, failed: 0, skipped: 0, reason: "Deskzo AI is off" };

  // A run a restart cut off is closed, so it isn't counted as going on for ever.
  await db.autoPlanRun.updateMany({ where: { status: "RUNNING", at: { lt: new Date(now.getTime() - STALE_RUN_MS) } }, data: { status: "FAILED", error: "Stopped part way — the server restarted." } });

  const left = config.perDay - (await plannedToday(now));
  if (left <= 0) return { planned: 0, failed: 0, skipped: 0, reason: "today's limit" };
  const since = new Date(Math.max(config.onSince.getTime(), now.getTime() - FRESH_MS));
  const leads = await db.lead.findMany({
    where: { createdAt: { gte: since }, status: { notIn: CLOSED }, autoPlanRun: { is: null }, researchPlans: { none: {} } },
    orderBy: { createdAt: "asc" },
    take: Math.min(PER_TICK, left),
    select: { id: true, ownerUserId: true },
  });

  const out: AutoPlanRun = { planned: 0, failed: 0, skipped: 0 };
  for (const lead of leads) {
    // Claimed first: two heartbeats at once plan a lead once.
    try {
      await db.autoPlanRun.create({ data: { leadId: lead.id, status: "RUNNING", at: now } });
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
      throw err;
    }
    const userId = await chargeTo(lead.ownerUserId, config.updatedById);
    if (!userId) {
      await db.autoPlanRun.update({ where: { leadId: lead.id }, data: { status: "SKIPPED", error: "Neither its owner nor whoever switched this on may use Deskzo AI." } });
      out.skipped += 1;
      continue;
    }
    try {
      const { plan } = await makePlan({ kind: "lead", id: lead.id }, userId);
      await db.autoPlanRun.update({ where: { leadId: lead.id }, data: { status: "DONE", chargedToId: userId } });
      out.planned += 1;
      // A hot one is worth saying, in Ved's own voice — to its owner only; warm and cold wait on Today.
      if (plan.fit === "HOT" && lead.ownerUserId) {
        const about = await db.lead.findUnique({ where: { id: lead.id }, select: { leadSeq: true, title: true, company: { select: { name: true } } } });
        if (about) {
          await notifyUser({
            userId: lead.ownerUserId,
            type: "LEAD_ACTIVITY",
            title: noteFrom((await teammate("ved")).name, `${about.company.name} looks hot — I've planned the next steps.`),
            message: about.title,
            link: leadPath(about.leadSeq),
          }).catch((err) => console.error("[auto-plan] the hot lead's notice failed", err instanceof Error ? err.message : err));
        }
      }
    } catch (err) {
      const why = err instanceof Error ? err.message : String(err);
      await db.autoPlanRun.update({ where: { leadId: lead.id }, data: { status: "FAILED", error: why.slice(0, 500), chargedToId: userId } });
      out.failed += 1;
      // Out of credits, AI paused, a cap reached: no point trying the next one now.
      if (err instanceof PlanRefusal) break;
      console.error("[auto-plan] a lead failed", why);
    }
  }
  return out;
}

export type HotLead = { id: string; href: string; title: string; company: string; fit: PlanFit; nextStep: string | null; at: string };

/**
 * The person's open leads Deskzo AI read as hot or warm, hot first and the newest plan first in each — their Today's
 * "Leads to work first". Only their own leads: what they are to act on.
 */
export async function hotLeadsFor(userId: string, take = 5): Promise<HotLead[]> {
  let rows;
  try {
    rows = await db.researchPlan.findMany({
      where: {
        lead: { ownerUserId: userId, status: { notIn: CLOSED } },
        OR: [{ plan: { path: ["fit"], equals: "HOT" } }, { plan: { path: ["fit"], equals: "WARM" } }],
      },
      orderBy: { createdAt: "desc" },
      take: 40,
      select: { createdAt: true, plan: true, lead: { select: { id: true, leadSeq: true, title: true, company: { select: { name: true } } } } },
    });
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
  const hot = rows.flatMap((r) => {
    if (!r.lead) return [];
    const plan = r.plan as unknown as StoredPlan;
    const open = plan.steps.findIndex((_, i) => !plan.tasks?.[String(i)]);
    return [{ id: r.lead.id, href: leadPath(r.lead.leadSeq), title: r.lead.title, company: r.lead.company.name, fit: plan.fit, nextStep: open >= 0 ? plan.steps[open]!.title : null, at: r.createdAt.toISOString() }];
  });
  return hot.sort((a, b) => (a.fit === b.fit ? b.at.localeCompare(a.at) : a.fit === "HOT" ? -1 : 1)).slice(0, take);
}
