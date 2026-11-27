"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { bulkMergeDuplicates, bulkMergePreview } from "@/actions/company-merge";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";

/**
 * Merges the pairs a person needn't weigh, in one go (owner, 13 Nov 2026 — src/lib/companies/bulk-merge.ts): the same
 * GSTIN or PAN with no orders, documents, payments or ledger entries on either. It runs batch after batch until none
 * are left, showing how far it has got; the rest stay on the list for a person.
 *
 * Security audit round three, 14 Nov 2026 (R3-24): it was one confirm for the whole workspace. Now the first press
 * asks the server what it would merge (the count, and how many today's limit still allows) and shows it; the person
 * types the workspace's name to go ahead, and the server checks that name on every batch.
 */
export function BulkMergeButton({ count }: { count: number }) {
  const router = useRouter();
  const [preview, setPreview] = useState<{ count: number; confirmWith: string; perCall: number; leftToday: number } | null>(null);
  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState(false);
  const [merged, setMerged] = useState(0);
  const [skipped, setSkipped] = useState<{ name: string; why: string }[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  async function ask() {
    setError(null);
    const r = await bulkMergePreview();
    if (!r.ok) {
      setError(r.error);
      return;
    }
    setPreview(r.data);
    setTyped("");
  }

  async function run() {
    if (!preview) return;
    setRunning(true);
    setError(null);
    setDone(false);
    let total = 0;
    const passed: { name: string; why: string }[] = [];
    // Batch after batch until a batch merges nothing: what's left then is for a person.
    for (;;) {
      const r = await bulkMergeDuplicates({ confirm: typed });
      if (!r.ok) {
        setError(r.error);
        break;
      }
      total += r.data.merged;
      passed.push(...r.data.skipped);
      setMerged(total);
      setSkipped([...passed]);
      if (r.data.merged === 0 || r.data.left <= 0) break;
    }
    setRunning(false);
    setDone(true);
    setPreview(null);
    router.refresh();
  }

  if (count === 0 && !done) return null;
  const typedRight = preview !== null && typed.trim().replace(/\s+/g, " ").toLowerCase() === preview.confirmWith.trim().replace(/\s+/g, " ").toLowerCase();
  return (
    <Card className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
      <div className="min-w-0 flex-1">
        {running ? (
          <p className="text-text">Merging… {merged.toLocaleString("en-IN")} done so far. Keep this page open.</p>
        ) : done ? (
          <p className="text-text">
            {merged.toLocaleString("en-IN")} pair{merged === 1 ? "" : "s"} merged.
            {skipped.length > 0 && ` ${skipped.length} left for a person: ${skipped.slice(0, 3).map((s) => s.name).join(", ")}${skipped.length > 3 ? "…" : ""}.`}
          </p>
        ) : preview ? (
          <div className="space-y-2">
            <p className="text-text">
              <span className="font-medium">{preview.count.toLocaleString("en-IN")}</span> pair{preview.count === 1 ? "" : "s"} would be merged
              {preview.count > preview.leftToday ? ` — ${preview.leftToday.toLocaleString("en-IN")} today, the most a day takes; the rest tomorrow` : ""}. In each, the company with more under it stays; its blanks are
              filled from the other and the people both have are combined. The account manager, caller, credit limit, terms and name stay the kept one&apos;s, and
              whoever looks after them is told. <span className="font-medium">A merge can&apos;t be undone.</span>
            </p>
            <label className="block text-xs text-muted">
              Type the workspace&apos;s name, <span className="font-medium text-text">{preview.confirmWith}</span>, to go ahead
              <Input className="mt-1 max-w-xs" value={typed} onChange={(e) => setTyped(e.target.value)} autoComplete="off" />
            </label>
          </div>
        ) : (
          <p className="text-text">
            <span className="font-medium">{count.toLocaleString("en-IN")}</span> pair{count === 1 ? "" : "s"} can be merged together — the same GSTIN or PAN, and no orders,
            documents, payments or ledger entries on either. The rest, a matching name alone included, need a person.
          </p>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
      {!done &&
        (preview ? (
          <div className="flex gap-2">
            <Button size="sm" variant="ghost" disabled={running} onClick={() => setPreview(null)}>
              Cancel
            </Button>
            <Button size="sm" variant="danger" disabled={running || !typedRight || preview.count === 0 || preview.leftToday === 0} onClick={run}>
              {running ? "Merging…" : `Merge ${Math.min(preview.count, preview.leftToday).toLocaleString("en-IN")} pair${Math.min(preview.count, preview.leftToday) === 1 ? "" : "s"}`}
            </Button>
          </div>
        ) : (
          <Button size="sm" disabled={running} onClick={ask}>
            {`Merge ${count.toLocaleString("en-IN")} pair${count === 1 ? "" : "s"}…`}
          </Button>
        ))}
    </Card>
  );
}
