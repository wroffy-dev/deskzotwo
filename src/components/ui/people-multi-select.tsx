"use client";

import { useId, useMemo, useState } from "react";
import { Check, Search, X } from "lucide-react";

export type PickPerson = { id: string; name: string; hint?: string | null };

/**
 * Picking several people by searching (owner, 16 Nov 2026: "change it to search and select" — in place of every name in
 * the workspace laid out as a button). Who's chosen sits on top, each removable; under it a search box and the people
 * matching it as a short scrolling list, ticked when chosen. Enter takes the top match; typing narrows by name or hint.
 */
export function PeopleMultiSelect({
  people,
  selected,
  onChange,
  placeholder = "Search people…",
  emptyText = "Nobody matches that.",
  label,
}: {
  people: PickPerson[];
  selected: string[];
  onChange: (ids: string[]) => void;
  placeholder?: string;
  emptyText?: string;
  /** For a screen reader: what the list is for — "Who is calling". */
  label?: string;
}) {
  const [query, setQuery] = useState("");
  const listId = useId();
  const byId = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const chosen = selected.map((id) => byId.get(id)).filter((p): p is PickPerson => !!p);
  const needle = query.trim().toLowerCase();
  const matches = needle ? people.filter((p) => p.name.toLowerCase().includes(needle) || (p.hint ?? "").toLowerCase().includes(needle)) : people;

  const toggle = (id: string) => onChange(selected.includes(id) ? selected.filter((v) => v !== id) : [...selected, id]);

  return (
    <div className="space-y-2">
      {chosen.length > 0 && (
        <div className="flex flex-wrap items-center gap-1.5" aria-label={label ? `${label}: chosen` : "Chosen"}>
          {chosen.map((p) => (
            <span key={p.id} className="inline-flex items-center gap-1 rounded-full bg-brand-subtle py-0.5 pl-2.5 pr-1 text-sm text-brand">
              {p.name}
              <button type="button" onClick={() => toggle(p.id)} className="grid h-5 w-5 place-items-center rounded-full hover:bg-brand/15" aria-label={`Remove ${p.name}`} title={`Remove ${p.name}`}>
                <X className="h-3 w-3" aria-hidden />
              </button>
            </span>
          ))}
          <button type="button" onClick={() => onChange([])} className="text-xs text-subtle hover:text-text hover:underline">
            Clear
          </button>
        </div>
      )}
      <div className="rounded-base border border-line-strong bg-surface">
        <div className="flex items-center gap-2 border-b border-line px-3">
          <Search className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                if (matches[0]) {
                  toggle(matches[0].id);
                  setQuery("");
                }
              }
            }}
            placeholder={placeholder}
            aria-label={label ? `Search — ${label}` : placeholder}
            aria-controls={listId}
            className="h-9 w-full bg-transparent text-sm text-text outline-none placeholder:text-subtle"
          />
          <span className="shrink-0 text-xs text-subtle">{selected.length > 0 ? `${selected.length} chosen` : ""}</span>
        </div>
        <ul id={listId} role="listbox" aria-multiselectable aria-label={label} className="max-h-56 overflow-y-auto py-1">
          {matches.length === 0 && <li className="px-3 py-2 text-sm text-subtle">{emptyText}</li>}
          {matches.map((p) => {
            const on = selected.includes(p.id);
            return (
              <li key={p.id} role="option" aria-selected={on}>
                <button type="button" onClick={() => toggle(p.id)} className={`flex w-full items-center gap-2.5 px-3 py-1.5 text-left text-sm transition-colors hover:bg-surface-sunken ${on ? "text-text" : "text-muted"}`}>
                  <span className={`grid h-4 w-4 shrink-0 place-items-center rounded border ${on ? "border-brand bg-brand text-brand-contrast" : "border-line-strong"}`}>{on && <Check className="h-3 w-3" aria-hidden />}</span>
                  <span className="min-w-0 flex-1 truncate">{p.name}</span>
                  {p.hint && <span className="shrink-0 truncate text-xs text-subtle">{p.hint}</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
