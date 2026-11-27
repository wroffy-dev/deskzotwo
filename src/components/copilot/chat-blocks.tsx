"use client";

import { useState, useTransition } from "react";
import { ArrowRight, CheckSquare, Pencil, Search, StickyNote, Target, type LucideIcon } from "lucide-react";
import { ReportChart } from "@/components/reports/report-chart";
import { Button } from "@/components/ui/button";
import { confirmCopilotProposal, cancelCopilotProposal } from "@/actions/copilot";
import type { ActivityBlock, ProposalBlock, ProposalChange, ReportBlock } from "@/lib/copilot/types";
import { baseLocale, formatMoneyWhole } from "@/lib/currency";

export function ActivityLine({ block }: { block: ActivityBlock }) {
  return (
    <p className="flex items-center gap-1.5 text-[11px] text-subtle">
      <Search className="h-3 w-3 shrink-0" aria-hidden="true" />
      {block.label}
    </p>
  );
}

/** A report, drawn the way the Reports page draws it. No download: the copilot doesn't export. */
export function ReportCard({ block }: { block: ReportBlock }) {
  const { result } = block;
  const locale = baseLocale();
  const format = (n: number) => (result.unit === "currency" ? formatMoneyWhole(n) : result.unit === "days" ? `${n.toFixed(1)} d` : n.toLocaleString(locale));
  const crossTab = result.columns.length > 1;
  const [showAll, setShowAll] = useState(false);
  const rows = showAll ? result.rows : result.rows.slice(0, 10);
  return (
    <div className="space-y-2 rounded-base border border-line bg-surface p-3">
      <div>
        <p className="text-[13px] font-semibold text-text">{block.title}</p>
        <p className="text-[11px] text-subtle">
          {block.measureLabel} · {block.averaged ? "average" : "total"} {format(result.grandTotal)} · {result.rowCount.toLocaleString(locale)} records
          {result.truncated ? " · capped, so a floor" : ""}
        </p>
      </div>
      {result.rows.length > 0 && (
        <div className="overflow-hidden rounded border border-line">
          <ReportChart result={result} type={crossTab ? "stacked" : "bar"} format={format} averaged={block.averaged} />
        </div>
      )}
      <table className="w-full text-[12px]">
        <tbody>
          {rows.map((row) => (
            <tr key={row.key} className="border-t border-line first:border-t-0">
              <td className="py-1 pr-2 text-text">{row.label}</td>
              <td className="py-1 text-right tabular-nums text-text">{format(row.total)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {result.rows.length > 10 && (
        <button type="button" className="text-[11px] text-muted underline underline-offset-2" onClick={() => setShowAll((v) => !v)}>
          {showAll ? "Show fewer" : `Show all ${result.rows.length}`}
        </button>
      )}
      <p className="text-[10px] text-subtle">{result.scopeNote}</p>
    </div>
  );
}

/** What each kind of card calls itself, its text, its button and what it did. */
const CARD: Record<ProposalBlock["kind"], { icon: LucideIcon; heading: string; details: string; confirm: string; done: string }> = {
  TASK: { icon: CheckSquare, heading: "New task", details: "Description", confirm: "Create task", done: "Task created" },
  NOTE: { icon: StickyNote, heading: "New note", details: "Note", confirm: "Save note", done: "Note saved" },
  LEAD: { icon: Target, heading: "New lead", details: "What will be saved", confirm: "Create lead", done: "Lead created" },
  LEAD_UPDATE: { icon: Pencil, heading: "Change a lead", details: "What will be saved", confirm: "Save changes", done: "Lead changed" },
};

/** A change to a record, field by field: what it holds, then what it would hold. */
export function ProposalChanges({ changes }: { changes: ProposalChange[] }) {
  return (
    <dl className="max-h-64 space-y-1.5 overflow-y-auto rounded border border-line bg-surface px-2 py-1.5 text-[12px] text-text">
      {changes.map((c, i) => (
        <div key={i}>
          <dt className="text-[10px] font-semibold uppercase tracking-wide text-subtle">{c.label}</dt>
          <dd className="flex flex-wrap items-baseline gap-x-1.5 whitespace-pre-wrap break-words">
            <span className="min-w-0 text-muted line-through">
              <span className="sr-only">From </span>
              {c.from}
            </span>
            <ArrowRight className="h-3 w-3 shrink-0 self-center text-subtle" aria-hidden="true" />
            <span className="min-w-0 font-medium">
              <span className="sr-only">to </span>
              {c.to}
            </span>
          </dd>
        </div>
      ))}
    </dl>
  );
}

/** A task, note or lead the copilot drafted, or a change to a lead — nothing is saved until this is pressed. */
export function ProposalCard({ block, onChange }: { block: ProposalBlock; onChange: (next: ProposalBlock) => void }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const card = CARD[block.kind];
  const Icon = card.icon;
  const status = block.status ?? "PENDING";

  function act(confirm: boolean) {
    setError(null);
    startTransition(async () => {
      const r = confirm ? await confirmCopilotProposal(block.id) : await cancelCopilotProposal(block.id);
      if (!r.ok) {
        setError(r.error);
        if (confirm) onChange({ ...block, status: "FAILED", error: r.error });
        return;
      }
      onChange({ ...block, status: confirm ? "DONE" : "CANCELLED" });
    });
  }

  return (
    <div className="space-y-2 rounded-base border border-brand/30 bg-brand-subtle/40 p-3">
      <p className="flex items-start gap-2 text-[13px] text-text">
        <Icon className="mt-0.5 h-4 w-4 shrink-0 text-brand" aria-hidden="true" />
        <span>
          <span className="text-[11px] font-semibold uppercase tracking-wide text-muted">{card.heading}</span>
          <br />
          {block.summary}
        </span>
      </p>
      {/* Security audit, 13 Nov 2026 (A4): everything Create will save is on the card — the whole text, and who it's for. */}
      {block.assignee?.other && (
        <p className="rounded border border-warning/40 bg-warning-bg px-2 py-1 text-[12px] font-medium text-text">This task is for {block.assignee.name}, not you.</p>
      )}
      {block.assignee && !block.assignee.other && <p className="text-[12px] text-muted">Assigned to you</p>}
      {block.changes && <ProposalChanges changes={block.changes} />}
      {block.details ? (
        <div className="max-h-48 overflow-y-auto whitespace-pre-wrap break-words rounded border border-line bg-surface px-2 py-1.5 text-[12px] text-text">
          <span className="block text-[10px] font-semibold uppercase tracking-wide text-subtle">{card.details}</span>
          {block.details}
        </div>
      ) : (
        block.kind === "TASK" && block.details !== undefined && <p className="text-[12px] text-subtle">No description</p>
      )}
      {status === "PENDING" ? (
        <div className="flex gap-2">
          <Button size="sm" disabled={pending} onClick={() => act(true)}>
            {pending ? "Saving…" : card.confirm}
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => act(false)}>
            Cancel
          </Button>
        </div>
      ) : (
        <p className={`text-[12px] ${status === "DONE" ? "text-success" : status === "FAILED" ? "text-danger" : "text-subtle"}`}>
          {status === "DONE" ? `✓ ${card.done}` : status === "FAILED" ? `Couldn't save: ${block.error ?? error ?? ""}` : "Cancelled"}
        </p>
      )}
      {error && status === "PENDING" && <p className="text-[12px] text-danger">{error}</p>}
    </div>
  );
}
