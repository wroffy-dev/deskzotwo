"use server";

import { revalidatePath } from "next/cache";
import { requireUser, refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { mayAccess } from "@/lib/authz/access";
import { recordAudit } from "@/lib/audit";
import { copilotConfig } from "@/lib/copilot/settings";
import { db } from "@/lib/db";
import { MONTHS_MAX, MONTHS_MIN, PER_DAY_MAX } from "@/lib/reengage/rules";
import { ReengageRefusal, approveCheckIn, draftCheckIn, draftedToday, reengageConfig, reengageReport, saveReengageConfig, skipCheckIn } from "@/lib/reengage/server";
import type { ActionResult } from "@/actions/company";

/**
 * Tara re-engaging quiet customers (owner, 20 Nov 2026 — AI team step 4, src/lib/reengage). Asking for a check-in takes
 * "Use Deskzo AI" and being the customer's account manager or able to change the customer; sending, changing or setting
 * it aside is the account manager's alone, from their mailbox. Never while viewing as somebody.
 */

function refusal(err: unknown): { ok: false; error: string } {
  if (err instanceof ReengageRefusal) return { ok: false, error: err.message };
  throw err;
}

export async function draftReengage(companyId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const id = String(companyId ?? "");
  if (!(await can(user.id, "copilot.use"))) return { ok: false, error: "Asking Tara takes the “Use Deskzo AI” permission." };
  const company = await db.company.findUnique({ where: { id }, select: { ownerUserId: true } });
  if (!company) return { ok: false, error: "That company isn't there any more." };
  if (company.ownerUserId !== user.id && !(await mayAccess(user.id, "companies", "edit", id))) return { ok: false, error: "Only its account manager, or somebody who can change this customer, can ask." };
  try {
    await draftCheckIn(id, user.id);
    revalidatePath("/companies");
    return { ok: true, data: null };
  } catch (err) {
    return refusal(err);
  }
}

/** Approves a waiting check-in: "working-hours" (the default) holds it for the next working morning, "now" sends it. */
export async function sendReengage(input: { id: string; subject: string; body: string; when?: "now" | "working-hours" }): Promise<ActionResult<{ to: string; at: string | null }>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  try {
    return { ok: true, data: await approveCheckIn(String(input?.id ?? ""), user.id, { subject: String(input?.subject ?? ""), body: String(input?.body ?? "") }, new Date(), input?.when === "now" ? "now" : "working-hours") };
  } catch (err) {
    return refusal(err);
  }
}

export async function skipReengage(id: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  try {
    await skipCheckIn(String(id ?? ""), user.id);
    return { ok: true, data: null };
  } catch (err) {
    return refusal(err);
  }
}

export type ReengageSettingsView = {
  enabled: boolean;
  months: number;
  perDay: number;
  draftedToday: number;
  aiOn: boolean;
  migrated: boolean;
  report: Awaited<ReturnType<typeof reengageReport>>;
};

export async function getReengageSettings(): Promise<ReengageSettingsView | null> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return null;
  const config = await reengageConfig();
  const [today, ai, report] = await Promise.all([draftedToday(), copilotConfig(), reengageReport(config.months)]);
  return { enabled: config.enabled, months: config.months, perDay: config.perDay, draftedToday: today, aiOn: ai.enabled, migrated: config.migrated, report };
}

export async function saveReengageSettings(input: { enabled: boolean; months: number; perDay: number }): Promise<ActionResult<ReengageSettingsView>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "Only somebody who can change the workspace's settings can change this." };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const months = Number(input?.months);
  const perDay = Number(input?.perDay);
  if (!Number.isInteger(months) || months < MONTHS_MIN || months > MONTHS_MAX) return { ok: false, error: `Months without an order: a whole number from ${MONTHS_MIN} to ${MONTHS_MAX}.` };
  if (!Number.isInteger(perDay) || perDay < 0 || perDay > PER_DAY_MAX) return { ok: false, error: `Check-ins drafted a day: a whole number from 0 to ${PER_DAY_MAX}.` };
  const enabled = input?.enabled === true;
  if (enabled && !(await copilotConfig()).enabled) return { ok: false, error: "Switch Deskzo AI on first, above." };
  const before = await reengageConfig();
  if (!before.migrated) return { ok: false, error: "This workspace is still being updated. Try again in a few minutes." };
  await saveReengageConfig({ enabled, months, perDay }, user.id);
  if (enabled !== before.enabled || months !== before.months || perDay !== before.perDay) {
    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "ReengageSettings",
      entityId: "global",
      entityLabel: enabled
        ? `Tara may check in with customers quiet ${months} months, every email approved by the account manager; ${perDay ? `${perDay} drafted by herself a day at most` : "only when somebody asks"}`
        : "Tara no longer checks in with quiet customers",
    });
  }
  const view = await getReengageSettings();
  return view ? { ok: true, data: view } : { ok: false, error: "Saved, but couldn't be read back." };
}
