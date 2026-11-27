import Link from "next/link";
import { CircleAlert, CircleCheck } from "lucide-react";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { documentPath } from "@/lib/trade-documents";
import { formatCurrency } from "@/lib/utils";
import type { BillPoCheck } from "@/lib/purchase/bill-check";

/**
 * "Checked against PO …" on a vendor's bill (owner, 16 Nov 2026 — src/lib/purchase/bill-check.ts): green when every
 * line agrees with our PO; otherwise each line that doesn't, what differs, and what it costs us over the PO.
 */
export function BillPoCheckCard({ check }: { check: BillPoCheck }) {
  const differing = check.rows.filter((r) => r.issues.length > 0);
  return (
    <Card className={check.matches ? undefined : "border-danger/40"}>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2 text-sm font-medium text-text">
        <span className="flex items-center gap-2">
          {check.matches ? <CircleCheck className="h-4 w-4 text-success" aria-hidden /> : <CircleAlert className="h-4 w-4 text-danger" aria-hidden />}
          Checked against our PO{" "}
          <Link href={documentPath(check.po.id)} className="font-mono text-brand hover:underline">
            {check.po.docNumber ?? "draft"}
          </Link>
          {check.how === "BY_REFERENCE" && <span className="text-xs font-normal text-subtle">· named in the bill&apos;s reference</span>}
        </span>
        {check.matches ? (
          <Badge tone="green">Matches our PO</Badge>
        ) : (
          <Badge tone="red">
            {differing.length} {differing.length === 1 ? "line differs" : "lines differ"}
            {check.extra > 0 ? ` · ${formatCurrency(check.extra)} over` : ""}
          </Badge>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {check.matches ? (
          <p className="text-muted">Every line is an item on the PO, within what it has left to bill, at its price and GST rate.</p>
        ) : (
          <ul className="divide-y divide-line">
            {differing.map((r) => (
              <li key={r.name} className="py-2 first:pt-0">
                <div className="flex flex-wrap items-baseline justify-between gap-2">
                  <span className="font-medium text-text">{r.name}</span>
                  <span className="text-xs tabular-nums text-muted">
                    Billed {r.billed?.quantity} × {formatCurrency(r.billed?.unitNet ?? 0)}
                    {r.ordered ? ` · PO ${r.ordered.quantity} × ${formatCurrency(r.ordered.unitNet)}` : ""}
                  </span>
                </div>
                <ul className="mt-1 space-y-0.5">
                  {r.issues.map((i) => (
                    <li key={i.kind} className={`text-xs ${i.kind === "TAX_RATE" || i.kind === "ABOVE_DEAL_PRICE" ? "text-warning" : "text-danger"}`}>
                      {i.text}
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
        {check.notBilledYet.length > 0 && (
          <p className="text-xs text-subtle">
            On the PO, not on this bill: {check.notBilledYet.join(", ")} — to come on a later bill, or not at all.
          </p>
        )}
        {!check.matches && <p className="text-xs text-subtle">Take it up with the vendor before paying: a corrected bill, or a credit note for the difference.</p>}
      </CardContent>
    </Card>
  );
}
