import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { companyOldProposals } from "@/lib/old-proposals/run";
import { MoveOldProposal } from "./old-proposal-move";
import type { OldLine } from "@/lib/old-proposals/read";

/**
 * A company's proposals from before Zoho, made in Excel (owner, 25 Nov 2026; src/lib/old-proposals): read here, on its
 * Earlier years tab — not documents, leads, or in any report.
 */
const STATUS: Record<string, { label: string; tone: "green" | "red" | "amber" | "default" }> = {
  WON: { label: "Won", tone: "green" },
  LOST: { label: "Lost", tone: "red" },
  PENDING: { label: "Pending", tone: "amber" },
  OTHER: { label: "Closed or other", tone: "default" },
  UNKNOWN: { label: "Not known", tone: "default" },
};
const money = (n: number) => `₹${n.toLocaleString("en-IN", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const dayLabel = (d: Date | null) => (d ? `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}` : "—");

export async function OldProposals({ companyId, companyName, canMove = false }: { companyId: string; companyName: string; canMove?: boolean }) {
  const rows = await companyOldProposals(companyId);
  if (rows.length === 0) return null;
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">
        Proposals made in Excel
        <p className="mt-0.5 text-xs font-normal text-muted">From before Zoho, to read. How each ended is as it was noted then.</p>
      </CardHeader>
      <CardContent className="space-y-2">
        {rows.map((p) => {
          const lines = (p.lines as unknown as OldLine[]) ?? [];
          const status = STATUS[p.status] ?? STATUS.UNKNOWN!;
          return (
            <details key={p.id} className="rounded-lg border border-line">
              <summary className="flex cursor-pointer flex-wrap items-center gap-2 px-3 py-2 text-sm">
                <span className="text-muted">{dayLabel(p.date)}</span>
                <span className="font-medium text-text">{p.ref || "No reference"}</span>
                <span className="text-text">{p.product}</span>
                <Badge tone={status.tone}>{status.label}</Badge>
                {p.total !== null && <span className="ml-auto tabular-nums text-text">{money(Number(p.total))}</span>}
              </summary>
              <div className="space-y-2 border-t border-line px-3 py-2 text-sm">
                <p className="text-xs text-muted">
                  {[p.madeFor.toLowerCase() !== companyName.toLowerCase() ? `Made for ${p.madeFor}` : "", p.contact, p.madeBy ? `By ${p.madeBy}` : ""].filter(Boolean).join(" · ")}
                </p>
                {lines.length > 0 && (
                  <div className="overflow-x-auto">
                    <table className="w-full text-sm">
                      <thead className="text-left text-xs text-muted">
                        <tr>
                          <th className="py-1 pr-3 font-medium">Item</th>
                          <th className="py-1 pr-3 text-right font-medium">Quantity</th>
                          <th className="py-1 pr-3 text-right font-medium">Rate</th>
                          <th className="py-1 text-right font-medium">Amount</th>
                        </tr>
                      </thead>
                      <tbody>
                        {lines.map((l, i) => (
                          <tr key={i} className="border-t border-line align-top">
                            <td className="py-1 pr-3 text-text">{l.item}</td>
                            <td className="py-1 pr-3 text-right tabular-nums text-text">{l.quantity ?? "—"}</td>
                            <td className="py-1 pr-3 text-right tabular-nums text-text">{l.rate === null ? "—" : money(l.rate)}</td>
                            <td className="py-1 text-right tabular-nums text-text">{l.amount === null ? "—" : money(l.amount)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
                {p.remarks && <p className="whitespace-pre-line text-xs text-muted">{p.remarks}</p>}
                {p.files.length > 0 && (
                  <p className="flex flex-wrap gap-3 text-xs">
                    {p.files.map((f) => (
                      <a key={f.id} href={`/api/old-proposals/${f.id}`} className="text-brand hover:underline">
                        {f.name}
                      </a>
                    ))}
                  </p>
                )}
                {canMove && <MoveOldProposal proposalId={p.id} companyId={companyId} madeFor={p.madeFor} offerOwn={p.madeFor.trim().toLowerCase() !== companyName.trim().toLowerCase()} />}
              </div>
            </details>
          );
        })}
      </CardContent>
    </Card>
  );
}
