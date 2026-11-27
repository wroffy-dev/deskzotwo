"use client";

import { useEffect, useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { CalendarDays, CalendarRange, ChartColumn, Columns3, LayoutGrid, Plus, Share2, Table2, Trash2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { confirmAction } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import {
  addListView,
  deleteListView,
  pinListRow,
  searchCompaniesForList,
  setListValue,
  unpinListRow,
  updateListView,
  type BoardProperty,
  type BoardView,
} from "@/actions/smart-list-board";
import { LIMITS, type ViewKind } from "@/lib/smart-lists/values";
import { BoardView as Kanban, CalendarView, GalleryView, TableView, TimelineView } from "@/components/smart-lists/list-views";
import { ColumnDialog } from "@/components/smart-lists/column-dialog";
import { RowPage } from "@/components/smart-lists/row-page";
import { ShareListDialog } from "@/components/connect/share-list-dialog";
import { ListDashboardView } from "@/components/smart-lists/list-dashboard";
import type { ListDashboard } from "@/lib/smart-lists/dashboard";
import { OwnTableView } from "@/components/smart-lists/own-table-view";
import { addOwnRow, deleteOwnRows, moveOwnRow, renameOwnRow, renameTitleColumn, setOwnRowValue } from "@/actions/smart-list-rows";
import { setManyValues, setTimelineOptions } from "@/actions/smart-list-links";
import { FilterBar, QUERY_PARAM } from "@/components/smart-lists/filter-bar";
import { LinkLabels } from "@/components/smart-lists/link-labels";
import { CellEditor } from "@/components/smart-lists/cells";
import type { LinkLabel } from "@/lib/smart-lists/links";
import type { ListTotals } from "@/lib/smart-lists/totals";
import type { ViewQuery } from "@/lib/smart-lists/view-query";

/**
 * A Smart List worked like a Notion database (owner, 20 Nov 2026 — "can we do something around smart lists along with
 * notion type ui"): its saved views as tabs (a table always first), its own columns edited in place, a page per row, and
 * companies added by hand. The rows are the page's — the list's filters and hand-added companies, as the person may
 * see them — and saving goes through src/actions/smart-list-board.ts, which checks all of it again.
 */

export type BoardRow = {
  id: string;
  name: string;
  href: string;
  place: string;
  ownerName: string | null;
  /** A row of the list's own, not a company (src/lib/smart-lists/own-rows.ts): who changed it last and when, in words. */
  own?: { edited: string; mine: boolean };
};

const KIND_ICON = { TABLE: Table2, BOARD: Columns3, CALENDAR: CalendarDays, GALLERY: LayoutGrid, TIMELINE: CalendarRange } as const;

export function SmartListBoard({
  workbookId,
  rows,
  properties,
  views,
  values: initialValues,
  pinned,
  people,
  activeViewId,
  canEdit,
  canAddRows,
  canPin,
  today,
  ready,
  canMessage = false,
  dashboard = null,
  own = null,
  canFill = true,
  query = null,
  labels: initialLabels = {},
  totals = null,
}: {
  /** A list with rows of its own (owner, 20 Nov 2026 — src/lib/smart-lists/own-rows.ts): what its title column is called. */
  own?: { titleName: string } | null;
  /** May fill it in — false for somebody the list is view-only to (Smart Lists phase 4). */
  canFill?: boolean;
  /** The view's filters and sort — saved, and in force now (Smart Lists phase 2, src/lib/smart-lists/view-query.ts). */
  query?: { saved: ViewQuery; current: ViewQuery } | null;
  /** The records and files the cells on screen link to, by id, as this person may see them. */
  labels?: Record<string, LinkLabel>;
  /** The table's footer: every column added up over the rows the view shows. */
  totals?: ListTotals | null;
  canMessage?: boolean;
  /** The list summed up — given when the Dashboard tab is open (owner, 20 Nov 2026). */
  dashboard?: ListDashboard | null;
  workbookId: string;
  rows: BoardRow[];
  properties: BoardProperty[];
  views: BoardView[];
  values: Record<string, Record<string, unknown>>;
  pinned: string[];
  people: { id: string; name: string }[];
  /** The saved view on screen; null — the plain table. */
  activeViewId: string | null;
  canEdit: boolean;
  canAddRows: boolean;
  /** Whether companies can be added by hand here — a list, not a calling activity. */
  canPin: boolean;
  today: string;
  ready: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [values, setValues] = useState(initialValues);
  // Fresh values from the server (a refresh, another page) replace the ones held here.
  const [from, setFrom] = useState(initialValues);
  if (from !== initialValues) {
    setFrom(initialValues);
    setValues(initialValues);
  }
  const [open, setOpen] = useState<BoardRow | null>(null);
  const [column, setColumn] = useState<{ property: BoardProperty | null } | null>(null);
  const [addingView, setAddingView] = useState(false);
  const [addingCompany, setAddingCompany] = useState(false);
  const [sharing, setSharing] = useState(false);
  const pinnedSet = useMemo(() => new Set(pinned), [pinned]);
  // Linked records' names: the server's, and the ones a picker just chose (Smart Lists phase 2).
  const [learnt, setLearnt] = useState<Record<string, LinkLabel>>({});
  const linkLabels = useMemo(() => ({ labels: { ...initialLabels, ...learnt }, learn: (more: Record<string, LinkLabel>) => setLearnt((l) => ({ ...l, ...more })) }), [initialLabels, learnt]);
  // Rows ticked to change at once — those still on screen.
  const [ticked, setTicked] = useState<Set<string>>(new Set());
  const onScreen = new Set(rows.map((r) => r.id));
  const selected = new Set([...ticked].filter((id) => onScreen.has(id)));
  const select = (ids: string[], on: boolean) =>
    setTicked((t) => {
      const next = new Set(t);
      for (const id of ids) {
        if (on) next.add(id);
        else next.delete(id);
      }
      return next;
    });
  const [bulkSetting, setBulkSetting] = useState(false);
  // The column the table groups its rows by (Smart Lists phase 3).
  const groupBy = query?.current.group ? (properties.find((p) => p.id === query.current.group) ?? null) : null;

  const view = views.find((v) => v.id === activeViewId) ?? null;
  const viewProperty = view?.propertyId ? (properties.find((p) => p.id === view.propertyId) ?? null) : null;
  const hrefFor = (id: string | null) => {
    const q = new URLSearchParams(search.toString());
    if (id) q.set("view", id);
    else q.delete("view");
    q.delete("page");
    // Another view brings its own filters (Smart Lists phase 2).
    q.delete(QUERY_PARAM);
    const s = q.toString();
    return `${pathname}${s ? `?${s}` : ""}`;
  };

  const [titling, setTitling] = useState(false);

  const setValue = async (companyId: string, property: BoardProperty, raw: unknown) => {
    const before = values;
    setValues((v) => ({ ...v, [companyId]: { ...(v[companyId] ?? {}), [property.id]: raw === "" ? null : raw } }));
    // A row of the list's own is saved as one (src/actions/smart-list-rows.ts); a company's as before.
    const r = own ? await setOwnRowValue({ propertyId: property.id, rowId: companyId, value: raw }) : await setListValue({ propertyId: property.id, companyId, value: raw });
    if (!r.ok) {
      setValues(before);
      return toast.error(r.error);
    }
    setValues((v) => ({ ...v, [companyId]: { ...(v[companyId] ?? {}), [property.id]: r.data.value } }));
  };

  const deleteTicked = async () => {
    const ids = [...selected];
    if (!(await confirmAction({ title: `Delete ${ids.length} row${ids.length === 1 ? "" : "s"}?`, message: "They go, with their values, notes, checklists and files. Rows somebody else added stay unless you built this list. This can't be undone.", confirmLabel: "Delete", danger: true }))) return;
    const r = await deleteOwnRows({ workbookId, rowIds: ids });
    if (!r.ok) return toast.error(r.error);
    toast.success(`${r.data.deleted} row${r.data.deleted === 1 ? "" : "s"} deleted.`);
    setTicked(new Set());
    router.refresh();
  };

  const unpin = async (row: BoardRow) => {
    if (!(await confirmAction({ title: `Take ${row.name} off this list?`, message: "It was added by hand. Its values and page in this list stay, and come back if it's added again.", confirmLabel: "Take off" }))) return;
    const r = await unpinListRow(workbookId, row.id);
    if (!r.ok) return toast.error(r.error);
    router.refresh();
  };

  const addRow = async (title: string) => {
    const r = await addOwnRow({ workbookId, title });
    if (!r.ok) {
      toast.error(r.error);
      return false;
    }
    router.refresh();
    return true;
  };

  const renameRow = async (row: BoardRow, title: string) => {
    const r = await renameOwnRow({ rowId: row.id, title });
    if (!r.ok) return toast.error(r.error);
    if (open?.id === row.id) setOpen({ ...open, name: r.data.title });
    router.refresh();
  };

  const deleteRow = async (row: BoardRow) => {
    if (!(await confirmAction({ title: `Delete "${row.name}"?`, message: "The row goes, with its values, notes and checklist. This can't be undone.", confirmLabel: "Delete row", danger: true }))) return;
    const r = await deleteOwnRows({ workbookId, rowIds: [row.id] });
    if (!r.ok) return toast.error(r.error);
    if (open?.id === row.id) setOpen(null);
    router.refresh();
  };

  // A row dragged above or below another (Smart Lists phase 4) — only in the list's own order: no sort, no groups.
  const moveRow = async (rowId: string, targetId: string, place: "before" | "after") => {
    const r = await moveOwnRow({ rowId, targetRowId: targetId, place });
    if (!r.ok) return toast.error(r.error);
    router.refresh();
  };
  const canMove = !!own && canFill && !groupBy && !(query?.current.sort.length ?? 0);

  const removeView = async () => {
    if (!view) return;
    if (!(await confirmAction({ title: `Delete the view "${view.name}"?`, message: "Only the view goes — the list, its columns and their values stay.", confirmLabel: "Delete view", danger: true }))) return;
    const r = await deleteListView(view.id);
    if (!r.ok) return toast.error(r.error);
    router.push(hrefFor(null));
    router.refresh();
  };

  if (!ready) {
    return <p className="rounded-card border border-line bg-surface px-4 py-6 text-sm text-muted">Views and columns arrive with this workspace&apos;s next update. Try again in a few minutes.</p>;
  }

  const common = { rows, properties, values, people, onSetValue: setValue, onOpen: setOpen };

  return (
    <LinkLabels.Provider value={linkLabels}>
    <div className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line">
        <nav aria-label="Views" className="-mb-px flex flex-wrap items-center gap-0.5">
          {[{ id: null, name: "Table", kind: "TABLE" as ViewKind }, ...views].map((v) => {
            const Icon = KIND_ICON[v.kind];
            const active = !dashboard && (v.id ?? null) === (view?.id ?? null);
            return (
              <Link
                key={v.id ?? "table"}
                href={hrefFor(v.id)}
                aria-current={active ? "page" : undefined}
                className={cn("inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm", active ? "border-text font-medium text-text" : "border-transparent text-muted hover:text-text")}
              >
                <Icon className="h-3.5 w-3.5" aria-hidden="true" />
                {v.name}
              </Link>
            );
          })}
          <Link
            href={hrefFor("dashboard")}
            aria-current={dashboard ? "page" : undefined}
            className={cn("inline-flex items-center gap-1.5 border-b-2 px-3 py-2 text-sm", dashboard ? "border-text font-medium text-text" : "border-transparent text-muted hover:text-text")}
          >
            <ChartColumn className="h-3.5 w-3.5" aria-hidden="true" />
            Dashboard
          </Link>
          {canEdit && (
            <button type="button" onClick={() => setAddingView(true)} className="inline-flex items-center gap-1 px-2.5 py-2 text-sm text-subtle hover:text-text" aria-label="Add a view">
              <Plus className="h-3.5 w-3.5" />
              View
            </button>
          )}
        </nav>
        <div className="flex items-center gap-1.5 pb-1.5">
          {canEdit && view && (
            <Button variant="ghost" size="sm" onClick={removeView} aria-label={`Delete the view ${view.name}`}>
              <Trash2 className="h-3.5 w-3.5" />
            </Button>
          )}
          {canEdit && (
            <Button variant="secondary" size="sm" onClick={() => setColumn({ property: null })}>
              <Plus className="h-3.5 w-3.5" />
              Column
            </Button>
          )}
          {canEdit && (canPin || !!own) && (
            <Button variant="secondary" size="sm" onClick={() => setSharing(true)} title="Share with people from another company (Deskzo Connect)">
              <Share2 className="h-3.5 w-3.5" />
              Share
            </Button>
          )}
          {canAddRows && canPin && (
            <Button variant="secondary" size="sm" onClick={() => setAddingCompany(true)}>
              <Plus className="h-3.5 w-3.5" />
              Add company
            </Button>
          )}
        </div>
      </div>

      {!dashboard && query && (
        <FilterBar
          workbookId={workbookId}
          viewId={view?.id ?? null}
          properties={properties}
          own={!!own}
          titleName={own ? own.titleName : "Company"}
          saved={query.saved}
          current={query.current}
          canEdit={canEdit}
          people={people}
        />
      )}

      {!dashboard && canFill && selected.size > 0 && (
        <div className="flex flex-wrap items-center gap-2 rounded-base border border-brand/30 bg-brand-subtle px-3 py-1.5 text-sm text-brand" role="region" aria-label="Ticked rows">
          <span className="font-medium">{selected.size} ticked</span>
          {properties.some((p) => p.kind !== "FILE") && (
            <Button size="sm" variant="secondary" onClick={() => setBulkSetting(true)}>
              Set a column…
            </Button>
          )}
          {own && (
            <Button size="sm" variant="secondary" onClick={deleteTicked}>
              <Trash2 className="h-3.5 w-3.5" />
              Delete
            </Button>
          )}
          <button type="button" className="ml-auto text-xs text-brand/80 hover:text-brand" onClick={() => setTicked(new Set())}>
            Clear
          </button>
        </div>
      )}

      {dashboard ? (
        <ListDashboardView data={dashboard} onAddColumn={canEdit ? () => setColumn({ property: null }) : undefined} />
      ) : view?.kind === "BOARD" && viewProperty ? (
        <Kanban {...common} property={viewProperty} />
      ) : view?.kind === "CALENDAR" && viewProperty ? (
        <CalendarView {...common} property={viewProperty} today={today} />
      ) : view?.kind === "GALLERY" ? (
        <GalleryView {...common} />
      ) : view?.kind === "TIMELINE" && viewProperty ? (
        <div className="space-y-2">
          {canEdit && (
            <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
              <span>Ends on</span>
              <Select
                aria-label="Ends on"
                className="h-7 w-48 py-0 text-xs"
                value={view.options?.endPropertyId ?? ""}
                onChange={async (e) => {
                  const r = await setTimelineOptions({ viewId: view.id, endPropertyId: e.target.value || null, scale: view.options?.scale ?? "week" });
                  if (!r.ok) return void toast.error(r.error);
                  router.refresh();
                }}
              >
                <option value="">— one day each</option>
                {properties
                  .filter((p) => p.kind === "DATE" && p.id !== viewProperty.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.name}
                    </option>
                  ))}
              </Select>
              <Select
                aria-label="Scale"
                className="h-7 w-32 py-0 text-xs"
                value={view.options?.scale ?? "week"}
                onChange={async (e) => {
                  const r = await setTimelineOptions({ viewId: view.id, endPropertyId: view.options?.endPropertyId ?? null, scale: e.target.value });
                  if (!r.ok) return void toast.error(r.error);
                  router.refresh();
                }}
              >
                <option value="week">By day</option>
                <option value="month">By month</option>
              </Select>
            </div>
          )}
          <TimelineView
            {...common}
            property={viewProperty}
            end={properties.find((p) => p.id === view.options?.endPropertyId && p.kind === "DATE") ?? null}
            scale={view.options?.scale === "month" ? "month" : "week"}
            today={today}
            readOnly={!canFill}
          />
        </div>
      ) : (
        <>
          {view && view.kind !== "TABLE" && !viewProperty && (
            <p className="rounded-base bg-warning-bg px-3 py-2 text-sm text-warning">
              This view&apos;s {view.kind === "BOARD" ? "Select" : "Date"} column was deleted, so it shows as a table. {canEdit ? "Pick another below." : ""}
            </p>
          )}
          {view && view.kind !== "TABLE" && !viewProperty && canEdit && <ViewColumnPicker view={view} properties={properties} />}
          {own ? (
            <OwnTableView
              {...common}
              titleName={own.titleName}
              canEdit={canEdit}
              canDelete={(row) => canEdit || !!row.own?.mine}
              onEditColumn={(p) => setColumn({ property: p })}
              onAddColumn={() => setColumn({ property: null })}
              onEditTitleColumn={() => setTitling(true)}
              onRename={renameRow}
              onAdd={addRow}
              onDelete={deleteRow}
              emptyHint={search.get("q") || search.has(QUERY_PARAM) || query?.current.rules.length ? "No row matches that search or filter." : `No rows yet — type a ${own.titleName.toLowerCase()} below, or import a spreadsheet.`}
              selected={selected}
              onSelect={select}
              totals={totals}
              groupBy={groupBy}
              readOnly={!canFill}
              onMove={canMove ? moveRow : undefined}
            />
          ) : (
          <TableView
            {...common}
            canEdit={canEdit}
            canAddRows={canAddRows && canPin}
            pinned={pinnedSet}
            onEditColumn={(p) => setColumn({ property: p })}
            onAddColumn={() => setColumn({ property: null })}
            onUnpin={unpin}
            canMessage={canMessage}
            selected={selected}
            onSelect={select}
            totals={totals}
            groupBy={groupBy}
            readOnly={!canFill}
          />
          )}
        </>
      )}

      {open && (
        <RowPage
          workbookId={workbookId}
          row={open}
          properties={properties}
          values={values[open.id] ?? {}}
          people={people}
          onClose={() => setOpen(null)}
          onSetValue={setValue}
          canEdit={canEdit}
          own={own ? { titleName: own.titleName, onRename: (title) => renameRow(open, title), canFill, today } : null}
        />
      )}
      {own && titling && <TitleColumnDialog workbookId={workbookId} name={own.titleName} onClose={() => setTitling(false)} />}
      {column && (
        <ColumnDialog
          key={column.property?.id ?? "new"}
          workbookId={workbookId}
          property={column.property}
          open
          guests
          own={!!own}
          listProperties={properties}
          onClose={() => setColumn(null)}
          isFirst={column.property ? properties[0]?.id === column.property.id : undefined}
          isLast={column.property ? properties.at(-1)?.id === column.property.id : undefined}
        />
      )}
      {addingView && (
        <AddViewDialog
          workbookId={workbookId}
          properties={properties}
          onClose={() => setAddingView(false)}
          onAdded={(id) => {
            setAddingView(false);
            router.push(hrefFor(id));
            router.refresh();
          }}
        />
      )}
      {sharing && <ShareListDialog workbookId={workbookId} onClose={() => setSharing(false)} />}
      {addingCompany && <AddCompanyDialog workbookId={workbookId} onClose={() => setAddingCompany(false)} />}
      {bulkSetting && (
        <BulkSetDialog
          workbookId={workbookId}
          properties={properties.filter((p) => p.kind !== "FILE")}
          people={people}
          rowKeys={[...selected]}
          onClose={() => setBulkSetting(false)}
          onDone={() => {
            setBulkSetting(false);
            setTicked(new Set());
            router.refresh();
          }}
        />
      )}
    </div>
    </LinkLabels.Provider>
  );
}

/** One column set to the same value on every ticked row (Smart Lists phase 2 — src/actions/smart-list-links.ts). */
function BulkSetDialog({
  workbookId,
  properties,
  people,
  rowKeys,
  onClose,
  onDone,
}: {
  workbookId: string;
  properties: BoardProperty[];
  people: { id: string; name: string }[];
  rowKeys: string[];
  onClose: () => void;
  onDone: () => void;
}) {
  const [propertyId, setPropertyId] = useState(properties[0]?.id ?? "");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const prop = properties.find((p) => p.id === propertyId) ?? null;
  const apply = (value: unknown) =>
    start(async () => {
      setError(null);
      const r = await setManyValues({ workbookId, propertyId, rowKeys, value });
      if (!r.ok) return setError(r.error);
      toast.success(`${prop?.name ?? "The column"} set on ${r.data.changed} row${r.data.changed === 1 ? "" : "s"}.`);
      onDone();
    });
  return (
    <Dialog open onClose={onClose} title={`Set a column on ${rowKeys.length} row${rowKeys.length === 1 ? "" : "s"}`}>
      <div className="space-y-4">
        <div className="space-y-1.5">
          <Label htmlFor="bulk-col">Column</Label>
          <Select id="bulk-col" value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
            {properties.map((p) => (
              <option key={p.id} value={p.id}>
                {p.name}
              </option>
            ))}
          </Select>
        </div>
        {prop && (
          <div className="relative min-h-10 space-y-1.5">
            <p className="text-sm font-medium text-text">Value</p>
            {prop.kind === "CHECKBOX" ? (
              <div className="flex gap-2">
                <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => apply(true)}>
                  Tick them
                </Button>
                <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => apply(null)}>
                  Untick them
                </Button>
              </div>
            ) : (
              <CellEditor key={prop.id} property={prop} value={null} people={people} onSave={(raw) => apply(raw)} onCancel={() => undefined} />
            )}
            <p className="text-xs text-subtle">Choose, or type and press Enter. It replaces what each ticked row had in this column.</p>
          </div>
        )}
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-between gap-2 border-t border-line pt-4">
          <Button type="button" variant="ghost" disabled={pending || !prop} onClick={() => apply(null)}>
            Empty it on them
          </Button>
          <Button type="button" variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>
    </Dialog>
  );
}

/** The title column of a list with rows of its own, renamed — "Linking page", "Unit". */
function TitleColumnDialog({ workbookId, name: initial, onClose }: { workbookId: string; name: string; onClose: () => void }) {
  const router = useRouter();
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <Dialog open onClose={onClose} title="Rename the title column">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const r = await renameTitleColumn({ workbookId, name });
            if (!r.ok) return setError(r.error);
            onClose();
            router.refresh();
          });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="title-col">Name</Label>
          <Input id="title-col" autoFocus value={name} maxLength={60} onChange={(e) => setName(e.target.value)} />
          <p className="text-xs text-subtle">Every row has one — what each row is: a page, a unit, a candidate.</p>
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || !name.trim()}>
            {pending ? "Saving…" : "Save"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function ViewColumnPicker({ view, properties }: { view: BoardView; properties: BoardProperty[] }) {
  const router = useRouter();
  const wanted = view.kind === "BOARD" ? "SELECT" : "DATE";
  const fits = properties.filter((p) => p.kind === wanted);
  return (
    <div className="flex items-center gap-2 text-sm">
      <Label htmlFor="view-col">{view.kind === "BOARD" ? "Group by" : "Place by"}</Label>
      <Select
        id="view-col"
        className="h-8 w-56"
        defaultValue=""
        onChange={async (e) => {
          const r = await updateListView({ id: view.id, propertyId: e.target.value || null });
          if (!r.ok) return toast.error(r.error);
          router.refresh();
        }}
      >
        <option value="">Choose a column…</option>
        {fits.map((p) => (
          <option key={p.id} value={p.id}>
            {p.name}
          </option>
        ))}
      </Select>
    </div>
  );
}

function AddViewDialog({ workbookId, properties, onClose, onAdded }: { workbookId: string; properties: BoardProperty[]; onClose: () => void; onAdded: (id: string) => void }) {
  const [kind, setKind] = useState<ViewKind>("BOARD");
  const [name, setName] = useState("");
  const [picked, setPropertyId] = useState("");
  const [endId, setEndId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const fits = properties.filter((p) => (kind === "BOARD" ? p.kind === "SELECT" : kind === "CALENDAR" || kind === "TIMELINE" ? p.kind === "DATE" : false));
  // The column picked, while it suits the kind chosen; else the first that does.
  const propertyId = fits.some((p) => p.id === picked) ? picked : (fits[0]?.id ?? "");

  const save = () =>
    start(async () => {
      setError(null);
      const r = await addListView({ workbookId, name, kind, propertyId: kind === "TABLE" ? null : propertyId || null });
      if (!r.ok) return setError(r.error);
      // A timeline's end column (Smart Lists phase 4).
      if (kind === "TIMELINE" && endId) {
        const o = await setTimelineOptions({ viewId: r.data.id, endPropertyId: endId, scale: "week" });
        if (!o.ok) return setError(o.error);
      }
      onAdded(r.data.id);
    });

  return (
    <Dialog open onClose={onClose} title="New view">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <fieldset className="grid grid-cols-3 gap-2 sm:grid-cols-5">
          <legend className="mb-1.5 text-sm font-medium text-text">Lay it out as</legend>
          {(["TABLE", "BOARD", "CALENDAR", "GALLERY", "TIMELINE"] as const).map((k) => {
            const Icon = KIND_ICON[k];
            return (
              <label key={k} className={cn("flex cursor-pointer flex-col items-center gap-1 rounded-base border p-3 text-sm", kind === k ? "border-brand bg-brand-subtle text-brand" : "border-line text-muted hover:border-line-strong")}>
                <input type="radio" name="view-kind" value={k} checked={kind === k} onChange={() => setKind(k)} className="sr-only" />
                <Icon className="h-5 w-5" aria-hidden="true" />
                {k === "TABLE" ? "Table" : k === "BOARD" ? "Board" : k === "CALENDAR" ? "Calendar" : k === "GALLERY" ? "Gallery" : "Timeline"}
              </label>
            );
          })}
        </fieldset>
        {kind !== "TABLE" && kind !== "GALLERY" && (
          <div className="space-y-1.5">
            <Label htmlFor="view-prop">{kind === "BOARD" ? "Group cards by" : kind === "TIMELINE" ? "Starts on" : "Place rows by"}</Label>
            {fits.length ? (
              <Select id="view-prop" value={propertyId} onChange={(e) => setPropertyId(e.target.value)}>
                {fits.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </Select>
            ) : (
              <p className="text-sm text-warning">{kind === "BOARD" ? "Add a Select column first — Outcome, Stage — and the board groups by it." : "Add a Date column first — Visit date, Next step — and the calendar places rows by it."}</p>
            )}
          </div>
        )}
        {kind === "TIMELINE" && fits.length > 1 && (
          <div className="space-y-1.5">
            <Label htmlFor="view-end">Ends on</Label>
            <Select id="view-end" value={endId} onChange={(e) => setEndId(e.target.value)}>
              <option value="">— one day each</option>
              {fits
                .filter((p) => p.id !== propertyId)
                .map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
            </Select>
          </div>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="view-name">Name</Label>
          <Input id="view-name" value={name} maxLength={LIMITS.viewName} placeholder={kind === "BOARD" ? "By outcome" : kind === "CALENDAR" ? "Visits" : "My rows"} onChange={(e) => setName(e.target.value)} />
        </div>
        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}
        <div className="flex justify-end gap-2 border-t border-line pt-4">
          <Button type="button" variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button type="submit" disabled={pending || (kind !== "TABLE" && kind !== "GALLERY" && !propertyId)}>
            {pending ? "Adding…" : "Add view"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function AddCompanyDialog({ workbookId, onClose }: { workbookId: string; onClose: () => void }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [found, setResults] = useState<{ q: string; rows: { id: string; name: string; inList: boolean }[] }>({ q: "", rows: [] });
  const [busy, setBusy] = useState<string | null>(null);
  const typed = query.trim();
  // What was found for what is typed now; anything shorter than two letters shows nothing.
  const results = typed.length >= 2 && found.q === typed ? found.rows : [];
  const searching = typed.length >= 2 && found.q !== typed;

  useEffect(() => {
    if (typed.length < 2) return;
    let live = true;
    const t = window.setTimeout(async () => {
      const rows = await searchCompaniesForList(workbookId, typed);
      if (live) setResults({ q: typed, rows });
    }, 250);
    return () => {
      live = false;
      window.clearTimeout(t);
    };
  }, [typed, workbookId]);

  const add = async (id: string, name: string) => {
    setBusy(id);
    const r = await pinListRow(workbookId, id);
    setBusy(null);
    if (!r.ok) return toast.error(r.error);
    toast.success(`${name} added to the list.`);
    setResults((f) => ({ ...f, rows: f.rows.map((x) => (x.id === id ? { ...x, inList: true } : x)) }));
    router.refresh();
  };

  return (
    <Dialog open onClose={onClose} title="Add a company to this list">
      <div className="space-y-3">
        <Input aria-label="Find a company" autoFocus value={query} placeholder="Type two letters of its name…" onChange={(e) => setQuery(e.target.value)} />
        <ul className="max-h-80 space-y-1 overflow-y-auto" aria-live="polite">
          {results.map((c) => (
            <li key={c.id} className="flex items-center justify-between gap-2 rounded-base px-2 py-1.5 hover:bg-surface-sunken">
              <span className="truncate text-sm text-text">{c.name}</span>
              {c.inList ? (
                <span className="shrink-0 text-xs font-medium text-success">In the list</span>
              ) : (
                <Button size="sm" variant="secondary" disabled={busy === c.id} onClick={() => add(c.id, c.name)}>
                  {busy === c.id ? "Adding…" : "Add"}
                </Button>
              )}
            </li>
          ))}
          {query.trim().length >= 2 && !searching && results.length === 0 && <li className="px-2 py-3 text-sm text-subtle">No company you can see goes by that name.</li>}
        </ul>
        <p className="text-xs text-subtle">Companies added by hand stay in the list whatever its filters say, and carry a pin.</p>
      </div>
    </Dialog>
  );
}
