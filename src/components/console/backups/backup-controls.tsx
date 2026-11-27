"use client";

import { useEffect, useId, useState } from "react";
import { Archive, ArchiveRestore, Download, ShieldCheck, Trash2 } from "lucide-react";
import {
  consoleBackupStepUp,
  consoleCreateBackup,
  consoleDeleteBackup,
  consolePreviewBackup,
  consoleRestorePlan,
  consoleRestoreRun,
  consoleStartRestore,
  consoleVerifyBackup,
  type RestorePlan,
  type RestoreRunView,
} from "@/actions/platform/console-backups";
import { StatusPill } from "@/components/console/kit/status";
import { ConfirmBody, ConfirmDialog } from "@/components/console/kit/confirm-dialog";
import { StepUpCodeField } from "@/components/console/kit/step-up-code";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { MIN_PASSPHRASE_LENGTH, passphraseProblem } from "@/lib/backup/archive-format";
import { RESTORE_STATUS, sizeText } from "@/lib/console-shared/backups";
import type { Tone } from "@/lib/console-shared/types";

/**
 * The owner's controls on the console's Backups page (src/actions/platform/console-backups.ts checks every one again):
 * a new backup, and each backup's Download, Verify and Delete. Admins see the page without them.
 */

type Estimate = { bytes: number; free: number; fits: boolean; parts: { label: string; bytes: number }[] };

// ─── New backup ──────────────────────────────────────────────────────────────────────────────────

export function NewBackupButton({ workspaces, initialWorkspace }: { workspaces: { slug: string; name: string; status: string }[]; initialWorkspace?: string | null }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button type="button" size="sm" onClick={() => setOpen(true)}>
        <Archive aria-hidden="true" className="h-4 w-4" />
        New backup
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="New backup">
        {open && <NewBackupForm workspaces={workspaces} initialWorkspace={initialWorkspace ?? null} onDone={() => setOpen(false)} />}
      </Dialog>
    </>
  );
}

function NewBackupForm({ workspaces, initialWorkspace, onDone }: { workspaces: { slug: string; name: string; status: string }[]; initialWorkspace: string | null; onDone: () => void }) {
  const id = useId();
  const { pending, error, run } = useConsoleAction<{ id: string }>();
  const [kind, setKind] = useState<"full" | "workspace">(initialWorkspace ? "workspace" : "full");
  const [workspace, setWorkspace] = useState(initialWorkspace ?? "");
  const [passphrase, setPassphrase] = useState("");
  const [confirm, setConfirm] = useState("");
  // The size against the disk, worked out again whenever what is backed up changes — kept with what it was for, so a
  // choice changed meanwhile shows "working out" rather than the last one's numbers.
  const target = kind === "full" ? "full" : `workspace:${workspace}`;
  const [answer, setAnswer] = useState<{ target: string; estimate: Estimate | null; error: string | null } | null>(null);
  useEffect(() => {
    let live = true;
    if (kind === "workspace" && !workspace) return;
    consolePreviewBackup({ kind, workspace }).then(
      (r) => live && setAnswer({ target, estimate: r.ok ? r.data : null, error: r.ok ? null : r.error }),
      () => live && setAnswer({ target, estimate: null, error: "The size couldn't be worked out just now." }),
    );
    return () => {
      live = false;
    };
  }, [kind, workspace, target]);
  const estimate = answer?.target === target ? answer.estimate : null;
  const estimateError = answer?.target === target ? answer.error : null;

  const problem = passphrase ? passphraseProblem(passphrase) : null;
  const mismatch = confirm.length > 0 && confirm !== passphrase;
  const ready = !!passphrase && !problem && confirm === passphrase && (kind === "full" || !!workspace) && estimate?.fits !== false;

  return (
    <ConfirmBody
      confirmLabel="Start backup"
      pending={pending}
      error={error}
      confirmDisabled={!ready}
      onCancel={onDone}
      onConfirm={() =>
        run(() => consoleCreateBackup({ kind, workspace, passphrase, confirm }), {
          success: "Backup started. It is made in the background — this page shows its progress.",
          onDone,
        })
      }
    >
      <fieldset className="space-y-2">
        <legend className="text-xs font-medium text-text">What to back up</legend>
        <label className="flex items-start gap-2">
          <input type="radio" name={`${id}-kind`} checked={kind === "full"} onChange={() => setKind("full")} disabled={pending} className="mt-1" />
          <span>
            <span className="block font-medium">Full application</span>
            <span className="block text-xs text-muted">The control plane and every workspace that isn&apos;t closed — for bringing the whole installation up on another server.</span>
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name={`${id}-kind`} checked={kind === "workspace"} onChange={() => setKind("workspace")} disabled={pending} className="mt-1" />
          <span>
            <span className="block font-medium">One workspace</span>
            <span className="block text-xs text-muted">Its database, its files and its records in the control plane.</span>
          </span>
        </label>
        {kind === "workspace" && (
          <div className="space-y-1 pl-6">
            <Label htmlFor={`${id}-ws`}>Workspace</Label>
            <SearchSelect id={`${id}-ws`} value={workspace} onChange={(e) => setWorkspace(e.target.value)} disabled={pending} searchPlaceholder="Search workspaces…" className="w-full">
              <option value="">Choose a workspace</option>
              {workspaces.map((w) => (
                <option key={w.slug} value={w.slug}>
                  {`${w.name} (${w.slug})${w.status === "ACTIVE" ? "" : ` — ${w.status.toLowerCase()}`}`}
                </option>
              ))}
            </SearchSelect>
          </div>
        )}
      </fieldset>

      <div className="space-y-1.5">
        <Label htmlFor={`${id}-pass`}>Passphrase</Label>
        <Input id={`${id}-pass`} type="password" autoComplete="new-password" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} disabled={pending} />
        <p className={problem ? "text-xs text-danger" : "text-xs text-muted"}>{problem ?? `At least ${MIN_PASSPHRASE_LENGTH} characters. A few words are easier to keep than one hard one.`}</p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor={`${id}-confirm`}>Type it again</Label>
        <Input id={`${id}-confirm`} type="password" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} disabled={pending} aria-invalid={mismatch || undefined} />
        {mismatch && <p className="text-xs text-danger">The two passphrases are not the same.</p>}
      </div>
      <p className="rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-xs text-text">
        Keep the passphrase somewhere safe. Without it — and without this server&apos;s PLATFORM_MASTER_KEY, which is never put in a backup — this backup
        can&apos;t be opened, by anybody. Nobody at Deskzo can recover it.
      </p>

      <div className="text-xs">
        {estimateError ? (
          <p className="text-danger">{estimateError}</p>
        ) : !estimate ? (
          <p className="text-muted">{kind === "workspace" && !workspace ? "Choose a workspace to see its size." : "Working out its size…"}</p>
        ) : estimate.fits ? (
          <p className="text-muted">{`About ${sizeText(estimate.bytes)} at most; the disk has ${sizeText(estimate.free)} free. The file is kept on the server for a day to be downloaded.`}</p>
        ) : (
          <p className="text-danger">{`It needs about ${sizeText(estimate.bytes)} and the disk has ${sizeText(estimate.free)} free — make room before starting it.`}</p>
        )}
      </div>
    </ConfirmBody>
  );
}

// ─── A backup's own controls ─────────────────────────────────────────────────────────────────────

/** Until when this tab's owner gave a fresh code; the server decides, this only saves asking twice in a row. */
let steppedUpUntil = 0;

function startDownload(id: string) {
  const a = document.createElement("a");
  a.href = `/backup-files/${encodeURIComponent(id)}`;
  a.rel = "noopener";
  a.setAttribute("download", "");
  document.body.appendChild(a);
  a.click();
  a.remove();
}

export function BackupRowActions({ row }: { row: { id: string; status: string; filePresent: boolean; verifying: boolean; label: string } }) {
  const [dialog, setDialog] = useState<"download" | "verify" | "delete" | "restore" | null>(null);
  const close = () => setDialog(null);
  const ready = row.status === "READY" && row.filePresent;
  return (
    <div className="flex flex-wrap justify-end gap-1.5">
      {ready && (
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={() => {
            if (Date.now() < steppedUpUntil) startDownload(row.id);
            else setDialog("download");
          }}
        >
          <Download aria-hidden="true" className="h-4 w-4" />
          Download
        </Button>
      )}
      {ready && (
        <Button type="button" size="sm" variant="secondary" disabled={row.verifying} onClick={() => setDialog("verify")}>
          <ShieldCheck aria-hidden="true" className="h-4 w-4" />
          {row.verifying ? "Verifying…" : "Verify"}
        </Button>
      )}
      {ready && (
        <Button type="button" size="sm" variant="secondary" disabled={row.verifying} onClick={() => setDialog("restore")}>
          <ArchiveRestore aria-hidden="true" className="h-4 w-4" />
          Restore…
        </Button>
      )}
      {row.status !== "RUNNING" && row.status !== "DELETED" && (
        <Button type="button" size="sm" variant="ghost" disabled={row.verifying} onClick={() => setDialog("delete")} aria-label={`Delete ${row.label}`}>
          <Trash2 aria-hidden="true" className="h-4 w-4" />
        </Button>
      )}
      <Dialog open={dialog === "download"} onClose={close} title="Download backup">
        {dialog === "download" && <DownloadBody id={row.id} label={row.label} onDone={close} />}
      </Dialog>
      <Dialog open={dialog === "verify"} onClose={close} title="Verify backup">
        {dialog === "verify" && <VerifyBody id={row.id} onDone={close} />}
      </Dialog>
      <DeleteDialog open={dialog === "delete"} id={row.id} label={row.label} onClose={close} />
      <Dialog open={dialog === "restore"} onClose={close} title={`Restore — ${row.label}`}>
        {dialog === "restore" && <RestoreWizard id={row.id} onDone={close} />}
      </Dialog>
    </div>
  );
}

function DownloadBody({ id, label, onDone }: { id: string; label: string; onDone: () => void }) {
  const { pending, error, run } = useConsoleAction<{ until: string }>();
  const [code, setCode] = useState("");
  return (
    <ConfirmBody
      confirmLabel="Download"
      pending={pending}
      error={error}
      confirmDisabled={code.length !== 6}
      onCancel={onDone}
      onConfirm={() =>
        run(() => consoleBackupStepUp(code), {
          refresh: false,
          success: "Downloading — your browser shows its progress.",
          onDone: (data) => {
            steppedUpUntil = Date.parse(data.until) - 30_000;
            startDownload(id);
            onDone();
          },
        })
      }
    >
      <p>{`${label} — everything in it leaves the server, encrypted under its passphrase.`}</p>
      <StepUpCodeField value={code} onChange={setCode} disabled={pending} optionalNote="A fresh code — each one works once, and lets you download for ten minutes. Every other owner is told." />
    </ConfirmBody>
  );
}

function VerifyBody({ id, onDone }: { id: string; onDone: () => void }) {
  const fieldId = useId();
  const { pending, error, run } = useConsoleAction<null>();
  const [passphrase, setPassphrase] = useState("");
  return (
    <ConfirmBody
      confirmLabel="Verify"
      pending={pending}
      error={error}
      confirmDisabled={!passphrase}
      onCancel={onDone}
      onConfirm={() => run(() => consoleVerifyBackup(id, passphrase), { success: "Verifying — the whole file is read once; a large one takes minutes.", onDone })}
    >
      <p>Reads the whole file with its passphrase and checks every part of it, without changing anything. The answer appears on this page.</p>
      <div className="space-y-1.5">
        <Label htmlFor={fieldId}>Passphrase</Label>
        <Input id={fieldId} type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} disabled={pending} />
      </div>
    </ConfirmBody>
  );
}

function DeleteDialog({ open, id, label, onClose }: { open: boolean; id: string; label: string; onClose: () => void }) {
  const { pending, error, run } = useConsoleAction<null>();
  return (
    <ConfirmDialog
      open={open}
      onClose={onClose}
      title="Delete backup"
      confirmLabel="Delete"
      tone="danger"
      pending={pending}
      error={error}
      onConfirm={() => run(() => consoleDeleteBackup(id), { success: "Backup deleted.", onDone: onClose })}
    >
      <p>{`${label}: its file is removed from the server. A copy already downloaded is not affected.`}</p>
    </ConfirmDialog>
  );
}

// ─── Restore ─────────────────────────────────────────────────────────────────────────────────────

const MODE_WORDS: Record<RestorePlan["mode"], string> = {
  IN_PLACE: "Restore over the workspace on this server",
  AS_NEW: "Add it to this server as a new workspace",
  FULL: "Restore the whole application",
};

/**
 * The restore wizard (src/actions/platform/console-backups.ts checks everything again, and the worker again before it
 * changes anything): what the backup is against this server, exactly what will happen in order, the option, the
 * passphrase, a fresh authenticator code and the typed confirmation — then the run's log as it goes.
 */
function RestoreWizard({ id, onDone }: { id: string; onDone: () => void }) {
  const fieldId = useId();
  const [plan, setPlan] = useState<{
    plan: RestorePlan | null;
    error: string | null;
  } | null>(null);
  const [passphrase, setPassphrase] = useState("");
  const [code, setCode] = useState("");
  const [putBack, setPutBack] = useState(false);
  const [runId, setRunId] = useState<string | null>(null);
  const { pending, error, run } = useConsoleAction<{
    runId: string;
    full: boolean;
  }>();
  useEffect(() => {
    let live = true;
    consoleRestorePlan(id).then(
      (r) => live && setPlan(r.ok ? { plan: r.data, error: null } : { plan: null, error: r.error }),
      () =>
        live &&
        setPlan({
          plan: null,
          error: "What a restore would do couldn't be worked out just now.",
        }),
    );
    return () => {
      live = false;
    };
  }, [id]);

  if (runId) return <RestoreProgress runId={runId} onDone={onDone} />;
  if (!plan) return <p className="text-sm text-muted">Working out what a restore would do here…</p>;
  if (!plan.plan) return <p className="text-sm text-danger">{plan.error}</p>;
  const p = plan.plan;
  const blocked = p.compat.verdict === "blocked";

  return (
    <ConfirmBody
      confirmLabel={p.mode === "FULL" ? "Restore everything" : "Restore"}
      tone="danger"
      typed={p.confirmText}
      pending={pending}
      error={error}
      confirmDisabled={blocked || !passphrase || code.length !== 6}
      onCancel={onDone}
      onConfirm={({ typed }) =>
        run(
          async () => {
            // A restore always asks for a fresh code, whatever was given for a download a minute ago.
            const stepped = await consoleBackupStepUp(code);
            if (!stepped.ok) return stepped;
            steppedUpUntil = Date.parse(stepped.data.until) - 30_000;
            return consoleStartRestore({
              backupId: id,
              passphrase,
              confirm: typed,
              putBackControlRows: putBack,
            });
          },
          {
            refresh: false,
            success: (d) => (d.full ? "The restore has started. The console closes while it runs." : "The restore has started."),
            onDone: (d) => {
              // A full restore closes the console at once: the next page is the "Restore in progress" page.
              if (d.full) window.location.reload();
              else setRunId(d.runId);
            },
          },
        )
      }
    >
      <p className="font-medium">{MODE_WORDS[p.mode]}</p>
      {p.warning && <p className="rounded-base border border-danger/40 bg-danger-bg px-3 py-2 text-xs text-text">{p.warning}</p>}
      <div className="space-y-1">
        <p className="text-xs font-medium text-text">This backup on this server</p>
        <ul className="space-y-1 text-xs">
          {p.compat.lines.map((l) => (
            <li key={l.key} className="flex items-start gap-1.5">
              <StatusPill tone={l.tone as Tone}>{l.label}</StatusPill>
              <span className="text-text">{l.text}</span>
            </li>
          ))}
        </ul>
        {blocked && <p className="text-xs text-danger">It can&apos;t be restored here until what is marked above is put right.</p>}
      </div>
      <div className="space-y-1">
        <p className="text-xs font-medium text-text">What will happen, in this order</p>
        <ol className="list-decimal space-y-0.5 pl-5 text-xs text-text">
          {p.steps.map((step, i) => (
            <li key={i}>{step}</li>
          ))}
        </ol>
      </div>
      {p.mode === "IN_PLACE" && (
        <label className="flex items-start gap-2 text-xs">
          <input type="checkbox" checked={putBack} onChange={(e) => setPutBack(e.target.checked)} disabled={pending} className="mt-0.5" />
          <span>
            <span className="block font-medium text-text">Also put back its plan, billing and settings records from the backup</span>
            <span className="block text-muted">
              Off: this server&apos;s are kept — they are live here. On: the backup&apos;s are put back over them (nothing is duplicated; records added since are kept).
            </span>
          </span>
        </label>
      )}
      {p.mode === "FULL" && (
        <p className="text-xs text-text">
          When it starts, your session ends. Afterwards, sign in with a staff account <strong>from the backup</strong> — the staff on this server now are replaced by the backup&apos;s.
        </p>
      )}
      <div className="space-y-1.5">
        <Label htmlFor={fieldId}>Passphrase</Label>
        <Input id={fieldId} type="password" autoComplete="off" value={passphrase} onChange={(e) => setPassphrase(e.target.value)} disabled={pending} />
      </div>
      <StepUpCodeField value={code} onChange={setCode} disabled={pending} optionalNote="A fresh code — each one works once. Every other owner is told." />
    </ConfirmBody>
  );
}

const LOG_NEXT: Record<RestoreRunView["status"], string> = {
  RUNNING: "",
  SUCCEEDED: "Done. Everybody in the workspace signs in again.",
  ROLLED_BACK: "It failed and was put back as it was — nothing was lost. Read the reason above, put it right, and restore again.",
  FAILED: "It failed. Read the reason above: a refusal changed nothing; anything else says what is left and how to recover.",
};

/** A workspace restore's log, as it runs, read every two seconds until it has finished. */
function RestoreProgress({ runId, onDone }: { runId: string; onDone: () => void }) {
  const [view, setView] = useState<RestoreRunView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      const r = await consoleRestoreRun(runId).catch(() => null);
      if (!live) return;
      if (r?.ok) {
        setView(r.data);
        setProblem(null);
        if (r.data.status !== "RUNNING") return;
      } else setProblem(r && !r.ok ? r.error : "The restore's progress couldn't be read just now.");
      timer = setTimeout(tick, 2000);
    };
    void tick();
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [runId]);
  const s = view ? RESTORE_STATUS[view.status] : null;
  return (
    <div className="space-y-3 text-sm">
      <div className="flex items-center gap-2">
        {s ? (
          <StatusPill tone={s.tone} dot>
            {s.label}
          </StatusPill>
        ) : (
          <span className="text-muted">Starting…</span>
        )}
        {problem && <span className="text-xs text-warning">{problem}</span>}
      </div>
      <ol aria-live="polite" className="max-h-72 space-y-0.5 overflow-auto rounded-base border border-border p-2 font-mono text-[11px] text-text">
        {(view?.log ?? []).map((l, i) => (
          <li key={i}>
            {l.at ? <span className="text-muted">{`${l.at.slice(11, 19)} `}</span> : null}
            {l.message}
          </li>
        ))}
      </ol>
      {view && view.status !== "RUNNING" && (
        <div className="space-y-1 text-xs">
          {view.error && <p className="whitespace-pre-line text-danger">{view.error}</p>}
          <p className="text-text">{LOG_NEXT[view.status]}</p>
          {view.safetyPath && <p className="text-muted">{`Safety copy: ${view.safetyPath}`}</p>}
        </div>
      )}
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="secondary" onClick={onDone}>
          {view && view.status !== "RUNNING" ? "Close" : "Close — it carries on"}
        </Button>
      </div>
    </div>
  );
}
