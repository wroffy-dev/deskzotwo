"use client";

import { useState, useTransition } from "react";
import { FileDown, LoaderCircle } from "lucide-react";
import { gstr1PortalFile, gstr3bPortalFile, type PortalFile } from "@/actions/tax-reports";
import { Button } from "@/components/ui/button";

/**
 * GSTR-1 and GSTR-3B as the portal's JSON (owner, 29 Oct 2026; src/lib/ledger/gstn-json.ts): downloaded here, opened in
 * the GST offline tool or uploaded on the portal — checked there before it's filed.
 */
export function PortalJsonButtons({ month, year, gstRegistrationId }: { month: number; year: number; gstRegistrationId?: string }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<"1" | "3B" | null>(null);
  const [, start] = useTransition();
  const download = (which: "1" | "3B") =>
    start(async () => {
      setError(null);
      setBusy(which);
      const params = { month, year, gstRegistrationId };
      const result: PortalFile = which === "1" ? await gstr1PortalFile(params) : await gstr3bPortalFile(params);
      setBusy(null);
      if (!result.ok) return setError(result.error);
      const url = URL.createObjectURL(new Blob([result.json], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = result.filename;
      link.click();
      URL.revokeObjectURL(url);
    });
  return (
    <div className="flex flex-col items-end gap-1">
      <div className="flex flex-wrap gap-2">
        {(["1", "3B"] as const).map((w) => (
          <Button key={w} type="button" size="sm" variant="secondary" disabled={busy !== null} onClick={() => download(w)}>
            {busy === w ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : <FileDown className="h-3.5 w-3.5" aria-hidden="true" />}
            GSTR-{w} JSON
          </Button>
        ))}
      </div>
      <p className="text-xs text-muted">For the GST portal&apos;s Upload JSON — open it in the offline tool to check before filing.</p>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
