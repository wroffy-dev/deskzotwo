"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileText, Pencil, Plus, Trash2 } from "lucide-react";
import { invoiceBillingStage, invoiceQuoteRemainder, invoiceQuoteShare, saveBillingStages } from "@/actions/progress-billing";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Select } from "@/components/ui/input";
import type { BillingProgress, StageStatus } from "@/lib/documents/progress-billing";

const STATUS: Record<StageStatus, { label: string; tone: "default" | "amber" | "blue" | "green" }> = {
  NOT_BILLED: { label: "Not billed", tone: "default" },
  DRAFT: { label: "Draft invoice", tone: "amber" },
  INVOICED: { label: "Invoiced", tone: "blue" },
  PAID: { label: "Paid", tone: "green" },
};

type Row = { id?: string; label: string; percent: string; locked: boolean };

/**
 * Bill in stages (owner, 3 Nov 2026 — progress invoicing, as Zoho has it; src/lib/documents/progress-billing.ts): a
 * quote's stages with what each bills and where it stands, an invoice raised for any stage, a one-off share, or what's
 * left — and how much of the quote is billed so far.
 */
export function BillInStages({ quoteId, progress, canBill }: { quoteId: string; progress: BillingProgress; canBill: boolean }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [rows, setRows] = useState<Row[]>([]);
  const [share, setShare] = useState("");
  const [unit, setUnit] = useState<"percent" | "amount">("percent");
  const money = (n: number) => new Intl.NumberFormat("en-IN", { style: "currency", currency: progress.currency, maximumFractionDigits: 2 }).format(n);
  const left = Math.max(0, progress.total - progress.billed);

  const open = (r: { ok: boolean; error?: string; data?: { id: string } }) => {
    if (!r.ok) return setError(r.error ?? "That didn't work.");
    if (r.data?.id) router.push(`/documents/${r.data.id}`);
    else router.refresh();
  };
  const act = (work: () => Promise<{ ok: boolean; error?: string; data?: unknown }>) =>
    start(async () => {
      setError(null);
      open((await work()) as { ok: boolean; error?: string; data?: { id: string } });
    });

  const startEditing = () => {
    setRows(
      progress.stages.length
        ? progress.stages.map((s) => ({ id: s.id, label: s.label, percent: String(s.percent), locked: s.status !== "NOT_BILLED" }))
        : [
            { label: "Advance", percent: "30", locked: false },
            { label: "On delivery", percent: "50", locked: false },
            { label: "On sign-off", percent: "20", locked: false },
          ],
    );
    setEditing(true);
  };
  const sum = rows.reduce((t, r) => t + (Number(r.percent) || 0), 0);
  const save = () =>
    start(async () => {
      setError(null);
      const r = await saveBillingStages(quoteId, rows.map((x) => ({ id: x.id, label: x.label, percent: Number(x.percent) })));
      if (!r.ok) return setError(r.error);
      setEditing(false);
      router.refresh();
    });

  return (
    <Card className="mt-4">
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-sm font-medium text-text">Bill in stages</span>
        {canBill && !editing && (
          <Button size="sm" variant="secondary" onClick={startEditing} disabled={pending}>
            <Pencil className="mr-1.5 h-3.5 w-3.5" aria-hidden /> {progress.stages.length ? "Change stages" : "Set stages"}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <div>
          <p className="text-text">
            Billed <span className="font-semibold">{money(progress.billed)}</span> of {money(progress.total)} ({progress.billedPercent}%) ·{" "}
            <span className="text-muted">{money(left)} left</span>
          </p>
          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface-sunken" aria-hidden>
            <div className="h-full bg-brand" style={{ width: `${Math.min(100, progress.billedPercent)}%` }} />
          </div>
        </div>

        {!editing && progress.stages.length > 0 && (
          <ul className="divide-y divide-line rounded-lg border border-line">
            {progress.stages.map((s) => (
              <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2">
                <span className="min-w-32 flex-1 font-medium text-text">{s.label}</span>
                <span className="tabular-nums text-muted">{s.percent}%</span>
                <span className="w-28 text-right tabular-nums text-text">{money(s.amount)}</span>
                <Badge tone={STATUS[s.status].tone}>{STATUS[s.status].label}</Badge>
                {s.invoice ? (
                  <Link href={`/documents/${s.invoice.id}`} className="text-xs text-brand hover:underline">
                    {s.invoice.docNumber ?? "Open"}
                  </Link>
                ) : (
                  canBill && (
                    <Button size="sm" disabled={pending} onClick={() => act(() => invoiceBillingStage(s.id))}>
                      <FileText className="mr-1.5 h-3.5 w-3.5" aria-hidden /> Create invoice
                    </Button>
                  )
                )}
              </li>
            ))}
          </ul>
        )}

        {editing && (
          <div className="space-y-2">
            {rows.map((r, n) => (
              <div key={r.id ?? `new-${n}`} className="flex items-center gap-2">
                <Input aria-label="Stage" value={r.label} disabled={r.locked} onChange={(e) => setRows((all) => all.map((x, i) => (i === n ? { ...x, label: e.target.value } : x)))} placeholder="Advance" />
                <Input aria-label="Share, %" value={r.percent} disabled={r.locked} inputMode="decimal" className="w-24" onChange={(e) => setRows((all) => all.map((x, i) => (i === n ? { ...x, percent: e.target.value } : x)))} />
                <span className="text-muted">%</span>
                <button
                  type="button"
                  disabled={r.locked}
                  title={r.locked ? "Invoiced already" : "Remove"}
                  aria-label="Remove stage"
                  onClick={() => setRows((all) => all.filter((_, i) => i !== n))}
                  className="inline-grid h-8 w-8 place-items-center rounded-base text-subtle hover:bg-danger-bg hover:text-danger disabled:opacity-40"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </button>
              </div>
            ))}
            <div className="flex flex-wrap items-center gap-2">
              <Button size="sm" variant="ghost" onClick={() => setRows((all) => [...all, { label: "", percent: String(Math.max(0, 100 - sum)), locked: false }])}>
                <Plus className="mr-1 h-3.5 w-3.5" aria-hidden /> Add a stage
              </Button>
              <span className={`text-xs ${sum > 100.01 ? "text-danger" : "text-muted"}`}>Comes to {Math.round(sum * 1000) / 1000}% of the quote</span>
              <span className="flex-1" />
              <Button size="sm" variant="ghost" onClick={() => setEditing(false)} disabled={pending}>
                Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={pending || sum > 100.01}>
                {pending ? "Saving…" : "Save stages"}
              </Button>
            </div>
          </div>
        )}

        {canBill && !editing && progress.leftPercent > 0 && (
          <div className="flex flex-wrap items-center gap-2 border-t border-line pt-3">
            <span className="text-xs text-muted">Or invoice</span>
            <Input aria-label="Share to invoice" value={share} onChange={(e) => setShare(e.target.value)} inputMode="decimal" placeholder={unit === "percent" ? "25" : "50000"} className="w-28" />
            <Select aria-label="Percent or amount" value={unit} onChange={(e) => setUnit(e.target.value as "percent" | "amount")} className="w-24">
              <option value="percent">%</option>
              <option value="amount">{progress.currency}</option>
            </Select>
            <Button size="sm" variant="secondary" disabled={pending || !(Number(share) > 0)} onClick={() => act(() => invoiceQuoteShare(quoteId, unit === "percent" ? { percent: Number(share) } : { amount: Number(share) }))}>
              Invoice it
            </Button>
            {progress.billedPercent > 0 && (
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => act(() => invoiceQuoteRemainder(quoteId))}>
                Invoice what&apos;s left ({progress.leftPercent}%)
              </Button>
            )}
          </div>
        )}

        {error && <p className="text-xs text-danger">{error}</p>}
      </CardContent>
    </Card>
  );
}
