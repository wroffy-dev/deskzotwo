"use client";

import { useEffect, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowLeft, ArrowRight, Plus, Trash2, X } from "lucide-react";
import { Dialog } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { confirmAction } from "@/components/ui/confirm";
import { toast } from "@/components/ui/toast";
import { addListProperty, deleteListProperty, moveListProperty, updateListProperty, type BoardProperty } from "@/actions/smart-list-board";
import { KIND_LABELS, LIMITS, OPTION_COLORS, PROPERTY_KINDS, shortId, type OptionColor, type PropertyKind, type SelectOption } from "@/lib/smart-lists/values";
import { OptionChip } from "@/components/smart-lists/cells";
import { columnReminder, countSources, linkableLists, setColumnReminder, type ColumnReminder } from "@/actions/smart-list-links";
import { NOTIFY_LABELS, type NotifyWho } from "@/lib/smart-lists/reminder-words";
import { FORMAT_LABELS, FORMULA_FORMATS, compileFormula, type FormulaFormat } from "@/lib/smart-lists/formulas";

/**
 * Adding a Smart List column, or changing one (owner, 20 Nov 2026 — src/lib/smart-lists): its name, its kind (fixed once
 * made — a different kind is a new column), a select's choices, moving it left or right, and deleting it with its values.
 */
export function ColumnDialog({
  workbookId,
  property,
  open,
  onClose,
  isFirst,
  isLast,
  guests = true,
  own = false,
  listProperties = [],
}: {
  /** A list of its own rows (src/lib/smart-lists/own-rows.ts) — whose reminders can go to whoever added a row. */
  own?: boolean;
  /** The list's columns — a reminder can go to a Person column's person. */
  listProperties?: BoardProperty[];
  workbookId: string;
  /** The column to change; none — a new one. */
  property: BoardProperty | null;
  open: boolean;
  onClose: () => void;
  isFirst?: boolean;
  isLast?: boolean;
  /** Whether the list can be shared with guests, so the column's guest switches apply — not a list of its own rows. */
  guests?: boolean;
}) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [name, setName] = useState(property?.name ?? "");
  const [kind, setKind] = useState<PropertyKind>(property?.kind ?? "TEXT");
  const [options, setOptions] = useState<SelectOption[]>(property?.options ?? []);
  const [newOption, setNewOption] = useState("");
  const [guestVisible, setGuestVisible] = useState(property?.guestVisible ?? false);
  const [guestEditable, setGuestEditable] = useState(property?.guestEditable ?? false);
  const [error, setError] = useState<string | null>(null);
  const hasChoices = kind === "SELECT" || kind === "MULTI_SELECT";
  // A "Row of another list" column's list (Smart Lists phase 2).
  const [lists, setLists] = useState<{ id: string; name: string }[] | null>(null);
  const [listId, setListId] = useState("");
  useEffect(() => {
    if (kind !== "ROW" || property || lists) return;
    let live = true;
    void linkableLists().then((l) => live && setLists(l));
    return () => {
      live = false;
    };
  }, [kind, property, lists]);
  // A formula (Smart Lists phase 4): its expression and what it works out, checked as it's typed.
  const [expr, setExpr] = useState(property?.formula?.expr ?? "");
  const [format, setFormat] = useState<FormulaFormat>((property?.formula?.format as FormulaFormat) ?? "number");
  const formulaCheck = kind === "FORMULA" && expr.trim() ? compileFormula(expr, listProperties.map((p) => ({ id: p.id, name: p.name })), property?.id) : null;
  // A count column's set-up (Smart Lists phase 3): the lists whose rows link here, and what to count there.
  const [sources, setSources] = useState<Awaited<ReturnType<typeof countSources>> | null>(null);
  const [rollup, setRollup] = useState<{ list: string; via: string; mode: "count" | "where" | "sum"; whereProp: string; whereOpt: string; field: string }>({ list: "", via: "", mode: "count", whereProp: "", whereOpt: "", field: "" });
  useEffect(() => {
    if (kind !== "ROLLUP" || property || sources) return;
    let live = true;
    void countSources(workbookId).then((s) => live && setSources(s));
    return () => {
      live = false;
    };
  }, [kind, property, sources, workbookId]);
  const source = sources?.find((s) => s.listId === rollup.list) ?? null;
  const rollupOptions = () => ({
    list: rollup.list,
    via: rollup.via || source?.via[0]?.id || "",
    fn: rollup.mode === "sum" ? "sum" : "count",
    field: rollup.mode === "sum" ? rollup.field || source?.numbers[0]?.id || null : null,
    where: rollup.mode === "where" ? { propertyId: rollup.whereProp || source?.selects[0]?.id || "", optionId: rollup.whereOpt || (source?.selects.find((x) => x.id === (rollup.whereProp || source?.selects[0]?.id))?.options[0]?.id ?? "") } : null,
  });
  // A Date column's reminder (Smart Lists phase 2): loaded when the column is opened.
  const personColumns = listProperties.filter((p) => p.kind === "PERSON");
  const [reminder, setReminder] = useState<ColumnReminder | undefined>(undefined);
  useEffect(() => {
    if (property?.kind !== "DATE") return;
    let live = true;
    void columnReminder(property.id).then((r) => live && setReminder(r));
    return () => {
      live = false;
    };
  }, [property]);
  const whoChoices = (Object.keys(NOTIFY_LABELS) as NotifyWho[]).filter((w) => (w === "ADDER" ? own : w === "ACCOUNT_OWNER" ? !own : w === "PERSON" ? personColumns.length > 0 : true));

  const addOption = () => {
    const n = newOption.replace(/\s+/g, " ").trim().slice(0, LIMITS.optionName);
    if (!n || options.some((o) => o.name.toLowerCase() === n.toLowerCase())) return setNewOption("");
    setOptions([...options, { id: shortId(options.map((o) => o.id)), name: n, color: OPTION_COLORS[options.length % OPTION_COLORS.length]! }]);
    setNewOption("");
  };

  const save = () =>
    start(async () => {
      setError(null);
      const r = property
        ? await updateListProperty({ id: property.id, name, ...(hasChoices ? { options } : {}), ...(property.kind === "FORMULA" ? { formula: { expr, format } } : {}), guestVisible, guestEditable })
        : await addListProperty({ workbookId, name, kind, options: hasChoices ? options : kind === "ROW" ? { listId } : kind === "ROLLUP" ? rollupOptions() : kind === "FORMULA" ? { expr, format } : undefined });
      if (!r.ok) return setError(r.error);
      if (property?.kind === "DATE" && reminder !== undefined) {
        const saved = await setColumnReminder({ propertyId: property.id, reminder });
        if (!saved.ok) return setError(saved.error);
      }
      toast.success(property ? "Column saved." : `Column "${name.trim()}" added.`);
      onClose();
      router.refresh();
    });

  const move = (direction: "left" | "right") =>
    start(async () => {
      if (!property) return;
      const r = await moveListProperty(property.id, direction);
      if (!r.ok) return setError(r.error);
      router.refresh();
    });

  const remove = () =>
    start(async () => {
      if (!property) return;
      const sure = await confirmAction({ title: `Delete "${property.name}"?`, message: "The column goes, with what everyone wrote in it. This can't be undone.", confirmLabel: "Delete column", danger: true });
      if (!sure) return;
      const r = await deleteListProperty(property.id);
      if (!r.ok) return setError(r.error);
      toast.success("Column deleted.");
      onClose();
      router.refresh();
    });

  return (
    <Dialog open={open} onClose={onClose} title={property ? `Column · ${property.name}` : "New column"}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          save();
        }}
      >
        <div className="space-y-1.5">
          <Label htmlFor="col-name">Name</Label>
          <Input id="col-name" value={name} maxLength={LIMITS.propertyName} onChange={(e) => setName(e.target.value)} placeholder="Products pitched, Visit date, Seats…" autoFocus />
        </div>
        <div className="space-y-1.5">
          <Label htmlFor="col-kind">Kind</Label>
          <Select id="col-kind" value={kind} disabled={!!property} onChange={(e) => setKind(e.target.value as PropertyKind)}>
            {PROPERTY_KINDS.map((k) => (
              <option key={k} value={k}>
                {KIND_LABELS[k]}
              </option>
            ))}
          </Select>
          {property && <p className="text-xs text-subtle">A column keeps its kind. For a different kind, add a new column.</p>}
        </div>

        {kind === "ROW" && !property && (
          <div className="space-y-1.5">
            <Label htmlFor="col-target">Links to rows of</Label>
            <Select id="col-target" value={listId} onChange={(e) => setListId(e.target.value)}>
              <option value="">Choose a list…</option>
              {(lists ?? []).map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </Select>
            {lists && lists.length === 0 && <p className="text-xs text-warning">No list with rows of its own yet — make one from a template first.</p>}
          </div>
        )}
        {(kind === "COMPANY" || kind === "LEAD" || kind === "CONTACT") && !property && (
          <p className="text-xs text-subtle">Each person sees — and can link — only the {kind === "COMPANY" ? "companies" : kind === "LEAD" ? "leads" : "contacts"} that are theirs to see.</p>
        )}
        {kind === "FILE" && !property && <p className="text-xs text-subtle">PDFs and images, up to 5 MB each and {LIMITS.files} to a row.</p>}

        {kind === "FORMULA" && (
          <div className="space-y-2 rounded-base border border-line p-3">
            <Label htmlFor="col-formula">Formula</Label>
            <textarea
              id="col-formula"
              rows={2}
              maxLength={500}
              value={expr}
              placeholder="{Qty} * {Rate}   ·   days_until({Expires on})   ·   if({Status} = 'Live', {Cost}, 0)"
              className="w-full rounded-base border border-line-strong bg-surface px-2 py-1.5 font-mono text-sm text-text outline-none focus:border-brand"
              onChange={(e) => setExpr(e.target.value)}
            />
            <div className="flex flex-wrap gap-1">
              {listProperties
                .filter((p) => p.id !== property?.id)
                .map((p) => (
                  <button key={p.id} type="button" className="rounded bg-surface-sunken px-1.5 py-0.5 text-xs text-muted hover:text-text" onClick={() => setExpr((e) => `${e}{${p.name}}`)}>
                    {p.name}
                  </button>
                ))}
            </div>
            {formulaCheck && !formulaCheck.ok && (
              <p role="alert" className="text-xs text-danger">
                {formulaCheck.error}
              </p>
            )}
            <div className="flex items-center gap-2 text-sm">
              <Label htmlFor="col-format">It works out</Label>
              <Select id="col-format" className="h-8 w-56" value={format} onChange={(e) => setFormat(e.target.value as FormulaFormat)}>
                {FORMULA_FORMATS.map((f) => (
                  <option key={f} value={f}>
                    {FORMAT_LABELS[f]}
                  </option>
                ))}
              </Select>
            </div>
            <p className="text-xs text-subtle">
              Columns go in {"{ }"}. Words: today, days_until, days_since, days_between, add_days, if, and, or, not, round, min, max, sum, abs, concat, upper, lower, len, empty. Worked out by Deskzo for every row — never typed in.
            </p>
          </div>
        )}

        {kind === "ROLLUP" && !property && (
          <div className="space-y-2 rounded-base border border-line p-3">
            {sources && sources.length === 0 ? (
              <p className="text-xs text-warning">No list links here yet. Add a &ldquo;Row of another list&rdquo; column to another list that points at this one{own ? "" : " — or a Company column, for a list of companies"} — then count through it.</p>
            ) : (
              <>
                <div className="space-y-1.5">
                  <Label htmlFor="roll-list">Count the rows of</Label>
                  <Select id="roll-list" value={rollup.list} onChange={(e) => setRollup({ ...rollup, list: e.target.value, via: "", whereProp: "", whereOpt: "", field: "" })}>
                    <option value="">Choose a list…</option>
                    {(sources ?? []).map((s) => (
                      <option key={s.listId} value={s.listId}>
                        {s.listName}
                      </option>
                    ))}
                  </Select>
                </div>
                {source && source.via.length > 1 && (
                  <div className="space-y-1.5">
                    <Label htmlFor="roll-via">That link here through</Label>
                    <Select id="roll-via" value={rollup.via || source.via[0]!.id} onChange={(e) => setRollup({ ...rollup, via: e.target.value })}>
                      {source.via.map((v) => (
                        <option key={v.id} value={v.id}>
                          {v.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}
                {source && (
                  <div className="space-y-1.5">
                    <Label htmlFor="roll-mode">Show</Label>
                    <Select id="roll-mode" value={rollup.mode} onChange={(e) => setRollup({ ...rollup, mode: e.target.value as "count" | "where" | "sum" })}>
                      <option value="count">How many link here</option>
                      {source.selects.length > 0 && <option value="where">How many with a choice</option>}
                      {source.numbers.length > 0 && <option value="sum">The sum of one of their columns</option>}
                    </Select>
                  </div>
                )}
                {source && rollup.mode === "where" && (
                  <div className="flex gap-2">
                    <Select aria-label="Which column" value={rollup.whereProp || source.selects[0]?.id || ""} onChange={(e) => setRollup({ ...rollup, whereProp: e.target.value, whereOpt: "" })}>
                      {source.selects.map((x) => (
                        <option key={x.id} value={x.id}>
                          {x.name}
                        </option>
                      ))}
                    </Select>
                    <Select aria-label="Which choice" value={rollup.whereOpt || (source.selects.find((x) => x.id === (rollup.whereProp || source.selects[0]?.id))?.options[0]?.id ?? "")} onChange={(e) => setRollup({ ...rollup, whereOpt: e.target.value })}>
                      {(source.selects.find((x) => x.id === (rollup.whereProp || source.selects[0]?.id))?.options ?? []).map((o) => (
                        <option key={o.id} value={o.id}>
                          {o.name}
                        </option>
                      ))}
                    </Select>
                  </div>
                )}
                {source && rollup.mode === "sum" && (
                  <Select aria-label="Which column to add up" value={rollup.field || source.numbers[0]?.id || ""} onChange={(e) => setRollup({ ...rollup, field: e.target.value })}>
                    {source.numbers.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.name}
                      </option>
                    ))}
                  </Select>
                )}
                <p className="text-xs text-subtle">Worked out each time it&apos;s shown — never typed in. Somebody who can&apos;t open that list sees nothing in it.</p>
              </>
            )}
          </div>
        )}

        {property?.kind === "DATE" && (
          <fieldset className="space-y-2 rounded-base border border-line p-3">
            <legend className="px-1 text-xs font-medium text-muted">Reminder</legend>
            {reminder === undefined ? (
              <p className="text-xs text-subtle">Loading…</p>
            ) : (
              <>
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={!!reminder} onChange={(e) => setReminder(e.target.checked ? { daysBefore: 7, notify: whoChoices[0] ?? "BUILDER", personPropertyId: personColumns[0]?.id ?? null } : null)} />
                  Remind somebody before each row&apos;s {property.name.toLowerCase()}
                </label>
                {reminder && (
                  <div className="flex flex-wrap items-center gap-2 text-sm">
                    <Input
                      aria-label="Days before"
                      type="number"
                      min={0}
                      max={365}
                      className="h-8 w-20"
                      value={reminder.daysBefore}
                      onChange={(e) => setReminder({ ...reminder, daysBefore: Math.max(0, Math.min(365, Number(e.target.value) || 0)) })}
                    />
                    <span>days before, tell</span>
                    <Select aria-label="Who is reminded" className="h-8 w-60" value={reminder.notify} onChange={(e) => setReminder({ ...reminder, notify: e.target.value as NotifyWho })}>
                      {whoChoices.map((w) => (
                        <option key={w} value={w}>
                          {NOTIFY_LABELS[w]}
                        </option>
                      ))}
                    </Select>
                    {reminder.notify === "PERSON" && (
                      <Select aria-label="Which Person column" className="h-8 w-44" value={reminder.personPropertyId ?? ""} onChange={(e) => setReminder({ ...reminder, personPropertyId: e.target.value })}>
                        {personColumns.map((p) => (
                          <option key={p.id} value={p.id}>
                            {p.name}
                          </option>
                        ))}
                      </Select>
                    )}
                  </div>
                )}
                <p className="text-xs text-subtle">In Deskzo and by email, once for each date — only dates still to come, and only to people who can open this list.</p>
              </>
            )}
          </fieldset>
        )}

        {hasChoices && (
          <div className="space-y-2">
            <Label htmlFor="col-option">Choices</Label>
            <ul className="space-y-1.5">
              {options.map((o) => (
                <li key={o.id} className="flex items-center gap-2">
                  <Input
                    aria-label={`Choice ${o.name}`}
                    value={o.name}
                    maxLength={LIMITS.optionName}
                    onChange={(e) => setOptions(options.map((x) => (x.id === o.id ? { ...x, name: e.target.value } : x)))}
                    className="h-8 min-w-0 flex-1"
                  />
                  <select
                    aria-label={`Colour of ${o.name}`}
                    className="h-8 rounded-base border border-line-strong bg-surface px-1 text-xs"
                    value={o.color}
                    onChange={(e) => setOptions(options.map((x) => (x.id === o.id ? { ...x, color: e.target.value as OptionColor } : x)))}
                  >
                    {OPTION_COLORS.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <OptionChip option={o} className="hidden max-w-32 shrink-0 sm:inline-flex" />
                  <button type="button" aria-label={`Remove ${o.name}`} className="rounded p-1 text-subtle hover:text-danger" onClick={() => setOptions(options.filter((x) => x.id !== o.id))}>
                    <X className="h-4 w-4" />
                  </button>
                </li>
              ))}
            </ul>
            <div className="flex gap-2">
              <Input
                id="col-option"
                value={newOption}
                maxLength={LIMITS.optionName}
                placeholder="Add a choice — Visited, Demo done…"
                onChange={(e) => setNewOption(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addOption();
                  }
                }}
                className="h-8"
              />
              <Button type="button" variant="secondary" size="sm" onClick={addOption}>
                <Plus className="h-3.5 w-3.5" />
                Add
              </Button>
            </div>
            {property && <p className="text-xs text-subtle">A choice taken away leaves the rows that had it empty in this column.</p>}
          </div>
        )}

        {/* A column whose cells are records or files elsewhere, a count or a formula, is never shown to guests (src/lib/connect/own-rows.ts). */}
        {property && guests && !["COMPANY", "LEAD", "CONTACT", "ROW", "FILE", "ROLLUP", "FORMULA"].includes(property.kind) && (
          <fieldset className="space-y-2 rounded-base border border-line p-3">
            <legend className="px-1 text-xs font-medium text-muted">Guests this list is shared with (Deskzo Connect)</legend>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Visible to guests</span>
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={guestVisible}
                onChange={(e) => {
                  setGuestVisible(e.target.checked);
                  if (!e.target.checked) setGuestEditable(false);
                }}
              />
            </label>
            <label className="flex items-center justify-between gap-3 text-sm">
              <span>Guests can edit</span>
              <input
                type="checkbox"
                className="h-4 w-4"
                checked={guestEditable}
                onChange={(e) => {
                  setGuestEditable(e.target.checked);
                  if (e.target.checked) setGuestVisible(true);
                }}
              />
            </label>
            <p className="text-xs text-subtle">Off unless switched on: a column like &ldquo;Our margin&rdquo; stays yours even when the list is shared.</p>
          </fieldset>
        )}

        {error && (
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
        )}

        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-line pt-4">
          <div className="flex gap-1">
            {property && (
              <>
                <Button type="button" variant="ghost" size="sm" disabled={pending || isFirst} onClick={() => move("left")} aria-label="Move left">
                  <ArrowLeft className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={pending || isLast} onClick={() => move("right")} aria-label="Move right">
                  <ArrowRight className="h-3.5 w-3.5" />
                </Button>
                <Button type="button" variant="ghost" size="sm" disabled={pending} onClick={remove} className="text-danger">
                  <Trash2 className="h-3.5 w-3.5" />
                  Delete
                </Button>
              </>
            )}
          </div>
          <div className="flex gap-2">
            <Button type="button" variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={pending || !name.trim()}>
              {pending ? "Saving…" : property ? "Save" : "Add column"}
            </Button>
          </div>
        </div>
      </form>
    </Dialog>
  );
}
