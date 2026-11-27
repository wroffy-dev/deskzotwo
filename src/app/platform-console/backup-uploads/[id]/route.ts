import { Readable } from "node:stream";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import { auditTenantId } from "@/lib/bundle/jobs";
import { cancelUpload, completeUpload, receivePart, uploadStatus } from "@/lib/bundle/upload";
import { answerFor, json, uploader } from "@/lib/bundle/upload-guard";
import { consoleAudit, revalidateConsole } from "@/lib/platform/console-guard";

/**
 * One upload of a Backup & Restore bundle (src/lib/bundle/upload.ts), at admin.<domain>/backup-uploads/<id>:
 *
 *   GET                       what has arrived — the page carries on from `nextPart` after a reload
 *   PUT ?part=<n>             one part, its SHA-256 in `x-part-sha256`; idempotent by part number
 *   POST                      every byte is there: the file becomes a READY backup (source UPLOADED)
 *   DELETE                    stop, and remove what had arrived
 *
 * Owners only, from the console's own page, and only the owner who began it.
 */

type Params = { params: Promise<{ id: string }> };

export async function GET(request: Request, { params }: Params) {
  const staff = await uploader(request);
  if (staff instanceof Response) return staff;
  try {
    return json(200, { ok: true, ...(await uploadStatus((await params).id, staff.id)) });
  } catch (err) {
    return answerFor(err);
  }
}

export async function PUT(request: Request, { params }: Params) {
  const staff = await uploader(request);
  if (staff instanceof Response) return staff;
  try {
    const part = new URL(request.url).searchParams.get("part");
    const body = request.body ? Readable.fromWeb(request.body as unknown as NodeReadableStream<Uint8Array>) : Readable.from([]);
    const result = await receivePart({ id: (await params).id, staffId: staff.id, part: part === null || part === "" ? NaN : Number(part), sha256: request.headers.get("x-part-sha256"), body });
    return json(200, { ok: true, ...result });
  } catch (err) {
    return answerFor(err);
  }
}

export async function POST(request: Request, { params }: Params) {
  const staff = await uploader(request);
  if (staff instanceof Response) return staff;
  try {
    const done = await completeUpload((await params).id, staff.id);
    const workspace = done.header.kind === "workspace" ? (done.header.workspaces[0] ?? null) : null;
    await consoleAudit(
      staff,
      "backup.upload",
      { backupId: done.backupId, kind: done.header.kind === "full" ? "FULL" : "WORKSPACE", workspace: workspace?.slug ?? null, file: done.fileName, sizeBytes: done.sizeBytes, sha256: done.sha256 },
      await auditTenantId(workspace?.id ?? null),
    );
    revalidateConsole();
    return json(200, { ok: true, backupId: done.backupId, fileName: done.fileName, sizeBytes: done.sizeBytes, sha256: done.sha256 });
  } catch (err) {
    return answerFor(err);
  }
}

export async function DELETE(request: Request, { params }: Params) {
  const staff = await uploader(request);
  if (staff instanceof Response) return staff;
  try {
    await cancelUpload((await params).id, staff.id);
    return json(200, { ok: true });
  } catch (err) {
    return answerFor(err);
  }
}
