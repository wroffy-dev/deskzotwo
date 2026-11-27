import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { OWNERS, hasRole } from "@/lib/console-shared/roles";
import { auditTenantId, bundlePath, downloadName, settleBackups } from "@/lib/bundle/jobs";
import { cleanStaleUploads } from "@/lib/bundle/upload";
import { sameOrigin } from "@/lib/http/same-origin";
import { consoleAudit } from "@/lib/platform/console-guard";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { currentStaffSession, type Staff } from "@/lib/platform/staff-session";
import { recentStepUp, tellOtherOwners } from "@/lib/platform/step-up";

/**
 * A Backup & Restore bundle's file, at admin.<domain>/backup-files/<id> (the proxy rewrites the console host into
 * /platform-console; outside the `(console)` group, so no layout wraps it — the way support-files/ is served, since
 * /api on the console's host answers only the platform's own machine routes, src/proxy.ts PLATFORM_API).
 *
 * The whole installation, or a whole workspace, leaves the server in one request, so:
 *
 *   · from a page of the console only (`sameOrigin`: another site's link or form is refused);
 *   · owners only, signed in with their second factor;
 *   · and a fresh authenticator code given on this session in the last ten minutes (the page asks for it first —
 *     src/lib/platform/step-up.ts `recentStepUp`), so a session alone, stolen or left open, can't take it;
 *   · recorded (`backup.download`) before the first byte goes, and every other owner told.
 *
 * Streamed from the disk with its Content-Length, never read into memory — a full bundle is gigabytes. A bundle whose
 * file is gone (expired, deleted, never made) is answered 410 with what happened to it. HEAD answers the same checks
 * with the same headers, without the bytes or a record.
 */

const TEXT = { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } as const;
const plain = (status: number, message: string) => new Response(message, { status, headers: TEXT });

type Params = { params: Promise<{ id: string }> };
type Checked = { staff: Staff; row: { id: string; kind: "FULL" | "WORKSPACE"; tenantId: string | null; tenantSlug: string | null; sizeBytes: bigint | null; sha256: string | null }; file: string; size: number; name: string };

async function check(request: Request, { params }: Params): Promise<Response | Checked> {
  if (!controlConfigured()) return plain(404, "Not found.");
  if (!sameOrigin(request)) return plain(403, "Backups are only downloaded from the console's own page.");
  const session = await currentStaffSession();
  if (!session || !session.mfaDone) return plain(401, "Sign in to the console.");
  if (!hasRole(session.staff.role, OWNERS)) return plain(403, "Only an owner can download backups.");
  if (!(await recentStepUp(session.sessionId))) return plain(403, "Enter a fresh code from your authenticator first — a download needs one from the last ten minutes.");

  const { id } = await params;
  const row = /^[A-Za-z0-9_-]{8,64}$/.test(id) ? await controlDb().platformBackup.findUnique({ where: { id } }) : null;
  if (!row) return plain(404, "There is no backup with that id.");
  if (row.status === "READY" && row.expiresAt && row.expiresAt.getTime() <= Date.now()) {
    await settleBackups(new Date(), cleanStaleUploads);
    return plain(410, "This backup's file was removed: it expired a day after it was made. Make a new one.");
  }
  if (row.status === "EXPIRED") return plain(410, "This backup's file was removed: it expired a day after it was made. Make a new one.");
  if (row.status === "DELETED") return plain(410, "This backup's file was deleted.");
  if (row.status === "RUNNING") return plain(409, "This backup is still being made.");
  if (row.status === "FAILED") return plain(410, "This backup failed; there is no file to download.");
  const file = bundlePath(row.fileName);
  const info = file ? await stat(file).catch(() => null) : null;
  if (!file || !info?.isFile()) return plain(410, "This backup's file is no longer on the server.");
  return { staff: session.staff, row, file, size: info.size, name: downloadName(row) };
}

function headersFor(checked: Checked): Record<string, string> {
  return {
    "Content-Type": "application/octet-stream",
    "Content-Length": String(checked.size),
    "Content-Disposition": `attachment; filename="${checked.name}"`,
    // Never in a shared cache, and never in the browser's either: this is everything the installation holds.
    "Cache-Control": "private, no-store",
    "X-Content-Type-Options": "nosniff",
    ...(checked.row.sha256 ? { "X-Content-SHA256": checked.row.sha256 } : {}),
  };
}

export async function GET(request: Request, context: Params) {
  const checked = await check(request, context);
  if (checked instanceof Response) return checked;
  const { staff, row, file, name, size } = checked;
  // Before the stream: a download that was recorded and then dropped is the right way round.
  await consoleAudit(staff, "backup.download", { backupId: row.id, kind: row.kind, workspace: row.tenantSlug, file: name, sizeBytes: size }, await auditTenantId(row.tenantId));
  void tellOtherOwners(staff, `Backup downloaded: ${name} (${row.kind === "FULL" ? "the whole installation" : `workspace ${row.tenantSlug ?? ""}`})`);
  const stream = createReadStream(file, { highWaterMark: 1024 * 1024 });
  return new Response(Readable.toWeb(stream) as ReadableStream, { status: 200, headers: headersFor(checked) });
}

export async function HEAD(request: Request, context: Params) {
  const checked = await check(request, context);
  if (checked instanceof Response) return new Response(null, { status: checked.status, headers: checked.headers });
  return new Response(null, { status: 200, headers: headersFor(checked) });
}
