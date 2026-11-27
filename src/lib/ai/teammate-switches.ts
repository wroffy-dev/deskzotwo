import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { MILLI, type AiFeature } from "@/lib/ai/catalogue";
import { creditStanding, monthOf, usageBreakdown } from "@/lib/ai/credits";
import { aiPaused } from "@/lib/ai/settings";
import { TEAMMATE_KEYS, isTeammateKey, type TeammateKey } from "@/lib/ai/teammates";
import { workspaceTeammates } from "@/lib/ai/teammates-server";
import { copilotConfig } from "@/lib/copilot/settings";
import { hrDeskConfig } from "@/lib/hr-desk/server";
import { getModuleDefinition } from "@/lib/modules";
import { isModuleEntitled, switchedOn } from "@/lib/modules-access";
import { currentTenant } from "@/lib/tenancy/resolve";
import { can } from "@/lib/authz/resolve";

/**
 * Each AI teammate switched on or off in this workspace, and whether each can work here now (owner, 23 Nov 2026 —
 * Settings › AI teammates: "shows whether each teammate is working here, with a switch per teammate"). Off is a hard
 * stop: the gateway (src/lib/ai/gateway.ts `aiUnavailable`) refuses every feature the teammate does. No row: on.
 * Their own settings — what Tara drafts on her own, Arjun's morning chase list — stay in Settings › Deskzo AI.
 */

/** Whose work each AI feature is. Null: nobody's — the email designer is a tool, not a teammate. */
export const FEATURE_TEAMMATE: Record<AiFeature, TeammateKey | null> = {
  "copilot.chat": "deskzo",
  "copilot.escalate": "deskzo",
  "research.brief": "ved",
  "research.plan": "ved",
  "nurture.email": "tara",
  "nurture.reply": "tara",
  "reengage.email": "tara",
  "inbox.answer": "kabir",
  "tickets.draft": "kabir",
  "automate.draft": "mira",
  "collections.email": "arjun",
  "collections.reply": "arjun",
  "bills.read": "arjun",
  "receipts.read": "arjun",
  "bank.match": "arjun",
  "hr.answer": "priya",
  "marketing.design": null,
};

/** The part of Deskzo each one works in: outside the plan, or switched off, they can't work. Deskzo AI is everywhere. */
export const TEAMMATE_MODULE: Partial<Record<TeammateKey, string>> = {
  ved: "leads",
  tara: "leads",
  kabir: "inbox",
  mira: "automate",
  arjun: "receivables",
  priya: "hr",
};

/** Teammates an admin switched off here. */
export async function teammatesOff(): Promise<Set<TeammateKey>> {
  try {
    const rows = await db.aiTeammateSwitch.findMany({ where: { on: false }, select: { key: true } });
    return new Set(rows.map((r) => r.key).filter(isTeammateKey));
  } catch (err) {
    if (notMigratedYet(err)) return new Set();
    throw err;
  }
}

export async function setTeammateOn(key: TeammateKey, on: boolean, userId: string): Promise<void> {
  await db.aiTeammateSwitch.upsert({ where: { key }, create: { key, on, updatedById: userId }, update: { on, updatedById: userId } });
}

/** The gateway's words when `feature` is the work of a teammate switched off here; null when it may run. */
export async function teammateSwitchedOff(feature: AiFeature): Promise<string | null> {
  const key = FEATURE_TEAMMATE[feature];
  if (!key || !(await teammatesOff()).has(key)) return null;
  const name = (await workspaceTeammates())[key].name;
  return `${name} is switched off in this workspace. An admin can switch ${key === "deskzo" ? "it" : "them"} on in Settings › AI teammates.`;
}

export type TeammateState = "working" | "blocked" | "off";

export type TeammateStatus = {
  key: TeammateKey;
  /** Switched on here — the switch's own position, whatever else stops them. */
  on: boolean;
  state: TeammateState;
  /** Why they can't work, in words — set when `state` is "blocked". */
  reason: string | null;
  /** Where that is put right. */
  fix: { label: string; href: string } | null;
  /** This month: jobs finished, and the credits their AI calls cost. */
  done: number;
  credits: number;
};

export type TeamStatus = {
  paused: boolean;
  aiOn: boolean;
  /** Credits left, whole; null: no limit. */
  creditsLeft: number | null;
  creditsUsed: number;
  teammates: TeammateStatus[];
};

const DESKZO_AI = { label: "Settings › Deskzo AI", href: "/settings/copilot" };

/** Everybody's position, for the settings page: what stops each one, then what each did this month. */
export async function teamStatus(now = new Date()): Promise<TeamStatus> {
  const tenant = await currentTenant();
  const month = monthOf(tenant, now);
  const [paused, ai, standing, off, hrDesk, usage, done] = await Promise.all([
    aiPaused(),
    copilotConfig(),
    creditStanding(tenant, now),
    teammatesOff(),
    hrDeskConfig(),
    usageBreakdown(tenant.id, month.from, now).catch(() => []),
    db.aiTeammateWork.groupBy({ by: ["teammate"], where: { status: "DONE", startedAt: { gte: month.from } }, _count: { _all: true } }).catch((err) => {
      if (notMigratedYet(err)) return [];
      throw err;
    }),
  ]);
  const outOfCredits = standing.metered && standing.available !== null && standing.available <= 0;

  const credits = new Map<TeammateKey, number>();
  for (const row of usage) {
    const key = FEATURE_TEAMMATE[row.feature as AiFeature];
    if (key) credits.set(key, (credits.get(key) ?? 0) + row.credits);
  }
  const finished = new Map<TeammateKey, number>();
  for (const row of done) if (isTeammateKey(row.teammate)) finished.set(row.teammate, row._count._all);

  const teammates: TeammateStatus[] = [];
  for (const key of TEAMMATE_KEYS) {
    const on = !off.has(key);
    let reason: string | null = null;
    let fix: TeammateStatus["fix"] = null;
    const moduleKey = TEAMMATE_MODULE[key];
    const moduleLabel = moduleKey ? (getModuleDefinition(moduleKey)?.label ?? moduleKey) : "";
    if (paused) reason = "Deskzo AI is paused for a short while";
    else if (!ai.enabled) [reason, fix] = ["Deskzo AI is switched off for this workspace", DESKZO_AI];
    else if (outOfCredits) [reason, fix] = ["No Deskzo AI credits left this month", { label: "Plan & billing", href: "/settings/billing" }];
    else if (moduleKey && !(await isModuleEntitled(moduleKey))) [reason, fix] = [`${moduleLabel} isn't in your plan`, { label: "Plan & billing", href: "/settings/billing" }];
    else if (moduleKey && !(await switchedOn(moduleKey))) [reason, fix] = [`${moduleLabel} is switched off`, { label: "Modules", href: "/settings/modules" }];
    else if (key === "mira" && !ai.draftingEnabled) [reason, fix] = ["Drafting workflows with AI is switched off", DESKZO_AI];
    else if (key === "priya" && !hrDesk.enabled) [reason, fix] = ["The HR desk isn't switched on", { label: "People › HR desk", href: "/people/hr-desk" }];
    teammates.push({
      key,
      on,
      state: !on ? "off" : reason ? "blocked" : "working",
      reason: on ? reason : null,
      fix: on ? fix : null,
      done: finished.get(key) ?? 0,
      credits: Math.round((credits.get(key) ?? 0) / MILLI),
    });
  }
  return {
    paused,
    aiOn: ai.enabled,
    creditsLeft: standing.available === null ? null : Math.floor(standing.available / MILLI),
    creditsUsed: Math.floor((standing.allowanceUsed + standing.packsUsed + standing.overdraft) / MILLI),
    teammates,
  };
}

/** Whether this person may switch teammates on and off: whoever may change the workspace's settings. */
export async function mayManageTeammates(userId: string): Promise<boolean> {
  return can(userId, "settings.manage");
}
