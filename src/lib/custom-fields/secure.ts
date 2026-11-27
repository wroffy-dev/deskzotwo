import { db } from "@/lib/db";
import { decryptSecret } from "@/lib/crypto";
import { CUSTOM_FIELD_LIMITS, fileValue, secretCipher, type CustomFieldEntityKey } from "@/lib/custom-fields/rules";
import { definitionsFor, fileIdsInUse, valuesFor } from "@/lib/custom-fields/server";
import { bytesOf, keepBytes, StoredFileMissing } from "@/lib/storage/files";
import { keepOrRefuse } from "@/lib/file-refusal";

/**
 * Secrets and files on custom fields (owner, 29 Oct 2026): a subscription's licence key, its certificate.
 *
 *   · **A secret** is encrypted as it is saved (src/lib/custom-fields/server.ts `prepareCustomFields`) and shown only
 *     as its last four. Reading it back is `revealFieldSecret`, after the caller has decided who may — a person with
 *     `fields.revealSecrets` who may open the record, or the customer through the portal behind its emailed code —
 *     and every reveal is a row in `custom_field_reveals`.
 *   · **A file** is a PDF or an image, listed in `custom_field_files` and kept in the storage box when the server has
 *     one (src/lib/storage/files.ts), in that row otherwise. It's checked by what it is, not by what it's called: a PDF
 *     starts "%PDF".
 */

const KINDS: { type: string; ext: RegExp; starts: (b: Buffer) => boolean }[] = [
  { type: "application/pdf", ext: /\.pdf$/i, starts: (b) => b.subarray(0, 5).toString("latin1") === "%PDF-" },
  { type: "image/png", ext: /\.png$/i, starts: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  { type: "image/jpeg", ext: /\.jpe?g$/i, starts: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  { type: "image/webp", ext: /\.webp$/i, starts: (b) => b.subarray(0, 4).toString("latin1") === "RIFF" && b.subarray(8, 12).toString("latin1") === "WEBP" },
];

/** `full`: refused because the workspace's storage is full (the route answers 413, as for a file too big). */
export type Uploaded = { ok: true; value: string; name: string } | { ok: false; error: string; full?: true };

/** A file uploaded for one field, kept until a record names it. */
export async function keepUploadedFile(params: { entity: CustomFieldEntityKey; fieldKey: string; name: string; bytes: Buffer; userId: string }): Promise<Uploaded> {
  const def = (await definitionsFor(params.entity)).find((d) => d.key === params.fieldKey && d.type === "FILE" && !d.archived);
  if (!def) return { ok: false, error: "That field no longer takes files." };
  if (params.bytes.length === 0) return { ok: false, error: "That file is empty." };
  if (params.bytes.length > CUSTOM_FIELD_LIMITS.fileBytes) return { ok: false, error: `A file is ${CUSTOM_FIELD_LIMITS.fileBytes / 1024 / 1024} MB at most.` };
  const kind = KINDS.find((k) => k.starts(params.bytes));
  if (!kind) return { ok: false, error: "Upload a PDF, or a PNG, JPEG or WebP image." };
  const base = params.name.replace(/[\\/:*?"<>|\r\n]+/g, " ").trim().slice(0, 120) || "file";
  const name = kind.ext.test(base) ? base : `${base.replace(/\.[a-z0-9]{1,5}$/i, "")}.${kind.type.split("/")[1]!.replace("jpeg", "jpg")}`;
  // Kept before the row: out of storage, the person is told and nothing is written (src/lib/file-refusal.ts).
  const kept = await keepOrRefuse(() => keepBytes("custom-field-files", params.bytes, kind.type));
  if (!kept.ok) return { ...kept, full: true };
  const made = await db.customFieldFile.create({
    data: { entity: params.entity, fieldKey: def.key, name, contentType: kind.type, size: params.bytes.length, data: kept.value, uploadedById: params.userId },
    select: { id: true },
  });
  return { ok: true, value: fileValue(made.id, name), name };
}

/** How long an uploaded file waits for a record to name it before the clean-up takes it. */
export const UNCLAIMED_FILE_MS = 24 * 60 * 60_000;

/**
 * Security audit, 11 Nov 2026 (SEC-62): files uploaded and never saved on a record — or replaced since — are deleted
 * once they are a day old. Each upload is a row of up to 5 MB in the workspace's own database, and nothing else ever
 * removed one. Run once a day from the heartbeat (src/lib/marketing/heartbeat.ts). Never throws.
 */
export async function sweepUnclaimedFieldFiles(now = new Date(), only?: { ids: string[] }): Promise<number> {
  try {
    const old = await db.customFieldFile.findMany({ where: { createdAt: { lt: new Date(now.getTime() - UNCLAIMED_FILE_MS) }, ...(only ? { id: { in: only.ids } } : {}) }, select: { id: true, entity: true, fieldKey: true } });
    if (!old.length) return 0;
    const unclaimed: string[] = [];
    for (const entity of [...new Set(old.map((f) => f.entity))]) {
      const files = old.filter((f) => f.entity === entity);
      const used = await fileIdsInUse(entity as CustomFieldEntityKey, files.map((f) => f.fieldKey));
      for (const f of files) if (!used.has(f.id)) unclaimed.push(f.id);
    }
    if (!unclaimed.length) return 0;
    return (await db.customFieldFile.deleteMany({ where: { id: { in: unclaimed } } })).count;
  } catch (err) {
    console.error("[custom-fields] unclaimed file sweep failed", err instanceof Error ? err.message : err);
    return 0;
  }
}

/** A kept file, for a download the caller has already allowed. */
export async function readFieldFile(id: string): Promise<{ name: string; contentType: string; data: Buffer; entity: string; fieldKey: string } | null> {
  const f = await db.customFieldFile.findUnique({ where: { id }, select: { name: true, contentType: true, data: true, entity: true, fieldKey: true } });
  if (!f) return null;
  // From the storage box when it is kept there; one the box no longer has reads as none, so the download is not found.
  try {
    return { ...f, data: Buffer.from(await bytesOf(f.data)) };
  } catch (err) {
    if (err instanceof StoredFileMissing) return null;
    throw err;
  }
}

/** "attachment; filename=…" that any browser reads, whatever the name holds. */
export function attachmentHeader(name: string, inline = false): string {
  const ascii = name.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${inline ? "inline" : "attachment"}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

/**
 * A record's secret in the clear, and the reveal recorded — once the caller has decided who may see it. Null when
 * the field isn't a secret, is retired, or the record holds none.
 */
export async function revealFieldSecret(params: { entity: CustomFieldEntityKey; recordId: string; fieldKey: string; by: { userId: string } | { portalLoginId: string } }): Promise<string | null> {
  const def = (await definitionsFor(params.entity)).find((d) => d.key === params.fieldKey && d.type === "SECRET" && !d.archived);
  if (!def) return null;
  const cipher = secretCipher((await valuesFor(params.entity, params.recordId))[def.key]);
  if (!cipher) return null;
  const plain = await decryptSecret(cipher);
  await db.customFieldReveal.create({
    data: { entity: params.entity, recordId: params.recordId, fieldKey: def.key, ...("userId" in params.by ? { byUserId: params.by.userId } : { byPortalLogin: params.by.portalLoginId }) },
  });
  return plain;
}

/** How many times a record's secrets were revealed, and the last time — for the record's page. */
export async function revealsOf(entity: CustomFieldEntityKey, recordId: string): Promise<{ count: number; last: Date | null }> {
  const [count, last] = await Promise.all([
    db.customFieldReveal.count({ where: { entity, recordId } }),
    db.customFieldReveal.findFirst({ where: { entity, recordId }, orderBy: { at: "desc" }, select: { at: true } }),
  ]);
  return { count, last: last?.at ?? null };
}
