"use client";

import { useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowDown, ArrowUp, Filter, Plus, Save, Trash2, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import type { BoardProperty } from "@/actions/smart-list-board";
import { addListView } from "@/actions/smart-list-board";
import { saveViewQuery } from "@/actions/smart-list-links";
import { OptionChip } from "@/components/smart-lists/cells";
import {
  BARE_OPS,
  EMPTY_QUERY,
  FIELD_CREATED,
  GROUP_KINDS,
  FIELD_TITLE,
  FIELD_UPDATED,
  ME,
  OP_LABELS,
  RANGES,
  RELATIVE_DAYS,
  cleanQuery,
  describeRule,
  encodeQuery,
  fieldKind,
  fieldName,
  isEmptyQuery,
  opsFor,
  type FieldKind,
  type Op,
  type Rule,
  type ViewQuery,
} from "@/lib/smart-lists/view-query";

/**
 * A view's filters and sort (owner, 20 Nov 2026 — Smart Lists phase 2): the rules in force as chips above the rows, a
 * dialog to change them, and — for whoever may edit the list — saving them to the view for everyone. Changes go in the
 * address bar first (`fq`), so anybody can try a filter, share the link, or go back; nothing is saved until "Save for
 * everyone". The server reads the same rules (src/lib/smart-lists/view-query.ts).
 */

export const QUERY_PARAM = "fq";

export function FilterBar({
  workbookId,
  viewId,
  properties,
  own,
  titleName,
  saved,
  current,
  canEdit,
  people,
}: {
  workbookId: string;
  /** The saved view on screen; null — the plain table, whose filters can be saved as a new view. */
  viewId: string | null;
  properties: BoardProperty[];
  own: boolean;
  titleName: string;
  saved: ViewQuery;
  current: ViewQuery;
  canEdit: boolean;
  people: { id: string; name: string }[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const search = useSearchParams();
  const [editing, setEditing] = useState(false);
  const [naming, setNaming] = useState(false);
  const [pending, start] = useTransition();
  const names = new Map(people.map((p) => [p.id, p.name]));
  const draft = search.has(QUERY_PARAM);
  const differs = draft && encodeQuery(current) !== encodeQuery(saved);

  const go = (q: ViewQuery | null) => {
    const p = new URLSearchParams(search.toString());
    if (q === null) p.delete(QUERY_PARAM);
    else p.set(QUERY_PARAM, encodeQuery(q) || "{}");
    p.delete("page");
    const s = p.toString();
    router.push(`${pathname}${s ? `?${s}` : ""}`);
  };

  const saveForEveryone = () =>
    start(async () => {
      if (!viewId) return setNaming(true);
      const r = await saveViewQuery({ viewId, query: current });
      if (!r.ok) return void toast.error(r.error);
      toast.success("Saved — everyone sees this view this way now.");
      go(null);
      router.refresh();
    });

  const removeRule = (i: number) => go({ ...current, rules: current.rules.filter((_, j) => j !== i) });
  const removeSort = (i: number) => go({ ...current, sort: current.sort.filter((_, j) => j !== i) });

  return (
    <div className="flex flex-wrap items-center gap-1.5 text-xs">
      {current.rules.map((r, i) => (
        <span key={`r${i}`} className="inline-flex max-w-full items-center gap-1 rounded-full border border-brand/30 bg-brand-subtle py-0.5 pl-2.5 pr-1 text-brand">
          <button type="button" className="truncate" onClick={() => setEditing(true)} title="Change the filters">
            {i > 0 && <span className="mr-1 text-brand/70">{current.match === "any" ? "or" : "and"}</span>}
            {describeRule(r, properties, titleName, names)}
          </button>
          <button type="button" aria-label="Remove this filter" className="rounded-full p-0.5 hover:bg-brand/10" onClick={() => removeRule(i)}>
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {current.sort.map((s, i) => (
        <span key={`s${i}`} className="inline-flex items-center gap-1 rounded-full border border-line bg-surface py-0.5 pl-2.5 pr-1 text-muted">
          <button type="button" className="inline-flex items-center gap-1" onClick={() => setEditing(true)} title="Change the order">
            {s.dir === "asc" ? <ArrowUp className="h-3 w-3" aria-hidden="true" /> : <ArrowDown className="h-3 w-3" aria-hidden="true" />}
            {fieldName(s.field, properties, titleName)}
          </button>
          <button type="button" aria-label="Remove this sort" className="rounded-full p-0.5 hover:bg-surface-sunken" onClick={() => removeSort(i)}>
            <X className="h-3 w-3" />
          </button>
        </span>
      ))}
      {current.group && (
        <span className="inline-flex items-center gap-1 rounded-full border border-line bg-surface py-0.5 pl-2.5 pr-1 text-muted">
          <button type="button" onClick={() => setEditing(true)} title="Change the grouping">
            Grouped by {fieldName(current.group, properties, titleName)}
          </button>
          <button type="button" aria-label="Stop grouping" className="rounded-full p-0.5 hover:bg-surface-sunken" onClick={() => go({ ...current, group: null })}>
            <X className="h-3 w-3" />
          </button>
        </span>
      )}
      <button type="button" onClick={() => setEditing(true)} className="inline-flex items-center gap-1 rounded-full px-2 py-1 text-muted hover:bg-surface-sunken hover:text-text">
        <Filter className="h-3.5 w-3.5" aria-hidden="true" />
        {isEmptyQuery(current) ? "Filter or sort" : "Change"}
      </button>
      {draft && (
        <>
          {canEdit && differs && (
            <Button size="sm" variant="secondary" disabled={pending} onClick={saveForEveryone}>
              <Save className="h-3.5 w-3.5" />
              {viewId ? "Save for everyone" : "Save as a view"}
            </Button>
          )}
          <button type="button" className="rounded-full px-2 py-1 text-subtle hover:text-text" onClick={() => go(null)}>
            {isEmptyQuery(saved) ? "Clear" : "Back to the saved view"}
          </button>
        </>
      )}
      {editing && (
        <QueryDialog
          properties={properties} own={own} titleName={titleName} people={people} query={current} onClose={() => setEditing(false)}
          onApply={(q) => {
            setEditing(false);
            go(q);
          }}
        />
      )}
      {naming && <NameViewDialog workbookId={workbookId} query={current} onClose={() => setNaming(false)} />}
    </div>
  );
}

function NameViewDialog({ workbookId, query, onClose }: { workbookId: string; query: ViewQuery; onClose: () => void }) {
  const router = useRouter();
  const pathname = usePathname();
  const [name, setName] = useState("");
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <Dialog open onClose={onClose} title="Save as a view">
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          start(async () => {
            const made = await addListView({ workbookId, name, kind: "TABLE" });
            if (!made.ok) return setError(made.error);
            const saved = await saveViewQuery({ viewId: made.data.id, query });
            if (!saved.ok) return setError(saved.error);
            onClose();
            router.push(`${pathname}?view=${made.data.id}`);
            router.refresh();
          });
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="view-name-q">Name</Label>
          <Input id="view-name-q" autoFocus value={name} maxLength={40} placeholder="Live links, newest first" onChange={(e) => setName(e.target.value)} />
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
            {pending ? "Saving…" : "Save view"}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

type Field = { id: string; name: string; kind: FieldKind };

function QueryDialog({
  properties,
  own,
  titleName,
  people,
  query,
  onClose,
  onApply,
}: {
  properties: BoardProperty[];
  own: boolean;
  titleName: string;
  people: { id: string; name: string }[];
  query: ViewQuery;
  onClose: () => void;
  onApply: (q: ViewQuery) => void;
}) {
  const fields: Field[] = [
    { id: FIELD_TITLE, name: titleName, kind: "TITLE" },
    ...properties.filter((p) => p.kind !== "ROLLUP").map((p) => ({ id: p.id, name: p.name, kind: p.kind as FieldKind })),
    ...(own ? [{ id: FIELD_CREATED, name: "Added", kind: "STAMP" as const }, { id: FIELD_UPDATED, name: "Last changed", kind: "STAMP" as const }] : []),
  ];
  const sortable = fields.filter((f) => !["MULTI_SELECT", "COMPANY", "LEAD", "CONTACT", "ROW", "FILE"].includes(f.kind));
  const [match, setMatch] = useState(query.match);
  const [rules, setRules] = useState<Rule[]>(query.rules);
  const [sort, setSort] = useState(query.sort);
  const [group, setGroup] = useState(query.group ?? "");
  const groupable = properties.filter((p) => GROUP_KINDS.includes(p.kind));
  const setRule = (i: number, patch: Partial<Rule>) => setRules((all) => all.map((r, j) => (j === i ? { ...r, ...patch } : r)));
  const fresh = (field: string): Rule => {
    const kind = fieldKind(field, properties, own) ?? "TEXT";
    const op = opsFor(kind)[0]!;
    return { field, op, value: defaultValue(kind, op) };
  };

  return (
    <Dialog open onClose={onClose} title="Filter and sort" wide>
      <form
        className="space-y-5"
        onSubmit={(e) => {
          e.preventDefault();
          onApply(cleanQuery({ match, rules, sort, group: group || null }, properties, own));
        }}
      >
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-text">Show rows where</h3>
            {rules.length > 1 && (
              <Select aria-label="Match" className="h-8 w-56" value={match} onChange={(e) => setMatch(e.target.value === "any" ? "any" : "all")}>
                <option value="all">all of these are true</option>
                <option value="any">any of these is true</option>
              </Select>
            )}
          </div>
          {rules.length === 0 && <p className="text-sm text-subtle">Every row, for now.</p>}
          <ul className="space-y-2">
            {rules.map((r, i) => {
              const kind = fieldKind(r.field, properties, own) ?? "TEXT";
              const prop = properties.find((p) => p.id === r.field) ?? null;
              return (
                <li key={i} className="flex flex-wrap items-start gap-1.5 rounded-base border border-line p-2">
                  <Select aria-label="Column" className="h-8 w-44" value={r.field} onChange={(e) => setRule(i, fresh(e.target.value))}>
                    {fields.map((f) => (
                      <option key={f.id} value={f.id}>
                        {f.name}
                      </option>
                    ))}
                  </Select>
                  <Select aria-label="How" className="h-8 w-40" value={r.op} onChange={(e) => setRule(i, { op: e.target.value as Op, value: defaultValue(kind, e.target.value as Op, r.value) })}>
                    {opsFor(kind).map((op) => (
                      <option key={op} value={op}>
                        {OP_LABELS[op]}
                      </option>
                    ))}
                  </Select>
                  <div className="min-w-48 flex-1">
                    <ValueInput kind={kind} op={r.op} prop={prop} people={people} value={r.value} onChange={(value) => setRule(i, { value })} />
                  </div>
                  <button type="button" aria-label="Remove this filter" className="rounded-base p-1.5 text-subtle hover:text-danger" onClick={() => setRules((all) => all.filter((_, j) => j !== i))}>
                    <Trash2 className="h-4 w-4" />
                  </button>
                </li>
              );
            })}
          </ul>
          {rules.length < 20 && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setRules((all) => [...all, fresh(properties.find((p) => p.kind === "SELECT")?.id ?? FIELD_TITLE)])}>
              <Plus className="h-3.5 w-3.5" />
              Add a filter
            </Button>
          )}
        </section>

        <section className="space-y-2 border-t border-line pt-4">
          <h3 className="text-sm font-semibold text-text">Sort by</h3>
          {sort.length === 0 && <p className="text-sm text-subtle">The order rows were added in.</p>}
          <ul className="space-y-2">
            {sort.map((s, i) => (
              <li key={i} className="flex items-center gap-1.5">
                <Select aria-label="Sort column" className="h-8 w-56" value={s.field} onChange={(e) => setSort((all) => all.map((x, j) => (j === i ? { ...x, field: e.target.value } : x)))}>
                  {sortable.map((f) => (
                    <option key={f.id} value={f.id}>
                      {f.name}
                    </option>
                  ))}
                </Select>
                <Select aria-label="Direction" className="h-8 w-40" value={s.dir} onChange={(e) => setSort((all) => all.map((x, j) => (j === i ? { ...x, dir: e.target.value === "desc" ? "desc" : "asc" } : x)))}>
                  <option value="asc">A → Z, low → high, old → new</option>
                  <option value="desc">Z → A, high → low, new → old</option>
                </Select>
                <button type="button" aria-label="Remove this sort" className="rounded-base p-1.5 text-subtle hover:text-danger" onClick={() => setSort((all) => all.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </button>
              </li>
            ))}
          </ul>
          {sort.length < 3 && (
            <Button type="button" variant="ghost" size="sm" onClick={() => setSort((all) => [...all, { field: sortable.find((f) => !all.some((x) => x.field === f.id))?.id ?? FIELD_TITLE, dir: "asc" }])}>
              <Plus className="h-3.5 w-3.5" />
              Add a sort
            </Button>
          )}
        </section>

        {groupable.length > 0 && (
          <section className="space-y-2 border-t border-line pt-4">
            <h3 className="text-sm font-semibold text-text">Group the table by</h3>
            <Select aria-label="Group by" className="h-8 w-56" value={group} onChange={(e) => setGroup(e.target.value)}>
              <option value="">No grouping</option>
              {groupable.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </section>
        )}

        <div className="flex justify-between gap-2 border-t border-line pt-4">
          <Button type="button" variant="ghost" onClick={() => onApply(EMPTY_QUERY)}>
            Clear all
          </Button>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit">Apply</Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}

function defaultValue(kind: FieldKind, op: Op, was?: unknown): unknown {
  if (BARE_OPS.includes(op)) return undefined;
  if (kind === "DATE" || kind === "STAMP") return op === "within" ? "next_7" : typeof was === "string" && !(was in RANGES) ? was : "today";
  if (kind === "SELECT" || kind === "MULTI_SELECT" || kind === "PERSON") return Array.isArray(was) ? was : [];
  return typeof was === "string" || typeof was === "number" ? was : "";
}

function ValueInput({ kind, op, prop, people, value, onChange }: { kind: FieldKind; op: Op; prop: BoardProperty | null; people: { id: string; name: string }[]; value: unknown; onChange: (v: unknown) => void }) {
  if (BARE_OPS.includes(op)) return null;
  if (kind === "DATE" || kind === "STAMP") {
    if (op === "within")
      return (
        <Select aria-label="When" className="h-8" value={String(value ?? "next_7")} onChange={(e) => onChange(e.target.value)}>
          {Object.entries(RANGES).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
        </Select>
      );
    const relative = typeof value === "string" && value in RELATIVE_DAYS;
    return (
      <div className="flex gap-1.5">
        <Select aria-label="Which day" className="h-8 w-36" value={relative ? String(value) : "date"} onChange={(e) => onChange(e.target.value === "date" ? "" : e.target.value)}>
          {Object.entries(RELATIVE_DAYS).map(([k, label]) => (
            <option key={k} value={k}>
              {label}
            </option>
          ))}
          <option value="date">A date…</option>
        </Select>
        {!relative && <Input type="date" aria-label="Date" className="h-8" value={String(value ?? "")} onChange={(e) => onChange(e.target.value)} />}
      </div>
    );
  }
  if (kind === "SELECT" || kind === "MULTI_SELECT" || kind === "PERSON") {
    const chosen = new Set(Array.isArray(value) ? value.map(String) : []);
    const toggle = (id: string) => {
      const next = new Set(chosen);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      onChange([...next]);
    };
    const choices = kind === "PERSON" ? [{ id: ME, name: "Me" }, ...people] : (prop?.options ?? []).map((o) => ({ id: o.id, name: o.name }));
    return (
      <div className="flex max-h-40 flex-wrap gap-1 overflow-y-auto">
        {choices.map((c) => {
          const option = prop?.options.find((o) => o.id === c.id);
          return (
            <label key={c.id} className={cn("inline-flex cursor-pointer items-center gap-1 rounded border px-1.5 py-0.5 text-xs", chosen.has(c.id) ? "border-brand" : "border-line")}>
              <input type="checkbox" className="h-3 w-3" checked={chosen.has(c.id)} onChange={() => toggle(c.id)} />
              {option ? <OptionChip option={option} /> : c.name}
            </label>
          );
        })}
        {choices.length === 0 && <span className="text-xs text-subtle">This column has no choices yet.</span>}
      </div>
    );
  }
  const numeric = kind === "NUMBER" || kind === "MONEY" || kind === "RATING";
  return <Input aria-label="Value" className="h-8" type={numeric ? "number" : "text"} step="any" value={String(value ?? "")} placeholder={numeric ? "0" : "Words…"} onChange={(e) => onChange(e.target.value)} />;
}
