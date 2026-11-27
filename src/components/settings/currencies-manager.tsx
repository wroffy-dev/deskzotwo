"use client";

import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { fetchRatesNow, setTypedRate, type CurrenciesView } from "@/actions/currencies";
import { formatRate } from "@/lib/currency";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Select } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";

/**
 * Settings › Currencies (owner, 30 Oct 2026): the day's rate per currency in use, typing a rate for a day, fetching now,
 * and the rates kept lately. A rate is base per unit — "1 USD = ₹83.25" — as on every document.
 */
export function CurrenciesManager({ view }: { view: CurrenciesView }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const [currency, setCurrency] = useState(view.inUse[0]?.code ?? view.choices[0]?.code ?? "");
  const [day, setDay] = useState(view.today);
  const [rate, setRate] = useState("");

  function run(fn: () => Promise<{ ok: true } | { ok: false; error: string }>, done: string, reset?: () => void) {
    setNotice(null);
    startTransition(async () => {
      const r = await fn();
      if (!r.ok) {
        setNotice({ tone: "error", text: r.error });
        return;
      }
      reset?.();
      setNotice({ tone: "success", text: done });
      router.refresh();
    });
  }

  function fetchNow() {
    setNotice(null);
    startTransition(async () => {
      const r = await fetchRatesNow();
      if (!r.ok) {
        setNotice({ tone: "error", text: r.error });
        return;
      }
      const { fetched, failed } = r.data;
      setNotice({
        tone: failed.length > 0 ? "error" : "success",
        text:
          (fetched > 0 ? `Fetched ${fetched} rate${fetched === 1 ? "" : "s"}.` : "Nothing new to fetch.") +
          (failed.length > 0 ? ` Couldn't find a rate for ${failed.join(", ")} — type it below.` : "") +
          " Rates you typed were left as they are.",
      });
      router.refresh();
    });
  }

  if (!view.migrated) {
    return <p className="text-sm text-muted">Exchange rates arrive with the next update of this workspace.</p>;
  }

  return (
    <div className="space-y-6">
      {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}

      <Card className="overflow-x-auto p-0">
        <CardHeader className="flex flex-wrap items-center justify-between gap-3 text-sm font-semibold text-text">
          <span>Today&apos;s rates ({view.today})</span>
          <Button size="sm" variant="secondary" disabled={pending || view.inUse.length === 0} onClick={fetchNow}>
            <RefreshCw className="h-3.5 w-3.5" /> Fetch now
          </Button>
        </CardHeader>
        {view.inUse.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted">
            No customer, vendor or document of the last year is in another currency yet. Set a currency on a company, or
            type a rate below.
          </p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-y border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2">Currency</th>
                <th className="px-4 py-2">Rate</th>
                <th className="px-4 py-2">From</th>
              </tr>
            </thead>
            <tbody>
              {view.inUse.map((c) => (
                <tr key={c.code} className="border-b border-line last:border-0">
                  <td className="px-4 py-2">
                    <span className="text-text">{c.code}</span> <span className="text-xs text-subtle">{c.label}</span>
                  </td>
                  <td className="px-4 py-2 text-text">{c.rate ? `1 ${c.code} = ${formatRate(c.rate.rate)}` : "—"}</td>
                  <td className="px-4 py-2 text-xs text-muted">
                    {c.rate
                      ? `${c.rate.source === "typed" ? "Typed" : "Fetched"}${c.rate.day !== view.today ? `, for ${c.rate.day}` : ""}`
                      : "No rate in the last week — new documents for them start in " + view.base}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>

      <Card>
        <CardHeader className="text-sm font-semibold text-text">Type a rate</CardHeader>
        <CardContent className="space-y-3">
          <p className="text-sm text-muted">
            The bank&apos;s rate, or the one agreed. It counts for that day and the week after where no later rate is kept,
            and the daily fetch never overwrites it.
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
            <div className="space-y-1.5">
              <Label htmlFor="rate-currency">Currency</Label>
              <Select id="rate-currency" value={currency} onChange={(e) => setCurrency(e.target.value)}>
                {view.choices.map((c) => (
                  <option key={c.code} value={c.code}>
                    {c.code} — {c.label}
                  </option>
                ))}
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rate-day">Day</Label>
              <Input id="rate-day" type="date" value={day} onChange={(e) => setDay(e.target.value)} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="rate-value">
                {view.base} for 1 {currency}
              </Label>
              <Input id="rate-value" type="number" step="0.000001" min="0" value={rate} onChange={(e) => setRate(e.target.value)} />
            </div>
            <div className="flex items-end">
              <Button
                disabled={pending || !currency || !day || !(Number(rate) > 0)}
                onClick={() => run(() => setTypedRate({ currency, day, rate }), `Saved: 1 ${currency} = ${formatRate(Number(rate))} on ${day}.`, () => setRate(""))}
              >
                Save rate
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card className="overflow-x-auto p-0">
        <CardHeader className="text-sm font-semibold text-text">Recent rates</CardHeader>
        {view.history.length === 0 ? (
          <p className="px-4 pb-4 text-sm text-muted">None kept yet.</p>
        ) : (
          <table className="w-full text-sm">
            <thead className="border-y border-line text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2">Day</th>
                <th className="px-4 py-2">Currency</th>
                <th className="px-4 py-2">Rate</th>
                <th className="px-4 py-2">Source</th>
              </tr>
            </thead>
            <tbody>
              {view.history.map((h) => (
                <tr key={`${h.day}:${h.currency}`} className="border-b border-line last:border-0">
                  <td className="px-4 py-2 text-muted">{h.day}</td>
                  <td className="px-4 py-2 text-text">{h.currency}</td>
                  <td className="px-4 py-2 text-text">{formatRate(h.rate)}</td>
                  <td className="px-4 py-2 text-xs text-muted">{h.source === "typed" ? `Typed${h.setBy ? ` by ${h.setBy}` : ""}` : "Fetched"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
    </div>
  );
}
