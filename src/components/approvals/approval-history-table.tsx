"use client";

import { useState } from "react";
import { CompanyLink } from "@/components/companies/company-link";
import { Download } from "lucide-react";
import { exportApprovalHistory, type ApprovalHistoryFilters, type ApprovalHistoryRow } from "@/actions/approval-history";
import { APPROVAL_DECISIONS } from "@/lib/approvals/kinds";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { useClock } from "@/components/time/clock-provider";
import { csvFilename } from "@/lib/csv";

const TONE = { APPROVED: "green", REJECTED: "red", SENT_BACK: "amber" } as const;

/** Approvals › History's rows (src/actions/approval-history.ts), and the download for whoever may export. */
export function ApprovalHistoryTable({ rows, filters, canExport }: { rows: ApprovalHistoryRow[]; filters: ApprovalHistoryFilters; canExport: boolean }) {
  const clock = useClock();
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function download() {
    setExporting(true);
    setError(null);
    const result = await exportApprovalHistory(filters);
    setExporting(false);
    if (!result.ok) return setError(result.error);
    const url = URL.createObjectURL(new Blob([result.data.csv], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = csvFilename("approvals-history", new Date(), clock);
    link.click();
    URL.revokeObjectURL(url);
  }

  return (
    <div>
      {canExport && (
        <div className="flex items-center justify-end gap-3 border-b border-line px-4 py-2">
          {error && <span className="text-xs text-danger">{error}</span>}
          <Button type="button" variant="secondary" size="sm" onClick={download} disabled={exporting || rows.length === 0}>
            <Download className="h-3.5 w-3.5" />
            {exporting ? "Preparing…" : "Download CSV"}
          </Button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-4 py-2.5">When</th>
              <th className="px-4 py-2.5">What</th>
              <th className="px-4 py-2.5">Record</th>
              <th className="px-4 py-2.5">Decision</th>
              <th className="px-4 py-2.5">Decided by</th>
              <th className="px-4 py-2.5">Asked by</th>
              <th className="px-4 py-2.5">Note</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} className="border-b border-line align-top last:border-0">
                <td className="whitespace-nowrap px-4 py-2.5 text-muted">{clock.dateTimeShort(r.decidedAt)}</td>
                <td className="px-4 py-2.5 text-muted">{r.kindLabel}</td>
                <td className="px-4 py-2.5">
                  {r.href ? (
                    <CompanyLink href={r.href} className="text-text hover:underline">
                      {r.label}
                    </CompanyLink>
                  ) : (
                    <span className="text-text">{r.label}</span>
                  )}
                </td>
                <td className="px-4 py-2.5">
                  <Badge tone={TONE[r.decision] ?? "default"}>{APPROVAL_DECISIONS[r.decision] ?? r.decision}</Badge>
                  {r.backfilled && (
                    <span className="mt-0.5 block text-[11px] text-subtle" title="From what the record kept before this history began — its latest decision only.">
                      from the record
                    </span>
                  )}
                </td>
                <td className="px-4 py-2.5 text-text">{r.decidedBy}</td>
                <td className="px-4 py-2.5 text-muted">{r.requestedBy ?? "—"}</td>
                <td className="max-w-xs px-4 py-2.5 text-muted">{r.note ?? "—"}</td>
              </tr>
            ))}
            {rows.length === 0 && (
              <tr>
                <td colSpan={7} className="px-4 py-8 text-center text-subtle">
                  No approval decisions match these filters.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
