"use client";

import { workspacePack } from "@/lib/country-pack";
import { useWording } from "@/components/terms/wording-provider";
import { slot, statusSlot } from "@/lib/terms/dictionary";
import { useId, useState, useTransition } from "react";
import type { z } from "zod";
import type { PaymentTerms, OrderStatus, OrderBusinessType } from "@prisma/client";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { termsLocked, updateCompanyProductSchema, type UpdateCompanyProductInput } from "@/lib/validation/company-product";
import { removeCompanyProduct, updateCompanyProduct } from "@/actions/company";
import { IndianRupee, Pencil, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { IconButton, RowActions } from "@/components/ui/icon-button";
import { Input, Label, Select } from "@/components/ui/input";
import { Badge } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { PaymentsDialog, type PayableOrder } from "@/components/payments/payments-dialog";
import { formatCurrency } from "@/lib/utils";
import { formatCalendarDay } from "@/lib/time/zone";
import { useClock } from "@/components/time/clock-provider";
import { getRenewalStatus } from "@/lib/renewals";
import { formatOrderId } from "@/lib/order-id";
import { companyPath, orderPath } from "@/lib/record-links";
import { calculateOrderAmount, getPaymentStatus, paymentTermsLabels } from "@/lib/gst";
import { orderBusinessTypeLabels } from "@/lib/validation/order";
import { AddSeatsDialog } from "@/components/orders/add-seats-dialog";
import type { OrderPaperwork, PaperLink } from "@/lib/orders/paperwork";

/** An order's invoices or its proposal, each opening it; a dash when it has none. */
function PaperLinks({ links }: { links: PaperLink[] }) {
  if (links.length === 0) return <span className="text-subtle">—</span>;
  return (
    <ul className="space-y-0.5">
      {links.map((l) => (
        <li key={l.href}>
          <Link href={l.href} className="whitespace-nowrap font-mono text-xs text-brand hover:underline" title={l.title}>
            {l.label}
          </Link>
          {l.tag && <span className="block text-[11px] text-subtle">{l.tag}</span>}
        </li>
      ))}
    </ul>
  );
}

type ItemOption = { id: string; name: string; sku: string; type: string; unit: string | null; sellingPrice: unknown };
type LocationOption = { id: string; label: string; isPrimary: boolean };
type VendorOption = { id: string; name: string; paymentTerms: PaymentTerms };

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

/**
 * Which of the list's views an order sits in (owner, 13 Nov 2026: "only active subscriptions seen by default"). Expired: a
 * subscription past its end date, or a cancelled or rejected order. Expiring: a subscription ending within 30 days, also
 * counted as active. Everything else — a subscription running or with no end date set, a one-time product — is active.
 */
export type ProductView = "active" | "expiring" | "expired" | "all";
export function productStanding(p: { orderStatus: OrderStatus; endDate: Date | string | null; item: { type: string } }, now = new Date()): "active" | "expiring" | "expired" {
  if (p.orderStatus === "CANCELLED" || p.orderStatus === "REJECTED") return "expired";
  if (p.item.type !== "SUBSCRIPTION") return "active";
  const key = getRenewalStatus(p.endDate, now).key;
  return key === "expired" ? "expired" : key === "expiring" ? "expiring" : "active";
}
export function inProductView(standing: "active" | "expiring" | "expired", view: ProductView): boolean {
  if (view === "all") return true;
  if (view === "active") return standing !== "expired";
  return standing === view;
}
const PRODUCT_VIEWS: { key: ProductView; label: string }[] = [
  { key: "active", label: "Active" },
  { key: "expiring", label: "Expiring soon" },
  { key: "expired", label: "Expired" },
  { key: "all", label: "All" },
];

type Product = PayableOrder & {
  notes: string | null;
  poNumber: string | null;
  startDate: Date | string | null;
  endDate: Date | string | null;
  createdAt: Date | string;
  orderStatus: OrderStatus;
  businessType: OrderBusinessType;
  addedBy: { id: string; name: string };
  /** Set on extra seats, pointing at the subscription they co-terminate with. */
  parentId?: string | null;
  /** Live addons hanging off this subscription, for the combined seat count. */
  addons?: { id: string; quantity: number; startDate: Date | string | null; unitPrice: string | number | null }[];
  location: { id: string; label: string; gstNumber: string | null; state: string | null };
  vendor: { id: string; companySeq: number; name: string; paymentTerms: PaymentTerms } | null;
  item: PayableOrder["item"] & { id: string; sku: string; type: string; unit: string | null };
  /** Set on a reseller's own rows: the customer this was bought for. */
  endCustomer?: { id: string; companySeq: number; name: string } | null;
  /** Set on an end customer's rows: the reseller who placed and pays for it. */
  company?: { id: string; companySeq: number; name: string };
};

type EditFormValues = z.input<typeof updateCompanyProductSchema>;

/** A typed day as stored (midnight UTC) back into a date input: its UTC date is the day, in any zone. */
function toDateInputValue(d: Date | string | null) {
  if (!d) return "";
  return new Date(d).toISOString().slice(0, 10);
}

function EditProductForm({
  product,
  locations,
  columnCount,
  canChangeTerms,
  onClose,
}: {
  product: Product;
  locations: LocationOption[];
  columnCount: number;
  canChangeTerms: boolean;
  onClose: () => void;
}) {
  const router = useRouter();
  const [serverError, setServerError] = useState<string | null>(null);
  const isSubscription = product.item.type === "SUBSCRIPTION";
  // Approved and later: quantity and term are what was approved and billed, the super admin's alone to correct
  // (updateCompanyProduct refuses them too).
  const locked = !canChangeTerms && termsLocked(product.orderStatus);
  // This form is rendered into whichever product row is being edited, so the ids are per-mount.
  const id = useId();
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<EditFormValues, unknown, UpdateCompanyProductInput>({
    resolver: zodResolver(updateCompanyProductSchema),
    defaultValues: {
      id: product.id,
      locationId: product.location.id,
      quantity: product.quantity,
      notes: product.notes ?? "",
      poNumber: product.poNumber ?? "",
      startDate: toDateInputValue(product.startDate),
      endDate: toDateInputValue(product.endDate),
    },
  });

  async function onSubmit(values: UpdateCompanyProductInput) {
    setServerError(null);
    const result = await updateCompanyProduct(values);
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    router.refresh();
    onClose();
  }

  return (
    <tr className="border-b border-line bg-surface-sunken last:border-0">
      <td colSpan={columnCount} className="p-3">
        <form onSubmit={handleSubmit(onSubmit)} className="space-y-2 rounded-md border border-line bg-surface p-3">
          {serverError && <p className="text-xs text-danger">{serverError}</p>}
          <div className="text-sm font-medium text-text">
            {formatOrderId(product.orderSeq)} · {product.item.name}
          </div>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor={`${id}-location`}>
              Location
            </Label>
            <Select id={`${id}-location`} {...register("locationId")}>
              {locations.map((loc) => (
                <option key={loc.id} value={loc.id}>
                  {loc.label}
                </option>
              ))}
            </Select>
            {errors.locationId && <p className="text-xs text-danger">{errors.locationId.message}</p>}
          </div>
          {/* These three carry a placeholder instead of a label, and a placeholder is gone the moment
              somebody types — so they are named outright rather than paired with a caption. */}
          <div className="flex gap-2">
            <Input
              type="number"
              min={1}
              placeholder="Qty"
              aria-label="Quantity"
              className="w-24"
              readOnly={locked}
              {...register("quantity")}
            />
            <Input
              placeholder="PO / Invoice number (optional)"
              aria-label="PO / Invoice number"
              {...register("poNumber")}
            />
          </div>
          <Input placeholder="Notes (optional)" aria-label="Notes" {...register("notes")} />
          {errors.quantity && <p className="text-xs text-danger">{errors.quantity.message}</p>}
          {isSubscription && (
            <div className="grid grid-cols-2 gap-2 rounded-md bg-surface-sunken p-2">
              <div className="space-y-1">
                <Label className="text-xs" htmlFor={`${id}-start-date`}>
                  Start date
                </Label>
                <Input id={`${id}-start-date`} type="date" readOnly={locked} {...register("startDate")} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs" htmlFor={`${id}-end-date`}>
                  Expiry date
                </Label>
                <Input id={`${id}-end-date`} type="date" readOnly={locked} {...register("endDate")} />
              </div>
            </div>
          )}
          {locked && (
            <p className="text-xs text-muted">
              This order is approved, so its quantity{isSubscription ? " and dates" : ""} stay as they are. Add seats or renew it instead.
            </p>
          )}
          <div className="flex justify-end gap-2">
            <Button type="button" variant="ghost" size="sm" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" size="sm" disabled={isSubmitting}>
              {isSubmitting ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </td>
    </tr>
  );
}

export function CompanyProductsList({
  companyId,
  companyName,
  products,
  items,
  locations,
  canEdit,
  canChangeTerms = false,
  canDelete,
  canRecordPayments,
  canDeletePayments,
  canAddSeats = true,
  paperwork = {},
  pastOrderIds = [],
}: {
  /** Orders entered after the fact (temporary — src/actions/past-order.ts), marked "Past order". */
  pastOrderIds?: string[];
  /** Renewals are in the workspace's plan and this person may raise seats (`orders.process`), as `createAddon` decides it. */
  canAddSeats?: boolean;
  companyId: string;
  companyName: string;
  products: Product[];
  /** Each order's invoices and the proposal it came from, by order id (src/lib/orders/paperwork.ts). */
  paperwork?: Record<string, OrderPaperwork>;
  items: ItemOption[];
  locations: LocationOption[];
  vendors: VendorOption[];
  canEdit: boolean;
  /** An approved order's quantity and dates: the super admin's alone (updateCompanyProduct). */
  canChangeTerms?: boolean;
  canDelete: boolean;
  canRecordPayments: boolean;
  canDeletePayments: boolean;
}) {
  const router = useRouter();
  // The workspace's own words and names for the statuses (Settings → Wording).
  const wording = useWording();
  const clock = useClock();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<Product | null>(null);
  const [paymentsTargetId, setPaymentsTargetId] = useState<string | null>(null);
  const paymentsTarget = products.find((p) => p.id === paymentsTargetId) ?? null;
  const [isPending, startTransition] = useTransition();
  const showActionsColumn = canEdit || canDelete || canRecordPayments || canDeletePayments;
  const columnCount = 12 + (showActionsColumn ? 1 : 0);
  // Active first; a customer with nothing active opens on All, so the page never looks empty when it isn't.
  const standings = new Map(products.map((p) => [p.id, productStanding(p)]));
  const viewCounts = Object.fromEntries(
    PRODUCT_VIEWS.map((v) => [v.key, products.filter((p) => inProductView(standings.get(p.id)!, v.key)).length]),
  ) as Record<ProductView, number>;
  const [view, setView] = useState<ProductView>(() => (viewCounts.active === 0 ? "all" : "active"));
  const shown = products.filter((p) => inProductView(standings.get(p.id)!, view));

  function confirmDelete() {
    if (!deleteTarget) return;
    const id = deleteTarget.id;
    startTransition(async () => {
      await removeCompanyProduct(id);
      setDeleteTarget(null);
      router.refresh();
    });
  }

  return (
    <div className="space-y-3">
      {products.length > 0 && (
        <div role="tablist" aria-label="Show" className="inline-flex flex-wrap gap-0.5 rounded-base bg-surface-sunken p-0.5">
          {PRODUCT_VIEWS.map((v) => (
            <button
              key={v.key}
              type="button"
              role="tab"
              aria-selected={view === v.key}
              onClick={() => setView(v.key)}
              className={`inline-flex items-center gap-1.5 rounded-[6px] px-3 py-1.5 text-sm transition-colors ${
                view === v.key ? "bg-surface font-medium text-text shadow-sm" : "text-muted hover:text-text"
              }`}
            >
              {v.label}
              <span className="text-[11px] tabular-nums text-subtle">{viewCounts[v.key]}</span>
            </button>
          ))}
        </div>
      )}
      <div className="overflow-x-auto rounded-md border border-line">
        <table className="w-full text-sm">
          <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
            <tr>
              <th className="px-3 py-2.5">{slot(wording, "Order ID", "order", "{one} ID")}</th>
              <th className="px-3 py-2.5">Status</th>
              <th className="px-3 py-2.5">Product</th>
              <th className="px-3 py-2.5">{slot(wording, "Vendor", "vendor", "{one}")}</th>
              <th className="px-3 py-2.5">Qty</th>
              <th className="px-3 py-2.5">PO / Invoice #</th>
              <th className="px-3 py-2.5">Invoice</th>
              <th className="px-3 py-2.5">Proposal</th>
              <th className="px-3 py-2.5">Total (incl. {workspacePack().tax.name})</th>
              <th className="px-3 py-2.5">Payment</th>
              <th className="px-3 py-2.5">{slot(wording, "Renewal", "renewal", "{one}")}</th>
              <th className="px-3 py-2.5">Added by</th>
              {showActionsColumn && <th className="px-3 py-2.5 text-right">Actions</th>}
            </tr>
          </thead>
          <tbody>
            {shown.map((p) => {
              const status = p.item.type === "SUBSCRIPTION" ? getRenewalStatus(p.endDate) : null;
              const { subtotal, gstAmount, total } = calculateOrderAmount({
                quantity: p.quantity,
                unitPrice: Number(p.unitPrice ?? p.item.sellingPrice),
                taxRatePercent: p.item.taxRatePercent ? Number(p.item.taxRatePercent) : null,
              });
              const paid = p.allocations.reduce((sum, a) => sum + Number(a.amount), 0);
              const balance = Math.round((total - paid) * 100) / 100;
              const paymentStatus = getPaymentStatus(total, paid);

              if (editingId === p.id) {
                return (
                  <EditProductForm
                    key={p.id}
                    product={p}
                    locations={locations}
                    columnCount={columnCount}
                    canChangeTerms={canChangeTerms}
                    onClose={() => setEditingId(null)}
                  />
                );
              }

              return (
                <tr key={p.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="px-3 py-2.5 font-mono text-xs">
                    <Link href={orderPath(p.orderSeq)} className="text-muted hover:underline">
                      {formatOrderId(p.orderSeq)}
                    </Link>
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge tone={ORDER_STATUS_TONE[p.orderStatus]}>{statusSlot(wording, p.orderStatus, p.orderStatus.replaceAll("_", " "))}</Badge>
                    <div className="mt-1">
                      <Badge tone={BUSINESS_TYPE_TONE[p.businessType]}>{orderBusinessTypeLabels[p.businessType]}</Badge>
                      {pastOrderIds.includes(p.id) && <Badge tone="default">Past order</Badge>}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-text">{p.item.name}</span>
                      <Badge>{p.item.type}</Badge>
                    </div>
                    <div className="text-muted">
                      {p.item.sku} · {p.location.label}
                      {p.notes && <> · {p.notes}</>}
                    </div>
                    {p.endCustomer && (
                      <div className="mt-0.5 text-xs text-info">
                        {slot(wording, "For end customer:", "customer", "For end {one:lower}:")}{" "}
                        <CompanyLink href={companyPath(p.endCustomer.companySeq)} className="hover:underline">
                          {p.endCustomer.name}
                        </CompanyLink>
                      </div>
                    )}
                    {p.company && (
                      <div className="mt-0.5 text-xs text-info">
                        Bought via reseller:{" "}
                        <CompanyLink href={companyPath(p.company.companySeq)} className="hover:underline">
                          {p.company.name}
                        </CompanyLink>
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    {p.vendor ? (
                      <>
                        <CompanyLink href={companyPath(p.vendor.companySeq)} className="font-medium text-text hover:underline">
                          {p.vendor.name}
                        </CompanyLink>
                        <div className="text-xs text-subtle">{paymentTermsLabels[p.vendor.paymentTerms]}</div>
                      </>
                    ) : (
                      <Badge tone="amber">{slot(wording, "No vendor set", "vendor", "No {one:lower} set")}</Badge>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-muted">
                    {p.quantity}
                    {p.item.unit ? ` ${p.item.unit}` : ""}
                    {/* The running total, where seats were added part-way through the term. */}
                    {p.addons && p.addons.length > 0 && (
                      <span className="block text-[11px] text-subtle">
                        {p.quantity + p.addons.reduce((t, a) => t + a.quantity, 0)} in total, with{" "}
                        {p.addons.length} addition{p.addons.length === 1 ? "" : "s"}
                      </span>
                    )}
                    {p.parentId && <span className="block text-[11px] text-subtle">added mid-term</span>}
                    {/* Extra seats are raised from the subscription itself, where the term and the
                        price to pro-rate against are already known. */}
                    {canAddSeats && !p.parentId && p.item.type === "SUBSCRIPTION" && p.endDate && p.orderStatus !== "CANCELLED" && (
                      <span className="mt-1 block">
                        <AddSeatsDialog subscription={{ id: p.id, quantity: p.quantity, endDate: p.endDate }} />
                      </span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-muted">{p.poNumber ?? "—"}</td>
                  <td className="px-3 py-2.5">
                    <PaperLinks links={paperwork[p.id]?.invoices ?? []} />
                  </td>
                  <td className="px-3 py-2.5">
                    <PaperLinks links={paperwork[p.id]?.proposal ? [paperwork[p.id]!.proposal!] : []} />
                  </td>
                  <td className="px-3 py-2.5 text-muted">
                    <div className="font-medium text-text">{formatCurrency(String(total))}</div>
                    {gstAmount > 0 && (
                      <div className="text-xs text-subtle">
                        {formatCurrency(String(subtotal))} + {workspacePack().tax.name} {formatCurrency(String(gstAmount))}
                      </div>
                    )}
                  </td>
                  <td className="px-3 py-2.5">
                    <Badge tone={paymentStatus.tone}>{paymentStatus.label}</Badge>
                    <div className="mt-1 text-xs text-muted">
                      Paid {formatCurrency(String(paid))}
                      {balance > 0 ? ` · Due ${formatCurrency(String(balance))}` : ""}
                    </div>
                  </td>
                  <td className="px-3 py-2.5">
                    {status ? (
                      <div className="space-y-1">
                        <div className="text-muted">
                          {formatCalendarDay(p.startDate)} – {formatCalendarDay(p.endDate)}
                        </div>
                        <Badge tone={status.tone}>{status.label}</Badge>
                      </div>
                    ) : (
                      <span className="text-subtle">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-muted">
                    {p.addedBy.name}
                    <div className="text-xs text-subtle">{clock.date(p.createdAt)}</div>
                  </td>
                  {showActionsColumn && (
                    <td className="px-3 py-2.5 text-right">
                      <RowActions>
                        {(canRecordPayments || canDeletePayments) && (
                          <IconButton
                            icon={IndianRupee}
                            label="Payments"
                            onClick={() => setPaymentsTargetId(p.id)}
                          />
                        )}
                        {canEdit && <IconButton icon={Pencil} label="Edit" onClick={() => setEditingId(p.id)} />}
                        {canDelete && (
                          <IconButton
                            icon={Trash2}
                            label="Delete"
                            tone="danger"
                            disabled={isPending && deleteTarget?.id === p.id}
                            onClick={() => setDeleteTarget(p)}
                          />
                        )}
                      </RowActions>
                    </td>
                  )}
                </tr>
              );
            })}
            {products.length === 0 && (
              <tr>
                <td colSpan={columnCount} className="px-3 py-6 text-center text-subtle">
                  {slot(wording, "No orders added directly yet.", "order", "No {many:lower} added directly yet.")}
                </td>
              </tr>
            )}
            {products.length > 0 && shown.length === 0 && (
              <tr>
                <td colSpan={columnCount} className="px-3 py-6 text-center text-subtle">
                  {view === "expiring" ? "Nothing ends in the next 30 days." : view === "expired" ? "Nothing has expired." : "Nothing active."}{" "}
                  <button type="button" onClick={() => setView("all")} className="text-brand hover:underline">
                    Show all {products.length}
                  </button>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      {items.length === 0 ? (
        <p className="text-xs text-subtle">Add an item to the catalog before punching an order.</p>
      ) : (
        <Link href={`/orders/new?companyId=${companyId}`}>
          <Button type="button" variant="secondary" size="sm">
            {slot(wording, "+ Punch order", "order", "+ Punch {one:lower}")}
          </Button>
        </Link>
      )}

      <Dialog open={!!deleteTarget} onClose={() => setDeleteTarget(null)} title="Remove product">
        <p className="text-sm text-muted">
          Remove{" "}
          <span className="font-medium text-text">
            {deleteTarget && formatOrderId(deleteTarget.orderSeq)} · {deleteTarget?.item.name}
          </span>{" "}
          {slot(wording, "from this company? This can't be undone.", "company", "from this {one:lower}? This can't be undone.")}
        </p>
        <div className="mt-4 flex justify-end gap-2">
          <Button type="button" variant="ghost" size="sm" onClick={() => setDeleteTarget(null)} disabled={isPending}>
            Cancel
          </Button>
          <Button type="button" variant="danger" size="sm" onClick={confirmDelete} disabled={isPending}>
            {isPending ? "Deleting…" : "Delete"}
          </Button>
        </div>
      </Dialog>

      {paymentsTarget && (
        <PaymentsDialog
          key={paymentsTarget.id}
          order={paymentsTarget}
          open
          onClose={() => setPaymentsTargetId(null)}
          canRecord={canRecordPayments}
          canDelete={canDeletePayments}
          companyId={companyId}
          companyName={companyName}
        />
      )}
    </div>
  );
}
