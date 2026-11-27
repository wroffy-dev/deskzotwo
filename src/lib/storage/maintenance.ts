import { createHash } from "node:crypto";
import { db } from "@/lib/db";
import { offsiteSetup } from "@/lib/offsite/config";
import { KeptByStore } from "@/lib/offsite/store";
import { storageBox, workspaceBox } from "@/lib/storage/box";
import { keepBytes, keepDataUrl, storedRef, TEXT_REF } from "@/lib/storage/files";
import { FILE_COLUMNS, type FileColumn } from "@/lib/storage/registry";
import { currentTenant } from "@/lib/tenancy/resolve";

/**
 * Moving a workspace's existing files into the storage box, and sweeping out the files no row points at any more.
 * Both run as the workspace (runAsTenant), from scripts/storage-box.ts and the nightly chores.
 */

const q = (name: string) => `"${name.replace(/"/g, '""')}"`;

/**
 * A maintenance query, given ten minutes instead of the workspace role's thirty seconds (src/lib/platform/provisioner.ts
 * ROLE_LIMITS): counting or listing every row of a table of files can take longer than a page's query ever should.
 */
export async function longQuery<T>(sql: string, ...params: unknown[]): Promise<T> {
  return db.$transaction(
    async (tx) => {
      await tx.$executeRawUnsafe("SET LOCAL statement_timeout = '600s'");
      return tx.$queryRawUnsafe<T>(sql, ...params);
    },
    { timeout: 11 * 60_000, maxWait: 60_000 },
  );
}

/**
 * What a row holds, judged by its first bytes only: substring() reads just the start of a large value, where LIKE would
 * read — and decompress — the whole file to look at its first five characters.
 */
const textStarts = (col: string, prefix: string) => `substring(${col} from 1 for ${prefix.length}) = '${prefix}'`;
/** "\0DZBLOB\0" as Postgres bytea. */
const MAGIC_HEX = "\\x00445a424c4f4200";

export type ColumnCount = { model: string; column: string; inBox: number; inDatabase: number; databaseBytes: number };

/** How many of each column's files are in the box, and how many (and how many bytes) are still in the database. */
export async function fileColumnCounts(): Promise<ColumnCount[]> {
  const out: ColumnCount[] = [];
  for (const c of FILE_COLUMNS) {
    const col = q(c.column);
    const where =
      c.shape === "dataUrl"
        ? { box: textStarts(col, TEXT_REF), here: textStarts(col, "data:") }
        : { box: `substring(${col} from 1 for 8) = '${MAGIC_HEX}'::bytea`, here: `octet_length(${col}) > 0 AND substring(${col} from 1 for 8) <> '${MAGIC_HEX}'::bytea` };
    const [row] = await longQuery<{ inbox: bigint; here: bigint; bytes: bigint | null }[]>(
      `SELECT count(*) FILTER (WHERE ${where.box}) AS inbox, count(*) FILTER (WHERE ${where.here}) AS here, sum(octet_length(${col})) FILTER (WHERE ${where.here}) AS bytes FROM ${q(c.table)}`,
    );
    out.push({ model: c.model, column: c.column, inBox: Number(row?.inbox ?? 0), inDatabase: Number(row?.here ?? 0), databaseBytes: Number(row?.bytes ?? 0) });
  }
  return out;
}

export type MoveResult = { model: string; column: string; moved: number; skipped: number; failed: number; bytes: number; errors: string[] };

/**
 * One column's files still in the database, moved into the box a few rows at a time. Each row is written back only
 * if it still holds what was read — a file changed while it was being copied is left for the next run — and the
 * file is read back from the box before the row lets go of it. With `dryRun` nothing is written anywhere.
 */
export async function moveColumn(c: FileColumn, options: { dryRun: boolean; batch?: number; limit?: number }): Promise<MoveResult> {
  const result: MoveResult = { model: c.model, column: c.column, moved: 0, skipped: 0, failed: 0, bytes: 0, errors: [] };
  const batch = options.batch ?? 10;
  const col = q(c.column);
  const id = q(c.id);
  const type = c.typeColumn ? `, ${q(c.typeColumn)} AS type` : ", NULL AS type";
  const pending = c.shape === "dataUrl" ? textStarts(col, "data:") : `octet_length(${col}) > 0 AND substring(${col} from 1 for 8) <> '${MAGIC_HEX}'::bytea`;
  let after = "";
  for (;;) {
    if (options.limit !== undefined && result.moved + result.failed >= options.limit) break;
    const rows = await longQuery<{ id: string; value: string | Uint8Array; type: string | null }[]>(
      `SELECT ${id} AS id, ${col} AS value${type} FROM ${q(c.table)} WHERE ${pending} AND ${id} > $1 ORDER BY ${id} LIMIT ${batch}`,
      after,
    );
    if (rows.length === 0) break;
    for (const row of rows) {
      after = row.id;
      const size = typeof row.value === "string" ? row.value.length : row.value.byteLength;
      if (options.dryRun) {
        result.moved += 1;
        result.bytes += size;
        continue;
      }
      try {
        // Counted already, where it was: moving it is neither new storage nor refused at the limit.
        const next = c.shape === "dataUrl" ? await keepDataUrl(c.kind, row.value as string, { counted: false }) : await keepBytes(c.kind, row.value as Uint8Array, row.type || "application/octet-stream", { counted: false });
        if (!storedRef(next)) {
          // A data URL that doesn't parse, or no box: left as it is.
          result.skipped += 1;
          continue;
        }
        const before = createHash("md5").update(typeof row.value === "string" ? Buffer.from(row.value, "utf8") : Buffer.from(row.value)).digest("hex");
        const changed = await db.$executeRawUnsafe(
          `UPDATE ${q(c.table)} SET ${col} = $1 WHERE ${id} = $2 AND md5(${c.shape === "dataUrl" ? `convert_to(${col}, 'UTF8')` : col}) = $3`,
          next,
          row.id,
          before,
        );
        if (changed === 1) {
          result.moved += 1;
          result.bytes += size;
        } else result.skipped += 1;
      } catch (err) {
        result.failed += 1;
        if (result.errors.length < 5) result.errors.push(`${row.id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  return result;
}

/** Every key the workspace's rows point at in the box. */
export async function referencedKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  for (const c of FILE_COLUMNS) {
    const col = q(c.column);
    const sql =
      c.shape === "dataUrl"
        ? `SELECT substring(${col} from 1 for 400) AS value FROM ${q(c.table)} WHERE ${textStarts(col, TEXT_REF)}`
        : `SELECT substring(${col} from 1 for 400) AS value FROM ${q(c.table)} WHERE substring(${col} from 1 for 8) = '${MAGIC_HEX}'::bytea`;
    const rows = await longQuery<{ value: string | Uint8Array }[]>(sql);
    for (const r of rows) {
      const ref = storedRef(r.value);
      if (ref) keys.add(ref.key);
    }
  }
  return keys;
}

/**
 * How long a file nobody points at is kept: longer than backups are, so a workspace restored from its oldest backup
 * still finds every file that backup points at. 45 days at least.
 */
export async function sweepGraceDays(): Promise<number> {
  const setup = await offsiteSetup().catch(() => null);
  return Math.max(45, (setup?.backupKeepDays ?? 35) + 10);
}

export type SweepResult = { checked: number; removed: number; kept: number; graceDays: number };

/** The workspace's files in the box that no row has pointed at for longer than the grace, deleted. */
export async function sweepStoredFiles(now = new Date()): Promise<SweepResult | null> {
  const box = (await storageBox());
  if (!box) return null;
  const tenant = await currentTenant();
  const files = workspaceBox(box, tenant.id, "files");
  const graceDays = await sweepGraceDays();
  const cutoff = now.getTime() - graceDays * 86_400_000;
  // Listed before the rows are read: a file written after the listing can't be taken for an orphan.
  const { objects } = await files.list("");
  const referenced = await referencedKeys();
  const result: SweepResult = { checked: objects.length, removed: 0, kept: 0, graceDays };
  for (const o of objects) {
    if (referenced.has(o.key)) continue;
    if (!o.modified || o.modified.getTime() > cutoff) {
      result.kept += 1;
      continue;
    }
    try {
      await files.remove(o.key);
      result.removed += 1;
    } catch (err) {
      if (err instanceof KeptByStore) result.kept += 1;
      else throw err;
    }
  }
  return result;
}
