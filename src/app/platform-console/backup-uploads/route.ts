import { HEAD_BYTES, initUpload } from "@/lib/bundle/upload";
import { answerFor, json, uploader } from "@/lib/bundle/upload-guard";

/**
 * Begins uploading a Backup & Restore bundle (src/lib/bundle/upload.ts), at admin.<domain>/backup-uploads — the
 * console's Backups page, owners only. The body is the file's first bytes (up to 64 KiB); its name and size are in
 * `x-bundle-name` (URI-encoded) and `x-bundle-size`. A file that isn't a bundle, or is larger than the disk has free,
 * is refused here, before a part is sent. The answer is the upload's id, the part size and how many parts.
 */

export async function POST(request: Request) {
  const staff = await uploader(request);
  if (staff instanceof Response) return staff;
  try {
    const head = await firstBytes(request, HEAD_BYTES);
    if (!head) return json(413, { error: `Send only the file's first ${HEAD_BYTES} bytes to begin.` });
    let name = "";
    try {
      name = decodeURIComponent(request.headers.get("x-bundle-name") ?? "");
    } catch {
      name = "";
    }
    const started = await initUpload({ staffId: staff.id, name, total: Number(request.headers.get("x-bundle-size") ?? ""), head });
    const h = started.header;
    return json(200, {
      ok: true,
      id: started.id,
      name: started.name,
      total: started.total,
      partSize: started.partSize,
      parts: started.parts,
      received: started.received,
      header: h ? { kind: h.kind, createdAt: h.createdAt, workspaces: h.workspaces.map((w) => w.slug) } : null,
    });
  } catch (err) {
    return answerFor(err);
  }
}

/** The body, if it is at most `max` bytes; null when it is more. */
async function firstBytes(request: Request, max: number): Promise<Buffer | null> {
  if (!request.body) return Buffer.alloc(0);
  const parts: Buffer[] = [];
  let size = 0;
  const reader = request.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return null;
    }
    parts.push(Buffer.from(value));
  }
  return Buffer.concat(parts);
}
