import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { notFound } from "next/navigation";
import { ArrowLeft } from "lucide-react";
import { isModuleEnabled } from "@/actions/module";
import { getCampaign } from "@/actions/marketing";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { EmailFrame } from "@/components/marketing/email-frame";
import { workspaceClock } from "@/lib/time/workspace";
import { companyPath } from "@/lib/record-links";
import { leadsFromCampaign } from "@/lib/marketing/utm-settings";
import { REVENUE_WINDOW_DAYS, campaignRevenue, ownAverage, providerBreakdown } from "@/lib/marketing/campaign-insights";
import { clickHeatmap, compareRate, type Rate } from "@/lib/marketing/report-rules";
import { formatMoneyWhole } from "@/lib/currency";
import { pollResults } from "@/lib/marketing/polls";

export const metadata = { title: "Campaign report" };

const STATUS_TONE: Record<string, "default" | "green" | "amber" | "red" | "blue"> = {
  QUEUED: "default",
  SENDING: "blue",
  SENT: "blue",
  DELIVERED: "blue",
  OPENED: "green",
  CLICKED: "green",
  BOUNCED: "red",
  COMPLAINED: "red",
  FAILED: "red",
  SUPPRESSED: "amber",
};

function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part / whole) * 100)}%` : "—";
}

function Stat({ label, value, hint }: { label: string; value: string | number; hint?: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs text-muted">{label}</div>
      <div className="mt-0.5 text-2xl font-semibold tabular-nums text-text">{value}</div>
      {hint && <div className="text-[11px] text-subtle">{hint}</div>}
    </Card>
  );
}

/**
 * How a campaign went: how many it reached, who opened and clicked, which links, who unsubscribed,
 * and why everybody it never reached was left out.
 */
export default async function CampaignReportPage({ params }: { params: Promise<{ id: string }> }) {
  if (!(await isModuleEnabled("marketing"))) return <ModuleDisabledNotice moduleKey="marketing" />;
  const { id } = await params;
  const [report, clock] = await Promise.all([getCampaign(id), workspaceClock()]);
  if (!report) notFound();
  const { campaign, totals } = report;
  // Leads whose website form came with this campaign's UTM tags (src/lib/marketing/utm.ts).
  // The deeper report (owner, 1 Nov 2026): by mailbox provider, revenue after a click, and the workspace's usual rates.
  const [leads, providers, revenue, own, polls] = await Promise.all([
    leadsFromCampaign(campaign.name, campaign.startedAt ?? campaign.createdAt),
    providerBreakdown(campaign.id),
    campaignRevenue(campaign.id),
    ownAverage(campaign.id, campaign.createdAt),
    pollResults(campaign.id),
  ]);
  const rate = (n: number) => (totals.sent > 0 ? n / totals.sent : null);
  const rates: { kind: Rate; label: string; value: number | null; own: number | null }[] = [
    { kind: "open", label: "Opens", value: rate(totals.opened), own: own.open },
    { kind: "click", label: "Clicks", value: rate(totals.clicked), own: own.click },
    { kind: "unsubscribe", label: "Unsubscribes", value: rate(totals.unsubscribed), own: own.unsubscribe },
  ];

  return (
    <div className="space-y-4">
      <div>
        <Link href="/marketing" className="mb-2 inline-flex items-center gap-1 text-xs text-muted hover:text-text">
          <ArrowLeft className="h-3.5 w-3.5" /> Campaigns
        </Link>
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-xl font-semibold text-text">{campaign.name}</h1>
          <span className="font-mono text-xs text-subtle">{campaign.reference}</span>
          <Badge tone={campaign.status === "SENT" ? "green" : campaign.status === "CANCELLED" ? "red" : "blue"}>{campaign.status.replaceAll("_", " ").toLowerCase()}</Badge>
        </div>
        <p className="mt-1 text-sm text-muted">
          “{campaign.template.name}” to {report.recipients}
          {campaign.startedAt && ` · started ${clock.dateTime(campaign.startedAt)}`}
          {campaign.finishedAt && ` · finished ${clock.dateTime(campaign.finishedAt)}`}
          {` · built by ${campaign.createdBy.name}`}
          {campaign.approvedBy && ` · approved by ${campaign.approvedBy.name}`}
        </p>
        {report.options.parent && (
          <p className="mt-1 text-sm text-muted">
            A resend to those who didn&apos;t open{" "}
            <Link href={`/marketing/campaigns/${report.options.parent.id}`} className="text-brand hover:underline">
              {report.options.parent.reference}
            </Link>
            {report.options.subject ? `, with the subject “${report.options.subject}”` : ""}.
          </p>
        )}
      </div>

      {(report.options.abTest || report.options.resend) && <AbAndResend options={report.options} templateName={campaign.template.name} templateSubject={campaign.template.subject} clock={clock} />}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-8">
        <Stat label="Sent" value={totals.sent} hint={totals.waiting ? `${totals.waiting} still waiting` : undefined} />
        <Stat label="Opened" value={totals.opened} hint={`${pct(totals.opened, totals.sent)} · approximate`} />
        <Stat label="Clicked" value={totals.clicked} hint={pct(totals.clicked, totals.sent)} />
        <Stat label="Unsubscribed" value={totals.unsubscribed} hint={pct(totals.unsubscribed, totals.sent)} />
        <Stat label="Bounced" value={totals.bounced} />
        <Stat label="Failed" value={totals.failed} />
        <Stat label="Held back" value={totals.withheld} hint="never sent — see why below" />
        <Stat label="Leads" value={leads} hint="forms filled in from its links" />
      </div>

      {totals.sent > 0 && (
        <div className="grid gap-4 lg:grid-cols-3">
          <Card>
            <CardHeader className="text-sm font-semibold text-text">Against the usual</CardHeader>
            <CardContent className="space-y-2 text-sm">
              {rates.map((r) => {
                const c = compareRate(r.kind, r.value, r.own);
                return (
                  <div key={r.kind}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-text">{r.label}</span>
                      <span className={c.tone === "good" ? "font-medium tabular-nums text-success" : c.tone === "poor" ? "font-medium tabular-nums text-danger" : "font-medium tabular-nums text-text"}>
                        {r.value === null ? "—" : `${(r.value * 100).toFixed(1)}%`}
                      </span>
                    </div>
                    <div className="text-[11px] text-subtle">
                      {c.typical}
                      {c.vsOwn && <> · {c.vsOwn}</>}
                    </div>
                  </div>
                );
              })}
              <p className="text-[11px] text-subtle">
                {own.campaigns ? `Your usual: your last ${own.campaigns} campaign${own.campaigns === 1 ? "" : "s"}.` : "Your usual appears once you've sent a few campaigns."} Opens are approximate — Apple Mail opens every email it receives.
              </p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="text-sm font-semibold text-text">Revenue after a click</CardHeader>
            <CardContent className="space-y-1 text-sm">
              <div className="text-2xl font-semibold tabular-nums text-text">{formatMoneyWhole(revenue.amount, revenue.currency)}</div>
              <p className="text-xs text-muted">
                {revenue.invoices} invoice{revenue.invoices === 1 ? "" : "s"} to {revenue.companies} compan{revenue.companies === 1 ? "y" : "ies"}
              </p>
              <p className="text-[11px] text-subtle">Sales invoices issued within {REVENUE_WINDOW_DAYS} days after somebody at the company clicked this email, less credit notes. A sign it helped, not proof it made the sale.</p>
            </CardContent>
          </Card>
          <Card>
            <CardHeader className="text-sm font-semibold text-text">By mailbox provider</CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-line text-left text-[11px] uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-1.5">Provider</th>
                    <th className="px-2 py-1.5 text-right">Sent</th>
                    <th className="px-2 py-1.5 text-right">Opened</th>
                    <th className="px-2 py-1.5 text-right">Clicked</th>
                    <th className="px-4 py-1.5 text-right">Bounced</th>
                  </tr>
                </thead>
                <tbody>
                  {providers.map((p) => (
                    <tr key={p.provider} className="border-b border-line last:border-0">
                      <td className="px-4 py-1.5 text-text">{p.provider}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{p.sent}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{pct(p.opened, p.sent)}</td>
                      <td className="px-2 py-1.5 text-right tabular-nums">{pct(p.clicked, p.sent)}</td>
                      <td className={p.bounced ? "px-4 py-1.5 text-right tabular-nums text-danger" : "px-4 py-1.5 text-right tabular-nums"}>{pct(p.bounced, p.sent)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-4 py-2 text-[11px] text-subtle">One provider far below the rest usually means it is filing you as spam — check the sending domain&apos;s set-up.</p>
            </CardContent>
          </Card>
        </div>
      )}

      <div className="grid gap-4 lg:grid-cols-2">
        <div className="space-y-4">
          {report.links.length > 0 && (
            <Card>
              <CardHeader className="text-sm font-semibold text-text">What they clicked</CardHeader>
              <CardContent>
                <ul className="space-y-1.5 text-sm">
                  {report.links.slice(0, 10).map((l) => (
                    <li key={l.url} className="flex items-baseline justify-between gap-3">
                      <span className="truncate text-text" title={l.url}>
                        {l.url}
                      </span>
                      <span className="shrink-0 tabular-nums text-muted">{l.clicks}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          {polls.map((p) => (
            <Card key={p.question}>
              <CardHeader className="text-sm font-semibold text-text">
                Poll: {p.question} <span className="font-normal text-muted">· {p.total} answer{p.total === 1 ? "" : "s"}</span>
              </CardHeader>
              <CardContent className="space-y-1.5 text-sm">
                {p.answers.map((a) => (
                  <div key={a.answer}>
                    <div className="flex items-baseline justify-between gap-3">
                      <span className="text-text">{a.answer}</span>
                      <span className="tabular-nums text-muted">
                        {a.count} · {pct(a.count, p.total)}
                      </span>
                    </div>
                    <div className="mt-0.5 h-1.5 rounded-full bg-surface-sunken">
                      <div className="h-1.5 rounded-full bg-primary" style={{ width: pct(a.count, p.total) }} />
                    </div>
                  </div>
                ))}
              </CardContent>
            </Card>
          ))}
          {report.withheldBecause.length > 0 && (
            <Card>
              <CardHeader className="text-sm font-semibold text-text">Why some weren&apos;t sent</CardHeader>
              <CardContent>
                <ul className="space-y-1 text-sm">
                  {report.withheldBecause.map((r) => (
                    <li key={r.reason} className="flex items-baseline justify-between gap-3">
                      <span className="text-text">{r.reason}</span>
                      <span className="shrink-0 tabular-nums text-muted">{r.count}</span>
                    </li>
                  ))}
                </ul>
              </CardContent>
            </Card>
          )}
          <Card>
            <CardHeader className="text-sm font-semibold text-text">Recipients (latest {report.recent.length})</CardHeader>
            <CardContent className="overflow-x-auto p-0">
              <table className="w-full text-sm">
                <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2">Person</th>
                    <th className="px-4 py-2">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {report.recent.map((m) => (
                    <tr key={m.id} className="border-b border-line last:border-0">
                      <td className="px-4 py-2">
                        <div className="text-text">{m.contact?.name ?? m.toEmail ?? "—"}</div>
                        <div className="text-xs text-subtle">
                          {m.toEmail} · <CompanyLink href={companyPath(m.company.companySeq)} className="hover:underline">{m.company.name}</CompanyLink>
                        </div>
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone={STATUS_TONE[m.status] ?? "default"}>{m.status.toLowerCase()}</Badge>
                        {(m.suppressedReason || m.error) && <div className="mt-0.5 text-[11px] text-subtle">{(m.suppressedReason ?? m.error ?? "").replace(/^[A-Z_]+: /, "")}</div>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </CardContent>
          </Card>
        </div>
        <div className="space-y-1">
          <p className="text-[11px] uppercase tracking-wide text-subtle">{report.links.length ? "One of them, as it was sent — with each link's clicks and share" : "One of them, as it was sent"}</p>
          {report.sample?.subject && <p className="text-sm font-medium text-text">{report.sample.subject}</p>}
          {report.sample?.body ? <EmailFrame html={report.links.length ? clickHeatmap(report.sample.body, report.links) : report.sample.body} title="A sent email" height={640} /> : <p className="text-sm text-subtle">Nothing has been sent yet.</p>}
        </div>
      </div>
    </div>
  );
}

type Options = Awaited<ReturnType<typeof getCampaign>> extends infer R ? (R extends { options: infer O } ? O : never) : never;

/** The A/B test, as it stands or as decided, and the resend to those who didn't open (owner, 1 Nov 2026). */
function AbAndResend({ options, templateName, templateSubject, clock }: { options: Options; templateName: string; templateSubject: string | null; clock: Awaited<ReturnType<typeof workspaceClock>> }) {
  const ab = options.abTest;
  const stats = options.abStats;
  const rate = (n: number, of: number) => (of ? `${Math.round((n / of) * 100)}%` : "—");
  const versions = ab
    ? ([
        ["A", ab.test === "subject" ? (templateSubject ?? templateName) : templateName],
        ["B", ab.test === "subject" ? (ab.subjectB ?? "") : (options.templateB?.name ?? "Version B")],
      ] as const)
    : [];
  return (
    <Card>
      <CardContent className="space-y-3 py-3 text-sm">
        {ab && stats && (
          <div>
            <div className="font-semibold text-text">
              A/B test — {ab.test === "subject" ? "two subject lines" : "two emails"} to {ab.percent}% of the audience, won by {ab.metric}
            </div>
            <p className="text-xs text-muted">
              {ab.winner
                ? `Version ${ab.winner} won${ab.decidedAt ? ` on ${clock.dateTime(ab.decidedAt)}` : ""}, and went to everybody else.`
                : `The winner is picked ${ab.hours} hour${ab.hours === 1 ? "" : "s"} after the test went out, then sent to everybody else.`}
            </p>
            <table className="mt-2 w-full text-xs">
              <thead className="text-left text-muted">
                <tr>
                  <th className="py-1">Version</th>
                  <th className="py-1">Sent</th>
                  <th className="py-1">Opened</th>
                  <th className="py-1">Clicked</th>
                </tr>
              </thead>
              <tbody>
                {versions.map(([v, label]) => {
                  const s = stats[v];
                  return (
                    <tr key={v} className={ab.winner === v ? "font-semibold text-success" : "text-text"}>
                      <td className="py-1">
                        {v} · {label}
                        {ab.winner === v ? " — winner" : ""}
                      </td>
                      <td className="py-1 tabular-nums">{s.sent}</td>
                      <td className="py-1 tabular-nums">
                        {s.opened} ({rate(s.opened, s.sent)})
                      </td>
                      <td className="py-1 tabular-nums">
                        {s.clicked} ({rate(s.clicked, s.sent)})
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        {options.resend && (
          <div className="text-xs text-muted">
            <span className="font-semibold text-text">Resend to those who don&apos;t open</span> — “{options.resend.subject}”, {Math.round(options.resend.afterHours / 24)} day
            {Math.round(options.resend.afterHours / 24) === 1 ? "" : "s"} after it goes.{" "}
            {options.resendChild ? (
              <>
                Sent to {options.resend.count ?? 0}:{" "}
                <Link href={`/marketing/campaigns/${options.resendChild.id}`} className="text-brand hover:underline">
                  {options.resendChild.reference}
                </Link>
              </>
            ) : options.resend.doneAt ? (
              "Everybody opened it — nothing to resend."
            ) : (
              "Not yet."
            )}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
