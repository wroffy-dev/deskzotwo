import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
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
import { ListFilter, UserRound, Users } from "lucide-react";
import { ColumnPicker } from "@/components/ui/table-columns";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import {
  companySourceValues,
  vendorRelationshipTypeValues,
  relationshipTypeLabels,
  vendorStatusValues,
  vendorStatusLabels,
} from "@/lib/validation/company";
import type { CompanySource, VendorStatus } from "@prisma/client";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { viewerReassignControls } from "@/lib/authz/reassign";
import { requireUser } from "@/lib/session";
import { viewerHas } from "@/actions/permission";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { listColumns } from "@/lib/custom-fields/server";
import { customFilterSetup, parseCustomFilters, type CustomFilterParams } from "@/lib/custom-fields/filters";

// Search params reach Prisma's enum filters directly, so anything outside the allowed set is
// dropped rather than passed through: an unknown value would 500 the query, and a relationship
// type this module doesn't own (notably COMMISSION_PARTY) would pull that module's records in here.
function asVendorRelationshipType(value?: string) {
  return vendorRelationshipTypeValues.find((t) => t === value);
}

function asVendorStatus(value?: string) {
  return vendorStatusValues.includes(value as VendorStatus) ? (value as VendorStatus) : undefined;
}

function asCompanySource(value?: string) {
  return companySourceValues.includes(value as CompanySource) ? (value as CompanySource) : undefined;
}

export default async function VendorsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    assignedTo?: string;
    owner?: string;
    source?: string;
    industryId?: string;
    relationshipType?: string;
    vendorStatus?: string;
    createdFrom?: string;
    createdTo?: string;
    page?: string;
    pageSize?: string;
    sel?: string;
    tab?: string;
  } & CustomFilterParams>;
}) {
  const enabled = await isModuleEnabled("vendors");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="vendors" />;
  }

  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const vendorFilters = {
    search: params.q,
    assignedToUserId: params.assignedTo,
    ownerUserId: params.owner,
    source: asCompanySource(params.source),
    industryId: params.industryId,
    relationshipType: asVendorRelationshipType(params.relationshipType),
    vendorStatus: asVendorStatus(params.vendorStatus),
    createdFrom: params.createdFrom,
    createdTo: params.createdTo,
    customFilters: parseCustomFilters(params),
  };
  const [viewMode, result, assignableUsers, industries, onboardingCount] = await Promise.all([
    getViewMode("vendors"),
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
    listColumns("VENDOR", user.id, viewMode === "split" ? [] : result.rows.map((c) => c.id)),
    customFilterSetup("VENDOR", user.id, vendorFilters.customFilters),
  ]);
  const w = await getWording();

  return (
    <SplitListPage active={viewMode === "split"}>
      <ListHeader
        title={slot(w, "Vendors", "vendor")}
        subtitle={
          <>
            {result.total} {result.total === 1 ? slot(w, "vendor", "vendor", "{one:lower}") : slot(w, "vendors", "vendor", "{many:lower}")}
            {onboardingCount > 0 && ` · ${onboardingCount} still onboarding`}
          </>
        }
        search={<ToolbarSearch paramName="q" placeholder="Search" label={slot(w, "Search company name", "company", "Search {one:lower} name")} />}
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
            <SelectParamFilter searchable
              variant="pill"
              icon={<UserRound />}
              paramName="owner"
              label="Account manager"
              allLabel="Anyone"
              options={[{ value: "unassigned", label: "Unassigned" }, ...assignableUsers.map((u) => ({ value: u.id, label: u.name }))]}
            />
            <MoreFilters params={["relationshipType", "source", "industryId", ["createdFrom", "createdTo"]]} fields={fieldFilters}>
              <SelectParamFilter
                variant="stacked"
                paramName="relationshipType"
                label="Type"
                options={vendorRelationshipTypeValues.map((t) => ({
                  value: t,
                  label: relationshipTypeLabels[t],
                }))}
              />
              <SelectParamFilter variant="stacked" paramName="source" label="Source" options={companySourceValues.map((s) => ({ value: s, label: s }))} />
              <SelectParamFilter
                variant="stacked"
                paramName="industryId"
                label="Industry"
                options={industries.map((i) => ({ value: i.id, label: i.name }))}
              />
              <DateRangePicker variant="stacked" fromParam="createdFrom" toParam="createdTo" label="Added on" />
            </MoreFilters>
            <ClearFilters params={["q", "relationshipType", "vendorStatus", "source", "industryId", "assignedTo", "owner", "createdFrom", "createdTo"]} prefixes={[fieldFilters.prefix]} />
          </>
        }
        actions={
          <>
            <ColumnPicker variant="toolbar" tableKey="vendors" customColumns={customColumns.columns} />
            <ViewModeToggle viewKey="vendors" mode={viewMode} />
            {(await viewerHas("companies.changeRole")) && (
              <Link href="/vendors/also-customers">
                <Button size="sm" variant="secondary">Marked as customers</Button>
              </Link>
            )}
            <Link href="/vendors/new">
              <Button size="sm">{slot(w, "New vendor", "vendor", "New {one:lower}")}</Button>
            </Link>
          </>
        }
      />

      {viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} ${result.total === 1 ? slot(w, "vendor", "vendor", "{one:lower}") : slot(w, "vendors", "vendor", "{many:lower}")}`}
          listPane={<CompanySplitList companies={result.rows} selectedId={selected} isVendor={true} />}
        >
          {selected ? (
            <CompanyDetail id={selected} tab={params.tab} basePath="/vendors" linkParams={splitLinkParams(params, selected)} />
          ) : (
            <SplitListEmpty message={slot(w, "No vendors match these filters.", "vendor", "No {many:lower} match these filters.")} />
          )}
        </SplitListShell>
      ) : (
        <div className="mt-6">
          <CompaniesTable
            companies={await withCompanyExtras("vendors", result.rows)}
            assignableUsers={assignableUsers}
            mode="vendors"
            canDeleteVendors={(await viewerHas("vendors.delete")) || (await actingAsSuperAdmin(user.id))}
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
