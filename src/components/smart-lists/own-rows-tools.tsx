"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Download, LayoutTemplate, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Select } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { exportOwnRows, importOwnRows, readImportFile, type ImportPreview } from "@/actions/smart-list-rows";
import { saveListAsTemplate } from "@/actions/smart-list-team";
import { exportCompanyList } from "@/actions/smart-list-links";
import { KIND_LABELS, PROPERTY_KINDS, type PropertyKind } from "@/lib/smart-lists/values";
import type { ImportTarget } from "@/lib/smart-lists/own-rows-import";

/**
 * A list with rows of its own, in and out (owner, 20 Nov 2026 — "CSV import and Excel export"): a CSV or Excel file read,
 * each of its columns matched to the list's — the title, a column it has, a new column, or left out — then added; and
 * the whole list downloaded as Excel. The server reads, checks and saves (src/actions/smart-list-rows.ts).
 */

export function ExportRowsButton({ workbookId }: { workbookId: string }) {
  const [pending, start] = useTransition();
  const download = () =>
    start(async () => {
      const r = await exportOwnRows(workbookId);
      if (!r.ok) {
        toast.error(r.error);
        return;
      }
      const bytes = Uint8Array.from(atob(r.data.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: r.data.contentType }));
      const link = document.createElement("a");
      link.href = url;
      link.download = r.data.filename;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    });
  return (
    <Button variant="secondary" disabled={pending} onClick={download}>
      <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
      {pending ? "Preparing…" : "Export Excel"}
    </Button>
  );
}

export function ImportRowsButton({ workbookId }: { workbookId: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <Upload className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Import
      </Button>
      {open && <ImportDialog workbookId={workbookId} onClose={() => setOpen(false)} />}
    </>
  );
}

/** A target as the column picker holds it: "title", "skip", "col:<id>" or "new". */
type Pick = { target: string; kind: PropertyKind; name: string };

const pickOf = (m: ImportTarget, header: string): Pick =>
  m.to === "title" ? { target: "title", kind: "TEXT", name: header } : m.to === "column" ? { target: `col:${m.propertyId}`, kind: "TEXT", name: header } : m.to === "new" ? { target: "new", kind: m.kind, name: m.name } : { target: "skip", kind: "TEXT", name: header };

const targetOf = (p: Pick): ImportTarget =>
  p.target === "title" ? { to: "title" } : p.target.startsWith("col:") ? { to: "column", propertyId: p.target.slice(4) } : p.target === "new" ? { to: "new", kind: p.kind, name: p.name } : { to: "skip" };

// A new column can be anything typed in, or a link a name finds (a company, a lead, a contact) — not a Person (matched by
// name into one the list already has), files or a count.
const NEW_KINDS = PROPERTY_KINDS.filter((k) => !["PERSON", "ROW", "FILE", "ROLLUP", "FORMULA"].includes(k));

function ImportDialog({ workbookId, onClose }: { workbookId: string; onClose: () => void }) {
  const router = useRouter();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [picks, setPicks] = useState<Pick[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const read = (file: File) =>
    start(async () => {
      setError(null);
      const form = new FormData();
      form.set("workbookId", workbookId);
      form.set("file", file);
      const r = await readImportFile(form);
      if (!r.ok) return setError(r.error);
      setPreview(r.data);
      setPicks(r.data.mapping.map((m, i) => pickOf(m, r.data.headers[i] ?? "")));
    });

  const titles = picks.filter((p) => p.target === "title").length;
  const save = () =>
    start(async () => {
      if (!preview) return;
      setError(null);
      const r = await importOwnRows({ workbookId, headers: preview.headers, rows: preview.rows, mapping: picks.map(targetOf) });
      if (!r.ok) return setError(r.error);
      const d = r.data;
      const notes = [
        d.columns ? `${d.columns} new column${d.columns === 1 ? "" : "s"}` : "",
        d.noTitle ? `${d.noTitle} without a title left out` : "",
        d.overLimit ? `${d.overLimit} past the list's limit left out` : "",
        d.cellsLeftOut ? `${d.cellsLeftOut} cell${d.cellsLeftOut === 1 ? "" : "s"} that didn't fit their column left empty` : "",
      ].filter(Boolean);
      toast.success(`${d.rows.toLocaleString("en-IN")} row${d.rows === 1 ? "" : "s"} imported${notes.length ? ` — ${notes.join("; ")}` : ""}.`);
      onClose();
      router.refresh();
    });

  const sample = (i: number) => preview?.rows.find((r) => (r[i] ?? "").trim())?.[i] ?? "";

  return (
    <Dialog open onClose={onClose} title="Import rows from a spreadsheet" wide>
      <div className="space-y-4">
        {!preview ? (
          <div className="space-y-2">
            <p className="text-sm text-muted">
              A CSV or Excel (.xlsx) file, with a header row. Each row becomes a row of this list; you choose where each column goes next. Up to 2,000 rows at a time.
            </p>
            <input
              type="file"
              accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
              aria-label="Choose a file"
              disabled={pending}
              className="block w-full text-sm text-muted file:mr-3 file:rounded-base file:border file:border-line file:bg-surface file:px-3 file:py-1.5 file:text-sm file:text-text"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) read(f);
              }}
            />
            {pending && <p className="text-sm text-subtle">Reading the file…</p>}
          </div>
        ) : (
          <>
            <p className="text-sm text-muted">
              {preview.rows.length.toLocaleString("en-IN")} row{preview.rows.length === 1 ? "" : "s"} read
              {preview.cut ? ` — the first ${preview.rows.length.toLocaleString("en-IN")}; ${preview.cut.toLocaleString("en-IN")} more left for another import` : ""}. Choose where each column goes.
            </p>
            <div className="max-h-[50vh] overflow-y-auto rounded-base border border-line">
              <table className="w-full border-collapse text-sm">
                <thead className="sticky top-0 bg-surface">
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="px-3 py-2 font-medium">In the file</th>
                    <th className="px-3 py-2 font-medium">Goes to</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.headers.map((h, i) => {
                    const p = picks[i]!;
                    const set = (patch: Partial<Pick>) => setPicks((all) => all.map((x, j) => (j === i ? { ...x, ...patch } : x)));
                    return (
                      <tr key={i} className="border-b border-line align-top last:border-0">
                        <td className="max-w-56 px-3 py-2">
                          <span className="block truncate font-medium text-text">{h || `Column ${i + 1}`}</span>
                          <span className="block truncate text-xs text-subtle">{sample(i) || "empty"}</span>
                        </td>
                        <td className="space-y-1.5 px-3 py-2">
                          <Select aria-label={`Where ${h || `column ${i + 1}`} goes`} className="h-8" value={p.target} onChange={(e) => set({ target: e.target.value })}>
                            <option value="title">{preview.titleName} (each row&apos;s title)</option>
                            {preview.columns.map((c) => (
                              <option key={c.id} value={`col:${c.id}`}>
                                {c.name} — {KIND_LABELS[c.kind]}
                              </option>
                            ))}
                            <option value="new">A new column…</option>
                            <option value="skip">Leave it out</option>
                          </Select>
                          {p.target === "new" && (
                            <div className="flex gap-1.5">
                              <Input aria-label="New column's name" className="h-8" value={p.name} maxLength={60} onChange={(e) => set({ name: e.target.value })} />
                              <Select aria-label="New column's kind" className="h-8 w-40" value={p.kind} onChange={(e) => set({ kind: e.target.value as PropertyKind })}>
                                {NEW_KINDS.map((k) => (
                                  <option key={k} value={k}>
                                    {KIND_LABELS[k]}
                                  </option>
                                ))}
                              </Select>
                            </div>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {titles !== 1 && <p className="text-sm text-warning">Choose one column as each row&apos;s {preview.titleName.toLowerCase()}.</p>}
            <p className="text-xs text-subtle">A choice the file names that a Select column lacks is added to it. A cell that isn&apos;t what its column keeps — a word in a Number column — is left empty.</p>
          </>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          {preview && (
            <Button type="button" variant="ghost" onClick={() => setPreview(null)} disabled={pending}>
              Another file
            </Button>
          )}
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          {preview && (
            <Button type="button" onClick={save} disabled={pending || titles !== 1}>
              {pending ? "Importing…" : `Import ${preview.rows.length.toLocaleString("en-IN")} row${preview.rows.length === 1 ? "" : "s"}`}
            </Button>
          )}
        </div>
      </div>
    </Dialog>
  );
}

/** This list's columns and views kept as one of the company's own templates (Smart Lists phase 3) — never its rows. */
export function SaveAsTemplateButton({ workbookId, listName }: { workbookId: string; listName: string }) {
  const [open, setOpen] = useState(false);
  const [name, setName] = useState(listName);
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <>
      <Button variant="secondary" onClick={() => setOpen(true)}>
        <LayoutTemplate className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Save as template
      </Button>
      {open && (
        <Dialog open onClose={() => setOpen(false)} title="Save as a template">
          <form
            className="space-y-4"
            onSubmit={(e) => {
              e.preventDefault();
              start(async () => {
                setError(null);
                const r = await saveListAsTemplate({ workbookId, name, description });
                if (!r.ok) return setError(r.error);
                toast.success(`"${name.trim()}" is on New list for everyone now.`);
                setOpen(false);
              });
            }}
          >
            <p className="text-sm text-muted">Its columns, choices and views go into the template — never its rows. Columns that link to or count through another list are left out.</p>
            <div className="space-y-1.5">
              <label htmlFor="tpl-name" className="text-sm font-medium text-text">
                Name
              </label>
              <Input id="tpl-name" autoFocus value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <label htmlFor="tpl-what" className="text-sm font-medium text-text">
                What it&apos;s for
              </label>
              <Input id="tpl-what" value={description} maxLength={300} onChange={(e) => setDescription(e.target.value)} />
            </div>
            {error && (
              <p role="alert" className="text-sm text-danger">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2 border-t border-line pt-4">
              <Button type="button" variant="secondary" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" disabled={pending || !name.trim()}>
                {pending ? "Saving…" : "Save template"}
              </Button>
            </div>
          </form>
        </Dialog>
      )}
    </>
  );
}

/** A list of companies as Excel — for whoever may export CRM data (Smart Lists phase 3). */
export function ExportCompaniesButton({ workbookId }: { workbookId: string }) {
  const [pending, start] = useTransition();
  return (
    <Button
      variant="secondary"
      disabled={pending}
      onClick={() =>
        start(async () => {
          const r = await exportCompanyList(workbookId);
          if (!r.ok) {
            toast.error(r.error);
            return;
          }
          const bytes = Uint8Array.from(atob(r.data.base64), (c) => c.charCodeAt(0));
          const url = URL.createObjectURL(new Blob([bytes], { type: r.data.contentType }));
          const link = document.createElement("a");
          link.href = url;
          link.download = r.data.filename;
          link.style.display = "none";
          document.body.appendChild(link);
          link.click();
          link.remove();
          window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
        })
      }
    >
      <Download className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
      {pending ? "Preparing…" : "Export Excel"}
    </Button>
  );
}
