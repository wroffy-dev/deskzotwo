import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { keepBytes } from "@/lib/storage/files";

/**
 * The old proposals' own files (owner, 25 Nov 2026), put beside the proposals brought in: the folder is chosen in the
 * browser and sent a few at a time, each found by its path in the folder. Only a path an imported proposal names is kept.
 */

export const FILE_LIMITS = { bytes: 15 * 1024 * 1024, perRequest: 12, requestBytes: 24 * 1024 * 1024 };

const TYPES: Record<string, string> = {
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xls: "application/vnd.ms-excel",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  doc: "application/msword",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const extension = (name: string) => /\.(\w+)$/.exec(name)?.[1]?.toLowerCase() ?? "";

/** The latest version's path of each imported proposal, and its other papers', not kept yet. */
export async function filesWanted(): Promise<string[]> {
  try {
    const rows = await db.oldProposal.findMany({ select: { paths: true, attachments: true, files: { select: { path: true } } } });
    return rows.flatMap((r) => [...r.paths.slice(0, 1), ...r.attachments].filter((p) => !r.files.some((f) => f.path === p)));
  } catch (err) {
    if (notMigratedYet(err)) return [];
    throw err;
  }
}

/** Keeps one file. False where no imported proposal names it, or it is kept already. A full store throws. */
export async function keepOldProposalFile(path: string, bytes: Buffer): Promise<boolean> {
  const name = path.split("/").pop() ?? "";
  const contentType = TYPES[extension(name)];
  if (!contentType || !bytes.length || bytes.length > FILE_LIMITS.bytes) return false;
  // What it says it is: an Office file or a PDF by its first bytes, so nothing else is kept under its name.
  const head = bytes.subarray(0, 4).toString("latin1");
  const zip = head.startsWith("PK");
  const ole = head === "\xd0\xcf\x11\xe0";
  if (contentType === TYPES.pdf ? head !== "%PDF" : !zip && !ole) return false;
  const proposal = await db.oldProposal.findFirst({ where: { OR: [{ paths: { has: path } }, { attachments: { has: path } }] }, select: { id: true, files: { where: { path }, select: { id: true } } } });
  if (!proposal || proposal.files.length) return false;
  const data = await keepBytes("old-proposals", bytes, contentType);
  const { count } = await db.oldProposalFile.createMany({ data: [{ proposalId: proposal.id, path, name: name.slice(0, 200), contentType, data, size: bytes.length }], skipDuplicates: true });
  return count > 0;
}
