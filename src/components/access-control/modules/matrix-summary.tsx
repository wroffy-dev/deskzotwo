"use client";

import Link from "next/link";
import { ChevronRight, X } from "lucide-react";
import { EmptyNote, Meter, Panel, PanelHeader, StateTag, type PillTone } from "@/components/access-control/ui";

export type SummaryStat = { label: string; value: number; of?: number; hint?: string };
export type SummaryLink = { label: string; href: string };
export type StagedItem = { id: string; label: string; where: string; from: string; to: string; tone: PillTone; undo: () => void };

/**
 * Beside the matrix: what the open role or person comes to once the staged changes are counted in,
 * every change waiting for Save (each one can be dropped on its own), and the screens that hold the
 * rest of their access — record reach, fields, documents, the history.
 */
export function MatrixSummary({
  title,
  sub,
  stats,
  staged,
  links,
  onUndoAll,
  onLeave,
}: {
  title: string;
  sub: string;
  stats: SummaryStat[];
  staged: StagedItem[];
  links: SummaryLink[];
  onUndoAll: () => void;
  /** A link was clicked: the matrix asks first when changes are staged. */
  onLeave: (event: React.MouseEvent, href: string) => void;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <Panel>
        <PanelHeader title="Summary" />
        <div className="px-4 pb-1 pt-3">
          <div className="truncate font-semibold text-text">{title}</div>
          <div className="mt-0.5 text-xs text-muted">{sub}</div>
        </div>
        <div className="flex flex-col gap-2.5 px-4 pb-4 pt-2">
          {stats.map((s) => (
            <div key={s.label}>
              <div className="flex items-baseline gap-2">
                <span className="flex-1 text-xs text-text/80">{s.label}</span>
                <span className="text-xs font-semibold text-text">
                  {s.value}
                  {s.of !== undefined && <span className="font-normal text-subtle"> of {s.of}</span>}
                </span>
              </div>
              {s.of !== undefined && <Meter value={s.value} max={s.of} tone="green" className="mt-1 h-1.5" />}
              {s.hint && <div className="mt-0.5 text-[11px] text-subtle">{s.hint}</div>}
            </div>
          ))}
        </div>
      </Panel>

      <Panel>
        <PanelHeader
          title="Staged changes"
          meta={<span className="text-xs text-subtle">{staged.length}</span>}
          action={
            staged.length > 0 ? (
              <button type="button" onClick={onUndoAll} className="text-xs font-semibold text-brand hover:underline">
                Reset
              </button>
            ) : undefined
          }
        />
        {staged.length === 0 ? (
          <EmptyNote>Nothing staged. Changes collect here until you save.</EmptyNote>
        ) : (
          <ul className="max-h-[320px] overflow-auto">
            {staged.map((s) => (
              <li key={s.id} className="flex items-start gap-2 border-b border-line/70 px-4 py-2 last:border-0">
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[12.5px] font-medium text-text" title={s.label}>
                    {s.label}
                  </span>
                  <span className="mt-0.5 flex flex-wrap items-center gap-1 text-[11px] text-subtle">
                    {s.where}
                    <span className="font-mono uppercase">· {s.from} →</span>
                    <StateTag tone={s.tone} className="h-4 text-[10px]">
                      {s.to}
                    </StateTag>
                  </span>
                </span>
                <button type="button" onClick={s.undo} title="Drop this change" aria-label={`Drop the change to ${s.label}`} className="rounded p-0.5 text-subtle transition-colors hover:bg-surface-sunken hover:text-text">
                  <X className="h-3.5 w-3.5" aria-hidden />
                </button>
              </li>
            ))}
          </ul>
        )}
      </Panel>

      <Panel>
        <PanelHeader title="The rest of their access" />
        <div className="flex flex-col">
          {links.map((l) => (
            <Link key={l.href + l.label} href={l.href} onClick={(e) => onLeave(e, l.href)} className="flex items-center gap-2 border-b border-line/70 px-4 py-2 text-[12.5px] text-text/80 transition-colors last:border-0 hover:bg-surface-sunken/60 hover:text-text">
              <span className="flex-1">{l.label}</span>
              <ChevronRight className="h-4 w-4 text-subtle" aria-hidden />
            </Link>
          ))}
        </div>
      </Panel>
    </div>
  );
}
