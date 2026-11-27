"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { CalendarDays, CalendarRange, Columns3, LayoutGrid, Lock, PhoneCall, Rows3, Search, Share2, Table2, TableProperties } from "lucide-react";
import { cn } from "@/lib/utils";
import { Input } from "@/components/ui/input";
import type { ListExtras } from "@/lib/smart-lists/index-extras";

/**
 * The Smart Lists page (owner, 20 Nov 2026: "this screen also requires upgrade"), in the look the lists themselves now
 * have: a search, tabs for whose lists and what kind, and cards — or a table — that say at a glance what each list is
 * for: its columns and views, the guests it's shared with, a calling activity's progress, who works it, and when it was
 * last opened. The view chosen is remembered in this browser.
 */

export type IndexRow = {
  id: string;
  name: string;
  description: string | null;
  calling: boolean;
  /** Holds rows of its own, not companies (src/lib/smart-lists/own-rows.ts). */
  ownRows?: boolean;
  shared: boolean;
  filterCount: number;
  records: number;
  mine: boolean;
  assignedToMe: boolean;
  owner: string;
  assignees: string[];
  opened: string;
};

type Tab = "all" | "mine" | "assigned" | "own" | "guests" | "calling";
const TABS: { key: Tab; label: string }[] = [
  { key: "all", label: "All" },
  { key: "mine", label: "Built by me" },
  { key: "assigned", label: "Assigned to me" },
  { key: "own", label: "Own rows" },
  { key: "guests", label: "Shared with guests" },
  { key: "calling", label: "Calling activities" },
];

/** A list's tile colour, from its name — the same every time, varied across lists. */
const TILES = ["bg-info-bg text-info", "bg-success-bg text-success", "bg-warning-bg text-warning", "bg-brand-subtle text-brand", "bg-danger-bg text-danger", "bg-pink-100 text-pink-700 dark:bg-pink-950 dark:text-pink-300"];
const tileOf = (name: string) => TILES[[...name].reduce((n, ch) => (n * 31 + ch.charCodeAt(0)) >>> 0, 7) % TILES.length]!;
const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]!.toUpperCase()).join("");
const VIEW_ICON = { TABLE: Table2, BOARD: Columns3, CALENDAR: CalendarDays, GALLERY: LayoutGrid, TIMELINE: CalendarRange } as const;
const KEY = "deskzo:smart-lists:view";

function People({ names }: { names: string[] }) {
  if (names.length === 0) return null;
  return (
    <span className="flex -space-x-1.5" title={names.join(", ")}>
      {names.slice(0, 4).map((n) => (
        <span key={n} className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface bg-surface-sunken text-[9px] font-semibold text-muted">
          {initials(n)}
        </span>
      ))}
      {names.length > 4 && <span className="flex h-6 w-6 items-center justify-center rounded-full border-2 border-surface bg-surface-sunken text-[9px] text-muted">+{names.length - 4}</span>}
    </span>
  );
}

function Facts({ row, x }: { row: IndexRow; x: ListExtras | undefined }) {
  return (
    <span className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
      {row.calling ? (
        <span className="inline-flex items-center gap-1">
          <PhoneCall className="h-3.5 w-3.5" aria-hidden="true" />
          {x?.done ?? 0} of {row.records} called
        </span>
      ) : row.ownRows ? (
        <span className="inline-flex items-center gap-1">
          <Rows3 className="h-3.5 w-3.5" aria-hidden="true" />
          {(x?.rows ?? 0).toLocaleString("en-IN")} row{x?.rows === 1 ? "" : "s"}
        </span>
      ) : (
        <span>
          {row.filterCount} filter{row.filterCount === 1 ? "" : "s"}
        </span>
      )}
      {!!x?.columns && (
        <span className="inline-flex items-center gap-1">
          <TableProperties className="h-3.5 w-3.5" aria-hidden="true" />
          {x.columns} column{x.columns === 1 ? "" : "s"}
        </span>
      )}
      {!!x?.views.length && (
        <span className="inline-flex items-center gap-1" title={`${x.views.length} saved view${x.views.length === 1 ? "" : "s"}`}>
          {[...new Set(x.views)].map((k) => {
            const Icon = VIEW_ICON[k];
            return <Icon key={k} className="h-3.5 w-3.5" aria-label={k.toLowerCase()} />;
          })}
        </span>
      )}
      {!!x?.guests && (
        <span className="inline-flex items-center gap-1 text-info">
          <Share2 className="h-3.5 w-3.5" aria-hidden="true" />
          {x.guests} guest{x.guests === 1 ? "" : "s"}
        </span>
      )}
      {!row.shared && (
        <span className="inline-flex items-center gap-1">
          <Lock className="h-3.5 w-3.5" aria-hidden="true" />
          Private
        </span>
      )}
    </span>
  );
}

export function SmartListIndex({ rows, extras }: { rows: IndexRow[]; extras: Record<string, ListExtras> }) {
  const [q, setQ] = useState("");
  const [tab, setTab] = useState<Tab>("all");
  const [view, setView] = useState<"cards" | "table">("cards");
  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      // eslint-disable-next-line react-hooks/set-state-in-effect -- read once from this browser after the first paint
      if (saved === "table" || saved === "cards") setView(saved);
    } catch {}
  }, []);
  const pick = (v: "cards" | "table") => {
    setView(v);
    try {
      localStorage.setItem(KEY, v);
    } catch {}
  };

  const counts = useMemo(
    () => ({
      all: rows.length,
      mine: rows.filter((r) => r.mine).length,
      assigned: rows.filter((r) => r.assignedToMe).length,
      own: rows.filter((r) => r.ownRows).length,
      guests: rows.filter((r) => (extras[r.id]?.guests ?? 0) > 0).length,
      calling: rows.filter((r) => r.calling).length,
    }),
    [rows, extras],
  );
  const shown = rows.filter((r) => {
    if (tab === "mine" && !r.mine) return false;
    if (tab === "assigned" && !r.assignedToMe) return false;
    if (tab === "own" && !r.ownRows) return false;
    if (tab === "guests" && !(extras[r.id]?.guests ?? 0)) return false;
    if (tab === "calling" && !r.calling) return false;
    const t = q.trim().toLowerCase();
    return !t || r.name.toLowerCase().includes(t) || (r.description ?? "").toLowerCase().includes(t) || r.owner.toLowerCase().includes(t);
  });

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line">
        <nav aria-label="Which lists" className="-mb-px flex flex-wrap gap-0.5">
          {TABS.filter((t) => t.key === "all" || counts[t.key] > 0).map((t) => (
            <button
              key={t.key}
              type="button"
              aria-pressed={tab === t.key}
              onClick={() => setTab(t.key)}
              className={cn("border-b-2 px-3 py-2 text-sm", tab === t.key ? "border-text font-medium text-text" : "border-transparent text-muted hover:text-text")}
            >
              {t.label} <span className="text-subtle">{counts[t.key]}</span>
            </button>
          ))}
        </nav>
        <div className="flex items-center gap-2 pb-1.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-subtle" aria-hidden="true" />
            <Input type="search" aria-label="Search lists" placeholder="Search lists…" value={q} onChange={(e) => setQ(e.target.value)} className="h-8 w-52 pl-8" />
          </div>
          <div role="group" aria-label="Show as" className="flex rounded-base border border-line p-0.5">
            <button type="button" aria-pressed={view === "cards"} onClick={() => pick("cards")} className={cn("rounded px-2 py-1", view === "cards" ? "bg-surface-sunken text-text" : "text-subtle hover:text-text")} aria-label="Cards">
              <LayoutGrid className="h-4 w-4" />
            </button>
            <button type="button" aria-pressed={view === "table"} onClick={() => pick("table")} className={cn("rounded px-2 py-1", view === "table" ? "bg-surface-sunken text-text" : "text-subtle hover:text-text")} aria-label="Table">
              <Rows3 className="h-4 w-4" />
            </button>
          </div>
        </div>
      </div>

      {shown.length === 0 ? (
        <p className="rounded-card border border-dashed border-line px-4 py-12 text-center text-sm text-muted">{q ? "No list matches that." : "Nothing here yet."}</p>
      ) : view === "cards" ? (
        <ul className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {shown.map((r) => (
            <li key={r.id}>
              <Link href={`/smart-lists/${r.id}`} className="group flex h-full flex-col gap-3 rounded-card border border-line bg-surface p-4 transition-[border-color,box-shadow,transform] hover:-translate-y-0.5 hover:border-line-strong hover:shadow-[0_14px_30px_-20px_rgb(15_23_42/0.35)]">
                <span className="flex items-start gap-3">
                  <span className={cn("flex h-10 w-10 shrink-0 items-center justify-center rounded-base text-sm font-bold", tileOf(r.name))} aria-hidden="true">
                    {r.calling ? <PhoneCall className="h-4 w-4" /> : initials(r.name)}
                  </span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-semibold text-text group-hover:text-brand">{r.name}</span>
                    <span className="mt-0.5 block line-clamp-2 text-sm text-muted">{r.description || (r.calling ? "Calling activity" : r.ownRows ? "A list of its own rows" : "Smart List")}</span>
                  </span>
                </span>
                <Facts row={r} x={extras[r.id]} />
                {r.calling && r.records > 0 && (
                  <span className="h-1.5 overflow-hidden rounded-full bg-surface-sunken" aria-hidden="true">
                    <span className="block h-full bg-success" style={{ width: `${Math.min(100, Math.round(((extras[r.id]?.done ?? 0) / r.records) * 100))}%` }} />
                  </span>
                )}
                <span className="mt-auto flex items-center justify-between gap-2 border-t border-line pt-3 text-xs text-subtle">
                  <span className="truncate">
                    {r.mine ? "Yours" : r.owner} · {r.opened}
                  </span>
                  <People names={r.assignees} />
                </span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <div className="overflow-x-auto rounded-card border border-line bg-surface">
          <table className="w-full min-w-[760px] border-collapse text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="px-3 py-2 font-medium">List</th>
                <th className="px-3 py-2 font-medium">What&apos;s in it</th>
                <th className="px-3 py-2 font-medium">Worked by</th>
                <th className="px-3 py-2 font-medium">Built by</th>
                <th className="px-3 py-2 font-medium">Last opened</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((r) => (
                <tr key={r.id} className="border-b border-line last:border-0 hover:bg-surface-sunken/60">
                  <td className="px-3 py-2">
                    <Link href={`/smart-lists/${r.id}`} className="flex items-center gap-2.5 font-medium text-text hover:underline">
                      <span className={cn("flex h-7 w-7 shrink-0 items-center justify-center rounded text-[11px] font-bold", tileOf(r.name))} aria-hidden="true">
                        {r.calling ? <PhoneCall className="h-3.5 w-3.5" /> : initials(r.name)}
                      </span>
                      {r.name}
                    </Link>
                  </td>
                  <td className="px-3 py-2">
                    <Facts row={r} x={extras[r.id]} />
                  </td>
                  <td className="px-3 py-2">
                    <People names={r.assignees} />
                  </td>
                  <td className="px-3 py-2 text-muted">{r.mine ? "You" : r.owner}</td>
                  <td className="px-3 py-2 text-muted">{r.opened}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
