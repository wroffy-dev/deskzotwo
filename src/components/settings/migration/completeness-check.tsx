"use client";

import { useState, useTransition } from "react";
import { ListChecks } from "lucide-react";
import { checkZohoCompleteness } from "@/actions/zoho";
import type { Completeness, CompletenessRow } from "@/lib/zoho/completeness";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/card";

const TONE: Record<CompletenessRow["state"], "green" | "amber" | "red" | "default" | "blue"> = {
  match: "green",
  behind: "amber",
  missing: "red",
  ahead: "blue",
  "open-only": "default",
  unknown: "default",
};
const WORDS: Record<CompletenessRow["state"], string> = {
  match: "Matches",
  behind: "Behind",
  missing: "Not in yet",
  ahead: "More here",
  "open-only": "Open only",
  unknown: "No count",
};

/**
 * "Is everything in?" (owner, 20 Nov 2026 — src/lib/zoho/completeness.ts): Zoho's count of each kind for the year beside
 * what Deskzo imported, what's waiting or failed, and what to do where they differ. Counted when pressed; changes nothing.
 */
export function CompletenessCheck() {
  const [result, setResult] = useState<Completeness | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const check = () =>
    start(async () => {
      setError(null);
      const r = await checkZohoCompleteness();
      if (!r.ok) return setError(r.error);
      setResult(r.data);
    });
  const fmt = (n: number | null) => (n === null ? "—" : n.toLocaleString("en-IN"));
  return (
    <div className="space-y-2 rounded-base border border-line p-3 text-sm">
      <div className="flex flex-wrap items-center gap-3">
        <ListChecks className="h-4 w-4 text-brand" aria-hidden="true" />
        <span className="min-w-0 flex-1">
          <span className="block font-medium text-text">Is everything in?</span>
          <span className="block text-xs text-muted">
            Zoho&apos;s count of each kind for the year so far, beside what Deskzo has now — drafts, voids, rejected and unapproved left out, as the switch
            leaves them. About 15 of Zoho&apos;s calls, and one more for every 200 invoices, credit notes, bills, customers, vendors and items; changes nothing.
          </span>
        </span>
        <Button size="sm" variant="secondary" disabled={pending} onClick={check}>
          {pending ? "Counting…" : result ? "Check again" : "Check"}
        </Button>
      </div>
      {error && <p className="text-xs text-danger">{error}</p>}
      {result && (
        <>
          <p className={`text-xs ${result.behind ? "text-warning" : "text-success"}`}>
            {result.behind ? `${result.behind} ${result.behind === 1 ? "kind isn't" : "kinds aren't"} all in yet — see below.` : "Everything Zoho counts for the year is here."}
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-left text-subtle">
                  <th className="py-1 pr-3 font-medium">Kind</th>
                  <th className="py-1 pr-3 text-right font-medium">In Zoho</th>
                  <th className="py-1 pr-3 text-right font-medium">In Deskzo</th>
                  <th className="py-1 pr-3 font-medium">State</th>
                  <th className="py-1 font-medium">What to do</th>
                </tr>
              </thead>
              <tbody>
                {result.rows.map((r) => (
                  <tr key={r.key} className="border-t border-line align-top">
                    <td className="py-1.5 pr-3 text-text">{r.label}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-text">{fmt(r.zoho)}</td>
                    <td className="py-1.5 pr-3 text-right tabular-nums text-text">
                      {fmt(r.deskzo)}
                      {!!r.archived && <span className="block text-[11px] text-subtle">{r.archived.toLocaleString("en-IN")} in Earlier years</span>}
                      {(r.waiting > 0 || r.failed > 0) && (
                        <span className="block text-[11px] text-warning">
                          {[r.waiting ? `${r.waiting} waiting` : null, r.failed ? `${r.failed} failed` : null].filter(Boolean).join(" · ")}
                        </span>
                      )}
                    </td>
                    <td className="py-1.5 pr-3">
                      <Badge tone={TONE[r.state]}>{WORDS[r.state]}</Badge>
                    </td>
                    <td className="py-1.5 text-muted">
                      {r.note}
                      {r.missing && r.missing.length > 0 && (
                        <details className="mt-1">
                          <summary className="cursor-pointer text-[11px] text-subtle hover:text-text">
                            {r.missing.length < (r.zoho ?? 0) - r.deskzo ? `The first ${r.missing.length}` : "Which ones"}
                          </summary>
                          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-[11px] text-text">
                            {r.missing.map((n) => (
                              <li key={n}>{n}</li>
                            ))}
                          </ul>
                        </details>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-subtle">Counted {new Date(result.checkedAt).toLocaleString("en-IN")} · {result.calls} of Zoho&apos;s calls.</p>
        </>
      )}
    </div>
  );
}
