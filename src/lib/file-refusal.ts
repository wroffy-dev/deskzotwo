import { StorageFull } from "@/lib/storage/allowance";
import { StoredRefRefused } from "@/lib/storage/files";

/**
 * A file the workspace won't keep, said the way the screen that sent it says any other "no" (storage in the plans,
 * 20 Nov 2026). `keepDataUrl` / `keepBytes` (src/lib/storage/files.ts) throw `StorageFull` at the workspace's limit —
 * and `StoredRefRefused` for an upload posing as a storage-box reference — and either one, left alone, reached the
 * person as a server error. Each writer catches it here and answers with its own refusal: `{ ok: false, error }` from
 * an action, a 413 from a route, a skipped file logged by a job in the background.
 *
 * Kept before the row is written, so a refusal leaves nothing half saved.
 */

/** The person-facing words for a file that wasn't kept; null for any other error (which stays an error). */
export function fileRefusal(err: unknown): string | null {
  return err instanceof StorageFull || err instanceof StoredRefRefused ? err.message : null;
}

/** Whether the error is the workspace's storage being full (a job skips the file and carries on). */
export const isStorageFull = (err: unknown): err is StorageFull => err instanceof StorageFull;

/**
 * Runs a save of a file: its result, or the refusal as an action answers it. Any other error is thrown on.
 *
 *   const kept = await keepOrRefuse(() => keepDataUrl("employee-documents", input.fileDataUrl));
 *   if (!kept.ok) return kept;
 */
export async function keepOrRefuse<T>(save: () => Promise<T>): Promise<{ ok: true; value: T } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await save() };
  } catch (err) {
    const refusal = fileRefusal(err);
    if (refusal === null) throw err;
    return { ok: false, error: refusal };
  }
}
