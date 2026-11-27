import { Prisma, type LegacyImportStatus } from "@prisma/client";
import { db } from "@/lib/db";
import { defaultMapping, detectKind, kindDef, mapRow, type KindKey } from "./formats";
import type { ReadFile } from "./files";

/**
 * Runs and their files (src/lib/legacy-import). One draft at a time: files are uploaded into it, looked at, mapped,
 * previewed, and then it is imported — after which the next upload starts a new draft. Rows are kept in chunks so a
 * batch of the import reads only the part it works on.
 */

export class ImportRefused extends Error {}

export const CHUNK_ROWS = 500;

export type FileSummary = {
  id: string;
  name: string;
  kind: KindKey | null;
  headers: string[];
  mapping: Record<string, string | null>;
  rowCount: number;
};

export type RunSummary = {
  id: string;
  status: LegacyImportStatus;
  strategy: string | null;
  createdAt: Date;
  startedAt: Date | null;
  finishedAt: Date | null;
  undoneAt: Date | null;
  backupId: string | null;
  files: FileSummary[];
};

const fileSelect = { id: true, name: true, kind: true, headers: true, mapping: true, rowCount: true } as const;
const asFile = (f: { id: string; name: string; kind: string | null; headers: string[]; mapping: unknown; rowCount: number }): FileSummary => ({
  ...f,
  kind: (kindDef(f.kind)?.key ?? null) as KindKey | null,
  // A column the table reads that the saved mapping has never heard of (one added since the upload — country_code,
  // 27 Oct 2026) is read from the heading of its name; a column the person set, to a heading or to none, stays theirs.
  mapping: {
    ...(kindDef(f.kind) ? defaultMapping(kindDef(f.kind)!.key, f.headers) : {}),
    ...((f.mapping && typeof f.mapping === "object" ? f.mapping : {}) as Record<string, string | null>),
  },
});

export async function runSummary(importId: string): Promise<RunSummary | null> {
  const run = await db.legacyImport.findUnique({
    where: { id: importId },
    select: { id: true, status: true, strategy: true, createdAt: true, startedAt: true, finishedAt: true, undoneAt: true, backupId: true, files: { select: fileSelect, orderBy: { createdAt: "asc" } } },
  });
  return run ? { ...run, files: run.files.map(asFile) } : null;
}

/** The draft being put together, if there is one. */
export async function currentDraft(): Promise<RunSummary | null> {
  const run = await db.legacyImport.findFirst({ where: { status: "DRAFT" }, orderBy: { createdAt: "desc" }, select: { id: true } });
  return run ? runSummary(run.id) : null;
}

/** The import under way, if one is. */
export async function runningImport(): Promise<{ id: string } | null> {
  return db.legacyImport.findFirst({ where: { status: "IMPORTING" }, select: { id: true } });
}

/** Every run, newest first — the history the page lists, with what each brought. */
export async function runHistory() {
  const runs = await db.legacyImport.findMany({
    where: { status: { not: "DRAFT" } },
    orderBy: { createdAt: "desc" },
    take: 20,
    select: { id: true, status: true, strategy: true, createdAt: true, startedAt: true, finishedAt: true, undoneAt: true, progress: true, _count: { select: { records: true, errors: true } } },
  });
  return runs.map((r) => ({ ...r, records: r._count.records, errors: r._count.errors, progress: (r.progress ?? {}) as Record<string, unknown> }));
}

/**
 * Adds files to the draft (starting one if need be). A file of the same name replaces the one there; each is taken
 * for the table its headings say, its columns read from headings of the same name — both can be changed after.
 */
export async function addFiles(files: ReadFile[], userId: string): Promise<RunSummary> {
  if (await runningImport()) throw new ImportRefused("An import is running. Wait for it to finish before uploading more.");
  const draft = (await db.legacyImport.findFirst({ where: { status: "DRAFT" }, orderBy: { createdAt: "desc" }, select: { id: true } })) ?? (await db.legacyImport.create({ data: { createdById: userId }, select: { id: true } }));
  for (const file of files) {
    const kind = detectKind(file.headers, file.name);
    await db.$transaction(
      async (tx) => {
        await tx.legacyImportFile.deleteMany({ where: { importId: draft.id, name: file.name } });
        const made = await tx.legacyImportFile.create({
          data: { importId: draft.id, name: file.name, kind, headers: file.headers, mapping: (kind ? defaultMapping(kind, file.headers) : {}) as Prisma.InputJsonValue, rowCount: file.rows.length },
          select: { id: true },
        });
        for (let seq = 0; seq * CHUNK_ROWS < file.rows.length; seq++) {
          await tx.legacyImportChunk.create({ data: { fileId: made.id, seq, rows: file.rows.slice(seq * CHUNK_ROWS, (seq + 1) * CHUNK_ROWS) as Prisma.InputJsonValue } });
        }
      },
      { timeout: 120_000 },
    );
  }
  // What was previewed no longer holds once the files change.
  await clearAnalysis(draft.id);
  return (await runSummary(draft.id))!;
}

async function draftFile(fileId: string) {
  const file = await db.legacyImportFile.findUnique({ where: { id: fileId }, select: { ...fileSelect, import: { select: { id: true, status: true } } } });
  if (!file || file.import.status !== "DRAFT") throw new ImportRefused("That file isn't in the import being put together.");
  return file;
}

export async function removeFile(fileId: string) {
  const file = await draftFile(fileId);
  await db.legacyImportFile.delete({ where: { id: file.id } });
  await clearAnalysis(file.import.id);
}

/** Takes a file for another table (or none), its columns read afresh from headings of the same name. */
export async function setFileKind(fileId: string, kind: string | null) {
  const file = await draftFile(fileId);
  const def = kind ? kindDef(kind) : null;
  if (kind && !def) throw new ImportRefused("Choose one of the old CRM's tables.");
  await db.legacyImportFile.update({ where: { id: file.id }, data: { kind: def?.key ?? null, mapping: (def ? defaultMapping(def.key, file.headers) : {}) as Prisma.InputJsonValue } });
  await clearAnalysis(file.import.id);
}

/** Which heading each column is read from: one of the file's headings, or none. */
export async function setFileMapping(fileId: string, mapping: Record<string, string | null>) {
  const file = await draftFile(fileId);
  const def = kindDef(file.kind);
  if (!def) throw new ImportRefused("Choose the table this file holds first.");
  const headers = new Set(file.headers);
  const next: Record<string, string | null> = {};
  for (const column of def.columns) {
    const heading = mapping?.[column] ?? null;
    if (heading !== null && !headers.has(heading)) throw new ImportRefused(`"${heading}" isn't a heading in ${file.name}.`);
    next[column] = heading;
  }
  await db.legacyImportFile.update({ where: { id: file.id }, data: { mapping: next as Prisma.InputJsonValue } });
  await clearAnalysis(file.import.id);
}

/** What was worked out from the files — the preview and the master lists — no longer holds once they change. */
export async function clearAnalysis(importId: string) {
  await db.legacyImport.update({ where: { id: importId }, data: { analysis: Prisma.DbNull } });
  await db.legacyMatch.deleteMany({ where: { importId } });
}

/** Throws a draft away, files and all. */
export async function discardDraft(importId: string) {
  const run = await db.legacyImport.findUnique({ where: { id: importId }, select: { status: true } });
  if (!run || run.status !== "DRAFT") throw new ImportRefused("Only an import that hasn't started can be thrown away.");
  await db.legacyImport.delete({ where: { id: importId } });
}

export type SourceRow = { row: Record<string, string>; file: string; line: number };

/** Every file of one table in a run, each with its mapping. */
export async function filesOfKind(importId: string, kind: KindKey) {
  const files = await db.legacyImportFile.findMany({ where: { importId, kind }, select: fileSelect, orderBy: { createdAt: "asc" } });
  return files.map(asFile);
}

/** A table's rows across its files, read through each file's mapping, in order, with the line each came from. */
export async function* rowsOf(importId: string, kind: KindKey): AsyncGenerator<SourceRow> {
  for (const file of await filesOfKind(importId, kind)) {
    const chunks = await db.legacyImportChunk.findMany({ where: { fileId: file.id }, select: { seq: true }, orderBy: { seq: "asc" } });
    for (const { seq } of chunks) {
      const chunk = await db.legacyImportChunk.findUnique({ where: { fileId_seq: { fileId: file.id, seq } }, select: { rows: true } });
      const rows = (chunk?.rows ?? []) as Record<string, string>[];
      for (let i = 0; i < rows.length; i++) yield { row: mapRow(rows[i]!, file.mapping), file: file.name, line: seq * CHUNK_ROWS + i + 2 };
    }
  }
}

/** A slice of a table's rows: from `offset`, at most `limit` — what one batch of the import works on. */
export async function rowsSlice(importId: string, kind: KindKey, offset: number, limit: number): Promise<SourceRow[]> {
  const out: SourceRow[] = [];
  let skip = offset;
  for (const file of await filesOfKind(importId, kind)) {
    if (skip >= file.rowCount) {
      skip -= file.rowCount;
      continue;
    }
    let seq = Math.floor(skip / CHUNK_ROWS);
    let at = skip % CHUNK_ROWS;
    skip = 0;
    while (out.length < limit && seq * CHUNK_ROWS < file.rowCount) {
      const chunk = await db.legacyImportChunk.findUnique({ where: { fileId_seq: { fileId: file.id, seq } }, select: { rows: true } });
      const rows = (chunk?.rows ?? []) as Record<string, string>[];
      for (; at < rows.length && out.length < limit; at++) out.push({ row: mapRow(rows[at]!, file.mapping), file: file.name, line: seq * CHUNK_ROWS + at + 2 });
      seq += 1;
      at = 0;
    }
    if (out.length >= limit) break;
  }
  return out;
}

/** How many rows a table has across the run's files. */
export async function countOf(importId: string, kind: KindKey): Promise<number> {
  return (await filesOfKind(importId, kind)).reduce((t, f) => t + f.rowCount, 0);
}
