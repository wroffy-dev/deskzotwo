"use client";

import { useState, useTransition } from "react";
import { Download } from "lucide-react";
import { exportExpenses } from "@/actions/expense";
import type { ExpenseListParams } from "@/actions/expense";
import { Button } from "@/components/ui/button";

/**
 * Downloads the expenses on screen as an Excel file (owner, 18 Nov 2026) — every claim the filters and the view hold,
 * not just this page. Shown to whoever holds `expenses.export`; the server checks it again, builds the file and logs
 * the download (src/actions/expense.ts `exportExpenses`). The browser only saves it.
 */
export function ExpenseExportButton({ filters }: { filters: ExpenseListParams }) {
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);

  function download() {
    setError(null);
    startTransition(async () => {
      const result = await exportExpenses(filters);
      if (!result.ok) {
        setError(result.error);
        return;
      }
      const bytes = Uint8Array.from(atob(result.data.base64), (c) => c.charCodeAt(0));
      const url = URL.createObjectURL(new Blob([bytes], { type: result.data.contentType }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.data.filename;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 30_000);
    });
  }

  return (
    <div className="flex flex-col items-end gap-1">
      <Button type="button" variant="secondary" size="sm" disabled={pending} onClick={download}>
        <Download aria-hidden="true" className="h-4 w-4" />
        {pending ? "Preparing…" : "Export Excel"}
      </Button>
      {error && (
        <span role="alert" className="max-w-xs text-right text-xs text-danger">
          {error}
        </span>
      )}
    </div>
  );
}
