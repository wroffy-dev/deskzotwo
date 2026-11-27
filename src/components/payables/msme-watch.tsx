import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { Badge, Card } from "@/components/ui/card";
import { formatCalendarDay } from "@/lib/time/zone";
import { formatCurrency } from "@/lib/utils";
import { companyPath } from "@/lib/record-links";
import { MSME_CATEGORY_LABELS, standingWords, type MsmeBillRow } from "@/lib/payables/msme-rules";

/**
 * Payables' MSME panel (owner, 17 Nov 2026; src/lib/payables/msme.ts): micro and small vendors' open bills that are past
 * the MSMED Act's limit or within a week of it, soonest first — with the rest only counted. Nothing when there is none.
 */
export function MsmeWatch({ bills }: { bills: MsmeBillRow[] }) {
  if (bills.length === 0) return null;
  const late = bills.filter((b) => b.state === "late");
  const soon = bills.filter((b) => b.state === "soon");
  const shown = [...late, ...soon];
  const ok = bills.length - shown.length;
  const sum = (rows: MsmeBillRow[]) => rows.reduce((t, b) => t + b.balance, 0);

  return (
    <Card className="mt-5 p-0">
      <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
        <div>
          <h2 className="text-sm font-semibold text-text">MSME vendors — 45-day limit</h2>
          <p className="mt-0.5 text-xs text-muted">
            Micro and small vendors are paid by the day agreed, at most 45 days from the bill (15 with none agreed). Later, they are owed
            interest at three times the RBI bank rate, and the amount isn&apos;t an expense for the year until paid.
          </p>
        </div>
        <div className="flex flex-wrap gap-2 text-xs">
          {late.length > 0 && <Badge tone="red">{late.length} past the limit · {formatCurrency(sum(late))}</Badge>}
          {soon.length > 0 && <Badge tone="amber">{soon.length} due within a week · {formatCurrency(sum(soon))}</Badge>}
          {ok > 0 && <Badge>{ok} within the limit</Badge>}
        </div>
      </div>
      {shown.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
              <tr>
                <th className="px-4 py-2">Bill</th>
                <th className="px-4 py-2">Vendor</th>
                <th className="px-4 py-2">Pay by</th>
                <th className="px-4 py-2 text-right">To pay</th>
                <th className="px-4 py-2 text-right">Standing</th>
              </tr>
            </thead>
            <tbody>
              {shown.map((b) => (
                <tr key={b.id} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="px-4 py-2">
                    <Link href={`/documents/${b.id}`} className="font-medium text-text hover:underline">
                      {b.docNumber ?? "Bill"}
                    </Link>
                    <div className="text-xs text-subtle">dated {formatCalendarDay(b.issueDate)}</div>
                  </td>
                  <td className="px-4 py-2">
                    <CompanyLink href={companyPath(b.companySeq)} className="text-text hover:underline">
                      {b.vendorName}
                    </CompanyLink>
                    <div className="text-xs text-subtle">{MSME_CATEGORY_LABELS[b.category]}</div>
                  </td>
                  <td className="px-4 py-2 text-muted">{formatCalendarDay(b.payBy)}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text">{formatCurrency(b.balance)}</td>
                  <td className={`px-4 py-2 text-right text-xs font-medium ${b.state === "late" ? "text-danger" : "text-warning"}`}>{standingWords(b)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
