import { readdirSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { bundlePath, downloadName } from "@/lib/bundle/jobs";
import { compatibilityOf, headerSummary, type Compatibility, type HeaderSummary, type ServerFacts } from "@/lib/console-shared/backups";
import { staffNameMap } from "@/lib/platform/console-guard";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { platformKeyFingerprint } from "@/lib/platform/kek";
import { workspaceMigrationNames } from "@/lib/platform/schema-info";
import { tenantsForBackup } from "@/lib/tenancy/registry";

/**
 * What the console's Backups page shows (src/app/platform-console/(console)/backups): every bundle built here or
 * uploaded, with its progress while it is made, whether its file is still on the server, its Verify result and the
 * compatibility report; and the restores. Nothing secret: the rows hold none, the header is cut down to what may be
 * shown (`headerSummary` — never its KDF, verifier or nonce), and the passphrase is never anywhere to read.
 */

/** The control plane's migrations this code carries, oldest first — spelled out, so the build traces one folder. */
function controlMigrationNames(): string[] {
  try {
    return readdirSync(path.join(process.cwd(), "prisma", "control", "migrations"), { withFileTypes: true })
      .filter((e) => e.isDirectory() && /^\d{14}_/.test(e.name))
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

async function appVersion(): Promise<string | null> {
  try {
    return (JSON.parse(await readFile(path.join(process.cwd(), "package.json"), "utf8")) as { version?: string }).version ?? null;
  } catch {
    return null;
  }
}

/** This server, as the compatibility report compares a bundle with it. */
export async function serverFacts(): Promise<ServerFacts> {
  const tenants = controlConfigured() ? await controlDb().tenant.findMany({ select: { id: true, slug: true, status: true } }) : [];
  return {
    keyFingerprint: platformKeyFingerprint(),
    controlMigrations: controlMigrationNames(),
    workspaceMigrations: workspaceMigrationNames(),
    workspaces: Object.fromEntries(tenants.map((t) => [t.id, { slug: t.slug, status: t.status }])),
    appVersion: await appVersion(),
  };
}

export type BackupProgress = { entry: string | null; bytes: number; entries: number; entriesTotal: number | null; expectedBytes: number | null; at: string | null };
export type VerifyState = { state: "running" | "done" | "failed" | "stopped"; bytes: number; total: number | null; at: string | null; error: string | null; by: string | null };

export type BackupRow = {
  id: string;
  kind: "FULL" | "WORKSPACE";
  tenantSlug: string | null;
  source: "CREATED" | "UPLOADED";
  status: "RUNNING" | "READY" | "FAILED" | "EXPIRED" | "DELETED";
  fileName: string;
  downloadName: string;
  sizeBytes: number | null;
  sha256: string | null;
  by: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  expiresAt: Date | null;
  error: string | null;
  progress: BackupProgress | null;
  filePresent: boolean;
  header: HeaderSummary | null;
  compat: Compatibility | null;
  verify: VerifyState | null;
  verifiedAt: Date | null;
  verifyOk: boolean | null;
  verifyProblems: string[];
};

export type RestoreLogLine = { at: string | null; step: string | null; message: string };
export type RestoreRow = {
  id: string;
  kind: "FULL" | "WORKSPACE";
  tenantSlug: string | null;
  backupId: string | null;
  /** The backup it was restored from, by its download name — when its record is still here. */
  backupName: string | null;
  /** IN_PLACE, AS_NEW or FULL (src/lib/bundle/restore.ts); null for a refusal made before it was decided. */
  mode: string | null;
  /** The safety copy taken first: its file on this server. */
  safetyPath: string | null;
  safetyBackupId: string | null;
  /** A full restore's workspaces that couldn't be restored, and this server's earlier ones left untouched. */
  notRestored: string[];
  untouched: string[];
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "ROLLED_BACK";
  by: string | null;
  startedAt: Date;
  finishedAt: Date | null;
  error: string | null;
  log: RestoreLogLine[];
};

export type BackupsFilters = { kind: "FULL" | "WORKSPACE" | null; workspace: string | null };

export type BackupsBoard = {
  asOf: Date;
  rows: BackupRow[];
  restores: RestoreRow[];
  /** Workspaces a backup may be made of (not closed), for the picker. */
  workspaces: { id: string; slug: string; name: string; status: string }[];
  /** Something is being made, checked or restored: the page refreshes itself. */
  live: boolean;
};

const ROWS = 200;
const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : null);
const str = (v: unknown) => (typeof v === "string" ? v : null);

export function parseBackupsFilters(sp: Record<string, string | string[] | undefined>): BackupsFilters {
  const one = (k: string) => {
    const v = sp[k];
    return typeof v === "string" ? v.trim() : Array.isArray(v) ? (v[0] ?? "").trim() : "";
  };
  const kind = one("kind").toUpperCase();
  const workspace = one("workspace").toLowerCase();
  return { kind: kind === "FULL" || kind === "WORKSPACE" ? kind : null, workspace: /^[a-z0-9][a-z0-9-]{0,62}$/.test(workspace) ? workspace : null };
}

export async function backupsBoard(filters: BackupsFilters): Promise<BackupsBoard> {
  const control = controlDb();
  const asOf = new Date();
  const [records, runs, tenants, facts] = await Promise.all([
    control.platformBackup.findMany({
      where: { ...(filters.kind ? { kind: filters.kind } : {}), ...(filters.workspace ? { tenantSlug: filters.workspace } : {}) },
      orderBy: { startedAt: "desc" },
      take: ROWS,
    }),
    control.restoreRun.findMany({ where: filters.workspace ? { tenantSlug: filters.workspace } : {}, orderBy: { startedAt: "desc" }, take: 50 }),
    tenantsForBackup(),
    serverFacts(),
  ]);
  const names = await staffNameMap([...records.map((r) => r.startedById ?? ""), ...runs.map((r) => r.startedById ?? "")].filter(Boolean));

  const rows: BackupRow[] = [];
  for (const r of records) {
    const file = bundlePath(r.fileName);
    const filePresent = r.status === "READY" && !!file && !!(await stat(file).catch(() => null))?.isFile();
    const header = headerSummary(r.header);
    const p = r.progress as Record<string, unknown> | null;
    const v = r.verifyProgress as Record<string, unknown> | null;
    rows.push({
      id: r.id,
      kind: r.kind,
      tenantSlug: r.tenantSlug,
      source: r.source,
      status: r.status,
      fileName: r.fileName,
      downloadName: downloadName(r),
      sizeBytes: r.sizeBytes === null ? null : Number(r.sizeBytes),
      sha256: r.sha256,
      by: r.startedById ? (names.get(r.startedById) ?? "A former staff member") : null,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      expiresAt: r.expiresAt,
      error: r.error,
      progress: p ? { entry: str(p.entry), bytes: num(p.bytes) ?? 0, entries: num(p.entries) ?? 0, entriesTotal: num(p.entriesTotal), expectedBytes: num(p.expectedBytes), at: str(p.at) } : null,
      filePresent,
      header,
      compat: header ? compatibilityOf(header, facts) : null,
      verify:
        v && (v.state === "running" || v.state === "done" || v.state === "failed" || v.state === "stopped")
          ? { state: v.state, bytes: num(v.bytes) ?? 0, total: num(v.total), at: str(v.at), error: str(v.error), by: str(v.by) ? (names.get(String(v.by)) ?? null) : null }
          : null,
      verifiedAt: r.verifiedAt,
      verifyOk: r.verifyOk,
      verifyProblems: Array.isArray(r.verifyProblems) ? (r.verifyProblems as unknown[]).map(String) : [],
    });
  }

  const backupNames = new Map(records.map((b) => [b.id, downloadName(b)]));
  const missing = runs.map((r) => r.backupId).filter((id): id is string => !!id && !backupNames.has(id));
  if (missing.length) for (const b of await control.platformBackup.findMany({ where: { id: { in: missing } } })) backupNames.set(b.id, downloadName(b));
  const restores: RestoreRow[] = runs.map((r) => ({
    id: r.id,
    kind: r.kind,
    tenantSlug: r.tenantSlug,
    backupId: r.backupId,
    backupName: r.backupId ? (backupNames.get(r.backupId) ?? null) : null,
    mode: r.mode,
    safetyPath: r.safetyPath,
    safetyBackupId: r.safetyBackupId,
    notRestored: ((r.outcomes as { workspaces?: { slug?: string; ok?: boolean; error?: string | null }[] } | null)?.workspaces ?? []).filter((w) => !w.ok).map((w) => `${w.slug}${w.error ? ` — ${w.error}` : ""}`),
    untouched: ((r.outcomes as { untouched?: { slug?: string; database?: string | null }[] } | null)?.untouched ?? []).map((u) => `${u.slug} (${u.database ?? "no database"})`),
    status: r.status,
    by: r.startedById ? (names.get(r.startedById) ?? "A former staff member") : null,
    startedAt: r.startedAt,
    finishedAt: r.finishedAt,
    error: r.error,
    log: Array.isArray(r.log)
      ? (r.log as unknown[]).map((line) => {
          const l = (line ?? {}) as Record<string, unknown>;
          return { at: str(l.at), step: str(l.step), message: str(l.message) ?? JSON.stringify(line) };
        })
      : [],
  }));

  return {
    asOf,
    rows,
    restores,
    workspaces: tenants.map((t) => ({ id: t.id, slug: t.slug, name: t.name, status: t.status })),
    live: rows.some((r) => r.status === "RUNNING" || r.verify?.state === "running") || restores.some((r) => r.status === "RUNNING"),
  };
}

/** How many bundles name this workspace — Workspace 360's link to them. */
export async function backupCountFor(tenantId: string): Promise<number> {
  if (!controlConfigured()) return 0;
  return controlDb()
    .platformBackup.count({ where: { tenantId } })
    .catch(() => 0);
}
