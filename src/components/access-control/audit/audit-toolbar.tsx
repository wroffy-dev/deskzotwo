"use client";

import { useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Download } from "lucide-react";
import { exportPermissionChangesCsv, type PermissionChangeFilters } from "@/actions/access-control-audit";
import { exportUnmaskEventsCsv, type UnmaskLogFilters } from "@/actions/unmask-log";
import { useClock } from "@/components/time/clock-provider";
import { toast } from "@/components/ui/toast";
import { csvFilename } from "@/lib/csv";
import { acButton } from "@/components/access-control/ui";
import { AUDIT_FILTER_PARAMS } from "./kinds";

type ExportSource = { log: "permissions"; filters: PermissionChangeFilters } | { log: "pii"; filters: UnmaskLogFilters };

/**
 * Export CSV: everything the filters match in the log on screen, not just the page shown. The server
 * decides again whether this person may take it out, applies its row limits, and logs the export.
 *
 * `blocked` is why the button is there but can't be pressed — said in its tooltip, so somebody without
 * the export permission learns which one it is rather than meeting a toast.
 */
export function AuditExportButton({ source, total, blocked }: { source: ExportSource; total: number; blocked?: string }) {
  const clock = useClock();
  const [pending, start] = useTransition();

  const exportCsv = () =>
    start(async () => {
      const result = source.log === "pii" ? await exportUnmaskEventsCsv(source.filters) : await exportPermissionChangesCsv(source.filters);
      if (!result.ok) {
        toast.error(result.error);
        return;
      }
      const blob = new Blob([result.data.csv], { type: "text/csv;charset=utf-8" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = csvFilename(source.log === "pii" ? "unmasking-logs" : "access-audit-log", new Date(), clock);
      a.click();
      URL.revokeObjectURL(url);
      if (result.data.capped) toast.info(`The file holds the newest ${result.data.rows.toLocaleString("en-IN")} of ${total.toLocaleString("en-IN")} — narrow the dates for the rest.`);
      else toast.success(`Exported ${result.data.rows.toLocaleString("en-IN")} ${result.data.rows === 1 ? "row" : "rows"}`);
    });

  return (
    <button type="button" onClick={exportCsv} disabled={pending || total === 0 || !!blocked} title={blocked} className={acButton.secondary}>
      <Download className="h-[18px] w-[18px]" aria-hidden />
      {pending ? "Exporting…" : "Export CSV"}
    </button>
  );
}

/** "Clear filters": every filter off, the category kept. Drawn only while something is filtered. */
export function AuditClearFilters() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const filtered = (key: string) => (AUDIT_FILTER_PARAMS as readonly string[]).includes(key);
  if (![...searchParams.entries()].some(([key, value]) => !!value && filtered(key))) return null;
  return (
    <button
      type="button"
      onClick={() => {
        const next = new URLSearchParams(searchParams.toString());
        for (const key of [...next.keys()]) if (filtered(key) || key === "page") next.delete(key);
        const query = next.toString();
        router.push(query ? `${pathname}?${query}` : pathname);
      }}
      className="inline-flex h-7 shrink-0 items-center rounded-md px-2 text-xs font-semibold text-brand hover:bg-brand-subtle"
    >
      Clear filters
    </button>
  );
}
