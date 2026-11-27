import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import { listCustomersPaged, listAssignableUsers } from "@/actions/company";
import { portalStateFor } from "@/lib/portal/state";
import { listIndustries } from "@/actions/industry";
import { listCustomerCategories } from "@/actions/customer-category";
import { categoryFilterOptions } from "@/lib/customers/categories";
import { elsewhereCategoryOptions } from "@/lib/customers/elsewhere-categories";
import { CompaniesTable } from "@/components/companies/companies-table";
import { withCompanyExtras } from "@/lib/tables/list-extras";
import { CompanySplitList } from "@/components/companies/company-split-list";
import { CompanyDetail } from "@/components/companies/company-detail";
import { SplitListShell, SplitListEmpty, SplitListPage, resolveSelected, splitLinkParams } from "@/components/ui/split-list";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { getViewMode } from "@/actions/view-mode";
import { ClearFilters, MoreFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListHeader } from "@/components/ui/list-header";
import Link from "next/link";
import { ListFilter, Medal, UserRound, Users } from "lucide-react";
import { LOYALTY_TIERS, TIER_LABEL } from "@/lib/customers/loyalty-rules";
import { ColumnPicker } from "@/components/ui/table-columns";
import { SortControl } from "@/components/ui/sort-control";
import { COMPANY_SORTS } from "@/lib/tables/sort-options";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { AmountRangeFilter } from "@/components/ui/amount-range-filter";
import { HISTORY_FILTER_PARAMS, type HistoryFilterParams } from "@/lib/customers/history-filters";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { companySourceValues } from "@/lib/validation/company";
import type { CompanySource } from "@prisma/client";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { viewerReassignControls } from "@/lib/authz/reassign";
import { requireUser } from "@/lib/session";
import { viewerHas } from "@/actions/permission";
import { listColumns } from "@/lib/custom-fields/server";
import { customFilterSetup, parseCustomFilters, type CustomFilterParams } from "@/lib/custom-fields/filters";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";

export default async function CustomersPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    assignedTo?: string;
    owner?: string;
    source?: string;
    industryId?: string;
    category?: string;
    createdFrom?: string;
    createdTo?: string;
    standing?: string;
    loyalty?: string;
    elsewhere?: string;
    elsewhereRenewal?: string;
    sort?: string;
    dir?: string;
    page?: string;
    pageSize?: string;
    sel?: string;
    tab?: string;
  } & CustomFilterParams & HistoryFilterParams>;
}) {
  if (!(await isModuleEnabled("companies"))) return <ModuleDisabledNotice moduleKey="companies" />;
  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const customFilters = parseCustomFilters(params);
  const [viewMode, result, assignableUsers, industries, categories, elsewhereCategories] = await Promise.all([
    getViewMode("customers"),
    listCustomersPaged({
      page,
      pageSize,
      search: params.q,
      assignedToUserId: params.assignedTo,
      ownerUserId: params.owner,
      source: params.source as CompanySource | undefined,
      industryId: params.industryId,
      categoryId: params.category,
      createdFrom: params.createdFrom,
      createdTo: params.createdTo,
      standing: params.standing,
      loyalty: params.loyalty,
      elsewhere: params.elsewhere,
      elsewhereRenewal: params.elsewhereRenewal,
      // Its history with us (owner, 17 Nov 2026 — src/lib/customers/history-filters.ts).
      history: Object.fromEntries(HISTORY_FILTER_PARAMS.map((k) => [k, params[k]])) as HistoryFilterParams,
      sort: params.sort,
      dir: params.dir,
      customFilters,
    }),
    listAssignableUsers(),
    listIndustries(),
    listCustomerCategories(),
    elsewhereCategoryOptions(),
  ]);

  /**
   * Portal state for this page of customers, in two queries rather than one per row.
   *
   * Resolved here rather than inside the table because it depends on the global portal settings,
   * which a client component has no business reading.
   */
  const portal = await portalStateFor(result.rows);
  const rows = result.rows.map((c) => ({ ...c, portal: portal.get(c.id) ?? null }));

  const selected = viewMode === "split" ? resolveSelected(rows, params.sel) : null;
  // The workspace's own fields (src/lib/custom-fields): the columns the table can show — the split view
  // has none, so it asks for no values, but the picker still offers them — and the filter panel.
  const user = await requireUser();
  const [customColumns, fieldFilters] = await Promise.all([
    listColumns("COMPANY", user.id, viewMode === "split" ? [] : rows.map((c) => c.id)),
    customFilterSetup("COMPANY", user.id, customFilters),
  ]);
  const w = await getWording();
  const canSeeOrders = await viewerHas("orders.view");

  return (
    <SplitListPage active={viewMode === "split"}>
      <ListHeader
        title={slot(w, "Customer", "customer")}
        search={<ToolbarSearch paramName="q" placeholder="Search" label={slot(w, "Search company name", "company", "Search {one:lower} name")} />}
        filters={
          <>
            {/* Every subscription ended and none renewed — the ones to win back (owner, 26 Oct 2026). */}
            <SelectParamFilter variant="pill" icon={<ListFilter />} paramName="standing" label="Standing" allLabel="Any" options={[{ value: "lapsed", label: "Lapsed customers" }]} />
            {/* The loyalty tier (owner, 31 Oct 2026 — Settings › Customer loyalty). */}
            <SelectParamFilter variant="pill" icon={<Medal />} paramName="loyalty" label="Loyalty" allLabel="Any" options={LOYALTY_TIERS.map((t) => ({ value: t, label: TIER_LABEL[t] }))} />
            <SelectParamFilter searchable
              variant="pill"
              icon={<Users />}
              paramName="assignedTo"
              label="Caller"
              allLabel="Everyone"
              options={[
                { value: "unassigned", label: "Unassigned" },
                ...assignableUsers.map((u) => ({ value: u.id, label: u.name })),
              ]}
            />
            <SelectParamFilter searchable
              variant="pill"
              icon={<UserRound />}
              paramName="owner"
              label="Account manager"
              allLabel="Anyone"
              options={[
                { value: "unassigned", label: "Unassigned" },
                ...assignableUsers.map((u) => ({ value: u.id, label: u.name })),
              ]}
            />
            <MoreFilters
              params={["source", "industryId", "category", ["createdFrom", "createdTo"], ["ltvMin", "ltvMax"], ["l12Min", "l12Max"], "liveOrders", "lastPurchase", "renewalRate", "activity", ["sinceFrom", "sinceTo"], "paysIn"]}
              fields={fieldFilters}
            >
              <SelectParamFilter variant="stacked" paramName="source" label="Source" options={companySourceValues.map((s) => ({ value: s, label: s }))} />
              <SelectParamFilter
                variant="stacked"
                paramName="industryId"
                label="Industry"
                options={industries.map((i) => ({ value: i.id, label: i.name }))}
              />
              <SelectParamFilter variant="stacked" paramName="category" label="Category" options={categoryFilterOptions(categories)} />
              {/* What they use that they bought elsewhere (owner, 6 Nov 2026), and when it comes up to win. */}
              <SelectParamFilter variant="stacked" paramName="elsewhere" label="Uses elsewhere" options={[{ value: "any", label: "Anything" }, ...elsewhereCategories.map((c) => ({ value: c.key, label: c.name }))]} />
              <SelectParamFilter variant="stacked" paramName="elsewhereRenewal" label="Outside renewal within" options={[{ value: "30", label: "30 days" }, { value: "90", label: "90 days" }, { value: "180", label: "6 months" }, { value: "365", label: "12 months" }]} />
              <DateRangePicker variant="stacked" fromParam="createdFrom" toParam="createdTo" label="Added on" />
              {/* Their history with us, as the columns read (owner, 17 Nov 2026 — src/lib/customers/history-filters.ts). */}
              <AmountRangeFilter label="Lifetime value" minParam="ltvMin" maxParam="ltvMax" />
              <AmountRangeFilter label="Last 12 months" minParam="l12Min" maxParam="l12Max" />
              <SelectParamFilter variant="stacked" paramName="liveOrders" label="Orders (live)" options={[{ value: "live", label: "With a live subscription" }, { value: "none", label: "No live subscription" }, { value: "five", label: "5 or more orders" }, { value: "one", label: "One order only" }]} />
              <SelectParamFilter
                variant="stacked"
                paramName="lastPurchase"
                label="Last purchase"
                options={[
                  { value: "30", label: "In the last 30 days" },
                  { value: "90", label: "In the last 90 days" },
                  { value: "180", label: "In the last 6 months" },
                  { value: "365", label: "In the last 12 months" },
                  { value: "over180", label: "None in 6 months" },
                  { value: "over365", label: "None in 12 months" },
                  { value: "never", label: "Never" },
                ]}
              />
              <SelectParamFilter variant="stacked" paramName="renewalRate" label="Renewal rate" options={[{ value: "high", label: "80% and above" }, { value: "mid", label: "50–79%" }, { value: "low", label: "Below 50%" }, { value: "none", label: "None due yet" }]} />
              <SelectParamFilter
                variant="stacked"
                paramName="activity"
                label="Last activity"
                options={[
                  { value: "7", label: "In the last 7 days" },
                  { value: "30", label: "In the last 30 days" },
                  { value: "90", label: "In the last 90 days" },
                  { value: "none30", label: "None in 30 days" },
                  { value: "none90", label: "None in 90 days" },
                  { value: "none180", label: "None in 6 months" },
                ]}
              />
              <DateRangePicker variant="stacked" fromParam="sinceFrom" toParam="sinceTo" label="Customer since" />
              <SelectParamFilter variant="stacked" paramName="paysIn" label="Pays in" options={[{ value: "30", label: "Within 30 days" }, { value: "60", label: "31–60 days" }, { value: "slow", label: "Over 60 days" }, { value: "overdue", label: "Has something overdue" }]} />
            </MoreFilters>
            <ClearFilters params={["q", "source", "industryId", "category", "standing", "loyalty", "elsewhere", "elsewhereRenewal", "assignedTo", "owner", "createdFrom", "createdTo", ...HISTORY_FILTER_PARAMS]} prefixes={[fieldFilters.prefix]} />
          </>
        }
        actions={
          <>
            {/* What customers use from other sellers, across every customer (owner, 2 Nov 2026). */}
            <Link href="/customers/elsewhere" className="inline-flex items-center rounded-base border border-line px-3 py-1.5 text-sm text-text transition-colors hover:border-brand hover:text-brand">
              Installed elsewhere
            </Link>
            <SortControl options={COMPANY_SORTS} canSeeOrders={canSeeOrders} />
            <ColumnPicker variant="toolbar" tableKey="customers" customColumns={customColumns.columns} />
            <ViewModeToggle viewKey="customers" mode={viewMode} />
          </>
        }
      />
      <p className="mt-1 text-sm text-muted">
        {result.total} {result.total === 1 ? "company has" : "companies have"} actually purchased from us — at least one order
        on file, active or expired.
      </p>

      {viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} ${result.total === 1 ? slot(w, "customer", "customer", "{one:lower}") : slot(w, "customers", "customer", "{many:lower}")}`}
          listPane={<CompanySplitList companies={rows} selectedId={selected} isVendor={false} />}
        >
          {selected ? (
            <CompanyDetail id={selected} tab={params.tab} basePath="/customers" linkParams={splitLinkParams(params, selected)} />
          ) : (
            <SplitListEmpty message={slot(w, "No customers match these filters.", "customer", "No {many:lower} match these filters.")} />
          )}
        </SplitListShell>
      ) : (
        <div className="mt-6">
          <CompaniesTable
            companies={await withCompanyExtras("customers", rows)}
            assignableUsers={assignableUsers}
            mode="customers"
            reassign={await viewerReassignControls()}
            customColumns={customColumns}
            canSeeOrders={canSeeOrders}
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
