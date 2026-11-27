"use server";

import type { StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { isTeammateKey } from "@/lib/ai/teammates";
import { AI_KNOWLEDGE_LIMITS, normaliseText } from "@/lib/ai-knowledge/chunk";
import { knowledgeName, readKnowledgeUpload } from "@/lib/ai-knowledge/upload";
import { forgetTraining, previewTraining } from "@/lib/ai-training/prompt";
import { cleanAgents, type TrainingBulkChange, type TrainingFileDetail, type TrainingPreview, type TrainingSaveReport } from "@/lib/ai-training/shared";
import { bulkDeleteTrainingFiles, bulkUpdateTrainingFiles, cleanTenantIds, deleteTrainingFile, saveTrainingTexts, trainingFile, updateTrainingFile } from "@/lib/ai-training/store";
import { MANAGERS, SETTINGS_VIEWERS, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { ConsoleRefused } from "@/lib/platform/refused";
import { StaffRefused, requireStaff, type Staff } from "@/lib/platform/staff-session";

/**
 * Settings › AI training in the console (src/lib/ai-training): owners and admins upload, edit and delete the training
 * files Deskzo AI's teammates are given, and choose which teammates and which workspaces each is for. Everybody who may
 * open Settings may read them and try a question. Every change is audited by the file's name — never its text — and
 * clears this process's copy; other servers pick it up within a minute.
 *
 * A server action takes 6 MB (next.config.ts); training files are guides, far under that, and a .zip of them too.
 */

async function asStaff<T>(roles: readonly StaffRole[], work: (staff: Staff) => Promise<T>): Promise<ConsoleResult<T>> {
  let staff: Staff;
  try {
    staff = await requireStaff(roles);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  try {
    return { ok: true, data: await work(staff) };
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

function refuse(message: string): never {
  throw new ConsoleRefused(message);
}

function fileId(value: unknown): string {
  const id = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) refuse("That file isn't there any more.");
  return id;
}

/** The scope a form sends: teammates and workspaces as JSON lists, two ticks. */
async function scopeOf(input: { agents: unknown; tenantIds: unknown; always: unknown; active: unknown }) {
  const tenantIds = await cleanTenantIds(input.tenantIds);
  if (Array.isArray(input.tenantIds) && input.tenantIds.length && !tenantIds.length) refuse("None of the workspaces chosen exists any more — choose again, or choose every workspace.");
  return { agents: cleanAgents(input.agents), tenantIds, always: input.always === true, active: input.active !== false };
}

/** The files a bulk change is for: known-looking ids, once each, at most a thousand. */
function fileIds(value: unknown): string[] {
  const ids = [...new Set((Array.isArray(value) ? value : []).map((v) => (typeof v === "string" ? v.trim() : "")).filter((v) => /^[A-Za-z0-9_-]{1,64}$/.test(v)))];
  if (!ids.length) refuse("Choose at least one file.");
  if (ids.length > 1000) refuse("Choose at most 1,000 files at once.");
  return ids;
}

const parseList = (raw: FormDataEntryValue | null): unknown => {
  try {
    return JSON.parse(typeof raw === "string" ? raw : "[]");
  } catch {
    return [];
  }
};

/** Several .md/.txt files, or a .zip of them, for the teammates and workspaces chosen on the form. */
export async function consoleUploadAiTraining(form: FormData): Promise<ConsoleResult<TrainingSaveReport>> {
  return asStaff(MANAGERS, async (staff) => {
    const uploads = form.getAll("files").filter((f): f is File => f instanceof File && f.size > 0);
    if (!uploads.length) refuse("Choose .md or .txt files, or a .zip of them.");
    const scope = await scopeOf({ agents: parseList(form.get("agents")), tenantIds: parseList(form.get("tenantIds")), always: form.get("always") === "true", active: true });
    const read = await readKnowledgeUpload(await Promise.all(uploads.map(async (f) => ({ name: f.name, bytes: Buffer.from(await f.arrayBuffer()) }))));
    const saved = await saveTrainingTexts(staff.id, read.files, scope);
    const names = [...saved.added, ...saved.replaced];
    if (names.length) {
      await consoleAudit(staff, "ai.training.upload", { added: saved.added.length, replaced: saved.replaced.length, files: names.slice(0, 20), agents: scope.agents, workspaces: scope.tenantIds.length || "all" });
      forgetTraining();
      revalidateConsole();
    }
    return { ...saved, skipped: [...read.skipped, ...saved.skipped] };
  });
}

export async function consoleAiTrainingFile(id: string): Promise<ConsoleResult<TrainingFileDetail>> {
  return asStaff(SETTINGS_VIEWERS, async () => (await trainingFile(fileId(id))) ?? refuse("That file isn't there any more."));
}

/** A file's name, text, teammates, workspaces and ticks, saved and cut into chunks again. */
export async function consoleSaveAiTrainingFile(input: { id: string; name: string; content: string; agents: string[]; tenantIds: string[]; always: boolean; active: boolean }): Promise<ConsoleResult<null>> {
  return asStaff(MANAGERS, async (staff) => {
    const id = fileId(input.id);
    const name = knowledgeName(String(input.name ?? "")) ?? refuse(`Give it a name of at most ${AI_KNOWLEDGE_LIMITS.nameChars} characters.`);
    if (!/\.(md|markdown|txt)$/i.test(name)) refuse("The name ends in .md or .txt.");
    const content = normaliseText(String(input.content ?? ""));
    if (!content) refuse("The file has no text.");
    if (content.length > AI_KNOWLEDGE_LIMITS.fileChars) refuse(`That's over ${AI_KNOWLEDGE_LIMITS.fileChars.toLocaleString("en-IN")} characters — split it into smaller files.`);
    const scope = await scopeOf(input);
    const problem = await updateTrainingFile(staff.id, id, { name, content, ...scope });
    if (problem) refuse(problem);
    await consoleAudit(staff, "ai.training.update", { id, name, agents: scope.agents, workspaces: scope.tenantIds.length || "all", always: scope.always, active: scope.active });
    forgetTraining();
    revalidateConsole();
    return null;
  });
}

export async function consoleDeleteAiTrainingFile(id: string): Promise<ConsoleResult<null>> {
  return asStaff(MANAGERS, async (staff) => {
    const key = fileId(id);
    const name = (await deleteTrainingFile(key)) ?? refuse("That file isn't there any more.");
    await consoleAudit(staff, "ai.training.delete", { id: key, name });
    forgetTraining();
    revalidateConsole();
    return null;
  });
}

/**
 * Owner, 23 Nov 2026 — "add a bulk change option": the files chosen get the teammates, workspaces or ticks given;
 * anything not given stays as each file has it. Audited once, with the names (up to 20) and what was set.
 */
export async function consoleBulkUpdateAiTraining(input: { ids: string[]; change: TrainingBulkChange }): Promise<ConsoleResult<{ changed: number }>> {
  return asStaff(MANAGERS, async (staff) => {
    const ids = fileIds(input.ids);
    const given = (input.change ?? {}) as Record<string, unknown>;
    const change: TrainingBulkChange = {};
    if (given.agents !== undefined) change.agents = cleanAgents(given.agents);
    if (given.tenantIds !== undefined) {
      change.tenantIds = await cleanTenantIds(given.tenantIds);
      if (Array.isArray(given.tenantIds) && given.tenantIds.length && !change.tenantIds.length) refuse("None of the workspaces chosen exists any more — choose again, or choose every workspace.");
    }
    if (typeof given.always === "boolean") change.always = given.always;
    if (typeof given.active === "boolean") change.active = given.active;
    if (!Object.keys(change).length) refuse("Choose something to change.");
    const names = await bulkUpdateTrainingFiles(staff.id, ids, change);
    if (!names.length) refuse("Those files aren't there any more.");
    await consoleAudit(staff, "ai.training.bulk_update", {
      count: names.length,
      files: names.slice(0, 20),
      ...(change.agents ? { agents: change.agents } : {}),
      ...(change.tenantIds ? { workspaces: change.tenantIds.length || "all" } : {}),
      ...(change.always !== undefined ? { always: change.always } : {}),
      ...(change.active !== undefined ? { active: change.active } : {}),
    });
    forgetTraining();
    revalidateConsole();
    return { changed: names.length };
  });
}

/** The files chosen, deleted together. Audited once, with the names (up to 20). */
export async function consoleBulkDeleteAiTraining(input: { ids: string[] }): Promise<ConsoleResult<{ deleted: number }>> {
  return asStaff(MANAGERS, async (staff) => {
    const names = await bulkDeleteTrainingFiles(fileIds(input.ids));
    if (!names.length) refuse("Those files aren't there any more.");
    await consoleAudit(staff, "ai.training.bulk_delete", { count: names.length, files: names.slice(0, 20) });
    forgetTraining();
    revalidateConsole();
    return { deleted: names.length };
  });
}

/** "Try it": what a teammate in a workspace would be given for a question — and how long finding it took. */
export async function consolePreviewAiTraining(input: { agent: string; tenantId: string; question: string }): Promise<ConsoleResult<TrainingPreview>> {
  return asStaff(SETTINGS_VIEWERS, async () => {
    if (!isTeammateKey(input.agent)) refuse("Choose a teammate.");
    const [tenantId] = await cleanTenantIds([input.tenantId]);
    if (!tenantId) refuse("Choose a workspace.");
    return previewTraining(input.agent, tenantId, String(input.question ?? "").slice(0, 2000));
  });
}
