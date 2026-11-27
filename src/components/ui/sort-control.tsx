"use client";

import { useId } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, ArrowUpDown, ChevronDown } from "lucide-react";
import { DIR_LABELS, resolveSort, type SortOption } from "@/lib/tables/sort-options";
import { cn } from "@/lib/utils";

/**
 * A list's Sort (owner, 31 Oct 2026): what to sort by, a pill over the browser's own select as the filters have it,
 * and beside it the direction — one click turns it round. Kept in the URL as `sort` and `dir`; choosing a new sort
 * opens it in its own direction (newest, highest, soonest first), and either goes back to page one.
 */
export function SortControl({ options, canSeeOrders = false }: { options: readonly SortOption[]; canSeeOrders?: boolean }) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const selectId = useId();
  const usable = options.filter((o) => !o.needsOrders || canSeeOrders);
  const current = resolveSort(usable, searchParams.get("sort") ?? undefined, searchParams.get("dir") ?? undefined, { canSeeOrders });
  const option = usable.find((o) => o.key === current.key)!;

  function go(sort: string, dir: string | null) {
    const params = new URLSearchParams(searchParams.toString());
    if (sort === usable[0]!.key && (dir === null || dir === usable[0]!.dir)) {
      params.delete("sort");
      params.delete("dir");
    } else {
      params.set("sort", sort);
      if (dir === null || dir === usable.find((o) => o.key === sort)?.dir) params.delete("dir");
      else params.set("dir", dir);
    }
    params.delete("page");
    const query = params.toString();
    router.push(query ? `${pathname}?${query}` : pathname);
  }

  const active = !current.isDefault;
  const flipTo = current.dir === "asc" ? "desc" : "asc";
  const DirIcon = current.dir === "asc" ? ArrowUpNarrowWide : ArrowDownWideNarrow;
  return (
    <div
      className={cn(
        "inline-flex h-8 shrink-0 items-stretch overflow-hidden rounded-lg border bg-surface text-[12.5px] transition-colors focus-within:border-brand focus-within:ring-2 focus-within:ring-brand/20",
        active ? "border-brand/50 bg-brand-subtle/50" : "border-line-strong",
      )}
    >
      <div className="relative inline-flex items-center gap-1 pl-2.5 pr-2 hover:bg-surface-sunken">
        <ArrowUpDown aria-hidden="true" className={cn("h-[15px] w-[15px] shrink-0", active ? "text-brand" : "text-subtle")} />
        <span aria-hidden="true" className="text-muted">
          Sort:
        </span>
        <span aria-hidden="true" className={cn("max-w-[10rem] truncate font-medium", active ? "text-brand" : "text-text")}>
          {option.label}
        </span>
        <ChevronDown aria-hidden="true" className="h-3.5 w-3.5 shrink-0 text-subtle" />
        <select
          id={selectId}
          aria-label="Sort by"
          value={current.key}
          onChange={(e) => go(e.target.value, null)}
          className="absolute inset-0 h-full w-full cursor-pointer appearance-none opacity-0"
        >
          {usable.map((o) => (
            <option key={o.key} value={o.key}>
              {o.label}
            </option>
          ))}
        </select>
      </div>
      <button
        type="button"
        onClick={() => go(current.key, flipTo)}
        title={`${DIR_LABELS[option.kind][current.dir]} — click for ${DIR_LABELS[option.kind][flipTo].toLowerCase()}`}
        aria-label={`${DIR_LABELS[option.kind][current.dir]}. Show ${DIR_LABELS[option.kind][flipTo].toLowerCase()}`}
        className={cn("inline-flex items-center gap-1 border-l px-2 hover:bg-surface-sunken", active ? "border-brand/30 text-brand" : "border-line-strong text-muted")}
      >
        <DirIcon aria-hidden="true" className="h-[15px] w-[15px]" />
        <span className="hidden sm:inline">{DIR_LABELS[option.kind][current.dir]}</span>
      </button>
    </div>
  );
}
