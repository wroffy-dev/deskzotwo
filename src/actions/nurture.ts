"use server";

import { revalidatePath } from "next/cache";
import { requireUser, refuseWhileViewingAs } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { mayAccess } from "@/lib/authz/access";
import { recordAudit } from "@/lib/audit";
import { copilotConfig } from "@/lib/copilot/settings";
import {
  answerReply,
  approveTouch,
  enrolLead,
  enrolMany,
  NURTURE_PER_DAY_MAX,
  NurtureRefusal,
  nurtureConfig,
  nurtureReport,
  draftedToday,
  saveNurtureConfig,
  skipTouch,
  stopNurture,
} from "@/lib/nurture/server";
import type { ActionResult } from "@/actions/company";

/**
 * Deskzo AI nurturing a lead (owner, 18 Nov 2026 — phase 3, src/lib/nurture). Starting one takes "Use Deskzo AI" and the
 * right to change the lead; each email is sent, changed or skipped only by the lead's owner, from their own mailbox;
 * stopping it, by whoever may change the lead. Never while viewing as somebody. Phase 4 (20 Nov 2026): approved for the
 * working morning, a reply's drafted answer sent by the owner, many leads started at once, auto-start and booking links.
 */

async function refused(fn: () => Promise<void>): Promise<ActionResult<null>> {
  try {
    await fn();
    return { ok: true, data: null };
  } catch (err) {
    if (err instanceof NurtureRefusal) return { ok: false, error: err.message };
    throw err;
  }
}

/** Who may start nurturing: "Use Deskzo AI", with Deskzo AI on — or why not, in words. */
async function mayStart(userId: string): Promise<string | null> {
  if (!(await can(userId, "copilot.use"))) return "Nurturing takes the “Use Deskzo AI” permission.";
  if (!(await copilotConfig()).enabled) return "Deskzo AI is switched off.";
  return null;
}

export async function startNurture(leadId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const no = await mayStart(user.id);
  if (no) return { ok: false, error: no };
  if (!(await mayAccess(user.id, "leads", "edit", String(leadId ?? "")))) return { ok: false, error: "You can't change this lead." };
  return refused(() => enrolLead(String(leadId), user.id));
}

/**
 * Many leads at once, from the Leads list's bulk bar (phase 4): each one this person may change, started as its button
 * would — those without a Research & plan counted, not planned here. A hundred at a time at most.
 */
export async function startNurtureMany(leadIds: string[]): Promise<ActionResult<{ started: number; needPlan: number; refused: number; cantChange: number; firstReason: string | null }>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const no = await mayStart(user.id);
  if (no) return { ok: false, error: no };
  const ids = [...new Set((Array.isArray(leadIds) ? leadIds : []).map(String))].slice(0, 100);
  if (!ids.length) return { ok: false, error: "Choose the leads first." };
  const allowed: string[] = [];
  for (const id of ids) if (await mayAccess(user.id, "leads", "edit", id)) allowed.push(id);
  try {
    const out = await enrolMany(allowed, user.id);
    revalidatePath("/leads");
    return { ok: true, data: { started: out.started, needPlan: out.needPlan, refused: out.refused.length, cantChange: ids.length - allowed.length, firstReason: out.refused[0]?.why ?? null } };
  } catch (err) {
    if (err instanceof NurtureRefusal) return { ok: false, error: err.message };
    throw err;
  }
}

/** Approves a waiting email: `when` "working-hours" (the default) holds it for the next working morning, "now" sends it. */
export async function sendNurtureEmail(input: { touchId: string; subject: string; body: string; when?: "now" | "working-hours" }): Promise<ActionResult<{ to: string; at: string | null }>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  try {
    const sent = await approveTouch(String(input?.touchId ?? ""), user.id, { subject: String(input?.subject ?? ""), body: String(input?.body ?? "") }, new Date(), input?.when === "now" ? "now" : "working-hours");
    return { ok: true, data: sent };
  } catch (err) {
    if (err instanceof NurtureRefusal) return { ok: false, error: err.message };
    throw err;
  }
}

export async function skipNurtureEmail(touchId: string): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  return refused(() => skipTouch(String(touchId ?? ""), user.id));
}

/** The answer Deskzo AI drafted to a reply, as its owner changed it, sent from their mailbox (phase 4). */
export async function answerNurtureReply(input: { replyId: string; subject: string; body: string }): Promise<ActionResult<{ to: string }>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  try {
    return { ok: true, data: await answerReply(String(input?.replyId ?? ""), user.id, { subject: String(input?.subject ?? ""), body: String(input?.body ?? "") }) };
  } catch (err) {
    if (err instanceof NurtureRefusal) return { ok: false, error: err.message };
    throw err;
  }
}

export async function stopLeadNurture(input: { leadId: string; replied: boolean }): Promise<ActionResult<null>> {
  const user = await requireUser();
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const leadId = String(input?.leadId ?? "");
  if (!(await mayAccess(user.id, "leads", "edit", leadId))) return { ok: false, error: "You can't change this lead." };
  return refused(() => stopNurture(leadId, user.id, input?.replied === true));
}

export type NurtureSettingsView = {
  enabled: boolean;
  perDay: number;
  draftedToday: number;
  aiOn: boolean;
  migrated: boolean;
  /** Phase 4's switches, and whether this workspace has them yet. */
  phase4: boolean;
  autoStart: boolean;
  bookingLinks: boolean;
  report: Awaited<ReturnType<typeof nurtureReport>>;
};

export async function getNurtureSettings(): Promise<NurtureSettingsView | null> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return null;
  const [config, today, ai, report] = await Promise.all([nurtureConfig(), draftedToday(), copilotConfig(), nurtureReport()]);
  return {
    enabled: config.enabled,
    perDay: config.perDay,
    draftedToday: today,
    aiOn: ai.enabled,
    migrated: config.migrated,
    phase4: config.phase4,
    autoStart: config.autoStart,
    bookingLinks: config.bookingLinks,
    report,
  };
}

export async function saveNurtureSettings(input: { enabled: boolean; perDay: number; autoStart?: boolean; bookingLinks?: boolean }): Promise<ActionResult<NurtureSettingsView>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "Only somebody who can change the workspace's settings can change this." };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const perDay = Number(input?.perDay);
  if (!Number.isInteger(perDay) || perDay < 1 || perDay > NURTURE_PER_DAY_MAX) return { ok: false, error: `Emails drafted a day: a whole number from 1 to ${NURTURE_PER_DAY_MAX}.` };
  const enabled = input?.enabled === true;
  if (enabled && !(await copilotConfig()).enabled) return { ok: false, error: "Switch Deskzo AI on first, above." };
  const before = await nurtureConfig();
  if (!before.migrated) return { ok: false, error: "This workspace is still being updated. Try again in a few minutes." };
  const autoStart = typeof input?.autoStart === "boolean" ? input.autoStart && enabled : undefined;
  const bookingLinks = typeof input?.bookingLinks === "boolean" ? input.bookingLinks : undefined;
  await saveNurtureConfig({ enabled, perDay, autoStart, bookingLinks }, user.id);
  const after = await nurtureConfig();
  const changes: string[] = [];
  if (enabled !== before.enabled || perDay !== before.perDay) {
    changes.push(enabled ? `Deskzo AI may nurture leads, every email approved by the lead's owner; at most ${perDay} drafted a day` : "Deskzo AI no longer nurtures leads");
  }
  if (after.autoStart !== before.autoStart) changes.push(after.autoStart ? "Hot and warm leads planned from now on are nurtured without a click" : "Leads are nurtured only when somebody starts it");
  if (after.bookingLinks !== before.bookingLinks) changes.push(after.bookingLinks ? "Nurture emails carry the owner's booking link" : "Nurture emails no longer carry a booking link");
  for (const label of changes) await recordAudit({ userId: user.id, action: "UPDATE", entityType: "NurtureSettings", entityId: "global", entityLabel: label });
  const view = await getNurtureSettings();
  return view ? { ok: true, data: view } : { ok: false, error: "Saved, but couldn't be read back." };
}
