"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { GripVertical, PanelRightOpen, Plus, Trash2 } from "lucide-react";
import type { BoardProperty } from "@/actions/smart-list-board";
import { CellEditor, CellValue, TotalCell } from "@/components/smart-lists/cells";
import type { ListTotals } from "@/lib/smart-lists/totals";
import type { BoardRow } from "@/components/smart-lists/smart-list-board";
import { groupHeads } from "@/components/smart-lists/list-views";
import { ScrollX } from "@/components/ui/scroll-x";

/**
 * A list with rows of its own (owner, 20 Nov 2026 — src/lib/smart-lists/own-rows.ts), as a Notion table: the title
 * first (click to rename it), the list's columns edited in place as a company list's are, who changed the row last,
 * and a line at the foot to add a row. Saving is the board's (src/components/smart-lists/smart-list-board.tsx).
 */
export function OwnTableView({
  rows,
  properties,
  values,
  people,
  onSetValue,
  onOpen,
  titleName,
  canEdit,
  canDelete,
  onEditColumn,
  onAddColumn,
  onEditTitleColumn,
  onRename,
  onAdd,
  onDelete,
  emptyHint,
  selected,
  onSelect,
  totals = null,
  groupBy = null,
  readOnly = false,
  onMove,
}: {
  /** View-only for this person (Smart Lists phase 4): nothing changes from here. */
  readOnly?: boolean;
  /** Moving a row above or below another — by dragging its handle, or its arrow keys (phase 4). Absent: rows stay put (a sort or groups decide the order). */
  onMove?: (rowId: string, targetId: string, place: "before" | "after") => void;
  /** The column the rows are grouped by (Smart Lists phase 3). */
  groupBy?: BoardProperty | null;
  /** Rows ticked to change at once, and ticking them (Smart Lists phase 2). */
  selected?: Set<string>;
  onSelect?: (ids: string[], on: boolean) => void;
  /** The footer: every column added up over the rows the view shows (src/lib/smart-lists/totals.ts). */
  totals?: ListTotals | null;
  rows: BoardRow[];
  properties: BoardProperty[];
  values: Record<string, Record<string, unknown>>;
  people: { id: string; name: string }[];
  onSetValue: (rowId: string, property: BoardProperty, raw: unknown) => void;
  onOpen: (row: BoardRow) => void;
  titleName: string;
  canEdit: boolean;
  canDelete: (row: BoardRow) => boolean;
  onEditColumn: (p: BoardProperty) => void;
  onAddColumn: () => void;
  onEditTitleColumn: () => void;
  onRename: (row: BoardRow, title: string) => void;
  onAdd: (title: string) => Promise<boolean>;
  onDelete: (row: BoardRow) => void;
  emptyHint: string;
}) {
  const names = useMemo(() => new Map(people.map((p) => [p.id, p.name])), [people]);
  const [editing, setEditing] = useState<{ row: string; prop: string } | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [adding, setAdding] = useState(false);
  const [dragging, setDragging] = useState<string | null>(null);
  const [over, setOver] = useState<{ id: string; place: "before" | "after" } | null>(null);
  const heads = groupHeads(rows, values, groupBy, names);
  const drop = () => {
    if (dragging && over && onMove && over.id !== dragging) onMove(dragging, over.id, over.place);
    setDragging(null);
    setOver(null);
  };
  const add = async () => {
    const title = draft.trim();
    if (!title || adding) return;
    setAdding(true);
    const ok = await onAdd(title);
    setAdding(false);
    if (ok) setDraft("");
  };
  const titleCell = "sticky left-0 z-[1] w-44 min-w-44 max-w-44 bg-surface sm:w-72 sm:min-w-72 sm:max-w-72";

  return (
    <ScrollX className="relative rounded-card border border-line bg-surface">
      <table className="w-max min-w-full border-collapse text-sm">
        <thead>
          <tr className="border-b border-line text-left text-xs text-muted">
            <th scope="col" className={`${titleCell} px-1 py-1 font-medium`}>
              <span className="flex items-center gap-1">
              {onSelect && selected && (
                <input
                  type="checkbox"
                  className="ml-2"
                  aria-label="Tick every row on this page"
                  checked={rows.length > 0 && rows.every((r) => selected.has(r.id))}
                  onChange={(e) => onSelect(rows.map((r) => r.id), e.target.checked)}
                />
              )}
              {canEdit ? (
                <button type="button" className="flex w-full items-center truncate rounded-base px-2 py-1 text-left hover:bg-surface-sunken" onClick={onEditTitleColumn} title="Rename this column">
                  {titleName}
                </button>
              ) : (
                <span className="block truncate px-2 py-1">{titleName}</span>
              )}
              </span>
            </th>
            {properties.map((p) => (
              <th key={p.id} scope="col" className="min-w-40 border-l border-line px-1 py-1 font-medium">
                {canEdit ? (
                  <button type="button" className="flex w-full items-center gap-1.5 truncate rounded-base px-2 py-1 text-left hover:bg-surface-sunken" onClick={() => onEditColumn(p)} title="Change this column">
                    <span className="truncate">{p.name}</span>
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
            <th scope="col" className="min-w-36 border-l border-line px-3 py-2 font-medium">
              Last changed
            </th>
            <th scope="col" className="w-16 border-l border-line px-2 py-2">
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
            <tr
              className={`group border-b border-line hover:bg-surface-sunken/60 ${over?.id === row.id ? (over.place === "before" ? "shadow-[inset_0_2px_0_var(--color-brand)]" : "shadow-[inset_0_-2px_0_var(--color-brand)]") : ""} ${dragging === row.id ? "opacity-50" : ""}`}
              onDragOver={
                onMove && dragging
                  ? (e) => {
                      e.preventDefault();
                      const box = e.currentTarget.getBoundingClientRect();
                      const place = e.clientY < box.top + box.height / 2 ? "before" : "after";
                      if (over?.id !== row.id || over.place !== place) setOver({ id: row.id, place });
                    }
                  : undefined
              }
              onDrop={
                onMove && dragging
                  ? (e) => {
                      e.preventDefault();
                      drop();
                    }
                  : undefined
              }
            >
              <th scope="row" className={`${titleCell} px-1 py-0.5 text-left font-medium group-hover:bg-surface-sunken`}>
                <span className="flex items-center gap-1">
                {onMove && (
                  <button
                    type="button"
                    draggable
                    aria-label={`Move ${row.name} — drag it, or use the up and down arrow keys`}
                    title="Drag to move"
                    className="shrink-0 cursor-grab rounded p-0.5 text-subtle opacity-0 hover:text-text focus:opacity-100 group-hover:opacity-100"
                    onDragStart={(e) => {
                      e.dataTransfer.effectAllowed = "move";
                      e.dataTransfer.setData("text/plain", row.id);
                      setDragging(row.id);
                    }}
                    onDragEnd={() => {
                      setDragging(null);
                      setOver(null);
                    }}
                    onKeyDown={(e) => {
                      const at = rows.findIndex((r) => r.id === row.id);
                      if (e.key === "ArrowUp" && at > 0) {
                        e.preventDefault();
                        onMove(row.id, rows[at - 1]!.id, "before");
                      } else if (e.key === "ArrowDown" && at >= 0 && at < rows.length - 1) {
                        e.preventDefault();
                        onMove(row.id, rows[at + 1]!.id, "after");
                      }
                    }}
                  >
                    <GripVertical className="h-3.5 w-3.5" aria-hidden="true" />
                  </button>
                )}
                {onSelect && selected && <input type="checkbox" className="ml-2 shrink-0" aria-label={`Tick ${row.name}`} checked={selected.has(row.id)} onChange={(e) => onSelect([row.id], e.target.checked)} />}
                {renaming === row.id ? (
                  <TitleEditor
                    initial={row.name}
                    label={`${titleName}: ${row.name}`}
                    onDone={(title) => {
                      setRenaming(null);
                      if (title && title !== row.name) onRename(row, title);
                    }}
                  />
                ) : (
                  <button type="button" disabled={readOnly} className="flex min-h-8 w-full items-center truncate rounded-base px-2 text-left text-text hover:bg-surface disabled:hover:bg-transparent" onClick={() => setRenaming(row.id)} aria-label={`Rename ${row.name}`}>
                    <span className="truncate">{row.name}</span>
                  </button>
                )}
                </span>
              </th>
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
              <td className="whitespace-nowrap border-l border-line px-3 py-1.5 text-xs text-subtle">{row.own?.edited ?? ""}</td>
              <td className="border-l border-line px-1 py-1">
                <div className="flex items-center justify-end gap-0.5">
                  <button type="button" onClick={() => onOpen(row)} aria-label={`Open ${row.name}'s page`} title="Open its page" className="rounded-base p-1.5 text-subtle hover:bg-surface hover:text-text">
                    <PanelRightOpen className="h-4 w-4" />
                  </button>
                  {!readOnly && canDelete(row) && (
                    <button
                      type="button"
                      onClick={() => onDelete(row)}
                      aria-label={`Delete ${row.name}`}
                      title="Delete this row"
                      className="rounded-base p-1.5 text-subtle opacity-0 hover:bg-surface hover:text-danger focus:opacity-100 group-hover:opacity-100"
                    >
                      <Trash2 className="h-4 w-4" />
                    </button>
                  )}
                </div>
              </td>
            </tr>
            </Fragment>
          ))}
          {rows.length === 0 && (
            <tr className="border-b border-line">
              <td colSpan={properties.length + 4} className="px-4 py-10 text-center text-subtle">
                {emptyHint}
              </td>
            </tr>
          )}
          {!readOnly && (
          <tr>
            <th scope="row" className={`${titleCell} px-1 py-1 text-left font-normal`}>
              <label className="flex items-center gap-1.5 px-2 text-subtle">
                <Plus className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                <span className="sr-only">Add a row</span>
                <input
                  value={draft}
                  disabled={adding}
                  maxLength={300}
                  placeholder={`New ${titleName.toLowerCase()}…`}
                  className="h-8 w-full bg-transparent text-sm text-text outline-none placeholder:text-subtle"
                  onChange={(e) => setDraft(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void add();
                    }
                  }}
                  onBlur={() => void add()}
                />
              </label>
            </th>
            <td colSpan={properties.length + 3} />
          </tr>
          )}
        </tbody>
        {totals && properties.length > 0 && (
          <tfoot>
            <tr className="border-t border-line bg-surface-sunken/40">
              <th scope="row" className={`${titleCell} px-3 py-1.5 text-left text-xs font-medium text-muted`}>
                {totals.count.toLocaleString("en-IN")} row{totals.count === 1 ? "" : "s"}
              </th>
              {properties.map((p) => (
                <td key={p.id} className="border-l border-line py-1.5">
                  <TotalCell property={p} total={totals.columns[p.id]} />
                </td>
              ))}
              {canEdit && <td className="border-l border-line" />}
              <td className="border-l border-line" />
              <td className="border-l border-line" />
            </tr>
          </tfoot>
        )}
      </table>
    </ScrollX>
  );
}

function TitleEditor({ initial, label, onDone }: { initial: string; label: string; onDone: (title: string | null) => void }) {
  const [value, setValue] = useState(initial);
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    ref.current?.focus();
    ref.current?.select();
  }, []);
  return (
    <input
      ref={ref}
      aria-label={label}
      value={value}
      maxLength={300}
      className="h-8 w-full rounded-base border border-brand bg-surface px-2 text-sm text-text outline-none"
      onChange={(e) => setValue(e.target.value)}
      onBlur={() => onDone(value.trim() || null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          onDone(value.trim() || null);
        }
        if (e.key === "Escape") {
          e.preventDefault();
          onDone(null);
        }
      }}
    />
  );
}
