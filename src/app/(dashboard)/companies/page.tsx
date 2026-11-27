import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import Link from "next/link";
import { listCompaniesPaged, listAssignableUsers } from "@/actions/company";
import { listIndustries } from "@/actions/industry";
import { listCustomerCategories } from "@/actions/customer-category";
import { categoryFilterOptions } from "@/lib/customers/categories";
import { Button } from "@/components/ui/button";
import { CompaniesTable } from "@/components/companies/companies-table";
import { withCompanyExtras } from "@/lib/tables/list-extras";
import { CompanySplitList } from "@/components/companies/company-split-list";
import { CompanyDetail } from "@/components/companies/company-detail";
import { SplitListShell, SplitListEmpty, SplitListPage, resolveSelected, splitLinkParams } from "@/components/ui/split-list";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { getViewMode } from "@/actions/view-mode";
import { ClearFilters, MoreFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListHeader } from "@/components/ui/list-header";
import { Tag, UserRound, Users } from "lucide-react";
import { ColumnPicker } from "@/components/ui/table-columns";
import { SortControl } from "@/components/ui/sort-control";
import { COMPANY_SORTS } from "@/lib/tables/sort-options";
import { viewerHas } from "@/actions/permission";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { companySourceValues } from "@/lib/validation/company";
import type { CompanyStage, CompanySource } from "@prisma/client";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { viewerReassignControls } from "@/lib/authz/reassign";
import { requireUser } from "@/lib/session";
import { listColumns } from "@/lib/custom-fields/server";
import { customFilterParams, customFilterSetup, parseCustomFilters, type CustomFilterParams } from "@/lib/custom-fields/filters";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";

export default async function CompaniesPage({
  searchParams,
}: {
  searchParams: Promise<{
    stage?: string;
    q?: string;
    assignedTo?: string;
    owner?: string;
    source?: string;
    industryId?: string;
    category?: string;
    createdFrom?: string;
    createdTo?: string;
    sort?: string;
    dir?: string;
    page?: string;
    pageSize?: string;
    sel?: string;
    tab?: string;
  } & CustomFilterParams>;
}) {
  if (!(await isModuleEnabled("companies"))) return <ModuleDisabledNotice moduleKey="companies" />;
  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const customFilters = parseCustomFilters(params);
  // This is the raw CLIENT-track sourcing pool, not the customer list (see /customers) — every
  // company here has `hasOrders: false` by definition, so a `stage: "CUSTOMER"` row within it is
  // always a won deal that's still waiting on its first order, never a real paying customer.
  // Vendors/OEMs/distributors/partners/commission parties never appear here — they live in their
  // own modules (`listCompanies` defaults to `relationshipType: "CLIENT"`).
  const [viewMode, result, assignableUsers, industries, categories] = await Promise.all([
    getViewMode("companies"),
    listCompaniesPaged({
      page,
      pageSize,
      stage: params.stage as CompanyStage | undefined,
      // Searching (owner, 30 Oct 2026), every client is looked through — one that has bought is found too, marked
      // "Already a customer" (companies-table.tsx); the Awaiting Order chip keeps its meaning.
      hasOrders: params.q?.trim() && params.stage !== "CUSTOMER" ? undefined : false,
      search: params.q,
      assignedToUserId: params.assignedTo,
      ownerUserId: params.owner,
      source: params.source as CompanySource | undefined,
      industryId: params.industryId,
      categoryId: params.category,
      createdFrom: params.createdFrom,
      createdTo: params.createdTo,
      sort: params.sort,
      dir: params.dir,
      customFilters,
    }),
    listAssignableUsers(),
    listIndustries(),
    listCustomerCategories(),
  ]);

  const selected = viewMode === "split" ? resolveSelected(result.rows, params.sel) : null;
  // The workspace's own fields (src/lib/custom-fields): the columns the table can show — the split view
  // has none, so it asks for no values, but the picker still offers them — and the filter panel.
  const user = await requireUser();
  const [customColumns, fieldFilters] = await Promise.all([
    listColumns("COMPANY", user.id, viewMode === "split" ? [] : result.rows.map((c) => c.id)),
    customFilterSetup("COMPANY", user.id, customFilters),
  ]);

  const w = await getWording();
  const canSeeOrders = await viewerHas("orders.view");
  const stageFilters: { label: string; value?: CompanyStage }[] = [
    { label: "All" },
    { label: "Prospects", value: "PROSPECT" },
    { label: "Leads", value: "LEAD" },
    { label: slot(w, "Awaiting Order", "order", "Awaiting {one}"), value: "CUSTOMER" },
    { label: "Disqualified", value: "DISQUALIFIED" },
  ];

  function queryFor(overrides: Record<string, string | undefined>) {
    const next = {
      // The field filters too, or a stage chip would quietly drop them.
      ...customFilterParams(params),
      stage: params.stage,
      q: params.q,
      assignedTo: params.assignedTo,
      source: params.source,
      industryId: params.industryId,
      category: params.category,
      createdFrom: params.createdFrom,
      createdTo: params.createdTo,
      // The sort too, or a stage chip would put the list back in its default order.
      sort: params.sort,
      dir: params.dir,
      ...overrides,
    };
    return Object.fromEntries(Object.entries(next).filter(([, v]) => v)) as Record<string, string>;
  }

  return (
    <SplitListPage active={viewMode === "split"}>
      <ListHeader
        title={slot(w, "Companies", "company")}
        subtitle={`${result.total} ${result.total === 1 ? slot(w, "company", "company", "{one:lower}") : slot(w, "companies", "company", "{many:lower}")}`}
        search={<ToolbarSearch paramName="q" placeholder="Search" label={slot(w, "Search company name", "company", "Search {one:lower} name")} />}
        filters={
          <>
            <SelectParamFilter variant="pill" icon={<Tag />} paramName="category" label="Category" options={categoryFilterOptions(categories)} />
            <SelectParamFilter searchable
              variant="pill"
              icon={<Users />}
              paramName="assignedTo"
              label="Caller"
              allLabel="Everyone"
              options={[{ value: "unassigned", label: "Unassigned" }, ...assignableUsers.map((u) => ({ value: u.id, label: u.name }))]}
            />
            <SelectParamFilter searchable
              variant="pill"
              icon={<UserRound />}
              paramName="owner"
              label="Account manager"
              allLabel="Anyone"
              options={[{ value: "unassigned", label: "Unassigned" }, ...assignableUsers.map((u) => ({ value: u.id, label: u.name }))]}
            />
            <MoreFilters params={["source", "industryId", ["createdFrom", "createdTo"]]} fields={fieldFilters}>
              <SelectParamFilter variant="stacked" paramName="source" label="Source" options={companySourceValues.map((s) => ({ value: s, label: s }))} />
              <SelectParamFilter variant="stacked" paramName="industryId" label="Industry" options={industries.map((i) => ({ value: i.id, label: i.name }))} />
              <DateRangePicker variant="stacked" fromParam="createdFrom" toParam="createdTo" label="Added on" />
            </MoreFilters>
            <ClearFilters params={["q", "source", "industryId", "category", "assignedTo", "owner", "createdFrom", "createdTo"]} prefixes={[fieldFilters.prefix]} />
          </>
        }
        actions={
          <>
            <SortControl options={COMPANY_SORTS} canSeeOrders={canSeeOrders} />
            <ColumnPicker variant="toolbar" tableKey="companies" customColumns={customColumns.columns} />
            <ViewModeToggle viewKey="companies" mode={viewMode} />
            <Link href="/companies/new">
              <Button size="sm">{slot(w, "New company", "company", "New {one:lower}")}</Button>
            </Link>
          </>
        }
        tabs={
          <>
            {stageFilters.map((f) => (
              <Link
                key={f.label}
                href={{ pathname: "/companies", query: queryFor({ stage: f.value }) }}
                className={`rounded-full px-3 py-1 text-sm ${
                  params.stage === f.value || (!params.stage && !f.value)
                    ? "bg-brand text-brand-contrast"
                    : "bg-surface text-muted border border-line-strong"
                }`}
              >
                {f.label}
              </Link>
            ))}
          </>
        }
      />

      {viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} ${result.total === 1 ? slot(w, "company", "company", "{one:lower}") : slot(w, "companies", "company", "{many:lower}")}`}
          listPane={<CompanySplitList companies={result.rows} selectedId={selected} />}
        >
          {selected ? (
            <CompanyDetail
              id={selected}
              tab={params.tab}
              basePath="/companies"
              linkParams={splitLinkParams(params, selected)}
            />
          ) : (
            <SplitListEmpty message={slot(w, "No companies match these filters.", "company", "No {many:lower} match these filters.")} />
          )}
        </SplitListShell>
      ) : (
        <div className="mt-6">
          <CompaniesTable
            companies={await withCompanyExtras("companies", result.rows)}
            assignableUsers={assignableUsers}
            reassign={await viewerReassignControls()}
            customColumns={customColumns}
            canSeeLeads={await isModuleEnabled("leads")}
          />
          <Pagination
            page={page}
            pageSize={pageSize}
            total={result.total}
            totalPages={totalPages(result.total, pageSize)}
            pageSizes={PAGE_SIZES}
          />
        </div>
      )}
    </SplitListPage>
  );
}
