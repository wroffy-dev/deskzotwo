"use client";

import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, SlidersHorizontal } from "lucide-react";
import { AnchoredPopover, insideAnchoredPopover } from "@/components/ui/anchored-popover";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { CustomFieldFilterForm } from "@/components/custom-fields/custom-field-filters";
import type { FilterSetup } from "@/lib/custom-fields/filters";
import { cn } from "@/lib/utils";

/**
 * A compact filter toolbar's parts (owner, 29 Oct 2026, the lead pipeline's): the search box with its
 * icon, a "More filters" panel holding the filters people reach for less, and "Clear all". Every filter
 * still lives in the URL as it always has — these only arrange them — so a reload, a shared link and the
 * Board, Table and Split views all keep the same choice.
 */

/** The toolbar's search box: the list's own search (SearchParamInput), drawn the toolbar's height with an icon. */
export function ToolbarSearch({
  paramName,
  placeholder,
  label,
  resetParams,
  className,
}: {
  paramName: string;
  placeholder: string;
  label?: string;
  /** As SearchParamInput's: the page numbers a new search sends back to the first page. */
  resetParams?: string[];
  className?: string;
}) {
  return (
    // Grows into the row's spare room and gives it back first, down to a short box, when the row is full.
    <div className={cn("relative", className ?? "w-full sm:w-auto sm:min-w-[5rem] sm:max-w-[15rem] sm:flex-1 sm:basis-0")}>
      <Search aria-hidden="true" className="pointer-events-none absolute left-2.5 top-1/2 h-[15px] w-[15px] -translate-y-1/2 text-subtle" />
      <SearchParamInput
        paramName={paramName}
        placeholder={placeholder}
        label={label}
        resetParams={resetParams}
        className="h-8 w-full rounded-lg border border-line-strong bg-surface pl-8 pr-2.5 text-[12.5px] text-text placeholder:text-subtle focus-visible:border-brand"
      />
    </div>
  );
}

const flat = (params: readonly (string | readonly string[])[]) => params.flatMap((p) => (typeof p === "string" ? [p] : [...p]));

/**
 * The filters a list's toolbar doesn't keep in view, behind one button. Each applies as it does in the
 * toolbar — a select at once, a date range at Done — and the workspace's own fields, when there are any,
 * at their Apply, as the Fields panel has always had them. The button counts the ones in use; Reset clears
 * these and leaves the toolbar's own alone. Closing the panel changes nothing.
 */
export function MoreFilters({
  params,
  fields,
  children,
  resetParams = ["page"],
}: {
  /** The URL parameters its filters write, a range as one group: each group in use counts once. */
  params: readonly (string | readonly string[])[];
  /** The workspace's own fields (src/lib/custom-fields/filters.ts `customFilterSetup`). */
  fields?: FilterSetup;
  children: ReactNode;
  resetParams?: string[];
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const anchorRef = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [width, setWidth] = useState(340);

  /**
   * Into the panel as it opens. It is portalled to the end of the page (AnchoredPopover), so without this a
   * keyboard user would have to tab past everything else on the screen to reach it — as the Fields panel does.
   */
  const attachPanel = useCallback((el: HTMLDivElement | null) => {
    if (el && !el.contains(document.activeElement)) el.querySelector<HTMLElement>("select, input, button[aria-haspopup]")?.focus();
  }, []);

  const inUse = params.filter((g) => (typeof g === "string" ? [g] : g).some((k) => !!searchParams.get(k))).length + (fields?.active ?? 0);

  useEffect(() => {
    if (!open) return;
    // A click in the panel — or in a calendar or list opened from it, portalled elsewhere — keeps it open.
    function onMouseDown(e: MouseEvent) {
      const target = e.target as Node | null;
      if (target && (anchorRef.current?.contains(target) || insideAnchoredPopover(target))) return;
      setOpen(false);
    }
    // On the window, after the page's own handlers: Escape in a calendar opened from here closes the
    // calendar (which marks the key handled), not the panel with it.
    function onKeyDown(e: KeyboardEvent) {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      setOpen(false);
      anchorRef.current?.focus();
    }
    document.addEventListener("mousedown", onMouseDown);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onMouseDown);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  function reset() {
    const next = new URLSearchParams(searchParams.toString());
    for (const key of flat(params)) next.delete(key);
    if (fields) for (const key of [...next.keys()]) if (key.startsWith(fields.prefix)) next.delete(key);
    for (const key of resetParams) next.delete(key);
    const query = next.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  return (
    <>
      <button
        ref={anchorRef}
        type="button"
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          // Never wider than a phone's screen.
          setWidth(Math.min(340, window.innerWidth - 16));
          setOpen((v) => !v);
        }}
        className={cn(
          "inline-flex h-8 shrink-0 items-center gap-1.5 rounded-lg border px-2.5 text-[12.5px] font-medium transition-colors",
          inUse > 0 ? "border-brand/50 bg-brand-subtle/50 text-text" : "border-line-strong bg-surface text-text hover:bg-surface-sunken",
        )}
      >
        <SlidersHorizontal aria-hidden="true" className={cn("h-[15px] w-[15px]", inUse > 0 ? "text-brand" : "text-subtle")} />
        More<span className="sr-only"> filters</span>
        {inUse > 0 && (
          <span className="rounded-full bg-brand-subtle px-1.5 text-[11px] font-semibold text-brand">
            {inUse}
            <span className="sr-only"> in use</span>
          </span>
        )}
      </button>
      {/* Its right edge on the button's, kept on screen: the button sits towards the toolbar's right-hand end. */}
      <AnchoredPopover anchorRef={anchorRef} open={open} width={width} maxHeight={560} align="end">
        <div ref={attachPanel} role="dialog" aria-label="More filters">
          <div className="flex items-center justify-between border-b border-line px-3 py-2.5">
            <p className="text-[13px] font-semibold text-text">More filters</p>
            <button type="button" onClick={reset} disabled={inUse === 0} className="text-[12.5px] font-medium text-brand hover:underline disabled:pointer-events-none disabled:text-subtle">
              Reset
            </button>
          </div>
          <div className="space-y-3 p-3">{children}</div>
          {fields && fields.fields.length > 0 && (
            <div className="border-t border-line">
              <CustomFieldFilterForm setup={fields} resetParams={resetParams} title="Your fields" onApplied={() => setOpen(false)} />
            </div>
          )}
        </div>
      </AnchoredPopover>
    </>
  );
}

/**
 * "Clear all": every filter on the list back to how the page opens — what is searched, the toolbar's and
 * More filters' choices and the workspace's fields — while the view, the pipeline and the page size stay.
 * Shown only while something is filtered.
 */
export function ClearFilters({ params, prefixes = [], resetParams = ["page"] }: { params: readonly string[]; prefixes?: readonly string[]; resetParams?: string[] }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filtered = (key: string) => params.includes(key) || prefixes.some((p) => key.startsWith(p));
  const active = [...searchParams.entries()].some(([key, value]) => !!value && filtered(key));
  if (!active) return null;
  return (
    <button
      type="button"
      onClick={() => {
        const next = new URLSearchParams(searchParams.toString());
        for (const key of [...next.keys()]) if (filtered(key)) next.delete(key);
        for (const key of resetParams) next.delete(key);
        const query = next.toString();
        router.push(query ? `${pathname}?${query}` : pathname);
      }}
      className="inline-flex h-8 shrink-0 items-center rounded-lg px-1.5 text-[12.5px] font-medium text-muted hover:bg-surface-sunken hover:text-text"
    >
      Clear<span className="sr-only"> all filters</span>
    </button>
  );
}
