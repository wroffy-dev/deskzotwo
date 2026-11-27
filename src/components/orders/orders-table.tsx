"use client";

import { useWording } from "@/components/terms/wording-provider";
import { slot, statusSlot } from "@/lib/terms/dictionary";
import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import type { OrderStatus, OrderBusinessType, CompanyRelationshipType } from "@prisma/client";
import { orderBusinessTypeLabels } from "@/lib/validation/order";
import { calculateOrderAmount } from "@/lib/gst";
import { formatOrderId } from "@/lib/order-id";
import { companyPath, orderPath } from "@/lib/record-links";
import { CustomerNoticeButton } from "@/components/marketing/customer-notice-button";
import { canAnnounceFulfilment } from "@/lib/marketing/customer-notices";
import { formatCurrency } from "@/lib/utils";
import { Badge, Card } from "@/components/ui/card";
import { useColumns, ColumnsTable } from "@/components/ui/table-columns";
import { CustomFieldBodyCells, CustomFieldHeaderCells, type CustomColumn } from "@/components/custom-fields/custom-field-cells";
import { handoffBadge, vendorPoLabels, type ReleaseState } from "@/lib/orders/handoff-rules";
import { useClock } from "@/components/time/clock-provider";
import { formatCalendarDay } from "@/lib/time/zone";
import type { Clock } from "@/lib/time/zone";
import type { StageColor } from "@/lib/pipeline/rules";
import { BillingChip } from "@/components/orders/order-invoicing";
import type { OrderBillingStatus } from "@/lib/orders/billing-rules";

const ORDER_STATUS_TONE: Record<OrderStatus, "default" | "green" | "blue" | "red" | "amber"> = {
  PENDING_APPROVAL: "amber",
  APPROVED: "blue",
  REJECTED: "red",
  PROCESSING: "blue",
  FULFILLED: "green",
  CANCELLED: "default",
};

const BUSINESS_TYPE_TONE: Record<OrderBusinessType, "default" | "green" | "blue" | "red" | "amber"> = {
  NEW: "green",
  RENEWAL: "blue",
  NEW_TO_US_RENEWAL: "amber",
  ADDON: "default",
};

type OrderRow = {
  id: string;
  orderSeq: number;
  /** The workspace's own step it is at within its status (src/lib/pipeline/order-steps.ts), if any. */
  step?: { label: string; color: StageColor } | null;
  quantity: number;
  unitPrice: number | null;
  orderStatus: OrderStatus;
  businessType: OrderBusinessType;
  company: { id: string; companySeq: number; name: string; relationshipType: CompanyRelationshipType; owner?: { id: string; name: string } | null; assignedTo?: { id: string; name: string } | null };
  createdAt?: Date | string;
  startDate?: Date | string | null;
  endDate?: Date | string | null;
  /** Read by the page only when its column is shown (src/lib/tables/list-extras.ts). */
  renewalManager?: { id: string; name: string; own: boolean } | null;
  endCustomer: { id: string; name: string } | null;
  item: { id: string; name: string; unit: string | null; sellingPrice: number; taxRatePercent: number | null };
  vendor: { id: string; name: string } | null;
  /** The vendor's invoice, where its column is shown (src/lib/orders/vendor-invoice.ts). */
  vendorInvoice?: { number: string | null; amount: number | null; difference: number | null } | null;
  addedBy: { id: string; name: string };
  purchaseRelease: ReleaseState;
  releaseOn: Date | string | null;
  pendingPurchasePrice: number | null;
  vendorPoCancel: "PENDING" | "CANCELLED" | "NOT_NEEDED" | null;
  /** Its invoicing (src/lib/orders/billing.ts); absent where the list didn't read it. */
  billing?: { status: OrderBillingStatus; invoices: { documentId: string; docNumber: string }[]; payment?: "PAID" | "PART" | "DUE" | null } | null;
};

/**
 * What an order is waiting on besides its status: sales holding it back from purchase, a higher price
 * waiting for sales, or a cancelled order's vendor PO. Shared with the split list. `clock` is the
 * workspace's (`useClock()`): a scheduled day says its year when it isn't this one there.
 */
export function orderFlags(o: Pick<OrderRow, "orderStatus" | "purchaseRelease" | "releaseOn" | "pendingPurchasePrice" | "vendorPoCancel">, clock: Clock): string[] {
  const flags: string[] = [];
  const open = o.orderStatus !== "CANCELLED" && o.orderStatus !== "REJECTED" && o.orderStatus !== "FULFILLED";
  const handoff = open ? handoffBadge(o, clock) : null;
  if (handoff) flags.push(handoff);
  if (open && o.pendingPurchasePrice !== null) flags.push("Waiting for sales approval");
  if (o.vendorPoCancel === "PENDING") flags.push(vendorPoLabels.PENDING);
  return flags;
}

/**
 * Deliberately has no row selection or bulk actions. An order moves through approval one at a time
 * because each step is a judgement about that specific order — accounts weighs its payment terms,
 * purchasing sources its vendor and cost. Approving a screenful at once would turn a review into a
 * rubber stamp, so the workflow stays on the order's own page.
 */
export function OrdersTable({
  orders,
  stepsOn = false,
  customColumns = { columns: [], texts: {} },
}: {
  orders: OrderRow[];
  /** The workspace has order steps (Settings → Pipeline): only then is there a Step column to show. */
  stepsOn?: boolean;
  /**
   * The workspace's own fields this person may see (src/lib/custom-fields/server.ts `listColumns`):
   * the ones they show in the column picker, or each field's default.
   */
  customColumns?: { columns: CustomColumn[]; texts: Record<string, Record<string, string>> };
}) {
  const cols = useColumns("orders");
  // The workspace's own names for the statuses (Settings → Wording).
  const wording = useWording();
  const clock = useClock();
  // The fields this person shows, worked out once: the header and every row draw this one list.
  const fieldColumns = customColumns.columns.filter((c) => cols.showCustom(c.key, c.default));
  // The Step column counts as shown by the picker even where there are no steps to show in it.
  const hiddenStep = !stepsOn && cols.show("step");
  const span = cols.count - Number(hiddenStep) + fieldColumns.length;
  return (
    <Card className="overflow-x-auto p-0">
      <ColumnsTable columns={cols} className="w-full text-sm">
        <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
          <tr>{cols.arrange(<>
            {cols.show("order") && <th data-col="order" className="px-4 py-2.5">{slot(wording, "Order", "order", "{one}")}</th>}
            {cols.show("status") && <th data-col="status" className="px-4 py-2.5">Status</th>}
            {stepsOn && cols.show("step") && <th data-col="step" className="px-4 py-2.5">Step</th>}
            {cols.show("type") && <th data-col="type" className="px-4 py-2.5">Type</th>}
            {cols.show("customer") && <th data-col="customer" className="px-4 py-2.5">{slot(wording, "Customer", "customer", "{one}")}</th>}
            {cols.show("accountManager") && <th data-col="accountManager" className="px-4 py-2.5">Account manager</th>}
            {cols.show("caller") && <th data-col="caller" className="px-4 py-2.5">Caller</th>}
            {cols.show("product") && <th data-col="product" className="px-4 py-2.5">Product</th>}
            {cols.show("qty") && <th data-col="qty" className="px-4 py-2.5">Qty</th>}
            {cols.show("total") && <th data-col="total" className="px-4 py-2.5">Total</th>}
            {cols.show("invoice") && <th data-col="invoice" className="px-4 py-2.5">Invoice</th>}
            {cols.show("vendor") && <th data-col="vendor" className="px-4 py-2.5">{slot(wording, "Vendor", "vendor", "{one}")}</th>}
            {cols.show("vendorInvoice") && <th data-col="vendorInvoice" className="px-4 py-2.5">{slot(wording, "Vendor invoice", "vendor", "{one} invoice")}</th>}
            {cols.show("addedBy") && <th data-col="addedBy" className="px-4 py-2.5">Added by</th>}
            {cols.show("orderDate") && <th data-col="orderDate" className="px-4 py-2.5">Order date</th>}
            {cols.show("term") && <th data-col="term" className="px-4 py-2.5">Term</th>}
            {cols.show("renewalManager") && <th data-col="renewalManager" className="px-4 py-2.5">Renewal manager</th>}
            {cols.show("payment") && <th data-col="payment" className="px-4 py-2.5">Payment</th>}
            {cols.show("endCustomer") && <th data-col="endCustomer" className="px-4 py-2.5">End customer</th>}
            {cols.show("actions") && <th data-col="actions" className="px-4 py-2.5 text-right">Tell them</th>}
            <CustomFieldHeaderCells columns={fieldColumns} className="px-4 py-2.5" />
          </>)}</tr>
        </thead>
        <tbody>
          {orders.map((o) => {
            const { total } = calculateOrderAmount({
              quantity: o.quantity,
              unitPrice: Number(o.unitPrice ?? o.item.sellingPrice),
              taxRatePercent: o.item.taxRatePercent ? Number(o.item.taxRatePercent) : null,
            });
            return (
              <tr key={o.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">{cols.arrange(<>
                {cols.show("order") && (
                  <td data-col="order" className="px-4 py-2.5 font-mono text-xs">
                    <Link href={orderPath(o.orderSeq)} className="text-text hover:underline">
                      {formatOrderId(o.orderSeq)}
                    </Link>
                  </td>
                )}
                {cols.show("status") && (
                  <td data-col="status" className="px-4 py-2.5">
                    <Badge tone={ORDER_STATUS_TONE[o.orderStatus]}>{statusSlot(wording, o.orderStatus, o.orderStatus.replaceAll("_", " "))}</Badge>
                    {orderFlags(o, clock).map((flag) => (
                      <div key={flag} className="mt-1">
                        <Badge tone={flag === vendorPoLabels.PENDING ? "red" : "amber"}>{flag}</Badge>
                      </div>
                    ))}
                  </td>
                )}
                {stepsOn && cols.show("step") && (
                  <td data-col="step" className="px-4 py-2.5">{o.step ? <Badge tone={o.step.color}>{o.step.label}</Badge> : <span className="text-subtle">—</span>}</td>
                )}
                {cols.show("type") && (
                  <td data-col="type" className="px-4 py-2.5">
                    <Badge tone={BUSINESS_TYPE_TONE[o.businessType]}>{orderBusinessTypeLabels[o.businessType]}</Badge>
                  </td>
                )}
                {cols.show("customer") && (
                  <td data-col="customer" className="px-4 py-2.5">
                    <CompanyLink href={companyPath(o.company.companySeq)} className="text-text hover:underline">
                      {o.company.name}
                    </CompanyLink>
                    {o.company.relationshipType === "RESELLER" && (
                      <div className="mt-0.5 flex items-center gap-1.5 text-xs text-info">
                        <Badge tone="blue">Reseller</Badge>
                        {o.endCustomer && <span className="text-muted">for {o.endCustomer.name}</span>}
                      </div>
                    )}
                  </td>
                )}
                {cols.show("accountManager") && <td data-col="accountManager" className="px-4 py-2.5 text-muted">{o.company.owner?.name ?? "—"}</td>}
                {cols.show("caller") && <td data-col="caller" className="px-4 py-2.5 text-muted">{o.company.assignedTo?.name ?? "—"}</td>}
                {cols.show("product") && (
                  <td data-col="product" className="px-4 py-2.5 text-muted">{o.item.name}</td>
                )}
                {cols.show("qty") && (
                  <td data-col="qty" className="px-4 py-2.5 text-muted">
                    {o.quantity}
                    {o.item.unit ? ` ${o.item.unit}` : ""}
                  </td>
                )}
                {cols.show("total") && (
                  <td data-col="total" className="px-4 py-2.5 font-medium text-text">{formatCurrency(total)}</td>
                )}
                {cols.show("invoice") && (
                  <td data-col="invoice" className="px-4 py-2.5">
                    {o.billing && o.orderStatus !== "CANCELLED" && o.orderStatus !== "REJECTED" ? (
                      <BillingChip status={o.billing.status} invoices={o.billing.invoices} />
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
                )}
                {cols.show("vendor") && (
                  <td data-col="vendor" className="px-4 py-2.5 text-muted">{o.vendor?.name ?? "—"}</td>
                )}
                {cols.show("vendorInvoice") && (
                  <td data-col="vendorInvoice" className="px-4 py-2.5 text-xs text-muted">
                    {o.vendorInvoice ? (
                      <span className="flex flex-col">
                        <span className="font-mono">{o.vendorInvoice.number ?? "—"}</span>
                        {o.vendorInvoice.amount !== null && (
                          <span className={`tabular-nums ${o.vendorInvoice.difference !== null && o.vendorInvoice.difference >= 0.5 ? "text-danger" : ""}`}>
                            {formatCurrency(o.vendorInvoice.amount)}
                            {o.vendorInvoice.difference !== null && o.vendorInvoice.difference >= 0.5 ? ` (+${formatCurrency(o.vendorInvoice.difference)})` : ""}
                          </span>
                        )}
                      </span>
                    ) : (
                      "—"
                    )}
                  </td>
                )}
                {cols.show("addedBy") && (
                  <td data-col="addedBy" className="px-4 py-2.5 text-muted">{o.addedBy.name}</td>
                )}
                {cols.show("orderDate") && <td data-col="orderDate" className="whitespace-nowrap px-4 py-2.5 text-muted">{o.createdAt ? clock.date(o.createdAt) : "—"}</td>}
                {cols.show("term") && (
                  <td data-col="term" className="whitespace-nowrap px-4 py-2.5 text-muted">
                    {o.startDate || o.endDate ? `${o.startDate ? formatCalendarDay(o.startDate) : "…"} – ${o.endDate ? formatCalendarDay(o.endDate) : "…"}` : "—"}
                  </td>
                )}
                {cols.show("renewalManager") && (
                  <td data-col="renewalManager" className="px-4 py-2.5 text-muted">
                    {o.renewalManager?.own ? o.renewalManager.name : <span className="text-subtle">Account manager</span>}
                  </td>
                )}
                {cols.show("payment") && (
                  <td data-col="payment" className="px-4 py-2.5">
                    {o.billing?.payment ? (
                      <Badge tone={o.billing.payment === "PAID" ? "green" : o.billing.payment === "PART" ? "amber" : "red"}>
                        {o.billing.payment === "PAID" ? "Paid" : o.billing.payment === "PART" ? "Part paid" : "Due"}
                      </Badge>
                    ) : (
                      <span className="text-subtle">Not invoiced</span>
                    )}
                  </td>
                )}
                {cols.show("endCustomer") && <td data-col="endCustomer" className="px-4 py-2.5 text-muted">{o.endCustomer?.name ?? "—"}</td>}
                {cols.show("actions") && (
                  <td data-col="actions" className="px-4 py-2.5">
                    <div className="flex items-center justify-end">
                      {/* Only once it is actually fulfilled. "Your order is ready" sent while
                          purchasing is still sourcing it invites a delivery query nobody can
                          answer, and cannot be taken back. */}
                      {canAnnounceFulfilment(o.orderStatus) && (
                        <CustomerNoticeButton
                          companyProductId={o.id}
                          companyName={o.company.name}
                          kind="FULFILMENT"
                        />
                      )}
                    </div>
                  </td>
                )}
                <CustomFieldBodyCells columns={fieldColumns} texts={customColumns.texts[o.id]} className="px-4 py-2.5 text-muted" />
              </>)}</tr>
            );
          })}
          {orders.length === 0 && (
            <tr>
              <td colSpan={span} className="px-4 py-8 text-center text-subtle">
                {slot(wording, "No orders found.", "order", "No {many:lower} found.")}
              </td>
            </tr>
          )}
        </tbody>
      </ColumnsTable>
    </Card>
  );
}
