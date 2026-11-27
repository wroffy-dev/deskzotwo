"use server";

import { revalidatePath } from "next/cache";
import { isInternalError, plainError } from "@/lib/plain-error";
import { refuseWhileViewingAs, requireUser } from "@/lib/session";
import { can } from "@/lib/authz/resolve";
import { logActivity } from "@/lib/activity";
import { recordAudit } from "@/lib/audit";
import { getArea } from "@/lib/portability/areas";
import { parseFile, plan, apply, IMPLEMENTED_IMPORTS, templateColumnsFor, type FailedRow, type ImportPlan, type RowWindow } from "@/lib/portability/import";
import { keepUpload, keptUpload } from "@/lib/portability/upload-cache";
import { UPLOAD_GONE } from "@/lib/portability/upload-gone";
import { csvRow } from "@/lib/csv";
import { db } from "@/lib/db";
import { workspaceClock } from "@/lib/time/workspace";
import { notMigratedYet } from "@/lib/not-migrated";
import { moduleAvailableForTenant } from "@/lib/modules-access";
import type { ActionResult } from "@/actions/company";

/**
 * Two steps, and they cannot be collapsed into one.
 *
 * `previewImport` reads the file and reports exactly what would happen, writing nothing.
 * `commitImport` carries it out. The separation is the whole safety property: a bad import
 * overwrites records that were correct and does it across thousands of rows in a second, and the
 * person who notices is usually a customer, weeks later.
 *
 * The file is re-parsed on commit rather than the plan being carried between calls. It costs a
 * second and it means the thing written is the thing in the file, not a client-supplied object
 * shaped like a plan — which a `"use server"` action must never trust.
 */

/** A whole customer or contact list from another CRM in one file (owner, 28 Oct 2026) — sent by src/app/api/data-import. */
const MAX_BYTES = 25 * 1024 * 1024;

/**
 * The module each import area writes into. Security audit, 13 Nov 2026 (low, imports — "no plan check per import
 * area"): the gate asked only for the `data.import*` permission, so a workspace whose plan has no helpdesk, payroll or
 * accounting could still fill those tables from a file. An area missing here belongs to no one module: the
 * suppression list (Settings › Blocked addresses) and users are in every workspace.
 */
const IMPORT_AREA_MODULES: Record<string, string> = {
  companies: "companies",
  customers: "companies",
  contacts: "companies",
  // Certificates sit under CRM, beside the companies they're issued to (src/lib/modules.ts).
  "verifiable-documents": "companies",
  leads: "leads",
  vendors: "vendors",
  resellers: "resellers",
  "commission-parties": "commission_parties",
  workspace: "workspace",
  items: "items",
  tickets: "helpdesk",
  visits: "visits",
  assets: "it_assets",
  expenses: "expenses",
  ledger: "accounting",
  people: "hr",
  hiring: "hr",
};

/**
 * Whether this person may import into the area at all — its `data.import*` permission. Not which records: that is
 * asked row by row by the area's importer, inside `plan` and `apply` alike, so the preview and the write can never
 * disagree (owner, 2 Nov 2026 — "Phase 1 security fixes", audit H-6: the leads importer took this gate as leave to
 * match and overwrite any lead in the workspace, and its preview read out leads the importer couldn't open — see
 * src/lib/portability/importers/leads.ts "Whose leads").
 */
async function gate(areaKey: string) {
  const user = await requireUser();
  const area = getArea(areaKey);
  if (!area) return { user, area: null, error: "Unknown area." };
  if (!area.importPermission) {
    return { user, area, error: area.importRefusedBecause ?? "This area cannot be imported." };
  }
  if (!(await can(user.id, area.importPermission))) {
    return { user, area, error: `You can't import ${area.label.toLowerCase()}.` };
  }
  if (!IMPLEMENTED_IMPORTS.includes(areaKey)) {
    return { user, area, error: `Import for ${area.label.toLowerCase()} isn't built yet.` };
  }
  // Security audit, 13 Nov 2026 (low, imports): the area's module has to be in the plan and switched on.
  const moduleKey = IMPORT_AREA_MODULES[areaKey];
  if (moduleKey && !(await moduleAvailableForTenant(moduleKey))) {
    return { user, area, error: `${area.label} isn't part of this workspace's plan, or is switched off, so it can't be imported.` };
  }
  // Security audit round two, 13 Nov 2026 (R2-01 and its lows): an import writes thousands of rows in the importer's
  // name, people's pay inputs among them — only ever done as yourself, never while viewing as somebody.
  const viewing = await refuseWhileViewingAs();
  if (viewing) return { user, area, error: viewing };
  return { user, area, error: null };
}

/**
 * At most this many rows a request, previewed or imported (owner, 12 Nov 2026 — Phase 4, audit D.6.5). The screen sends
 * a large file a window at a time (500 to check, 200 to import — src/components/settings/import-dialog.tsx); the server
 * held to that only when a window was sent, and took the whole file when none was.
 */
const MAX_ROWS_PER_REQUEST = 2000;

/**
 * Rows a workspace may import in one business day, across every area (owner, 12 Nov 2026 — Phase 4, audit D.6.5):
 * generous — a whole CRM moved in a day fits — and there so that a script, or a mistake, can't write a workspace's
 * records over and over. Counted as they're taken (`takeImportRows`), on the workspace's own clock.
 */
const MAX_IMPORT_ROWS_PER_DAY = 50_000;

/**
 * The rows to take (`RowWindow`, src/lib/portability/import.ts): the window the screen sent, at most
 * `MAX_ROWS_PER_REQUEST` of it — and with none sent, the file's first `MAX_ROWS_PER_REQUEST`, never the whole file. The
 * answer's `processed` and `totalRows` say how far that got.
 */
function windowOf(input: { from?: unknown; count?: unknown }): RowWindow {
  const from = Number(input.from);
  const count = Number(input.count);
  return {
    from: Number.isInteger(from) && from >= 0 ? from : 0,
    count: Number.isInteger(count) && count > 0 ? Math.min(count, MAX_ROWS_PER_REQUEST) : MAX_ROWS_PER_REQUEST,
  };
}

/**
 * Takes `rows` of today's import allowance, or says no — in one statement, so two imports at once can't both take the
 * last of it. The business day is the workspace's. A workspace not migrated to 20261213100000_lead_intake_guards yet has
 * no count to keep, and is let through, as before.
 */
async function takeImportRows(rows: number): Promise<{ ok: true } | { ok: false; error: string }> {
  if (rows <= 0) return { ok: true };
  const day = (await workspaceClock()).dateKey(new Date());
  try {
    const taken = await db.$queryRaw<{ n: number }[]>`
      INSERT INTO "organisation_settings" ("id", "legalName", "importDay", "importRows", "updatedAt")
      SELECT 'global', '', ${day}::text, ${rows}::int, now() WHERE ${rows}::int <= ${MAX_IMPORT_ROWS_PER_DAY}::int
      ON CONFLICT ("id") DO UPDATE SET
        "importRows" = CASE WHEN "organisation_settings"."importDay" = ${day}::text THEN "organisation_settings"."importRows" + ${rows}::int ELSE ${rows}::int END,
        "importDay" = ${day}::text
      WHERE (CASE WHEN "organisation_settings"."importDay" = ${day}::text THEN "organisation_settings"."importRows" ELSE 0 END) + ${rows}::int <= ${MAX_IMPORT_ROWS_PER_DAY}::int
      RETURNING "importRows"::int AS n`;
    if (taken.length > 0) return { ok: true };
  } catch (err) {
    if (notMigratedYet(err)) return { ok: true };
    throw err;
  }
  return {
    ok: false,
    error: `This workspace can import ${MAX_IMPORT_ROWS_PER_DAY.toLocaleString("en-IN")} rows a day, and today's are nearly or all used. Import the rest tomorrow, or ask Deskzo support if you're moving a larger system across.`,
  };
}

/**
 * The file's rows: kept from an earlier window of the same import (`upload`, src/lib/portability/upload-cache.ts) — read
 * by the server then, never sent back by the browser — or read from what was sent and kept for the next window.
 */
async function rowsOf(
  input: { area: string; filename: string; base64: string; upload?: string },
  userId: string,
): Promise<{ rows: Record<string, string>[]; upload: string } | { error: string }> {
  if (input.upload) {
    const kept = keptUpload(input.upload, userId, input.area);
    if (kept) return { rows: kept.rows, upload: input.upload };
    // The screen sends the file again on this answer.
    if (!input.base64) return { error: UPLOAD_GONE };
  }
  if (Buffer.byteLength(input.base64, "base64") > MAX_BYTES) {
    return { error: `That file is over ${MAX_BYTES / 1024 / 1024}MB. Split it and import in batches.` };
  }
  if (!/\.(csv|xlsx)$/i.test(input.filename)) return { error: "Use a .csv or .xlsx file." };
  const rows = await parseFile(input.base64, input.filename);
  if (rows.length === 0) return { error: "That file has no rows." };
  return { rows, upload: keepUpload(userId, input.area, input.filename, rows) };
}

export async function previewImport(input: {
  area: string;
  filename: string;
  base64: string;
  from?: number;
  count?: number;
  upload?: string;
}): Promise<ActionResult<ImportPlan & { upload: string }>> {
  const { user, area, error } = await gate(input.area);
  if (error || !area) {
    if (error?.startsWith("You can't")) {
      await logActivity({
        kind: "PERMISSION_DENIED",
        severity: "WARNING",
        summary: `${user.name} tried to import ${input.area} without permission`,
      });
    }
    return { ok: false, error: error ?? "Unknown area." };
  }

  try {
    const read = await rowsOf(input, user.id);
    if ("error" in read) return { ok: false, error: read.error };
    return { ok: true, data: { ...(await plan(input.area, read.rows, user.id, windowOf(input))), upload: read.upload } };
  } catch (err) {
    // Our own refusals (a heading read twice, a sheet too large) say why; a library's error is logged, not shown.
    return { ok: false, error: isInternalError(err) ? plainError(err, "Couldn't read that file.") : `Couldn't read that file: ${(err as Error).message}` };
  }
}

export async function commitImport(input: {
  area: string;
  filename: string;
  base64: string;
  from?: number;
  count?: number;
  upload?: string;
}): Promise<ActionResult<{ created: number; updated: number; skipped: number; failed: FailedRow[]; processed: number; totalRows: number; upload: string }>> {
  const { user, area, error } = await gate(input.area);
  if (error || !area) return { ok: false, error: error ?? "Unknown area." };

  try {
    const read = await rowsOf(input, user.id);
    if ("error" in read) return { ok: false, error: read.error };
    const rows = read.rows;

    const window = windowOf(input);
    const processed = Math.max(0, Math.min(window.count, rows.length - window.from));
    // Taken before any row is written, all of the window or none of it.
    const allowed = await takeImportRows(processed);
    if (!allowed.ok) return { ok: false, error: allowed.error };
    const result = await apply(input.area, rows, user.id, window);

    const summary =
      `${user.name} imported ${area.label.toLowerCase()} from ${input.filename}${window.from > 0 || processed < rows.length ? ` (rows ${window.from + 2}–${window.from + 1 + processed} of ${rows.length})` : ""}: ` +
      `${result.created} created, ${result.updated} updated, ${result.skipped} unchanged` +
      (result.failed.length ? `, ${result.failed.length} failed` : "");

    // Both trails: the activity log is the security record of data entering the system, and the
    // audit log is where somebody looks when a record's history is in question.
    await logActivity({
      kind: "EXPORT",
      severity: result.failed.length ? "WARNING" : "NOTICE",
      summary,
      metadata: {
        direction: "import",
        area: input.area,
        file: input.filename,
        created: result.created,
        updated: result.updated,
        failed: result.failed.length,
      },
    });
    await recordAudit({
      userId: user.id,
      action: result.created > 0 ? "CREATE" : "UPDATE",
      entityType: "Import",
      entityId: input.area,
      entityLabel: summary,
    });

    revalidatePath("/", "layout");
    return { ok: true, data: { ...result, processed, totalRows: rows.length, upload: read.upload } };
  } catch (err) {
    return { ok: false, error: plainError(err, "Import failed.") };
  }
}

/** A CSV with the right headings and nothing else — the fastest way to get the columns right. */
export async function importTemplate(areaKey: string): Promise<ActionResult<{ filename: string; csv: string }>> {
  const { user, area, error } = await gate(areaKey);
  if (error || !area) return { ok: false, error: error ?? "Unknown area." };
  // The workspace's own fields this person may import join the built-in columns (src/lib/custom-fields/sheets.ts).
  const columns = await templateColumnsFor(areaKey, user.id);
  // Quoted: a field's label may hold a comma, which would otherwise split it into two columns.
  return { ok: true, data: { filename: `${areaKey}-import-template.csv`, csv: csvRow(columns) + "\n" } };
}
