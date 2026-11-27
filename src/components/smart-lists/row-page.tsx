"use client";

import { useEffect, useRef, useState } from "react";
import { CompanyLink } from "@/components/companies/company-link";
import { Plus, X } from "lucide-react";
import { SidePane } from "@/components/ui/side-pane";
import { Input, Textarea } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { getRowPage, saveRowPage, type BoardProperty } from "@/actions/smart-list-board";
import { getOwnRowPage, saveOwnRowPage } from "@/actions/smart-list-rows";
import { LIMITS, shortId, type ChecklistItem } from "@/lib/smart-lists/values";
import { CellEditor, CellValue } from "@/components/smart-lists/cells";
import type { BoardRow } from "@/components/smart-lists/smart-list-board";
import { RowComments } from "@/components/connect/row-comments";
import { RowActivityPanel } from "@/components/smart-lists/row-activity";
import { OwnRowTools } from "@/components/smart-lists/row-tools";

/**
 * A company's page inside one Smart List (owner, 20 Nov 2026 — src/lib/smart-lists): the list's columns for it, edited
 * as in the table, then notes and a checklist about this company for this list's work. Notes save a moment after
 * typing stops; the checklist on each change.
 */
export function RowPage({
  workbookId,
  row,
  properties,
  values,
  people,
  onClose,
  onSetValue,
  own = null,
  canEdit = false,
}: {
  /** Whether this person may edit the list — and so delete anybody's comment on it. */
  canEdit?: boolean;
  /**
   * A row of the list's own, not a company (src/lib/smart-lists/own-rows.ts): its title can be changed here, and it has no
   * company page or guest comments. `canFill` and `today`: to copy it, or make it repeat (Smart Lists phase 4).
   */
  own?: { titleName: string; onRename: (title: string) => void; canFill?: boolean; today?: string } | null;
  workbookId: string;
  row: BoardRow;
  properties: BoardProperty[];
  values: Record<string, unknown>;
  people: { id: string; name: string }[];
  onClose: () => void;
  onSetValue: (companyId: string, property: BoardProperty, raw: unknown) => void;
}) {
  const names = new Map(people.map((p) => [p.id, p.name]));
  const [loaded, setLoaded] = useState(false);
  const [notes, setNotes] = useState("");
  const [checklist, setChecklist] = useState<ChecklistItem[]>([]);
  const [newItem, setNewItem] = useState("");
  const [editing, setEditing] = useState<string | null>(null);
  const [saving, setSaving] = useState<"idle" | "saving" | "saved">("idle");
  const [who, setWho] = useState<{ createdBy: string | null; createdAt: string; updatedBy: string | null } | null>(null);
  const [title, setTitle] = useState(row.name);
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => {
    let live = true;
    const load = own ? getOwnRowPage(row.id) : getRowPage(workbookId, row.id);
    void load.then((page) => {
      if (!live) return;
      setNotes(page?.notes ?? "");
      setChecklist(page?.checklist ?? []);
      // An own row's page says who added and changed it (src/actions/smart-list-rows.ts); a company's doesn't.
      const by = page as { createdBy?: string | null; createdAt?: string; updatedBy?: string | null } | null;
      if (by?.createdAt) setWho({ createdBy: by.createdBy ?? null, createdAt: by.createdAt, updatedBy: by.updatedBy ?? null });
      setLoaded(true);
    });
    return () => {
      live = false;
      window.clearTimeout(timer.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `own` is fixed for the list; the page loads once a row
  }, [workbookId, row.id]);

  const persist = async (patch: { notes?: string; checklist?: ChecklistItem[] }) => {
    setSaving("saving");
    const r = own ? await saveOwnRowPage({ rowId: row.id, ...patch }) : await saveRowPage({ workbookId, companyId: row.id, ...patch });
    if (!r.ok) {
      setSaving("idle");
      return toast.error(r.error);
    }
    setSaving("saved");
  };

  const typeNotes = (next: string) => {
    setNotes(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => void persist({ notes: next }), 700);
  };

  const changeChecklist = (next: ChecklistItem[]) => {
    setChecklist(next);
    void persist({ checklist: next });
  };

  const addItem = () => {
    const text = newItem.trim().slice(0, LIMITS.checklistText);
    if (!text) return;
    changeChecklist([...checklist, { id: shortId(checklist.map((c) => c.id)), text, done: false }]);
    setNewItem("");
  };

  return (
    <SidePane open onClose={onClose} title={row.name}>
      <div className="space-y-5">
        {own ? (
          <div className="space-y-1">
            <label htmlFor="own-row-title" className="text-xs text-muted">
              {own.titleName}
            </label>
            <Input
              id="own-row-title"
              value={title}
              maxLength={300}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => {
                const next = title.trim();
                if (next && next !== row.name) own.onRename(next);
                else setTitle(row.name);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") (e.target as HTMLInputElement).blur();
              }}
            />
            {who && (
              <p className="text-xs text-subtle">
                Added {who.createdBy ? `by ${who.createdBy} ` : ""}on {new Date(who.createdAt).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" })}
                {who.updatedBy ? ` · last changed by ${who.updatedBy}` : ""}
              </p>
            )}
            {own.today && <OwnRowTools workbookId={workbookId} rowId={row.id} rowTitle={row.name} canFill={own.canFill !== false} canEdit={canEdit} today={own.today} onCopied={() => undefined} />}
          </div>
        ) : (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
            {row.place && <span>{row.place}</span>}
            {row.ownerName && <span>Owner {row.ownerName}</span>}
            <CompanyLink hideWhenShut href={row.href} className="font-medium text-brand hover:underline">
              Open the company
            </CompanyLink>
          </div>
        )}

        {properties.length > 0 && (
          <dl className="space-y-1">
            {properties.map((p) => (
              <div key={p.id} className="grid grid-cols-[8.5rem_1fr] items-center gap-2 text-sm">
                <dt className="truncate text-muted">{p.name}</dt>
                <dd className="min-h-8 min-w-0">
                  {editing === p.id ? (
                    <CellEditor
                      property={p}
                      value={values[p.id] ?? null}
                      people={people}
                      rowKey={row.id}
                      onCancel={() => setEditing(null)}
                      onSave={(raw) => {
                        setEditing(null);
                        onSetValue(row.id, p, raw);
                      }}
                    />
                  ) : (
                    <button
                      type="button"
                      className="flex min-h-8 w-full items-center rounded-base px-1.5 text-left hover:bg-surface-sunken"
                      disabled={p.kind === "ROLLUP"}
                      onClick={() => (p.kind === "CHECKBOX" ? onSetValue(row.id, p, values[p.id] !== true) : setEditing(p.id))}
                      aria-label={`${p.name}: change`}
                    >
                      <CellValue property={p} value={values[p.id] ?? null} people={names} />
                    </button>
                  )}
                </dd>
              </div>
            ))}
          </dl>
        )}

        <section className="space-y-2 border-t border-line pt-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold text-text">Notes</h3>
            <span className="text-xs text-subtle" aria-live="polite">
              {saving === "saving" ? "Saving…" : saving === "saved" ? "Saved" : ""}
            </span>
          </div>
          <Textarea
            aria-label="Notes"
            rows={7}
            value={notes}
            disabled={!loaded}
            maxLength={LIMITS.notes}
            placeholder={loaded ? (own ? "Anything worth keeping about this row — context, links, what's next." : "What you know about them for this list — who decides, what they use, what's next.") : "Loading…"}
            onChange={(e) => typeNotes(e.target.value)}
          />
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-semibold text-text">Checklist</h3>
          <ul className="space-y-1">
            {checklist.map((item) => (
              <li key={item.id} className="group flex items-start gap-2 text-sm">
                <input
                  type="checkbox"
                  className="mt-1"
                  checked={item.done}
                  aria-label={item.text}
                  onChange={(e) => changeChecklist(checklist.map((c) => (c.id === item.id ? { ...c, done: e.target.checked } : c)))}
                />
                <span className={item.done ? "flex-1 text-subtle line-through" : "flex-1 text-text"}>{item.text}</span>
                <button
                  type="button"
                  aria-label={`Remove ${item.text}`}
                  className="rounded p-0.5 text-subtle opacity-0 hover:text-danger focus:opacity-100 group-hover:opacity-100"
                  onClick={() => changeChecklist(checklist.filter((c) => c.id !== item.id))}
                >
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
          {checklist.length < LIMITS.checklist && (
            <div className="flex items-center gap-2">
              <Plus className="h-3.5 w-3.5 text-subtle" aria-hidden="true" />
              <Input
                aria-label="Add a checklist item"
                value={newItem}
                disabled={!loaded}
                maxLength={LIMITS.checklistText}
                placeholder="Add an item and press Enter"
                className="h-8"
                onChange={(e) => setNewItem(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addItem();
                  }
                }}
                onBlur={addItem}
              />
            </div>
          )}
        </section>

        {/* Comments — internal, or shared with the list's guests (Deskzo Connect phase 3). */}
        {!own && <RowComments workbookId={workbookId} companyId={row.id} />}
        {/* Comments on a list of its own, and every row's history (Smart Lists phase 3). */}
        <RowActivityPanel workbookId={workbookId} rowKey={row.id} own={!!own} canEdit={canEdit} />
      </div>
    </SidePane>
  );
}
