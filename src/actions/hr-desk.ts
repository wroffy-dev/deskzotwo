"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requireUser, refuseWhileViewingAs } from "@/lib/session";
import { requireModuleUser } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { recordAudit } from "@/lib/audit";
import { copilotConfig } from "@/lib/copilot/settings";
import { listKnowledgeFiles } from "@/lib/ai-knowledge/store";
import {
  HrDeskRefusal,
  answerAsHr,
  askForAPerson,
  askPriya,
  hrDeskClosed,
  hrDeskConfig,
  hrDeskFileIds,
  hrDeskReport,
  hrPeople,
  myQuestions,
  saveHrDeskConfig,
  type HrDeskReport,
  type QuestionView,
} from "@/lib/hr-desk/server";
import type { ActionResult } from "@/actions/company";

/**
 * Priya, the HR desk (owner, 20 Nov 2026 — src/lib/hr-desk). Asking takes My HR (the People module) and the desk switched
 * on; answering what she passes on takes "Manage people records" (`hr.manage`); her settings take `settings.manage`.
 * Never while viewing as somebody.
 */

function refusal<T>(err: unknown): ActionResult<T> {
  if (err instanceof HrDeskRefusal) return { ok: false, error: err.message };
  throw err;
}

export async function askHrDesk(question: string): Promise<ActionResult<QuestionView>> {
  const user = await requireModuleUser("hr");
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  try {
    const answered = await askPriya(user.id, String(question ?? ""));
    revalidatePath("/people/hr-desk");
    return { ok: true, data: answered };
  } catch (err) {
    return refusal(err);
  }
}

export async function askHrInstead(questionId: string): Promise<ActionResult<QuestionView>> {
  const user = await requireModuleUser("hr");
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  try {
    const passed = await askForAPerson(String(questionId ?? ""), user.id);
    revalidatePath("/people/hr-desk");
    return { ok: true, data: passed };
  } catch (err) {
    return refusal(err);
  }
}

export async function answerHrDeskQuestion(input: { id: string; answer: string }): Promise<ActionResult<null>> {
  const user = await requireModuleUser("hr");
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  if (!(await can(user.id, "hr.manage"))) return { ok: false, error: "Answering the HR desk's questions takes “Manage people records”." };
  try {
    await answerAsHr(String(input?.id ?? ""), user.id, String(input?.answer ?? ""));
    revalidatePath("/people/hr-desk");
    return { ok: true, data: null };
  } catch (err) {
    return refusal(err);
  }
}

/** For My HR: whether the desk is open to them, and their own questions. Null when it's switched off. */
export async function myHrDesk(): Promise<{ questions: QuestionView[]; closed: string | null } | null> {
  const user = await requireModuleUser("hr");
  const config = await hrDeskConfig();
  if (!config.migrated || !config.enabled) return null;
  return { questions: await myQuestions(user.id), closed: await hrDeskClosed() };
}

// ─── Settings › Deskzo AI ─────────────────────────────────────────────────────────────────────────────────────────

export type HrDeskSettingsView = {
  enabled: boolean;
  handTo: string[];
  /** Who may be named: active members who manage people records. */
  people: { id: string; name: string; hint: string | null }[];
  /** AI Knowledge's files, each ticked when she may answer from it; null before AI Knowledge is there. */
  files: { id: string; name: string; title: string; chosen: boolean }[] | null;
  aiOn: boolean;
  migrated: boolean;
  report: HrDeskReport;
};

export async function getHrDeskSettings(): Promise<HrDeskSettingsView | null> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return null;
  const [config, ai, report, peopleIds, files, chosen] = await Promise.all([hrDeskConfig(), copilotConfig(), hrDeskReport(), hrPeople([]), listKnowledgeFiles(), hrDeskFileIds()]);
  const people = await db.user.findMany({ where: { id: { in: peopleIds } }, orderBy: { name: "asc" }, select: { id: true, name: true, email: true } });
  const picked = new Set(chosen);
  return {
    enabled: config.enabled,
    handTo: config.handTo,
    people: people.map((p) => ({ id: p.id, name: p.name, hint: p.email })),
    files: files ? files.map((f) => ({ id: f.id, name: f.name, title: f.title, chosen: picked.has(f.id) })) : null,
    aiOn: ai.enabled,
    migrated: config.migrated,
    report,
  };
}

export async function saveHrDeskSettings(input: { enabled: boolean; handTo: string[]; fileIds: string[] }): Promise<ActionResult<HrDeskSettingsView>> {
  const user = await requireUser();
  if (!(await can(user.id, "settings.manage"))) return { ok: false, error: "Only somebody who can change the workspace's settings can change this." };
  const viewingAs = await refuseWhileViewingAs();
  if (viewingAs) return { ok: false, error: viewingAs };
  const enabled = input?.enabled === true;
  if (enabled && !(await copilotConfig()).enabled) return { ok: false, error: "Switch Deskzo AI on first, above." };
  const before = await hrDeskConfig();
  if (!before.migrated) return { ok: false, error: "This workspace is still being updated. Try again in a few minutes." };
  // Only people who manage people records may be named; only files that are there may be chosen.
  const allowed = new Set(await hrPeople([]));
  const handTo = (Array.isArray(input?.handTo) ? [...new Set(input.handTo.map(String))] : []).filter((id) => allowed.has(id)).slice(0, 20);
  const asked = Array.isArray(input?.fileIds) ? [...new Set(input.fileIds.map(String))] : [];
  const files = asked.length ? (await db.aiKnowledgeFile.findMany({ where: { id: { in: asked } }, select: { id: true } })).map((f) => f.id) : [];
  if (enabled && !(await hrPeople(handTo)).length) return { ok: false, error: "Nobody here manages people records, so nobody could answer what the HR desk passes on. Give somebody “Manage people records” first." };
  await saveHrDeskConfig({ enabled, handTo, fileIds: files }, user.id);
  await recordAudit({
    userId: user.id,
    action: "UPDATE",
    entityType: "HrDeskSettings",
    entityId: "global",
    entityLabel: enabled
      ? `The HR desk answers employees, from ${files.length} HR guide${files.length === 1 ? "" : "s"}; what it can't answer goes to ${handTo.length ? `${handTo.length} named` : "everybody who manages people records"}`
      : "The HR desk is switched off",
  });
  const view = await getHrDeskSettings();
  return view ? { ok: true, data: view } : { ok: false, error: "Saved, but couldn't be read back." };
}
