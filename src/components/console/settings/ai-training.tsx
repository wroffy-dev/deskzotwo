"use client";

import { createContext, useContext, useEffect, useId, useMemo, useRef, useState, type FormEvent, type ReactNode } from "react";
import { LoaderCircle, Pencil, Search, SlidersHorizontal, Trash2, Upload } from "lucide-react";
import {
  consoleAiTrainingFile,
  consoleBulkDeleteAiTraining,
  consoleBulkUpdateAiTraining,
  consoleDeleteAiTrainingFile,
  consolePreviewAiTraining,
  consoleSaveAiTrainingFile,
  consoleUploadAiTraining,
} from "@/actions/platform/console-ai-training";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { useConsoleAction } from "@/components/console/kit/use-console-action";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { TEAMMATES, TEAMMATE_KEYS, type TeammateKey } from "@/lib/ai/teammates";
import { TRAINING_PROMPT_CHARS, modelsText, type TeammateModels, type TrainingBulkChange, type TrainingFileDetail, type TrainingFileRow, type TrainingPreview, type TrainingSaveReport, type TrainingWorkspace } from "@/lib/ai-training/shared";

/**
 * Settings › AI training (src/lib/ai-training): upload guides for Deskzo AI's teammates, choose who each is for —
 * teammates and workspaces — edit or delete them one at a time or many at once, and try a question to see what a
 * teammate would be given. Owners and admins change them; everybody else who opens Settings sees the same page without
 * the controls.
 */
/** The models each teammate runs on now (src/lib/ai-training/models.ts), for the pickers below. */
const Models = createContext<TeammateModels>({});

/** "runs on …" under a teammate's name, or that nothing is routed to it yet. */
function RunsOn({ teammate, inline = false }: { teammate: TeammateKey; inline?: boolean }) {
  const text = modelsText(useContext(Models)[teammate]);
  return <span className={inline ? "" : "block text-[11px] text-muted"}>{text ? `runs on ${text}` : "no model routed yet"}</span>;
}

export function AiTraining({ files, workspaces, models, canEdit }: { files: TrainingFileRow[]; workspaces: TrainingWorkspace[]; models: TeammateModels; canEdit: boolean }) {
  const [editing, setEditing] = useState<string | null>(null);
  const [removing, setRemoving] = useState<TrainingFileRow | null>(null);
  const [filter, setFilter] = useState("");
  const names = useMemo(() => new Map(workspaces.map((w) => [w.id, w.name])), [workspaces]);
  const shown = files.filter((f) => !filter.trim() || `${f.name} ${f.title}`.toLowerCase().includes(filter.trim().toLowerCase()));
  // Many at once (owner, 23 Nov 2026 — "add a bulk change option"). Only files still here count.
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState<"change" | "delete" | null>(null);
  const chosen = files.filter((f) => picked.has(f.id));
  const allShownPicked = shown.length > 0 && shown.every((f) => picked.has(f.id));
  const toggle = (id: string) => setPicked((p) => (p.has(id) ? new Set([...p].filter((x) => x !== id)) : new Set([...p, id])));
  const toggleShown = () => setPicked((p) => (allShownPicked ? new Set([...p].filter((id) => !shown.some((f) => f.id === id))) : new Set([...p, ...shown.map((f) => f.id)])));
  const clear = () => setPicked(new Set());
  const quick = useConsoleAction<{ changed: number }>();
  const switchAll = (active: boolean) =>
    quick.run(() => consoleBulkUpdateAiTraining({ ids: chosen.map((f) => f.id), change: { active } }), {
      success: (r) => `${r.changed} ${r.changed === 1 ? "file" : "files"} switched ${active ? "on" : "off"}.`,
      onDone: clear,
    });

  return (
    <Models.Provider value={models}>
    <div className="space-y-6">
      {canEdit && <UploadPanel workspaces={workspaces} />}

      <Panel
        title={`Training files (${files.length})`}
        description="Each answer is given only the parts of these files its question finds, for its own teammate — never whole files — so prompts stay short and the model answers fast."
        padded={false}
        actions={<Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a file" className="h-8 w-48" aria-label="Find a file" />}
      >
        {canEdit && chosen.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-b border-line bg-brand-subtle/40 px-4 py-2.5" role="region" aria-label="Change the files chosen">
            <span className="mr-1 text-[13px] font-medium text-text">
              {chosen.length} {chosen.length === 1 ? "file" : "files"} chosen
            </span>
            <Button type="button" size="sm" onClick={() => setBulk("change")} disabled={quick.pending}>
              <SlidersHorizontal aria-hidden="true" className="h-4 w-4" />
              Change…
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => switchAll(true)} disabled={quick.pending}>
              Switch on
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => switchAll(false)} disabled={quick.pending}>
              Switch off
            </Button>
            <Button type="button" size="sm" variant="secondary" onClick={() => setBulk("delete")} disabled={quick.pending}>
              <Trash2 aria-hidden="true" className="h-4 w-4" />
              Delete
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={clear} disabled={quick.pending}>
              Clear
            </Button>
            {quick.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin text-muted" />}
            {quick.error && <span className="text-xs text-danger">{quick.error}</span>}
          </div>
        )}
        {shown.length ? (
          <div className="relative overflow-x-auto">
            <table className="w-full text-[13px]">
              <thead className="border-b border-line text-left text-xs text-muted">
                <tr>
                  {canEdit && (
                    <th className="w-8 py-2 pl-4">
                      <input type="checkbox" checked={allShownPicked} onChange={toggleShown} aria-label={allShownPicked ? "Unchoose the files shown" : "Choose every file shown"} />
                    </th>
                  )}
                  <th className="px-4 py-2 font-medium">File</th>
                  <th className="px-4 py-2 font-medium">Teammates</th>
                  <th className="px-4 py-2 font-medium">Workspaces</th>
                  <th className="px-4 py-2 font-medium">Size</th>
                  <th className="px-4 py-2 font-medium">Updated</th>
                  {canEdit && <th className="px-4 py-2" />}
                </tr>
              </thead>
              <tbody>
                {shown.map((f) => (
                  <tr key={f.id} className={`border-b border-line last:border-0 align-top ${picked.has(f.id) ? "bg-brand-subtle/30" : ""}`}>
                    {canEdit && (
                      <td className="py-2.5 pl-4">
                        <input type="checkbox" checked={picked.has(f.id)} onChange={() => toggle(f.id)} aria-label={`Choose ${f.name}`} />
                      </td>
                    )}
                    <td className="px-4 py-2.5">
                      <div className="font-medium text-text">{f.name}</div>
                      {f.title && <div className="text-xs text-muted">{f.title}</div>}
                      <div className="mt-1 flex gap-1">
                        {f.always && <StatusPill tone="brand">Always given</StatusPill>}
                        {!f.active && <StatusPill tone="neutral">Off</StatusPill>}
                      </div>
                    </td>
                    <td className="px-4 py-2.5">{f.agents.length ? f.agents.map((k) => TEAMMATES[k].defaultName).join(", ") : <span className="text-muted">Every teammate</span>}</td>
                    <td className="px-4 py-2.5" title={f.tenantIds.map((id) => names.get(id) ?? id).join(", ")}>
                      {f.tenantIds.length ? (f.tenantIds.length <= 2 ? f.tenantIds.map((id) => names.get(id) ?? "(closed)").join(", ") : `${f.tenantIds.length} workspaces`) : <span className="text-muted">Every workspace</span>}
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                      {f.chars.toLocaleString("en-IN")} chars · {f.chunks} chunks
                    </td>
                    <td className="whitespace-nowrap px-4 py-2.5 text-muted">
                      <RelativeTime at={f.updatedAt} />
                    </td>
                    {canEdit && (
                      <td className="whitespace-nowrap px-4 py-2.5 text-right">
                        <Button type="button" variant="ghost" size="icon" aria-label={`Edit ${f.name}`} onClick={() => setEditing(f.id)}>
                          <Pencil aria-hidden="true" className="h-4 w-4" />
                        </Button>
                        <Button type="button" variant="ghost" size="icon" aria-label={`Delete ${f.name}`} onClick={() => setRemoving(f)}>
                          <Trash2 aria-hidden="true" className="h-4 w-4" />
                        </Button>
                      </td>
                    )}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p className="px-4 py-6 text-sm text-muted">{files.length ? "No file matches that." : "No training files yet."}</p>
        )}
      </Panel>

      <TryPanel workspaces={workspaces} />

      {editing && <EditDialog id={editing} workspaces={workspaces} onClose={() => setEditing(null)} />}
      {removing && <DeleteDialog file={removing} onClose={() => setRemoving(null)} />}
      {bulk === "change" && <BulkChangeDialog files={chosen} workspaces={workspaces} onClose={() => setBulk(null)} onDone={clear} />}
      {bulk === "delete" && <BulkDeleteDialog files={chosen} onClose={() => setBulk(null)} onDone={clear} />}
    </div>
    </Models.Provider>
  );
}

// ─── Who a file is for ───────────────────────────────────────────────────────────────────────────

type Scope = { agents: TeammateKey[]; tenantIds: string[] };

const toggled = <T,>(list: T[], item: T): T[] => (list.includes(item) ? list.filter((x) => x !== item) : [...list, item]);

/** The teammates, each with the model it runs on now. */
function TeammateTicks({ value, onChange }: { value: TeammateKey[]; onChange: (next: TeammateKey[]) => void }) {
  return (
    <>
      <div className="grid grid-cols-2 gap-1.5">
        {TEAMMATE_KEYS.map((k) => (
          <label key={k} className="flex items-start gap-2 text-[13px]">
            <input type="checkbox" className="mt-0.5" checked={value.includes(k)} onChange={() => onChange(toggled(value, k))} />
            <span>
              {TEAMMATES[k].defaultName} <span className="text-muted">· {TEAMMATES[k].role}</span>
              <RunsOn teammate={k} />
            </span>
          </label>
        ))}
      </div>
      {(value.includes("kabir") || value.length === 0) && <p className="text-xs text-warning">Kabir answers customers on websites and WhatsApp: anything given to him may be told to them.</p>}
    </>
  );
}

/** Every workspace, or the ones ticked. */
function WorkspacePicker({ value, onChange, workspaces }: { value: string[]; onChange: (next: string[]) => void; workspaces: TrainingWorkspace[] }) {
  const id = useId();
  const [find, setFind] = useState("");
  const [chosen, setChosen] = useState(value.length > 0);
  const q = find.trim().toLowerCase();
  const listed = workspaces.filter((w) => !q || `${w.name} ${w.slug}`.toLowerCase().includes(q)).slice(0, 200);

  return (
    <>
      <div className="flex gap-4 text-[13px]">
        <label className="flex items-center gap-2">
          <input
            type="radio"
            name={`${id}-reach`}
            checked={!chosen}
            onChange={() => {
              setChosen(false);
              onChange([]);
            }}
          />
          Every workspace
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name={`${id}-reach`} checked={chosen} onChange={() => setChosen(true)} />
          Only these
        </label>
      </div>
      {chosen && (
        <div className="space-y-1.5">
          <Input value={find} onChange={(e) => setFind(e.target.value)} placeholder="Find a workspace" className="h-8" aria-label="Find a workspace" />
          <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border border-line p-2">
            {listed.map((w) => (
              <label key={w.id} className="flex items-center gap-2 text-[13px]">
                <input type="checkbox" checked={value.includes(w.id)} onChange={() => onChange(toggled(value, w.id))} />
                <span>
                  {w.name} <span className="text-muted">· {w.slug}</span>
                </span>
              </label>
            ))}
            {!listed.length && <p className="text-xs text-muted">No workspace matches.</p>}
          </div>
          <p className="text-xs text-muted">{value.length ? `${value.length} chosen` : "Choose at least one, or pick Every workspace."}</p>
        </div>
      )}
    </>
  );
}

function ScopeFields({ scope, onChange, workspaces, disabled }: { scope: Scope; onChange: (next: Scope) => void; workspaces: TrainingWorkspace[]; disabled: boolean }) {
  return (
    <div className="grid gap-5 sm:grid-cols-2">
      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="text-sm font-medium text-text">Teammates</legend>
        <p className="text-xs text-muted">None ticked: every teammate is trained on it.</p>
        <TeammateTicks value={scope.agents} onChange={(agents) => onChange({ ...scope, agents })} />
      </fieldset>

      <fieldset className="space-y-2" disabled={disabled}>
        <legend className="text-sm font-medium text-text">Workspaces</legend>
        <WorkspacePicker value={scope.tenantIds} onChange={(tenantIds) => onChange({ ...scope, tenantIds })} workspaces={workspaces} />
      </fieldset>
    </div>
  );
}

// ─── Upload ──────────────────────────────────────────────────────────────────────────────────────

function UploadPanel({ workspaces }: { workspaces: TrainingWorkspace[] }) {
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const [scope, setScope] = useState<Scope>({ agents: [], tenantIds: [] });
  const [always, setAlways] = useState(false);
  const [report, setReport] = useState<TrainingSaveReport | null>(null);
  const upload = useConsoleAction<TrainingSaveReport>();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const chosen = Array.from(input.current?.files ?? []);
    if (!chosen.length) return;
    const form = new FormData();
    for (const f of chosen) form.append("files", f);
    form.set("agents", JSON.stringify(scope.agents));
    form.set("tenantIds", JSON.stringify(scope.tenantIds));
    form.set("always", always ? "true" : "false");
    setReport(null);
    upload.run(() => consoleUploadAiTraining(form), {
      success: (r) => `${r.added.length} added, ${r.replaced.length} replaced.`,
      onDone: (r) => {
        setReport(r);
        if (input.current) input.current.value = "";
      },
    });
  };

  return (
    <Panel title="Add training" description="Markdown (.md) or text (.txt) files, several at once, or a .zip of them. A file with a name already here is replaced.">
      <form onSubmit={submit} className="space-y-5">
        <div className="space-y-1.5">
          <Label htmlFor={`${id}-files`}>Files</Label>
          <input id={`${id}-files`} ref={input} type="file" multiple accept=".md,.markdown,.txt,.zip" className="block text-[13px]" disabled={upload.pending} />
        </div>
        <ScopeFields scope={scope} onChange={setScope} workspaces={workspaces} disabled={upload.pending} />
        <label className="flex items-start gap-2 text-[13px]">
          <input type="checkbox" className="mt-0.5" checked={always} onChange={(e) => setAlways(e.target.checked)} disabled={upload.pending} />
          <span>
            <span className="font-medium">Always give it</span>
            <span className="block text-xs text-muted">For short rules and tone (a page at most). Given to every answer, not only when a question finds it. Long files make every answer slower — leave this off for them.</span>
          </span>
        </label>
        <ActionNoticeRegion notice={upload.error ? { tone: "error", message: upload.error } : null} />
        {report && report.skipped.length > 0 && (
          <div className="rounded-md border border-warning/40 bg-warning-bg p-3 text-xs text-warning">
            <p className="font-medium">Left out:</p>
            <ul className="mt-1 list-disc pl-4">
              {report.skipped.map((s) => (
                <li key={`${s.name}-${s.reason}`}>
                  {s.name} — {s.reason}
                </li>
              ))}
            </ul>
          </div>
        )}
        <Button type="submit" disabled={upload.pending}>
          {upload.pending ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Upload aria-hidden="true" className="h-4 w-4" />}
          Upload
        </Button>
      </form>
    </Panel>
  );
}

// ─── Edit and delete ─────────────────────────────────────────────────────────────────────────────

function EditDialog({ id, workspaces, onClose }: { id: string; workspaces: TrainingWorkspace[]; onClose: () => void }) {
  const fieldId = useId();
  const load = useConsoleAction<TrainingFileDetail>();
  const save = useConsoleAction<null>();
  const [draft, setDraft] = useState<TrainingFileDetail | null>(null);
  const { run: loadRun } = load;
  useEffect(() => {
    loadRun(() => consoleAiTrainingFile(id), { success: "", refresh: false, onDone: setDraft });
  }, [id, loadRun]);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!draft) return;
    save.run(() => consoleSaveAiTrainingFile({ id, name: draft.name, content: draft.content, agents: draft.agents, tenantIds: draft.tenantIds, always: draft.always, active: draft.active }), {
      success: `${draft.name} saved.`,
      onDone: onClose,
    });
  };

  return (
    <Dialog open onClose={() => !save.pending && onClose()} title={draft ? `Edit ${draft.name}` : "Edit training file"} wide>
      {!draft ? (
        <div className="py-8 text-center text-sm text-muted">{load.error ?? "Opening…"}</div>
      ) : (
        <form onSubmit={submit} className="space-y-5">
          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-name`}>Name</Label>
            <Input id={`${fieldId}-name`} value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} readOnly={save.pending} spellCheck={false} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${fieldId}-text`}>Text</Label>
            <Textarea id={`${fieldId}-text`} value={draft.content} onChange={(e) => setDraft({ ...draft, content: e.target.value })} readOnly={save.pending} rows={14} className="font-mono text-xs" />
            <p className="text-xs text-muted">Headings (#, ##) split it into the pieces an answer is given — one topic per heading works best.</p>
          </div>
          <ScopeFields scope={{ agents: draft.agents, tenantIds: draft.tenantIds }} onChange={(s) => setDraft({ ...draft, ...s })} workspaces={workspaces} disabled={save.pending} />
          <div className="flex flex-wrap gap-5 text-[13px]">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.always} onChange={(e) => setDraft({ ...draft, always: e.target.checked })} disabled={save.pending} />
              Always give it
            </label>
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={draft.active} onChange={(e) => setDraft({ ...draft, active: e.target.checked })} disabled={save.pending} />
              On
            </label>
          </div>
          <ActionNoticeRegion notice={save.error ? { tone: "error", message: save.error } : null} />
          <div className="flex justify-end gap-2">
            <Button type="button" variant="secondary" onClick={onClose} disabled={save.pending}>
              Cancel
            </Button>
            <Button type="submit" disabled={save.pending}>
              {save.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
              Save
            </Button>
          </div>
        </form>
      )}
    </Dialog>
  );
}

function DeleteDialog({ file, onClose }: { file: TrainingFileRow; onClose: () => void }) {
  const remove = useConsoleAction<null>();
  return (
    <Dialog open onClose={() => !remove.pending && onClose()} title={`Delete ${file.name}?`}>
      <div className="space-y-4">
        <p className="text-sm text-text">{"Its teammates stop being given it in every workspace within a minute. This can't be undone — upload it again to bring it back."}</p>
        <ActionNoticeRegion notice={remove.error ? { tone: "error", message: remove.error } : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={remove.pending}>
            Cancel
          </Button>
          <Button type="button" variant="danger" disabled={remove.pending} onClick={() => remove.run(() => consoleDeleteAiTrainingFile(file.id), { success: `${file.name} deleted.`, onDone: onClose })}>
            Delete
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ─── Many at once ────────────────────────────────────────────────────────────────────────────────

const filesWord = (n: number) => `${n} ${n === 1 ? "file" : "files"}`;

/** One part of a bulk change: left as each file has it, or set for all of them. */
function BulkPart({ label, set, onSet, children, disabled }: { label: string; set: boolean; onSet: (set: boolean) => void; children: ReactNode; disabled: boolean }) {
  const id = useId();
  return (
    <fieldset className="space-y-2 rounded-md border border-line p-3" disabled={disabled}>
      <legend className="px-1 text-sm font-medium text-text">{label}</legend>
      <div className="flex flex-wrap gap-4 text-[13px]">
        <label className="flex items-center gap-2">
          <input type="radio" name={`${id}-set`} checked={!set} onChange={() => onSet(false)} />
          Leave as each file has it
        </label>
        <label className="flex items-center gap-2">
          <input type="radio" name={`${id}-set`} checked={set} onChange={() => onSet(true)} />
          Set for all of them
        </label>
      </div>
      {set && <div className="space-y-2 pt-1">{children}</div>}
    </fieldset>
  );
}

function YesNo({ value, onChange, yes, no }: { value: boolean | null; onChange: (v: boolean) => void; yes: string; no: string }) {
  const id = useId();
  return (
    <div className="flex flex-wrap gap-4 text-[13px]">
      <label className="flex items-center gap-2">
        <input type="radio" name={id} checked={value === true} onChange={() => onChange(true)} />
        {yes}
      </label>
      <label className="flex items-center gap-2">
        <input type="radio" name={id} checked={value === false} onChange={() => onChange(false)} />
        {no}
      </label>
    </div>
  );
}

function BulkChangeDialog({ files, workspaces, onClose, onDone }: { files: TrainingFileRow[]; workspaces: TrainingWorkspace[]; onClose: () => void; onDone: () => void }) {
  const save = useConsoleAction<{ changed: number }>();
  const [agents, setAgents] = useState<TeammateKey[] | null>(null);
  const [tenantIds, setTenantIds] = useState<string[] | null>(null);
  const [always, setAlways] = useState<boolean | null>(null);
  const [active, setActive] = useState<boolean | null>(null);
  const change: TrainingBulkChange = {
    ...(agents ? { agents } : {}),
    ...(tenantIds ? { tenantIds } : {}),
    ...(always !== null ? { always } : {}),
    ...(active !== null ? { active } : {}),
  };
  const nothing = Object.keys(change).length === 0;

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (nothing) return;
    save.run(() => consoleBulkUpdateAiTraining({ ids: files.map((f) => f.id), change }), {
      success: (r) => `${filesWord(r.changed)} changed.`,
      onDone: () => {
        onDone();
        onClose();
      },
    });
  };

  return (
    <Dialog open onClose={() => !save.pending && onClose()} title={`Change ${filesWord(files.length)}`} wide>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-muted" title={files.map((f) => f.name).join(", ")}>
          {files
            .slice(0, 6)
            .map((f) => f.name)
            .join(", ")}
          {files.length > 6 ? ` and ${files.length - 6} more` : ""}
        </p>
        <BulkPart label="Teammates" set={agents !== null} onSet={(on) => setAgents(on ? [] : null)} disabled={save.pending}>
          <p className="text-xs text-muted">None ticked: every teammate.</p>
          <TeammateTicks value={agents ?? []} onChange={setAgents} />
        </BulkPart>
        <BulkPart label="Workspaces" set={tenantIds !== null} onSet={(on) => setTenantIds(on ? [] : null)} disabled={save.pending}>
          <WorkspacePicker value={tenantIds ?? []} onChange={setTenantIds} workspaces={workspaces} />
        </BulkPart>
        <BulkPart label="Always give it" set={always !== null} onSet={(on) => setAlways(on ? true : null)} disabled={save.pending}>
          <YesNo value={always} onChange={setAlways} yes="Always give them" no="Only when a question finds them" />
        </BulkPart>
        <BulkPart label="On or off" set={active !== null} onSet={(on) => setActive(on ? true : null)} disabled={save.pending}>
          <YesNo value={active} onChange={setActive} yes="On" no="Off — kept, but given to nobody" />
        </BulkPart>
        <ActionNoticeRegion notice={save.error ? { tone: "error", message: save.error } : null} />
        <div className="flex items-center justify-end gap-2">
          {nothing && <span className="mr-auto text-xs text-muted">Choose what to set.</span>}
          <Button type="button" variant="secondary" onClick={onClose} disabled={save.pending}>
            Cancel
          </Button>
          <Button type="submit" disabled={save.pending || nothing}>
            {save.pending && <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" />}
            Change {filesWord(files.length)}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function BulkDeleteDialog({ files, onClose, onDone }: { files: TrainingFileRow[]; onClose: () => void; onDone: () => void }) {
  const remove = useConsoleAction<{ deleted: number }>();
  return (
    <Dialog open onClose={() => !remove.pending && onClose()} title={`Delete ${filesWord(files.length)}?`}>
      <div className="space-y-4">
        <p className="text-sm text-text">{"Their teammates stop being given them in every workspace within a minute. This can't be undone — upload them again to bring them back."}</p>
        <ul className="max-h-40 list-disc overflow-y-auto pl-5 text-[13px] text-muted">
          {files.map((f) => (
            <li key={f.id}>{f.name}</li>
          ))}
        </ul>
        <ActionNoticeRegion notice={remove.error ? { tone: "error", message: remove.error } : null} />
        <div className="flex justify-end gap-2">
          <Button type="button" variant="secondary" onClick={onClose} disabled={remove.pending}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="danger"
            disabled={remove.pending}
            onClick={() =>
              remove.run(() => consoleBulkDeleteAiTraining({ ids: files.map((f) => f.id) }), {
                success: (r) => `${filesWord(r.deleted)} deleted.`,
                onDone: () => {
                  onDone();
                  onClose();
                },
              })
            }
          >
            Delete {filesWord(files.length)}
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

// ─── Try it ──────────────────────────────────────────────────────────────────────────────────────

function TryPanel({ workspaces }: { workspaces: TrainingWorkspace[] }) {
  const id = useId();
  const [agent, setAgent] = useState<TeammateKey>("deskzo");
  const [tenantId, setTenantId] = useState(workspaces[0]?.id ?? "");
  const [question, setQuestion] = useState("");
  const [result, setResult] = useState<TrainingPreview | null>(null);
  const preview = useConsoleAction<TrainingPreview>();

  const submit = (e: FormEvent) => {
    e.preventDefault();
    preview.run(() => consolePreviewAiTraining({ agent, tenantId, question }), { success: "", refresh: false, onDone: setResult });
  };

  return (
    <Panel title="Try it" description={`What a teammate in a workspace is given for a question — at most ${TRAINING_PROMPT_CHARS.toLocaleString("en-IN")} characters, on top of the workspace's own AI Knowledge.`}>
      <form onSubmit={submit} className="space-y-4">
        <p className="text-xs text-muted">
          {TEAMMATES[agent].defaultName}: <RunsOn teammate={agent} inline />
        </p>
        <div className="grid gap-3 sm:grid-cols-[10rem_14rem_1fr_auto] sm:items-end">
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-agent`}>Teammate</Label>
            <Select id={`${id}-agent`} value={agent} onChange={(e) => setAgent(e.target.value as TeammateKey)}>
              {TEAMMATE_KEYS.map((k) => (
                <option key={k} value={k}>
                  {TEAMMATES[k].defaultName}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-tenant`}>Workspace</Label>
            <Select id={`${id}-tenant`} value={tenantId} onChange={(e) => setTenantId(e.target.value)}>
              {workspaces.map((w) => (
                <option key={w.id} value={w.id}>
                  {w.name}
                </option>
              ))}
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor={`${id}-q`}>Question</Label>
            <Input id={`${id}-q`} value={question} onChange={(e) => setQuestion(e.target.value)} placeholder="How do I add a lead?" />
          </div>
          <Button type="submit" variant="secondary" disabled={preview.pending || !tenantId}>
            {preview.pending ? <LoaderCircle aria-hidden="true" className="h-4 w-4 animate-spin" /> : <Search aria-hidden="true" className="h-4 w-4" />}
            Try
          </Button>
        </div>
        <ActionNoticeRegion notice={preview.error ? { tone: "error", message: preview.error } : null} />
        {result && (
          <div className="space-y-3">
            <p className="text-xs text-muted">
              {result.chars.toLocaleString("en-IN")} characters (about {Math.ceil(result.chars / 4).toLocaleString("en-IN")} tokens), found in {result.ms} ms.
            </p>
            {!result.always.length && !result.found.length && <p className="text-sm text-muted">Nothing — this teammate would answer without training here.</p>}
            {result.always.map((a) => (
              <Piece key={`a-${a.file}`} label={`${a.file} · always`} text={a.text} />
            ))}
            {result.found.map((h, i) => (
              <Piece key={`f-${h.file}-${i}`} label={h.heading ? `${h.file} › ${h.heading}` : h.file} text={h.text} />
            ))}
          </div>
        )}
      </form>
    </Panel>
  );
}

function Piece({ label, text }: { label: string; text: string }) {
  return (
    <div className="rounded-md border border-line p-3">
      <div className="text-xs font-medium text-muted">{label}</div>
      <pre className="mt-1 whitespace-pre-wrap font-sans text-[13px] text-text">{text}</pre>
    </div>
  );
}
