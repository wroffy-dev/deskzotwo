import { Badge } from "@/components/ui/card";
import { gstinStatusLabels, gstinStatusTone, type GstinCheckView } from "@/lib/gstin/notes";

/** A GSTIN's standing as last checked with the GST system (src/lib/gstin), beside the number; "not checked" when it never was. */
export function GstinBadge({ check }: { check: GstinCheckView | null }) {
  if (!check) return <span className="font-sans text-[11px] text-subtle">not checked with GST</span>;
  return (
    <span className="inline-flex items-center gap-1 font-sans" title={check.source === "mock" ? "Checked with the mock portal, not the GST system" : "Checked with the GST system"}>
      <Badge tone={gstinStatusTone[check.status]}>{gstinStatusLabels[check.status]}</Badge>
      {check.blocked && <Badge tone="red">E-way bills blocked</Badge>}
    </span>
  );
}
