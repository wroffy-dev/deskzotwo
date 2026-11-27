import { controlDb } from "@/lib/platform/control-db";
import { AI_KNOWLEDGE_LIMITS, chunkFile, fileTitle, isMarkdownName } from "@/lib/ai-knowledge/chunk";
import type { UploadedText } from "@/lib/ai-knowledge/upload";
import type { TeammateKey } from "@/lib/ai/teammates";
import { cleanAgents, type TrainingBulkChange, type TrainingFileDetail, type TrainingFileRow, type TrainingSaveReport, type TrainingWorkspace } from "@/lib/ai-training/shared";

/**
 * The console's side of AI training (src/lib/ai-training/shared.ts): the files in the control plane's database, kept
 * whole and in chunks, written in one transaction so a search never finds half of an old file and half of a new one.
 * Cut exactly as a workspace's AI Knowledge is (src/lib/ai-knowledge/chunk.ts). No permission is checked here: the
 * console's actions do (src/actions/platform/console-ai-training.ts). Server only.
 */

/** Files in all. */
export const TRAINING_FILES_MAX = AI_KNOWLEDGE_LIMITS.files;

const ROW_SELECT = { id: true, name: true, title: true, chars: true, agents: true, tenantIds: true, always: true, active: true, updatedAt: true, _count: { select: { chunks: true } } } as const;

type Stored = { id: string; name: string; title: string; chars: number; agents: string[]; tenantIds: string[]; always: boolean; active: boolean; updatedAt: Date; _count: { chunks: number } };

const rowOf = (r: Stored): TrainingFileRow => ({
  id: r.id,
  name: r.name,
  title: r.title,
  chars: r.chars,
  chunks: r._count.chunks,
  agents: cleanAgents(r.agents),
  tenantIds: r.tenantIds ?? [],
  always: r.always,
  active: r.active,
  updatedAt: r.updatedAt.toISOString(),
});

export async function listTrainingFiles(): Promise<TrainingFileRow[]> {
  const rows = await controlDb().platformAiTrainingFile.findMany({ orderBy: { name: "asc" }, select: ROW_SELECT });
  return rows.map(rowOf);
}

export async function trainingFile(id: string): Promise<TrainingFileDetail | null> {
  const r = await controlDb().platformAiTrainingFile.findUnique({ where: { id }, select: { ...ROW_SELECT, content: true } });
  return r ? { ...rowOf(r), content: r.content } : null;
}

/** The workspaces a file may be given to — every one that isn't closed for good. */
export async function trainingWorkspaces(): Promise<TrainingWorkspace[]> {
  return controlDb().tenant.findMany({ where: { status: { not: "DEPROVISIONED" } }, orderBy: { name: "asc" }, take: 5000, select: { id: true, slug: true, name: true } });
}

/** Only ids of workspaces that exist, once each. */
export async function cleanTenantIds(value: unknown): Promise<string[]> {
  const given = [...new Set((Array.isArray(value) ? value : []).map((v) => String(v).trim()).filter((v) => /^[A-Za-z0-9_-]{1,64}$/.test(v)))];
  if (!given.length) return [];
  const found = await controlDb().tenant.findMany({ where: { id: { in: given.slice(0, 5000) } }, select: { id: true } });
  return found.map((t) => t.id);
}

function byName(name: string, except?: string) {
  return controlDb().platformAiTrainingFile.findFirst({ where: { name: { equals: name, mode: "insensitive" }, ...(except ? { id: { not: except } } : {}) }, select: { id: true, name: true } });
}

type Scope = { agents: TeammateKey[]; tenantIds: string[]; always: boolean; active: boolean };

/** Writes one file and its chunks: a new one, or `id`'s with its old chunks replaced. */
async function write(input: { id: string | null; name: string; content: string; staffId: string; scope?: Scope }): Promise<string> {
  const markdown = isMarkdownName(input.name);
  const chunks = chunkFile(input.content, { markdown });
  const data = { name: input.name, title: fileTitle(input.content, markdown), content: input.content, chars: input.content.length, updatedById: input.staffId, ...(input.scope ?? {}) };
  return controlDb().$transaction(
    async (tx) => {
      const file = input.id
        ? await tx.platformAiTrainingFile.update({ where: { id: input.id }, data, select: { id: true } })
        : await tx.platformAiTrainingFile.create({ data: { ...data, createdById: input.staffId }, select: { id: true } });
      await tx.platformAiTrainingChunk.deleteMany({ where: { fileId: file.id } });
      if (chunks.length) await tx.platformAiTrainingChunk.createMany({ data: chunks.map((c, position) => ({ fileId: file.id, position, heading: c.heading, text: c.text })) });
      return file.id;
    },
    { timeout: 30_000 },
  );
}

/**
 * An upload's files, saved for `scope`'s teammates and workspaces: a new name is added; a name already here has its
 * text replaced and is given the upload's scope too — what was chosen on the upload form is what the staff member sees.
 */
export async function saveTrainingTexts(staffId: string, files: UploadedText[], scope: Scope): Promise<TrainingSaveReport> {
  const report: TrainingSaveReport = { added: [], replaced: [], skipped: [] };
  let count = await controlDb().platformAiTrainingFile.count();
  for (const file of files) {
    const existing = await byName(file.name);
    if (!existing && count >= TRAINING_FILES_MAX) {
      report.skipped.push({ name: file.name, reason: `AI training holds at most ${TRAINING_FILES_MAX.toLocaleString("en-IN")} files` });
      continue;
    }
    await write({ id: existing?.id ?? null, name: existing?.name ?? file.name, content: file.content, staffId, scope });
    if (existing) report.replaced.push(existing.name);
    else {
      report.added.push(file.name);
      count += 1;
    }
  }
  return report;
}

/** A file edited in the console: its name, text and scope. The reason it can't be saved, or null. */
export async function updateTrainingFile(staffId: string, id: string, input: { name: string; content: string } & Scope): Promise<string | null> {
  const existing = await controlDb().platformAiTrainingFile.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return "That file isn't there any more.";
  const clash = await byName(input.name, id);
  if (clash) return `There's already a file called “${clash.name}”.`;
  const { name, content, ...scope } = input;
  await write({ id, name, content, staffId, scope });
  return null;
}

/**
 * Owner, 23 Nov 2026 — "add a bulk change option": the files chosen get `change`'s fields, the rest of each kept as it
 * was. Only who a file is for and its two ticks change, never its text, so its chunks stay as they are. The names of
 * the files changed.
 */
export async function bulkUpdateTrainingFiles(staffId: string, ids: string[], change: TrainingBulkChange): Promise<string[]> {
  const control = controlDb();
  const files = await control.platformAiTrainingFile.findMany({ where: { id: { in: ids } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  if (!files.length) return [];
  await control.platformAiTrainingFile.updateMany({ where: { id: { in: files.map((f) => f.id) } }, data: { ...change, updatedById: staffId } });
  return files.map((f) => f.name);
}

/** The files chosen and their chunks (the foreign key cascades), gone. Their names. */
export async function bulkDeleteTrainingFiles(ids: string[]): Promise<string[]> {
  const control = controlDb();
  const files = await control.platformAiTrainingFile.findMany({ where: { id: { in: ids } }, select: { id: true, name: true }, orderBy: { name: "asc" } });
  if (!files.length) return [];
  await control.platformAiTrainingFile.deleteMany({ where: { id: { in: files.map((f) => f.id) } } });
  return files.map((f) => f.name);
}

/** A file and its chunks, gone. Its name, or null when it wasn't there. */
export async function deleteTrainingFile(id: string): Promise<string | null> {
  const existing = await controlDb().platformAiTrainingFile.findUnique({ where: { id }, select: { name: true } });
  if (!existing) return null;
  await controlDb().platformAiTrainingFile.delete({ where: { id } });
  return existing.name;
}
