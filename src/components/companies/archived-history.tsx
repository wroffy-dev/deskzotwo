import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { ARCHIVE_LABELS, companyArchive, type ArchiveKind } from "@/lib/migration/archive";
import { zohoConnected, zohoPdfPath } from "@/lib/zoho/archive-pdf";

/**
 * A company's earlier years from the old system (src/lib/migration/archive.ts): each year's documents and payments
 * as the old system had them, to be read — not in the books, the statement or any report. A year at a time, the
 * newest open. A document opens its PDF: the one kept, or — with the workspace still connected to Zoho — Zoho's, fetched
 * as it is opened (src/lib/zoho/open-archived-pdf.ts).
 */

const money = (n: number, currency: string | null) =>
  `${currency && currency !== "INR" ? `${currency} ` : "₹"}${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (d: string) => `${Number(d.slice(8, 10))} ${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(0, 4)}`;
/** What a figure means for each kind: owed on a document, unused on a payment or a credit. */
const PLURAL: Record<ArchiveKind, string> = { QUOTE: "quotes", SALES_ORDER: "sales orders", DELIVERY_CHALLAN: "delivery challans", INVOICE: "invoices", CREDIT_NOTE: "credit notes", CUSTOMER_PAYMENT: "payments received", PURCHASE_ORDER: "purchase orders", BILL: "bills", VENDOR_CREDIT: "vendor credits", VENDOR_PAYMENT: "payments made" };
const LEFT: Partial<Record<ArchiveKind, string>> = { INVOICE: "owing", BILL: "owing", CREDIT_NOTE: "unused", VENDOR_CREDIT: "unused", CUSTOMER_PAYMENT: "unused", VENDOR_PAYMENT: "unused" };

export async function ArchivedHistory({ companyId }: { companyId: string }) {
  const [{ years, documents }, connected] = await Promise.all([companyArchive(companyId), zohoConnected()]);
  const opens = (d: (typeof documents)[number]) => d.pdf || (connected && d.unfetched && zohoPdfPath(d) !== null);
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">
        Earlier years, from the old system
        <p className="mt-0.5 text-xs font-normal text-muted">As the old system had them, to read. They aren&apos;t in Deskzo&apos;s books, statement or reports — those years are summed up in the opening balances.</p>
      </CardHeader>
      <CardContent className="space-y-3">
        {years.map((y, i) => {
          const rows = documents.filter((d) => d.year === y.year);
          return (
            <details key={y.year} open={i === 0} className="rounded-lg border border-line">
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="font-medium text-text">FY {y.year}</span>
                {y.kinds.map((k) => (
                  <Badge key={k.kind}>
                    {k.count.toLocaleString("en-IN")} {k.count === 1 ? ARCHIVE_LABELS[k.kind].toLowerCase() : PLURAL[k.kind]} · {money(k.total, null)}
                  </Badge>
                ))}
              </summary>
              <div className="overflow-x-auto border-t border-line">
                <table className="w-full text-sm">
                  <thead className="bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                    <tr>
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Document</th>
                      <th className="px-3 py-2">Status</th>
                      <th className="px-3 py-2 text-right">Total</th>
                      <th className="px-3 py-2 text-right">Left in the old system</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.slice(0, 500).map((d) => (
                      <tr key={d.id} className="border-t border-line">
                        <td className="whitespace-nowrap px-3 py-1.5 text-muted">{dayLabel(d.date)}</td>
                        <td className="px-3 py-1.5 text-text">
                          {opens(d) ? (
                            <a href={`/api/archive/${d.id}/pdf`} target="_blank" rel="noopener" className="text-brand hover:underline">
                              {ARCHIVE_LABELS[d.kind as ArchiveKind] ?? d.kind} {d.number}
                            </a>
                          ) : (
                            <>
                              {ARCHIVE_LABELS[d.kind as ArchiveKind] ?? d.kind} {d.number}
                            </>
                          )}
                          {d.reference && <span className="block text-xs text-muted">{d.reference}</span>}
                        </td>
                        <td className="px-3 py-1.5 text-muted">{d.status ?? "—"}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-text">{money(d.total, d.currency)}</td>
                        <td className="whitespace-nowrap px-3 py-1.5 text-right tabular-nums text-muted">
                          {d.balance ? `${money(d.balance, d.currency)} ${LEFT[d.kind as ArchiveKind] ?? ""}` : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {rows.length > 500 && <p className="px-3 py-2 text-xs text-muted">The first 500 of {rows.length.toLocaleString("en-IN")} — the old system&apos;s export has the rest.</p>}
              </div>
            </details>
          );
        })}
      </CardContent>
    </Card>
  );
}
