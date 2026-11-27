import type { ReactNode } from "react";

/**
 * A list page's header (owner, 29 Oct 2026, from the lead pipeline's): the title and its count, then the
 * search box, the filters kept in view, More and Clear, then the page's own actions — Columns, the layout
 * switch, Export, New — on one row where the page has room for it. Where it hasn't, the filters take a row
 * of their own under the title; on a phone they scroll sideways rather than stacking.
 *
 * Only an arrangement: every control in it is the page's own (ToolbarSearch, SelectParamFilter's "pill",
 * MoreFilters, ClearFilters, ColumnPicker's "toolbar", the layout switch) and writes the URL as it always has.
 * Drawn on the server; the controls it holds are the client parts.
 */
export function ListHeader({
  title,
  subtitle,
  search,
  filters,
  actions,
  tabs,
}: {
  title: ReactNode;
  /** Under the title: the count, "267 total leads". */
  subtitle?: ReactNode;
  /** The list's ToolbarSearch. */
  search?: ReactNode;
  /** The filters kept in view as pills, then MoreFilters and ClearFilters. */
  filters?: ReactNode;
  /** Columns, the layout switch, Export, New — at the row's end. */
  actions?: ReactNode;
  /**
   * Quick views as chips (All, Prospects, Leads…). Given, they take the second row with the actions at its end, so
   * the header is two rows, not three (owner, 17 Nov 2026, Companies: "three lines getting waste").
   */
  tabs?: ReactNode;
}) {
  const actionsBox = actions && <div className="ml-auto flex flex-wrap items-center justify-end gap-1.5">{actions}</div>;
  return (
    <div className="@container">
      <div className="flex flex-wrap items-center gap-x-1.5 gap-y-3">
        <div className="mr-2 min-w-0 max-w-full shrink-0">
          <h1 className="text-lg font-semibold leading-tight text-text">{title}</h1>
          {subtitle && <p className="mt-0.5 text-sm text-muted">{subtitle}</p>}
        </div>
        {/*
          Sized by its content (flex-auto, not flex-1): when it and the actions don't share a row, the actions move
          down whole, instead of the filters breaking with Clear left alone on a line (owner, 30 Oct 2026, Renewals).
        */}
        {(search || filters) && (
          <div className="order-last flex w-full flex-wrap items-center gap-1.5 @min-[64rem]:order-none @min-[64rem]:w-auto @min-[64rem]:min-w-0 @min-[64rem]:flex-auto">
            {search}
            {/*
              On a phone, one row that scrolls sideways; wider, part of the header's own row. Positioned, so
              the buttons' screen-reader text (sr-only, absolute) scrolls with them rather than widening the page.
            */}
            {filters && <div className="relative -mx-4 flex w-[calc(100%+2rem)] items-center gap-1.5 overflow-x-auto px-4 pb-1 sm:contents">{filters}</div>}
          </div>
        )}
        {!tabs && actionsBox}
      </div>
      {tabs && (
        <div className="mt-3 flex flex-wrap items-center gap-x-1.5 gap-y-2">
          <div className="flex min-w-0 flex-wrap items-center gap-2">{tabs}</div>
          {actionsBox}
        </div>
      )}
    </div>
  );
}
