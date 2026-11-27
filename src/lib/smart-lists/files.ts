import { db } from "@/lib/db";
import { bytesOf, keepBytes, StoredFileMissing } from "@/lib/storage/files";
import { LIMITS } from "@/lib/smart-lists/values";

/**
 * A Smart List's Files column (owner, 20 Nov 2026 — Smart Lists phase 2: "attach proof to a row: a backlink
 * screenshot, a snag photo, a certificate PDF"). A PDF or an image — checked by what it is, not what it's called — up
 * to 5 MB, kept in `workbook_files` and moved to the storage box when the server has one (src/lib/storage/files.ts).
 * A cell's value is its files' ids; a file taken out of its cell, or whose row is deleted, is deleted too. Who may
 * upload or download one is the list's rule, checked by the caller (src/actions/smart-list-links.ts and
 * /api/smart-lists/files/[id]). Server only.
 */

const KINDS: { type: string; ext: RegExp; starts: (b: Buffer) => boolean }[] = [
  { type: "application/pdf", ext: /\.pdf$/i, starts: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { type: "image/png", ext: /\.png$/i, starts: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: "image/jpeg", ext: /\.jpe?g$/i, starts: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/webp", ext: /\.webp$/i, starts: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

export type KeptFile = { ok: true; id: string; name: string } | { ok: false; error: string };

/** A file kept for one cell — not yet in it: the caller adds its id to the cell's value. */
export async function keepListFile(input: { workbookId: string; propertyId: string; rowKey: string; name: string; bytes: Buffer; userId: string }): Promise<KeptFile> {
  if (input.bytes.length === 0) return { ok: false, error: "That file is empty." };
  if (input.bytes.length > LIMITS.fileBytes) return { ok: false, error: `A file is ${LIMITS.fileBytes / 1024 / 1024} MB at most.` };
  const kind = KINDS.find((k) => k.starts(input.bytes));
  if (!kind) return { ok: false, error: "Upload a PDF, or a PNG, JPEG or WebP image." };
  const base = input.name.replace(/[\\/:*?"<>|\r\n]+/g, " ").trim().slice(0, 120) || "file";
  const name = kind.ext.test(base) ? base : `${base.replace(/\.[a-z0-9]{1,5}$/i, "")}.${kind.type.split("/")[1]!.replace("jpeg", "jpg")}`;
  const made = await db.workbookFile.create({
    data: {
      workbookId: input.workbookId,
      propertyId: input.propertyId,
      rowKey: input.rowKey,
      name,
      contentType: kind.type,
      size: input.bytes.length,
      data: await keepBytes("smart-list-files", input.bytes, kind.type),
      uploadedByUserId: input.userId,
    },
    select: { id: true },
  });
  return { ok: true, id: made.id, name };
}

/** A kept file, for a download the caller has already allowed. Null when it's gone. */
export async function readListFile(id: string): Promise<{ name: string; contentType: string; data: Buffer; workbookId: string; propertyId: string; rowKey: string } | null> {
  const f = await db.workbookFile.findUnique({ where: { id }, select: { name: true, contentType: true, data: true, workbookId: true, propertyId: true, rowKey: true } });
  if (!f) return null;
  try {
    return { ...f, data: Buffer.from(await bytesOf(f.data)) };
  } catch (err) {
    if (err instanceof StoredFileMissing) return null;
    throw err;
  }
}

/** A cell's files that its value no longer names, deleted — after a save. */
export async function dropFilesNotIn(propertyId: string, rowKey: string, keep: string[]): Promise<number> {
  return (await db.workbookFile.deleteMany({ where: { propertyId, rowKey, id: { notIn: keep } } })).count;
}

/** Every file of these rows, deleted — when the rows are. */
export async function dropFilesOfRows(workbookId: string, rowKeys: string[]): Promise<number> {
  if (!rowKeys.length) return 0;
  return (await db.workbookFile.deleteMany({ where: { workbookId, rowKey: { in: rowKeys } } })).count;
}
