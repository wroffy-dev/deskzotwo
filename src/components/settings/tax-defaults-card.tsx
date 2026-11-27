"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil } from "lucide-react";
import { fillItemsWithoutRate, setDefaultTaxRate, type TaxDefaults } from "@/actions/tax-defaults";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/input";

/**
 * Settings › Taxes › Default tax rate (owner, 23 Nov 2026 — Zoho Books' Default Tax Preference): what a new item and a
 * new document line start with. One rate: whether it goes out as CGST + SGST or as IGST is the place of supply's to
 * decide on each document, as it always is. Items already saved keep their own; those with none can be given it.
 */
export function TaxDefaultsCard({ setting }: { setting: TaxDefaults }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [rate, setRate] = useState(String(setting.rate));
  const [said, setSaid] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  // Locked until the pencil is pressed (owner, 23 Nov 2026: "do the same lock for default rate in settings"), as on an item.
  const [editing, setEditing] = useState(false);
  const india = setting.taxName === "GST";
  const shown = setting.rate;
  const half = Math.round((shown / 2) * 1000) / 1000;

  function save() {
    setSaid(null);
    startTransition(async () => {
      const result = await setDefaultTaxRate({ rate: Number(rate) });
      if (!result.ok) {
        setSaid({ tone: "error", text: result.error });
        return;
      }
      setSaid({ tone: "success", text: `Saved. New items and document lines start at ${rate}%.` });
      setEditing(false);
      router.refresh();
    });
  }

  function fill() {
    setSaid(null);
    startTransition(async () => {
      const result = await fillItemsWithoutRate();
      if (!result.ok) {
        setSaid({ tone: "error", text: result.error });
        return;
      }
      const n = result.data.filled;
      setSaid({ tone: "success", text: n ? `${n} item${n === 1 ? "" : "s"} now at ${result.data.rate}%.` : "No item was without a rate." });
      router.refresh();
    });
  }

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Default {setting.taxName} rate</CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted">
          The rate a new item and a new line on a quote, order or invoice start with — changeable on each. Items already saved keep their own rate.
          {india && " Whether it goes out as CGST + SGST or as IGST is decided on each document by its place of supply."}
        </p>
        {!editing ? (
          <div className="max-w-md space-y-1.5">
            <span className="block text-[13px] font-medium text-muted">Rate</span>
            <div className="flex items-start justify-between gap-3 rounded-lg border border-line bg-surface-sunken px-3 py-2">
              <div className="min-w-0">
                <p className="text-sm font-medium text-text">
                  {shown}%{shown === setting.countryDefault ? " — the usual rate" : ""}
                </p>
                {india && (
                  <p className="text-xs text-muted">
                    {shown === 0 ? "No GST charged" : `Within your state CGST ${half}% + SGST ${half}% · to another state IGST ${shown}%`}
                  </p>
                )}
              </div>
              {setting.changeable && (
                <button
                  type="button"
                  onClick={() => {
                    setRate(String(setting.rate));
                    setSaid(null);
                    setEditing(true);
                    requestAnimationFrame(() => document.getElementById("default-tax-rate")?.focus());
                  }}
                  className="shrink-0 rounded-md p-1.5 text-muted hover:bg-surface hover:text-text"
                  aria-label={`Change the default ${setting.taxName} rate`}
                  title={`Change the default ${setting.taxName} rate`}
                >
                  <Pencil className="h-4 w-4" aria-hidden="true" />
                </button>
              )}
            </div>
            {said && (
              <p role={said.tone === "error" ? "alert" : "status"} className={said.tone === "error" ? "text-sm text-danger" : "text-sm text-success"}>
                {said.text}
              </p>
            )}
          </div>
        ) : (
          <>
            <div className="max-w-xs space-y-1.5">
              <Label htmlFor="default-tax-rate">Rate</Label>
              <Select
                id="default-tax-rate"
                value={rate}
                onChange={(e) => {
                  setRate(e.target.value);
                  setSaid(null);
                }}
                disabled={pending}
              >
                {setting.rates.map((r) => (
                  <option key={r} value={String(r)}>
                    {r}%{r === setting.countryDefault ? " — the usual rate" : ""}
                  </option>
                ))}
              </Select>
              {india && <p className="text-xs text-subtle">Since 22 September 2025 most goods and services are at 5% or 18%, and a few at 40%.</p>}
            </div>
            <div className="flex flex-wrap items-center gap-3">
              <Button type="button" onClick={save} disabled={pending || rate === String(setting.rate)}>
                {pending ? "Saving…" : "Save rate"}
              </Button>
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setEditing(false);
                  setRate(String(setting.rate));
                  setSaid(null);
                }}
                disabled={pending}
              >
                Cancel
              </Button>
              {said && (
                <span role={said.tone === "error" ? "alert" : "status"} className={said.tone === "error" ? "text-sm text-danger" : "text-sm text-success"}>
                  {said.text}
                </span>
              )}
            </div>
          </>
        )}
        {!setting.changeable && <p className="text-sm text-muted">This workspace&apos;s default rate is set in its server&apos;s configuration.</p>}
        {setting.itemsWithoutRate > 0 && (
          <div className="rounded-lg border border-line bg-surface-sunken px-4 py-3 text-sm">
            <p className="text-text">
              {setting.itemsWithoutRate} item{setting.itemsWithoutRate === 1 ? " has" : "s have"} no {setting.taxName} rate.
            </p>
            <p className="mt-0.5 text-muted">
              Give {setting.itemsWithoutRate === 1 ? "it" : "them"} the default, {setting.rate}% — exempt, zero-rated and out-of-scope items are left alone.
              Check items that should be at another rate afterwards.
            </p>
            <Button type="button" variant="secondary" className="mt-2" onClick={fill} disabled={pending}>
              Give them {setting.rate}%
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
