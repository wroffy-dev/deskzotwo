"use client";

import { Download } from "lucide-react";
import { Button } from "@/components/ui/button";

/** The VAT 201's boxes as a CSV, to type into (or keep beside) the FTA's EmaraTax form. */
export function VatReturnCsv({ csv, fileName }: { csv: string; fileName: string }) {
  return (
    <Button
      type="button"
      size="sm"
      variant="secondary"
      onClick={() => {
        const url = URL.createObjectURL(new Blob([csv], { type: "text/csv;charset=utf-8" }));
        const a = document.createElement("a");
        a.href = url;
        a.download = fileName;
        a.click();
        URL.revokeObjectURL(url);
      }}
    >
      <Download className="mr-1.5 h-3.5 w-3.5" />
      Download CSV
    </Button>
  );
}
