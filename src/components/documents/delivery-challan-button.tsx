"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Loader2, Truck } from "lucide-react";
import { createDeliveryChallan, deliveryChallanSource, type ChallanSource } from "@/actions/delivery-challan";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { challanWords } from "@/lib/country-pack";

/**
 * "Create delivery challan" on an issued proposal, proforma or tax invoice (owner, 16 Nov 2026 — src/actions/delivery-challan.ts):
 * how many of each line go this time, what is left after earlier challans offered, and the challan issued at once.
 */
export function DeliveryChallanButton({ documentId }: { documentId: string }) {
  const router = useRouter();
  const words = challanWords();
  const [open, setOpen] = useState(false);
  const [source, setSource] = useState<ChallanSource | null>(null);
  const [qty, setQty] = useState<Record<number, string>>({});
  const [notes, setNotes] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, startLoading] = useTransition();
  const [saving, startSaving] = useTransition();

  const openDialog = () => {
    setOpen(true);
    setError(null);
    setSource(null);
    setNotes("");
    startLoading(async () => {
      const r = await deliveryChallanSource(documentId);
      if (!r.ok) return setError(r.error);
      setSource(r.data);
      setQty(Object.fromEntries(r.data.lines.map((l) => [l.sortOrder, String(l.left)])));
    });
  };

  const chosen = source ? source.lines.map((l) => ({ sortOrder: l.sortOrder, quantity: Number(qty[l.sortOrder] || 0) })).filter((l) => l.quantity > 0) : [];
  const over = source?.lines.find((l) => Number(qty[l.sortOrder] || 0) > l.left + 1e-9) ?? null;
  const nothingLeft = !!source && source.lines.every((l) => l.left <= 0);

  const create = () =>
    startSaving(async () => {
      setError(null);
      const r = await createDeliveryChallan({ documentId, lines: chosen, notes });
      if (!r.ok) return setError(r.error);
      setOpen(false);
      router.push(`/documents/${r.data.id}`);
    });

  return (
    <>
      <Button variant="secondary" onClick={openDialog}>
        <Truck className="mr-1.5 h-3.5 w-3.5" />
        Create {words.one}
      </Button>
      <Dialog open={open} onClose={() => !saving && setOpen(false)} title={`Create ${words.one}`} wide>
        {loading && (
          <p className="flex items-center gap-2 py-6 text-sm text-muted">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </p>
        )}
        {source && (
          <div className="space-y-4">
            <p className="text-sm text-muted">
              For {source.customer}, from {source.label.toLowerCase()} {source.number}. Enter how many of each line go this time; it is issued at once, with the same
              addresses, GSTINs and prices.
            </p>
            {source.challans.length > 0 && (
              <p className="text-xs text-muted">
                Already sent on{" "}
                {source.challans.map((c, i) => (
                  <span key={c.id}>
                    {i > 0 && ", "}
                    <Link href={`/documents/${c.id}`} className="text-brand hover:underline">
                      {c.number ?? words.one}
                    </Link>
                  </span>
                ))}
                .
              </p>
            )}
            <div className="overflow-x-auto rounded-base border border-line">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs text-muted">
                    <th className="px-3 py-2 font-medium">Item</th>
                    <th className="px-3 py-2 text-right font-medium">Ordered</th>
                    <th className="px-3 py-2 text-right font-medium">Sent</th>
                    <th className="w-32 px-3 py-2 font-medium">This {words.one}</th>
                  </tr>
                </thead>
                <tbody>
                  {source.lines.map((l) => (
                    <tr key={l.sortOrder} className="border-b border-line last:border-0">
                      <td className="px-3 py-2">
                        <div className="text-text">{l.name}</div>
                        {l.hsnCode && <div className="text-xs text-muted">HSN/SAC {l.hsnCode}</div>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted">
                        {l.ordered} {l.unit ?? ""}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums text-muted">{l.sent}</td>
                      <td className="px-3 py-2">
                        <Input
                          aria-label={`${l.name}: quantity on this ${words.one}`}
                          inputMode="decimal"
                          className="h-8 text-right tabular-nums"
                          value={qty[l.sortOrder] ?? ""}
                          disabled={saving || l.left <= 0}
                          onChange={(e) => setQty((prev) => ({ ...prev, [l.sortOrder]: e.target.value }))}
                        />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div className="space-y-1">
              <Label htmlFor="dc-notes">Notes (optional)</Label>
              <Textarea id="dc-notes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} maxLength={2000} placeholder="Vehicle, transporter, what it is for…" disabled={saving} />
            </div>
            {nothingLeft && <ActionNotice tone="error">Everything on this document has gone on {words.many} already.</ActionNotice>}
            {over && <ActionNotice tone="error">{over.name}: only {over.left} left to send.</ActionNotice>}
            {error && <ActionNotice tone="error">{error}</ActionNotice>}
            <div className="flex justify-end gap-2">
              <Button variant="ghost" onClick={() => setOpen(false)} disabled={saving}>
                Cancel
              </Button>
              <Button onClick={create} disabled={saving || chosen.length === 0 || !!over}>
                {saving ? "Creating…" : `Create and issue ${words.one}`}
              </Button>
            </div>
          </div>
        )}
        {!source && !loading && error && <ActionNotice tone="error">{error}</ActionNotice>}
      </Dialog>
    </>
  );
}
