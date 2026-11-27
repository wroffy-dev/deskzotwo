import Link from "next/link";
import { notFound } from "next/navigation";
import { Mail, Pencil, PhoneCall } from "lucide-react";
import { requireUser } from "@/lib/session";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { getWorkbook, runWorkbook } from "@/actions/workspace";
import { listAssignableUsers } from "@/actions/company";
import { getViewMode } from "@/actions/view-mode";
import { Badge } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { SplitListShell, SplitListEmpty, SplitListPage, resolveSelected, splitLinkParams } from "@/components/ui/split-list";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { CompanySplitList } from "@/components/companies/company-split-list";
import { CompanyDetail } from "@/components/companies/company-detail";
import { WorkbookResults } from "@/components/workspace/workbook-results";
import { DuplicateWorkbookButton } from "@/components/workspace/duplicate-button";
import { AssignWorkbook } from "@/components/workspace/assign-workbook";
import { StartActivity } from "@/components/workspace/start-activity";
import { ActivityDashboard } from "@/components/workspace/activity-dashboard";
import { activityReport } from "@/actions/calling-activity";
import { countActiveFilters, filterLabels, type WorkbookFilters } from "@/lib/workspace/filters";
import { can } from "@/lib/authz/resolve";
import { isModuleEntitled } from "@/lib/modules-access";
import { getListBoard, getListDashboard, getListValues } from "@/actions/smart-list-board";
import { SmartListBoard } from "@/components/smart-lists/smart-list-board";
import { companyPath } from "@/lib/record-links";
import { workspaceClock } from "@/lib/time/workspace";
import { OwnRowList } from "@/components/smart-lists/own-row-list";
import { pageQuery } from "@/lib/smart-lists/view-query-server";
import { linkLabels } from "@/lib/smart-lists/links";
import { rollupValues } from "@/lib/smart-lists/rollups";
import { ExportCompaniesButton } from "@/components/smart-lists/own-rows-tools";
import { AccessButton } from "@/components/smart-lists/list-access";

/** The most rows a board or a calendar lays out at once. */
const BOARD_ROWS = 500;

export default async function WorkbookPage({
  params,
  searchParams,
}: {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ q?: string; page?: string; pageSize?: string; sel?: string; tab?: string; view?: string; fq?: string; answers?: string }>;
}) {
  const enabled = await isModuleEnabled("workspace");
  if (!enabled) return <ModuleDisabledNotice moduleKey="workspace" />;

  const [{ id }, query] = await Promise.all([params, searchParams]);
  const workbook = await getWorkbook(id);
  if (!workbook) notFound();
  // A list with rows of its own — a backlink tracker, a unit inventory — not companies (src/lib/smart-lists/own-rows.ts).
  if (workbook.mode === "ROWS") return <OwnRowList workbook={workbook} query={query} />;

  const isActivity = workbook.mode === "COLD_CALLING";
  // Notion-style views and columns (owner, 20 Nov 2026 — src/lib/smart-lists): a board or a calendar lays out every row
  // at once (up to BOARD_ROWS), a table pages as before.
  const shape = isActivity ? null : await getListBoard(id, []);
  const activeView = shape?.views.find((v) => v.id === query.view) ?? null;
  // The Dashboard tab (owner, 20 Nov 2026): the whole list summed up instead of a page of it.
  const dashboard = shape?.ready && query.view === "dashboard" ? await getListDashboard(id) : null;
  const wholeList = !!activeView && activeView.kind !== "TABLE" && !!activeView.propertyId;
  const page = wholeList ? 1 : resolvePage(query.page);
  const pageSize = wholeList ? BOARD_ROWS : resolvePageSize(query.pageSize);
  // A calling campaign is the Calls module's: without it in the plan, none is started or reported.
  const callsInPlan = await isModuleEntitled("calls");
  // The view's filters and sort — saved, or tried in the address bar (Smart Lists phase 2, src/lib/smart-lists/view-query.ts).
  const queries = shape?.ready ? await pageQuery({ workbookId: id, viewId: activeView?.id ?? null, param: query.fq, props: shape.properties, own: false }) : null;

  const [viewer, viewMode, result, users, report] = await Promise.all([
    requireUser(),
    getViewMode("workspace"),
    // A campaign's rows are its frozen records, not the live filter — that's the whole point of
    // starting one, so the segment isn't re-run here.
    isActivity
      ? Promise.resolve({ rows: [], total: 0 })
      : runWorkbook({ filters: workbook.filters, page, pageSize, search: query.q, workbookId: workbook.id, query: queries?.current, totals: !!shape?.ready && !wholeList && !dashboard }),
    listAssignableUsers(),
    isActivity && callsInPlan ? activityReport(id) : Promise.resolve(null),
  ]);

  const selected = !isActivity && viewMode === "split" ? resolveSelected(result.rows, query.sel) : null;

  // Named rather than listed in full: the point is to see at a glance what narrows this list, and
  // the exact values are one click away in the editor.
  const activeKeys = (Object.keys(workbook.filters) as (keyof WorkbookFilters)[]).filter((key) => {
    const value = workbook.filters[key];
    if (value === undefined || value === null || value === "" || value === false) return false;
    return Array.isArray(value) ? value.length > 0 : true;
  });

  const canAssign = workbook.canEdit || (await can(viewer.id, "workspace.manageAny"));
  // Mail the list with a marketing template (owner, 16 Nov 2026): for whoever may build campaigns, with Marketing on.
  const canMail = (await isModuleEnabled("marketing")) && (await can(viewer.id, "marketing.manage"));
  // Each row's own Mail button, beside Call: one company, a message template (owner, 16 Nov 2026).
  const canMessage = await can(viewer.id, "messages.send");
  // The list as Excel (Smart Lists phase 3): for whoever may export CRM data.
  const canExport = !isActivity && (await can(viewer.id, "data.exportCrm"));
  const listValues = shape && viewMode === "list" ? await getListValues(id, result.rows.map((r) => r.id)) : { values: {}, pinned: [] };
  const clock = await workspaceClock();
  // Linked records' and files' names, as this person may see them (Smart Lists phase 2).
  const labels = shape?.ready ? await linkLabels(shape.properties, listValues.values, viewer.id) : {};
  // Count columns, worked out from the rows of other lists that link to these companies (Smart Lists phase 3).
  if (shape?.ready) for (const [rowKey, cells] of Object.entries(await rollupValues(shape.properties, result.rows.map((r) => r.id), viewer.id))) listValues.values[rowKey] = { ...(listValues.values[rowKey] ?? {}), ...cells };

  return (
    <SplitListPage active={!isActivity && viewMode === "split"}>
      <Link href="/smart-lists" className="text-sm text-muted hover:text-text">
        ← Smart Lists
      </Link>

      <div className="mt-1 flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h1 className="text-xl font-semibold text-text">{workbook.name}</h1>
          {workbook.description && viewMode === "list" && (
            <p className="mt-1 text-sm text-muted">{workbook.description}</p>
          )}
          <p className="mt-1 text-xs text-subtle">
            {isActivity
              ? `${report?.totals.records ?? 0} record(s) frozen · calling activity`
              : `${result.total.toLocaleString("en-IN")} compan${result.total === 1 ? "y" : "ies"} today`}{" "}
            · {countActiveFilters(workbook.filters)} filter(s) · built by {workbook.owner.name}
            {!workbook.shared && " · private"}
          </p>
          <div className="mt-2">
            <AssignWorkbook
              workbookId={workbook.id}
              assignees={workbook.assignees}
              users={users}
              canAssign={canAssign}
              calling={isActivity}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {!isActivity && <ViewModeToggle viewKey="workspace" mode={viewMode} />}
          {!isActivity && workbook.canEdit && callsInPlan && (
            <StartActivity workbookId={workbook.id} matchCount={result.total} users={users} />
          )}
          {isActivity && (
            <Link href={`/smart-lists/${workbook.id}/call`}>
              <Button>
                <PhoneCall className="mr-1.5 h-3.5 w-3.5" />
                Open my queue
              </Button>
            </Link>
          )}
          {canMail && (
            <Link href={`/marketing/send?smartList=${encodeURIComponent(workbook.id)}`}>
              <Button variant="secondary">
                <Mail className="mr-1.5 h-3.5 w-3.5" />
                Mail all
              </Button>
            </Link>
          )}
          {canExport && <ExportCompaniesButton workbookId={workbook.id} />}
          {/* Who may see and fill it in (Smart Lists phase 4). */}
          {!isActivity && workbook.canEdit && <AccessButton workbookId={workbook.id} />}
          <DuplicateWorkbookButton id={workbook.id} />
          {workbook.canEdit && (
            <Link href={`/smart-lists/${workbook.id}/edit`}>
              <Button variant="secondary">
                <Pencil className="mr-1.5 h-3.5 w-3.5" />
                Edit filters
              </Button>
            </Link>
          )}
        </div>
      </div>

      {activeKeys.length > 0 && viewMode === "list" && !isActivity && (
        <div className="mt-4 flex flex-wrap gap-1.5">
          {activeKeys.map((key) => (
            <Badge key={key} tone="blue">
              {filterLabels[key] ?? key}
            </Badge>
          ))}
        </div>
      )}

      {!isActivity && (
        <div className="mt-4 flex flex-wrap items-center gap-3">
          <SearchParamInput paramName="q" placeholder="Search within this list…" />
        </div>
      )}

      {isActivity && report ? (
        <div className="mt-5">
          <ActivityDashboard report={report} currentUserId={viewer.id} />
        </div>
      ) : viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} compan${result.total === 1 ? "y" : "ies"}`}
          listPane={<CompanySplitList companies={result.rows} selectedId={selected} />}
        >
          {selected ? (
            <CompanyDetail
              id={selected}
              tab={query.tab}
              basePath={`/smart-lists/${workbook.id}`}
              linkParams={splitLinkParams(query, selected)}
            />
          ) : (
            <SplitListEmpty message="Nothing in this list yet. Loosen a filter and it will fill." />
          )}
        </SplitListShell>
      ) : (
        <>
          <div className="mt-4">
            {shape ? (
              <SmartListBoard
                workbookId={workbook.id}
                rows={result.rows.map((r) => ({
                  id: r.id,
                  name: r.name,
                  href: companyPath(r.companySeq),
                  place: [r.locations[0]?.city, r.locations[0]?.state].filter(Boolean).join(", "),
                  ownerName: r.owner?.name ?? null,
                }))}
                properties={shape.properties}
                views={shape.views}
                values={listValues.values}
                pinned={listValues.pinned}
                people={shape.people}
                activeViewId={activeView?.id ?? null}
                canEdit={shape.canEdit}
                canAddRows={shape.canAddRows}
                canPin={!isActivity}
                canMessage={canMessage}
                today={clock.today()}
                ready={shape.ready}
                dashboard={dashboard}
                query={queries}
                canFill={shape.canFill ?? true}
                labels={labels}
                totals={"totals" in result ? (result.totals ?? null) : null}
              />
            ) : (
              <WorkbookResults rows={result.rows} filters={workbook.filters} canMessage={canMessage} />
            )}
          </div>

          {dashboard ? null : wholeList ? (
            result.total > BOARD_ROWS && (
              <p className="mt-3 text-xs text-subtle">
                Showing the first {BOARD_ROWS} of {result.total.toLocaleString("en-IN")} companies. Search within the list, or use the table to page through them all.
              </p>
            )
          ) : (
            <Pagination page={page} pageSize={pageSize} total={result.total} totalPages={totalPages(result.total, pageSize)} pageSizes={PAGE_SIZES} />
          )}
        </>
      )}
    </SplitListPage>
  );
}
