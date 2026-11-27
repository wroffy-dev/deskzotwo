"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "@/components/ui/toast";
import { Input } from "@/components/ui/input";
import { guestSetCell } from "@/actions/connect-public";
import { CellEditor, CellValue } from "@/components/smart-lists/cells";
import type { GuestColumn, GuestListView } from "@/lib/connect/guest-lists";
import { PanelRightOpen, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { GuestRowPage } from "@/components/connect/guest-row-page";
import { SuggestCompanyDialog } from "@/components/connect/suggest-company-dialog";
import { ScrollX } from "@/components/ui/scroll-x";

/**
 * `preview` (owner, 20 Nov 2026): an admin seeing what this guest sees — the same table, its links under `base`, and
 * nothing that changes anything: no cell, no suggestion, no comment.
 *
 * A shared Smart List as the guest works it (owner, 20 Nov 2026 — src/lib/connect): the companies, the columns marked
 * for guests, and in-place editing of the ones marked editable. The server checks every change again.
 */
export function GuestListTable({ view, search, page, hasOthers, preview }: { view: GuestListView; search: string; page: number; hasOthers: boolean; preview?: { guestId: string; base: string } }) {
  const router = useRouter();
  const [values, setValues] = useState(view.values);
  const [from, setFrom] = useState(view.values);
  if (from !== view.values) {
    setFrom(view.values);
    setValues(view.values);
  }
  const [editing, setEditing] = useState<{ row: string; col: string } | null>(null);
  const [q, setQ] = useState(search);
  const [open, setOpen] = useState<{ id: string; name: string; place: string } | null>(null);
  const [suggesting, setSuggesting] = useState(false);
  const waiting = view.suggestions.filter((s) => s.kind === "NEW_COMPANY" && s.status === "PENDING");
  const decided = view.suggestions.filter((s) => s.status !== "PENDING").slice(0, 8);
  const STATUS: Record<string, string> = { LINKED: "Added to the list", CREATED: "Added to the list", ACCEPTED: "Correction made", DECLINED: "Not added" };
  const names = useMemo(() => new Map(view.people.map((p) => [p.id, p.name])), [view.people]);
  const pages = Math.max(1, Math.ceil(view.total / 100));

  const save = async (companyId: string, col: GuestColumn, raw: unknown) => {
    const before = values;
    setValues((v) => ({ ...v, [companyId]: { ...(v[companyId] ?? {}), [col.id]: raw === "" ? null : raw } }));
    const r = await guestSetCell({ shareId: view.share.id, propertyId: col.id, companyId, value: raw });
    if (!r.ok) {
      setValues(before);
      toast.error(r.error);
      if (/signed out|isn't shared/.test(r.error)) router.refresh();
      return;
    }
    setValues((v) => ({ ...v, [companyId]: { ...(v[companyId] ?? {}), [col.id]: r.value } }));
  };

  const go = (next: { q?: string; page?: number }) => {
    const params = new URLSearchParams();
    const qq = next.q ?? q;
    if (qq.trim()) params.set("q", qq.trim());
    if ((next.page ?? 1) > 1) params.set("page", String(next.page));
    router.push(`${preview ? preview.base : "/connect"}/${view.share.id}${params.size ? `?${params}` : ""}`);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          {hasOthers && (
            <Link href={preview ? preview.base : "/connect"} className="text-sm text-muted hover:text-text">
              ← Shared with you
            </Link>
          )}
          <h1 className="text-xl font-semibold text-text">{view.share.listName}</h1>
          <p className="mt-0.5 text-sm text-muted">
            {view.own ? `${view.total.toLocaleString("en-IN")} row${view.total === 1 ? "" : "s"}` : `${view.total.toLocaleString("en-IN")} compan${view.total === 1 ? "y" : "ies"}`}
            {view.share.sharedBy ? ` · shared by ${view.share.sharedBy}` : ""}
            {view.share.until ? ` · until ${new Date(view.share.until).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}` : ""}
          </p>
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            go({ q, page: 1 });
          }}
        >
          <div className="flex flex-wrap gap-2">
            <Input type="search" aria-label="Search this list" placeholder="Search this list…" value={q} onChange={(e) => setQ(e.target.value)} className="w-56" />
            {/* A list of its own rows takes no company suggestions (Smart Lists phase 3). */}
            {!view.own && (
              <Button type="button" onClick={() => (preview ? toast.info("View only — they'd suggest a company here.") : setSuggesting(true))}>
                <Plus className="h-3.5 w-3.5" />
                Suggest a company
              </Button>
            )}
          </div>
        </form>
      </div>

      <ScrollX underHeader={false} className="relative rounded-card border border-line bg-surface">
        <table className="w-max min-w-full border-collapse text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th scope="col" className="sticky left-0 z-[1] w-44 min-w-44 max-w-44 bg-surface px-3 py-2 font-medium sm:w-60 sm:min-w-60 sm:max-w-60">
                {view.own ? view.own.titleName : "Company"}
              </th>
              {!view.own && (
                <>
                  <th scope="col" className="min-w-32 border-l border-line px-3 py-2 font-medium">
                    Where
                  </th>
                  <th scope="col" className="min-w-32 border-l border-line px-3 py-2 font-medium">
                    Your contact
                  </th>
                </>
              )}
              {view.columns.map((c) => (
                <th key={c.id} scope="col" className="min-w-40 border-l border-line px-3 py-2 font-medium">
                  {c.name}
                  {!c.editable && <span className="ml-1 font-normal text-subtle">· read only</span>}
                </th>
              ))}
              <th scope="col" className="w-12 border-l border-line px-2 py-2">
                <span className="sr-only">Open</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {waiting.map((s) => (
              <tr key={s.id} className="border-b border-line bg-surface-sunken/70 text-muted">
                <th scope="row" className="sticky left-0 z-[1] w-44 min-w-44 max-w-44 truncate bg-surface-sunken px-3 py-1.5 text-left font-medium sm:w-60 sm:min-w-60 sm:max-w-60">
                  {s.name}
                </th>
                <td colSpan={view.columns.length + 3} className="border-l border-line px-3 py-1.5 text-xs">
                  Suggested by you · waiting for them to decide
                </td>
              </tr>
            ))}
            {view.rows.map((row) => (
              <tr key={row.id} className="border-b border-line last:border-0">
                <th scope="row" className="sticky left-0 z-[1] w-44 min-w-44 max-w-44 truncate bg-surface px-3 py-1.5 text-left font-medium text-text sm:w-60 sm:min-w-60 sm:max-w-60">
                  {row.name}
                </th>
                {!view.own && (
                  <>
                    <td className="border-l border-line px-3 py-1.5 text-muted">{row.place || "—"}</td>
                    <td className="border-l border-line px-3 py-1.5 text-muted">{view.contacts[row.id] ?? "—"}</td>
                  </>
                )}
                {view.columns.map((c) => {
                  const value = values[row.id]?.[c.id] ?? null;
                  const isEditing = editing?.row === row.id && editing.col === c.id;
                  return (
                    <td key={c.id} className="relative border-l border-line px-1 py-0.5">
                      {isEditing ? (
                        <div className={c.kind === "MULTI_SELECT" ? "absolute left-0 top-0 z-10" : ""}>
                          <CellEditor
                            property={c}
                            value={value}
                            people={view.people}
                            onCancel={() => setEditing(null)}
                            onSave={(raw) => {
                              setEditing(null);
                              void save(row.id, c, raw);
                            }}
                          />
                        </div>
                      ) : c.editable && !preview ? (
                        <button
                          type="button"
                          className="flex min-h-8 w-full items-center rounded-base px-2 text-left hover:bg-surface-sunken"
                          aria-label={`${c.name} for ${row.name}`}
                          onClick={() => (c.kind === "CHECKBOX" ? void save(row.id, c, value !== true) : setEditing({ row: row.id, col: c.id }))}
                        >
                          <CellValue property={c} value={value} people={names} />
                        </button>
                      ) : (
                        <div className="flex min-h-8 items-center px-2">
                          <CellValue property={c} value={value} people={names} />
                        </div>
                      )}
                    </td>
                  );
                })}
                <td className="border-l border-line px-1 py-1 text-center">
                  <button type="button" onClick={() => setOpen(row)} aria-label={`Open ${row.name}'s page`} title="Contact, comments, corrections" className="rounded-base p-1.5 text-subtle hover:bg-surface-sunken hover:text-text">
                    <PanelRightOpen className="h-4 w-4" />
                  </button>
                </td>
              </tr>
            ))}
            {view.rows.length === 0 && (
              <tr>
                <td colSpan={view.columns.length + 4} className="px-4 py-10 text-center text-subtle">
                  {search ? "No company in this list matches that." : "This list is empty right now."}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </ScrollX>

      {decided.length > 0 && (
        <section aria-label="Your suggestions" className="rounded-card border border-line bg-surface p-4 text-sm">
          <h2 className="mb-2 font-semibold text-text">What became of your suggestions</h2>
          <ul className="space-y-1">
            {decided.map((s) => (
              <li key={s.id} className="flex flex-wrap gap-x-2">
                <span className="font-medium text-text">{s.kind === "CORRECTION" ? "A correction" : s.name}</span>
                <span className={s.status === "DECLINED" ? "text-muted" : "text-success"}>{STATUS[s.status] ?? s.status}</span>
                {s.declineReason && <span className="text-muted">— {s.declineReason}</span>}
              </li>
            ))}
          </ul>
        </section>
      )}

      {open && <GuestRowPage shareId={view.share.id} row={open} onClose={() => setOpen(null)} previewGuestId={preview?.guestId} />}
      {suggesting && <SuggestCompanyDialog shareId={view.share.id} onClose={() => setSuggesting(false)} />}

      {pages > 1 && (
        <div className="flex items-center justify-end gap-2 text-sm">
          <button type="button" className="rounded-base border border-line px-3 py-1 disabled:opacity-40" disabled={page <= 1} onClick={() => go({ page: page - 1 })}>
            Previous
          </button>
          <span className="text-muted">
            Page {page} of {pages}
          </span>
          <button type="button" className="rounded-base border border-line px-3 py-1 disabled:opacity-40" disabled={page >= pages} onClick={() => go({ page: page + 1 })}>
            Next
          </button>
        </div>
      )}
    </div>
  );
}
