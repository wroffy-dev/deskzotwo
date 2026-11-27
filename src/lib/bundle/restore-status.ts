import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { DEFAULT_BACKUP_DIR } from "@/lib/backup/policy";

/**
 * A full restore's account of itself, on disk (Backup & Restore, part C — src/lib/bundle/restore.ts).
 *
 * A full restore replaces the control plane, so nothing about it can live there while it runs: the RestoreRun row the
 * console made is dropped with everything else, and the console's own pages read a database that is being rebuilt.
 * So, like a workspace restore's status (src/lib/backup/maintenance.ts), it is kept in files under BACKUP_DIR:
 *
 *   BACKUP_DIR/platform/restores/<run id>.json   the run: its state, step and log — written all the way through, and
 *                                                copied into the restored control plane's RestoreRun at the end
 *   BACKUP_DIR/platform/restores/active.json     only while one runs: which, and when its worker was last heard from.
 *                                                src/proxy.ts reads it on every request and, while it is there and
 *                                                fresh, answers the console with a plain status page and every other
 *                                                address with "being restored" — no database is asked anything.
 *
 * Read synchronously and never throwing, for the proxy: a folder that is missing or unreadable reads as "no restore".
 * What the status page is told is a fixed sentence per step (`publicRestoreStatus`) — never a workspace's name, a
 * log line or anything else from the backup: whoever opens the console's address may see it.
 */

export const RESTORE_HEARTBEAT_MS = 20_000;
/** A worker not heard from for this long has died: the proxy stops holding the application. */
export const RESTORE_STALE_AFTER_MS = 10 * 60_000;

export type FullRestoreStep = "checks" | "safety" | "control" | "settings" | "workspaces" | "finishing" | "rolling-back" | "done";
export type FullRestoreState = "running" | "succeeded" | "partial" | "failed" | "rolled-back";
export type RestoreLogLine = { at: string; step: string; message: string };

export type FullRestoreFile = {
  id: string;
  state: FullRestoreState;
  step: FullRestoreStep;
  startedAt: string;
  finishedAt: string | null;
  /** Workspaces restored so far, and how many the backup holds — the only numbers the status page shows. */
  done: number;
  total: number;
  log: RestoreLogLine[];
  error: string | null;
  safetyPath: string | null;
  outcomes: unknown;
  backupId: string | null;
  startedById: string | null;
};

export type ActiveRestore = {
  runId: string;
  startedAt: string;
  beatAt: string;
  held?: boolean;
};

export const platformRestoreDir = () => path.join(path.resolve(process.env.BACKUP_DIR?.trim() || DEFAULT_BACKUP_DIR), "platform", "restores");
export const runFilePath = (id: string) => path.join(platformRestoreDir(), `${id}.json`);
export const activeFilePath = () => path.join(platformRestoreDir(), "active.json");
export const validRunId = (id: unknown): id is string => typeof id === "string" && /^[A-Za-z0-9_-]{8,64}$/.test(id);

/**
 * The full restore running now, or null. A worker that has not written its heartbeat for RESTORE_STALE_AFTER_MS has
 * died, and stops holding the application — unless the restore failed so badly that it was left `held` on purpose
 * (the control plane could not be put back), when it holds until somebody removes the file.
 */
export function activeFullRestore(now = Date.now()): ActiveRestore | null {
  try {
    const file = activeFilePath();
    if (!existsSync(file)) return null;
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<ActiveRestore>;
    if (!validRunId(parsed.runId)) return null;
    const beat = Date.parse(parsed.beatAt ?? parsed.startedAt ?? "");
    if (!parsed.held && (!Number.isFinite(beat) || now - beat > RESTORE_STALE_AFTER_MS)) return null;
    return {
      runId: parsed.runId,
      startedAt: String(parsed.startedAt ?? ""),
      beatAt: String(parsed.beatAt ?? ""),
      held: parsed.held === true,
    };
  } catch {
    return null;
  }
}

export function readRunFileSync(id: string): FullRestoreFile | null {
  if (!validRunId(id)) return null;
  try {
    const parsed = JSON.parse(readFileSync(runFilePath(id), "utf8")) as FullRestoreFile;
    return parsed?.id === id ? parsed : null;
  } catch {
    return null;
  }
}

const STEP_WORDS: Record<FullRestoreStep, string> = {
  checks: "Checking the backup before anything is changed…",
  safety: "Taking a safety copy of this server's control plane…",
  control: "Replacing the control plane…",
  settings: "Keeping this server's own settings and clearing the old server's sessions…",
  workspaces: "Restoring workspaces…",
  finishing: "Finishing…",
  "rolling-back": "The restore failed — putting this server back as it was…",
  done: "Finished.",
};

export type PublicRestoreStatus = {
  running: boolean;
  state: FullRestoreState | "stopped" | "unknown";
  message: string;
  done: number;
  total: number;
};

/** What the status page may say about a run: its state in a fixed sentence and two counts. Nothing from the backup. */
export function publicRestoreStatus(id: string, now = Date.now()): PublicRestoreStatus {
  const run = readRunFileSync(id);
  if (!run)
    return {
      running: false,
      state: "unknown",
      message: "There is no such restore on this server.",
      done: 0,
      total: 0,
    };
  const active = activeFullRestore(now);
  const counts = { done: Number(run.done) || 0, total: Number(run.total) || 0 };
  if (run.state === "running") {
    if (active?.runId === id) {
      const words = run.step === "workspaces" && counts.total ? `Restoring workspaces — ${counts.done} of ${counts.total} done…` : (STEP_WORDS[run.step] ?? "Working…");
      return { running: true, state: "running", message: words, ...counts };
    }
    return {
      running: false,
      state: "stopped",
      message: "The restore stopped without finishing — the server restarted while it ran. Its log and the safety copy are on the server under BACKUP_DIR/platform; see docs/runbook.md §4.3.",
      ...counts,
    };
  }
  const final: Record<Exclude<FullRestoreState, "running">, string> = {
    succeeded: "Done — sign in with your staff account from the backup.",
    partial: "Done, but not every workspace could be restored — sign in with your staff account from the backup and open Backups › Restores for which, and why.",
    "rolled-back": "The restore failed, and this server was put back as it was before it started. Sign in as before and open Backups › Restores to see why.",
    failed: active?.held
      ? "The restore failed and this server could not be put back by itself. The application stays closed: see BACKUP_DIR/platform/restores on the server and docs/runbook.md §4.3."
      : "The restore failed before anything was changed. Sign in as before and open Backups › Restores to see why.",
  };
  return {
    running: !!active?.held && active.runId === id,
    state: run.state,
    message: final[run.state],
    ...counts,
  };
}

/**
 * The console's page while a full restore runs: a fixed page that polls `/restore-status?run=<id>` (answered by the
 * proxy from the run's file) and says when it is done. The run id is the only thing put in it.
 */
export function restoreStatusPage(runId: string): string {
  const id = validRunId(runId) ? runId : "";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Restore in progress</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; background:#f6f7f9; color:#15181d; }
  @media (prefers-color-scheme: dark) { body { background:#15181d; color:#e8eaed; } }
  main { max-width:34rem; padding:2rem; text-align:center; }
  h1 { font-size:1.25rem; margin:0 0 .75rem; }
  p { margin:0 0 .5rem; opacity:.85; }
  a { color:inherit; }
</style></head>
<body><main>
  <h1 id="h">Restore in progress</h1>
  <p>The whole application is being restored from a backup. The console and every workspace are closed until it finishes.</p>
  <p>When it is done, sign in with your staff account <strong>from the backup</strong> — the accounts on this server before the restore are replaced by the backup's.</p>
  <p><output id="s">Checking…</output></p>
  <p id="go" hidden><a href="/">Go to sign in</a></p>
  <script>
    var run = ${JSON.stringify(id)};
    async function tick() {
      try {
        var r = await fetch('/restore-status?run=' + encodeURIComponent(run), { cache: 'no-store' });
        var d = await r.json();
        document.getElementById('s').textContent = d.message || 'Working…';
        if (!d.running) { document.getElementById('h').textContent = 'Restore finished'; document.getElementById('go').hidden = false; return; }
      } catch (e) { document.getElementById('s').textContent = 'Working…'; }
      setTimeout(tick, 3000);
    }
    tick();
  </script>
</main></body></html>`;
}

/** What every other address answers while the whole application is being restored. */
export const RESTORING_EVERYTHING_PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex">
<title>Being restored — please wait</title>
<style>
  :root { color-scheme: light dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.6 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; background:#f6f7f9; color:#15181d; }
  @media (prefers-color-scheme: dark) { body { background:#15181d; color:#e8eaed; } }
  main { max-width:32rem; padding:2rem; text-align:center; }
  h1 { font-size:1.25rem; margin:0 0 .75rem; }
  p { margin:0; opacity:.8; }
</style></head>
<body><main>
  <h1>Being restored from a backup</h1>
  <p>This service is unavailable while it is restored. Please try again in a little while.</p>
</main></body></html>`;
