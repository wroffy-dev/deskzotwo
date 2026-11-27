"use client";

import { useMemo, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { BookOpen, FileText, Pencil, Search, Trash2, Upload } from "lucide-react";
import { deleteAiKnowledgeFile, getAiKnowledgeFile, saveAiKnowledgeFile, setAiKnowledgeForCustomers, tryAiKnowledgeSearch } from "@/actions/ai-knowledge";
import type { KnowledgeFileRow } from "@/lib/ai-knowledge/store";
import type { KnowledgeHit } from "@/lib/ai-knowledge/search";
import { useClock } from "@/components/time/clock-provider";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice, type NoticeTone } from "@/components/ui/action-notice";
import { confirmAction } from "@/components/ui/confirm";

/**
 * Settings › AI Knowledge's screen (src/actions/ai-knowledge.ts, src/app/api/ai-knowledge/upload): upload many
 * files or a .zip at once; find a file by its name or title; open one to edit or rename; delete; and ask a question
 * to see the very chunks the copilot would be given for it. Each file has a tick, "Website chat may use this": the
 * chat bot answers visitors only from the files with it on (security audit, 11 Nov 2026 — SEC-46).
 */

type Notice = { tone: NoticeTone; text: string };
type Editing = { id: string; name: string; content: string; original: string };

const number = (n: number) => n.toLocaleString("en-IN");

export function AiKnowledgeManager({ files }: { files: KnowledgeFileRow[] }) {
  const router = useRouter();
  const clock = useClock();
  const input = useRef<HTMLInputElement>(null);
  const [pending, startTransition] = useTransition();
  const [uploading, setUploading] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [filter, setFilter] = useState("");
  const [editing, setEditing] = useState<Editing | null>(null);
  const [question, setQuestion] = useState("");
  const [found, setFound] = useState<{ question: string; hits: KnowledgeHit[] } | null>(null);

  const shown = useMemo(() => {
    const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return files;
    return files.filter((f) => words.every((w) => f.name.toLowerCase().includes(w) || f.title.toLowerCase().includes(w)));
  }, [files, filter]);
  const chunks = files.reduce((sum, f) => sum + f.chunks, 0);
  const forChat = files.filter((f) => f.forCustomers === true).length;

  async function upload(list: FileList | null) {
    if (!list?.length) return;
    setNotice(null);
    setUploading(true);
    try {
      const form = new FormData();
      for (const file of Array.from(list)) form.append("files", file);
      const response = await fetch("/api/ai-knowledge/upload", { method: "POST", body: form });
      const r = (await response.json().catch(() => ({ ok: false, error: "The upload failed — try again." }))) as
        | { ok: true; data: { added: string[]; replaced: string[]; skipped: { name: string; reason: string }[] } }
        | { ok: false; error: string };
      if (!r.ok) return setNotice({ tone: "error", text: r.error });
      const { added, replaced, skipped } = r.data;
      const done = [added.length ? `${number(added.length)} added` : "", replaced.length ? `${number(replaced.length)} replaced` : ""].filter(Boolean).join(", ");
      const left = skipped.length ? ` Left out: ${skipped.slice(0, 4).map((s) => `${s.name} (${s.reason})`).join("; ")}${skipped.length > 4 ? `, and ${skipped.length - 4} more` : ""}.` : "";
      setNotice({ tone: done ? (skipped.length ? "info" : "success") : "error", text: `${done ? `${done[0]!.toUpperCase()}${done.slice(1)}.` : "Nothing was saved."}${left}` });
      router.refresh();
    } catch {
      setNotice({ tone: "error", text: "The upload didn't reach the server — check the connection and try again." });
    } finally {
      setUploading(false);
      if (input.current) input.current.value = "";
    }
  }

  function open(file: KnowledgeFileRow) {
    setNotice(null);
    startTransition(async () => {
      const r = await getAiKnowledgeFile(file.id);
      if (!r.ok) return setNotice({ tone: "error", text: r.error });
      setEditing({ id: r.data.id, name: r.data.name, content: r.data.content, original: r.data.content });
    });
  }

  function save() {
    if (!editing) return;
    setNotice(null);
    startTransition(async () => {
      const r = await saveAiKnowledgeFile({ id: editing.id, name: editing.name, content: editing.content });
      if (!r.ok) return setNotice({ tone: "error", text: r.error });
      setNotice({ tone: "success", text: `Saved ${editing.name} — the AI answers from the new version now.` });
      setEditing(null);
      router.refresh();
    });
  }

  async function remove(file: KnowledgeFileRow) {
    if (!(await confirmAction({ title: `Delete ${file.name}?`, message: "Deskzo AI and the inbox's bot stop answering from it. It can't be brought back — keep a copy if you may want it again.", confirmLabel: "Delete" }))) return;
    setNotice(null);
    startTransition(async () => {
      const r = await deleteAiKnowledgeFile(file.id);
      if (!r.ok) return setNotice({ tone: "error", text: r.error });
      if (editing?.id === file.id) setEditing(null);
      setNotice({ tone: "success", text: `Deleted ${file.name}.` });
      router.refresh();
    });
  }

  function setForCustomers(file: KnowledgeFileRow, on: boolean) {
    setNotice(null);
    startTransition(async () => {
      const r = await setAiKnowledgeForCustomers({ id: file.id, on });
      if (!r.ok) return setNotice({ tone: "error", text: r.error });
      setNotice({ tone: "success", text: on ? `The website chat may answer visitors from ${file.name} now.` : `The website chat no longer answers visitors from ${file.name}.` });
      router.refresh();
    });
  }

  function trySearch() {
    const q = question.trim();
    if (!q) return;
    setNotice(null);
    startTransition(async () => {
      const r = await tryAiKnowledgeSearch(q);
      if (!r.ok) return setNotice({ tone: "error", text: r.error });
      setFound({ question: q, hits: r.data });
    });
  }

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader className="flex flex-wrap items-start justify-between gap-2">
          <div>
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text">
              <Upload className="h-4 w-4 text-brand" aria-hidden="true" />
              Upload files
            </h2>
            <p className="mt-0.5 text-xs text-muted">
              Choose several .md or .txt files at once, or one .zip of them — folders inside it are kept in the names. A file with the same name as one here
              replaces it. Each file is cut at its headings into pieces of about 800 characters, and those pieces are what the AI is given.
            </p>
          </div>
          <div>
            <input
              ref={input}
              id="ai-knowledge-files"
              type="file"
              multiple
              accept=".md,.markdown,.txt,.zip,text/markdown,text/plain,application/zip"
              className="sr-only"
              onChange={(e) => void upload(e.target.files)}
            />
            <Button size="sm" onClick={() => input.current?.click()} disabled={uploading || pending}>
              <Upload className="h-3.5 w-3.5" />
              {uploading ? "Uploading…" : "Choose files"}
            </Button>
          </div>
        </CardHeader>
      </Card>

      <div aria-live="polite">{notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}</div>

      {editing && (
        <Card>
          <CardHeader>
            <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text">
              <Pencil className="h-4 w-4 text-brand" aria-hidden="true" />
              Edit {editing.name}
            </h2>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="ai-knowledge-name">Name</Label>
              <Input id="ai-knowledge-name" value={editing.name} maxLength={200} onChange={(e) => setEditing({ ...editing, name: e.target.value })} />
              <p className="text-xs text-muted">Ends in .md for a file read for its headings (# Title, ## Question…), or .txt for plain text.</p>
            </div>
            <div className="space-y-1">
              <Label htmlFor="ai-knowledge-content">Text</Label>
              <Textarea
                id="ai-knowledge-content"
                rows={18}
                className="font-mono text-xs"
                value={editing.content}
                onChange={(e) => setEditing({ ...editing, content: e.target.value })}
              />
              <p className="text-xs text-muted">{number(editing.content.length)} characters. Saved, it&apos;s cut into pieces again, and the AI answers from the new text at once.</p>
            </div>
            <div className="flex gap-2">
              <Button size="sm" onClick={save} disabled={pending}>
                {pending ? "Saving…" : "Save"}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={pending}
                onClick={async () => {
                  if (editing.content !== editing.original && !(await confirmAction({ title: "Discard your changes?", message: "What you've typed since opening the file is lost.", confirmLabel: "Discard" }))) return;
                  setEditing(null);
                }}
              >
                Cancel
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text">
            <Search className="h-4 w-4 text-brand" aria-hidden="true" />
            What would the AI find?
          </h2>
          <p className="mt-0.5 text-xs text-muted">Ask a question the way a colleague would. You see exactly the pieces Deskzo AI is given for it — the best five, at most 4,000 characters in all.</p>
        </CardHeader>
        <CardContent className="space-y-3">
          <form
            className="flex flex-col gap-2 sm:flex-row"
            onSubmit={(e) => {
              e.preventDefault();
              trySearch();
            }}
          >
            <Input aria-label="A question" value={question} maxLength={200} onChange={(e) => setQuestion(e.target.value)} placeholder="How do I add a lead?" />
            <Button type="submit" size="md" variant="secondary" disabled={pending || question.trim().length < 2}>
              Search
            </Button>
          </form>
          {found &&
            (found.hits.length ? (
              <ol className="space-y-2">
                {found.hits.map((hit, i) => (
                  <li key={`${hit.file}-${i}`} className="rounded-base border border-line bg-surface-sunken p-2.5">
                    <p className="text-xs font-medium text-text">
                      {i + 1}. {hit.file}
                      {hit.heading && <span className="font-normal text-muted"> › {hit.heading}</span>}
                    </p>
                    <p className="mt-1 line-clamp-4 whitespace-pre-line text-xs text-muted">{hit.text}</p>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-xs text-muted">Nothing in AI Knowledge matches “{found.question}”. Deskzo AI would say it doesn&apos;t know, rather than guess.</p>
            ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-wrap items-center justify-between gap-2">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text">
            <BookOpen className="h-4 w-4 text-brand" aria-hidden="true" />
            {files.length ? `${number(files.length)} file${files.length === 1 ? "" : "s"} · ${number(chunks)} pieces` : "No files yet"}
          </h2>
          {files.length > 0 && (
            <Input aria-label="Find a file" className="sm:w-64" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Find a file by its name or title" />
          )}
        </CardHeader>
        <CardContent>
          {files.length > 0 && (
            <p className="mb-2 text-xs text-muted">
              {files.some((f) => f.forCustomers === null)
                ? "This workspace is being updated, so files can't be marked for the website chat yet — try again in a few minutes. Until then the chat bot uses none of them."
                : `The chat bot on your website answers visitors only from files with “Website chat may use this” on — ${number(forChat)} of ${number(files.length)} now. Your own team's Deskzo AI reads every file.`}
            </p>
          )}
          {!files.length ? (
            <p className="text-sm text-muted">Upload your guides above. Until there are some, Deskzo AI answers from your data alone.</p>
          ) : !shown.length ? (
            <p className="text-sm text-muted">No file&apos;s name or title has “{filter}”.</p>
          ) : (
            <ul className="divide-y divide-line">
              {shown.map((file) => (
                <li key={file.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2">
                  <FileText className="h-4 w-4 shrink-0 text-subtle" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-text">{file.name}</p>
                    <p className="truncate text-xs text-muted">
                      {file.title ? `${file.title} · ` : ""}
                      {number(file.chars)} characters, {number(file.chunks)} piece{file.chunks === 1 ? "" : "s"} · {clock.dateTime(file.updatedAt)}
                      {file.updatedBy ? `, ${file.updatedBy}` : ""}
                    </p>
                  </div>
                  {file.forCustomers !== null && (
                    <label className="flex items-center gap-1.5 text-xs text-text" title="The chat bot on your website answers visitors only from files with this on.">
                      <input type="checkbox" checked={file.forCustomers} disabled={pending} onChange={(e) => setForCustomers(file, e.target.checked)} />
                      Website chat may use this
                    </label>
                  )}
                  <div className="flex gap-1">
                    <Button size="sm" variant="ghost" onClick={() => open(file)} disabled={pending} aria-label={`Edit ${file.name}`}>
                      <Pencil className="h-3.5 w-3.5" />
                      Edit
                    </Button>
                    <Button size="sm" variant="ghost" onClick={() => void remove(file)} disabled={pending} aria-label={`Delete ${file.name}`}>
                      <Trash2 className="h-3.5 w-3.5" />
                      Delete
                    </Button>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
