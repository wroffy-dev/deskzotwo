"use client";

import { useState } from "react";
import { exportLeadsCsv } from "@/actions/lead";
import { Button } from "@/components/ui/button";

export function ExportLeadsButton() {
  const [isExporting, setIsExporting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function handleExport() {
    setError(null);
    setIsExporting(true);
    const result = await exportLeadsCsv();
    setIsExporting(false);
    if (!result.ok) {
      setError(result.error);
      return;
    }

    const blob = new Blob([result.data.csv], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = result.data.filename;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  return (
    <div className="flex flex-col items-end gap-1">
      {/* "Export" on the button (owner, 29 Oct 2026: one compact header row); what it makes is in its name. */}
      <Button type="button" variant="secondary" size="sm" onClick={handleExport} disabled={isExporting} aria-label={isExporting ? "Exporting CSV…" : "Export CSV"} title="Download the leads you can see as a CSV">
        {isExporting ? "Exporting…" : "Export"}
      </Button>
      {error && <span className="text-xs text-danger">{error}</span>}
    </div>
  );
}
