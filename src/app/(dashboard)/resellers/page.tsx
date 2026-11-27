import Link from "next/link";
import { listResellersPaged, listAssignableUsers } from "@/actions/company";
import { listIndustries } from "@/actions/industry";
import { isModuleEnabled } from "@/actions/module";
import { Button } from "@/components/ui/button";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ClearFilters, MoreFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListHeader } from "@/components/ui/list-header";
import { Database, UserRound, Users } from "lucide-react";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { ResellersTable } from "@/components/resellers/resellers-table";
import { ColumnPicker } from "@/components/ui/table-columns";
import { withCompanyExtras } from "@/lib/tables/list-extras";
import { ResellerSplitList } from "@/components/resellers/reseller-split-list";
import { CompanyDetail } from "@/components/companies/company-detail";
import { SplitListShell, SplitListEmpty, SplitListPage, resolveSelected, splitLinkParams } from "@/components/ui/split-list";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { getViewMode } from "@/actions/view-mode";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { companySourceValues } from "@/lib/validation/company";
import { requireUser } from "@/lib/session";
import { customFilterSetup, parseCustomFilters, type CustomFilterParams } from "@/lib/custom-fields/filters";
import type { CompanySource } from "@prisma/client";

function asCompanySource(value?: string) {
  return companySourceValues.includes(value as CompanySource) ? (value as CompanySource) : undefined;
}

export default async function ResellersPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    assignedTo?: string;
    owner?: string;
    source?: string;
    industryId?: string;
    createdFrom?: string;
    createdTo?: string;
    page?: string;
    pageSize?: string;
    sel?: string;
    tab?: string;
  } & CustomFilterParams>;
}) {
  const enabled = await isModuleEnabled("resellers");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="resellers" />;
  }

  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const customFilters = parseCustomFilters(params);
  const [viewMode, result, assignableUsers, industries] = await Promise.all([
    getViewMode("resellers"),
    listResellersPaged({
      page,
      pageSize,
      search: params.q,
      assignedToUserId: params.assignedTo,
      ownerUserId: params.owner,
      source: asCompanySource(params.source),
      industryId: params.industryId,
      createdFrom: params.createdFrom,
      createdTo: params.createdTo,
      customFilters,
    }),
    listAssignableUsers(),
    listIndustries(),
  ]);

  const endCustomerTotal = result.endCustomerTotal;
  // The workspace's own company fields, for the filter panel (src/lib/custom-fields/filters.ts).
  const fieldFilters = await customFilterSetup("COMPANY", (await requireUser()).id, customFilters);
  const selected = viewMode === "split" ? resolveSelected(result.rows, params.sel) : null;

  return (
    <SplitListPage active={viewMode === "split"}>
      <ListHeader
        title="Resellers"
        subtitle={`${result.total} ${result.total === 1 ? "reseller" : "resellers"} · ${endCustomerTotal} end ${endCustomerTotal === 1 ? "customer" : "customers"}`}
        search={<ToolbarSearch paramName="q" placeholder="Search" label="Search reseller name" />}
        filters={
          <>
            <SelectParamFilter
              variant="pill"
              icon={<Database />}
              paramName="source"
              label="Source"
              options={companySourceValues.map((s) => ({ value: s, label: s }))}
            />
            <SelectParamFilter searchable
              variant="pill"
              icon={<Users />}
              paramName="assignedTo"
              label="Caller"
              allLabel="Everyone"
              options={[{ value: "unassigned", label: "Unassigned" }, ...assignableUsers.map((u) => ({ value: u.id, label: u.name }))]}
            />
            {/* The reseller's account manager (owner, 30 Oct 2026); the pill before it, labelled so, was the caller. */}
            <SelectParamFilter searchable
              variant="pill"
              icon={<UserRound />}
              paramName="owner"
              label="Account manager"
              allLabel="Anyone"
              options={[{ value: "unassigned", label: "Unassigned" }, ...assignableUsers.map((u) => ({ value: u.id, label: u.name }))]}
            />
            <MoreFilters params={["industryId", ["createdFrom", "createdTo"]]} fields={fieldFilters}>
              <SelectParamFilter
                variant="stacked"
                paramName="industryId"
                label="Industry"
                options={industries.map((i) => ({ value: i.id, label: i.name }))}
              />
              <DateRangePicker variant="stacked" fromParam="createdFrom" toParam="createdTo" label="Added on" />
            </MoreFilters>
            <ClearFilters params={["q", "source", "industryId", "assignedTo", "owner", "createdFrom", "createdTo"]} prefixes={[fieldFilters.prefix]} />
          </>
        }
        actions={
          <>
            <ColumnPicker variant="toolbar" tableKey="resellers" />
            <ViewModeToggle viewKey="resellers" mode={viewMode} />
            <Link href="/resellers/new">
              <Button size="sm">New reseller</Button>
            </Link>
          </>
        }
      />

      {viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} reseller${result.total === 1 ? "" : "s"}`}
          listPane={<ResellerSplitList resellers={result.rows} selectedId={selected} />}
        >
          {selected ? (
            <CompanyDetail
              id={selected}
              tab={params.tab}
              basePath="/resellers"
              linkParams={splitLinkParams(params, selected)}
            />
          ) : (
            <SplitListEmpty message="No resellers match these filters." />
          )}
        </SplitListShell>
      ) : (
        <>
          <div className="mt-6">
            <ResellersTable resellers={await withCompanyExtras("resellers", result.rows)} />
          </div>

          <Pagination
            page={page}
            pageSize={pageSize}
            total={result.total}
            totalPages={totalPages(result.total, pageSize)}
            pageSizes={PAGE_SIZES}
          />
        </>
      )}
    </SplitListPage>
  );
}
