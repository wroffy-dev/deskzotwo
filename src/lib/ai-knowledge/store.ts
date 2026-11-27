import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { AI_KNOWLEDGE_LIMITS, chunkFile, fileTitle, isMarkdownName } from "@/lib/ai-knowledge/chunk";
import type { UploadedText } from "@/lib/ai-knowledge/upload";

/**
 * AI Knowledge's files in the workspace's own database (owner, 3 Nov 2026). Saving a file — uploaded or edited —
 * keeps it whole and remakes its chunks in one transaction, so a search never finds half of an old file and half of
 * a new one. No permission is checked here: the callers do (src/actions/ai-knowledge.ts, the upload route).
 */

/**
 * `forCustomers` — "Website chat may use this" (security audit, 11 Nov 2026 — SEC-46): the Customer inbox's bot answers
 * customers only from files with it on. Null while the workspace's database hasn't the column yet: no file is used.
 */
export type KnowledgeFileRow = { id: string; name: string; title: string; chars: number; chunks: number; updatedAt: string; updatedBy: string | null; forCustomers: boolean | null };
export type KnowledgeFileDetail = { id: string; name: string; title: string; content: string; chars: number; updatedAt: string };
export type SaveReport = { added: string[]; replaced: string[]; skipped: { name: string; reason: string }[] };

/** Every file, by name — null when the workspace's database hasn't the tables yet. */
export async function listKnowledgeFiles(): Promise<KnowledgeFileRow[] | null> {
  const select = { id: true, name: true, title: true, chars: true, updatedAt: true, updatedBy: { select: { name: true } }, _count: { select: { chunks: true } } } as const;
  try {
    // "Website chat may use this" is asked for by name — it isn't in every workspace's database yet, so a read that
    // doesn't name it never brings it (security audit, 11 Nov 2026 — SEC-46). Where it's missing, the files without it.
    const rows = await db.aiKnowledgeFile
      .findMany({ orderBy: { name: "asc" }, select: { ...select, forCustomers: true } })
      .then((found) => found.map((r) => ({ ...r, forCustomers: r.forCustomers as boolean | null })))
      .catch(async (err) => {
        if (!notMigratedYet(err)) throw err;
        return (await db.aiKnowledgeFile.findMany({ orderBy: { name: "asc" }, select })).map((r) => ({ ...r, forCustomers: null as boolean | null }));
      });
    return rows.map((r) => ({ id: r.id, name: r.name, title: r.title, chars: r.chars, chunks: r._count.chunks, updatedAt: r.updatedAt.toISOString(), updatedBy: r.updatedBy?.name ?? null, forCustomers: r.forCustomers }));
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/**
 * How many files the website chat may answer from — for the Customer inbox's settings, beside "Use AI Knowledge".
 * Null when the workspace's database can't say yet (security audit, 11 Nov 2026 — SEC-46).
 */
export async function countKnowledgeForCustomers(): Promise<number | null> {
  try {
    return await db.aiKnowledgeFile.count({ where: { forCustomers: true } });
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/**
 * "Website chat may use this", ticked or cleared on one file (security audit, 11 Nov 2026 — SEC-46). The file's name;
 * null when it isn't there any more; "not-ready" while the workspace's database hasn't the column yet. A file
 * replaced by an upload or edited keeps its tick — neither writes it — and a new file starts without one.
 */
export async function setKnowledgeForCustomers(id: string, on: boolean): Promise<{ name: string } | "not-ready" | null> {
  const existing = await db.aiKnowledgeFile.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return null;
  try {
    return await db.aiKnowledgeFile.update({ where: { id }, data: { forCustomers: on }, select: { name: true } });
  } catch (err) {
    if (notMigratedYet(err)) return "not-ready";
    throw err;
  }
}

export async function knowledgeFile(id: string): Promise<KnowledgeFileDetail | null> {
  const r = await db.aiKnowledgeFile.findUnique({ where: { id }, select: { id: true, name: true, title: true, content: true, chars: true, updatedAt: true } });
  return r ? { ...r, updatedAt: r.updatedAt.toISOString() } : null;
}

/** Whether there's anything to search — the copilot offers search_knowledge only then. */
export async function hasKnowledge(): Promise<boolean> {
  try {
    return (await db.aiKnowledgeChunk.findFirst({ select: { id: true } })) !== null;
  } catch (err) {
    if (notMigratedYet(err)) return false;
    throw err;
  }
}

/** A file with this name, whatever its case: "FAQ.md" and "faq.md" are one file. */
function byName(name: string, except?: string) {
  return db.aiKnowledgeFile.findFirst({ where: { name: { equals: name, mode: "insensitive" }, ...(except ? { id: { not: except } } : {}) }, select: { id: true, name: true } });
}

/** Writes one file and its chunks: a new one, or `id`'s, its old chunks replaced. */
async function write(input: { id: string | null; name: string; content: string; userId: string }): Promise<string> {
  const markdown = isMarkdownName(input.name);
  const chunks = chunkFile(input.content, { markdown });
  const data = { name: input.name, title: fileTitle(input.content, markdown), content: input.content, chars: input.content.length, updatedById: input.userId };
  return db.$transaction(
    async (tx) => {
      const file = input.id ? await tx.aiKnowledgeFile.update({ where: { id: input.id }, data, select: { id: true } }) : await tx.aiKnowledgeFile.create({ data, select: { id: true } });
      await tx.aiKnowledgeChunk.deleteMany({ where: { fileId: file.id } });
      if (chunks.length) await tx.aiKnowledgeChunk.createMany({ data: chunks.map((c, position) => ({ fileId: file.id, position, heading: c.heading, text: c.text })) });
      return file.id;
    },
    { timeout: 30_000 },
  );
}

/**
 * An upload's files, saved: a new name is added, a name already here has its file replaced. Past the workspace's
 * limit of files, the rest are left out and said so.
 */
export async function saveKnowledgeTexts(userId: string, files: UploadedText[]): Promise<SaveReport> {
  const report: SaveReport = { added: [], replaced: [], skipped: [] };
  let count = await db.aiKnowledgeFile.count();
  for (const file of files) {
    const existing = await byName(file.name);
    if (!existing && count >= AI_KNOWLEDGE_LIMITS.files) {
      report.skipped.push({ name: file.name, reason: `AI Knowledge holds at most ${AI_KNOWLEDGE_LIMITS.files.toLocaleString("en-IN")} files` });
      continue;
    }
    // A replaced file keeps the name it had: the upload's spelling of it may differ only in case.
    await write({ id: existing?.id ?? null, name: existing?.name ?? file.name, content: file.content, userId });
    if (existing) report.replaced.push(existing.name);
    else {
      report.added.push(file.name);
      count += 1;
    }
  }
  return report;
}

/** A file edited in Settings: its name and text, saved and cut into chunks again. The reason it can't be, or null. */
export async function updateKnowledgeFile(userId: string, id: string, input: { name: string; content: string }): Promise<string | null> {
  const existing = await db.aiKnowledgeFile.findUnique({ where: { id }, select: { id: true } });
  if (!existing) return "That file isn't there any more.";
  const clash = await byName(input.name, id);
  if (clash) return `There's already a file called “${clash.name}”.`;
  await write({ id, name: input.name, content: input.content, userId });
  return null;
}

/** A file and its chunks, gone. Its name, or null when it wasn't there. */
export async function deleteKnowledgeFile(id: string): Promise<string | null> {
  const existing = await db.aiKnowledgeFile.findUnique({ where: { id }, select: { name: true } });
  if (!existing) return null;
  await db.aiKnowledgeFile.delete({ where: { id } });
  return existing.name;
}
