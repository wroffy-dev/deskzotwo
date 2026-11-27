import { CompanyLink } from "@/components/companies/company-link";
import { RemindMeButton } from "@/components/reminders/remind-me-button";
import { CallButton } from "@/components/calls/call-button";
import { CustomerNoticeButton } from "@/components/marketing/customer-notice-button";
import { myPaymentRemindersFor } from "@/lib/payment-reminders";
import { currentUser } from "@/lib/session";
import { listOrdersWithPaymentsPaged, listPaymentsPaged, type PaymentStatusFilter } from "@/actions/payment";
import { listCompanyOptions } from "@/actions/company";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { accessLevel } from "@/lib/authz/access";
import { Badge, Card } from "@/components/ui/card";
import { ClearFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListHeader } from "@/components/ui/list-header";
import { ListFilter } from "lucide-react";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { PaymentsRowAction } from "@/components/payments/payments-row-action";
import { RecordPaymentButton } from "@/components/payments/record-payment-button";
import { PaymentsReceivedTable } from "@/components/payments/payments-received-table";
import { formatCurrency } from "@/lib/utils";
import { getPaymentStatus } from "@/lib/gst";
import { formatOrderId } from "@/lib/order-id";
import { companyPath } from "@/lib/record-links";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";

/** How many companies the Record payment dialog is sent; past that it searches the server. */
const COMPANIES_SENT = 300;

export default async function PaymentsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    q?: string;
    page?: string;
    pageSize?: string;
    ppage?: string;
    ppageSize?: string;
  }>;
}) {
  const enabled = await isModuleEnabled("payments");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="payments" />;
  }

  const sessionUser = await currentUser();
  const userId = sessionUser!.id;
  const [params, canRecord, canDelete] = await Promise.all([
    searchParams,
    hasEffectivePermission(userId, "payments.record"),
    accessLevel(userId, "payments", "delete").then((level) => level !== "NONE"),
  ]);

  const status = ["unpaid", "partial", "paid"].includes(params.status ?? "")
    ? (params.status as PaymentStatusFilter)
    : undefined;
  // Two independent lists on one screen, so each gets its own page params.
  const orderPage = resolvePage(params.page);
  const orderPageSize = resolvePageSize(params.pageSize);
  const paymentPage = resolvePage(params.ppage);
  const paymentPageSize = resolvePageSize(params.ppageSize);

  const [orderResult, companyRows, paymentResult] = await Promise.all([
    listOrdersWithPaymentsPaged({ status, search: params.q, page: orderPage, pageSize: orderPageSize }),
    // The first few hundred, one more to tell whether there are others — past them the dialog searches
    // (owner, 30 Oct 2026: the page sent every company before anything could be typed).
    canRecord ? listCompanyOptions({ withContacts: false, take: COMPANIES_SENT + 1 }) : Promise.resolve([]),
    listPaymentsPaged({ page: paymentPage, pageSize: paymentPageSize }),
  ]);
  // Each row's own "Remind me", showing its day once set (owner, 3 Nov 2026 — src/lib/payment-reminders.ts).
  const reminders = await myPaymentRemindersFor(
    userId,
    orderResult.rows.map((o) => ({ id: o.id, orderSeq: o.orderSeq, companyId: o.company.id })),
  );
  const companySearch = companyRows.length > COMPANIES_SENT;
  const companies = companyRows.slice(0, COMPANIES_SENT);

  const orders = orderResult.rows;
  const payments = paymentResult.rows;
  const totalOutstanding = orderResult.outstanding;
  const totalUnallocated = paymentResult.unallocated;

  return (
    <div>
      {/*
        Both page numbers, because these filters narrow both lists on this screen and resetting
        only one would leave the other stranded on a page that no longer exists.
      */}
      <ListHeader
        title="Payments"
        subtitle={
          <>
            {orderResult.total} order(s) · {formatCurrency(String(totalOutstanding))} outstanding
            {totalUnallocated > 0 && ` · ${formatCurrency(String(totalUnallocated))} unallocated`}
          </>
        }
        search={<ToolbarSearch paramName="q" placeholder="Search" label="Search company name" resetParams={["page", "ppage"]} />}
        filters={
          <>
            <SelectParamFilter
              variant="pill"
              icon={<ListFilter />}
              paramName="status"
              label="Status"
              allLabel="All"
              resetParams={["page", "ppage"]}
              options={[
                { value: "unpaid", label: "Unpaid" },
                { value: "partial", label: "Partially paid" },
                { value: "paid", label: "Paid" },
              ]}
            />
            <ClearFilters params={["q", "status"]} resetParams={["page", "ppage"]} />
          </>
        }
        actions={<RecordPaymentButton companies={companies} companySearch={companySearch} canRecord={canRecord} />}
      />

      <Card className="mt-6">
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2.5">Order ID</th>
                <th className="px-4 py-2.5">Company</th>
                <th className="px-4 py-2.5">Product</th>
                <th className="px-4 py-2.5">Qty</th>
                <th className="px-4 py-2.5">Total</th>
                <th className="px-4 py-2.5">Paid</th>
                <th className="px-4 py-2.5">Balance</th>
                <th className="px-4 py-2.5">Status</th>
                <th className="px-4 py-2.5 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {orders.map((o) => {
                const paymentStatus = getPaymentStatus(o.total, o.paid);
                return (
                  <tr key={o.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                    <td className="px-4 py-2.5 font-mono text-xs text-muted">{formatOrderId(o.orderSeq)}</td>
                    <td className="px-4 py-2.5">
                      <CompanyLink href={`${companyPath(o.company.companySeq)}?tab=products`} className="font-medium text-text hover:underline">
                        {o.company.name}
                      </CompanyLink>
                    </td>
                    <td className="px-4 py-2.5 text-muted">
                      {o.item.name}
                      {o.item.unit ? ` (${o.item.unit})` : ""}
                    </td>
                    <td className="px-4 py-2.5 text-muted">{o.quantity}</td>
                    <td className="px-4 py-2.5 text-muted">{formatCurrency(String(o.total))}</td>
                    <td className="px-4 py-2.5 text-muted">{formatCurrency(String(o.paid))}</td>
                    <td className="px-4 py-2.5 text-muted">{formatCurrency(String(Math.max(o.balance, 0)))}</td>
                    <td className="px-4 py-2.5">
                      <Badge tone={paymentStatus.tone}>{paymentStatus.label}</Badge>
                    </td>
                    <td className="px-4 py-2.5 text-right">
                      {/* Chase what's owed, as the renewals list chases a renewal (owner, 3 Nov 2026): remind
                          yourself, ring them, write to them — then record it. */}
                      <div className="flex items-center justify-end gap-1">
                      {o.balance > 0 && (
                        <>
                          <RemindMeButton
                            target={{ kind: "payment", orderId: o.id }}
                            label={`${formatOrderId(o.orderSeq)} — ${o.item.name}, ${o.company.name}`}
                            reminder={reminders.get(o.id) ?? null}
                          />
                          <CallButton companyId={o.company.id} companyName={o.company.name} companyProductId={o.id} size="icon" variant="ghost" />
                          <CustomerNoticeButton companyProductId={o.id} companyName={o.company.name} kind="PAYMENT" />
                        </>
                      )}
                      <PaymentsRowAction
                        order={{
                          id: o.id,
                          orderSeq: o.orderSeq,
                          quantity: o.quantity,
                          item: o.item,
                          allocations: o.allocations,
                        }}
                        companyId={o.company.id}
                        companyName={o.company.name}
                        canRecord={canRecord}
                        canDelete={canDelete}
                      />
                      </div>
                    </td>
                  </tr>
                );
              })}
              {orders.length === 0 && (
                <tr>
                  <td colSpan={9} className="px-4 py-8 text-center text-subtle">
                    No orders match this filter.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </Card>

      <Pagination
        page={orderPage}
        pageSize={orderPageSize}
        total={orderResult.total}
        totalPages={totalPages(orderResult.total, orderPageSize)}
        pageSizes={PAGE_SIZES}
        label="orders"
      />

      <PaymentsReceivedTable payments={payments} canRecord={canRecord} canDelete={canDelete} />

      <Pagination
        page={paymentPage}
        pageSize={paymentPageSize}
        total={paymentResult.total}
        totalPages={totalPages(paymentResult.total, paymentPageSize)}
        pageSizes={PAGE_SIZES}
        pageParam="ppage"
        pageSizeParam="ppageSize"
        label="payments"
      />
    </div>
  );
}
