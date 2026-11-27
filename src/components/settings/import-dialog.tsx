"use client";

import { useRef, useState, useTransition, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Upload, AlertTriangle, Check, FileDown, X } from "lucide-react";
import { importTemplate } from "@/actions/data-import";
import { csvRow } from "@/lib/csv";
import { UPLOAD_GONE } from "@/lib/portability/upload-gone";
import type { ImportPlan } from "@/lib/portability/import";
import type { ActionResult } from "@/actions/company";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";

/**
 * Pick a file, see exactly what would happen, then decide.
 *
 * The preview is the feature. Anybody can write a loop that reads a spreadsheet into a database;
 * what makes an import safe to hand to somebody is that they can see, before committing, which rows
 * are new, which existing records change, precisely what those changes are, and which rows are
 * unusable and why. The Import button stays out of reach until that has been looked at.
 */

const ACTION_TONE = {
  create: "green",
  update: "amber",
  skip: "default",
  error: "red",
} as const;

/** The rows a notice applies to — the first ten, and how many more. */
function rowList(lines: number[]): string {
  const more = lines.length > 10 ? ` and ${lines.length - 10} more` : "";
  return `${lines.length === 1 ? "Row" : "Rows"} ${lines.slice(0, 10).join(", ")}${more}.`;
}

type FailedRow = { line: number; error: string; row?: Record<string, string> };
type Applied = { created: number; updated: number; skipped: number; failed: FailedRow[] };

/**
 * A part of the file, and the token its rows are kept under after the first (src/lib/portability/upload-cache.ts).
 * Only an area's own import takes them; a dialog given its own calls sends the whole file at once.
 */
type Part = { filename: string; base64: string; from?: number; count?: number; upload?: string };

/**
 * The three calls behind the dialog. An area on the import screen uses src/actions/data-import.ts; the
 * payroll migration import passes its own (src/actions/payroll-import.ts), which only payroll may run.
 */
export type ImportActions = {
  preview: (file: Part) => Promise<ActionResult<ImportPlan & { upload?: string }>>;
  commit: (file: Part) => Promise<ActionResult<Applied & { processed?: number; totalRows?: number; upload?: string }>>;
  template: () => Promise<ActionResult<{ filename: string; csv: string }>>;
};

/**
 * Rows a request takes (owner, 30 Oct 2026: 13,979 leads went in with nothing on screen to say how many, or which
 * failed). Each is its own request, well inside Cloudflare's 100 seconds; importing writes, so it takes fewer.
 */
const PREVIEW_ROWS = 500;
const IMPORT_ROWS = 200;

/** Two windows of a preview as one. */
function mergePlans(a: ImportPlan | null, b: ImportPlan): ImportPlan {
  if (!a) return b;
  const notices = new Map(a.notices.map((n) => [n.text, { ...n, lines: [...n.lines] }]));
  for (const n of b.notices) {
    const seen = notices.get(n.text);
    if (seen) seen.lines.push(...n.lines);
    else notices.set(n.text, { ...n, lines: [...n.lines] });
  }
  return {
    ...a,
    creates: a.creates + b.creates,
    updates: a.updates + b.updates,
    skips: a.skips + b.skips,
    errors: a.errors + b.errors,
    rows: [...a.rows, ...b.rows],
    notices: [...notices.values()],
  };
}

/** The rows that failed, as a CSV to put right and import again: their own cells, then which row and why. */
function failedCsv(failed: FailedRow[]): string {
  const headings = [...new Set(failed.flatMap((f) => Object.keys(f.row ?? {})))];
  const lines = [csvRow([...headings, "Row in file", "Why it failed"])];
  for (const f of failed) lines.push(csvRow([...headings.map((h) => f.row?.[h] ?? ""), f.line, f.error]));
  return lines.join("\n") + "\n";
}

/** A server action takes 6 MB, and a file grows by a third as base64: what a file sent to one may be. */
const ACTION_FILE_BYTES = 4 * 1024 * 1024;
/** What src/actions/data-import.ts takes, by its route. */
const ROUTE_FILE_BYTES = 25 * 1024 * 1024;

async function viaRoute<T>(mode: "preview" | "commit", area: string, file: Part): Promise<ActionResult<T>> {
  try {
    const res = await fetch("/api/data-import", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mode, area, ...file }) });
    const body = (await res.json().catch(() => null)) as ActionResult<T> | null;
    return body ?? { ok: false, error: `The import didn't go through (${res.status}). Try again.` };
  } catch {
    return { ok: false, error: "The import didn't go through — check the connection and try again." };
  }
}

export function ImportDialog({
  areaKey,
  areaLabel,
  actions,
  buttonLabel = "Import",
  title,
  intro,
}: {
  areaKey: string;
  areaLabel: string;
  actions?: ImportActions;
  buttonLabel?: string;
  title?: string;
  /** Said above the file picker, before the usual line about nothing being written yet. */
  intro?: ReactNode;
}) {
  // An area's own import goes by the route, which takes a file a server action can't (src/app/api/data-import).
  const calls: ImportActions = actions ?? {
    preview: (file) => viaRoute("preview", areaKey, file),
    commit: (file) => viaRoute("commit", areaKey, file),
    template: () => importTemplate(areaKey),
  };
  // What the file may be before it is sent: the route's limit, or what a server action takes once encoded.
  const maxBytes = actions ? ACTION_FILE_BYTES : ROUTE_FILE_BYTES;
  const router = useRouter();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();

  const [file, setFile] = useState<{ name: string; base64: string } | null>(null);
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<(Applied & { total: number; stoppedAt?: number }) | null>(null);
  /** Rows checked or imported so far, out of the file's — shown while a large file goes a window at a time. */
  const [progress, setProgress] = useState<{ what: "Checking" | "Importing"; done: number; total: number } | null>(null);
  // The kept file's token, after the first window (src/lib/portability/upload-cache.ts).
  const upload = useRef<string | undefined>(undefined);
  // Windows only for an area's own import; a dialog given its own calls sends the whole file at once.
  const windowed = !actions;

  const reset = () => {
    setFile(null);
    setPlan(null);
    setError(null);
    setDone(null);
    setProgress(null);
    upload.current = undefined;
  };

  /** One call for a window: the token once there is one, the file again if it has gone. */
  async function send<T extends { upload?: string }>(call: (part: Part) => Promise<ActionResult<T>>, f: { name: string; base64: string }, window?: { from: number; count: number }) {
    const part = { filename: f.name, ...(window ?? {}) };
    let result = await call(upload.current ? { ...part, base64: "", upload: upload.current } : { ...part, base64: f.base64 });
    if (!result.ok && result.error === UPLOAD_GONE) result = await call({ ...part, base64: f.base64 });
    if (result.ok && result.data.upload) upload.current = result.data.upload;
    return result;
  }

  const choose = (f: File) => {
    reset();
    if (f.size > maxBytes) {
      setError(`That file is over ${Math.floor(maxBytes / 1024 / 1024)} MB. Split it and import in batches.`);
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(",")[1] ?? "";
      const picked = { name: f.name, base64 };
      setFile(picked);
      startTransition(async () => {
        let merged: ImportPlan | null = null;
        for (let from = 0; ; from += PREVIEW_ROWS) {
          const result = await send(calls.preview, picked, windowed ? { from, count: PREVIEW_ROWS } : undefined);
          if (!result.ok) {
            setProgress(null);
            setError(result.error);
            return;
          }
          merged = mergePlans(merged, result.data);
          if (!windowed || from + PREVIEW_ROWS >= merged.totalRows) break;
          setProgress({ what: "Checking", done: from + PREVIEW_ROWS, total: merged.totalRows });
        }
        setProgress(null);
        setPlan(merged);
      });
    };
    reader.onerror = () => setError("That file couldn't be read.");
    reader.readAsDataURL(f);
  };

  const commit = () => {
    if (!file || !plan) return;
    setError(null);
    const total = plan.totalRows;
    startTransition(async () => {
      const sum: Applied = { created: 0, updated: 0, skipped: 0, failed: [] };
      let stoppedAt: number | undefined;
      for (let from = 0; ; from += IMPORT_ROWS) {
        setProgress({ what: "Importing", done: Math.min(from, total), total });
        const result = await send(calls.commit, file, windowed ? { from, count: IMPORT_ROWS } : undefined);
        if (!result.ok) {
          // What went in stays in; the same file again matches it rather than making it twice.
          setError(`${result.error} Stopped at row ${from + 2}.`);
          stoppedAt = from + 2;
          break;
        }
        sum.created += result.data.created;
        sum.updated += result.data.updated;
        sum.skipped += result.data.skipped;
        sum.failed.push(...result.data.failed);
        if (!windowed || result.data.processed === undefined || from + IMPORT_ROWS >= total) break;
      }
      setProgress(null);
      setDone({ ...sum, total, stoppedAt });
      setPlan(null);
      router.refresh();
    });
  };

  const template = () => {
    startTransition(async () => {
      const result = await calls.template();
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const url = URL.createObjectURL(new Blob([result.data.csv], { type: "text/csv" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.data.filename;
      link.click();
      URL.revokeObjectURL(url);
    });
  };

  const changed = plan?.rows.filter((r) => r.action !== "skip") ?? [];

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        <Upload className="h-3.5 w-3.5" />
        {buttonLabel}
      </Button>

      <Dialog
        open={open}
        onClose={() => {
          setOpen(false);
          reset();
        }}
        title={title ?? `Import ${areaLabel.toLowerCase()}`}
      >
        <div className="max-h-[70vh] space-y-4 overflow-y-auto pr-1">
          {error && <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>}

          {progress ? (
            // A large file goes a window at a time: how far it has got, said as it goes.
            <div className="space-y-2 py-2">
              <p className="text-sm font-medium text-text">
                {progress.what} rows… {progress.done.toLocaleString("en-IN")} of {progress.total.toLocaleString("en-IN")}
              </p>
              <div className="h-2 overflow-hidden rounded-full bg-surface-sunken">
                <div className="h-full bg-brand transition-all" style={{ width: `${Math.round((progress.done / Math.max(progress.total, 1)) * 100)}%` }} />
              </div>
              <p className="text-xs text-subtle">Keep this open until it finishes.</p>
            </div>
          ) : done ? (
            <div className="space-y-3">
              <p className="flex items-center gap-2 text-sm font-medium text-success">
                <Check className="h-4 w-4" />
                {(done.created + done.updated).toLocaleString("en-IN")} imported of {done.total.toLocaleString("en-IN")} row(s)
              </p>
              <div className="flex flex-wrap gap-2 text-sm">
                <Badge tone="green">{done.created.toLocaleString("en-IN")} new</Badge>
                <Badge tone="amber">{done.updated.toLocaleString("en-IN")} updated</Badge>
                <Badge tone="default">{done.skipped.toLocaleString("en-IN")} already there</Badge>
                <Badge tone={done.failed.length ? "red" : "default"}>{done.failed.length.toLocaleString("en-IN")} failed</Badge>
                {done.stoppedAt !== undefined && (
                  <Badge tone="red">{Math.max(0, done.total - (done.stoppedAt - 2)).toLocaleString("en-IN")} not reached</Badge>
                )}
              </div>
              {done.stoppedAt !== undefined && (
                <p className="text-xs text-danger">
                  It stopped at row {done.stoppedAt}. Import the same file again to carry on — rows already in are matched, not
                  made twice.
                </p>
              )}
              {done.failed.length > 0 && (
                <Card className="border-danger/40 bg-danger-bg px-3 py-2">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-sm font-medium text-danger">{done.failed.length.toLocaleString("en-IN")} row(s) could not be imported</p>
                    <Button
                      size="sm"
                      variant="secondary"
                      onClick={() => {
                        const url = URL.createObjectURL(new Blob([failedCsv(done.failed)], { type: "text/csv" }));
                        const link = document.createElement("a");
                        link.href = url;
                        link.download = `${(file?.name ?? areaKey).replace(/\.(csv|xlsx)$/i, "")}-failed-rows.csv`;
                        link.click();
                        URL.revokeObjectURL(url);
                      }}
                    >
                      <FileDown className="h-3.5 w-3.5" />
                      Download the failed rows
                    </Button>
                  </div>
                  <ul className="mt-1.5 max-h-60 space-y-0.5 overflow-y-auto text-xs text-danger">
                    {done.failed.map((f) => (
                      <li key={f.line}>
                        Row {f.line}
                        {f.row ? ` — ${f.row["Title"] || f.row["Company"] || f.row["Name"] || f.row["Contact"] || ""}` : ""}: {f.error}
                      </li>
                    ))}
                  </ul>
                  <p className="mt-1.5 text-xs text-danger">
                    The rest went in. Fix these in the downloaded file and import it — it holds only these rows, with why
                    each failed in its last column.
                  </p>
                </Card>
              )}
              <Button
                size="sm"
                onClick={() => {
                  setOpen(false);
                  reset();
                }}
              >
                Done
              </Button>
            </div>
          ) : !plan ? (
            <div className="space-y-3">
              {intro}
              <p className="text-sm text-muted">
                A CSV or Excel file. Nothing is written until you have seen what it would do.
              </p>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="secondary" disabled={isPending} onClick={() => fileRef.current?.click()}>
                  <Upload className="h-3.5 w-3.5" />
                  {isPending ? "Reading…" : "Choose a file"}
                </Button>
                <Button size="sm" variant="ghost" disabled={isPending} onClick={template}>
                  <FileDown className="h-3.5 w-3.5" />
                  Download the template
                </Button>
              </div>
              <p className="text-xs text-subtle">
                A file exported from here can be edited and handed straight back — the cover sheet is ignored.
                Records are matched on their key, so importing the same file twice changes nothing the second time.
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              <div className="flex flex-wrap items-center gap-2 text-sm">
                <Badge tone="green">{plan.creates} new</Badge>
                <Badge tone="amber">{plan.updates} changed</Badge>
                <Badge tone="default">{plan.skips} already match</Badge>
                {plan.errors > 0 && <Badge tone="red">{plan.errors} unusable</Badge>}
                <span className="text-muted">from {plan.totalRows} rows in {file?.name}</span>
              </div>

              {plan.readAs.length > 0 && (
                <p className="rounded-md bg-surface-sunken px-3 py-2 text-xs text-muted">
                  Read {plan.readAs.map((r) => `“${r.from}” as ${r.to}`).join(", ")}.
                </p>
              )}

              {plan.unknownColumns.length > 0 && (
                <p className="flex items-start gap-1.5 rounded-md bg-warning-bg px-3 py-2 text-xs text-warning">
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    Ignoring columns this import doesn&rsquo;t recognise: {plan.unknownColumns.join(", ")}. If one of
                    those holds data you wanted, the headings may not match the template.
                  </span>
                </p>
              )}

              {/* What some rows held that is left as it is, and why — said rather than dropped. */}
              {plan.notices.map((n) => (
                <p
                  key={n.text}
                  className={`flex items-start gap-1.5 rounded-md px-3 py-2 text-xs ${n.tone === "danger" ? "bg-danger-bg font-medium text-danger" : "bg-warning-bg text-warning"}`}
                >
                  <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                  <span>
                    {n.text} {rowList(n.lines)}
                  </span>
                </p>
              ))}

              {changed.length === 0 ? (
                <p className="rounded-md bg-surface-sunken px-3 py-4 text-center text-sm text-subtle">
                  Every row already matches what is stored. Importing would change nothing.
                </p>
              ) : (
                <div className="max-h-72 overflow-y-auto rounded-md border border-line">
                  <table className="w-full text-sm">
                    <thead className="sticky top-0 border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                      <tr>
                        <th className="px-3 py-2">Row</th>
                        <th className="px-3 py-2">What</th>
                        <th className="px-3 py-2">Record</th>
                        <th className="px-3 py-2">Changes</th>
                      </tr>
                    </thead>
                    <tbody>
                      {changed.slice(0, 200).map((r) => (
                        <tr key={r.line} className="border-b border-line last:border-0 align-top">
                          <td className="px-3 py-2 font-mono text-xs text-subtle">{r.line}</td>
                          <td className="px-3 py-2">
                            <Badge tone={ACTION_TONE[r.action]}>{r.action}</Badge>
                          </td>
                          <td className="px-3 py-2 text-text">{r.label || "—"}</td>
                          <td className="px-3 py-2 text-xs text-muted">
                            {r.error ? (
                              <span className="text-danger">{r.error}</span>
                            ) : (
                              r.changes.map((c) => (
                                <div key={c.field}>
                                  <span className="text-subtle">{c.field}:</span> {c.from} → <strong className="text-text">{c.to}</strong>
                                </div>
                              ))
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  {changed.length > 200 && (
                    <p className="border-t border-line px-3 py-1.5 text-xs text-subtle">
                      Showing the first 200 of {changed.length}. All of them will be imported.
                    </p>
                  )}
                </div>
              )}

              {plan.updates > 0 && (
                <p className="text-xs text-warning">
                  {plan.updates} existing record(s) will be overwritten with the values above. There is no undo.
                </p>
              )}

              <div className="flex gap-2">
                <Button size="sm" disabled={isPending || changed.length === 0 || plan.creates + plan.updates === 0} onClick={commit}>
                  {isPending ? "Importing…" : `Import ${plan.creates + plan.updates} row(s)`}
                </Button>
                <Button size="sm" variant="ghost" onClick={reset} disabled={isPending}>
                  <X className="h-3.5 w-3.5" />
                  Choose a different file
                </Button>
              </div>
            </div>
          )}
        </div>
      </Dialog>

      <input
        ref={fileRef}
        type="file"
        accept=".csv,.xlsx"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) choose(f);
          e.target.value = "";
        }}
      />
    </>
  );
}
