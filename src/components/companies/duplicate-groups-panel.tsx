"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { controlGstinMerge, getDuplicateBreakdown, mergeJobProgress, startGstinMerge } from "@/actions/company-dedupe";
import { GROUP_LABELS, type DuplicateGroup } from "@/lib/companies/duplicate-groups";
import type { DuplicateBreakdown, MergeJobView } from "@/lib/companies/gstin-merge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

const ORDER: DuplicateGroup[] = ["gstin", "pan", "corroborated", "weak"];
const n = (x: number) => x.toLocaleString("en-IN");

/**
 * The duplicate list sorted into what to do with it, and the ones sharing a GSTIN merged in the background (owner,
 * 14 Nov 2026 — src/lib/companies/gstin-merge.ts). Read after the page opens: it goes through every company again.
 */
export function DuplicateGroupsPanel() {
  const router = useRouter();
  const [data, setData] = useState<{ breakdown: DuplicateBreakdown; job: MergeJobView | null; confirmWith: string } | null>(null);
  const [job, setJob] = useState<MergeJobView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [typed, setTyped] = useState("");
  const [busy, setBusy] = useState(false);
  const wasRunning = useRef(false);

  const load = useCallback(async () => {
    const r = await getDuplicateBreakdown();
    if (!r.ok) return setError(r.error);
    setData(r.data);
    setJob(r.data.job);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // While it runs, how far it has got, every few seconds — which also sets it going again if its process stopped.
  useEffect(() => {
    if (job?.status !== "RUNNING") {
      if (wasRunning.current) {
        wasRunning.current = false;
        void load();
        router.refresh();
      }
      return;
    }
    wasRunning.current = true;
    const timer = setInterval(async () => {
      const r = await mergeJobProgress();
      if (r.ok) setJob(r.data);
    }, 3000);
    return () => clearInterval(timer);
  }, [job?.status, load, router]);

  const start = async () => {
    setBusy(true);
    setError(null);
    const r = await startGstinMerge({ confirm: typed });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setAsking(false);
    setTyped("");
    setJob(r.data);
  };

  const control = async (to: "PAUSED" | "RUNNING" | "STOPPED") => {
    if (!job) return;
    setBusy(true);
    const r = await controlGstinMerge({ jobId: job.id, to });
    setBusy(false);
    if (!r.ok) return setError(r.error);
    setJob(r.data);
  };

  if (!data) {
    return (
      <Card>
        <CardContent className="py-3 text-sm text-muted">{error ?? "Sorting the pairs into groups…"}</CardContent>
      </Card>
    );
  }

  const { breakdown } = data;
  const open = job && (job.status === "RUNNING" || job.status === "PAUSED");
  const pct = job && job.total > 0 ? Math.round((job.done / job.total) * 100) : 0;

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">
        {n(breakdown.total)} pairs among {n(breakdown.scanned)} companies, in four groups
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <ul className="divide-y divide-line rounded-base border border-line">
          {ORDER.map((g) => (
            <li key={g} className="flex flex-wrap items-start justify-between gap-3 px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="font-medium text-text">
                  {GROUP_LABELS[g].letter} · {GROUP_LABELS[g].title} — {n(breakdown.groups[g])} pair{breakdown.groups[g] === 1 ? "" : "s"}
                </p>
                <p className="text-xs text-muted">{GROUP_LABELS[g].detail}</p>
              </div>
              {g === "gstin" && breakdown.gstinMerges > 0 && !open && (
                <Button size="sm" onClick={() => setAsking(true)} disabled={busy}>
                  Merge {n(breakdown.gstinMerges)} in the background
                </Button>
              )}
              {g !== "gstin" && breakdown.groups[g] > 0 && (
                <Link href={`/companies/duplicates?group=${g}`} className="text-xs font-medium text-brand hover:underline">
                  Show these pairs
                </Link>
              )}
            </li>
          ))}
        </ul>

        {asking && !open && (
          <div className="space-y-2 rounded-base border border-warning/40 bg-warning-bg p-3">
            <p className="text-text">
              {n(breakdown.gstinMerges)} companies will be merged into {n(breakdown.gstinKept)}, each into the one sharing its GSTIN with the most under it.
              Their orders, invoices, payments, people and history move to the one kept, and their old links open it. A merge can&apos;t be undone.
            </p>
            <p className="text-xs text-muted">
              It runs in the background — you can leave this page, pause it or stop it. A pair a merge can&apos;t take (a reseller&apos;s customer and
              your own, say) is left on the list with why.
            </p>
            <label className="block space-y-1">
              <span className="text-xs text-muted">
                Type <span className="font-medium text-text">{data.confirmWith}</span> to start
              </span>
              <Input value={typed} onChange={(e) => setTyped(e.target.value)} className="max-w-sm" autoComplete="off" />
            </label>
            <div className="flex gap-2">
              <Button size="sm" onClick={start} disabled={busy || typed.trim() === ""}>
                Start merging
              </Button>
              <Button size="sm" variant="secondary" onClick={() => setAsking(false)} disabled={busy}>
                Cancel
              </Button>
            </div>
          </div>
        )}

        {job && (
          <div className="space-y-2 rounded-base border border-line p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="font-medium text-text">
                {job.status === "RUNNING" && `Merging companies that share a GSTIN — ${n(job.done)} of ${n(job.total)}`}
                {job.status === "PAUSED" && `Paused at ${n(job.done)} of ${n(job.total)}`}
                {job.status === "DONE" && `Done: ${n(job.merged)} merged`}
                {job.status === "STOPPED" && `Stopped at ${n(job.done)} of ${n(job.total)}: ${n(job.merged)} merged`}
                {job.status === "FAILED" && `Stopped by an error at ${n(job.done)} of ${n(job.total)}`}
              </p>
              {open && (
                <div className="flex gap-2">
                  {job.status === "RUNNING" ? (
                    <Button size="sm" variant="secondary" onClick={() => control("PAUSED")} disabled={busy}>
                      Pause
                    </Button>
                  ) : (
                    <Button size="sm" onClick={() => control("RUNNING")} disabled={busy}>
                      Carry on
                    </Button>
                  )}
                  <Button size="sm" variant="secondary" onClick={() => control("STOPPED")} disabled={busy}>
                    Stop
                  </Button>
                </div>
              )}
            </div>
            {open && (
              <div className="h-2 overflow-hidden rounded-full bg-surface-sunken" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
                <div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} />
              </div>
            )}
            <p className="text-xs text-muted">
              {n(job.merged)} merged{job.skipped > 0 ? `, ${n(job.skipped)} left for a person` : ""}.
              {job.error ? ` ${job.error}` : ""}
            </p>
            {job.notes.length > 0 && (
              <details className="text-xs text-muted">
                <summary className="cursor-pointer">Why {job.notes.length === 1 ? "one was" : "some were"} left</summary>
                <ul className="mt-1 space-y-0.5">
                  {job.notes.slice(0, 50).map((x, i) => (
                    <li key={i}>
                      {x.name} — {x.why}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )}
        {error && <p className="text-danger">{error}</p>}
      </CardContent>
    </Card>
  );
}
