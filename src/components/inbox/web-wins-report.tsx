import { Card, CardContent, CardHeader } from "@/components/ui/card";
import type { ReportRow, webActivityReport } from "@/lib/inbox/activity-report";
import { formatCurrency } from "@/lib/utils";

/**
 * What brings wins, as a section of Inbox reports (owner, 6 Nov 2026; src/lib/inbox/activity-report.ts): which campaigns
 * and pages came before leads and wins. The page decides who sees it (`mayReadWebReport`).
 */
export function WebWinsReport({ report }: { report: Awaited<ReturnType<typeof webActivityReport>> }) {
  const { totals } = report;
  const stat = (label: string, value: string) => (
    <Card className="px-4 py-3">
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-0.5 text-lg font-semibold tabular-nums text-text">{value}</p>
    </Card>
  );
  return (
    <section id="website" className="space-y-4">
      <div>
        <h2 className="text-base font-semibold text-text">Website: what brings wins</h2>
        <p className="mt-0.5 text-sm text-muted">Which campaigns and pages came before leads and wins, for the same period.</p>
      </div>
      <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
        {stat("Visitors", String(totals.visitors))}
        {stat("Known", String(totals.known))}
        {stat("Leads from known visitors", String(totals.leads))}
        {stat("Won", String(totals.won))}
        {stat("Value won", formatCurrency(totals.wonValue))}
      </div>
      <ReportTable title="Campaigns and sources" first="Where they first came from" rows={report.sources} leads />
      <ReportTable title="Pages" first="Page" rows={report.pages} />
      <p className="max-w-3xl text-xs text-subtle">
        How this is counted: a lead or win counts for a campaign when that campaign first brought a browser of its contact&apos;s before the lead was made or won, and for every page they opened before the win. So one win can count on several rows, and the
        rows don&apos;t add up to the total. A page&apos;s wins are wins that saw it, not wins it caused. Only visitors who agreed to being remembered are in it, so the real figures are higher. Value is the lead&apos;s estimated value, before GST.
      </p>
    </section>
  );
}

function ReportTable({ title, first, rows, leads = false }: { title: string; first: string; rows: (ReportRow & { views?: number })[]; leads?: boolean }) {
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">{title}</CardHeader>
      <CardContent className="overflow-x-auto p-0">
        {rows.length === 0 ? (
          <p className="px-4 py-8 text-center text-sm text-subtle">Nothing in this period yet.</p>
        ) : (
          <table className="w-full min-w-[40rem] text-sm">
            <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-subtle">
              <tr>
                <th className="px-4 py-2">{first}</th>
                {!leads && <th className="px-4 py-2 text-right">Views</th>}
                <th className="px-4 py-2 text-right">Visitors</th>
                <th className="px-4 py-2 text-right">Known</th>
                {leads && <th className="px-4 py-2 text-right">Leads</th>}
                <th className="px-4 py-2 text-right">Won</th>
                <th className="px-4 py-2 text-right">Value won</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line">
              {rows.map((r) => (
                <tr key={r.label}>
                  <td className="max-w-md break-all px-4 py-2 text-text">{r.label}</td>
                  {!leads && <td className="px-4 py-2 text-right tabular-nums text-muted">{r.views ?? 0}</td>}
                  <td className="px-4 py-2 text-right tabular-nums text-muted">{r.visitors}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-muted">{r.known}</td>
                  {leads && <td className="px-4 py-2 text-right tabular-nums text-muted">{r.leads}</td>}
                  <td className="px-4 py-2 text-right tabular-nums text-text">{r.won}</td>
                  <td className="px-4 py-2 text-right tabular-nums text-text">{r.wonValue ? formatCurrency(r.wonValue) : "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </CardContent>
    </Card>
  );
}
