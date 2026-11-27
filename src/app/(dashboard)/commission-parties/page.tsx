import Link from "next/link";
import { listVendorsPaged, countVendorsOnboarding, listAssignableUsers } from "@/actions/company";
import { listIndustries } from "@/actions/industry";
import { isModuleEnabled } from "@/actions/module";
import { Button } from "@/components/ui/button";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { CompaniesTable } from "@/components/companies/companies-table";
import { withCompanyExtras } from "@/lib/tables/list-extras";
import { CompanySplitList } from "@/components/companies/company-split-list";
import { CompanyDetail } from "@/components/companies/company-detail";
import { SplitListShell, SplitListEmpty, SplitListPage, resolveSelected, splitLinkParams } from "@/components/ui/split-list";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { getViewMode } from "@/actions/view-mode";
import { ClearFilters, MoreFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListHeader } from "@/components/ui/list-header";
import { ListFilter, Users } from "lucide-react";
import { ColumnPicker } from "@/components/ui/table-columns";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { companySourceValues, vendorStatusValues, vendorStatusLabels } from "@/lib/validation/company";
import type { CompanySource, VendorStatus } from "@prisma/client";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { viewerReassignControls } from "@/lib/authz/reassign";
import { requireUser } from "@/lib/session";
import { listColumns } from "@/lib/custom-fields/server";
import { customFilterSetup, parseCustomFilters, type CustomFilterParams } from "@/lib/custom-fields/filters";

// Search params reach Prisma's enum filters directly, so anything unrecognised is dropped rather
// than passed through — an unknown value would otherwise fail the query and 500 the page.
function asVendorStatus(value?: string) {
  return vendorStatusValues.includes(value as VendorStatus) ? (value as VendorStatus) : undefined;
}

function asCompanySource(value?: string) {
  return companySourceValues.includes(value as CompanySource) ? (value as CompanySource) : undefined;
}

export default async function CommissionPartiesPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    assignedTo?: string;
    source?: string;
    industryId?: string;
    vendorStatus?: string;
    createdFrom?: string;
    createdTo?: string;
    page?: string;
    pageSize?: string;
    sel?: string;
    tab?: string;
  } & CustomFilterParams>;
}) {
  const enabled = await isModuleEnabled("commission_parties");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="commission_parties" />;
  }

  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const vendorFilters = {
    relationshipType: "COMMISSION_PARTY" as const,
    search: params.q,
    assignedToUserId: params.assignedTo,
    source: asCompanySource(params.source),
    industryId: params.industryId,
    vendorStatus: asVendorStatus(params.vendorStatus),
    createdFrom: params.createdFrom,
    createdTo: params.createdTo,
    customFilters: parseCustomFilters(params),
  };
  const [viewMode, result, assignableUsers, industries, onboardingCount] = await Promise.all([
    getViewMode("commission-parties"),
    listVendorsPaged({ page, pageSize, ...vendorFilters }),
    listAssignableUsers(),
    listIndustries(),
    countVendorsOnboarding(vendorFilters),
  ]);

  const selected = viewMode === "split" ? resolveSelected(result.rows, params.sel) : null;
  // The workspace's own fields (src/lib/custom-fields): the columns the table can show — the split view
  // has none, so it asks for no values, but the picker still offers them — and the filter panel.
  const user = await requireUser();
  const [customColumns, fieldFilters] = await Promise.all([
    listColumns("COMPANY", user.id, viewMode === "split" ? [] : result.rows.map((c) => c.id)),
    customFilterSetup("COMPANY", user.id, vendorFilters.customFilters),
  ]);

  return (
    <SplitListPage active={viewMode === "split"}>
      <ListHeader
        title="Commission Parties"
        subtitle={
          <>
            {result.total} {result.total === 1 ? "commission party" : "commission parties"}
            {onboardingCount > 0 && ` · ${onboardingCount} still onboarding`}
          </>
        }
        search={<ToolbarSearch paramName="q" placeholder="Search" label="Search company/agent name" />}
        filters={
          <>
            <SelectParamFilter
              variant="pill"
              icon={<ListFilter />}
              paramName="vendorStatus"
              label="Status"
              options={vendorStatusValues.map((s) => ({
                value: s,
                label: vendorStatusLabels[s],
              }))}
            />
            <SelectParamFilter searchable
              variant="pill"
              icon={<Users />}
              paramName="assignedTo"
              label="Assigned to"
              allLabel="Everyone"
              options={[
                { value: "unassigned", label: "Unassigned" },
                ...assignableUsers.map((u) => ({ value: u.id, label: u.name })),
              ]}
            />
            <MoreFilters params={["source", "industryId", ["createdFrom", "createdTo"]]} fields={fieldFilters}>
              <SelectParamFilter variant="stacked" paramName="source" label="Source" options={companySourceValues.map((s) => ({ value: s, label: s }))} />
              <SelectParamFilter
                variant="stacked"
                paramName="industryId"
                label="Industry"
                options={industries.map((i) => ({ value: i.id, label: i.name }))}
              />
              <DateRangePicker variant="stacked" fromParam="createdFrom" toParam="createdTo" label="Added on" />
            </MoreFilters>
            <ClearFilters params={["q", "vendorStatus", "source", "industryId", "assignedTo", "createdFrom", "createdTo"]} prefixes={[fieldFilters.prefix]} />
          </>
        }
        actions={
          <>
            <ColumnPicker variant="toolbar" tableKey="commission-parties" customColumns={customColumns.columns} />
            <ViewModeToggle viewKey="commission-parties" mode={viewMode} />
            <Link href="/commission-parties/new">
              <Button size="sm">New commission party</Button>
            </Link>
          </>
        }
      />

      {viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} commission part${result.total === 1 ? "y" : "ies"}`}
          listPane={<CompanySplitList companies={result.rows} selectedId={selected} isVendor={true} />}
        >
          {selected ? (
            <CompanyDetail
              id={selected}
              tab={params.tab}
              basePath="/commission-parties"
              linkParams={splitLinkParams(params, selected)}
            />
          ) : (
            <SplitListEmpty message="No commission parties match these filters." />
          )}
        </SplitListShell>
      ) : (
        <div className="mt-6">
          <CompaniesTable
            companies={await withCompanyExtras("commission-parties", result.rows)}
            assignableUsers={assignableUsers}
            mode="commission-parties"
            reassign={await viewerReassignControls()}
            customColumns={customColumns}
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
