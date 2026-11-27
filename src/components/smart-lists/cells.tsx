"use client";

import { useContext, useEffect, useRef, useState } from "react";
import { Check, Paperclip, Star } from "lucide-react";
import { cn } from "@/lib/utils";
import type { BoardProperty } from "@/actions/smart-list-board";
import { LIMITS, isLinkKind, valueText, type OptionColor, type SelectOption } from "@/lib/smart-lists/values";
import { LinkLabels } from "@/components/smart-lists/link-labels";
import { LinkPicker, FileCellEditor } from "@/components/smart-lists/link-cells";

/**
 * A Smart List's cells (owner, 20 Nov 2026 — src/lib/smart-lists): each column kind shown, and edited in place — click,
 * change, and it saves on Enter or leaving the field; Escape puts it back. What the server keeps is
 * src/lib/smart-lists/values.ts's rule, so a cell shows what came back, not what was typed.
 */

const CHIP: Record<OptionColor, string> = {
  gray: "bg-surface-sunken text-muted",
  blue: "bg-info-bg text-info",
  green: "bg-success-bg text-success",
  amber: "bg-warning-bg text-warning",
  red: "bg-danger-bg text-danger",
  purple: "bg-brand-subtle text-brand",
  pink: "bg-pink-100 text-pink-700 dark:bg-pink-950 dark:text-pink-300",
};

export function OptionChip({ option, className }: { option: SelectOption; className?: string }) {
  return <span className={cn("inline-flex max-w-full items-center truncate rounded px-1.5 py-0.5 text-xs font-medium", CHIP[option.color], className)}>{option.name}</span>;
}

/** The value as read — chips for choices, a tick for a checkbox, a link for a link. */
export function CellValue({ property, value, people }: { property: BoardProperty; value: unknown; people: Map<string, string> }) {
  if (value === null || value === undefined) return <span className="text-subtle">—</span>;
  switch (property.kind) {
    case "SELECT": {
      const o = property.options.find((x) => x.id === value);
      return o ? <OptionChip option={o} /> : <span className="text-subtle">—</span>;
    }
    case "MULTI_SELECT":
      return (
        <span className="flex flex-wrap gap-1">
          {(Array.isArray(value) ? value : []).map((id) => {
            const o = property.options.find((x) => x.id === id);
            return o ? <OptionChip key={o.id} option={o} /> : null;
          })}
        </span>
      );
    case "CHECKBOX":
      return value === true ? <Check className="h-4 w-4 text-success" aria-label="Yes" /> : null;
    case "LINK":
      return (
        <a href={String(value)} target="_blank" rel="noopener noreferrer" className="truncate text-brand hover:underline" onClick={(e) => e.stopPropagation()}>
          {String(value).replace(/^https?:\/\/(www\.)?/, "").replace(/\/$/, "")}
        </a>
      );
    case "EMAIL":
      return (
        <a href={`mailto:${String(value)}`} className="truncate text-brand hover:underline" onClick={(e) => e.stopPropagation()}>
          {String(value)}
        </a>
      );
    case "PHONE":
      return (
        <a href={`tel:${String(value).replace(/[^\d+]/g, "")}`} className="truncate text-text hover:underline" onClick={(e) => e.stopPropagation()}>
          {String(value)}
        </a>
      );
    case "RATING":
      return <Stars value={typeof value === "number" ? value : 0} />;
    case "FORMULA": {
      // What its formula works out, as its format says (Smart Lists phase 4).
      const f = property.formula?.format ?? "number";
      if (f === "checkbox") return value === true ? <Check className="h-4 w-4 text-success" aria-label="Yes" /> : null;
      if (typeof value === "number")
        return (
          <span className="tabular-nums">
            {f === "money" ? "₹" : ""}
            {value.toLocaleString("en-IN", { maximumFractionDigits: 2 })}
            {f === "days" ? ` day${Math.abs(value) === 1 ? "" : "s"}` : ""}
          </span>
        );
      return <span className="truncate">{String(value)}</span>;
    }
    case "ROLLUP":
      return (
        <span className="tabular-nums">
          {property.rollup?.money ? "₹" : ""}
          {typeof value === "number" ? value.toLocaleString("en-IN", { maximumFractionDigits: 2 }) : "0"}
        </span>
      );
    case "COMPANY":
    case "LEAD":
    case "CONTACT":
    case "ROW":
    case "FILE":
      return <LinkChips ids={Array.isArray(value) ? value.map(String) : []} file={property.kind === "FILE"} />;
    default:
      return <span className="truncate">{valueText(property.kind, value, property.options, people)}</span>;
  }
}

/** Linked records or files by name, each opening where it lives; one the person may not see reads "Hidden". */
function LinkChips({ ids, file }: { ids: string[]; file: boolean }) {
  const { labels } = useContext(LinkLabels);
  if (!ids.length) return <span className="text-subtle">—</span>;
  return (
    <span className="flex flex-wrap gap-1">
      {ids.map((id) => {
        const l = labels[id];
        const body = (
          <>
            {file && <Paperclip className="h-3 w-3 shrink-0" aria-hidden="true" />}
            <span className="truncate">{l?.name ?? "…"}</span>
          </>
        );
        const cls = cn("inline-flex max-w-48 items-center gap-1 rounded px-1.5 py-0.5 text-xs", l?.hidden ? "bg-surface-sunken text-subtle italic" : "bg-info-bg text-info");
        return l?.href ? (
          <a key={id} href={l.href} target={file ? "_blank" : undefined} rel={file ? "noopener noreferrer" : undefined} className={cn(cls, "hover:underline")} onClick={(e) => e.stopPropagation()}>
            {body}
          </a>
        ) : (
          <span key={id} className={cls}>
            {body}
          </span>
        );
      })}
    </span>
  );
}

/** One to five stars, read-only. */
export function Stars({ value }: { value: number }) {
  return (
    <span className="inline-flex items-center gap-0.5" aria-label={`${value} of ${LIMITS.rating} stars`}>
      {Array.from({ length: LIMITS.rating }, (_, i) => (
        <Star key={i} aria-hidden="true" className={cn("h-3.5 w-3.5", i < value ? "fill-warning text-warning" : "text-line-strong")} />
      ))}
    </span>
  );
}

const inputClass = "h-8 w-full rounded-base border border-brand bg-surface px-2 text-sm text-text outline-none";

/**
 * The editor for one cell. `onSave` gets what the person chose (raw; the server parses it) and the editor closes.
 * A checkbox needs no editor: a click flips it.
 */
export function CellEditor({
  property,
  value,
  people,
  onSave,
  onCancel,
  rowKey,
}: {
  property: BoardProperty;
  value: unknown;
  people: { id: string; name: string }[];
  onSave: (raw: unknown) => void;
  onCancel: () => void;
  /** The row the cell is in — a Files cell uploads into it. */
  rowKey?: string;
}) {
  const [draft, setDraft] = useState<unknown>(value ?? (property.kind === "MULTI_SELECT" ? [] : ""));
  const ref = useRef<HTMLInputElement & HTMLSelectElement>(null);
  useEffect(() => {
    ref.current?.focus();
    if (ref.current && "select" in ref.current && typeof ref.current.select === "function" && ref.current.tagName === "INPUT") ref.current.select();
  }, []);
  const done = () => onSave(draft);
  const keys = (e: React.KeyboardEvent) => {
    if (e.key === "Enter") {
      e.preventDefault();
      done();
    }
    if (e.key === "Escape") {
      e.preventDefault();
      onCancel();
    }
  };

  switch (property.kind) {
    case "SELECT":
    case "PERSON": {
      const choices = property.kind === "SELECT" ? property.options.map((o) => ({ id: o.id, name: o.name })) : people;
      return (
        <select
          ref={ref}
          aria-label={property.name}
          className={inputClass}
          value={String(draft ?? "")}
          onChange={(e) => onSave(e.target.value)}
          onBlur={onCancel}
          onKeyDown={keys}
        >
          <option value="">—</option>
          {choices.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      );
    }
    case "COMPANY":
    case "LEAD":
    case "CONTACT":
    case "ROW":
      return isLinkKind(property.kind) ? <LinkPicker property={property} value={Array.isArray(value) ? value.map(String) : []} onSave={onSave} onCancel={onCancel} /> : null;
    case "FILE":
      return <FileCellEditor property={property} rowKey={rowKey ?? ""} value={Array.isArray(value) ? value.map(String) : []} onSave={onSave} onCancel={onCancel} />;
    case "MULTI_SELECT": {
      const chosen = new Set(Array.isArray(draft) ? (draft as string[]) : []);
      return (
        <div
          className="min-w-48 space-y-1 rounded-base border border-brand bg-surface p-2 shadow-lg"
          onKeyDown={keys}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node | null)) done();
          }}
        >
          {property.options.map((o, i) => (
            <label key={o.id} className="flex cursor-pointer items-center gap-2 text-sm">
              <input
                ref={i === 0 ? (ref as React.Ref<HTMLInputElement>) : undefined}
                type="checkbox"
                checked={chosen.has(o.id)}
                onChange={(e) => {
                  const next = new Set(chosen);
                  if (e.target.checked) next.add(o.id);
                  else next.delete(o.id);
                  setDraft([...next]);
                }}
              />
              <OptionChip option={o} />
            </label>
          ))}
          {property.options.length === 0 && <p className="text-xs text-subtle">No choices yet — add some from the column&apos;s menu.</p>}
          <button type="button" className="mt-1 w-full rounded-base bg-brand px-2 py-1 text-xs font-medium text-brand-contrast" onClick={done}>
            Done
          </button>
        </div>
      );
    }
    case "RATING": {
      const current = typeof value === "number" ? value : 0;
      return (
        <div role="radiogroup" aria-label={property.name} className="flex h-8 items-center gap-0.5 rounded-base border border-brand bg-surface px-1.5" onKeyDown={keys}>
          {Array.from({ length: LIMITS.rating }, (_, i) => (
            <button
              key={i}
              ref={i === 0 ? (ref as unknown as React.Ref<HTMLButtonElement>) : undefined}
              type="button"
              role="radio"
              aria-checked={current === i + 1}
              aria-label={`${i + 1} star${i ? "s" : ""}`}
              className="rounded p-0.5 hover:bg-surface-sunken"
              // The same star again takes the rating away.
              onClick={() => onSave(current === i + 1 ? null : i + 1)}
              onBlur={(e) => {
                if (!e.currentTarget.parentElement?.contains(e.relatedTarget as Node | null)) onCancel();
              }}
            >
              <Star aria-hidden="true" className={cn("h-4 w-4", i < current ? "fill-warning text-warning" : "text-line-strong")} />
            </button>
          ))}
        </div>
      );
    }
    case "DATE":
      return <input ref={ref} type="date" aria-label={property.name} className={inputClass} value={String(draft ?? "")} onChange={(e) => setDraft(e.target.value)} onBlur={done} onKeyDown={keys} />;
    case "NUMBER":
    case "MONEY":
      return <input ref={ref} type="number" inputMode="decimal" step="any" aria-label={property.name} className={inputClass} value={String(draft ?? "")} onChange={(e) => setDraft(e.target.value)} onBlur={done} onKeyDown={keys} />;
    default:
      return <input ref={ref} type={property.kind === "LINK" ? "url" : property.kind === "EMAIL" ? "email" : property.kind === "PHONE" ? "tel" : "text"} aria-label={property.name} className={inputClass} value={String(draft ?? "")} onChange={(e) => setDraft(e.target.value)} onBlur={done} onKeyDown={keys} />;
  }
}

/** A column's footer in a table: what it adds up to over every row the view shows (Smart Lists phase 2). */
export function TotalCell({ property, total }: { property: BoardProperty; total: { filled: number; sum?: number; ticked?: number } | undefined }) {
  if (!total || property.kind === "ROLLUP") return null;
  const money = property.kind === "MONEY" || (property.kind === "FORMULA" && property.formula?.format === "money");
  const text =
    money && total.sum !== undefined
      ? `₹${total.sum.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
      : total.sum !== undefined
        ? `Sum ${total.sum.toLocaleString("en-IN", { maximumFractionDigits: 2 })}`
        : total.ticked !== undefined
          ? `${(total.ticked ?? 0).toLocaleString("en-IN")} ticked`
          : `${total.filled.toLocaleString("en-IN")} filled`;
  return <span className="block truncate px-2 text-xs font-medium text-muted">{text}</span>;
}
