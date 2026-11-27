import { getWording } from "@/lib/terms/server";
import { slot, statusSlot } from "@/lib/terms/dictionary";
import Link from "next/link";
import { listOrdersPaged } from "@/actions/order";
import { isModuleEnabled } from "@/actions/module";
import { Button } from "@/components/ui/button";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { OrdersTable } from "@/components/orders/orders-table";
import { withOrderExtras } from "@/lib/tables/list-extras";
import { orderSteps, stepsOfOrders } from "@/lib/pipeline/order-steps-server";
import { stepStatusLabel } from "@/lib/pipeline/order-steps";
import { OrderSplitList } from "@/components/orders/order-split-list";
import { OrderDetail } from "@/components/orders/order-detail";
import { SplitListShell, SplitListEmpty, SplitListPage, resolveSelected } from "@/components/ui/split-list";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { getViewMode } from "@/actions/view-mode";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { ClearFilters, MoreFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListHeader } from "@/components/ui/list-header";
import { Database, ListFilter } from "lucide-react";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { ColumnPicker } from "@/components/ui/table-columns";
import { orderStatusValues, orderBusinessTypeValues, orderBusinessTypeLabels } from "@/lib/validation/order";
import { requireUser } from "@/lib/session";
import { viewerHas } from "@/actions/permission";
import { listColumns } from "@/lib/custom-fields/server";
import { customFilterParams, customFilterSetup, parseCustomFilters, type CustomFilterParams } from "@/lib/custom-fields/filters";
import type { OrderStatus, OrderBusinessType } from "@prisma/client";
import { listOrdersToInvoice } from "@/actions/order-billing";
import { OrdersToInvoice } from "@/components/orders/orders-to-invoice";
import { moduleAccessFor } from "@/lib/modules-access";
import { can } from "@/lib/authz/resolve";
import { viewAsContext } from "@/lib/session";

const HANDOFF_FLAGS = [
  { value: "held", label: "In hand" },
  { value: "ready", label: "Ready for purchase" },
  { value: "review", label: "Price to approve" },
  { value: "vendorPo", label: "Vendor PO to cancel" },
] as const;

export default async function OrdersPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    step?: string;
    businessType?: string;
    channel?: string;
    flag?: string;
    /** "toInvoice": finance's view of sold orders not yet billed in full, grouped by customer PO. */
    billing?: string;
    q?: string;
    page?: string;
    pageSize?: string;
    sel?: string;
  } & CustomFilterParams>;
}) {
  const enabled = await isModuleEnabled("orders");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="orders" />;
  }

  const params = await searchParams;
  const status = orderStatusValues.includes(params.status as OrderStatus) ? (params.status as OrderStatus) : undefined;
  // Narrowed to the types the filter offers; ADDON is raised from a subscription rather than
  // picked from a list, so it is not among them.
  const businessType = orderBusinessTypeValues.includes(
    params.businessType as (typeof orderBusinessTypeValues)[number],
  )
    ? (params.businessType as OrderBusinessType)
    : undefined;
  const viaReseller = params.channel === "reseller" ? true : params.channel === "direct" ? false : undefined;
  const flag = HANDOFF_FLAGS.find((f) => f.value === params.flag)?.value;
  const toInvoice = params.billing === "toInvoice";
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const customFilters = parseCustomFilters(params);
  const [viewMode, result, user] = await Promise.all([
    getViewMode("orders"),
    listOrdersPaged({ status, businessType, viaReseller, search: params.q, page, pageSize, flag, customFilters, step: params.step || undefined }),
    requireUser(),
  ]);
  const pendingCount = result.pendingApproval;
  const selected = viewMode === "split" ? resolveSelected(result.rows, params.sel) : null;
  // The workspace's own fields (src/lib/custom-fields): the columns the table can show — the table's
  // alone, so the split view asks for no values, though the picker still offers them — and the filter panel.
  const [customColumns, fieldFilters, { steps: allSteps }, stepOf] = await Promise.all([
    listColumns("ORDER", user.id, viewMode === "split" ? [] : result.rows.map((o) => o.id)),
    customFilterSetup("ORDER", user.id, customFilters),
    // The workspace's own steps within a status (Settings → Pipeline → Orders): the filter, and each row's.
    orderSteps(),
    stepsOfOrders(result.rows),
  ]);
  const activeSteps = allSteps.filter((s) => !s.archived);
  const stepsOn = activeSteps.length > 0;

  // The tabs, in the workspace's own names for the statuses where it has them (Settings → Wording).
  const wording = await getWording();
  const tab = (status: OrderStatus, canonical: string) => ({ label: statusSlot(wording, status, canonical), value: status });
  const stageFilters: { label: string; value?: OrderStatus }[] = [
    { label: "All" },
    tab("PENDING_APPROVAL", "Pending Approval"),
    tab("APPROVED", "Approved"),
    tab("PROCESSING", "Processing"),
    tab("FULFILLED", "Fulfilled"),
    tab("REJECTED", "Rejected"),
    tab("CANCELLED", "Cancelled"),
  ];

  function queryFor(overrides: Record<string, string | undefined>) {
    const next = {
      // The field filters too, or a status chip would quietly drop them.
      ...customFilterParams(params),
      status: params.status,
      step: params.step,
      q: params.q,
      businessType: params.businessType,
      channel: params.channel,
      flag: params.flag,
      billing: params.billing,
      ...overrides,
    };
    return Object.fromEntries(Object.entries(next).filter(([, v]) => v)) as Record<string, string>;
  }

  return (
    <SplitListPage active={viewMode === "split"}>
      <ListHeader
        title={slot(wording, "Orders", "order")}
        subtitle={
          <>
            {result.total} total{pendingCount > 0 && ` · ${pendingCount} awaiting accounts approval`}
          </>
        }
        search={<ToolbarSearch paramName="q" placeholder="Search" label={slot(wording, "Search customer name", "customer", "Search {one:lower} name")} />}
        filters={
          <>
            <SelectParamFilter
              variant="pill"
              icon={<ListFilter />}
              paramName="businessType"
              label="Type"
              options={orderBusinessTypeValues.map((t) => ({ value: t, label: orderBusinessTypeLabels[t] }))}
            />
            <SelectParamFilter
              variant="pill"
              icon={<Database />}
              paramName="channel"
              label="Channel"
              options={[
                { value: "direct", label: "Direct" },
                { value: "reseller", label: "Via reseller" },
              ]}
            />
            <MoreFilters params={stepsOn ? ["step"] : []} fields={fieldFilters}>
              {stepsOn && (
                <SelectParamFilter
                  variant="stacked"
                  paramName="step"
                  label="Step"
                  options={activeSteps.map((s) => ({ value: s.key, label: `${stepStatusLabel(s.status)} · ${s.label}` }))}
                />
              )}
            </MoreFilters>
            <ClearFilters params={["q", "businessType", "channel", "step"]} prefixes={[fieldFilters.prefix]} />
          </>
        }
        actions={
          <>
            <ColumnPicker variant="toolbar" tableKey="orders" customColumns={customColumns.columns} omit={stepsOn ? undefined : ["step"]} />
            <ViewModeToggle viewKey="orders" mode={viewMode} />
            {/* Orders saved without a price, filled in once (owner, 3 Nov 2026). */}
            {(await viewerHas("products.edit")) && (
              <Link href="/orders/missing-prices" className="rounded-full border border-line-strong bg-surface px-3 py-1 text-sm text-muted transition-colors hover:text-text">
                Fill missing prices
              </Link>
            )}
            <Link href="/orders/new">
              <Button size="sm">{slot(wording, "Punch order", "order", "Punch {one:lower}")}</Button>
            </Link>
          </>
        }
      />

      <div className="mt-4 flex flex-wrap gap-2">
        {stageFilters.map((f) => (
          <Link
            key={f.label}
            href={{ pathname: "/orders", query: queryFor({ status: f.value, flag: undefined, billing: undefined }) }}
            className={`rounded-full px-3 py-1 text-sm ${
              !flag && !toInvoice && (params.status === f.value || (!params.status && !f.value))
                ? "bg-brand text-brand-contrast"
                : "bg-surface text-muted border border-line-strong"
            }`}
          >
            {f.label}
          </Link>
        ))}
        {/* The hand-off views: sales's in-hand orders, purchase's queue, and what each is waiting on. */}
        {HANDOFF_FLAGS.map((f) => (
          <Link
            key={f.value}
            href={{ pathname: "/orders", query: queryFor({ flag: f.value, status: undefined, billing: undefined }) }}
            className={`rounded-full px-3 py-1 text-sm ${
              flag === f.value ? "bg-brand text-brand-contrast" : "bg-surface text-muted border border-dashed border-line-strong"
            }`}
          >
            {f.label}
          </Link>
        ))}
        {/* Finance's view: sold, not yet billed in full — grouped by the customer's PO. */}
        <Link
          href={{ pathname: "/orders", query: queryFor({ billing: toInvoice ? undefined : "toInvoice", flag: undefined, status: undefined }) }}
          className={`rounded-full px-3 py-1 text-sm ${toInvoice ? "bg-brand text-brand-contrast" : "bg-surface text-muted border border-dashed border-line-strong"}`}
        >
          To invoice
        </Link>
      </div>

      {toInvoice ? (
        <OrdersToInvoice
          groups={await listOrdersToInvoice({ search: params.q })}
          canInvoice={
            !(await viewAsContext()) && (await moduleAccessFor(user.id, "sales_documents")) === "available" && (await can(user.id, "docs.createInvoice"))
          }
        />
      ) : viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} ${result.total === 1 ? slot(wording, "order", "order", "{one:lower}") : slot(wording, "orders", "order", "{many:lower}")}`}
          listPane={<OrderSplitList orders={result.rows} selectedId={selected} />}
        >
          {selected ? <OrderDetail id={selected} /> : <SplitListEmpty message={slot(wording, "No orders match these filters.", "order", "No {many:lower} match these filters.")} />}
        </SplitListShell>
      ) : (
        <>
          <div className="mt-6">
            <OrdersTable orders={await withOrderExtras(result.rows.map((o) => ({ ...o, step: stepOf.get(o.id) ?? null })))} stepsOn={stepsOn} customColumns={customColumns} />
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
