"use server";

import { db } from "@/lib/db";
import { requireUser, refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { copilotConfig } from "@/lib/copilot/settings";
import { baseCurrency, formatMoney } from "@/lib/currency";
import { mayLogFollowUps } from "@/lib/collections/load";
import { ARJUN_PER_DAY_MAX, arjunConfig, arjunReport, saveArjunConfig, type ArjunReport } from "@/lib/collections/arjun-auto";
import type { ActionResult } from "@/actions/company";

/**
 * Settings › Deskzo AI: Arjun working by himself (owner, 19 Nov 2026 — phase 3, src/lib/collections/arjun-auto.ts).
 * Reading and changing it takes `settings.manage`; switching it on takes Deskzo AI being on. Never while viewing as
 * somebody.
 */

export type ArjunSettingsView = {
  enabled: boolean;
  perDay: number;
  minDaysLate: number;
  minAmount: number;
  brokenAlways: boolean;
  weeklyTo: string[];
  /** Who may be chosen for the Monday note: active members who follow payments up. */
  people: { id: string; name: string; hint: string | null }[];
  currency: string;
  aiOn: boolean;
  migrated: boolean;
  report: ArjunReport;
};

export async function getArjunSettings(): Promise<ArjunSettingsView | null> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return null;
  const [config, ai, report, members] = await Promise.all([
    arjunConfig(),
    copilotConfig(),
    arjunReport(),
    db.user.findMany({ where: { active: true, kind: "MEMBER" }, orderBy: { name: "asc" }, take: 500, select: { id: true, name: true, email: true } }),
  ]);
  const people: ArjunSettingsView["people"] = [];
  for (const m of members) if (await mayLogFollowUps(m.id)) people.push({ id: m.id, name: m.name, hint: m.email });
  return { ...config, people, currency: baseCurrency(), aiOn: ai.enabled, report };
}

export async function saveArjunSettings(input: {
  enabled: boolean;
  perDay: number;
  minDaysLate: number;
  minAmount: number;
  brokenAlways: boolean;
  weeklyTo: string[];
}): Promise<ActionResult<ArjunSettingsView>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "Only somebody who can change the workspace's settings can change this." };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const perDay = Number(input?.perDay);
  if (!Number.isInteger(perDay) || perDay < 1 || perDay > ARJUN_PER_DAY_MAX) return { ok: false, error: `Drafts a day: a whole number from 1 to ${ARJUN_PER_DAY_MAX}.` };
  const minDaysLate = Number(input?.minDaysLate);
  if (!Number.isInteger(minDaysLate) || minDaysLate < 1 || minDaysLate > 365) return { ok: false, error: "Days late: a whole number from 1 to 365." };
  const minAmount = Number(input?.minAmount ?? 0);
  if (!Number.isFinite(minAmount) || minAmount < 0 || minAmount > 1e11) return { ok: false, error: "The smallest amount: zero or more." };
  const enabled = input?.enabled === true;
  if (enabled && !(await copilotConfig()).enabled) return { ok: false, error: "Switch Deskzo AI on first, above." };
  const before = await arjunConfig();
  if (!before.migrated) return { ok: false, error: "This workspace is still being updated. Try again in a few minutes." };
  // Only people who follow payments up get the note: it shows the money in their collections.
  const asked = Array.isArray(input?.weeklyTo) ? [...new Set(input.weeklyTo.map(String))].slice(0, 50) : [];
  const weeklyTo: string[] = [];
  for (const id of asked) {
    const person = await db.user.findUnique({ where: { id }, select: { active: true, kind: true } });
    if (person?.active && person.kind === "MEMBER" && (await mayLogFollowUps(id))) weeklyTo.push(id);
  }
  const brokenAlways = input?.brokenAlways !== false;
  await saveArjunConfig({ enabled, perDay, minDaysLate, minAmount: Math.round(minAmount * 100) / 100, brokenAlways, weeklyTo }, user.id);
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "CollectionAgentSettings",
    entityId: "global",
    entityLabel: enabled
      ? `Arjun drafts chase emails by himself each morning: ${minDaysLate}+ days late${brokenAlways ? " or a promise broken" : ""}${minAmount > 0 ? `, owing ${formatMoney(minAmount)} or more` : ""}; at most ${perDay} a day; Monday note to ${weeklyTo.length} ${weeklyTo.length === 1 ? "person" : "people"}`
      : "Arjun no longer drafts chase emails by himself",
  });
  const view = await getArjunSettings();
  return view ? { ok: true, data: view } : { ok: false, error: "Saved, but couldn't be read back." };
}
