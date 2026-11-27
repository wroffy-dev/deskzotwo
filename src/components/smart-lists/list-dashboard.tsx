"use client";

import Link from "next/link";
import { Plus } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { OptionChip } from "@/components/smart-lists/cells";
import type { Bar, ListDashboard } from "@/lib/smart-lists/dashboard";
import type { OptionColor } from "@/lib/smart-lists/values";

/**
 * A Smart List's Dashboard tab (owner, 20 Nov 2026: "i want a dashboard for report under same smart list so results can
 * be seen easly"): the whole list at a glance — headline figures, then a bar chart for each Select column (with what its
 * Money column adds up to), the companies by state and by account owner, and guests' work on it. Worked out on the
 * server over every row the person sees (src/lib/smart-lists/dashboard.ts).
 */

const BAR: Record<OptionColor, string> = {
  gray: "bg-line-strong",
  blue: "bg-info",
  green: "bg-success",
  amber: "bg-warning",
  red: "bg-danger",
  purple: "bg-brand",
  pink: "bg-pink-500",
};

/** Rupees the Indian way: crore and lakh when large, full figures otherwise. */
function rupees(n: number): string {
  const a = Math.abs(n);
  if (a >= 1e7) return `₹${(n / 1e7).toLocaleString("en-IN", { maximumFractionDigits: 2 })} Cr`;
  if (a >= 1e5) return `₹${(n / 1e5).toLocaleString("en-IN", { maximumFractionDigits: 2 })} L`;
  return `₹${Math.round(n).toLocaleString("en-IN")}`;
}
const count = (n: number) => n.toLocaleString("en-IN");

function Tile({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-card border border-line bg-surface p-4">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold tracking-tight text-text">{value}</p>
      {hint && <p className="mt-0.5 text-xs text-subtle">{hint}</p>}
    </div>
  );
}

function Bars({ bars, total, notSet, amountOf, neutral }: { bars: Bar[]; total: number; notSet?: number; amountOf?: string | null; neutral?: boolean }) {
  const rows = [...bars, ...(notSet ? [{ key: "none", label: "Not set", count: notSet } as Bar] : [])];
  const max = Math.max(1, ...rows.map((b) => b.count));
  if (rows.every((b) => b.count === 0)) return <p className="text-sm text-subtle">Nothing filled in yet.</p>;
  return (
    <ul className="space-y-2">
      {rows.map((b) => {
        const pct = total ? Math.round((b.count / total) * 100) : 0;
        return (
          <li key={b.key} className="grid grid-cols-[minmax(0,9rem)_minmax(0,1fr)_auto] items-center gap-3 text-sm">
            <span className="min-w-0 truncate" title={b.label}>
              {b.color && b.key !== "none" ? <OptionChip option={{ id: b.key, name: b.label, color: b.color }} /> : <span className={cn(b.key === "none" ? "text-subtle" : "text-text")}>{b.label}</span>}
            </span>
            <span className="h-2.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
              <span className={cn("block h-full rounded-full", b.key === "none" ? "bg-line" : neutral || !b.color ? "bg-brand/70" : BAR[b.color])} style={{ width: `${Math.max(b.count ? 3 : 0, Math.round((b.count / max) * 100))}%` }} />
            </span>
            <span className="whitespace-nowrap text-right tabular-nums text-muted">
              <span className="font-medium text-text">{count(b.count)}</span> · {pct}%
              {amountOf && b.amount !== undefined && b.key !== "none" && <span className="ml-2 text-text">{rupees(b.amount)}</span>}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function Panel({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section className="rounded-card border border-line bg-surface p-4">
      <div className="mb-3 flex flex-wrap items-baseline justify-between gap-2">
        <h3 className="font-semibold text-text">{title}</h3>
        {note && <span className="text-xs text-subtle">{note}</span>}
      </div>
      {children}
    </section>
  );
}

export function ListDashboardView({ data, onAddColumn }: { data: ListDashboard; onAddColumn?: () => void }) {
  const d = data;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-[repeat(auto-fit,minmax(11rem,1fr))]">
        <Tile label={d.own ? d.own.rows : "Companies"} value={count(d.total)} hint={d.own ? "in the list" : d.byHand ? `${count(d.byHand)} added by hand` : "brought by the filters"} />
        {d.numbers.map((n) => (
          <Tile key={n.id} label={n.name} value={n.money ? rupees(n.sum) : count(Math.round(n.sum))} hint={n.filled ? `across ${count(n.filled)} · average ${n.money ? rupees(n.sum / n.filled) : count(Math.round(n.sum / n.filled))}` : "nothing filled in"} />
        ))}
        {d.checks.map((c) => (
          <Tile key={c.id} label={c.name} value={count(c.ticked)} hint={`ticked, of ${count(d.total)}`} />
        ))}
        {d.dates.map((t) => (
          <Tile key={t.id} label={t.name} value={`${count(t.week)} this week`} hint={`${count(t.month)} in 30 days${t.overdue ? ` · ${count(t.overdue)} gone by` : ""}`} />
        ))}
        <Tile label="Changed this week" value={count(d.changedThisWeek)} hint="cells, by your team or guests" />
      </div>

      {d.guests && (
        <div className="flex flex-wrap items-center justify-between gap-2 rounded-card border border-info/30 bg-info-bg px-4 py-3 text-sm">
          <span className="text-text">
            Shared with <strong>{count(d.guests.shared)}</strong> guest{d.guests.shared === 1 ? "" : "s"} · last 30 days: {count(d.guests.edits)} cells changed, {count(d.guests.comments)} comments, {count(d.guests.suggestions)} suggestions
          </span>
          <span className="flex gap-3">
            {d.guests.waiting > 0 && (
              <Link href="/smart-lists/guests/suggestions" className="font-medium text-brand hover:underline">
                {d.guests.waiting} suggestion{d.guests.waiting === 1 ? "" : "s"} waiting
              </Link>
            )}
            <Link href="/smart-lists/guests/activity" className="text-brand hover:underline">
              Guest activity
            </Link>
          </span>
        </div>
      )}

      {d.selects.length === 0 && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-card border border-dashed border-line px-4 py-4 text-sm text-muted">
          <span>Add a Select column — Stage, Outcome, Next step — and its chart shows here: how many of each, and what they add up to.</span>
          {onAddColumn && (
            <Button size="sm" variant="secondary" onClick={onAddColumn}>
              <Plus className="h-3.5 w-3.5" />
              Column
            </Button>
          )}
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        {d.selects.map((s) => (
          <Panel key={s.id} title={s.name} note={s.multi ? `a ${d.own ? "row" : "company"} can hold several` : s.amountOf ? `count · share · ${s.amountOf}` : undefined}>
            <Bars bars={s.bars} total={d.total} notSet={s.notSet} amountOf={s.multi ? null : s.amountOf} />
          </Panel>
        ))}
        {d.states && (
          <Panel title="By state" note="their main address">
            <Bars bars={d.states} total={d.total} neutral />
          </Panel>
        )}
        <Panel title={d.own ? "By who added them" : "By account owner"}>
          <Bars bars={d.owners} total={d.total} neutral />
        </Panel>
      </div>

      {d.capped && <p className="text-xs text-subtle">This list is very large: the charts are worked out over its first 200,000 values.</p>}
    </div>
  );
}
