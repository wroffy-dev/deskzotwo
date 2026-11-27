import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import Link from "next/link";
import { notFound } from "next/navigation";
import { listLeadBoard, listLeadsPaged } from "@/actions/lead";
import { companiesOutOfReach } from "@/lib/companies/out-of-reach";
import { listAssignableUsers } from "@/actions/company";
import { waitingEnquiries } from "@/actions/website-enquiries";
import { apolloSetup } from "@/lib/apollo/server";
import { Button } from "@/components/ui/button";
import { ViewToggle } from "@/components/leads/view-toggle";
import { LeadsBoard } from "@/components/leads/leads-board";
import { LeadsListTable } from "@/components/leads/leads-list-table";
import { withLeadExtras } from "@/lib/tables/list-extras";
import { myLeadRemindersFor } from "@/lib/lead-reminders";
import { LeadSplitList } from "@/components/leads/lead-split-list";
import { LeadDetail } from "@/components/leads/lead-detail";
import { SplitListShell, SplitListEmpty, SplitListPage, resolveSelected } from "@/components/ui/split-list";
import { getViewMode } from "@/actions/view-mode";
import { ExportLeadsButton } from "@/components/leads/export-leads-button";
import { ColumnPicker } from "@/components/ui/table-columns";
import { SortControl } from "@/components/ui/sort-control";
import { LEAD_SORTS } from "@/lib/tables/sort-options";
import { ClearFilters, MoreFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListHeader } from "@/components/ui/list-header";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { leadStages, stagesOfLeads } from "@/lib/pipeline/server";
import type { LeadSource, LeadStatus } from "@prisma/client";
import { LEAD_SOURCE_LABELS, LEAD_SOURCE_VALUES } from "@/lib/leads/source";
import { viewerReassignControls } from "@/lib/authz/reassign";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { listColumns } from "@/lib/custom-fields/server";
import { customFilterParams, customFilterSetup, parseCustomFilters, type CustomFilterParams } from "@/lib/custom-fields/filters";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { isQuoteFilter, QUOTE_FILTERS } from "@/lib/leads/quotes";
import { leadQuotes, seesLeadQuotes } from "@/lib/leads/quote-status";
import { ListFilter, Users } from "lucide-react";
import { nurtureConfig } from "@/lib/nurture/server";
import { copilotConfig } from "@/lib/copilot/settings";
import { teammate } from "@/lib/ai/teammates-server";

/**
 * Every filter the lead pipeline writes to the URL — what "Clear all" clears. Not the view, the pipeline,
 * the page size or the lead open in the split view. `status` has no control of its own here (links from
 * elsewhere set it), but it narrows the list, so clearing everything clears it too.
 */
const LEAD_FILTER_PARAMS = ["q", "stage", "owner", "am", "source", "grade", "quote", "closeFrom", "closeTo", "status"] as const;

/** The board sorts each column by the lead's own fields; what is worked out from other records only the list ranks. */
const BOARD_SORTS = LEAD_SORTS.filter((o) => o.key !== "lastActivity" && o.key !== "nextFollowUp" && o.key !== "stageChanged");

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<{
    view?: string;
    sel?: string;
    status?: string;
    stage?: string;
    /** The team pipeline shown, by its key; the first in use when not given (src/lib/pipeline). */
    pipeline?: string;
    q?: string;
    owner?: string;
    /** The account manager of the lead's company. */
    am?: string;
    closeFrom?: string;
    closeTo?: string;
    source?: string;
    grade?: string;
    /** Has had a quotation sent, hasn't, or is missing one (src/lib/leads/quotes.ts). */
    quote?: string;
    sort?: string;
    dir?: string;
    page?: string;
    pageSize?: string;
  } & CustomFilterParams>;
}) {
  if (!(await isModuleEnabled("leads"))) return <ModuleDisabledNotice moduleKey="leads" />;
  const user = await requireUser();
  if (!(await hasEffectivePermission(user.id, "leads.view"))) notFound();
  const mayCreate = await hasEffectivePermission(user.id, "leads.create");
  // Ved's lookalikes (owner, 22 Nov 2026 — src/lib/prospects): for whoever may add leads and spend Apollo credits.
  const lookalikes = mayCreate && (await hasEffectivePermission(user.id, "companies.enrich")) && (await apolloSetup()).connected;

  const params = await searchParams;
  // The list unless the board is asked for (owner, 2 Nov 2026: "default lead menu should open list view only").
  const view = params.view === "board" ? "board" : "list";

  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  // One team pipeline at a time (owner, 14 Oct 2026): the board's columns are its stages. The first in
  // use — the main one, unless reordered — when none is asked for, or one no longer in use is.
  const pipelineData = await leadStages();
  const inUse = pipelineData.pipelines.filter((p) => !p.archived);
  const shown = inUse.find((p) => p.key === params.pipeline) ?? inUse[0] ?? pipelineData.pipelines[0]!;
  // Each lead's quotation (owner, 19 Oct 2026): a column, a filter and a card's badge — in a sales
  // pipeline, for somebody who may see sales documents.
  const quotesShown = shown.sales && (await seesLeadQuotes(user.id));
  const filters = {
    status: params.status as LeadStatus | undefined,
    stage: params.stage || undefined,
    pipeline: shown.key,
    search: params.q,
    ownerUserId: params.owner,
    accountManagerId: params.am,
    closeFrom: params.closeFrom,
    closeTo: params.closeTo,
    source: (LEAD_SOURCE_VALUES as readonly string[]).includes(params.source ?? "") ? (params.source as LeadSource) : undefined,
    grade: (["HOT", "WARM", "COLD"] as const).find((g) => g === params.grade),
    quote: quotesShown && isQuoteFilter(params.quote) ? params.quote : undefined,
    sort: params.sort,
    dir: params.dir,
    customFilters: parseCustomFilters(params),
  };

  // The list is paged; the board shows each column's first cards with its whole count, and "Show more"
  // (src/actions/lead.ts `listLeadBoard`) — every lead at once can't be drawn in a large workspace.
  const [viewMode, listed, board, assignableUsers] = await Promise.all([
    getViewMode("leads"),
    view === "list" ? listLeadsPaged({ ...filters, page, pageSize }) : null,
    view === "board" ? listLeadBoard(filters) : null,
    listAssignableUsers(),
  ]);
  const total = listed?.total ?? board?.total ?? 0;

  // Prisma's Decimal is a class instance, not plain data — it can't cross the
  // Server → Client Component boundary as a prop, so serialize it to a string here.
  // The workspace's own stages (Settings → Pipeline, src/lib/pipeline): the board's columns, the filter's
  // choices, and the one each lead shows.
  const listRows = listed?.rows ?? [];
  const stageOf = await stagesOfLeads(listRows);
  const activeStages = pipelineData.stages.filter((s) => !s.archived && s.pipelineId === shown.id);
  const pipelineNames = new Map(pipelineData.pipelines.map((p) => [p.id, p.name]));
  // What the optional columns need beyond the list's query, only where shown (src/lib/tables/list-extras.ts).
  // This person's own "Remind me" on each lead of the page (owner, 31 Oct 2026).
  const myReminders = await myLeadRemindersFor(user.id, listRows.map((l) => l.id));
  const leads = await withLeadExtras(
    listRows.map((lead) => ({
      ...lead,
      estimatedValue: lead.estimatedValue?.toString() ?? null,
      stage: stageOf.get(lead.id)!,
      pipelineName: pipelineNames.get(stageOf.get(lead.id)!.pipelineId) ?? null,
      myReminder: myReminders.get(lead.id) ?? null,
    })),
  );

  const selected = view === "list" && viewMode === "split" ? resolveSelected(leads, params.sel) : null;
  // The split list has no column for it.
  const quotes = quotesShown && view === "list" && viewMode !== "split" ? await leadQuotes(user.id, listRows.map((l) => l.id)) : null;

  // The workspace's own fields (src/lib/custom-fields): the columns the table can show — only the table
  // shows them, so neither the board nor the split list asks for values, though the picker still offers
  // them — and the filter panel, which narrows the board as well.
  const [customColumns, fieldFilters] = await Promise.all([
    listColumns("LEAD", user.id, view === "list" && viewMode !== "split" ? leads.map((l) => l.id) : []),
    customFilterSetup("LEAD", user.id, filters.customFilters),
  ]);
  // The workspace's own words (Settings → Wording, src/lib/terms).
  const w = await getWording();
  const waiting = await waitingEnquiries().catch(() => 0);

  return (
    <SplitListPage active={view === "list" && viewMode === "split"}>
      {/*
        One header row (owner, 29 Oct 2026; src/components/ui/list-header.tsx): search, Stage and Owner, the
        rest behind More, then Columns, the views, Export and New lead. Each filter writes the same URL
        parameter it always has, so the board, the table and the split list read the same choice.
      */}
      <ListHeader
        title={slot(w, "Lead pipeline", "lead", "{one} pipeline")}
        subtitle={inUse.length > 1 ? `${total} in ${shown.name}` : `${total} ${slot(w, "total leads", "lead", "total {many:lower}")}`}
        search={<ToolbarSearch paramName="q" placeholder="Search" label={slot(w, "Search title or company", "company", "Search title or {one:lower}")} />}
        filters={
          <>
            <SelectParamFilter variant="pill" icon={<ListFilter />} paramName="stage" label="Stage" options={activeStages.map((s) => ({ value: s.key, label: s.label }))} />
            <SelectParamFilter searchable
              variant="pill"
              icon={<Users />}
              paramName="owner"
              label="Owner"
              allLabel="Everyone"
              options={[{ value: "unassigned", label: "Unassigned" }, ...assignableUsers.map((u) => ({ value: u.id, label: u.name }))]}
            />
            <MoreFilters params={["am", "source", "grade", ...(quotesShown ? ["quote"] : []), ["closeFrom", "closeTo"]]} fields={fieldFilters}>
              {/* Whose account the lead is on (owner, 30 Oct 2026) — the company's account manager, not the lead's owner. */}
              <SelectParamFilter
                variant="stacked"
                paramName="am"
                label="Account manager"
                allLabel="Anyone"
                options={[{ value: "unassigned", label: "Unassigned" }, ...assignableUsers.map((u) => ({ value: u.id, label: u.name }))]}
              />
              <SelectParamFilter variant="stacked" paramName="source" label="Source" options={LEAD_SOURCE_VALUES.map((s) => ({ value: s, label: LEAD_SOURCE_LABELS[s] }))} />
              <SelectParamFilter
                variant="stacked"
                paramName="grade"
                label="Score"
                allLabel="Any"
                options={[
                  { value: "HOT", label: "Hot (70+)" },
                  { value: "WARM", label: "Warm (40–69)" },
                  { value: "COLD", label: "Cold (under 40)" },
                ]}
              />
              {quotesShown && (
                <SelectParamFilter variant="stacked" paramName="quote" label="Quotation" allLabel="Any" options={QUOTE_FILTERS.map((f) => ({ value: f.value, label: f.label }))} />
              )}
              <DateRangePicker variant="stacked" fromParam="closeFrom" toParam="closeTo" label="Expected close" />
            </MoreFilters>
            <ClearFilters params={LEAD_FILTER_PARAMS} prefixes={[fieldFilters.prefix]} />
          </>
        }
        actions={
          <>
            <SortControl options={view === "board" ? BOARD_SORTS : LEAD_SORTS} />
            <ColumnPicker variant="toolbar" tableKey="leads" customColumns={customColumns.columns} />
            <ViewToggle
              view={view}
              mode={viewMode}
              otherParams={{
                ...customFilterParams(params),
                status: params.status,
                stage: params.stage,
                pipeline: params.pipeline,
                q: params.q,
                owner: params.owner,
                am: params.am,
                closeFrom: params.closeFrom,
                closeTo: params.closeTo,
                source: params.source,
                grade: params.grade,
                quote: params.quote,
                sort: params.sort,
                dir: params.dir,
              }}
            />
            <ExportLeadsButton />
            {lookalikes && (
              <Link href="/leads/lookalikes">
                <Button size="sm" variant="secondary">Find lookalikes</Button>
              </Link>
            )}
            {waiting > 0 && (
              // Website enquiries held for review (src/lib/lead-capture/review.ts), for whoever decides them.
              <Link href="/leads/enquiries">
                <Button size="sm" variant="secondary">{waiting} website {waiting === 1 ? "enquiry" : "enquiries"} to review</Button>
              </Link>
            )}
            {mayCreate && (
              <Link href={inUse.length > 1 ? `/leads/new?pipeline=${encodeURIComponent(shown.key)}` : "/leads/new"}>
                <Button size="sm">{slot(w, "New lead", "lead", "New {one:lower}")}</Button>
              </Link>
            )}
          </>
        }
      />

      {inUse.length > 1 && (
        <nav aria-label="Pipelines" className="mt-4 flex flex-wrap items-center gap-2">
          {inUse.map((p) => (
            <Link
              key={p.id}
              href={`/leads?pipeline=${encodeURIComponent(p.key)}${view === "board" ? "&view=board" : ""}`}
              aria-current={p.id === shown.id ? "page" : undefined}
              className={`rounded-full border px-3 py-1 text-sm ${p.id === shown.id ? "border-brand bg-brand-subtle font-medium text-brand" : "border-line text-muted hover:text-text"}`}
            >
              {p.name}
            </Link>
          ))}
        </nav>
      )}

      {view === "list" && viewMode === "split" ? (
        <SplitListShell
          countLabel={`${total} ${total === 1 ? slot(w, "lead", "lead", "{one:lower}") : slot(w, "leads", "lead", "{many:lower}")}`}
          listPane={<LeadSplitList leads={leads} selectedId={selected} />}
        >
          {selected ? <LeadDetail id={selected} /> : <SplitListEmpty message={slot(w, "No leads match these filters.", "lead", "No {many:lower} match these filters.")} />}
        </SplitListShell>
      ) : (
        <div className="mt-6">
          {view === "list" ? (
            <>
              <LeadsListTable
                leads={leads}
                stages={activeStages}
                assignableUsers={assignableUsers}
                reassign={await viewerReassignControls()}
                nurture={await bulkNurture(user.id)}
                customColumns={customColumns}
                contactDetails={listed?.contactDetails ?? false}
                quotes={quotes}
                shutCompanies={await companiesOutOfReach(user.id, leads.map((l) => l.company.id))}
              />
              <Pagination
                page={page}
                pageSize={pageSize}
                total={total}
                totalPages={totalPages(total, pageSize)}
                pageSizes={PAGE_SIZES}
              />
            </>
          ) : (
            board && <LeadsBoard leads={board.cards} counts={board.counts} stages={activeStages} extras={board.extras} quotes={board.quotes} filters={filters} />
          )}
        </div>
      )}
    </SplitListPage>
  );
}

/**
 * Whether the bulk bar offers nurturing the chosen leads (src/lib/nurture, phase 4): switched on for the workspace,
 * Deskzo AI on, and this person may use it. Their teammate's name for the button.
 */
async function bulkNurture(userId: string): Promise<{ name: string } | null> {
  const [config, ai, mayUse] = await Promise.all([nurtureConfig().catch(() => null), copilotConfig(), hasEffectivePermission(userId, "copilot.use")]);
  if (!config?.enabled || !ai.enabled || !mayUse) return null;
  return { name: (await teammate("tara")).name };
}
