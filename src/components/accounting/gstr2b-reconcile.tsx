"use client";

import { useRef, useState, useTransition } from "react";
import Link from "next/link";
import { FileDown, LoaderCircle, Upload } from "lucide-react";
import { reconcileGstr2bFile, type Gstr2bResult } from "@/actions/gstr2b";
import { MATCH_LABELS, type MatchRow, type MatchStatus } from "@/lib/ledger/gstr2b";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { formatCurrency } from "@/lib/utils";
import { sanitizeCsvCell } from "@/lib/csv";

const ORDER: MatchStatus[] = ["NOT_IN_2B", "NOT_IN_DESKZO", "AMOUNT_DIFFERS", "GSTIN_DIFFERS", "MATCHED"];
const TONE: Record<MatchStatus, "green" | "red" | "amber" | "default"> = { MATCHED: "green", NOT_IN_2B: "red", NOT_IN_DESKZO: "amber", AMOUNT_DIFFERS: "amber", GSTIN_DIFFERS: "amber" };
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

const taxOf = (x: { igst: number; cgst: number; sgst: number } | null) => (x ? x.igst + x.cgst + x.sgst : 0);
/**
 * Security audit round three, 14 Nov 2026 (tax lows): the vendor names and invoice numbers come from the vendors' own
 * filings, so a name starting "=" or "@" was a formula when the file opened in Excel. Text goes through the shared
 * guard (src/lib/csv.ts); numbers are written as they are, so a negative stays a number.
 */
const csvCell = (v: unknown) => {
  const s = typeof v === "number" ? String(v) : sanitizeCsvCell(String(v ?? ""));
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/**
 * GSTR-2B against the bills (owner, 29 Oct 2026; src/lib/ledger/gstr2b.ts): the portal's JSON uploaded and matched —
 * what the vendors reported that isn't entered, and what's entered that they didn't report — before GSTR-3B is filed.
 */
export function Gstr2bReconcile() {
  const input = useRef<HTMLInputElement>(null);
  const [result, setResult] = useState<Gstr2bResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showing, setShowing] = useState<MatchStatus | "ALL">("ALL");
  const [pending, start] = useTransition();

  const upload = (file: File) =>
    start(async () => {
      setError(null);
      if (file.size > 5_500_000) return setError("That file is over 5 MB — the portal's GSTR-2B JSON for a month is smaller. Is it the right file?");
      const r = await reconcileGstr2bFile(await file.text());
      if (input.current) input.current.value = "";
      if (!r.ok) return setError(r.error);
      setResult(r.data);
      setShowing("ALL");
    });

  const counts = new Map<MatchStatus, number>();
  for (const r of result?.rows ?? []) counts.set(r.status, (counts.get(r.status) ?? 0) + 1);
  const rows = (result?.rows ?? []).filter((r) => showing === "ALL" || r.status === showing).sort((a, b) => ORDER.indexOf(a.status) - ORDER.indexOf(b.status));
  const atRisk = (result?.rows ?? []).filter((r) => r.status === "NOT_IN_2B").reduce((t, r) => t + taxOf(r.bill), 0);
  const unclaimed = (result?.rows ?? []).filter((r) => r.status === "NOT_IN_DESKZO" && r.twoB?.itcAvailable).reduce((t, r) => t + taxOf(r.twoB), 0);

  const download = () => {
    if (!result) return;
    const head = ["Status", "Vendor GSTIN (2B)", "Vendor (2B)", "Invoice no. (2B)", "Date (2B)", "Taxable (2B)", "Tax (2B)", "ITC available", "Bill", "Vendor's no. on bill", "Vendor (Deskzo)", "GSTIN on bill", "Bill date", "Taxable (bill)", "Tax (bill)", "Note"];
    const line = (r: MatchRow) => [MATCH_LABELS[r.status], r.twoB?.supplierGstin, r.twoB?.supplierName, r.twoB?.number, r.twoB?.date, r.twoB?.taxableValue, r.twoB ? taxOf(r.twoB).toFixed(2) : "", r.twoB ? (r.twoB.itcAvailable ? "Y" : "N") : "", r.bill?.docNumber, r.bill?.reference, r.bill?.vendorName, r.bill?.vendorGstin, r.bill?.date, r.bill?.taxableValue, r.bill ? taxOf(r.bill).toFixed(2) : "", r.note];
    const text = [head, ...result.rows.map(line)].map((cells) => cells.map(csvCell).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([String.fromCharCode(0xfeff) + text], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `gstr2b-reconciliation-${result.gstin}-${result.year}-${String(result.month).padStart(2, "0")}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <Card className="mt-4 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-text">Reconcile with GSTR-2B</h2>
          <p className="mt-0.5 text-xs text-muted">
            Download GSTR-2B from the GST portal as JSON (Returns › GSTR-2B) and upload it: each vendor invoice is matched to a bill by the vendor&apos;s GSTIN and
            invoice number. Nothing is saved.
          </p>
        </div>
        <div className="flex gap-2">
          <input ref={input} type="file" accept=".json,application/json" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} aria-label="GSTR-2B JSON file" />
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => input.current?.click()}>
            {pending ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <Upload className="h-3.5 w-3.5" aria-hidden="true" />}
            Upload GSTR-2B JSON
          </Button>
          {result && (
            <Button type="button" size="sm" variant="ghost" onClick={download}>
              <FileDown className="h-3.5 w-3.5" aria-hidden="true" />
              CSV
            </Button>
          )}
        </div>
      </div>
      {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      {result && (
        <>
          <p className="mt-3 text-xs text-muted">
            {MONTHS[result.month - 1]} {result.year} · GSTIN {result.gstin} · {result.rows.filter((r) => r.twoB).length} vendor invoices in 2B, {result.billsLooked} bills looked at (this month and
            the three before, for late filings)
          </p>
          {(atRisk > 0 || unclaimed > 0) && (
            <p className="mt-1 text-sm text-text">
              {atRisk > 0 && <span className="text-danger">{formatCurrency(atRisk)} of credit on bills the vendors haven&apos;t reported. </span>}
              {unclaimed > 0 && <span className="text-warning">{formatCurrency(unclaimed)} of credit in 2B with no bill entered.</span>}
            </p>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            {(["ALL", ...ORDER] as const).map((s) => (
              <button key={s} type="button" onClick={() => setShowing(s)} className={`rounded-full border px-2.5 py-0.5 text-xs ${showing === s ? "border-primary bg-primary/10 text-text" : "border-line text-muted hover:text-text"}`}>
                {s === "ALL" ? `All (${result.rows.length})` : `${MATCH_LABELS[s]} (${counts.get(s) ?? 0})`}
              </button>
            ))}
          </div>
          <div className="mt-2 max-h-[28rem] overflow-auto">
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-surface text-left text-muted">
                <tr>
                  <th className="py-1.5 pr-2 font-medium">Status</th>
                  <th className="py-1.5 pr-2 font-medium">Vendor</th>
                  <th className="py-1.5 pr-2 font-medium">Invoice (2B)</th>
                  <th className="py-1.5 pr-2 font-medium">Bill in Deskzo</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Tax (2B)</th>
                  <th className="py-1.5 pr-2 text-right font-medium">Tax (bill)</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r, i) => (
                  <tr key={`${r.twoB?.supplierGstin}-${r.twoB?.number}-${r.bill?.id}-${i}`} className="align-top">
                    <td className="py-1.5 pr-2">
                      <Badge tone={TONE[r.status]}>{MATCH_LABELS[r.status]}</Badge>
                    </td>
                    <td className="py-1.5 pr-2">
                      <div className="text-text">{r.twoB?.supplierName || r.bill?.vendorName}</div>
                      <div className="font-mono text-muted">{r.twoB?.supplierGstin ?? r.bill?.vendorGstin}</div>
                    </td>
                    <td className="py-1.5 pr-2">{r.twoB ? `${r.twoB.number} · ${r.twoB.date}` : "—"}</td>
                    <td className="py-1.5 pr-2">
                      {r.bill ? (
                        <Link href={`/documents/${r.bill.id}`} className="text-text hover:underline">
                          {r.bill.reference || r.bill.docNumber} · {r.bill.date}
                        </Link>
                      ) : (
                        "—"
                      )}
                      {r.note && <div className="text-muted">{r.note}</div>}
                    </td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{r.twoB ? formatCurrency(taxOf(r.twoB)) : "—"}</td>
                    <td className="py-1.5 pr-2 text-right tabular-nums">{r.bill ? formatCurrency(taxOf(r.bill)) : "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {rows.length === 0 && <p className="py-3 text-center text-xs text-muted">Nothing here.</p>}
          </div>
          {result.notes.length > 0 && (
            <details className="mt-2 text-xs">
              <summary className="cursor-pointer text-muted">Credit and debit notes in 2B ({result.notes.length}) — not matched; check them against vendor credits</summary>
              <ul className="mt-1 divide-y divide-line">
                {result.notes.map((n, i) => (
                  <li key={`${n.supplierGstin}-${n.number}-${i}`} className="flex justify-between gap-2 py-1">
                    <span>
                      {n.kind === "CREDIT_NOTE" ? "Credit note" : "Debit note"} {n.number} · {n.supplierName || n.supplierGstin} · {n.date}
                    </span>
                    <span className="tabular-nums">{formatCurrency(taxOf(n))}</span>
                  </li>
                ))}
              </ul>
            </details>
          )}
        </>
      )}
    </Card>
  );
}
