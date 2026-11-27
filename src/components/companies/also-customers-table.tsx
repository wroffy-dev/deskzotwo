"use client";

import { useState, useTransition } from "react";
import { CompanyLink } from "@/components/companies/company-link";
import { useRouter } from "next/navigation";
import { removeCustomerMarks } from "@/actions/also-customers";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { confirmAction } from "@/components/ui/confirm";
import type { AlsoCustomerRow } from "@/lib/companies/also-customers";
import { formatCompanyId } from "@/lib/order-id";
import { companyPath } from "@/lib/record-links";

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** What's on the customer side, in words: why this one isn't ticked. */
function salesInWords(row: AlsoCustomerRow): string {
  const parts = [
    row.orders > 0 && plural(row.orders, "order"),
    row.documents > 0 && plural(row.documents, "sales document"),
    row.paymentsIn > 0 && plural(row.paymentsIn, "payment received", "payments received"),
    row.leads > 0 && plural(row.leads, "lead"),
    row.archived > 0 && `${row.archived} in the archive`,
  ];
  return parts.filter(Boolean).join(", ");
}

/** The review list (src/lib/companies/also-customers.ts). Only a vendor with no sales can be ticked. */
export function AlsoCustomersTable({ rows }: { rows: AlsoCustomerRow[] }) {
  const router = useRouter();
  const removable = rows.filter((r) => r.noSales);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [pending, startTransition] = useTransition();
  const allPicked = removable.length > 0 && removable.every((r) => picked.has(r.id));

  function toggle(id: string) {
    setPicked((now) => {
      const next = new Set(now);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function remove() {
    const ids = [...picked];
    const sure = await confirmAction({
      title: `Take the customer mark off ${plural(ids.length, "vendor")}?`,
      message: "They stay as vendors, and leave the Customer list. You can add it back from a company's Roles card.",
      confirmLabel: "Take it off",
    });
    if (!sure) return;
    setMessage(null);
    startTransition(async () => {
      const result = await removeCustomerMarks(ids);
      if (!result.ok) {
        setMessage({ tone: "error", text: result.error });
        return;
      }
      setPicked(new Set());
      setMessage({
        tone: "ok",
        text: `${plural(result.removed, "vendor")} no longer marked as a customer.${result.skipped > 0 ? ` ${result.skipped} left alone: sold to since this page opened, or not yours to change.` : ""}`,
      });
      router.refresh();
    });
  }

  if (rows.length === 0) {
    return <Card className="mt-5 px-4 py-10 text-center text-sm text-muted">No vendor is marked as a customer.</Card>;
  }

  return (
    <div className="mt-5 space-y-3">
      {message && (
        <p role="status" className={`text-sm ${message.tone === "error" ? "text-danger" : "text-muted"}`}>
          {message.text}
        </p>
      )}
      {removable.length > 0 && (
        <div className="flex flex-wrap items-center gap-3">
          <label className="inline-flex items-center gap-2 text-sm text-text">
            <input type="checkbox" checked={allPicked} onChange={() => setPicked(allPicked ? new Set() : new Set(removable.map((r) => r.id)))} />
            All {removable.length} with no sales
          </label>
          <Button size="sm" variant="secondary" disabled={pending || picked.size === 0} onClick={remove}>
            {pending ? "Taking it off…" : picked.size > 0 ? `Take the mark off ${picked.size}` : "Take the mark off"}
          </Button>
        </div>
      )}
      <Card className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs uppercase tracking-wide text-subtle">
              <th className="w-10 px-4 py-2.5" aria-label="Pick" />
              <th className="px-4 py-2.5">Vendor</th>
              <th className="px-4 py-2.5">Sold to?</th>
              <th className="px-4 py-2.5">Marked by</th>
              <th className="px-4 py-2.5">Customer side with</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            {rows.map((row) => (
              <tr key={row.id}>
                <td className="px-4 py-2.5">
                  {row.noSales && <input type="checkbox" aria-label={`Pick ${row.name}`} checked={picked.has(row.id)} onChange={() => toggle(row.id)} />}
                </td>
                <td className="px-4 py-2.5">
                  <CompanyLink href={companyPath(row.companySeq)} className="font-medium text-text hover:underline">
                    {row.name}
                  </CompanyLink>
                  <div className="font-mono text-xs text-subtle">{formatCompanyId(row.companySeq)}</div>
                </td>
                <td className="px-4 py-2.5">{row.noSales ? <Badge tone="amber">No sales</Badge> : <span className="text-muted">{salesInWords(row)}</span>}</td>
                <td className="px-4 py-2.5 text-muted">{row.fromZoho ? "The Zoho import" : "By hand, or a merge"}</td>
                <td className="px-4 py-2.5 text-muted">{row.sideOwner ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Card>
    </div>
  );
}
