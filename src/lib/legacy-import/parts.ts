import { randomUUID } from "crypto";
import { mkdir, readdir, readFile, rm, stat, writeFile } from "fs/promises";
import { tmpdir } from "os";
import path from "path";
import { UPLOAD_LIMITS, UploadRefused } from "./files";

/**
 * An upload sent in parts (owner, 26 Oct 2026: 250 MB uploads): Cloudflare, in front of Deskzo, refuses a request
 * over 100 MB on its usual plans, so the browser sends a big file 40 MB at a time and the parts wait here — on the
 * server's disk, under an id the first part was given, with who sent it — until the last arrives and they are put
 * back together. Parts not finished within a day are cleared away.
 */

const ROOT = path.join(tmpdir(), "deskzo-legacy-uploads");
const STALE_MS = 24 * 60 * 60 * 1000;

export const newUploadId = () => randomUUID();
const validId = (id: string) => /^[0-9a-f-]{36}$/.test(id);

async function clearStale() {
  const names = await readdir(ROOT).catch(() => [] as string[]);
  for (const n of names) {
    const s = await stat(path.join(ROOT, n)).catch(() => null);
    if (s && Date.now() - s.mtimeMs > STALE_MS) await rm(path.join(ROOT, n), { recursive: true, force: true }).catch(() => undefined);
  }
}

export type Part = { uploadId: string; index: number; count: number; name: string; size: number; userId: string; bytes: Buffer };

/**
 * Keeps one part; when it was the last, the whole file. Every part must come from the person who sent the first,
 * name the same file and size, and the parts together be exactly that size and within the upload limit.
 */
export async function receivePart(p: Part): Promise<{ done: false } | { done: true; name: string; bytes: Buffer }> {
  if (!validId(p.uploadId)) throw new UploadRefused("That upload's id isn't one this app gave.");
  if (!Number.isInteger(p.count) || p.count < 1 || !Number.isInteger(p.index) || p.index < 0 || p.index >= p.count) throw new UploadRefused("That part doesn't belong to the upload.");
  if (!Number.isInteger(p.size) || p.size <= 0 || p.size > UPLOAD_LIMITS.requestBytes) throw new UploadRefused(`That's over ${UPLOAD_LIMITS.requestBytes / 1024 / 1024} MB — upload it in more than one go.`);
  if (p.bytes.length > UPLOAD_LIMITS.partBytes + 1024) throw new UploadRefused("That part is larger than the app sends.");
  if (p.count > Math.ceil(UPLOAD_LIMITS.requestBytes / UPLOAD_LIMITS.partBytes) + 1) throw new UploadRefused("That upload has more parts than the app sends.");
  const dir = path.join(ROOT, p.uploadId);
  const metaFile = path.join(dir, "meta.json");
  if (p.index === 0) {
    await clearStale();
    await mkdir(dir, { recursive: true });
    await writeFile(metaFile, JSON.stringify({ userId: p.userId, name: p.name, size: p.size, count: p.count }));
  }
  const meta = JSON.parse(await readFile(metaFile, "utf8").catch(() => "null")) as { userId: string; name: string; size: number; count: number } | null;
  if (!meta || meta.userId !== p.userId || meta.name !== p.name || meta.size !== p.size || meta.count !== p.count) throw new UploadRefused("That upload was started by somebody else, or has gone — upload the file again.");
  await writeFile(path.join(dir, `part-${p.index}`), p.bytes);
  const have = (await readdir(dir)).filter((n) => n.startsWith("part-")).length;
  if (have < p.count) return { done: false };
  const parts: Buffer[] = [];
  for (let i = 0; i < p.count; i++) parts.push(await readFile(path.join(dir, `part-${i}`)));
  await rm(dir, { recursive: true, force: true });
  const bytes = Buffer.concat(parts);
  if (bytes.length !== p.size) throw new UploadRefused("The parts didn't add up to the file — upload it again.");
  return { done: true, name: p.name, bytes };
}
