"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { History } from "lucide-react";
import { recordPastOrder, type PastOrderInput } from "@/actions/past-order";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { SearchSelect } from "@/components/ui/search-select";
import { paymentTermsLabels } from "@/lib/gst";
import { orderBusinessTypeLabels } from "@/lib/validation/order";

/**
 * "Add past order" on a customer's Orders tab (owner, 23 Nov 2026 — TEMPORARY, src/actions/past-order.ts): the old
 * CRM's form, for an order the customer already has. Saved as done — no approval, purchase step or invoice.
 */

type Option = { id: string; name: string };

export function PastOrderButton({ companyId, items, locations, vendors }: { companyId: string; items: (Option & { sku?: string })[]; locations: { id: string; label: string; isPrimary: boolean }[]; vendors: Option[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const blankForm = (): PastOrderInput => ({
    companyId,
    itemId: "",
    quantity: "",
    poNumber: "",
    businessType: "NEW",
    tenantDomain: "",
    vendorId: "",
    locationId: locations.find((l) => l.isPrimary)?.id ?? locations[0]?.id ?? "",
    paymentTerms: undefined,
    notes: "",
    startDate: "",
    endDate: "",
    unitPrice: undefined,
  });
  const [form, setForm] = useState<PastOrderInput>(blankForm);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const set = (patch: Partial<PastOrderInput>) => setForm((f) => ({ ...f, ...patch }));

  const save = (another: boolean) =>
    start(async () => {
      setError(null);
      setSaved(null);
      const r = await recordPastOrder(form);
      if (!r.ok) return setError(r.error);
      router.refresh();
      if (another) {
        setForm(blankForm());
        setSaved("Saved — add the next one.");
      } else {
        setOpen(false);
        setForm(blankForm());
      }
    });

  return (
    <>
      <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>
        <History className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
        Add past order
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Add past order" wide>
        <form
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            save(false);
          }}
        >
          <p className="text-xs text-muted">
            An order this customer already has. It&apos;s saved as done — no approval, purchase step, invoice or emails — and comes up for renewal from its
            expiry date.
          </p>
          <div>
            <Label htmlFor="past-item">Product</Label>
            <SearchSelect id="past-item" value={form.itemId} onChange={(e) => set({ itemId: e.target.value })} required>
              <option value="">Select a product</option>
              {items.map((i) => (
                <option key={i.id} value={i.id}>
                  {i.name}
                  {i.sku ? ` (${i.sku})` : ""}
                </option>
              ))}
            </SearchSelect>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="past-qty">Quantity</Label>
              <Input id="past-qty" type="number" min={1} value={String(form.quantity)} onChange={(e) => set({ quantity: e.target.value })} placeholder="Enter quantity" required />
            </div>
            <div>
              <Label htmlFor="past-po">PO number</Label>
              <Input id="past-po" value={form.poNumber ?? ""} onChange={(e) => set({ poNumber: e.target.value })} placeholder="Enter PO number" maxLength={100} />
            </div>
            <div>
              <Label htmlFor="past-type">Product type</Label>
              <Select id="past-type" value={form.businessType} onChange={(e) => set({ businessType: e.target.value as NonNullable<PastOrderInput["businessType"]> })}>
                {(["NEW", "RENEWAL", "NEW_TO_US_RENEWAL"] as const).map((t) => (
                  <option key={t} value={t}>
                    {orderBusinessTypeLabels[t]}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="past-tenant">Domain / tenant</Label>
              <Input id="past-tenant" value={form.tenantDomain ?? ""} onChange={(e) => set({ tenantDomain: e.target.value })} placeholder="Enter domain tenant" maxLength={200} />
            </div>
            <div>
              <Label htmlFor="past-start">Start date</Label>
              <Input id="past-start" type="date" value={form.startDate} onChange={(e) => set({ startDate: e.target.value })} required />
            </div>
            <div>
              <Label htmlFor="past-end">Expiry date</Label>
              <Input id="past-end" type="date" value={form.endDate ?? ""} onChange={(e) => set({ endDate: e.target.value })} />
            </div>
            <div>
              <Label htmlFor="past-vendor">Vendor</Label>
              <SearchSelect id="past-vendor" value={form.vendorId ?? ""} onChange={(e) => set({ vendorId: e.target.value })}>
                <option value="">Select vendor</option>
                {vendors.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.name}
                  </option>
                ))}
              </SearchSelect>
            </div>
            <div>
              <Label htmlFor="past-price">Unit price (optional)</Label>
              <Input id="past-price" type="number" min={0} step="0.01" value={form.unitPrice === undefined ? "" : String(form.unitPrice)} onChange={(e) => set({ unitPrice: e.target.value === "" ? undefined : e.target.value })} placeholder="Leave blank if not known" />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="past-address">Address</Label>
              <Select id="past-address" value={form.locationId} onChange={(e) => set({ locationId: e.target.value })} required>
                {locations.length === 0 && <option value="">Add an address to this customer first</option>}
                {locations.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                    {l.isPrimary ? " (primary)" : ""}
                  </option>
                ))}
              </Select>
            </div>
            <div>
              <Label htmlFor="past-terms">Payment terms</Label>
              <Select id="past-terms" value={form.paymentTerms ?? ""} onChange={(e) => set({ paymentTerms: (e.target.value || undefined) as PastOrderInput["paymentTerms"] })}>
                <option value="">Select payment terms</option>
                {(["DUE_ON_RECEIPT", "ADVANCE", "NET_15", "NET_30", "NET_45", "NET_60"] as const).map((t) => (
                  <option key={t} value={t}>
                    {paymentTermsLabels[t]}
                  </option>
                ))}
              </Select>
            </div>
          </div>
          <div>
            <Label htmlFor="past-notes">Description</Label>
            <Textarea id="past-notes" rows={3} value={form.notes ?? ""} onChange={(e) => set({ notes: e.target.value })} placeholder="Enter description" maxLength={5000} />
          </div>
          {error && (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          )}
          {saved && <p className="text-sm text-success">{saved}</p>}
          <div className="flex flex-wrap justify-end gap-2">
            <Button type="button" variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" variant="secondary" disabled={pending} onClick={() => save(true)}>
              Save and add another
            </Button>
            <Button type="submit" disabled={pending}>
              {pending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      </Dialog>
    </>
  );
}
