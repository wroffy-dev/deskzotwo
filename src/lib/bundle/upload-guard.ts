import { OWNERS, hasRole } from "@/lib/console-shared/roles";
import { UploadRefused } from "@/lib/bundle/upload";
import { sameOrigin } from "@/lib/http/same-origin";
import { controlConfigured } from "@/lib/platform/control-db";
import { currentStaffSession, type Staff } from "@/lib/platform/staff-session";

/**
 * Who may upload a Backup & Restore bundle (src/lib/bundle/upload.ts), for the routes under
 * admin.<domain>/backup-uploads: owners only, signed in with their second factor, from a page of the console.
 */

export const json = (status: number, body: Record<string, unknown>) => Response.json(body, { status, headers: { "cache-control": "no-store" } });

export async function uploader(request: Request): Promise<Staff | Response> {
  if (!controlConfigured()) return json(404, { error: "Not found." });
  if (!sameOrigin(request)) return json(403, { error: "Backups are only uploaded from the console's own page." });
  const session = await currentStaffSession();
  if (!session || !session.mfaDone) return json(401, { error: "Sign in to the console." });
  if (!hasRole(session.staff.role, OWNERS)) return json(403, { error: "Only an owner can upload backups." });
  return session.staff;
}

/** A refusal as the browser reads it; anything else is a 500 without its insides. */
export function answerFor(err: unknown): Response {
  if (err instanceof UploadRefused) return json(err.status, { error: err.message });
  console.error(`[backups] an upload request failed: ${(err as { code?: string } | null)?.code ?? (err instanceof Error ? err.name : "error")}`);
  return json(500, { error: "The server couldn't take that part just now. Try again in a moment." });
}
