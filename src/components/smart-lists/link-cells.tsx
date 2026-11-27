"use client";

import { useContext, useEffect, useRef, useState } from "react";
import { Paperclip, Search, Upload, X } from "lucide-react";
import { toast } from "@/components/ui/toast";
import type { BoardProperty } from "@/actions/smart-list-board";
import { attachListFile, searchLinkTargets } from "@/actions/smart-list-links";
import { LIMITS } from "@/lib/smart-lists/values";
import { LinkLabels } from "@/components/smart-lists/link-labels";

/**
 * Editing a cell that links to records elsewhere, or holds files (owner, 20 Nov 2026 — Smart Lists phase 2): a search
 * of what the person may link — companies, leads, contacts, another list's rows (src/actions/smart-list-links.ts) —
 * and files attached one at a time. The server checks every choice again when the cell is saved.
 */

const panel = "min-w-72 space-y-2 rounded-base border border-brand bg-surface p-2 shadow-lg";
const WHAT: Record<string, string> = { COMPANY: "a company", LEAD: "a lead", CONTACT: "a contact", ROW: "a row" };

export function LinkPicker({ property, value, onSave, onCancel }: { property: BoardProperty; value: string[]; onSave: (ids: string[]) => void; onCancel: () => void }) {
  const { labels, learn } = useContext(LinkLabels);
  const [chosen, setChosen] = useState<string[]>(value);
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<{ q: string | null; rows: { id: string; name: string; sub: string | null }[] }>({ q: null, rows: [] });
  const ref = useRef<HTMLInputElement>(null);
  const typed = query.trim();

  useEffect(() => {
    ref.current?.focus();
  }, []);
  useEffect(() => {
    let live = true;
    const t = window.setTimeout(async () => {
      const rows = await searchLinkTargets({ propertyId: property.id, query: typed });
      if (live) setFound({ q: typed, rows });
    }, 200);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [typed, property.id]);

  const toggle = (row: { id: string; name: string }) => {
    learn({ [row.id]: { name: row.name, href: labels[row.id]?.href ?? null } });
    setChosen((c) => (c.includes(row.id) ? c.filter((x) => x !== row.id) : c.length >= LIMITS.links ? c : [...c, row.id]));
  };

  return (
    <div
      className={panel}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      {chosen.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {chosen.map((id) => (
            <span key={id} className="inline-flex items-center gap-1 rounded bg-info-bg py-0.5 pl-1.5 pr-0.5 text-xs text-info">
              {labels[id]?.name ?? "…"}
              <button type="button" aria-label={`Take ${labels[id]?.name ?? "it"} off`} className="rounded p-0.5 hover:bg-info/10" onClick={() => setChosen((c) => c.filter((x) => x !== id))}>
                <X className="h-3 w-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <label className="flex items-center gap-1.5 rounded-base border border-line px-2">
        <Search className="h-3.5 w-3.5 text-subtle" aria-hidden="true" />
        <input ref={ref} aria-label={`Find ${WHAT[property.kind] ?? "a record"}`} value={query} placeholder={`Find ${WHAT[property.kind] ?? "a record"}…`} className="h-8 w-full bg-transparent text-sm outline-none" onChange={(e) => setQuery(e.target.value)} />
      </label>
      <ul className="max-h-56 overflow-y-auto" aria-live="polite">
        {found.rows.map((r) => (
          <li key={r.id}>
            <label className="flex cursor-pointer items-center gap-2 rounded px-1.5 py-1 text-sm hover:bg-surface-sunken">
              <input type="checkbox" checked={chosen.includes(r.id)} onChange={() => toggle(r)} />
              <span className="min-w-0 flex-1 truncate text-text">{r.name}</span>
              {r.sub && <span className="shrink-0 truncate text-xs text-subtle">{r.sub}</span>}
            </label>
          </li>
        ))}
        {found.q === typed && found.rows.length === 0 && <li className="px-1.5 py-2 text-xs text-subtle">{typed ? "Nothing you can see goes by that name." : "Nothing here yet."}</li>}
      </ul>
      <div className="flex justify-end gap-1.5">
        <button type="button" className="rounded-base px-2 py-1 text-xs text-muted hover:text-text" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="rounded-base bg-brand px-2.5 py-1 text-xs font-medium text-brand-contrast" onClick={() => onSave(chosen)}>
          Done
        </button>
      </div>
    </div>
  );
}

export function FileCellEditor({ property, rowKey, value, onSave, onCancel }: { property: BoardProperty; rowKey: string; value: string[]; onSave: (ids: string[]) => void; onCancel: () => void }) {
  const { labels, learn } = useContext(LinkLabels);
  const [files, setFiles] = useState<string[]>(value);
  const [busy, setBusy] = useState(false);
  const attach = async (file: File) => {
    if (file.size > LIMITS.fileBytes) return void toast.error(`A file is ${LIMITS.fileBytes / 1024 / 1024} MB at most.`);
    setBusy(true);
    const form = new FormData();
    form.set("propertyId", property.id);
    form.set("rowKey", rowKey);
    form.set("file", file);
    const r = await attachListFile(form);
    setBusy(false);
    if (!r.ok) return void toast.error(r.error);
    const added = r.data.value.at(-1)!;
    learn({ [added]: { name: r.data.name, href: `/api/smart-lists/files/${added}` } });
    setFiles(r.data.value);
  };
  return (
    <div
      className={panel}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.preventDefault();
          onCancel();
        }
      }}
    >
      <ul className="space-y-1">
        {files.map((id) => (
          <li key={id} className="flex items-center gap-1.5 text-sm">
            <Paperclip className="h-3.5 w-3.5 shrink-0 text-subtle" aria-hidden="true" />
            {labels[id]?.href ? (
              <a href={labels[id]!.href!} target="_blank" rel="noopener noreferrer" className="min-w-0 flex-1 truncate text-brand hover:underline">
                {labels[id]!.name}
              </a>
            ) : (
              <span className="min-w-0 flex-1 truncate">{labels[id]?.name ?? "A file"}</span>
            )}
            <button type="button" aria-label={`Take ${labels[id]?.name ?? "this file"} off`} className="rounded p-0.5 text-subtle hover:text-danger" onClick={() => setFiles((f) => f.filter((x) => x !== id))}>
              <X className="h-3.5 w-3.5" />
            </button>
          </li>
        ))}
        {files.length === 0 && <li className="text-xs text-subtle">No files yet.</li>}
      </ul>
      {files.length < LIMITS.files && rowKey && (
        <label className="flex cursor-pointer items-center gap-1.5 rounded-base border border-dashed border-line px-2 py-1.5 text-xs text-muted hover:border-line-strong">
          <Upload className="h-3.5 w-3.5" aria-hidden="true" />
          {busy ? "Attaching…" : "Attach a PDF or an image (5 MB at most)"}
          <input
            type="file"
            className="sr-only"
            disabled={busy}
            accept="application/pdf,image/png,image/jpeg,image/webp"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = "";
              if (f) void attach(f);
            }}
          />
        </label>
      )}
      <p className="text-[11px] text-subtle">A file taken off is deleted when you press Done.</p>
      <div className="flex justify-end gap-1.5">
        <button type="button" className="rounded-base px-2 py-1 text-xs text-muted hover:text-text" onClick={() => onSave(files)}>
          Close
        </button>
        <button type="button" className="rounded-base bg-brand px-2.5 py-1 text-xs font-medium text-brand-contrast" onClick={() => onSave(files)}>
          Done
        </button>
      </div>
    </div>
  );
}
