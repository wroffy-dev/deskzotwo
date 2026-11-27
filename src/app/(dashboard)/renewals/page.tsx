import Link from "next/link";
import { formatCurrency } from "@/lib/utils";
import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import { listRenewalsPaged, type RenewalWindow } from "@/actions/renewal";
import { isModuleEnabled } from "@/actions/module";
import { viewerHas } from "@/actions/permission";
import { ClearFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListHeader } from "@/components/ui/list-header";
import { ListFilter, UserRound } from "lucide-react";
import { ColumnPicker } from "@/components/ui/table-columns";
import { SortControl } from "@/components/ui/sort-control";
import { RENEWAL_SORTS } from "@/lib/tables/sort-options";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { RenewalsTable } from "@/components/renewals/renewals-table";
import { withRenewalExtras } from "@/lib/tables/list-extras";
import { viewerReassignControls } from "@/lib/authz/reassign";
import { renewalManagersHere } from "@/lib/companies/renewal-manager";
import { undatedCount } from "@/lib/renewals-undated";
import { unwatchedServiceCount } from "@/lib/renewals-unwatched";
import { RenewalSplitList } from "@/components/renewals/renewal-split-list";
import { CustomerNoticeButton } from "@/components/marketing/customer-notice-button";
import { RenewButton } from "@/components/renewals/renew-button";
import { RenewalProposalButton } from "@/components/renewals/renewal-proposal-button";
import { CallButton } from "@/components/calls/call-button";
import { viewerRenewalActions } from "@/lib/renewal-actions";
// A renewal row IS an order — the subscription and the order it was punched as are one record — so
// the order's detail is the renewal's detail.
import { OrderDetail } from "@/components/orders/order-detail";
import { SplitListShell, SplitListEmpty, SplitListPage, resolveSelected } from "@/components/ui/split-list";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { getViewMode } from "@/actions/view-mode";
import { listAssignableUsers } from "@/actions/company";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";

export default async function RenewalsPage({
  searchParams,
}: {
  searchParams: Promise<{ window?: string; q?: string; manager?: string; sort?: string; dir?: string; page?: string; pageSize?: string; sel?: string }>;
}) {
  const enabled = await isModuleEnabled("renewals");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="renewals" />;
  }

  const params = await searchParams;
  // Open by default — upcoming, or ended in the last 90 days; "all" asks for every one, however long ago (owner, 31 Oct 2026).
  const window: RenewalWindow | undefined =
    params.window === "all"
      ? undefined
      : ["expired", "lapsed", "atrisk", "reminders", "30", "60", "90"].includes(params.window ?? "")
        ? (params.window as RenewalWindow)
        : "open";
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const [viewMode, result, users, can, reassign, managersHere] = await Promise.all([
    getViewMode("renewals"),
    listRenewalsPaged({ window, search: params.q, manager: params.manager, sort: params.sort, dir: params.dir, page, pageSize }),
    listAssignableUsers(),
    // What this person may do to a renewal: only that is offered (owner, 26 Nov 2026 — src/lib/renewal-actions.ts).
    viewerRenewalActions(),
    viewerReassignControls(),
    renewalManagersHere(),
  ]);
  const renewals = result.rows;
  const canTidy = await viewerHas("settings.manage");
  // Running subscriptions nothing can remind anybody about (owner, 11 Nov 2026 — src/lib/renewals-undated.ts).
  const undated = await undatedCount();
  // Services that look as if they renew — an AMC — and aren't watched (owner, 11 Nov 2026 — src/lib/renewals-unwatched-rules.ts).
  // It leads to an Items page, where the answer is given: shown to whoever can open Items.
  const unwatched = (await isModuleEnabled("items")) ? await unwatchedServiceCount() : 0;
  // Orders saved without a price, filled in once (owner, 3 Nov 2026 — src/actions/order-prices.ts).
  const canFillPrices = await viewerHas("products.edit");
  const selected = viewMode === "split" ? resolveSelected(renewals, params.sel) : null;

  const expiredCount = result.expired;

  const selectedRenewal = selected ? renewals.find((r) => r.id === selected) ?? null : null;
  // The workspace's own words (Settings → Wording).
  const wording = await getWording();

  return (
    <SplitListPage active={viewMode === "split"}>
      <ListHeader
        title={slot(wording, "Renewals", "renewal")}
        subtitle={
          <>
            {result.total} subscription(s) with an expiry date{expiredCount > 0 && ` · ${expiredCount} expired`}
            {/* What they renew for in all (owner, 31 Oct 2026) — the Renewal value column's total. */}
            {result.totalValue > 0 && ` · ${formatCurrency(result.totalValue)} to renew`}
          </>
        }
        search={<ToolbarSearch paramName="q" placeholder="Search" label={slot(wording, "Search company name", "company", "Search {one:lower} name")} />}
        filters={
          <>
            <SelectParamFilter
              variant="pill"
              icon={<ListFilter />}
              paramName="window"
              label="Window"
              allLabel="Open"
              options={[
                // Every one, however long ago it ended (the default leaves out what ended over 90 days ago).
                { value: "all", label: "All, ever" },
                { value: "expired", label: "Expired" },
                // Ended, not renewed, and nobody has marked it — to chase, or to call lost (owner, 26 Oct 2026).
                { value: "lapsed", label: "Lapsed — not renewed" },
                // Ending within 30 days and nobody has called, quoted or renewed it (owner, 30 Oct 2026).
                { value: "atrisk", label: "At risk — not started or gone quiet" },
                // The ones this person asked to be reminded about (owner, 31 Oct 2026).
                { value: "reminders", label: "My reminders" },
                { value: "30", label: "Expiring in 30 days" },
                { value: "60", label: "Expiring in 60 days" },
                { value: "90", label: "Expiring in 90 days" },
              ]}
            />
            {/* Whose renewals: the customer's renewal manager, else its account manager (owner, 30 Oct 2026). */}
            <SelectParamFilter
              searchable
              variant="pill"
              icon={<UserRound />}
              paramName="manager"
              label="Renewal manager"
              allLabel="Anyone"
              options={[{ value: "unassigned", label: "Nobody" }, ...users.map((u) => ({ value: u.id, label: u.name }))]}
            />
            <ClearFilters params={["q", "window", "manager"]} />
          </>
        }
        actions={
          <>
            <SortControl options={RENEWAL_SORTS} />
            <ColumnPicker variant="toolbar" tableKey="renewals" />
            <ViewModeToggle viewKey="renewals" mode={viewMode} />
            {/* Shown only while there are some: they're on no list here, and nothing reminds anybody about them. */}
            {undated > 0 && (
              <Link href="/renewals/no-end-date" className="rounded-full border border-warning bg-surface px-3 py-1 text-sm font-medium text-warning transition-colors hover:text-text">
                {undated} with no end date
              </Link>
            )}
            {unwatched > 0 && (
              <Link href="/items/renewing-services" className="rounded-full border border-warning bg-surface px-3 py-1 text-sm font-medium text-warning transition-colors hover:text-text">
                {unwatched} {unwatched === 1 ? "service" : "services"} not watched
              </Link>
            )}
            {/* Renewed, lost and why, by month, product and salesperson (owner, 26 Oct 2026). */}
            <Link href="/renewals/report" className="rounded-full border border-line-strong bg-surface px-3 py-1 text-sm text-muted transition-colors hover:text-text">
              Report
            </Link>
            {/* What could go unbilled: nothing set to bill, held up, drafts waiting (owner, 30 Oct 2026). */}
            <Link href="/renewals/billing" className="rounded-full border border-line-strong bg-surface px-3 py-1 text-sm text-muted transition-colors hover:text-text">
              Billing check
            </Link>
            {/* Old expired subscriptions linked to their renewal or closed (owner, 31 Oct 2026 — src/lib/renewal-tidy.ts). */}
            {canTidy && (
              <Link href="/renewals/tidy" className="rounded-full border border-line-strong bg-surface px-3 py-1 text-sm text-muted transition-colors hover:text-text">
                Clean up old
              </Link>
            )}
            {canFillPrices && (
              <Link href="/orders/missing-prices" className="rounded-full border border-line-strong bg-surface px-3 py-1 text-sm text-muted transition-colors hover:text-text">
                Fill missing prices
              </Link>
            )}
          </>
        }
      />

      {viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} subscription${result.total === 1 ? "" : "s"}`}
          listPane={<RenewalSplitList renewals={renewals} selectedId={selected} />}
        >
          {selected ? (
            <div>
              {/* The same per-row action the table has, for whoever works from the split view. */}
              {selectedRenewal && (
                <div className="mb-3 flex flex-wrap items-center justify-between gap-2 border-b border-line pb-3">
                  <span className="text-xs text-subtle">
                    {selectedRenewal.company.owner?.name
                      ? `Account manager: ${selectedRenewal.company.owner.name}`
                      : slot(wording, "No account manager on this company", "company", "No account manager on this {one:lower}")}
                  </span>
                  <div className="flex items-center gap-1">
                    {can.call && (
                      <CallButton
                        companyId={selectedRenewal.company.id}
                        companyName={selectedRenewal.company.name}
                        companyProductId={selectedRenewal.id}
                        preferContact={selectedRenewal.company.contacts?.[0]}
                        size="icon"
                        variant="ghost"
                      />
                    )}
                    {can.email && (
                      <CustomerNoticeButton
                        companyProductId={selectedRenewal.renewedBy?.id ?? selectedRenewal.id}
                        companyName={(selectedRenewal.endCustomer ?? selectedRenewal.company).name}
                        kind={selectedRenewal.renewedBy ? "RENEWED" : "RENEWAL"}
                      />
                    )}
                    {can.proposal && (
                      <RenewalProposalButton
                        companyProductId={selectedRenewal.id}
                        companyName={(selectedRenewal.endCustomer ?? selectedRenewal.company).name}
                        alreadyRenewed={Boolean(selectedRenewal.renewedBy)}
                      />
                    )}
                    {can.renew && <RenewButton companyProductId={selectedRenewal.id} />}
                  </div>
                </div>
              )}
              {/* Its own call button stands down — the strip above has one, next to the other
                  two things you'd do with a renewal. */}
              <OrderDetail id={selected} showCall={false} />
            </div>
          ) : (
            <SplitListEmpty message="No subscriptions match these filters." />
          )}
        </SplitListShell>
      ) : (
        <>
          <div className="mt-6">
            <RenewalsTable renewals={await withRenewalExtras(renewals)} users={users} can={can} canSetManager={reassign.show && managersHere} totalValue={result.totalValue} />
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
