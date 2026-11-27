"use client";

import { useEffect, useState } from "react";
import { Download } from "lucide-react";
import { mayExportNewCustomers, type NewCustomer } from "@/actions/new-customers";
import { csvRow } from "@/lib/csv";

/**
 * The customers listed, as a CSV that opens in Excel (Performance › New customers).
 *
 * Security audit round three, 14 Nov 2026 (R3-19): the file is financial data, so the button shows only to
 * someone with Export financial data — asked of the server, not taken from the page.
 */
export function NewCustomersDownload({ rows, label, canExport }: { rows: NewCustomer[]; label: string; canExport?: boolean }) {
  const [allowed, setAllowed] = useState<boolean>(canExport ?? false);
  useEffect(() => {
    if (canExport !== undefined) return;
    let live = true;
    void mayExportNewCustomers()
      .then((yes) => live && setAllowed(yes))
      .catch(() => live && setAllowed(false));
    return () => {
      live = false;
    };
  }, [canExport]);
  if (rows.length === 0 || !allowed) return null;
  const download = () => {
    // Through the shared guard (security audit, 11 Nov 2026 — SEC-57): a name starting with = + - or @ opens as text, not a formula; numbers stay numbers.
    const quote = (v: string | number) => csvRow([v]);
    const lines = [
      ["Customer", "First billed", "Invoice", "Value", "Credited to", "As", "From earlier years"].map(quote).join(","),
      ...rows.map((c) => [c.name, c.at.slice(0, 10), c.number, c.value, c.person, c.creditFrom === "SALESPERSON" ? "Salesperson" : "Account manager", c.fromArchive ? "Yes" : "No"].map(quote).join(",")),
    ];
    // A byte-order mark first, so Excel reads the names as UTF-8.
    const url = URL.createObjectURL(new Blob([String.fromCharCode(0xfeff) + lines.join(String.fromCharCode(10))], { type: "text/csv;charset=utf-8" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `new-customers-${label.replace(/\W+/g, "-").toLowerCase()}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <button type="button" onClick={download} className="inline-flex items-center gap-1.5 rounded-base border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-sunken">
      <Download className="h-4 w-4" />
      Download for Excel
    </button>
  );
}
