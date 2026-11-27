"use client";

import { useCallback, useEffect, useRef, useState, useTransition } from "react";
import { AlertTriangle, Download, Loader2, Upload } from "lucide-react";
import { buildLegacyMasterLists, decideLegacyMatch, legacyMasterCsv, legacyMatches, uploadLegacyMasterCsv } from "@/actions/legacy-import";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LISTS, type ListKey, type MatchRow } from "@/lib/legacy-import/lists";
import { confirmAction } from "@/components/ui/confirm";

type Counts = Record<string, Record<string, number>>;

const GROUPS = [
  { key: "matched", label: "Matched", statuses: ["MATCHED", "CONFIRMED"] },
  { key: "suggested", label: "Suggested", statuses: ["SUGGESTED"] },
  { key: "zoho", label: "Only in Zoho", statuses: ["ZOHO_ONLY"] },
  { key: "old", label: "Only in WroffyCRM", statuses: ["OLD_ONLY", "REJECTED"] },
] as const;

const n = (v: number) => v.toLocaleString("en-IN");

/** An action's answer, or its failure as a refusal — a signed-out session or a dropped connection says so here instead of taking the page down. */
async function safely<T>(call: () => Promise<{ ok: true; data: T } | { ok: false; error: string }>): Promise<{ ok: true; data: T } | { ok: false; error: string }> {
  try {
    return await call();
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "That didn't go through — reload the page." };
  }
}
const sum = (counts: Record<string, number> | undefined, statuses: readonly string[]) => statuses.reduce((t, s) => t + (counts?.[s] ?? 0), 0);

/**
 * The master lists (src/lib/legacy-import/master.ts): Zoho's customers, vendors, items and contacts beside
 * WroffyCRM's, each sorted into matched (with why), suggested (confirm or reject), only in Zoho and only in
 * WroffyCRM. Hundreds can be checked at once as a CSV: download, write a decision, upload.
 */
export function LegacyMasterLists({ importId, initialCounts }: { importId: string; initialCounts: Counts }) {
  const [counts, setCounts] = useState<Counts>(initialCounts);
  const [notes, setNotes] = useState<string[]>([]);
  const [list, setList] = useState<ListKey>("customers");
  // A list opens on what needs deciding, when there is any.
  const firstGroup = (c: Counts, key: ListKey) => ((c[key]?.SUGGESTED ?? 0) > 0 ? "suggested" : "matched");
  const [group, setGroup] = useState<(typeof GROUPS)[number]["key"]>(firstGroup(initialCounts, "customers"));
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [rows, setRows] = useState<MatchRow[]>([]);
  const [total, setTotal] = useState(0);
  const [pending, start] = useTransition();
  const [message, setMessage] = useState<string | null>(null);
  const upload = useRef<HTMLInputElement>(null);
  const built = Object.keys(counts).length > 0;

  const load = useCallback(() => {
    if (!built) return;
    start(async () => {
      const r = await safely(async () => legacyMatches(importId, list, group, query, page));
      if (r.ok) {
        setRows(r.data.rows);
        setTotal(r.data.total);
      } else setMessage(r.error);
    });
  }, [built, importId, list, group, query, page]);

  useEffect(() => {
    load();
  }, [load]);

  const build = () =>
    start(async () => {
      setMessage(null);
      const r = await safely(async () => buildLegacyMasterLists(importId));
      if (!r.ok) return setMessage(r.error);
      setCounts(r.data.counts);
      setNotes(r.data.notes);
      setPage(0);
    });

  const decide = (id: string, decision: "confirm" | "reject") =>
    start(async () => {
      const r = await safely(async () => decideLegacyMatch(importId, id, decision));
      if (!r.ok) return setMessage(r.error);
      setCounts(r.data);
      const again = await safely(async () => legacyMatches(importId, list, group, query, page));
      if (again.ok) {
        setRows(again.data.rows);
        setTotal(again.data.total);
      }
    });

  const download = () =>
    start(async () => {
      const r = await safely(async () => legacyMasterCsv(importId, list));
      if (!r.ok) return setMessage(r.error);
      const url = URL.createObjectURL(new Blob([r.data.csv], { type: "text/csv;charset=utf-8" }));
      const a = document.createElement("a");
      a.href = url;
      a.download = r.data.filename;
      a.click();
      URL.revokeObjectURL(url);
    });

  const uploadCsv = (file: File | undefined) => {
    if (!file) return;
    start(async () => {
      const text = await file.text();
      const r = await safely(async () => uploadLegacyMasterCsv(importId, list, text));
      if (upload.current) upload.current.value = "";
      if (!r.ok) return setMessage(r.error);
      setCounts(r.data.counts);
      setMessage(`From the file: ${r.data.confirmed} confirmed, ${r.data.rejected} split, ${r.data.paired} paired by hand.`);
      load();
    });
  };

  const current = counts[list];
  return (
    <Card className="overflow-hidden p-0">
      <div className="flex flex-wrap items-start justify-between gap-3 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-medium text-text">Master lists — Zoho beside WroffyCRM</h2>
          <p className="mt-0.5 max-w-3xl text-xs text-muted">
            Each company comes in once, with both old ids. Matched by the same GSTIN, else the same PAN in another state (a branch), else the same name; an email domain,
            phone or similar name is only suggested. Settle the suggestions before anything is imported.
          </p>
        </div>
        <Button type="button" size="sm" variant={built ? "secondary" : "primary"} disabled={pending} onClick={async () => (!built || await confirmAction("Build the lists again? Decisions made on them are replaced.")) && build()}>
          {pending && !built ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {built ? "Build again" : "Build the master lists"}
        </Button>
      </div>
      {notes.length > 0 && (
        <div className="border-b border-line bg-danger-bg px-4 py-2 text-xs text-danger">
          {notes.map((note) => (
            <p key={note} className="flex items-start gap-1.5">
              <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
              {note}
            </p>
          ))}
        </div>
      )}
      {message && <p className="border-b border-line px-4 py-2 text-xs text-muted">{message}</p>}
      {built && (
        <>
          <div className="flex flex-wrap gap-1 border-b border-line px-4 pt-3">
            {LISTS.map((l) => {
              const c = counts[l.key];
              const open = sum(c, ["SUGGESTED"]);
              return (
                <button
                  key={l.key}
                  type="button"
                  onClick={() => {
                    setList(l.key);
                    setGroup(firstGroup(counts, l.key));
                    setQuery("");
                    setPage(0);
                  }}
                  className={`rounded-t-base border-b-2 px-3 py-2 text-sm ${list === l.key ? "border-brand font-medium text-text" : "border-transparent text-muted hover:text-text"}`}
                >
                  {l.label}
                  {open > 0 && <span className="ml-1.5 rounded-full bg-warning-bg px-1.5 text-xs text-warning">{n(open)}</span>}
                </button>
              );
            })}
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3">
            <div className="flex flex-wrap gap-1.5">
              {GROUPS.map((g) => (
                <button
                  key={g.key}
                  type="button"
                  onClick={() => {
                    setGroup(g.key);
                    setPage(0);
                  }}
                  className={`rounded-full border px-3 py-1 text-xs ${group === g.key ? "border-brand bg-brand/10 text-text" : "border-line text-muted hover:text-text"}`}
                >
                  {g.label} <span className="tabular-nums">{n(sum(current, g.statuses))}</span>
                </button>
              ))}
              {list === "contacts" && (current?.FLAGGED ?? 0) > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    setGroup("matched");
                    setQuery("flagged");
                    setPage(0);
                  }}
                  className="rounded-full border border-warning/40 px-3 py-1 text-xs text-warning"
                >
                  By name only {n(current!.FLAGGED!)}
                </button>
              )}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Input
                className="h-8 w-52"
                placeholder="Search by name or GSTIN"
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setPage(0);
                }}
              />
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={download}>
                <Download className="mr-1.5 h-3.5 w-3.5" />
                CSV
              </Button>
              <input ref={upload} type="file" accept=".csv" className="hidden" onChange={(e) => uploadCsv(e.target.files?.[0])} />
              <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => upload.current?.click()} title="Upload the CSV back with confirm, reject or pair in its Decision column">
                <Upload className="mr-1.5 h-3.5 w-3.5" />
                Upload decisions
              </Button>
            </div>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-y border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-4 py-2">Zoho</th>
                  <th className="px-4 py-2">WroffyCRM</th>
                  <th className="px-4 py-2">Why</th>
                  <th className="px-4 py-2" />
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} className="border-b border-line align-top last:border-0">
                    <td className="px-4 py-2 text-text">{r.zohoLabel ?? <span className="text-subtle">—</span>}</td>
                    <td className="px-4 py-2 text-text">
                      {r.oldLabel ?? <span className="text-subtle">—</span>}
                      {r.company && <span className="block text-xs text-muted">at {r.company}</span>}
                    </td>
                    <td className={`px-4 py-2 text-xs ${r.flagged || r.status === "SUGGESTED" ? "text-warning" : "text-muted"}`}>{r.reason}</td>
                    <td className="whitespace-nowrap px-4 py-2 text-right">
                      {r.status === "SUGGESTED" && (
                        <>
                          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => decide(r.id, "confirm")}>
                            Same
                          </Button>{" "}
                        </>
                      )}
                      {(r.status === "SUGGESTED" || r.status === "MATCHED" || r.status === "CONFIRMED") && r.zohoId && r.oldId && (
                        <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => decide(r.id, "reject")}>
                          Not the same
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
                {rows.length === 0 && (
                  <tr>
                    <td colSpan={4} className="px-4 py-6 text-center text-xs text-subtle">
                      {pending ? "Reading…" : "Nothing here."}
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {total > 50 && (
            <div className="flex items-center justify-between border-t border-line px-4 py-2 text-xs text-muted">
              <span>
                {n(page * 50 + 1)}–{n(Math.min(total, (page + 1) * 50))} of {n(total)}
              </span>
              <span className="flex gap-2">
                <Button type="button" size="sm" variant="ghost" disabled={pending || page === 0} onClick={() => setPage(page - 1)}>
                  Previous
                </Button>
                <Button type="button" size="sm" variant="ghost" disabled={pending || (page + 1) * 50 >= total} onClick={() => setPage(page + 1)}>
                  Next
                </Button>
              </span>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
