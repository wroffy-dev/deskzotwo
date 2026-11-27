"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { paymentMethodLabels, paymentMethodValues } from "@/lib/gst";
import { formatCalendarDay } from "@/lib/time/zone";
import { useClock } from "@/components/time/clock-provider";
import { recordProformaAdvance } from "@/actions/proforma-advance";

/** An advance as the page receives it: plain data, its date as yyyy-mm-dd. */
export type ProformaAdvanceView = {
  paymentId: string;
  paymentSeq: number;
  amount: number;
  paidOn: string;
  method: string;
  reference: string | null;
  applied: { documentId: string; docNumber: string | null; amount: number }[];
  unapplied: number;
};

/**
 * The advances received against a proforma (owner, 17 Nov 2026), and the way to record one. The money waits on the
 * customer's account and goes onto the tax invoice raised from this proforma — or from the orders punched from it —
 * when that invoice is issued (src/lib/receivables/proforma-advance.ts).
 */
export function ProformaAdvances({
  proformaId,
  total,
  currency,
  advances,
  canRecord,
}: {
  proformaId: string;
  total: number;
  currency: string;
  advances: ProformaAdvanceView[];
  /** Records payments, in a plan with Payments, and the proforma is live. */
  canRecord: boolean;
}) {
  const router = useRouter();
  const clock = useClock();
  const [pending, startTransition] = useTransition();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const money = (value: number) => formatCurrency(value, currency);

  const received = Math.round(advances.reduce((t, a) => t + a.amount, 0) * 100) / 100;
  const toReceive = Math.max(0, Math.round((total - received) * 100) / 100);
  const waiting = Math.round(advances.reduce((t, a) => t + a.unapplied, 0) * 100) / 100;

  const [amount, setAmount] = useState(toReceive.toFixed(2));
  const [paidOn, setPaidOn] = useState(() => clock.today());
  const [method, setMethod] = useState("BANK_TRANSFER");
  const [reference, setReference] = useState("");
  const [notes, setNotes] = useState("");
  // One id per attempt: a double click or a retry is the advance already recorded (src/lib/request-once.ts).
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());

  if (advances.length === 0 && !canRecord) return null;

  function save() {
    setError(null);
    startTransition(async () => {
      const result = await recordProformaAdvance({ proformaId, amount, paidOn, method, reference, notes, requestId });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setOpen(false);
      setRequestId(crypto.randomUUID());
      setNotice(result.data.applied > 0 ? `Recorded — ${money(result.data.applied)} of it applied to the invoice raised from this proforma.` : "Recorded. It goes onto the tax invoice when that is issued.");
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span>Advance received</span>
        {received > 0 && toReceive < 0.01 ? <Badge tone="green">Received in full</Badge> : received > 0 ? <Badge tone="blue">Part received</Badge> : null}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div className="grid grid-cols-3 gap-2">
          <Figure label="Proforma" value={money(total)} />
          <Figure label="Received" value={money(received)} tone={received > 0 ? "success" : undefined} />
          <Figure label="To receive" value={money(toReceive)} />
        </div>
        {advances.length > 0 && (
          <ul className="divide-y divide-line">
            {advances.map((a) => (
              <li key={a.paymentId} className="py-2 first:pt-0 last:pb-0">
                <div className="flex items-baseline justify-between gap-2">
                  <span className="text-text">
                    {formatCalendarDay(a.paidOn)} · {a.reference || paymentMethodLabels[a.method as keyof typeof paymentMethodLabels] || a.method}
                  </span>
                  <span className="font-medium text-text">{money(a.amount)}</span>
                </div>
                <p className="text-xs text-muted">
                  {a.applied.map((x, i) => (
                    <span key={x.documentId}>
                      {i > 0 ? ", " : ""}
                      {money(x.amount)} on{" "}
                      <Link href={`/documents/${x.documentId}`} className="text-brand hover:underline">
                        {x.docNumber ?? "an invoice"}
                      </Link>
                    </span>
                  ))}
                  {a.applied.length > 0 && a.unapplied >= 0.01 ? " · " : ""}
                  {a.unapplied >= 0.01 ? `${money(a.unapplied)} waiting for the tax invoice` : null}
                </p>
              </li>
            ))}
          </ul>
        )}
        {waiting >= 0.01 && <p className="text-xs text-subtle">Held on the customer&apos;s account as an advance. It is applied to the tax invoice raised from this proforma, or from its orders, as soon as that invoice is issued.</p>}
        {notice && <p className="text-xs text-success">{notice}</p>}
        {canRecord && toReceive >= 0.01 && (
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              setAmount(toReceive.toFixed(2));
              setError(null);
              setNotice(null);
              setOpen(true);
            }}
          >
            Record advance
          </Button>
        )}
      </CardContent>

      <Dialog open={open} onClose={() => setOpen(false)} title="Record advance against this proforma">
        <div className="space-y-4">
          <p className="text-sm text-muted">Up to {money(toReceive)}. It waits on the customer&apos;s account and goes onto the tax invoice when that is issued.</p>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="advAmount">Amount</Label>
              <Input id="advAmount" type="number" step="0.01" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="advPaidOn">Received on</Label>
              <Input id="advPaidOn" type="date" max={clock.today()} value={paidOn} onChange={(e) => setPaidOn(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="advMethod">Method</Label>
              <Select id="advMethod" value={method} onChange={(e) => setMethod(e.target.value)}>
                {paymentMethodValues.map((m) => (
                  <option key={m} value={m}>
                    {paymentMethodLabels[m]}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="advReference">Reference</Label>
              <Input id="advReference" value={reference} onChange={(e) => setReference(e.target.value)} placeholder="UTR / cheque no." />
            </div>
            <div className="col-span-2 space-y-1.5">
              <Label htmlFor="advNotes">Notes</Label>
              <Textarea id="advNotes" rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} />
            </div>
          </div>
          {error && <p className="text-sm text-danger">{error}</p>}
          <div className="flex gap-2">
            <Button disabled={pending || !amount} onClick={save}>
              {pending ? "Saving…" : "Record advance"}
            </Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>
              Cancel
            </Button>
          </div>
        </div>
      </Dialog>
    </Card>
  );
}

function Figure({ label, value, tone }: { label: string; value: string; tone?: "success" }) {
  return (
    <div className="rounded-lg border border-line bg-surface-sunken px-3 py-2">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className={`mt-0.5 text-sm font-semibold ${tone === "success" ? "text-success" : "text-text"}`}>{value}</div>
    </div>
  );
}
