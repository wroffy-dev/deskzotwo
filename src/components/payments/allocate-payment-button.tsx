"use client";

import { useId, useState, useTransition } from "react";
import type { z } from "zod";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useRouter } from "next/navigation";
import { allocatePaymentSchema, type AllocatePaymentInput } from "@/lib/validation/payment";
import { allocatePayment, listCompanyOrdersForPayment } from "@/actions/payment";
import { applyPaymentToInvoice, listOpenInvoices } from "@/actions/receivable";
import { isBaseCurrency } from "@/lib/currency";
import { formatCalendarDay } from "@/lib/time/zone";
import { Button } from "@/components/ui/button";
import { Input, Label, Select } from "@/components/ui/input";
import { Dialog } from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/utils";
import { formatOrderId } from "@/lib/order-id";

type OrderOption = Awaited<ReturnType<typeof listCompanyOrdersForPayment>>[number];
type InvoiceOption = Awaited<ReturnType<typeof listOpenInvoices>>[number];
type FormValues = z.input<typeof allocatePaymentSchema>;

export type UnallocatedPayment = {
  id: string;
  unallocated: number;
  company: { id: string; name: string };
};

export function AllocatePaymentButton({ payment }: { payment: UnallocatedPayment }) {
  const router = useRouter();
  // One of these buttons sits on every unallocated payment row, so the field ids have to be unique
  // per instance — a fixed "amount" would repeat down the page and point every label at row one.
  const fieldId = useId();
  const [open, setOpen] = useState(false);
  const [orders, setOrders] = useState<OrderOption[] | null>(null);
  const [ordersPending, startOrdersTransition] = useTransition();
  const [serverError, setServerError] = useState<string | null>(null);
  /**
   * To an invoice or to an order (owner, 21 Nov 2026 — "I have added payment in customer payments but how do I allocate
   * to this invoice?"). Invoices first: money on account is usually for one. The same rules as everywhere an invoice is
   * settled (receivable.ts `applyPaymentToInvoice`); only rupee invoices, as this button is only on rupee payments.
   */
  const [to, setTo] = useState<"invoice" | "order">("invoice");
  const [invoices, setInvoices] = useState<InvoiceOption[] | null>(null);
  const [invoiceId, setInvoiceId] = useState("");
  const [invoiceAmount, setInvoiceAmount] = useState("");
  const [applying, setApplying] = useState(false);
  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<FormValues, unknown, AllocatePaymentInput>({
    resolver: zodResolver(allocatePaymentSchema),
    defaultValues: { paymentId: payment.id },
  });

  function openDialog() {
    setOpen(true);
    setServerError(null);
    setInvoiceId("");
    setInvoiceAmount("");
    startOrdersTransition(async () => {
      // Without Receivables, no invoices to offer — the orders still load.
      const [o, i] = await Promise.all([listCompanyOrdersForPayment(payment.company.id), listOpenInvoices(payment.company.id).catch(() => [] as InvoiceOption[])]);
      setOrders(o);
      setInvoices(i.filter((x) => isBaseCurrency(x.currency)));
    });
  }

  function pickInvoice(id: string) {
    setInvoiceId(id);
    const inv = invoices?.find((x) => x.id === id);
    // What can go on it: its balance, or what is left of this payment, whichever is less.
    if (inv) setInvoiceAmount(String(Math.round(Math.min(inv.balance, payment.unallocated) * 100) / 100));
  }

  async function applyToInvoice(e: React.FormEvent) {
    e.preventDefault();
    setServerError(null);
    const amount = Number(invoiceAmount);
    if (!invoiceId) return setServerError("Choose the invoice.");
    if (!(amount > 0)) return setServerError("Enter an amount greater than zero.");
    setApplying(true);
    try {
      const result = await applyPaymentToInvoice(payment.id, invoiceId, amount);
      if (!result.ok) return setServerError(result.error);
      setOpen(false);
      router.refresh();
    } catch {
      setServerError("That didn't go through — try again.");
    } finally {
      setApplying(false);
    }
  }

  async function onSubmit(values: AllocatePaymentInput) {
    setServerError(null);
    const result = await allocatePayment({ ...values, paymentId: payment.id });
    if (!result.ok) {
      setServerError(result.error);
      return;
    }
    setOpen(false);
    router.refresh();
  }

  return (
    <>
      <Button type="button" variant="secondary" size="sm" onClick={openDialog}>
        Allocate
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title={`Allocate payment — ${payment.company.name}`}>
        <p className="mb-2 text-sm text-muted">
          {formatCurrency(String(payment.unallocated))} unallocated. Apply some or all of it to an invoice or an order.
        </p>
        <div role="radiogroup" aria-label="Apply it to" className="mb-3 inline-flex rounded-base border border-line p-0.5 text-sm">
          {(["invoice", "order"] as const).map((k) => (
            <button
              key={k}
              type="button"
              role="radio"
              aria-checked={to === k}
              onClick={() => {
                setTo(k);
                setServerError(null);
              }}
              className={to === k ? "rounded-base bg-surface-sunken px-3 py-1 font-medium text-text" : "px-3 py-1 text-muted hover:text-text"}
            >
              {k === "invoice" ? "An invoice" : "An order"}
            </button>
          ))}
        </div>
        {ordersPending && <p className="text-sm text-subtle">Loading…</p>}
        {!ordersPending && to === "invoice" && (
          <form onSubmit={(e) => void applyToInvoice(e)} className="space-y-2">
            {serverError && <p className="text-xs text-danger">{serverError}</p>}
            <div className="space-y-1">
              <Label className="text-xs" htmlFor={`${fieldId}-invoice`}>Invoice</Label>
              <Select id={`${fieldId}-invoice`} value={invoiceId} onChange={(e) => pickInvoice(e.target.value)}>
                <option value="">Select an invoice…</option>
                {invoices?.map((i) => (
                  <option key={i.id} value={i.id}>
                    {i.docNumber} · {formatCalendarDay(i.issueDate)} — owes {formatCurrency(String(i.balance))}
                  </option>
                ))}
              </Select>
              {invoices?.length === 0 && <p className="text-xs text-subtle">This company has no rupee invoice with anything owing.</p>}
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor={`${fieldId}-invoice-amount`}>Amount to apply</Label>
              <Input
                id={`${fieldId}-invoice-amount`}
                type="number"
                min={0.01}
                step="0.01"
                max={payment.unallocated}
                value={invoiceAmount}
                onChange={(e) => setInvoiceAmount(e.target.value)}
              />
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={applying || !invoiceId}>
                {applying ? "Applying…" : "Apply"}
              </Button>
            </div>
          </form>
        )}
        {!ordersPending && to === "order" && (
          <form onSubmit={handleSubmit(onSubmit)} className="space-y-2">
            {serverError && <p className="text-xs text-danger">{serverError}</p>}
            <div className="space-y-1">
              <Label className="text-xs" htmlFor={`${fieldId}-order`}>Order</Label>
              <Select id={`${fieldId}-order`} {...register("companyProductId")}>
                <option value="">Select an order…</option>
                {orders?.map((o) => (
                  <option key={o.id} value={o.id}>
                    {formatOrderId(o.orderSeq)} · {o.item.name} — due {formatCurrency(String(Math.max(o.balance, 0)))}
                  </option>
                ))}
              </Select>
              {errors.companyProductId && <p className="text-xs text-danger">{errors.companyProductId.message}</p>}
              {orders?.length === 0 && <p className="text-xs text-subtle">This company has no orders yet.</p>}
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor={`${fieldId}-amount`}>Amount to allocate</Label>
              <Input
                id={`${fieldId}-amount`}
                type="number"
                min={0.01}
                step="0.01"
                max={payment.unallocated}
                {...register("amount")}
              />
              {errors.amount && <p className="text-xs text-danger">{errors.amount.message}</p>}
            </div>
            <div className="flex justify-end gap-2 pt-1">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button type="submit" size="sm" disabled={isSubmitting || orders?.length === 0}>
                {isSubmitting ? "Allocating…" : "Allocate"}
              </Button>
            </div>
          </form>
        )}
      </Dialog>
    </>
  );
}
