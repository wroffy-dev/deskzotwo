"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { AlertTriangle, CheckCircle2, ChevronDown, ChevronRight, Download, FileUp, Loader2, RotateCcw, Trash2, Undo2 } from "lucide-react";
import {
  analyseLegacyImport,
  discardLegacyDraft,
  legacyErrorReport,
  removeLegacyFile,
  resumeLegacyImport,
  setLegacyFileKind,
  setLegacyFileMapping,
  startLegacyImport,
  stepLegacyImport,
  undoLegacyImport,
} from "@/actions/legacy-import";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { IconButton } from "@/components/ui/icon-button";
import { Input, Label, Select } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import type { Analysis, KindReport } from "@/lib/legacy-import/analyse";
import { COUNTED_MASTER, countedKind, KINDS, kindDef, STRATEGIES, type KindKey, type StrategyKey } from "@/lib/legacy-import/formats";
import type { FileSummary } from "@/lib/legacy-import/store";
import { LegacyMasterLists } from "./legacy-master-lists";
import { confirmAction } from "@/components/ui/confirm";

type HistoryRun = {
  id: string;
  status: string;
  strategy: string | null;
  createdAt: string;
  finishedAt: string | null;
  undoneAt: string | null;
  records: number;
  errors: number;
  progress: Record<string, unknown>;
};

type Counts = { created: number; updated: number; linked: number; unchanged: number; skipped: number; failed: number };

const n = (v: number) => v.toLocaleString("en-IN");
const when = (iso: string | null) => (iso ? new Date(iso).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" }) : "—");

function download(filename: string, text: string) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/csv;charset=utf-8" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * The old CRM migration, start to finish (src/lib/legacy-import): upload, check what each file was taken for and
 * which heading each column comes from, preview, decide, confirm, watch it run, and see — or undo — what it did.
 */
/** An upload's limit, and the part a big file is sent in — the server's own (src/lib/legacy-import/files.ts UPLOAD_LIMITS). */
const MAX_UPLOAD = 250 * 1024 * 1024;
const PART = 38 * 1024 * 1024;

export function LegacyImportWizard({ draft, analysis, runningId, history, masterCounts }: { draft: { id: string; files: FileSummary[] } | null; analysis: Analysis | null; runningId: string | null; history: HistoryRun[]; masterCounts: Record<string, Record<string, number>> }) {
  return (
    <div className="mt-5 space-y-5">
      {runningId && <RunningImport importId={runningId} />}
      {!runningId && <Draft draft={draft} analysis={analysis} masterCounts={masterCounts} earlier={history.filter((h) => h.status === "DONE" || h.status === "FAILED")} />}
      {history.length > 0 && <History runs={history} busy={!!runningId} />}
    </div>
  );
}

// ─── 1–6: the draft ──────────────────────────────────────────────────────────────────────────────

function Draft({ draft, analysis, earlier, masterCounts }: { draft: { id: string; files: FileSummary[] } | null; analysis: Analysis | null; earlier: HistoryRun[]; masterCounts: Record<string, Record<string, number>> }) {
  const zoho = !!draft?.files.some((f) => kindDef(f.kind)?.source === "zoho");
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [sending, setSending] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);

  /**
   * A file at a time; one over the part size in parts (src/lib/legacy-import/parts.ts) — Cloudflare, in front of
   * Deskzo, refuses a request over 100 MB — each part sent after the one before has landed.
   */
  const send = async (form: FormData) => {
    const res = await fetch("/api/legacy-import/upload", { method: "POST", body: form });
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new Error(body.error ?? "The upload didn't go through.");
  };
  const upload = async (list: FileList | null) => {
    if (!list || list.length === 0) return;
    setError(null);
    const files = Array.from(list);
    const total = files.reduce((t, f) => t + f.size, 0);
    if (total > MAX_UPLOAD) {
      setError(`That's ${Math.round(total / 1024 / 1024)} MB — upload at most ${MAX_UPLOAD / 1024 / 1024} MB at a time, in more than one go.`);
      return;
    }
    setUploading(true);
    try {
      for (const file of files) {
        if (file.size <= PART) {
          setSending(`Sending ${file.name}…`);
          const form = new FormData();
          form.append("files", file);
          await send(form);
          continue;
        }
        const parts = Math.ceil(file.size / PART);
        const uploadId = crypto.randomUUID();
        for (let i = 0; i < parts; i++) {
          setSending(`Sending ${file.name}: part ${i + 1} of ${parts}…`);
          const form = new FormData();
          form.append("uploadId", uploadId);
          form.append("part", String(i));
          form.append("parts", String(parts));
          form.append("name", file.name);
          form.append("size", String(file.size));
          form.append("chunk", file.slice(i * PART, (i + 1) * PART), file.name);
          await send(form);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "The upload didn't go through.");
    } finally {
      setUploading(false);
      setSending(null);
      if (input.current) input.current.value = "";
      router.refresh();
    }
  };

  const act = (work: () => Promise<{ ok: true } | { ok: false; error: string }>) =>
    start(async () => {
      setError(null);
      const r = await work();
      if (!r.ok) setError(r.error);
      router.refresh();
    });

  return (
    <>
      <Card className="p-4">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="text-sm font-medium text-text">1 · Upload the old CRM&apos;s export</h2>
            <p className="mt-0.5 text-xs text-muted">A ZIP of its CSV files, or the CSV files themselves — as many uploads as it takes. A file uploaded again replaces the one of the same name.</p>
          </div>
          {/* Start over: throws the draft away — its files, the table and heading choices, the master lists and the
              preview — so the next upload begins a fresh one. Imports already run stay; each has its own Undo. */}
          {draft && draft.files.length > 0 && (
            <Button
              type="button"
              size="sm"
              variant="secondary"
              disabled={pending || uploading}
              onClick={async () =>
                (await confirmAction("Start over? The uploaded files, what each was taken for, the master lists and the preview are all thrown away. Nothing imported so far is touched.")) &&
                act(() => discardLegacyDraft(draft.id))
              }
            >
              <RotateCcw className="mr-1.5 h-3.5 w-3.5" aria-hidden />
              Start over
            </Button>
          )}
        </div>
        <div
          className="mt-3 flex flex-col items-center justify-center gap-2 rounded-base border border-dashed border-line-strong bg-surface-sunken px-4 py-6 text-center"
          onDragOver={(e) => e.preventDefault()}
          onDrop={(e) => {
            e.preventDefault();
            void upload(e.dataTransfer.files);
          }}
        >
          {uploading ? <Loader2 className="h-5 w-5 animate-spin text-muted" /> : <FileUp className="h-5 w-5 text-muted" />}
          <p className="text-sm text-text">{uploading ? (sending ?? "Reading the files…") : "Drop a ZIP or CSV files here"}</p>
          <input ref={input} type="file" multiple accept=".zip,.csv" className="hidden" onChange={(e) => void upload(e.target.files)} />
          <Button type="button" size="sm" variant="secondary" disabled={uploading} onClick={() => input.current?.click()}>
            Choose files
          </Button>
          <p className="text-xs text-subtle">Up to {MAX_UPLOAD / 1024 / 1024} MB an upload — a big file goes up in parts.</p>
        </div>
        {error && <p className="mt-2 text-xs text-danger">{error}</p>}
      </Card>

      {draft && draft.files.length > 0 && (
        <>
          <FilesCard files={draft.files} pending={pending} act={act} />
          {zoho && <LegacyMasterLists key={draft.files.map((f) => `${f.id}:${f.kind}`).join("|")} importId={draft.id} initialCounts={masterCounts} />}
          <Card className="flex flex-wrap items-center justify-between gap-3 p-4">
            <div>
              <h2 className="text-sm font-medium text-text">3 · Preview</h2>
              <p className="mt-0.5 text-xs text-muted">Reads every file as the import would — counts, what&apos;s already here, what can&apos;t come in and why. Writes nothing.</p>
            </div>
            <div className="flex gap-2">
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={async () => await confirmAction("Throw away these uploaded files? Nothing has been imported from them.") && act(() => discardLegacyDraft(draft.id))}>
                Discard
              </Button>
              <Button type="button" size="sm" disabled={pending} onClick={() => act(() => analyseLegacyImport(draft.id))}>
                {pending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                {analysis ? "Preview again" : "Preview the import"}
              </Button>
            </div>
          </Card>
          {analysis && <Preview importId={draft.id} analysis={analysis} earlier={earlier} />}
        </>
      )}
    </>
  );
}

function FilesCard({ files, pending, act }: { files: FileSummary[]; pending: boolean; act: (work: () => Promise<{ ok: true } | { ok: false; error: string }>) => void }) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium text-text">2 · The files, and what each holds</h2>
        <p className="mt-0.5 text-xs text-muted">Each file was taken for the old CRM&apos;s table its headings say. Change it if it&apos;s wrong, and open a file to choose which heading each column is read from.</p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">File</th>
              <th className="px-4 py-2.5 text-right">Rows</th>
              <th className="px-4 py-2.5">Holds</th>
              <th className="px-4 py-2.5">Columns read</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody>
            {files.map((f) => {
              const def = kindDef(f.kind);
              const read = def ? def.columns.filter((c) => f.mapping[c]).length : 0;
              const expanded = open === f.id;
              return (
                <tr key={f.id} className="border-b border-line align-top last:border-0">
                  <td className="px-4 py-2">
                    <button type="button" className="flex items-center gap-1 text-left font-mono text-xs text-text hover:underline" onClick={() => setOpen(expanded ? null : f.id)} aria-expanded={expanded}>
                      {expanded ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
                      {f.name}
                    </button>
                    {expanded && def && <MappingEditor file={f} pending={pending} act={act} />}
                    {expanded && !def && <p className="ml-5 mt-1 text-xs text-muted">Headings: {f.headers.join(", ")}</p>}
                  </td>
                  <td className="px-4 py-2 text-right tabular-nums">{n(f.rowCount)}</td>
                  <td className="px-4 py-2">
                    <Select className="h-8 w-56" value={f.kind ?? ""} disabled={pending} onChange={(e) => act(() => setLegacyFileKind(f.id, e.target.value || null))} aria-label={`What ${f.name} holds`}>
                      <option value="">Not one of the old CRM&apos;s tables — left out</option>
                      {KINDS.map((k) => (
                        <option key={k.key} value={k.key}>
                          {k.label}
                        </option>
                      ))}
                    </Select>
                    {def && <p className="mt-0.5 text-xs text-muted">→ {def.becomes}</p>}
                  </td>
                  <td className="px-4 py-2 text-xs text-muted">{def ? (def.role === "ignored" ? "Not brought" : `${read} of ${def.columns.length}`) : "—"}</td>
                  <td className="px-4 py-2 text-right">
                    <IconButton icon={Trash2} label={`Remove ${f.name}`} tone="danger" disabled={pending} onClick={() => act(() => removeLegacyFile(f.id))} />
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </Card>
  );
}

function MappingEditor({ file, pending, act }: { file: FileSummary; pending: boolean; act: (work: () => Promise<{ ok: true } | { ok: false; error: string }>) => void }) {
  const def = kindDef(file.kind)!;
  const [mapping, setMapping] = useState(file.mapping);
  const unused = file.headers.filter((h) => !Object.values(mapping).includes(h));
  return (
    <div className="ml-5 mt-2 space-y-2 rounded-base border border-line bg-surface-sunken p-3">
      <div className="grid grid-cols-1 gap-x-4 gap-y-1.5 sm:grid-cols-2">
        {def.columns.map((column) => (
          <label key={column} className="flex items-center justify-between gap-2 text-xs">
            <span className="font-mono text-muted">{column}</span>
            <select className="h-7 w-44 rounded-base border border-line-strong bg-surface px-2 text-xs" value={mapping[column] ?? ""} onChange={(e) => setMapping({ ...mapping, [column]: e.target.value || null })}>
              <option value="">— not in this file</option>
              {file.headers.map((h) => (
                <option key={h} value={h}>
                  {h}
                </option>
              ))}
            </select>
          </label>
        ))}
      </div>
      {unused.length > 0 && <p className="text-xs text-subtle">Not read: {unused.join(", ")}</p>}
      <div className="flex justify-end">
        <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => act(() => setLegacyFileMapping(file.id, mapping))}>
          Save columns
        </Button>
      </div>
    </div>
  );
}

function Preview({ importId, analysis, earlier }: { importId: string; analysis: Analysis; earlier: HistoryRun[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [strategy, setStrategy] = useState<StrategyKey>("NEW");
  const [matches, setMatches] = useState<Partial<Record<KindKey, "link" | "skip">>>({});
  const [users, setUsers] = useState<Record<string, string>>(() => Object.fromEntries(analysis.users.map((u) => [u.oldId, u.match?.id ?? "create"])));
  const [confirmed, setConfirmed] = useState(false);
  // WroffyCRM's tables, and Zoho's customers and vendors, which can come in on their own (owner, 30 Oct 2026).
  const records = analysis.kinds.filter((k) => countedKind({ key: k.kind, role: k.role }));
  const totals = records.reduce((t, k) => ({ fresh: t.fresh + k.fresh, imported: t.imported + k.imported, matches: t.matches + k.matches, problems: t.problems + k.problemRows }), { fresh: 0, imported: 0, matches: 0, problems: 0 });
  const undecided = analysis.needsDecision.filter((k) => !matches[k]);
  const creating = Object.values(users).filter((v) => v === "create").length;

  const begin = () =>
    start(async () => {
      setError(null);
      const r = await startLegacyImport(importId, { strategy, decisions: { matches, users }, confirmed });
      if (!r.ok) return setError(r.error);
      router.refresh();
    });

  return (
    <>
      <Card className="overflow-hidden p-0">
        <div className="border-b border-line px-4 py-3">
          <h2 className="text-sm font-medium text-text">What the files hold</h2>
          <p className="mt-0.5 text-xs text-muted">Previewed {when(analysis.at)}. Open a table to see its problems, warnings and a few of its rows.</p>
        </div>
        {analysis.notes.length > 0 && (
          <div className="border-b border-line bg-warning-bg px-4 py-2 text-xs text-warning">
            {analysis.notes.map((note) => (
              <p key={note} className="flex items-start gap-1.5">
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
                {note}
              </p>
            ))}
          </div>
        )}
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5">Table</th>
                <th className="px-4 py-2.5 text-right">Rows</th>
                <th className="px-4 py-2.5 text-right">New</th>
                <th className="px-4 py-2.5 text-right">Imported before</th>
                <th className="px-4 py-2.5 text-right">Already in Deskzo</th>
                <th className="px-4 py-2.5 text-right">Left behind</th>
                <th className="px-4 py-2.5 text-right">Can&apos;t come in</th>
              </tr>
            </thead>
            <tbody>
              {analysis.kinds.map((k) => (
                <KindRow key={k.kind} report={k} />
              ))}
            </tbody>
          </table>
        </div>
        {analysis.unknownFiles.length > 0 && <p className="border-t border-line px-4 py-2 text-xs text-muted">Left out, not being one of the old CRM&apos;s tables: {analysis.unknownFiles.join(", ")}.</p>}
      </Card>

      {analysis.users.length > 0 && (
        <Card className="overflow-hidden p-0">
          <div className="border-b border-line px-4 py-3">
            <h2 className="text-sm font-medium text-text">4 · Who the old users are in Deskzo</h2>
            <p className="mt-0.5 text-xs text-muted">Matched by email. Anyone not in Deskzo is created as a switched-off account — no sign-in, no seat — so their history shows who did it. {creating > 0 && `${creating} will be created.`}</p>
          </div>
          <div className="max-h-96 overflow-auto">
            <table className="w-full text-sm">
              <tbody>
                {analysis.users.map((u) => (
                  <tr key={u.oldId} className="border-b border-line last:border-0">
                    <td className="px-4 py-1.5">
                      <span className="text-text">{u.name}</span> <span className="text-xs text-muted">{u.email}</span>
                      {!u.active && <Badge className="ml-1.5">Left</Badge>}
                      {u.roles.length > 0 && <span className="block text-xs text-subtle">{u.roles.join(", ")}</span>}
                    </td>
                    <td className="px-4 py-1.5 text-right">
                      <SearchSelect className="h-8 w-64" value={users[u.oldId] ?? "create"} disabled={u.imported} onChange={(e) => setUsers({ ...users, [u.oldId]: e.target.value })} aria-label={`Who ${u.name} is in Deskzo`} searchPlaceholder="Search users…">
                        <option value="create">Create as a switched-off user</option>
                        {analysis.deskzoUsers.map((d) => (
                          <option key={d.id} value={d.id}>
                            {d.name} — {d.email}
                            {d.active ? "" : " (switched off)"}
                          </option>
                        ))}
                      </SearchSelect>
                      {u.imported && <p className="text-xs text-subtle">Imported before</p>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>
      )}

      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-medium text-text">5 · How the files meet what&apos;s already here</h2>
        <div className="space-y-2">
          {STRATEGIES.map((s) => (
            <label key={s.key} className={`flex cursor-pointer gap-2 rounded-base border p-3 text-sm ${strategy === s.key ? "border-brand bg-brand/5" : "border-line"}`}>
              <input type="radio" name="strategy" checked={strategy === s.key} onChange={() => setStrategy(s.key)} className="mt-1" />
              <span>
                <span className="font-medium text-text">{s.label}</span>
                <span className="block text-xs text-muted">{s.explain}</span>
                {s.key === "REPLACE" && <span className="mt-1 block text-xs text-warning">{earlier.length === 0 ? "There's no earlier import to replace — this is the same as importing new data." : `Undoes ${earlier.length} earlier import(s) first: ${earlier.map((e) => when(e.createdAt)).join(", ")}.`}</span>}
              </span>
            </label>
          ))}
        </div>
        {analysis.needsDecision.length > 0 && (
          <div className="space-y-2 rounded-base border border-warning/40 bg-warning-bg p-3">
            <p className="text-sm font-medium text-warning">Rows that meet records Deskzo already has — decide before importing</p>
            {analysis.needsDecision.map((kind) => {
              const report = analysis.kinds.find((k) => k.kind === kind)!;
              const asked = report.matches - (report.linked ?? 0);
              return (
                <div key={kind} className="text-xs text-text">
                  <p>
                    {n(asked)} {report.label.toLowerCase()} match{asked === 1 ? "es" : ""} one Deskzo already has{" "}
                    {kind === "customers" || COUNTED_MASTER.includes(kind) ? "(same company name)" : kind === "products" ? "(same SKU)" : "(same email at the same company)"}.
                  </p>
                  <div className="mt-1 flex flex-wrap gap-4">
                    <label className="flex items-center gap-1.5">
                      <input type="radio" name={`match-${kind}`} checked={matches[kind] === "link"} onChange={() => setMatches({ ...matches, [kind]: "link" })} />
                      {COUNTED_MASTER.includes(kind)
                        ? "Use the Deskzo company — its Zoho records attach to it; only an empty account manager is filled from Zoho's owner"
                        : "Use the Deskzo record — its old records attach to it, and it isn't changed"}
                    </label>
                    <label className="flex items-center gap-1.5">
                      <input type="radio" name={`match-${kind}`} checked={matches[kind] === "skip"} onChange={() => setMatches({ ...matches, [kind]: "skip" })} />
                      Leave those rows out — and what hangs off them
                    </label>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Card>

      <Card className="space-y-3 p-4">
        <h2 className="text-sm font-medium text-text">6 · Confirm</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-text">
          <li>
            <span className="font-medium">{n(totals.fresh)}</span> new record(s) come in{totals.matches ? `; ${n(totals.matches)} meet records Deskzo has` : ""}
            {totals.imported ? `; ${n(totals.imported)} came in before and are ${strategy === "UPDATE" ? "updated from the files" : strategy === "REPLACE" ? "taken back and brought in afresh" : "left as they are"}` : ""}.
          </li>
          {totals.problems > 0 && <li className="text-warning">{n(totals.problems)} row(s) can&apos;t come in — listed above, and in the error report afterwards.</li>}
          <li>A full backup of the workspace is taken first. If it can&apos;t be, nothing is imported.</li>
          <li>Nothing typed into Deskzo by hand is deleted or changed. The import can be undone from the list below.</li>
          <li>It runs in parts — keep this page open until it says it&apos;s done; if it&apos;s closed, it carries on when you come back.</li>
        </ul>
        <label className="flex items-center gap-2 text-sm text-text">
          <input type="checkbox" checked={confirmed} onChange={(e) => setConfirmed(e.target.checked)} />
          I&apos;ve read what this will do
        </label>
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex justify-end">
          <Button type="button" disabled={pending || !confirmed || undecided.length > 0 || records.length === 0} onClick={begin}>
            {pending ? <Loader2 className="mr-1.5 h-4 w-4 animate-spin" /> : null}
            {pending ? "Taking the backup…" : "Back up and import"}
          </Button>
        </div>
        {undecided.length > 0 && <p className="text-right text-xs text-warning">Decide about the {undecided.map((k) => kindDef(k)!.label.toLowerCase()).join(" and ")} Deskzo already has first.</p>}
      </Card>
    </>
  );
}

function KindRow({ report }: { report: KindReport }) {
  const [open, setOpen] = useState(false);
  const records = countedKind({ key: report.kind, role: report.role });
  const issues = report.problems.length + report.warnings.length;
  return (
    <>
      <tr className="border-b border-line last:border-0">
        <td className="px-4 py-2">
          <button type="button" className="flex items-center gap-1 text-left hover:underline" onClick={() => setOpen(!open)} aria-expanded={open}>
            {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
            <span className="text-text">{report.label}</span>
            {issues > 0 && <AlertTriangle className="h-3.5 w-3.5 text-warning" />}
          </button>
          <span className="ml-5 block text-xs text-muted">{report.becomes}</span>
        </td>
        <td className="px-4 py-2 text-right tabular-nums">{n(report.rows)}</td>
        <td className="px-4 py-2 text-right tabular-nums font-medium">{records ? n(report.fresh) : "—"}</td>
        <td className="px-4 py-2 text-right tabular-nums text-muted">{records ? n(report.imported) : "—"}</td>
        <td className={`px-4 py-2 text-right tabular-nums ${report.matches ? "text-warning" : "text-muted"}`}>{records ? n(report.matches) : "—"}</td>
        <td className="px-4 py-2 text-right tabular-nums text-muted">{records ? n(report.deleted) : "—"}</td>
        <td className={`px-4 py-2 text-right tabular-nums ${report.problemRows ? "text-danger" : "text-muted"}`}>{records ? n(report.problemRows) : "—"}</td>
      </tr>
      {open && (
        <tr className="border-b border-line bg-surface-sunken">
          <td colSpan={7} className="space-y-2 px-4 py-3 text-xs">
            <p className="text-muted">From {report.files.join(", ")}.</p>
            {report.warnings.map((w) => (
              <p key={w} className="text-warning">
                {w}
              </p>
            ))}
            {report.problems.length > 0 && (
              <div>
                <p className="font-medium text-danger">Can&apos;t come in{report.problemRows > report.problems.length ? ` (first ${report.problems.length} of ${n(report.problemRows)})` : ""}:</p>
                <ul className="mt-1 max-h-48 space-y-0.5 overflow-auto">
                  {report.problems.map((p, i) => (
                    <li key={i} className="text-text">
                      <span className="font-mono text-muted">
                        {p.file}:{p.line}
                        {p.oldId ? ` (id ${p.oldId})` : ""}
                      </span>{" "}
                      {p.message}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {report.sample.length > 0 && (
              <div>
                <p className="font-medium text-muted">First rows, as read:</p>
                {report.sample.map((row, i) => (
                  <p key={i} className="truncate font-mono text-subtle">
                    {Object.entries(row)
                      .slice(0, 10)
                      .map(([k, v]) => `${k}=${v.slice(0, 40)}`)
                      .join(" · ")}
                  </p>
                ))}
              </div>
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ─── 7: the import running ───────────────────────────────────────────────────────────────────────

function RunningImport({ importId }: { importId: string }) {
  const router = useRouter();
  const [state, setState] = useState<{ label: string; done: number; total: number; counts: Record<string, Counts>; failure: string | null; status: string }>({ label: "Starting…", done: 0, total: 0, counts: {}, failure: null, status: "IMPORTING" });
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);

  useEffect(() => {
    live.current = true;
    const loop = async () => {
      while (live.current) {
        const r = await stepLegacyImport(importId).catch((e: unknown) => ({ ok: false as const, error: e instanceof Error ? e.message : "The import step didn't answer." }));
        if (!live.current) return;
        if (!r.ok) {
          setError(r.error);
          await new Promise((res) => setTimeout(res, 3000));
          continue;
        }
        setError(null);
        const progress = r.data.progress as unknown as { counts?: Record<string, Counts>; failure?: string | null };
        setState({ label: r.data.label, done: r.data.done, total: r.data.total, counts: progress.counts ?? {}, failure: progress.failure ?? null, status: r.data.status });
        if (r.data.status !== "IMPORTING") {
          router.refresh();
          return;
        }
      }
    };
    void loop();
    return () => {
      live.current = false;
    };
  }, [importId, router]);

  return (
    <Card className="space-y-3 p-4">
      <div className="flex items-center gap-2">
        {state.status === "IMPORTING" ? <Loader2 className="h-4 w-4 animate-spin text-brand" /> : <CheckCircle2 className="h-4 w-4 text-success" />}
        <h2 className="text-sm font-medium text-text">7 · Importing — keep this page open</h2>
      </div>
      <p className="text-sm text-text">
        {state.label}
        {state.total > 0 && ` — ${n(state.done)} of ${n(state.total)}`}
      </p>
      {state.total > 0 && (
        <div className="h-2 overflow-hidden rounded-full bg-surface-sunken">
          <div className="h-full bg-brand transition-all" style={{ width: `${Math.min(100, (state.done / state.total) * 100)}%` }} />
        </div>
      )}
      <CountsTable counts={state.counts} />
      {state.failure && <p className="text-xs text-danger">Stopped: {state.failure}</p>}
      {error && <p className="text-xs text-warning">{error} Trying again…</p>}
    </Card>
  );
}

function CountsTable({ counts }: { counts: Record<string, Counts> }) {
  const rows = Object.entries(counts);
  if (rows.length === 0) return null;
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead className="text-left text-muted">
          <tr>
            <th className="py-1">Table</th>
            <th className="py-1 text-right">Created</th>
            <th className="py-1 text-right">Updated</th>
            <th className="py-1 text-right">Linked</th>
            <th className="py-1 text-right">Unchanged</th>
            <th className="py-1 text-right">Skipped</th>
            <th className="py-1 text-right">Failed</th>
          </tr>
        </thead>
        <tbody>
          {rows.map(([kind, c]) => (
            <tr key={kind} className="border-t border-line">
              <td className="py-1 text-text">{kind === "customer_product_links" ? "Order add-ons and renewals" : (kindDef(kind)?.label ?? kind)}</td>
              <td className="py-1 text-right tabular-nums">{n(c.created)}</td>
              <td className="py-1 text-right tabular-nums">{n(c.updated)}</td>
              <td className="py-1 text-right tabular-nums">{n(c.linked)}</td>
              <td className="py-1 text-right tabular-nums text-muted">{n(c.unchanged)}</td>
              <td className="py-1 text-right tabular-nums text-muted">{n(c.skipped)}</td>
              <td className={`py-1 text-right tabular-nums ${c.failed ? "text-danger" : "text-muted"}`}>{n(c.failed)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ─── The runs so far ─────────────────────────────────────────────────────────────────────────────

function History({ runs, busy }: { runs: HistoryRun[]; busy: boolean }) {
  return (
    <Card className="overflow-hidden p-0">
      <div className="border-b border-line px-4 py-3">
        <h2 className="text-sm font-medium text-text">Imports so far</h2>
        <p className="mt-0.5 text-xs text-muted">What each brought, its error report, and Undo — which takes back only what that import made or changed.</p>
      </div>
      <ul className="divide-y divide-line">
        {runs.map((r) => (
          <RunRow key={r.id} run={r} busy={busy} />
        ))}
      </ul>
    </Card>
  );
}

function RunRow({ run, busy }: { run: HistoryRun; busy: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [confirm, setConfirm] = useState("");
  const counts = (run.progress.counts ?? {}) as Record<string, Counts>;
  const made = Object.values(counts).reduce((t, c) => t + c.created, 0);
  const failure = run.progress.failure as string | null | undefined;
  const tone = run.status === "DONE" ? "green" : run.status === "FAILED" ? "red" : run.status === "UNDONE" ? "default" : "amber";
  const label = { DONE: "Done", FAILED: "Stopped", UNDONE: "Undone", IMPORTING: "Importing" }[run.status] ?? run.status;

  const report = () =>
    start(async () => {
      const r = await legacyErrorReport(run.id);
      if (!r.ok) return setMessage(r.error);
      if (r.data.count === 0) return setMessage("Every row came in — there's nothing in the error report.");
      download(r.data.filename, r.data.csv);
    });

  const undo = async () => {
    setUndoing(true);
    setMessage(null);
    for (;;) {
      const r = await undoLegacyImport(run.id, confirm);
      if (!r.ok) {
        setMessage(r.error);
        break;
      }
      setMessage(`Undoing… ${n(r.data.left)} record(s) left${r.data.kept ? `, ${n(r.data.kept)} kept because Deskzo uses them since` : ""}.`);
      if (r.data.done) {
        setMessage(`Undone.${r.data.kept ? ` ${n(r.data.kept)} record(s) were kept because records made in Deskzo since use them.` : ""}`);
        router.refresh();
        break;
      }
    }
    setUndoing(false);
  };

  return (
    <li className="px-4 py-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <button type="button" className="flex items-center gap-1.5 text-left" onClick={() => setOpen(!open)} aria-expanded={open}>
          {open ? <ChevronDown className="h-4 w-4 text-subtle" /> : <ChevronRight className="h-4 w-4 text-subtle" />}
          <span className="text-text">{when(run.createdAt)}</span>
          <Badge tone={tone}>{label}</Badge>
          <span className="text-xs text-muted">
            {run.strategy ? STRATEGIES.find((s) => s.key === run.strategy)?.label : ""} · {n(made)} made · {n(run.errors)} in the error report
          </span>
        </button>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={report}>
            <Download className="mr-1.5 h-3.5 w-3.5" />
            Error report
          </Button>
          {(run.status === "DONE" || run.status === "FAILED") && (
            <Button type="button" size="sm" variant="secondary" disabled={busy || undoing} onClick={() => setOpen(true)}>
              <Undo2 className="mr-1.5 h-3.5 w-3.5" />
              Undo
            </Button>
          )}
          {run.status === "FAILED" && (
            <Button type="button" size="sm" disabled={busy || pending} onClick={() => start(async () => { const r = await resumeLegacyImport(run.id); if (!r.ok) setMessage(r.error); router.refresh(); })}>
              Carry on
            </Button>
          )}
        </div>
      </div>
      {open && (
        <div className="ml-6 mt-2 space-y-2">
          {failure && <p className="text-xs text-danger">Stopped: {failure}</p>}
          <CountsTable counts={counts} />
          {(run.status === "DONE" || run.status === "FAILED") && (
            <div className="flex flex-wrap items-end gap-2 rounded-base border border-line bg-surface-sunken p-3">
              <div className="space-y-1">
                <Label htmlFor={`undo-${run.id}`} className="text-xs">
                  Type UNDO to take this import back
                </Label>
                <Input id={`undo-${run.id}`} className="h-8 w-32" value={confirm} onChange={(e) => setConfirm(e.target.value)} />
              </div>
              <Button type="button" size="sm" variant="danger" disabled={busy || undoing || confirm.trim().toUpperCase() !== "UNDO"} onClick={() => void undo()}>
                {undoing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
                Undo this import
              </Button>
              <p className="w-full text-xs text-muted">Deletes what it made and puts back what it changed. A record somebody has since built on in Deskzo is kept, and said so.</p>
            </div>
          )}
        </div>
      )}
      {message && <p className="ml-6 mt-1 text-xs text-muted">{message}</p>}
    </li>
  );
}
