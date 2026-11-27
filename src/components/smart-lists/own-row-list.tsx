import Link from "next/link";
import { Pencil } from "lucide-react";
import { requireUser } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { DuplicateWorkbookButton } from "@/components/workspace/duplicate-button";
import { getListBoard } from "@/actions/smart-list-board";
import { SmartListBoard } from "@/components/smart-lists/smart-list-board";
import { ExportRowsButton, ImportRowsButton, SaveAsTemplateButton } from "@/components/smart-lists/own-rows-tools";
import { FormsButton } from "@/components/smart-lists/list-forms";
import { AccessButton } from "@/components/smart-lists/list-access";
import { RepeatsButton } from "@/components/smart-lists/row-tools";
import { ownRowDashboard, ownRowsPage, ownRowsReady, titleNameOf } from "@/lib/smart-lists/own-rows";
import { workspaceClock } from "@/lib/time/workspace";
import { ownRowsQueryWhere, pageQuery } from "@/lib/smart-lists/view-query-server";
import { effectiveSort } from "@/lib/smart-lists/view-query";
import { ownRowTotals } from "@/lib/smart-lists/totals";
import { linkLabels } from "@/lib/smart-lists/links";
import { rollupValues } from "@/lib/smart-lists/rollups";
import type { getWorkbook } from "@/actions/workspace";
import { db } from "@/lib/db";

/** The most rows a board or a calendar of a list's own rows lays out at once. */
const BOARD_ROWS = 1000;

/**
 * A Smart List with rows of its own (owner, 20 Nov 2026 — src/lib/smart-lists/own-rows.ts): the same board as a list of
 * companies — views as tabs, its own columns, a page per row, a dashboard — over rows typed in, imported, or begun from
 * a template, with an Excel download. The page's access check is getWorkbook's, done by the caller.
 */
export async function OwnRowList({
  workbook,
  query,
}: {
  workbook: NonNullable<Awaited<ReturnType<typeof getWorkbook>>>;
  query: { q?: string; page?: string; pageSize?: string; view?: string; fq?: string; answers?: string };
}) {
  const [shape, ready, viewer, clock] = await Promise.all([getListBoard(workbook.id, []), ownRowsReady(), requireUser(), workspaceClock()]);
  if (!shape || !ready) {
    return <p className="rounded-card border border-line bg-surface px-4 py-6 text-sm text-muted">This list arrives with this workspace&apos;s next update. Try again in a few minutes.</p>;
  }
  const activeView = shape.views.find((v) => v.id === query.view) ?? null;
  const dashboard = query.view === "dashboard" ? await ownRowDashboard(workbook.id, clock.today()) : null;
  const wholeList = !!activeView && activeView.kind !== "TABLE" && !!activeView.propertyId;
  const page = wholeList ? 1 : resolvePage(query.page);
  const pageSize = wholeList ? BOARD_ROWS : resolvePageSize(query.pageSize);
  const me = viewer.id;
  // The view's filters and sort — saved, or tried in the address bar (Smart Lists phase 2).
  const { saved, current } = await pageQuery({ workbookId: workbook.id, viewId: activeView?.id ?? null, param: query.fq, props: shape.properties, own: true });
  const filter = await ownRowsQueryWhere(workbook.id, current, shape.properties, { userId: me, clock, today: clock.today() });
  const [titleName, result, totals] = await Promise.all([
    titleNameOf(workbook.id),
    ownRowsPage(workbook.id, shape.properties, { search: query.q, skip: (page - 1) * pageSize, take: pageSize, filter, sort: effectiveSort(current) }),
    dashboard || wholeList ? Promise.resolve(null) : ownRowTotals(workbook.id, shape.properties, { search: query.q, filter }),
  ]);
  const labels = me ? await linkLabels(shape.properties, result.values, me) : {};
  // Answers to its public forms waiting to be accepted (Smart Lists phase 4) — none on a workspace not migrated yet.
  const waiting = shape.canEdit ? await db.workbookFormSubmission.count({ where: { workbookId: workbook.id, status: "PENDING" } }).catch(() => 0) : 0;
  // And its rows that repeat (phase 4).
  const repeats = shape.canEdit ? await db.workbookRepeat.count({ where: { workbookId: workbook.id } }).catch(() => 0) : 0;
  // Count columns, worked out from the rows of other lists that link to these (Smart Lists phase 3).
  if (me) for (const [rowKey, cells] of Object.entries(await rollupValues(shape.properties, result.rows.map((r) => r.id), me))) result.values[rowKey] = { ...(result.values[rowKey] ?? {}), ...cells };

  return (
    <div className="animate-fade-rise">
      <Link href="/smart-lists" className="text-sm text-muted hover:text-text">
        ← Smart Lists
      </Link>

      <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-text">{workbook.name}</h1>
          {workbook.description && <p className="mt-1 max-w-3xl text-sm text-muted">{workbook.description}</p>}
          <p className="mt-1 text-xs text-subtle">
            {result.total.toLocaleString("en-IN")} row{result.total === 1 ? "" : "s"}
            {query.q || current.rules.length ? " found" : ""} · built by {workbook.owner.name}
            {!workbook.shared && " · private"}
            {workbook.shared && shape.canFill === false && " · view only for you"}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {shape.canEdit && <ImportRowsButton workbookId={workbook.id} />}
          {/* Forms that add rows, and the list kept as a template (Smart Lists phase 3). */}
          {shape.canEdit && <FormsButton workbookId={workbook.id} properties={shape.properties} waiting={waiting} startOnAnswers={query.answers === "1"} />}
          {shape.canEdit && <RepeatsButton workbookId={workbook.id} count={repeats} today={clock.today()} />}
          {shape.canEdit && <SaveAsTemplateButton workbookId={workbook.id} listName={workbook.name} />}
          {/* Who may see and fill it in (Smart Lists phase 4). */}
          {shape.canEdit && <AccessButton workbookId={workbook.id} />}
          <ExportRowsButton workbookId={workbook.id} />
          <DuplicateWorkbookButton id={workbook.id} />
          {workbook.canEdit && (
            <Link href={`/smart-lists/${workbook.id}/edit`}>
              <Button variant="secondary">
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit
              </Button>
            </Link>
          )}
        </div>
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search within this list…" />
      </div>

      <div className="mt-4">
        <SmartListBoard
          workbookId={workbook.id}
          rows={result.rows.map((r) => ({
            id: r.id,
            name: r.title,
            href: "",
            place: "",
            ownerName: null,
            own: {
              edited: [r.updatedBy ?? r.createdBy, clock.date(r.updatedAt)].filter(Boolean).join(" · "),
              mine: !!me && r.createdById === me,
            },
          }))}
          properties={shape.properties}
          views={shape.views}
          values={result.values}
          pinned={[]}
          people={shape.people}
          activeViewId={activeView?.id ?? null}
          canEdit={shape.canEdit}
          canAddRows
          canPin={false}
          today={clock.today()}
          ready={shape.ready}
          dashboard={dashboard}
          own={{ titleName }}
          canFill={shape.canFill ?? true}
          query={{ saved, current }}
          labels={labels}
          totals={totals}
        />
      </div>

      {dashboard ? null : wholeList ? (
        result.total > BOARD_ROWS && (
          <p className="mt-3 text-xs text-subtle">
            Showing the first {BOARD_ROWS.toLocaleString("en-IN")} of {result.total.toLocaleString("en-IN")} rows. Search within the list, or use the table to page through them all.
          </p>
        )
      ) : (
        <Pagination page={page} pageSize={pageSize} total={result.total} totalPages={totalPages(result.total, pageSize)} pageSizes={PAGE_SIZES} />
      )}
    </div>
  );
}
