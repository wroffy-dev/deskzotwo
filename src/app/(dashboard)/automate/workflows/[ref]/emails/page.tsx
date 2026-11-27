import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { notFound } from "next/navigation";
import { ChevronLeft, Download } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { workflowEmails } from "@/actions/automate-emails";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Badge, Card } from "@/components/ui/card";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspaceClock } from "@/lib/time/workspace";
import { companyPath } from "@/lib/record-links";
import type { Tally } from "@/lib/automate/email-report";

export const metadata = { title: "Emails sent" };

/** One period's count: sent, then skipped and failed beside it. */
function Period({ label, t }: { label: string; t: Tally }) {
  return (
    <Card className="p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-muted">{label}</p>
      <p className="mt-1 text-2xl font-semibold text-text">{t.sent.toLocaleString("en-IN")}</p>
      <p className="text-xs text-muted">
        sent{t.skipped ? ` · ${t.skipped} skipped` : ""}
        {t.failed ? <span className="text-danger"> · {t.failed} failed</span> : null}
      </p>
    </Card>
  );
}

/**
 * A workflow's emails (owner, 2 Nov 2026: "how do I check an automation has sent how many mails?" —
 * src/lib/automate/email-report.ts): sent, skipped and failed today, this month and in all, and every one listed —
 * who, which customer, the subject, from where, and why one was skipped — newest first, with the same as an Excel file.
 * Tests aren't counted. For whoever may use Automate.
 */
export default async function WorkflowEmailsPage({ params, searchParams }: { params: Promise<{ ref: string }>; searchParams: Promise<{ show?: string }> }) {
  if (!(await isModuleEnabled("automate"))) return <ModuleDisabledNotice moduleKey="automate" />;
  const [{ ref }, { show }] = await Promise.all([params, searchParams]);
  let data;
  try {
    data = await workflowEmails(decodeURIComponent(ref));
  } catch (err) {
    if (notMigratedYet(err)) notFound();
    throw err;
  }
  if (!data) notFound();
  const { workflow, report } = data;
  const clock = await workspaceClock();
  const filter = show === "SENT" || show === "SKIPPED" || show === "FAILED" ? show : null;
  const rows = filter ? report.rows.filter((r) => r.outcome === filter) : report.rows;
  const base = `/automate/workflows/${workflow.ref}/emails`;

  return (
    <div className="space-y-5">
      <Link href={`/automate/workflows/${workflow.ref}`} className="inline-flex items-center gap-1 text-sm text-muted hover:text-text">
        <ChevronLeft className="h-4 w-4" aria-hidden /> {workflow.name}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Emails sent</h1>
          <p className="mt-1 text-sm text-muted">
            Every email {workflow.name} sent, skipped or couldn&apos;t send. Test runs aren&apos;t counted.
          </p>
        </div>
        {report.rows.length > 0 && (
          <a href={`/api/automate/workflow-emails/${workflow.ref}${filter ? `?show=${filter}` : ""}`} className="inline-flex items-center gap-1.5 rounded-base border border-line px-3 py-1.5 text-sm text-text transition-colors hover:border-brand hover:text-brand">
            <Download className="h-4 w-4" aria-hidden /> Excel
          </a>
        )}
      </div>

      <div className="grid gap-3 sm:grid-cols-3">
        <Period label="Today" t={report.today} />
        <Period label="This month" t={report.month} />
        <Period label="All time" t={report.all} />
      </div>

      <div className="flex flex-wrap gap-2 text-sm">
        {[
          { key: null, label: `All (${report.all.sent + report.all.skipped + report.all.failed})` },
          { key: "SENT", label: `Sent (${report.all.sent})` },
          { key: "SKIPPED", label: `Skipped (${report.all.skipped})` },
          { key: "FAILED", label: `Failed (${report.all.failed})` },
        ].map((t) => (
          <Link key={t.label} href={t.key ? `${base}?show=${t.key}` : base} className={`rounded-full border px-3 py-1 ${filter === t.key ? "border-brand bg-brand/10 text-brand" : "border-line text-muted hover:text-text"}`}>
            {t.label}
          </Link>
        ))}
      </div>

      <Card className="overflow-x-auto p-0">
        {rows.length === 0 ? (
          <p className="p-6 text-sm text-muted">{report.rows.length ? "None of these." : "This workflow hasn't emailed anybody yet."}</p>
        ) : (
          <table className="w-full min-w-[860px] text-sm">
            <thead className="border-b border-line bg-surface-sunken text-left text-xs font-medium text-muted">
              <tr>
                <th className="px-4 py-2">When</th>
                <th className="px-4 py-2">To</th>
                <th className="px-4 py-2">Customer</th>
                <th className="px-4 py-2">Subject</th>
                <th className="px-4 py-2">From</th>
                <th className="px-4 py-2">Outcome</th>
                <th className="px-4 py-2">Run</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={`${r.runRef}-${i}`} className="border-b border-line align-top last:border-0">
                  <td className="whitespace-nowrap px-4 py-2.5 text-muted">{clock.dateTimeShort(r.at)}</td>
                  <td className="px-4 py-2.5">
                    <span className="text-text">{r.recipientName ?? "—"}</span>
                    {r.recipientEmail && <span className="block text-xs text-subtle">{r.recipientEmail}</span>}
                    {r.copied > 0 && <span className="block text-[11px] text-subtle">+{r.copied} in CC</span>}
                  </td>
                  <td className="px-4 py-2.5 text-muted">
                    {r.companySeq && r.companyName ? (
                      <CompanyLink href={companyPath(r.companySeq)} className="hover:underline">
                        {r.companyName}
                      </CompanyLink>
                    ) : (
                      (r.companyName ?? (r.recipientKind === "person" ? "A colleague" : "—"))
                    )}
                  </td>
                  <td className="max-w-xs px-4 py-2.5 text-muted">{r.subject ?? "—"}</td>
                  <td className="px-4 py-2.5 text-xs text-muted">{r.from ?? "—"}</td>
                  <td className="px-4 py-2.5">
                    <Badge tone={r.outcome === "SENT" ? "green" : r.outcome === "FAILED" ? "red" : "default"}>{r.outcome === "SENT" ? "Sent" : r.outcome === "FAILED" ? "Failed" : "Skipped"}</Badge>
                    {r.reason && <span className="mt-0.5 block max-w-xs text-[11px] text-subtle">{r.reason}</span>}
                  </td>
                  <td className="px-4 py-2.5">
                    <Link href={`/automate/runs/${r.runRef}`} className="font-mono text-xs text-muted hover:underline">
                      {r.runRef}
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </Card>
      {report.capped && <p className="text-xs text-subtle">The newest 2,000 are listed; the counts cover up to the latest 20,000.</p>}
    </div>
  );
}
