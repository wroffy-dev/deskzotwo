"use client";

import { Fragment, useContext, useMemo, useState, type ReactNode } from "react";
import { CompanyLink } from "@/components/companies/company-link";
import { ChevronLeft, ChevronRight, Eye, PanelRightOpen, Pin, Plus, X } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BoardProperty } from "@/actions/smart-list-board";
import { CellEditor, CellValue, OptionChip, TotalCell } from "@/components/smart-lists/cells";
import type { ListTotals } from "@/lib/smart-lists/totals";
import { LinkLabels } from "@/components/smart-lists/link-labels";
import type { BoardRow } from "@/components/smart-lists/smart-list-board";
import { CallButton } from "@/components/calls/call-button";
import { QuickMessageButton } from "@/components/messages/quick-message";
import { ScrollX } from "@/components/ui/scroll-x";

/**
 * A Smart List's three ways of looking (owner, 20 Nov 2026 — src/lib/smart-lists): a table with its columns edited in
 * place, a board grouped by a Select column (drag a card to another column to change it), and a calendar placing rows by
 * a Date column. Each draws the rows it is given; saving is the board's (`onSetValue`).
 */

type Common = {
  rows: BoardRow[];
  properties: BoardProperty[];
  values: Record<string, Record<string, unknown>>;
  people: { id: string; name: string }[];
  onSetValue: (companyId: string, property: BoardProperty, raw: unknown) => void;
  onOpen: (row: BoardRow) => void;
};

// ─── Groups (Smart Lists phase 3) ─────────────────────────────────────────────

/**
 * Where each group starts among the rows on screen, its label and how many it has here — rows grouped by a Select, a
 * Person or a Checkbox column (the server fetches them in that order: src/lib/smart-lists/view-query.ts effectiveSort).
 */
export function groupHeads(rows: BoardRow[], values: Record<string, Record<string, unknown>>, groupBy: BoardProperty | null | undefined, names: Map<string, string>): Map<string, { label: ReactNode; count: number }> {
  const out = new Map<string, { label: ReactNode; count: number }>();
  if (!groupBy) return out;
  const keyOf = (id: string) => {
    const v = values[id]?.[groupBy.id];
    return v === undefined || v === null ? "" : String(v);
  };
  let current: string | null = null;
  let head: { label: ReactNode; count: number } | null = null;
  for (const row of rows) {
    const key = keyOf(row.id);
    if (key !== current || !head) {
      current = key;
      const option = groupBy.kind === "SELECT" ? groupBy.options.find((o) => o.id === key) : undefined;
      const label: ReactNode = option ? (
        <OptionChip option={option} />
      ) : groupBy.kind === "CHECKBOX" ? (
        key === "true" ? `${groupBy.name}: ticked` : `${groupBy.name}: not ticked`
      ) : key ? (
        (names.get(key) ?? "Somebody who left")
      ) : (
        `No ${groupBy.name.toLowerCase()}`
      );
      head = { label, count: 0 };
      out.set(row.id, head);
    }
    head.count += 1;
  }
  return out;
}

// ─── Table ────────────────────────────────────────────────────────────────────

export function TableView({
  rows,
  properties,
  values,
  people,
  onSetValue,
  onOpen,
  canEdit,
  canAddRows,
  pinned,
  onEditColumn,
  onAddColumn,
  onUnpin,
  canMessage = false,
  selected,
  onSelect,
  totals = null,
  groupBy = null,
  readOnly = false,
}: Common & {
  /** View-only for this person (Smart Lists phase 4): nothing changes from here. */
  readOnly?: boolean;
  /** The column the rows are grouped by (Smart Lists phase 3). */
  groupBy?: BoardProperty | null;
  canEdit: boolean;
  canAddRows: boolean;
  pinned: Set<string>;
  onEditColumn: (p: BoardProperty) => void;
  onAddColumn: () => void;
  onUnpin: (row: BoardRow) => void;
  /** Each row's Mail button, beside Call, as the list always had (owner, 16 Nov 2026). */
  canMessage?: boolean;
  /** Rows ticked to change at once, and ticking them (Smart Lists phase 2). */
  selected?: Set<string>;
  onSelect?: (ids: string[], on: boolean) => void;
  /** The footer: every column added up over the rows the view shows (src/lib/smart-lists/totals.ts). */
  totals?: ListTotals | null;
}) {
  const names = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const [editing, setEditing] = useState<{ row: string; prop: string } | null>(null);
  const heads = groupHeads(rows, values, groupBy, names);
  return (
    // `relative`: the header's screen-reader label is absolutely placed — anchored here, it stays inside the scroll box
    // instead of widening the whole page.
    <ScrollX className="relative rounded-card border border-line bg-surface">
      {/* Columns as wide as they need, not stretched: a wide Company column, kept in view, would hide the rest on a phone. */}
      <table className="w-max min-w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th scope="col" className="sticky left-0 z-[1] w-44 min-w-44 max-w-44 bg-surface px-3 py-2 font-medium sm:w-60 sm:min-w-60 sm:max-w-60">
              <span className="flex items-center gap-2">
                {onSelect && selected && (
                  <input
                    type="checkbox"
                    aria-label="Tick every row on this page"
                    checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                    onChange={(e) => onSelect(rows.map((r) => r.id), e.target.checked)}
                  />
                )}
                Company
              </span>
            </th>
            <th scope="col" className="min-w-32 border-l border-line px-3 py-2 font-medium">
              Where
            </th>
            <th scope="col" className="min-w-28 border-l border-line px-3 py-2 font-medium">
              Owner
            </th>
            {properties.map((p) => (
              <th key={p.id} scope="col" className="min-w-40 border-l border-line px-1 py-1 font-medium">
                {canEdit ? (
                  <button type="button" className="flex w-full items-center gap-1.5 truncate rounded-base px-2 py-1 text-left hover:bg-surface-sunken" onClick={() => onEditColumn(p)} title="Change this column">
                    <span className="truncate">{p.name}</span>
                    {p.guestVisible && <Eye className="h-3 w-3 shrink-0 text-info" aria-label={p.guestEditable ? "Guests see and edit it" : "Guests see it"} />}
                  </button>
                ) : (
                  <span className="block truncate px-2 py-1">{p.name}</span>
                )}
              </th>
            ))}
            {canEdit && (
              <th scope="col" className="w-10 border-l border-line px-1 py-1">
                <button type="button" onClick={onAddColumn} aria-label="Add a column" title="Add a column" className="rounded-base p-1.5 text-subtle hover:bg-surface-sunken hover:text-text">
                  <Plus className="h-4 w-4" />
                </button>
              </th>
            )}
            <th scope="col" className="w-20 border-l border-line px-2 py-2">
              <span className="sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <Fragment key={row.id}>
              {heads.get(row.id) && (
                <tr className="border-b border-line bg-surface-sunken/50">
                  <th scope="rowgroup" colSpan={999} className="sticky left-0 px-3 py-1.5 text-left text-xs font-semibold text-muted">
                    <span className="inline-flex items-center gap-2">
                      {heads.get(row.id)!.label}
                      <span className="font-normal text-subtle">{heads.get(row.id)!.count}</span>
                    </span>
                  </th>
                </tr>
              )}
            <tr className="group border-b border-line last:border-0 hover:bg-surface-sunken/60">
              <th scope="row" className="sticky left-0 z-[1] w-44 min-w-44 max-w-44 bg-surface px-3 py-1.5 text-left font-medium group-hover:bg-surface-sunken sm:w-60 sm:min-w-60 sm:max-w-60">
                <div className="flex items-center gap-1.5">
                  {onSelect && selected && <input type="checkbox" aria-label={`Tick ${row.name}`} checked={selected.has(row.id)} onChange={(e) => onSelect([row.id], e.target.checked)} />}
                  <CompanyLink href={row.href} className="truncate text-text hover:underline">
                    {row.name}
                  </CompanyLink>
                  {pinned.has(row.id) && <Pin className="h-3 w-3 shrink-0 text-subtle" aria-label="Added by hand" />}
                </div>
              </th>
              <td className="border-l border-line px-3 py-1.5 text-muted">{row.place || "—"}</td>
              <td className="border-l border-line px-3 py-1.5 text-muted">{row.ownerName ?? "Unassigned"}</td>
              {properties.map((p) => {
                const value = values[row.id]?.[p.id] ?? null;
                const isEditing = editing?.row === row.id && editing.prop === p.id;
                return (
                  <td key={p.id} className="relative border-l border-line px-1 py-0.5">
                    {isEditing ? (
                      <div className={["MULTI_SELECT", "COMPANY", "LEAD", "CONTACT", "ROW", "FILE"].includes(p.kind) ? "absolute left-0 top-0 z-10" : ""}>
                        <CellEditor
                          property={p}
                          value={value}
                          people={people}
                          rowKey={row.id}
                          onCancel={() => setEditing(null)}
                          onSave={(raw) => {
                            setEditing(null);
                            onSetValue(row.id, p, raw);
                          }}
                        />
                      </div>
                    ) : (
                      <button
                        type="button"
                        className="flex min-h-8 w-full items-center rounded-base px-2 text-left hover:bg-surface"
                        aria-label={`${p.name} for ${row.name}`}
                        disabled={readOnly || p.kind === "ROLLUP" || p.kind === "FORMULA"}
                        onClick={() => (p.kind === "CHECKBOX" ? onSetValue(row.id, p, value !== true) : setEditing({ row: row.id, prop: p.id }))}
                      >
                        <CellValue property={p} value={value} people={names} />
                      </button>
                    )}
                  </td>
                );
              })}
              {canEdit && <td className="border-l border-line" />}
              <td className="border-l border-line px-1 py-1">
                <div className="flex items-center justify-end gap-0.5">
                  {canMessage && <QuickMessageButton ask={{ moment: "AFTER_CALL", companyId: row.id }} title={`Mail ${row.name}`} label="Mail" start="EMAIL" variant="ghost" size="sm" />}
                  <CallButton companyId={row.id} companyName={row.name} size="sm" variant="ghost" />
                  <button type="button" onClick={() => onOpen(row)} aria-label={`Open ${row.name}'s page`} title="Open its page" className="rounded-base p-1.5 text-subtle hover:bg-surface hover:text-text">
                    <PanelRightOpen className="h-4 w-4" />
                  </button>
                  {canAddRows && pinned.has(row.id) && (
                    <button type="button" onClick={() => onUnpin(row)} aria-label={`Take ${row.name} off this list`} title="Take it off this list" className="rounded-base p-1.5 text-subtle hover:bg-surface hover:text-danger">
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </td>
            </tr>
            </Fragment>
          ))}
          {rows.length === 0 && (
            <tr>
              <td colSpan={properties.length + 5} className="px-4 py-12 text-center text-subtle">
                Nothing in this list yet. Loosen a filter, or add a company by hand.
              </td>
            </tr>
          )}
        </tbody>
        {totals && properties.length > 0 && (
          <tfoot>
            <tr className="border-t border-line bg-surface-sunken/40">
              <th scope="row" className="sticky left-0 z-[1] bg-surface px-3 py-1.5 text-left text-xs font-medium text-muted">
                {totals.count.toLocaleString("en-IN")} compan{totals.count === 1 ? "y" : "ies"}
              </th>
              <td className="border-l border-line" />
              <td className="border-l border-line" />
              {properties.map((p) => (
                <td key={p.id} className="border-l border-line py-1.5">
                  <TotalCell property={p} total={totals.columns[p.id]} />
                </td>
              ))}
              {canEdit && <td className="border-l border-line" />}
              <td className="border-l border-line" />
            </tr>
          </tfoot>
        )}
      </table>
    </ScrollX>
  );
}

// ─── Board ────────────────────────────────────────────────────────────────────

export function BoardView({ rows, properties, values, people, onSetValue, onOpen, property }: Common & { property: BoardProperty }) {
  const names = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const [over, setOver] = useState<string | null>(null);
  const columns = [...property.options.map((o) => ({ key: o.id, option: o })), { key: "", option: null }];
  const others = properties.filter((p) => p.id !== property.id).slice(0, 3);
  const inColumn = (key: string) => rows.filter((r) => String(values[r.id]?.[property.id] ?? "") === key);

  return (
    <div className="flex gap-3 overflow-x-auto pb-2">
      {columns.map(({ key, option }) => {
        const cards = inColumn(key);
        return (
          <section
            key={key || "none"}
            aria-label={option ? option.name : `No ${property.name}`}
            className={cn("flex w-64 shrink-0 flex-col gap-2 rounded-card bg-surface-sunken p-2.5 transition-colors", over === key && "ring-2 ring-brand")}
            onDragOver={(e) => {
              e.preventDefault();
              setOver(key);
            }}
            onDragLeave={() => setOver((o) => (o === key ? null : o))}
            onDrop={(e) => {
              e.preventDefault();
              setOver(null);
              const companyId = e.dataTransfer.getData("text/x-company");
              if (companyId && String(values[companyId]?.[property.id] ?? "") !== key) onSetValue(companyId, property, key || null);
            }}
          >
            <header className="flex items-center gap-2 px-1 text-xs font-medium text-muted">
              {option ? <OptionChip option={option} /> : <span>No {property.name.toLowerCase()}</span>}
              <span className="text-subtle">{cards.length}</span>
            </header>
            {cards.map((row) => (
              <article
                key={row.id}
                draggable
                onDragStart={(e) => {
                  e.dataTransfer.setData("text/x-company", row.id);
                  e.dataTransfer.effectAllowed = "move";
                }}
                className="cursor-grab rounded-base border border-line bg-surface p-2.5 shadow-sm active:cursor-grabbing"
              >
                <button type="button" className="block w-full text-left" onClick={() => onOpen(row)}>
                  <span className="block truncate text-sm font-medium text-text">{row.name}</span>
                  <span className="mt-0.5 block truncate text-xs text-muted">{[row.place, row.ownerName].filter(Boolean).join(" · ") || " "}</span>
                  {others.map((p) => {
                    const v = values[row.id]?.[p.id];
                    if (v === undefined || v === null) return null;
                    return (
                      <span key={p.id} className="mt-1.5 flex items-center gap-1.5 text-xs text-muted">
                        <span className="shrink-0 text-subtle">{p.name}</span>
                        <span className="min-w-0 truncate">
                          <CellValue property={p} value={v} people={names} />
                        </span>
                      </span>
                    );
                  })}
                </button>
              </article>
            ))}
            {cards.length === 0 && <p className="px-1 py-3 text-center text-xs text-subtle">Drop a card here</p>}
          </section>
        );
      })}
    </div>
  );
}

// ─── Calendar ─────────────────────────────────────────────────────────────────

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const pad = (n: number) => String(n).padStart(2, "0");

export function CalendarView({ rows, values, onOpen, property, today }: Common & { property: BoardProperty; today: string }) {
  const [month, setMonth] = useState(today.slice(0, 7));
  const [y, m] = month.split("-").map(Number) as [number, number];
  const first = new Date(Date.UTC(y, m - 1, 1));
  const daysIn = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const lead = (first.getUTCDay() + 6) % 7; // Monday first
  const cells = Array.from({ length: Math.ceil((lead + daysIn) / 7) * 7 }, (_, i) => {
    const d = i - lead + 1;
    return d >= 1 && d <= daysIn ? `${month}-${pad(d)}` : null;
  });
  const byDay = new Map<string, BoardRow[]>();
  let undated = 0;
  for (const r of rows) {
    const v = values[r.id]?.[property.id];
    if (typeof v !== "string") {
      undated += 1;
      continue;
    }
    byDay.set(v, [...(byDay.get(v) ?? []), r]);
  }
  const shift = (by: number) => {
    const d = new Date(Date.UTC(y, m - 1 + by, 1));
    setMonth(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`);
  };

  return (
    <div className="rounded-card border border-line bg-surface">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line px-3 py-2">
        <div className="flex items-center gap-1">
          <button type="button" aria-label="Previous month" className="rounded-base p-1.5 text-muted hover:bg-surface-sunken" onClick={() => shift(-1)}>
            <ChevronLeft className="h-4 w-4" />
          </button>
          <h2 className="min-w-36 text-center text-sm font-semibold text-text">
            {MONTHS[m - 1]} {y}
          </h2>
          <button type="button" aria-label="Next month" className="rounded-base p-1.5 text-muted hover:bg-surface-sunken" onClick={() => shift(1)}>
            <ChevronRight className="h-4 w-4" />
          </button>
          <button type="button" className="ml-1 rounded-base px-2 py-1 text-xs text-muted hover:bg-surface-sunken" onClick={() => setMonth(today.slice(0, 7))}>
            Today
          </button>
        </div>
        <p className="text-xs text-subtle">
          By {property.name}
          {undated > 0 ? ` · ${undated} without a date` : ""}
        </p>
      </div>
      <div className="overflow-x-auto">
        <div className="grid min-w-[720px] grid-cols-7">
          {DAYS.map((d) => (
            <div key={d} className="border-b border-line px-2 py-1.5 text-xs font-medium text-muted">
              {d}
            </div>
          ))}
          {cells.map((day, i) => (
            <div key={i} className={cn("min-h-24 border-b border-r border-line p-1.5 [&:nth-child(7n)]:border-r-0", !day && "bg-surface-sunken/50")}>
              {day && (
                <>
                  <div className={cn("mb-1 inline-flex h-6 w-6 items-center justify-center rounded-full text-xs", day === today ? "bg-brand font-semibold text-brand-contrast" : "text-muted")}>{Number(day.slice(8))}</div>
                  <div className="space-y-1">
                    {(byDay.get(day) ?? []).map((r) => (
                      <button key={r.id} type="button" onClick={() => onOpen(r)} className="block w-full truncate rounded bg-brand-subtle px-1.5 py-0.5 text-left text-xs font-medium text-brand hover:brightness-95">
                        {r.name}
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

// ─── Gallery ──────────────────────────────────────────────────────────────────

const IMAGE = /\.(png|jpe?g|webp)$/i;

/**
 * Cards, a few columns each (owner, 20 Nov 2026 — Smart Lists phase 3): the row's title, the first image in a Files
 * column as its cover, and the next columns that have a value. A card opens the row's page.
 */
export function GalleryView({ rows, properties, values, people, onOpen }: Common) {
  const names = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const { labels } = useContext(LinkLabels);
  const files = properties.filter((p) => p.kind === "FILE");
  const shown = properties.filter((p) => p.kind !== "FILE");
  if (rows.length === 0) return <p className="rounded-card border border-dashed border-line px-4 py-12 text-center text-sm text-subtle">Nothing to show here yet.</p>;
  return (
    <ul className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
      {rows.map((row) => {
        const cover = files
          .flatMap((p) => (Array.isArray(values[row.id]?.[p.id]) ? (values[row.id]![p.id] as string[]) : []))
          .map((id) => labels[id])
          .find((l) => l?.href && IMAGE.test(l.name));
        const facts = shown.filter((p) => values[row.id]?.[p.id] !== undefined && values[row.id]?.[p.id] !== null).slice(0, 5);
        return (
          <li key={row.id}>
            <button type="button" onClick={() => onOpen(row)} className="flex h-full w-full flex-col overflow-hidden rounded-card border border-line bg-surface text-left transition-[border-color,box-shadow] hover:border-line-strong hover:shadow-[0_14px_30px_-20px_rgb(15_23_42/0.35)]">
              {cover?.href && (
                // eslint-disable-next-line @next/next/no-img-element -- a file served by the list's own route, not a static asset
                <img src={cover.href} alt="" className="h-32 w-full object-cover" loading="lazy" />
              )}
              <span className="flex flex-1 flex-col gap-1.5 p-3">
                <span className="truncate text-sm font-semibold text-text">{row.name}</span>
                {(row.place || row.ownerName) && <span className="truncate text-xs text-muted">{[row.place, row.ownerName].filter(Boolean).join(" · ")}</span>}
                {facts.map((p) => (
                  <span key={p.id} className="flex items-center gap-1.5 text-xs text-muted">
                    <span className="shrink-0 text-subtle">{p.name}</span>
                    <span className="min-w-0 truncate">
                      <CellValue property={p} value={values[row.id]![p.id]} people={names} />
                    </span>
                  </span>
                ))}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}

// ─── Timeline (Smart Lists phase 4) ───────────────────────────────────────────

const DAY_MS = 86_400_000;
const dayMs = (d: string) => Date.parse(`${d}T00:00:00Z`);
const dayOf = (t: number) => new Date(t).toISOString().slice(0, 10);
const isDay = (v: unknown): v is string => typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);

/**
 * Rows as bars between a start and an end Date column, by week or month (owner, 20 Nov 2026 — Smart Lists phase 4:
 * "useful for content calendars, events, site work and trainings"). Drag a bar to move both its dates; click it to open
 * the row. A row with no start isn't drawn; one with no end is a single day.
 */
export function TimelineView({
  rows,
  values,
  onOpen,
  onSetValue,
  property,
  end,
  scale = "week",
  today,
  readOnly = false,
}: Common & { property: BoardProperty; end: BoardProperty | null; scale?: "week" | "month"; today: string; readOnly?: boolean }) {
  const [drag, setDrag] = useState<{ id: string; x0: number; days: number; moved: boolean } | null>(null);
  const dayW = scale === "month" ? 6 : 28;
  const bars = rows
    .map((row) => {
      const s = values[row.id]?.[property.id];
      if (!isDay(s)) return null;
      const e0 = end ? values[row.id]?.[end.id] : null;
      const e = isDay(e0) && e0 >= s ? e0 : s;
      return { row, s, e, hasEnd: isDay(e0) };
    })
    .filter((b): b is { row: BoardRow; s: string; e: string; hasEnd: boolean } => !!b);
  const undated = rows.length - bars.length;
  const first = Math.min(dayMs(today) - 7 * DAY_MS, ...bars.map((b) => dayMs(b.s))) - 3 * DAY_MS;
  const last = Math.min(Math.max(dayMs(today) + 30 * DAY_MS, ...bars.map((b) => dayMs(b.e))) + 3 * DAY_MS, first + 400 * DAY_MS);
  const days = Math.round((last - first) / DAY_MS) + 1;
  const width = days * dayW;
  const months: { label: string; left: number }[] = [];
  for (let i = 0; i < days; i += 1) {
    const d = new Date(first + i * DAY_MS);
    if (d.getUTCDate() === 1 || i === 0) months.push({ label: d.toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" }), left: i * dayW });
  }
  const todayLeft = ((dayMs(today) - first) / DAY_MS) * dayW;

  const drop = (b: { row: BoardRow; s: string; e: string; hasEnd: boolean }, by: number) => {
    if (!by) return;
    onSetValue(b.row.id, property, dayOf(dayMs(b.s) + by * DAY_MS));
    if (end && b.hasEnd) onSetValue(b.row.id, end, dayOf(dayMs(b.e) + by * DAY_MS));
  };

  return (
    <div className="rounded-card border border-line bg-surface">
      <div className="flex items-center justify-between gap-2 border-b border-line px-3 py-2 text-xs text-subtle">
        <span>
          From {property.name}
          {end ? ` to ${end.name}` : ""}
          {undated > 0 ? ` · ${undated} without a ${property.name.toLowerCase()}` : ""}
        </span>
        {!readOnly && <span>Drag a bar to move its dates.</span>}
      </div>
      <div className="overflow-x-auto">
        <div className="relative" style={{ width: width + 224 }}>
          <div className="sticky top-0 flex border-b border-line text-[11px] text-muted">
            <div className="sticky left-0 z-[2] w-56 shrink-0 bg-surface px-3 py-1.5 font-medium">Row</div>
            <div className="relative h-7" style={{ width }}>
              {months.map((m) => (
                <span key={m.left} className="absolute top-1.5 whitespace-nowrap border-l border-line pl-1" style={{ left: m.left }}>
                  {m.label}
                </span>
              ))}
            </div>
          </div>
          {bars.map((b) => {
            const shift = drag?.id === b.row.id ? drag.days : 0;
            const left = ((dayMs(b.s) - first) / DAY_MS + shift) * dayW;
            const w = ((dayMs(b.e) - dayMs(b.s)) / DAY_MS + 1) * dayW;
            return (
              <div key={b.row.id} className="flex border-b border-line last:border-0">
                <button type="button" className="sticky left-0 z-[1] w-56 shrink-0 truncate bg-surface px-3 py-1.5 text-left text-sm text-text hover:underline" onClick={() => onOpen(b.row)}>
                  {b.row.name}
                </button>
                <div className="relative h-9" style={{ width }}>
                  <span className="absolute inset-y-0 w-px bg-brand/40" style={{ left: todayLeft }} aria-hidden="true" />
                  <div
                    role="button"
                    tabIndex={0}
                    aria-label={`${b.row.name}: ${b.s}${b.e !== b.s ? ` to ${b.e}` : ""}`}
                    className={cn("absolute top-1.5 flex h-6 items-center truncate rounded bg-brand-subtle px-1.5 text-xs font-medium text-brand", readOnly ? "cursor-pointer" : "cursor-grab active:cursor-grabbing")}
                    style={{ left, width: Math.max(w, 6) }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") onOpen(b.row);
                    }}
                    onPointerDown={(e) => {
                      if (readOnly) return;
                      (e.target as HTMLElement).setPointerCapture(e.pointerId);
                      setDrag({ id: b.row.id, x0: e.clientX, days: 0, moved: false });
                    }}
                    onPointerMove={(e) => {
                      if (!drag || drag.id !== b.row.id) return;
                      const d = Math.round((e.clientX - drag.x0) / dayW);
                      if (d !== drag.days || (!drag.moved && Math.abs(e.clientX - drag.x0) > 3)) setDrag({ ...drag, days: d, moved: drag.moved || Math.abs(e.clientX - drag.x0) > 3 });
                    }}
                    onPointerUp={() => {
                      const was = drag;
                      setDrag(null);
                      if (!was || was.id !== b.row.id || !was.moved) return onOpen(b.row);
                      drop(b, was.days);
                    }}
                    onClick={() => readOnly && onOpen(b.row)}
                  >
                    {w > 40 ? b.row.name : ""}
                  </div>
                </div>
              </div>
            );
          })}
          {bars.length === 0 && <p className="px-4 py-10 text-center text-sm text-subtle">No row has a {property.name.toLowerCase()} yet.</p>}
        </div>
      </div>
    </div>
  );
}
