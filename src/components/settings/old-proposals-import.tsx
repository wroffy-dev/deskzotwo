"use client";

import { useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { FolderUp, Loader2, Undo2 } from "lucide-react";
import { stepOldProposalsImport, undoOldProposalsImport } from "@/actions/old-proposals";
import { ActionNoticeRegion } from "@/components/ui/action-notice";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import type { ImportView } from "@/lib/old-proposals/run";

/** The imports of old proposals so far: carried on, taken back, and their own files sent (src/lib/old-proposals/run.ts). */

const n = (v: number) => v.toLocaleString("en-IN");
const STATUS: Record<string, { label: string; tone: "green" | "amber" | "red" | "default" }> = {
  IMPORTING: { label: "Bringing in", tone: "amber" },
  DONE: { label: "Done", tone: "green" },
  FAILED: { label: "Stopped", tone: "red" },
  UNDONE: { label: "Undone", tone: "default" },
};

export function OldProposalImports({ imports }: { imports: ImportView[] }) {
  if (imports.length === 0) return null;
  return (
    <div className="mt-5 space-y-4">
      {imports.some((i) => i.status === "DONE" && i.filesWanted > i.files) && <SendFiles />}
      <Card>
        <CardHeader className="text-sm font-medium text-text">Brought in so far</CardHeader>
        <CardContent className="space-y-4">
          {imports.map((i) => (
            <Run key={i.id} first={i} />
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function Run({ first }: { first: ImportView }) {
  const router = useRouter();
  const [view, setView] = useState(first);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [typed, setTyped] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const p = view.progress;
  const status = STATUS[view.status] ?? STATUS.FAILED!;

  const carryOn = async () => {
    setWorking(true);
    setError(null);
    try {
      for (let last = -1; ; ) {
        const r = await stepOldProposalsImport(view.id);
        if (!r.ok) {
          setError(r.error);
          break;
        }
        setView(r.data);
        if (r.data.status !== "IMPORTING") break;
        // Another tab has it this moment.
        if (r.data.progress.at === last) await new Promise((done) => setTimeout(done, 3000));
        last = r.data.progress.at;
      }
      router.refresh();
    } catch {
      setError("It stopped — the connection dropped. Press Carry on.");
    } finally {
      setWorking(false);
    }
  };
  const undo = async () => {
    setWorking(true);
    setError(null);
    try {
      for (;;) {
        const r = await undoOldProposalsImport(view.id, typed);
        if (!r.ok) {
          setError(r.error);
          break;
        }
        if (r.data.done) {
          setNote(`Undone.${r.data.kept ? ` ${n(r.data.kept)} companies and contacts were kept: something in Deskzo was built on them since.` : ""}`);
          setView((v) => ({ ...v, status: "UNDONE" }));
          router.refresh();
          break;
        }
        setNote(`Taking it back… ${n(r.data.left)} left`);
      }
    } catch {
      setError("It stopped — the connection dropped. Press it again to carry on.");
    } finally {
      setWorking(false);
    }
  };

  return (
    <div className="space-y-2 text-sm">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-text">{new Date(view.createdAt).toLocaleString("en-IN", { dateStyle: "medium", timeStyle: "short" })}</span>
        <Badge tone={status.tone}>{status.label}</Badge>
        <span className="text-xs text-muted">
          {n(p.at)} of {n(p.total)} gone through · {n(p.proposals)} brought in · {n(p.companies)} companies and {n(p.contacts)} contacts made · {n(view.files)} of {n(view.filesWanted)} files
        </span>
        {view.status === "IMPORTING" && (
          <Button type="button" size="sm" disabled={working} onClick={carryOn}>
            {working ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : null}
            {working ? "Bringing in…" : "Carry on"}
          </Button>
        )}
        {view.status !== "UNDONE" && !working && (
          <Button type="button" size="sm" variant="ghost" onClick={() => setUndoing(!undoing)}>
            <Undo2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
            Undo
          </Button>
        )}
      </div>
      {undoing && view.status !== "UNDONE" && (
        <div className="flex flex-wrap items-center gap-2">
          <Input value={typed} onChange={(e) => setTyped(e.target.value)} placeholder="Type UNDO" aria-label="Type UNDO to take this import back" className="h-8 w-32" />
          <Button type="button" size="sm" variant="secondary" disabled={typed !== "UNDO" || working} onClick={undo}>
            Take it back
          </Button>
          <span className="text-xs text-muted">The proposals go, and the companies and contacts it made that nothing has been built on since.</span>
        </div>
      )}
      <ActionNoticeRegion notice={error ? { tone: "error", message: error } : note ? { tone: "success", message: note } : null} />
      {p.failed.length > 0 && (
        <details className="text-xs text-muted">
          <summary className="cursor-pointer">{n(p.failed.length)} not brought in</summary>
          <ul className="mt-1 list-disc pl-5">
            {p.failed.slice(0, 200).map((f) => (
              <li key={f.key}>
                {f.company}: {f.why}
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  );
}

/** The folder's own files, the wanted ones only, a few at a time. */
function SendFiles() {
  const router = useRouter();
  const input = useRef<HTMLInputElement>(null);
  const [pending, start] = useTransition();
  const [sent, setSent] = useState<{ done: number; of: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const send = (list: FileList | null) => {
    if (!list?.length) return;
    const chosen = Array.from(list);
    start(async () => {
      setError(null);
      setNote(null);
      try {
        const asked = await fetch("/api/old-proposals/files");
        if (!asked.ok) throw new Error();
        const { wanted } = (await asked.json()) as { wanted: string[] };
        // Found by the end of its path, whichever folder above was chosen; one file a path.
        const byPath = new Map(chosen.map((f) => [f.webkitRelativePath || f.name, f]));
        const all = [...byPath.keys()];
        const tails = new Map<string, File>();
        for (const path of all) {
          const parts = path.split("/");
          for (let i = 0; i < parts.length; i++) tails.set(parts.slice(i).join("/"), byPath.get(path)!);
        }
        const go = wanted.map((path) => ({ path, file: tails.get(path) })).filter((x): x is { path: string; file: File } => !!x.file);
        if (go.length === 0) {
          setError("None of the files still wanted are in that folder. Choose the folder that has the year folders (2017, 2018…).");
          return;
        }
        let kept = 0;
        for (let i = 0; i < go.length; ) {
          const form = new FormData();
          let size = 0;
          let k = 0;
          for (; k < 12 && i + k < go.length && (k === 0 || size + go[i + k]!.file.size < 16 * 1024 * 1024); k++) {
            size += go[i + k]!.file.size;
            form.append("path", go[i + k]!.path);
            form.append("file", go[i + k]!.file);
          }
          const res = await fetch("/api/old-proposals/files", { method: "POST", body: form });
          const body = (await res.json().catch(() => ({}))) as { kept?: number; error?: string };
          kept += body.kept ?? 0;
          if (!res.ok) {
            setError(`${body.error ?? "That didn't go through."} ${n(kept)} kept so far; choose the folder again to carry on.`);
            return;
          }
          i += k;
          setSent({ done: i, of: go.length });
        }
        setNote(`${n(kept)} files kept beside their proposals.${wanted.length > go.length ? ` ${n(wanted.length - go.length)} weren't in that folder.` : ""}`);
        router.refresh();
      } catch {
        setError("The files stopped — the connection dropped. Choose the folder again to carry on; what went is kept.");
      } finally {
        setSent(null);
      }
    });
  };
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Their own files</CardHeader>
      <CardContent className="space-y-2">
        <p className="text-sm text-muted">Choose the folder the proposals are in. Each proposal&apos;s latest version and the other papers in its folder are sent, and kept on its company&apos;s Earlier years tab to open.</p>
        <input
          ref={input}
          type="file"
          multiple
          className="hidden"
          aria-label="The proposals' folder"
          {...({ webkitdirectory: "" } as Record<string, string>)}
          onChange={(e) => {
            send(e.target.files);
          }}
        />
        <Button type="button" size="sm" disabled={pending} onClick={() => input.current?.click()}>
          {pending ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <FolderUp className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />}
          {pending ? (sent ? `Sending ${n(sent.done)} of ${n(sent.of)}…` : "Looking…") : "Choose the folder"}
        </Button>
        <ActionNoticeRegion notice={error ? { tone: "error", message: error } : note ? { tone: "success", message: note } : null} />
      </CardContent>
    </Card>
  );
}
