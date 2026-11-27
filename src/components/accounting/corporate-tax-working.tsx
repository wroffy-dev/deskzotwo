"use client";

import { useState } from "react";
import { Amount } from "@/components/accounting/report-chrome";
import { Card } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { CT_ZERO_BAND, NO_ADJUSTMENTS, corporateTaxWorking, type CorporateTaxAdjustments } from "@/lib/corporate-tax";

type Field = { key: keyof CorporateTaxAdjustments; label: string; hint: string };

const ADD_BACKS: Field[] = [
  { key: "entertainment", label: "Entertainment", hint: "Of clients, suppliers and the like — half of it is added back." },
  { key: "finesAndPenalties", label: "Fines and penalties", hint: "All of it is added back." },
  { key: "nonQualifyingDonations", label: "Donations", hint: "To bodies that aren't qualifying public benefit entities." },
  { key: "otherAddBacks", label: "Other add-backs", hint: "Anything else your adviser adds back." },
];
const DEDUCTIONS: Field[] = [
  { key: "exemptIncome", label: "Exempt income", hint: "Qualifying dividends and participation gains already in the profit." },
  { key: "otherDeductions", label: "Other deductions", hint: "Anything else your adviser takes off." },
];

/**
 * The working, from the books' revenue and profit to the tax (src/lib/corporate-tax.ts). The adjustments are typed here
 * and kept nowhere: it is a working to file from, not a filing.
 */
export function CorporateTaxWorkingView({ revenue, accountingProfit, periodEnd }: { revenue: number; accountingProfit: number; periodEnd: string }) {
  const [adj, setAdj] = useState<Record<keyof CorporateTaxAdjustments, string>>(
    Object.fromEntries(Object.keys(NO_ADJUSTMENTS).map((k) => [k, ""])) as Record<keyof CorporateTaxAdjustments, string>,
  );
  const [elect, setElect] = useState(false);
  const [excluded, setExcluded] = useState(false);
  const num = (v: string) => {
    const n = Number(v.replace(/,/g, ""));
    return Number.isFinite(n) && n > 0 ? n : 0;
  };
  const w = corporateTaxWorking({
    revenue,
    accountingProfit,
    periodEnd,
    electRelief: elect,
    excludedFromRelief: excluded,
    adjustments: Object.fromEntries(Object.entries(adj).map(([k, v]) => [k, num(v)])) as CorporateTaxAdjustments,
  });

  const field = (f: Field) => (
    <div key={f.key} className="space-y-1">
      <Label htmlFor={`ct-${f.key}`}>{f.label}</Label>
      <Input id={`ct-${f.key}`} inputMode="decimal" value={adj[f.key]} onChange={(e) => setAdj({ ...adj, [f.key]: e.target.value })} placeholder="0" className="text-right" />
      <p className="text-xs text-subtle">{f.hint}</p>
    </div>
  );

  return (
    <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
      <div className="space-y-4">
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-medium text-text">Added back</h2>
          <div className="grid gap-3 sm:grid-cols-2">{ADD_BACKS.map(field)}</div>
        </Card>
        <Card className="space-y-3 p-4">
          <h2 className="text-sm font-medium text-text">Taken off</h2>
          <div className="grid gap-3 sm:grid-cols-2">{DEDUCTIONS.map(field)}</div>
        </Card>
        <Card className="space-y-2 p-4 text-sm">
          <h2 className="text-sm font-medium text-text">Small Business Relief</h2>
          <label className="flex items-start gap-2 text-text">
            <input type="checkbox" checked={excluded} onChange={(e) => setExcluded(e.target.checked)} className="mt-1" />
            <span>We are a Qualifying Free Zone Person, or part of a large multinational group</span>
          </label>
          <label className={`flex items-start gap-2 ${w.relief.available ? "text-text" : "text-subtle"}`}>
            <input type="checkbox" checked={elect && w.relief.available} disabled={!w.relief.available} onChange={(e) => setElect(e.target.checked)} className="mt-1" />
            <span>Elect Small Business Relief — taxable income is treated as nil</span>
          </label>
          <p className="text-xs text-subtle">
            {w.relief.why ?? "Revenue of AED 3,000,000 or less this period. It must also have been so in every earlier period — check that before electing."}
          </p>
        </Card>
      </div>

      <Card className="overflow-x-auto p-0">
        <table className="w-full text-sm">
          <tbody>
            <Row label="Revenue" value={w.revenue} />
            <Row label="Accounting profit" value={w.accountingProfit} />
            <Row label="Add-backs" value={w.addBacks} />
            <Row label="Deductions" value={-w.deductions} />
            <Row label="Taxable income" value={w.taxableIncome} bold />
            {w.relief.elected && <Row label="Small Business Relief elected — treated as nil" value={0} />}
            <Row label={`At 0% (the first AED ${CT_ZERO_BAND.toLocaleString("en-US")})`} value={w.zeroBand} />
            <Row label="At 9%" value={w.taxedAt9} />
            <Row label="Corporate Tax payable" value={w.tax} bold />
            {w.loss > 0 && <Row label="Tax loss to carry forward" value={w.loss} />}
          </tbody>
        </table>
      </Card>
    </div>
  );
}

function Row({ label, value, bold }: { label: string; value: number; bold?: boolean }) {
  return (
    <tr className="border-b border-line last:border-0">
      <td className={`px-4 py-2 ${bold ? "font-medium text-text" : "text-text"}`}>{label}</td>
      <td className="px-4 py-2 text-right">
        <Amount value={value} bold={bold} />
      </td>
    </tr>
  );
}
