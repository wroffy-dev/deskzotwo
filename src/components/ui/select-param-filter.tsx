"use client";

import { useId, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ChevronDown } from "lucide-react";
import { SearchSelect } from "@/components/ui/search-select";
import { cn } from "@/lib/utils";

/**
 * A filter that narrows a list, kept in the URL.
 *
 * Changing it returns to the first page. Without that, narrowing a list while standing on page 3
 * leaves the page number behind and shows an empty page 3 of a result that now has one page —
 * which reads as "no matches" and is how a working filter gets reported as broken.
 */
export function SelectParamFilter({
  paramName,
  label,
  allLabel = "All",
  options,
  resetParams = ["page"],
  variant = "inline",
  icon,
  searchable = false,
}: {
  paramName: string;
  label?: string;
  allLabel?: string;
  options: { value: string; label: string }[];
  /**
   * The page numbers this filter invalidates. Named rather than guessed, because a screen showing
   * two paginated lists has two of them and resetting only one is worse than resetting neither.
   */
  resetParams?: string[];
  /**
   * How it is drawn. "inline": a caption beside a select, as most lists have it. "pill": one compact
   * control reading "Stage: All" — a compact toolbar's (the lead pipeline's). "stacked": the caption
   * above a full-width select — inside a panel such as More filters.
   */
  variant?: "inline" | "pill" | "stacked";
  /** The pill's icon, drawn (`<Users />`): a page on the server can hand over an element, not a component. */
  icon?: ReactNode;
  /**
   * Opens with a search box over the list (SearchSelect) rather than the browser's own: for a list of
   * people, where the one wanted is a name somebody types rather than scrolls to (owner, 29 Oct 2026).
   */
  searchable?: boolean;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  // `useId` rather than the param name: a screen can show two filters on the same param (one per
  // list), and a shared id would point both labels at whichever select rendered first.
  const selectId = useId();

  function handleChange(value: string) {
    const params = new URLSearchParams(searchParams.toString());
    if (value) params.set(paramName, value);
    else params.delete(paramName);
    for (const key of resetParams) params.delete(key);
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  const current = searchParams.get(paramName) ?? "";
  const Field = searchable ? SearchSelect : "select";
  const searchPlaceholder = `Search ${(label ?? "").toLowerCase() || "options"}…`;
  const optionList = (
    <>
      <option value="">{allLabel}</option>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </>
  );

  if (variant === "pill") {
    // A styled face over the real select, which takes the clicks: the browser's own list on a phone, the
    // keyboard as a select has it everywhere, and nothing to re-implement.
    const chosen = options.find((o) => o.value === current);
    const active = !!current && !!chosen;
    const pillFace = (
      <>
        {icon && (
          <span aria-hidden="true" className={cn("shrink-0 [&>svg]:h-[15px] [&>svg]:w-[15px]", active ? "text-brand" : "text-subtle")}>
            {icon}
          </span>
        )}
        <span aria-hidden="true" className="text-muted">
          {label}:
        </span>
        <span aria-hidden="true" className={cn("max-w-[10rem] truncate font-medium", active ? "text-brand" : "text-text")}>
          {chosen?.label ?? allLabel}
        </span>
        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />
      </>
    );
    if (searchable) {
      // The same face, as SearchSelect's button: a click opens the list with its search box.
      return (
        <SearchSelect
          bare
          id={selectId}
          aria-label={label ?? allLabel}
          value={current}
          onChange={(e) => handleChange(e.target.value)}
          searchPlaceholder={searchPlaceholder}
          face={() => pillFace}
          className={cn(
            "w-auto shrink-0 h-8 gap-1 rounded-lg border bg-surface pl-2.5 pr-2 text-[12.5px] transition-colors focus-visible:border-brand",
            active ? "border-brand/50 bg-brand-subtle/50" : "border-line-strong hover:bg-surface-sunken",
          )}
        >
          {optionList}
        </SearchSelect>
      );
    }
    return (
      <div
        className={cn(
          "relative inline-flex h-8 shrink-0 items-center gap-1 rounded-lg border bg-surface pl-2.5 pr-2 text-[12.5px] transition-colors focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20",
          active ? "border-brand/50 bg-brand-subtle/50" : "border-line-strong hover:bg-surface-sunken",
        )}
      >
        {pillFace}
        <select
          id={selectId}
          aria-label={label ?? allLabel}
          value={current}
          onChange={(e) => handleChange(e.target.value)}
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
        >
          {optionList}
        </select>
      </div>
    );
  }

  if (variant === "stacked") {
    return (
      <div className="space-y-1 text-sm">
        {label && (
          <label htmlFor={selectId} className="block text-[12.5px] font-medium text-muted">
            {label}
          </label>
        )}
        <Field
          id={selectId}
          aria-label={label ? undefined : allLabel}
          value={current}
          onChange={(e) => handleChange(e.target.value)}
          {...(searchable && { searchPlaceholder })}
          className={cn("h-9 w-full rounded-lg border bg-surface px-2.5 text-[13px] text-text shadow-none", current ? "border-brand/50" : "border-line-strong")}
        >
          {optionList}
        </Field>
      </div>
    );
  }

  return (
    <div className="flex min-w-0 max-w-full items-center gap-2 text-sm">
      {/* Tied to the select, not merely sitting beside it: a caption looks identical and names
          nothing, and the pairing also makes the word itself a click target for the dropdown. */}
      {label && (
        <label htmlFor={selectId} className="text-muted">
          {label}
        </label>
      )}
      <Field
        id={selectId}
        /* Four screens render this filter with no label at all, where the "All …" option is the
           only wording it has. Left off when there is a label, so the visible word stays the name
           rather than being shadowed by a second one. */
        aria-label={label ? undefined : allLabel}
        value={searchParams.get(paramName) ?? ""}
        onChange={(e) => handleChange(e.target.value)}
        {...(searchable && { searchPlaceholder })}
        className={cn("h-8 min-w-0 max-w-full rounded-md border border-line-strong px-2 text-sm", searchable && "w-48 shadow-none")}
      >
        {optionList}
      </Field>
    </div>
  );
}
