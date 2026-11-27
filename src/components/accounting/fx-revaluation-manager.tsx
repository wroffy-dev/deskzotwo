"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Undo2 } from "lucide-react";
import type { getFxRevaluationPreview, listFxRevaluations } from "@/actions/fx-revaluation";
import { getFxRevaluationPreview as loadPreview, postFxRevaluation, undoFxRevaluation } from "@/actions/fx-revaluation";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { formatCurrency } from "@/lib/utils";
import { formatRate } from "@/lib/currency";
import { confirmAction } from "@/components/ui/confirm";

type Loaded = NonNullable<Awaited<ReturnType<typeof getFxRevaluationPreview>>>;
type Preview = NonNullable<Extract<Loaded, { notReady: false }>["preview"]>;
type History = Awaited<ReturnType<typeof listFxRevaluations>>;

const KIND_LABEL = { RECEIVABLE: "Receivable", PAYABLE: "Payable", BANK: "Bank" } as const;

/**
 * Revalue foreign balances (owner, 30 Oct 2026): pick a day, see what is open in each foreign currency at what the books
 * hold and at that day's closing rate, change a rate if the bank's differs, and post — the entry on the day and its
 * reversal the next. Below, every revaluation posted, and undo while its period is open.
 */
export function FxRevaluationManager({
  asOf: initialAsOf,
  initial,
  history,
  canPost,
}: {
  asOf: string;
  initial: Preview | null;
  history: History;
  canPost: boolean;
}) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [asOf, setAsOf] = useState(initialAsOf);
  const [preview, setPreview] = useState<Preview | null>(initial);
  const [rates, setRates] = useState<Record<string, string>>(() => ratesOf(initial));
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  function ratesOf(p: Preview | null): Record<string, string> {
    return Object.fromEntries((p?.totals.currencies ?? []).map((c) => [c.currency, c.rate === null ? "" : String(c.rate)]));
  }

  function recalculate(day = asOf, typed: Record<string, string> = rates) {
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await loadPreview({ asOf: day, rates: typed });
      if (!result || result.notReady) {
        setError("Revaluation isn't available here yet.");
        return;
      }
      if (result.error || !result.preview) {
        setError(result.error ?? "Could not read the balances.");
        return;
      }
      setPreview(result.preview as Preview);
      setRates(ratesOf(result.preview as Preview));
    });
  }

  function changeDay(day: string) {
    setAsOf(day);
    // A new day starts from that day's rates, not the last day's typed ones.
    if (day) recalculate(day, {});
    router.replace(`/accounting/books/revalue?asOf=${day}`, { scroll: false });
  }

  async function post() {
    if (!preview) return;
    const gain = preview.totals.gain;
    const ok = await confirmAction({
      title: `Revalue at ${asOf}?`,
      message: `Posts an unrealised ${gain >= 0 ? "gain" : "loss"} of ${formatCurrency(Math.abs(gain))} dated ${asOf}, and its reversal dated the next day.`,
      confirmLabel: "Post",
    });
    if (!ok) return;
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await postFxRevaluation({ asOf, rates });
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessage(`Posted ${result.data.entryNumber}, reversed by ${result.data.reversalNumber}.`);
      recalculate(asOf, rates);
      router.refresh();
    });
  }

  async function undo(id: string, day: string) {
    const ok = await confirmAction({
      title: `Undo the ${day} revaluation?`,
      message: "Its entry and the next day's reversal are removed.",
      confirmLabel: "Undo",
      danger: true,
    });
    if (!ok) return;
    setError(null);
    setMessage(null);
    startTransition(async () => {
      const result = await undoFxRevaluation(id);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      setMessage(`The ${day} revaluation was undone.`);
      if (day === asOf) recalculate(asOf, rates);
      router.refresh();
    });
  }

  const blocked = !preview || preview.locked || !!preview.existingId || preview.missingRates.length > 0 || preview.balances.every((b) => b.gain === 0);

  return (
    <div className="space-y-4">
      {error && <Card className="border-danger/40 bg-danger-bg px-4 py-3 text-sm text-danger">{error}</Card>}
      {message && <Card className="border-success/40 bg-success-bg px-4 py-3 text-sm text-success">{message}</Card>}

      <Card>
        <CardHeader className="text-sm font-medium text-text">Revalue at a day&apos;s closing rate</CardHeader>
        <CardContent className="space-y-4">
          <p className="text-sm text-muted">
            Invoices, credit notes and bills in another currency still open at the day, and the balance of each
            foreign-currency bank account, restated at that day&apos;s rate (AS 11 / Ind AS 21). The difference is posted to
            Unrealised Exchange Gain / (Loss) on the day and reversed the next, so the gain or loss when each one
            actually settles is still counted once, against the rate it was booked at.
          </p>
          <div className="flex flex-wrap items-end gap-3">
            <div className="space-y-1.5">
              <Label htmlFor="fxAsOf">As of</Label>
              <Input id="fxAsOf" type="date" value={asOf} onChange={(e) => changeDay(e.target.value)} />
            </div>
            <Button variant="secondary" disabled={pending || !asOf} onClick={() => recalculate()}>
              <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
              {pending ? "Working…" : "Recalculate"}
            </Button>
          </div>

          {preview && preview.locked && (
            <p className="rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
              The books are closed to this day or later — nothing can be posted into it.
            </p>
          )}
          {preview && preview.existingId && (
            <p className="rounded-base border border-warning/40 bg-warning-bg px-3 py-2 text-sm text-warning">
              Already revalued at {asOf}. Undo it below to post it again.
            </p>
          )}

          {preview && preview.totals.currencies.length === 0 && (
            <p className="text-sm text-subtle">Nothing in a foreign currency was open at the end of {asOf}.</p>
          )}

          {preview && preview.totals.currencies.length > 0 && (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[640px] text-sm">
                <thead>
                  <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-subtle">
                    <th className="py-2 pr-3">Currency</th>
                    <th className="py-2 pr-3">Closing rate</th>
                    <th className="py-2 pr-3 text-right">Receivables</th>
                    <th className="py-2 pr-3 text-right">Payables</th>
                    <th className="py-2 pr-3 text-right">Bank</th>
                    <th className="py-2 text-right">Gain / (loss)</th>
                  </tr>
                </thead>
                <tbody>
                  {preview.totals.currencies.map((c) => (
                    <tr key={c.currency} className="border-b border-line align-top">
                      <td className="py-2 pr-3 font-medium text-text">{c.currency}</td>
                      <td className="py-2 pr-3">
                        <Input
                          aria-label={`Closing rate for ${c.currency}`}
                          type="number"
                          step="0.000001"
                          min="0"
                          inputMode="decimal"
                          className="w-32"
                          value={rates[c.currency] ?? ""}
                          disabled={!canPost}
                          onChange={(e) => setRates((r) => ({ ...r, [c.currency]: e.target.value }))}
                        />
                        <span className="mt-0.5 block text-[11px] text-subtle">
                          {c.rate === null
                            ? "No rate for this day — enter one"
                            : c.rateSource === "entered"
                              ? "Entered here; kept as the day's rate when posted"
                              : `${c.rateSource === "typed" ? "Typed" : "Fetched"} for ${c.rateDay}`}
                        </span>
                      </td>
                      <Side foreign={c.receivables.foreign} booked={c.receivables.booked} revalued={c.receivables.revalued} currency={c.currency} />
                      <Side foreign={c.payables.foreign} booked={c.payables.booked} revalued={c.payables.revalued} currency={c.currency} />
                      <Side foreign={c.bank.foreign} booked={c.bank.booked} revalued={c.bank.revalued} currency={c.currency} />
                      <td className={`py-2 text-right tabular-nums ${c.gain < 0 ? "text-danger" : "text-text"}`}>{formatCurrency(c.gain)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <td colSpan={5} className="py-2 pr-3 text-right text-xs uppercase tracking-wide text-subtle">
                      Net unrealised {preview.totals.gain >= 0 ? "gain" : "loss"}
                    </td>
                    <td className={`py-2 text-right font-semibold tabular-nums ${preview.totals.gain < 0 ? "text-danger" : "text-text"}`}>
                      {formatCurrency(preview.totals.gain)}
                    </td>
                  </tr>
                </tfoot>
              </table>
              <p className="mt-2 text-xs text-subtle">
                Each figure is what is open in the currency, what the books hold for it (at the rates it was booked at), and
                that at the closing rate. Change a rate and recalculate before posting.
              </p>
            </div>
          )}

          {preview && preview.balances.length > 0 && (
            <details className="rounded-base border border-line px-3 py-2 text-sm">
              <summary className="cursor-pointer text-muted">The {preview.balances.length} balances behind it</summary>
              <ul className="mt-2 divide-y divide-line">
                {preview.balances.map((b) => (
                  <li key={`${b.kind}:${b.id}`} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                    <span>
                      <Badge tone={b.kind === "BANK" ? "blue" : "default"}>{KIND_LABEL[b.kind]}</Badge>{" "}
                      <span className="text-text">{b.label}</span>
                      {b.party && <span className="text-subtle"> · {b.party}</span>}
                    </span>
                    <span className="tabular-nums text-muted">
                      {formatCurrency(b.foreign, b.currency)} · {formatCurrency(b.booked)} → {formatCurrency(b.revalued)} at {formatRate(b.rate)}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          )}

          {canPost && preview && (
            <Button disabled={pending || blocked} onClick={post}>
              {pending ? "Posting…" : "Post the revaluation"}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Revaluations posted</CardHeader>
        <CardContent>
          {history.length === 0 ? (
            <p className="text-sm text-subtle">None yet.</p>
          ) : (
            <ul className="divide-y divide-line rounded-base border border-line">
              {history.map((h) => (
                <li key={h.id} className="flex flex-wrap items-center gap-3 px-3 py-2.5 text-sm">
                  <span className="font-medium text-text">{h.asOf}</span>
                  <span className={`tabular-nums ${h.net < 0 ? "text-danger" : "text-muted"}`}>
                    {h.net >= 0 ? "Gain" : "Loss"} {formatCurrency(Math.abs(h.net))}
                  </span>
                  <span className="text-xs text-subtle">
                    {Object.entries(h.rates).map(([c, r]) => `${c} ${r}`).join(" · ")}
                  </span>
                  <span className="font-mono text-xs text-subtle">
                    {h.entryNumber} / {h.reversalNumber}
                  </span>
                  {h.postedBy && <span className="text-xs text-subtle">by {h.postedBy}</span>}
                  {h.locked ? (
                    <Badge tone="green">Period closed</Badge>
                  ) : (
                    canPost && (
                      <Button size="sm" variant="ghost" className="ml-auto" disabled={pending} onClick={() => undo(h.id, h.asOf)}>
                        <Undo2 className="mr-1.5 h-3.5 w-3.5" />
                        Undo
                      </Button>
                    )
                  )}
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

function Side({ foreign, booked, revalued, currency }: { foreign: number; booked: number; revalued: number; currency: string }) {
  if (foreign === 0 && booked === 0) return <td className="py-2 pr-3 text-right text-subtle">—</td>;
  return (
    <td className="py-2 pr-3 text-right tabular-nums">
      <span className="block text-text">{formatCurrency(foreign, currency)}</span>
      <span className="block text-xs text-subtle">{formatCurrency(booked)} booked</span>
      <span className="block text-xs text-muted">{formatCurrency(revalued)} at close</span>
    </td>
  );
}
