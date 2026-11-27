"use client";

import { useRouter } from "next/navigation";
import { useEffect, useState, useTransition } from "react";
import { undoWriteOff, writeOffInvoice, writeOffPreview, type WriteOffPreview } from "@/actions/write-off";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { formatMoney } from "@/lib/currency";
import { formatCalendarDay } from "@/lib/time/zone";
import type { WriteOffView } from "@/lib/receivables/write-off";

/**
 * Writing an invoice off, on its payments panel (owner, 15 Nov 2026 — src/actions/write-off.ts): what's left goes to
 * Bad Debts, the invoice counts as settled, and in the UAE the VAT on it can be claimed back once its conditions are
 * met. Written off, the panel says so, and it can be undone — the customer paid after all.
 */
export function WriteOffControl({ invoiceId, writeOff, settled, canWriteOff }: { invoiceId: string; writeOff: WriteOffView | null; settled: boolean; canWriteOff: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<WriteOffPreview | null>(null);
  const [on, setOn] = useState("");
  const [reason, setReason] = useState("");
  const [notified, setNotified] = useState("");
  const [claim, setClaim] = useState(true);

  useEffect(() => {
    if (!open) return;
    let live = true;
    void writeOffPreview(invoiceId, on, notified || null).then((r) => {
      if (!live) return;
      if (!r.ok) return setError(r.error);
      setPreview(r.data);
      if (!on) setOn(r.data.today);
    });
    return () => {
      live = false;
    };
  }, [open, on, notified, invoiceId]);

  if (writeOff) {
    return (
      <div className="flex flex-wrap items-start justify-between gap-2 rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm">
        <div>
          <p className="font-medium text-text">
            Written off {formatMoney(writeOff.amount, writeOff.currency)} on {formatCalendarDay(writeOff.writtenOffOn)}
          </p>
          <p className="text-xs text-muted">
            {writeOff.reason}
            {writeOff.reliefVat > 0 ? ` · VAT relief claimed ${formatMoney(writeOff.reliefVat, writeOff.currency)}` : ""}
            {writeOff.customerNotifiedOn ? ` · customer told ${formatCalendarDay(writeOff.customerNotifiedOn)}` : ""}
          </p>
          {error && <p className="text-xs text-danger">{error}</p>}
        </div>
        {canWriteOff && (
          <Button
            size="sm"
            variant="ghost"
            disabled={pending}
            onClick={() =>
              start(async () => {
                setError(null);
                const r = await undoWriteOff(invoiceId);
                if (!r.ok) return setError(r.error);
                router.refresh();
              })
            }
          >
            Undo write-off
          </Button>
        )}
      </div>
    );
  }
  if (!canWriteOff || settled) return null;

  const save = () =>
    start(async () => {
      setError(null);
      const r = await writeOffInvoice({ invoiceId, writtenOffOn: on, reason, customerNotifiedOn: notified || null, claimRelief: !!preview?.uae && claim && preview.relief > 0 });
      if (!r.ok) return setError(r.error);
      setOpen(false);
      router.refresh();
    });

  return (
    <>
      <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
        Write off
      </Button>
      <Dialog open={open} onClose={() => setOpen(false)} title="Write off as bad debt">
        <div className="space-y-3 text-sm">
          <p className="text-muted">
            {preview ? formatMoney(preview.balance, preview.currency) : "What's left"} goes to Bad Debts and the invoice counts as settled: no more reminders or pay links. If the customer pays later, undo
            the write-off first, then record the payment.
            {preview && !preview.uae && " The GST on it isn't given back for a bad debt."}
          </p>
          <div>
            <Label htmlFor="wo-on">Written off on</Label>
            <Input id="wo-on" type="date" value={on} min={preview?.issueDate} max={preview?.today} onChange={(e) => setOn(e.target.value)} className="mt-1 w-44" />
          </div>
          <div>
            <Label htmlFor="wo-reason">Why</Label>
            <Textarea id="wo-reason" value={reason} onChange={(e) => setReason(e.target.value)} rows={2} className="mt-1" placeholder="The customer closed down · a dispute settled · too small to chase" />
          </div>
          {preview?.uae && (
            <div className="space-y-2 rounded-base border border-line p-3">
              <p className="font-medium text-text">VAT bad-debt relief</p>
              <p className="text-xs text-muted">The VAT on it can be claimed back on this period&apos;s VAT return once six months have passed since the invoice and the customer has been told how much is written off.</p>
              <div>
                <Label htmlFor="wo-told">Customer told on</Label>
                <Input id="wo-told" type="date" value={notified} max={preview.today} onChange={(e) => setNotified(e.target.value)} className="mt-1 w-44" />
              </div>
              {preview.relief > 0 ? (
                <label className="flex items-center gap-2 text-sm">
                  <input type="checkbox" checked={claim} onChange={(e) => setClaim(e.target.checked)} />
                  Claim {formatMoney(preview.relief, preview.currency)} VAT back
                </label>
              ) : (
                preview.reliefWhy && <p className="text-xs text-subtle">{preview.reliefWhy}</p>
              )}
            </div>
          )}
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button variant="danger" disabled={pending || !preview || reason.trim().length < 3} onClick={save}>
              {pending ? "Writing off…" : "Write off"}
            </Button>
          </div>
        </div>
      </Dialog>
    </>
  );
}
