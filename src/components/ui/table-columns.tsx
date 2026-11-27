"use client";

import {
  Children,
  cloneElement,
  createContext,
  Fragment,
  isValidElement,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { Columns3, RotateCcw, Check, PanelLeft, PanelRight } from "lucide-react";
import { setTableColumns, resetTableColumns } from "@/actions/table-preference";
import {
  getTableDefinition,
  resolveColumns,
  isDefaultSelection,
  isFieldChoice,
  isFreezeChoice,
  fieldOfChoice,
  fieldChoice,
  freezeChoice,
  frozenColumns,
  columnOfFreeze,
  showsField,
  type Freeze,
} from "@/lib/tables/registry";
import { AnchoredPopover } from "@/components/ui/anchored-popover";

/**
 * Per-user column visibility for records tables.
 *
 * ## Why a context rather than a prop
 *
 * Every table here is a client component fed rows by a server page. Threading the preference down
 * would mean editing all ~18 pages as well as all ~18 tables, and a table rendered inside a tab
 * three levels deep would need the prop passed through components with no other reason to know
 * about it. The layout reads every preference once and provides them here.
 *
 * It also avoids the flash: a table that fetched its own preference on mount would render default
 * columns first and then rearrange itself, which reads as a bug every time.
 *
 * ## The invariant
 *
 * `show(key)` is called twice per column — once in the header, once in the body — and both calls
 * must use the same key. If they diverge the header and the rows disagree about how many cells
 * there are, every row below shifts one across, and it looks like bad data rather than a rendering
 * fault. `npm run check:tables` compares the two sets for every registered table, which is what
 * makes this safe to apply across twenty screens.
 *
 * Use `count` for the `colSpan` on empty-state rows. Hardcoding it is the other way this breaks.
 *
 * ## Frozen columns
 *
 * Somebody may freeze any shown column at the left or right edge, and the ones between scroll
 * sideways under them. A table opts in by tagging each cell, header and body, with `data-col` (its
 * column key, or `cf.<field>` — the field cells do that themselves), passing each row's cells through
 * `arrange`, and drawing the table as `<ColumnsTable columns={cols}>`. The tick box is always frozen
 * left. A cell without a tag never freezes and keeps its place among the scrolling ones.
 *
 * The workspace's own fields follow the same rule by construction rather than by check: a table
 * filters its field columns once, through `showCustom`, and hands that one list to both the header
 * cells and the row cells (src/components/custom-fields/custom-field-cells.tsx), adding its length to
 * `count` for the `colSpan`.
 */

type Preferences = Record<string, string[]>;

const TableColumnsContext = createContext<{
  preferences: Preferences;
  setPreference: (tableKey: string, columns: string[]) => void;
  clearPreference: (tableKey: string) => void;
}>({ preferences: {}, setPreference: () => {}, clearPreference: () => {} });

export function TableColumnsProvider({ initial, children }: { initial: Preferences; children: React.ReactNode }) {
  const [preferences, setPreferences] = useState<Preferences>(initial);

  const setPreference = useCallback((tableKey: string, columns: string[]) => {
    setPreferences((prev) => ({ ...prev, [tableKey]: columns }));
  }, []);

  /**
   * Removes the key entirely rather than writing the defaults into it.
   *
   * The two look identical today and diverge the moment a new column ships: an absent key tracks
   * the registry, while a stored copy of today's defaults freezes this table forever.
   */
  const clearPreference = useCallback((tableKey: string) => {
    setPreferences((prev) => {
      if (!Object.prototype.hasOwnProperty.call(prev, tableKey)) return prev;
      const next = { ...prev };
      delete next[tableKey];
      return next;
    });
  }, []);

  const value = useMemo(
    () => ({ preferences, setPreference, clearPreference }),
    [preferences, setPreference, clearPreference],
  );
  return <TableColumnsContext.Provider value={value}>{children}</TableColumnsContext.Provider>;
}

export type TableColumns = {
  show: (key: string) => boolean;
  /** The edge a column is frozen at, or null. The tick box (`select`) is frozen left whenever it is shown. */
  frozen: (key: string) => Freeze | null;
  /** For the `<table>`: measures the frozen columns, so each sits just past the ones before it. */
  measure: (table: HTMLTableElement | null) => void;
  /**
   * One row's cells, header or body, in the order they are written — each tagged `data-col` with its
   * column key. Frozen ones come back moved to their edge (in their own order) and made sticky; the
   * rest, and any cell without a tag, keep their places between. Use it for every row of the table,
   * the header included, or the frozen header cells and the frozen body cells disagree.
   */
  arrange: (cells: React.ReactNode) => React.ReactNode[];
  /**
   * Whether one of the workspace's own fields is a column here: this person's choice in the picker,
   * or the field's default (`default` from src/lib/custom-fields/server.ts `listColumns`) without one.
   */
  showCustom: (key: string, byDefault: boolean) => boolean;
  /** Visible column count, for `colSpan` — the registry's columns; a table adds its field columns. */
  count: number;
  visible: string[];
};

/**
 * What a table asks for.
 *
 * Shows everything when the table is not in the registry, deliberately: an unregistered table must
 * render exactly as it did before rather than collapsing to nothing the moment somebody imports
 * this hook.
 */
export function useColumns(tableKey: string): TableColumns {
  const { preferences } = useContext(TableColumnsContext);
  const def = getTableDefinition(tableKey);
  const [table, setTable] = useState<HTMLTableElement | null>(null);

  const stored = def && Object.prototype.hasOwnProperty.call(preferences, tableKey) ? preferences[tableKey]! : null;
  const columns = useMemo(() => {
    const frozenMap = def ? frozenColumns(stored) : new Map<string, Freeze>();
    const frozen = (key: string): Freeze | null => (key === "select" ? "left" : (frozenMap.get(key) ?? null));
    const arrange = (cells: React.ReactNode) => arrangeCells(cells, frozen);
    if (!def) {
      return { show: () => true, showCustom: (_key: string, byDefault: boolean) => byDefault, count: 0, visible: [], frozen, arrange };
    }
    const visible = resolveColumns(tableKey, stored);
    const set = new Set(visible);
    return {
      show: (key: string) => set.has(key),
      // A table whose picker doesn't offer the fields has no choices about them to read.
      showCustom: (key: string, byDefault: boolean) => (def.customFields ? showsField(stored, key, byDefault) : byDefault),
      count: visible.length,
      visible,
      frozen,
      arrange,
    };
  }, [def, stored, tableKey]);

  useFrozenOffsets(table, (stored ?? []).join(","));

  return useMemo(() => ({ ...columns, measure: setTable }), [columns]);
}

/**
 * The `<table>` of a list with a column picker — a plain table that also measures its frozen columns.
 * A component rather than `ref={cols.measure}` in each list, where the React compiler's lint takes
 * the whole `cols` for a ref and refuses every `cols.show` read during render.
 */
export function ColumnsTable({ columns: { measure }, ...props }: { columns: TableColumns } & React.TableHTMLAttributes<HTMLTableElement>) {
  const own = useRef<HTMLTableElement | null>(null);
  const ref = useCallback(
    (table: HTMLTableElement | null) => {
      own.current = table;
      measure(table);
    },
    [measure],
  );
  // Never narrower than its columns need (owner, 31 Oct 2026: "not scrollable when columns are added, so the columns get
  // narrower"): a full-width table squeezed every column to fit; at least MIN_COLUMN_REM a column, the list scrolls
  // sideways instead. Every render, as the picker may have added or taken one away — the header's cells, so the
  // workspace's own field columns count too.
  useLayoutEffect(() => {
    const table = own.current;
    if (!table) return;
    const columns = table.tHead?.rows[0]?.cells.length ?? 0;
    table.style.minWidth = columns > 0 ? `${columns * MIN_COLUMN_REM}rem` : "";
  });
  return <table ref={ref} {...props} />;
}

/** The narrowest a list's column gets before the list scrolls sideways rather than squeezing it. */
const MIN_COLUMN_REM = 8;

type CellProps = { "data-col"?: string; className?: string; style?: React.CSSProperties };

/** The cells of a row as a flat list: fragments opened, and the field cells drawn out (`expandsCells`). */
function flattenCells(node: React.ReactNode, out: React.ReactNode[] = []): React.ReactNode[] {
  for (const child of Children.toArray(node)) {
    if (isValidElement<{ children?: React.ReactNode }>(child)) {
      if (child.type === Fragment) {
        flattenCells(child.props.children, out);
        continue;
      }
      const type = child.type as { expandsCells?: true } & ((props: unknown) => React.ReactNode);
      if (typeof type === "function" && type.expandsCells) {
        flattenCells(type(child.props), out);
        continue;
      }
    }
    out.push(child);
  }
  return out;
}

function arrangeCells(cells: React.ReactNode, frozen: (key: string) => Freeze | null): React.ReactNode[] {
  const flat = flattenCells(cells);
  const sideOf = (cell: React.ReactNode) => {
    const key = isValidElement<CellProps>(cell) ? cell.props["data-col"] : undefined;
    return key ? frozen(key) : null;
  };
  const left = flat.filter((c) => sideOf(c) === "left");
  const right = flat.filter((c) => sideOf(c) === "right");
  // Rekeyed by column: the list mixes cells from different levels, whose own keys could meet.
  const keyOf = (cell: React.ReactElement<CellProps>, i: number) => cell.props["data-col"] ?? `cell-${i}`;
  const stick = (cell: React.ReactNode, side: Freeze, index: number, edge: boolean) => {
    const el = cell as React.ReactElement<CellProps>;
    return cloneElement(el, {
      key: keyOf(el, -1),
      "data-freeze": side,
      "data-freeze-edge": edge ? "" : undefined,
      className: `${el.props.className ?? ""} frozen-cell`,
      style: { ...el.props.style, [side]: `var(--fz-${side}-${index}, 0px)` },
    } as CellProps);
  };
  return [
    ...left.map((c, i) => stick(c, "left", i, i === left.length - 1)),
    ...flat.map((c, i) => (sideOf(c) || !isValidElement<CellProps>(c) ? null : cloneElement(c, { key: keyOf(c, i) }))).filter(Boolean),
    // Counted from the right edge: the last cell sits at 0, the one before it past that one.
    ...right.map((c, i) => stick(c, "right", right.length - 1 - i, i === 0)),
  ];
}

/** The nearest box that scrolls sideways — the table's own wrapper, normally. */
function scrollerOf(table: HTMLTableElement): HTMLElement | null {
  for (let el = table.parentElement; el; el = el.parentElement) {
    const overflow = getComputedStyle(el).overflowX;
    if (overflow === "auto" || overflow === "scroll") return el;
  }
  return null;
}

/**
 * Writes each frozen column's offset onto the table, from the header's cells: the widths of the
 * frozen columns before it at its edge. Measured again whenever a frozen column changes size — new
 * rows, a narrower window — and whenever the choices change. Also marks whether anything has slid
 * under either edge yet, which is when the edge shadow shows.
 */
function useFrozenOffsets(table: HTMLTableElement | null, choices: string) {
  useLayoutEffect(() => {
    if (!table) return;
    const scroller = scrollerOf(table);
    const headerCells = () => Array.from((table.tHead?.rows[0] ?? table.rows[0])?.cells ?? []);

    const edges = () => {
      if (!scroller) return;
      const max = scroller.scrollWidth - scroller.clientWidth;
      table.toggleAttribute("data-fz-scrolled", scroller.scrollLeft > 0);
      table.toggleAttribute("data-fz-more", scroller.scrollLeft < max - 1);
    };
    const measure = () => {
      const cells = headerCells();
      for (const side of ["left", "right"] as const) {
        const at = cells.filter((c) => c.dataset.freeze === side);
        if (side === "right") at.reverse();
        let offset = 0;
        at.forEach((cell, i) => {
          table.style.setProperty(`--fz-${side}-${i}`, `${offset}px`);
          offset += cell.getBoundingClientRect().width;
        });
      }
      edges();
    };

    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(table);
    for (const cell of headerCells()) if (cell.dataset.freeze) observer.observe(cell);
    scroller?.addEventListener("scroll", edges, { passive: true });
    return () => {
      observer.disconnect();
      scroller?.removeEventListener("scroll", edges);
    };
  }, [table, choices]);
}

/** The picker. Drop it beside a table's filters. */
export function ColumnPicker({
  tableKey,
  className,
  omit,
  customColumns,
  variant = "default",
}: {
  tableKey: string;
  className?: string;
  /** "toolbar": the height and corners of a compact filter toolbar's controls (the lead pipeline's). */
  variant?: "default" | "toolbar";
  /** Columns not offered here: one that means nothing in this workspace, like Branch with a single branch. */
  omit?: string[];
  /**
   * The workspace's own fields this person may see (src/lib/custom-fields/server.ts `listColumns`),
   * offered under "Your fields" on a table that shows them, each starting as its own default.
   */
  customColumns?: { key: string; label: string; default: boolean }[];
}) {
  const { preferences, setPreference, clearPreference } = useContext(TableColumnsContext);
  const def = getTableDefinition(tableKey);
  const anchorRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);
  const [, startTransition] = useTransition();

  const stored =
    def && Object.prototype.hasOwnProperty.call(preferences, tableKey) ? preferences[tableKey]! : null;
  // Both memoised on the stored value rather than on `visible`: a fresh array every render would
  // rebuild the Set every render, which is what the exhaustive-deps warning is pointing at.
  const visible = useMemo(() => (def ? resolveColumns(tableKey, stored) : []), [def, tableKey, stored]);
  const chosen = useMemo(() => new Set(visible), [visible]);

  if (!def) return null;

  const fields = def.customFields ? (customColumns ?? []) : [];
  const isDefault = isDefaultSelection(tableKey, stored, fields);
  const offered = omit?.length ? def.columns.filter((c) => !omit.includes(c.key)) : def.columns;
  const hiddenCount =
    offered.filter((c) => !chosen.has(c.key)).length + fields.filter((f) => !showsField(stored, f.key, f.default)).length;
  // The choices already made about fields, carried through a change to a built-in column as they are:
  // a field nobody has chosen about goes on following its own default.
  const fieldChoices = (stored ?? []).filter(isFieldChoice);
  // And the freezes, the same way. A hidden column keeps its freeze, so showing it again brings it back where it was.
  const freezeChoices = (stored ?? []).filter(isFreezeChoice);
  const frozen = frozenColumns(stored);

  // The context is updated first so the table re-renders on the click, and the write follows. A
  // checkbox that does nothing for 300ms and then jumps gets clicked twice.
  const save = (next: string[]) => {
    setPreference(tableKey, next);
    startTransition(async () => {
      await setTableColumns(tableKey, next);
    });
  };

  const toggle = (key: string) =>
    save([...(chosen.has(key) ? visible.filter((k) => k !== key) : [...visible, key]), ...fieldChoices, ...freezeChoices]);

  const toggleField = (field: { key: string; default: boolean }) =>
    save([
      ...visible,
      ...fieldChoices.filter((c) => fieldOfChoice(c) !== field.key),
      fieldChoice(field.key, !showsField(stored, field.key, field.default)),
      ...freezeChoices,
    ]);

  // Pressing the edge a column is already frozen at unfreezes it.
  const freeze = (columnKey: string, side: Freeze) =>
    save([
      ...visible,
      ...fieldChoices,
      ...freezeChoices.filter((c) => columnOfFreeze(c) !== columnKey),
      ...(frozen.get(columnKey) === side ? [] : [freezeChoice(columnKey, side)]),
    ]);

  const freezeButtons = (columnKey: string, label: string) => (
    <span className="mt-1 flex shrink-0 items-center gap-0.5">
      {(["left", "right"] as const).map((side) => {
        const on = frozen.get(columnKey) === side;
        const Icon = side === "left" ? PanelLeft : PanelRight;
        const title = on ? `Unfreeze ${label}` : `Freeze ${label} at the ${side}`;
        return (
          <button
            key={side}
            type="button"
            aria-pressed={on}
            aria-label={title}
            title={title}
            onClick={() => freeze(columnKey, side)}
            className={`grid h-6 w-6 place-items-center rounded ${
              on ? "bg-brand-subtle text-brand" : "text-subtle hover:bg-surface-sunken hover:text-text"
            }`}
          >
            <Icon className="h-3.5 w-3.5" />
          </button>
        );
      })}
    </span>
  );

  const reset = () => {
    clearPreference(tableKey);
    startTransition(async () => {
      await resetTableColumns(tableKey);
    });
  };

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className={`inline-flex shrink-0 items-center gap-1.5 border border-line-strong font-medium text-muted hover:bg-surface-sunken hover:text-text ${variant === "toolbar" ? "h-8 rounded-lg bg-surface px-2.5 text-[12.5px]" : "h-8 rounded-md px-2.5 text-sm"} ${className ?? ""}`}
      >
        <Columns3 className={variant === "toolbar" ? "h-[15px] w-[15px]" : "h-3.5 w-3.5"} />
        {/* On a phone the toolbar's button is its icon and count; the word is still its name. */}
        <span className={variant === "toolbar" ? "max-sm:sr-only" : undefined}>Columns</span>
        {hiddenCount > 0 && (
          <span className="rounded-full bg-brand-subtle px-1.5 text-[11px] font-semibold text-brand">
            {hiddenCount}
          </span>
        )}
      </button>

      {/* One scroller, the list: the panel itself would scroll too (owner, 30 Oct 2026), and its scrollbar sat
          outside the content, so reaching for it closed the picker. Header and footer stay put. */}
      <AnchoredPopover anchorRef={anchorRef} open={open} width={304} align="end" maxHeight={440} className="flex flex-col overflow-hidden" onPointerLeave={() => setOpen(false)}>
        <div className="flex min-h-0 flex-col p-1">
          <div className="flex items-center justify-between px-2 py-1.5">
            <span className="text-xs font-semibold uppercase tracking-wide text-subtle">{def.label}</span>
            {!isDefault && (
              <button
                type="button"
                onClick={reset}
                className="inline-flex items-center gap-1 text-[11px] font-medium text-muted hover:text-text"
              >
                <RotateCcw className="h-3 w-3" />
                Reset
              </button>
            )}
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
            {offered.map((col) => {
              const on = chosen.has(col.key);
              return (
                <div key={col.key} className="flex items-start gap-1 pr-1">
                  <button
                    type="button"
                    aria-pressed={on}
                    disabled={col.required}
                    title={col.required ? "This column can't be hidden." : col.hint}
                    onClick={() => toggle(col.key)}
                    className={`flex min-w-0 flex-1 items-start gap-2 rounded px-2 py-1.5 text-left text-sm ${
                      col.required ? "cursor-not-allowed" : "hover:bg-surface-sunken"
                    }`}
                  >
                    <span
                      className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border ${
                        on ? "border-brand bg-brand text-brand-contrast" : "border-line-strong"
                      } ${col.required ? "opacity-50" : ""}`}
                    >
                      {on && <Check className="h-3 w-3" />}
                    </span>
                    <span className="min-w-0">
                      <span className="block text-text">{col.label}</span>
                      {col.hint && <span className="block text-xs leading-snug text-subtle">{col.hint}</span>}
                    </span>
                  </button>
                  {/* The tick box is frozen whenever it is shown; nothing to choose. */}
                  {on && col.key !== "select" && freezeButtons(col.key, col.label)}
                </div>
              );
            })}

            {fields.length > 0 && (
              <>
                <div className="mt-1 border-t border-line px-2 pb-1 pt-2 text-xs font-semibold uppercase tracking-wide text-subtle">
                  Your fields
                </div>
                {fields.map((field) => {
                  const on = showsField(stored, field.key, field.default);
                  return (
                    <div key={fieldChoice(field.key, true)} className="flex items-start gap-1 pr-1">
                      <button
                        type="button"
                        aria-pressed={on}
                        onClick={() => toggleField(field)}
                        className="flex min-w-0 flex-1 items-start gap-2 rounded px-2 py-1.5 text-left text-sm hover:bg-surface-sunken"
                      >
                        <span
                          className={`mt-0.5 grid h-4 w-4 shrink-0 place-items-center rounded border ${
                            on ? "border-brand bg-brand text-brand-contrast" : "border-line-strong"
                          }`}
                        >
                          {on && <Check className="h-3 w-3" />}
                        </span>
                        <span className="min-w-0 text-text">{field.label}</span>
                      </button>
                      {on && freezeButtons(fieldChoice(field.key, true), field.label)}
                    </div>
                  );
                })}
              </>
            )}
          </div>

          <p className="flex items-center gap-1 border-t border-line px-2 py-1.5 text-xs text-subtle">
            <PanelLeft className="h-3 w-3 shrink-0" />
            <PanelRight className="h-3 w-3 shrink-0" />
            <span>freeze a column at that edge; the rest scroll between.</span>
          </p>

          {visible.length <= 2 && (
            <p className="border-t border-line px-2 py-1.5 text-xs text-warning">
              Almost everything is hidden. Reset brings the table back.
            </p>
          )}
        </div>
      </AnchoredPopover>
    </>
  );
}
