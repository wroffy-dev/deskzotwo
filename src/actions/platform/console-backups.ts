"use server";

import { rm } from "node:fs/promises";
import type { StaffRole } from "@deskzo/control-client";
import type { ConsoleResult } from "@/actions/platform/console";
import { passphraseProblem } from "@/lib/backup/archive-format";
import { bundleFileName } from "@/lib/bundle/build";
import { bundlePassphraseOpens, readBundleHeader } from "@/lib/bundle/format";
import { auditTenantId, bundlePath, downloadName, estimateBundle, handPassphrase, settleBackups, startWorker, takePassphrase, type BundleEstimate } from "@/lib/bundle/jobs";
import { cleanStaleUploads } from "@/lib/bundle/upload";
import { compatibilityOf, headerSummary, sizeText, type Compatibility } from "@/lib/console-shared/backups";
import { serverFacts } from "@/lib/bundle/console-data";
import { FULL_CONFIRMATION, RestoreRefused, abandonFullRestore, openFullRestore, quickChecks, recordRefusal, type RestoreMode } from "@/lib/bundle/restore";
import { MANAGERS, OWNERS, consoleAudit, consoleRefusal, revalidateConsole } from "@/lib/platform/console-guard";
import { controlConfigured, controlDb } from "@/lib/platform/control-db";
import { ConsoleRefused } from "@/lib/platform/refused";
import { StaffRefused, currentStaffSession, requireStaff, type Staff } from "@/lib/platform/staff-session";
import { STEP_UP_WINDOW_MS, recentStepUp, recordStepUp, tellOtherOwners } from "@/lib/platform/step-up";
import { tenantBySlug } from "@/lib/tenancy/registry";
import type { Tenant } from "@/lib/tenancy/state";

/**
 * The console's Backups page (owner, 26 Nov 2026 — src/lib/bundle): bundles of the whole installation or one
 * workspace, made on this server, downloaded, uploaded, checked and deleted.
 *
 *   See the page             owners and admins (PAGE_ROLES.backups)
 *   New backup, Verify,      owners only — a bundle is everything the installation holds, under a passphrase the
 *   Delete, Download,        owner chooses; a download or a restore also asks for a fresh authenticator code
 *   Upload, Restore          (step-up), and every other owner is told. A restore (src/lib/bundle/restore.ts) is
 *                            confirmed by typing the workspace's slug, or RESTORE EVERYTHING
 *
 * The passphrase is typed twice in the browser, checked here, and handed to the detached worker sealed in a file of
 * its own (src/lib/bundle/jobs.ts) — never on a row, in the audit log, in a log line, or on a command line.
 */

async function asStaff<T>(roles: readonly StaffRole[], work: (staff: Staff) => Promise<T>): Promise<ConsoleResult<T>> {
  let staff: Staff;
  try {
    staff = await requireStaff(roles);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  try {
    if (!controlConfigured()) throw new ConsoleRefused("This server has no control plane, so the console can't keep backups.");
    return { ok: true, data: await work(staff) };
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
}

export type BackupInput = { kind?: unknown; workspace?: unknown; passphrase?: unknown; confirm?: unknown };

type Target = { kind: "full" | "workspace"; tenant: Tenant | null };

async function targetOf(input: BackupInput): Promise<Target> {
  if (input?.kind === "full") return { kind: "full", tenant: null };
  if (input?.kind !== "workspace") throw new ConsoleRefused("Choose the full application or one workspace.");
  const slug = typeof input.workspace === "string" ? input.workspace.trim().toLowerCase() : "";
  if (!slug) throw new ConsoleRefused("Choose the workspace to back up.");
  const tenant = await tenantBySlug(slug);
  if (!tenant) throw new ConsoleRefused(`There is no workspace "${slug.slice(0, 64)}".`);
  if (tenant.status === "DEPROVISIONED") throw new ConsoleRefused(`${tenant.slug} is closed; there is nothing of it to put in a backup.`);
  return { kind: "workspace", tenant };
}

const refuseSpace = (e: BundleEstimate) =>
  new ConsoleRefused(
    `Not started — it needs about ${sizeText(e.bytes)} and the disk where backups are made has ${sizeText(e.free)} free. Make room in BACKUP_DIR (or give the server more disk), then try again.`,
  );

/** What a backup would come to, against the disk's free space — shown before it is started. */
export async function consolePreviewBackup(input: BackupInput): Promise<ConsoleResult<BundleEstimate>> {
  return asStaff(OWNERS, async () => {
    const target = await targetOf(input ?? {});
    return estimateBundle(target.kind, target.tenant);
  });
}

/**
 * Starts a backup: its row (RUNNING), its passphrase sealed for the worker, the worker. One at a time for the same
 * kind and workspace; refused, with the numbers, when the disk hasn't room for it.
 */
export async function consoleCreateBackup(input: BackupInput): Promise<ConsoleResult<{ id: string }>> {
  return asStaff(OWNERS, async (staff) => {
    const target = await targetOf(input ?? {});
    const passphrase = typeof input?.passphrase === "string" ? input.passphrase : "";
    const problem = passphraseProblem(passphrase);
    if (problem) throw new ConsoleRefused(problem);
    if (input?.confirm !== passphrase) throw new ConsoleRefused("The two passphrases are not the same — type it again in both fields.");

    // A build whose worker died stops holding the way.
    await settleBackups(new Date(), cleanStaleUploads);
    const estimate = await estimateBundle(target.kind, target.tenant);
    if (!estimate.fits) throw refuseSpace(estimate);

    const kind = target.kind === "full" ? "FULL" : "WORKSPACE";
    const tenantId = target.tenant?.id ?? null;
    const now = new Date();
    const row = await controlDb().$transaction(async (tx) => {
      // Two owners pressing at once: the second waits here, then finds the first's row.
      await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext($1))`, `platform-backup:${kind}:${tenantId ?? "-"}`);
      const running = await tx.platformBackup.findFirst({ where: { kind, tenantId, status: "RUNNING", source: "CREATED" }, select: { id: true } });
      if (running) throw new ConsoleRefused(target.tenant ? `A backup of ${target.tenant.slug} is already being made — wait for it to finish.` : "A full backup is already being made — wait for it to finish.");
      return tx.platformBackup.create({
        data: {
          kind,
          tenantId,
          tenantSlug: target.tenant?.slug ?? null,
          status: "RUNNING",
          source: "CREATED",
          fileName: bundleFileName(target.kind, target.tenant?.slug ?? null, now),
          startedById: staff.id,
          startedAt: now,
          progress: { entry: null, entryBytes: 0, bytes: 0, entries: 0, entriesTotal: null, expectedBytes: estimate.bytes, at: now.toISOString() },
        },
        select: { id: true },
      });
    });

    try {
      await handPassphrase(row.id, "build", passphrase);
      startWorker("build", row.id);
    } catch (err) {
      await takePassphrase(row.id, "build").catch(() => null);
      await controlDb().platformBackup.update({ where: { id: row.id }, data: { status: "FAILED", finishedAt: new Date(), error: `The worker could not be started: ${err instanceof Error ? err.message : String(err)}` } });
      throw new ConsoleRefused("The backup could not be started — the worker didn't start. Nothing was made.");
    }
    await consoleAudit(staff, "backup.create", { backupId: row.id, kind, workspace: target.tenant?.slug ?? null, estimateBytes: estimate.bytes }, tenantId);
    revalidateConsole();
    return { id: row.id };
  });
}

/**
 * Reads a READY bundle through with its passphrase, in the worker (minutes for a big one), and writes the answer on
 * its row. A passphrase that doesn't open it is refused here at once, from the header's verifier.
 */
export async function consoleVerifyBackup(id: unknown, passphrase: unknown): Promise<ConsoleResult<null>> {
  return asStaff(OWNERS, async (staff) => {
    const row = await findRow(id);
    if (row.status !== "READY") throw new ConsoleRefused("Only a backup that is ready can be verified.");
    const file = bundlePath(row.fileName);
    const header = file ? await readBundleHeader(file).catch(() => null) : null;
    if (!header) throw new ConsoleRefused("Its file is no longer on the server, or can't be read as a backup.");
    const typed = typeof passphrase === "string" ? passphrase : "";
    if (!typed || !bundlePassphraseOpens(header, typed)) throw new ConsoleRefused("That passphrase doesn't open this backup.");

    const progress = { state: "running", startedAt: new Date().toISOString(), at: new Date().toISOString(), bytes: 0, total: row.sizeBytes === null ? null : Number(row.sizeBytes), by: staff.id };
    const claimed = await controlDb().$executeRawUnsafe(
      `UPDATE "platform_backups" SET "verifyProgress" = $2::jsonb WHERE id = $1 AND status = 'READY' AND ("verifyProgress" IS NULL OR "verifyProgress"->>'state' <> 'running')`,
      row.id,
      JSON.stringify(progress),
    );
    if (!claimed) throw new ConsoleRefused("It is being verified already — wait for that to finish.");
    try {
      await handPassphrase(row.id, "verify", typed);
      startWorker("verify", row.id);
    } catch (err) {
      await takePassphrase(row.id, "verify").catch(() => null);
      await controlDb().platformBackup.update({ where: { id: row.id }, data: { verifyProgress: { ...progress, state: "failed", error: `The worker could not be started: ${err instanceof Error ? err.message : String(err)}` } } });
      throw new ConsoleRefused("The check could not be started — the worker didn't start.");
    }
    await consoleAudit(staff, "backup.verify", { backupId: row.id, kind: row.kind, workspace: row.tenantSlug }, await auditTenantId(row.tenantId));
    revalidateConsole();
    return null;
  });
}

/** Removes a backup's file and marks it DELETED. Not while it is being made or read. */
export async function consoleDeleteBackup(id: unknown): Promise<ConsoleResult<null>> {
  return asStaff(OWNERS, async (staff) => {
    const row = await findRow(id);
    if (row.status === "RUNNING") throw new ConsoleRefused("It is still being made. Wait for it to finish or fail, then delete it.");
    if (row.status === "DELETED") throw new ConsoleRefused("It is deleted already.");
    if ((row.verifyProgress as { state?: string } | null)?.state === "running") throw new ConsoleRefused("It is being verified. Wait for that to finish, then delete it.");
    const file = bundlePath(row.fileName);
    if (file) await rm(file, { force: true });
    await controlDb().platformBackup.update({ where: { id: row.id }, data: { status: "DELETED" } });
    await consoleAudit(staff, "backup.delete", { backupId: row.id, kind: row.kind, workspace: row.tenantSlug, was: row.status, sizeBytes: row.sizeBytes === null ? null : Number(row.sizeBytes) }, await auditTenantId(row.tenantId));
    revalidateConsole();
    return null;
  });
}

/**
 * A fresh authenticator code for downloading backups: checked once, and good on this console session for ten minutes
 * (src/lib/platform/step-up.ts `recentStepUp`, which the download route asks).
 */
export async function consoleBackupStepUp(code: unknown): Promise<ConsoleResult<{ until: string }>> {
  return asStaff(OWNERS, async (staff) => {
    const session = await currentStaffSession();
    if (!session) throw new StaffRefused("Sign in to the console.");
    const at = await recordStepUp(staff, session.sessionId, code);
    return { until: new Date(at.getTime() + STEP_UP_WINDOW_MS).toISOString() };
  });
}

async function findRow(id: unknown) {
  const key = typeof id === "string" ? id.trim() : "";
  const row = /^[A-Za-z0-9_-]{8,64}$/.test(key) ? await controlDb().platformBackup.findUnique({ where: { id: key } }) : null;
  if (!row) throw new ConsoleRefused("That backup no longer exists.");
  return row;
}

// ─── Restore (Backup & Restore, part C — src/lib/bundle/restore.ts) ──────────────────────────────

export type RestorePlan = {
  backupId: string;
  kind: "full" | "workspace";
  mode: RestoreMode;
  /** The workspace, for a workspace backup. */
  workspace: { id: string; slug: string; name: string } | null;
  createdAt: string;
  compat: Compatibility;
  /** What will happen, in order, in plain words. */
  steps: string[];
  /** Said prominently before anything: a full restore onto a server that holds workspaces, say. */
  warning: string | null;
  /** What must be typed to confirm it. */
  confirmText: string;
};

function restoreSteps(mode: RestoreMode, slug: string, createdAt: string): string[] {
  const when = createdAt ? createdAt.slice(0, 16).replace("T", " ") + " UTC" : "when it was made";
  if (mode === "IN_PLACE") {
    return [
      `The backup is read through once more and checked; if anything about it is wrong, nothing is changed.`,
      `${slug} is closed to its users — they see a maintenance page — until the restore finishes.`,
      `A safety copy of ${slug} as it is now is taken and kept 30 days, with its plan and billing records saved beside it. Without a safety copy, nothing is restored.`,
      `Its database is replaced by the backup's (from ${when}) and brought up to this version. Everybody signs in again.`,
      `Its files from the backup are written back. Files added since the backup are kept.`,
      `If the backup was made under other keys for ${slug}, those keys are installed — the restored data needs them.`,
      `Its plan, billing and settings records on this server are left as they are, unless you tick the option below.`,
      `If anything fails after the safety copy, ${slug} is put back exactly as it was, by itself.`,
    ];
  }
  if (mode === "AS_NEW") {
    return [
      `The backup is read through once more and checked; if its address name or a domain is taken here, nothing is changed.`,
      `A new database is made for ${slug} on this server and the backup's database (from ${when}) put in it, brought up to this version.`,
      `Its records — the workspace, its plans, subscription, invoices and domains — are added to this server's control plane. Plans and partners this server has already are used as they are.`,
      `Its files are written into this server's storage box.`,
      `If anything fails, everything it added is taken away again.`,
    ];
  }
  return [
    `The backup is read through once more and checked; if anything about it is wrong, nothing is changed.`,
    `A safety copy of this server's control plane is taken.`,
    `The control plane — staff, plans, settings, billing, partners, every workspace's record — is replaced by the backup's. Your session ends here: afterwards you sign in with a staff account from the backup.`,
    `This server's storage box and off-site settings are kept; the old server's sign-ins, job leases and warm databases are cleared.`,
    `Every workspace in the backup gets a new database on this server, with its files. One that can't be restored is left suspended and the others carry on.`,
    `The reference data (PIN codes and places) is loaded again from its source.`,
    `If it fails before any workspace is restored, this server is put back as it was.`,
  ];
}

async function restoreTarget(row: Awaited<ReturnType<typeof findRow>>) {
  if (row.status !== "READY") throw new ConsoleRefused("Only a backup that is ready can be restored.");
  const file = bundlePath(row.fileName);
  const header = file ? await readBundleHeader(file).catch(() => null) : null;
  if (!file || !header) throw new ConsoleRefused("Its file is no longer on the server, or can't be read as a backup — upload it again.");
  return { file, header };
}

/** What restoring a backup would do here — the wizard's first page. Nothing is checked that needs the passphrase. */
export async function consoleRestorePlan(id: unknown): Promise<ConsoleResult<RestorePlan>> {
  return asStaff(OWNERS, async () => {
    const row = await findRow(id);
    const { header } = await restoreTarget(row);
    const summary = headerSummary(header);
    if (!summary) throw new ConsoleRefused("Its header can't be read.");
    const facts = await serverFacts();
    const compat = compatibilityOf(summary, facts);
    const kind = header.kind;
    const ws = kind === "workspace" ? (header.workspaces[0] ?? null) : null;
    const mode: RestoreMode = kind === "full" ? "FULL" : ws && facts.workspaces[ws.id] ? "IN_PLACE" : "AS_NEW";
    const existing = Object.values(facts.workspaces).filter((w) => w.status !== "DEPROVISIONED");
    const warning =
      mode === "FULL" && existing.length
        ? `This server is not a fresh install: it has ${existing.length} workspace${existing.length === 1 ? "" : "s"} (${existing
            .slice(0, 8)
            .map((w) => w.slug)
            .join(
              ", ",
            )}${existing.length > 8 ? "…" : ""}). Their databases are left untouched, but after the restore the console is the backup's and they are no longer in it. A safety copy of this control plane is taken first.`
        : mode === "IN_PLACE"
          ? `${ws!.slug} on this server is replaced by the backup's — everything changed in it since ${summary.createdAt.slice(0, 10)} is lost, except in the safety copy.`
          : null;
    return {
      backupId: row.id,
      kind,
      mode,
      workspace: ws ? { id: ws.id, slug: ws.slug, name: ws.name } : null,
      createdAt: summary.createdAt,
      compat,
      steps: restoreSteps(mode, ws?.slug ?? "the workspace", summary.createdAt),
      warning,
      confirmText: mode === "FULL" ? FULL_CONFIRMATION : ws!.slug,
    };
  });
}

export type RestoreInput = {
  backupId?: unknown;
  passphrase?: unknown;
  confirm?: unknown;
  putBackControlRows?: unknown;
};

/**
 * Starts a restore (owners, with a fresh authenticator code given in the last ten minutes, the confirmation typed): the
 * quick checks here — a refusal is said at once and recorded as a RestoreRun FAILED, nothing changed — then its run
 * (RUNNING), its passphrase sealed for the worker, the worker. A full restore closes the application at once: every
 * page after this one is the "Restore in progress" page until it has finished.
 */
export async function consoleStartRestore(input: RestoreInput): Promise<ConsoleResult<{ runId: string; full: boolean }>> {
  let staff: Staff;
  try {
    staff = await requireStaff(MANAGERS);
  } catch (err) {
    if (err instanceof StaffRefused) return { ok: false, error: err.message };
    throw err;
  }
  if (!controlConfigured())
    return {
      ok: false,
      error: "This server has no control plane, so the console can't restore backups.",
    };
  let row: Awaited<ReturnType<typeof findRow>>;
  try {
    row = await findRow(input?.backupId);
  } catch (err) {
    const refusal = consoleRefusal(err);
    if (refusal !== null) return { ok: false, error: refusal };
    throw err;
  }
  const kind = row.kind === "FULL" ? "FULL" : "WORKSPACE";
  const refuse = async (message: string): Promise<ConsoleResult<{ runId: string; full: boolean }>> => {
    await recordRefusal({
      kind,
      tenantId: row.tenantId,
      tenantSlug: row.tenantSlug,
      backupId: row.id,
      startedById: staff.id,
      message,
    });
    revalidateConsole();
    return { ok: false, error: message };
  };
  if (staff.role !== "OWNER") return refuse("Only an owner can restore a backup. Nothing has been changed.");
  const session = await currentStaffSession();
  if (!session || !(await recentStepUp(session.sessionId))) return refuse("Give a fresh code from your authenticator first — a restore needs one from the last ten minutes. Nothing has been changed.");

  let target: Awaited<ReturnType<typeof restoreTarget>>;
  try {
    target = await restoreTarget(row);
  } catch (err) {
    return refuse(err instanceof Error ? err.message : String(err));
  }
  const ws = target.header.kind === "workspace" ? (target.header.workspaces[0] ?? null) : null;
  const expected = target.header.kind === "full" ? FULL_CONFIRMATION : (ws?.slug ?? "");
  const typed = typeof input?.confirm === "string" ? input.confirm.trim() : "";
  if (!expected || typed !== expected) return refuse(`The confirmation doesn't match — type ${expected || "the workspace's address name"} exactly. Nothing has been changed.`);
  const passphrase = typeof input?.passphrase === "string" ? input.passphrase : "";
  const source = {
    file: target.file,
    backupId: row.id,
    expectedSha256: row.sha256,
    label: downloadName(row),
  };
  let quick: Awaited<ReturnType<typeof quickChecks>>;
  try {
    quick = await quickChecks(target.header.kind, source, passphrase, null);
  } catch (err) {
    if (err instanceof RestoreRefused) return refuse(err.message);
    throw err;
  }
  const putBackControlRows = quick.mode === "IN_PLACE" && input?.putBackControlRows === true;

  const now = new Date();
  // Two owners pressing at once: the second waits here, then finds the first's run (a dead one, unheard from for ten
  // minutes, doesn't count).
  const busy = await controlDb().$transaction(async (tx) => {
    await tx.$executeRawUnsafe(`SELECT pg_advisory_xact_lock(hashtext('platform-restore'))`);
    const running = await tx.restoreRun.findMany({
      where: {
        status: "RUNNING",
        beatAt: { gt: new Date(Date.now() - 10 * 60_000) },
      },
      select: { kind: true, tenantId: true, tenantSlug: true },
    });
    const clash = running.find((r) => r.kind === "FULL" || kind === "FULL" || r.tenantId === quick.tenantId);
    if (clash)
      return clash.kind === "FULL" ? "A restore of the whole application is running — wait for it to finish." : `A restore of ${clash.tenantSlug ?? "a workspace"} is running — wait for it to finish.`;
    return tx.restoreRun.create({
      data: {
        kind,
        tenantId: quick.tenantId,
        tenantSlug: quick.slug,
        backupId: row.id,
        status: "RUNNING",
        mode: quick.mode,
        log: [
          {
            at: now.toISOString(),
            step: "start",
            message: `Started by ${staff.name} (${staff.email}).`,
          },
        ],
        startedById: staff.id,
        startedAt: now,
        beatAt: now,
        outcomes: quick.mode === "FULL" ? undefined : { options: { putBackControlRows } },
      },
      select: { id: true },
    });
  });
  if (typeof busy === "string") return refuse(`${busy} Nothing has been changed.`);
  const run = busy;
  const full = quick.mode === "FULL";
  await consoleAudit(
    staff,
    "backup.restore",
    {
      backupId: row.id,
      restoreRunId: run.id,
      mode: quick.mode,
      workspace: quick.slug,
      putBackControlRows,
    },
    await auditTenantId(quick.tenantId),
  );
  if (full || quick.mode === "IN_PLACE") {
    await tellOtherOwners(
      staff,
      full ? "Started a restore of the whole application from a backup — the control plane and every workspace will be replaced." : `Started a restore of the workspace ${quick.slug} from a backup.`,
    );
  }
  try {
    if (full) await openFullRestore(run.id, row.id, staff.id);
    await handPassphrase(run.id, "restore", passphrase);
    startWorker("restore", run.id, full ? (why) => abandonFullRestore(run.id, why) : undefined);
  } catch (err) {
    await takePassphrase(run.id, "restore").catch(() => null);
    if (full) await abandonFullRestore(run.id, "The worker could not be started.");
    await controlDb().restoreRun.update({
      where: { id: run.id },
      data: {
        status: "FAILED",
        finishedAt: new Date(),
        error: `The worker could not be started: ${err instanceof Error ? err.message : String(err)}`,
      },
    });
    return {
      ok: false,
      error: "The restore could not be started — the worker didn't start. Nothing has been changed.",
    };
  }
  revalidateConsole();
  return { ok: true, data: { runId: run.id, full } };
}

export type RestoreRunView = {
  id: string;
  status: "RUNNING" | "SUCCEEDED" | "FAILED" | "ROLLED_BACK";
  mode: string | null;
  error: string | null;
  finishedAt: string | null;
  safetyPath: string | null;
  log: { at: string | null; step: string | null; message: string }[];
};

/** One restore's progress, for the wizard's live log. Owners and admins. */
export async function consoleRestoreRun(id: unknown): Promise<ConsoleResult<RestoreRunView>> {
  return asStaff(MANAGERS, async () => {
    const key = typeof id === "string" ? id.trim() : "";
    const run = /^[A-Za-z0-9_-]{8,64}$/.test(key) ? await controlDb().restoreRun.findUnique({ where: { id: key } }) : null;
    if (!run) throw new ConsoleRefused("That restore isn't on this server.");
    const log = Array.isArray(run.log)
      ? (run.log as Record<string, unknown>[]).map((l) => ({
          at: typeof l?.at === "string" ? l.at : null,
          step: typeof l?.step === "string" ? l.step : null,
          message: typeof l?.message === "string" ? l.message : "",
        }))
      : [];
    return {
      id: run.id,
      status: run.status,
      mode: run.mode,
      error: run.error,
      finishedAt: run.finishedAt?.toISOString() ?? null,
      safetyPath: run.safetyPath,
      log,
    };
  });
}
