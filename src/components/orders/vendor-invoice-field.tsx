"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { Pencil } from "lucide-react";
import { setVendorInvoice } from "@/actions/order-vendor-invoice";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import type { VendorInvoice } from "@/lib/orders/vendor-invoice";

/**
 * The vendor's invoice on the order's details (owner, 16 Nov 2026 — src/lib/orders/vendor-invoice.ts): its number and
 * what it billed before GST, checked against quantity × purchase price. Typed by purchasing or whoever approves orders,
 * at any stage — fulfilled too; read from a vendor bill in Deskzo where there is one.
 */
export function VendorInvoiceField({ orderId, invoice, expected, canEdit }: { orderId: string; invoice: VendorInvoice | null; expected: number | null; canEdit: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [editing, setEditing] = useState(false);
  const [number, setNumber] = useState(invoice?.fromBill ? "" : (invoice?.number ?? ""));
  const [amount, setAmount] = useState(invoice?.fromBill || invoice?.amount === null || invoice?.amount === undefined ? "" : String(invoice.amount));
  const [error, setError] = useState<string | null>(null);
  const fromBill = invoice?.fromBill ?? null;

  const save = () =>
    start(async () => {
      setError(null);
      const r = await setVendorInvoice(orderId, { number, amount });
      if (!r.ok) return setError(r.error);
      setEditing(false);
      router.refresh();
    });

  if (editing && !fromBill) {
    return (
      <div className="basis-full space-y-1.5 rounded-base border border-line bg-surface-sunken p-2.5">
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs text-muted">
            Invoice number
            <Input value={number} onChange={(e) => setNumber(e.target.value)} placeholder="INGM/24-25/10234" className="mt-1 h-8 w-48" autoFocus />
          </label>
          <label className="text-xs text-muted">
            Billed, before GST (₹)
            <Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={expected !== null ? String(expected) : "0.00"} className="mt-1 h-8 w-36" onKeyDown={(e) => e.key === "Enter" && save()} />
          </label>
          <Button size="sm" disabled={pending} onClick={save}>
            Save
          </Button>
          <Button size="sm" variant="ghost" disabled={pending} onClick={() => setEditing(false)}>
            Cancel
          </Button>
        </div>
        {expected !== null && <p className="text-xs text-subtle">Expected {formatCurrency(expected)} — quantity × purchase price.</p>}
        {error && <p className="text-xs text-danger">{error}</p>}
      </div>
    );
  }

  return (
    <span className="flex flex-wrap items-baseline justify-end gap-x-2 gap-y-0.5 text-right">
      {invoice ? (
        <>
          <span className="text-text">{invoice.number ?? "—"}</span>
          {invoice.amount !== null && <span className="tabular-nums text-text">{formatCurrency(invoice.amount)}</span>}
          <Verdict invoice={invoice} />
          {fromBill && (
            <Link href={`/documents/${fromBill.id}`} className="text-xs text-brand hover:underline">
              from the bill
            </Link>
          )}
        </>
      ) : (
        <span className={canEdit ? "text-subtle" : "text-text"}>{canEdit ? "Not added yet" : "—"}</span>
      )}
      {canEdit && !fromBill && (
        <button type="button" onClick={() => setEditing(true)} className="self-center text-subtle hover:text-brand" aria-label={invoice ? "Change the vendor's invoice" : "Add the vendor's invoice"} title={invoice ? "Change" : "Add"}>
          <Pencil className="h-3.5 w-3.5" aria-hidden />
        </button>
      )}
    </span>
  );
}

/** Billed against expected: matches, or by how much it's off. */
export function Verdict({ invoice, compact = false }: { invoice: Pick<VendorInvoice, "difference">; compact?: boolean }) {
  if (invoice.difference === null) return null;
  if (Math.abs(invoice.difference) < 0.5) return <span className="text-xs text-success">{compact ? "matches" : "Matches the purchase price"}</span>;
  return invoice.difference > 0 ? (
    <span className="text-xs text-danger">{formatCurrency(invoice.difference)} more than expected</span>
  ) : (
    <span className="text-xs text-muted">{formatCurrency(-invoice.difference)} less than expected</span>
  );
}
