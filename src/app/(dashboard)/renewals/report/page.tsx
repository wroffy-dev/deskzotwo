import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { renewalReport, type RenewalReportView } from "@/actions/renewal";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";
import type { Tally } from "@/lib/renewals-report";

export const metadata = { title: "Renewal report" };

/**
 * Renewals › Report (owner, 26 Oct 2026 — src/lib/renewals-report.ts): of the subscriptions that came up for
 * renewal in a run of months, how many were renewed and lost, what it was worth, why they were lost, and by
 * product and by salesperson. Within the viewer's reach, as the renewals list is.
 */
export default async function RenewalReportPage({ searchParams }: { searchParams: Promise<{ from?: string; to?: string }> }) {
  if (!(await isModuleEnabled("renewals"))) return <ModuleDisabledNotice moduleKey="renewals" />;
  const params = await searchParams;
  const report = await renewalReport({ from: params.from, to: params.to });
  if (!report) return <ModuleDisabledNotice moduleKey="renewals" />;
  return <Report report={report} />;
}

const monthWords = (m: string) => new Date(`${m}-01T00:00:00Z`).toLocaleDateString("en-IN", { month: "short", year: "numeric", timeZone: "UTC" });
const money = (n: number) => formatCurrency(n);
const rate = (t: Tally) => (t.rate === null ? "—" : `${t.rate}%`);

function Report({ report }: { report: RenewalReportView }) {
  const t = report.totals;
  // India's financial year: April to March.
  const [y, m] = report.thisMonth.split("-").map(Number) as [number, number];
  const fyStart = m >= 4 ? y : y - 1;
  const presets = [
    { label: "Last 12 months", from: undefined, to: undefined },
    { label: "This financial year", from: `${fyStart}-04`, to: `${fyStart + 1}-03` },
    { label: "Last financial year", from: `${fyStart - 1}-04`, to: `${fyStart}-03` },
  ];
  return (
    <div className="animate-fade-rise space-y-5">
      <div>
        <h1 className="text-xl font-semibold text-text">Renewal report</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Subscriptions that came up for renewal from {monthWords(report.from)} to {monthWords(report.to)}: renewed, lost, and still open — and why the lost ones went.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <Link href="/renewals" className="rounded-full border border-line-strong bg-surface px-3 py-1 text-sm text-muted transition-colors hover:text-text">
          Renewals
        </Link>
        {presets.map((p) => (
          <Link key={p.label} href={{ pathname: "/renewals/report", query: p.from ? { from: p.from, to: p.to } : {} }} className="rounded-base px-2.5 py-1 text-sm text-muted hover:text-text">
            {p.label}
          </Link>
        ))}
        <form className="flex flex-wrap items-center gap-1.5 text-sm text-muted" action="/renewals/report">
          <input type="month" name="from" defaultValue={report.from} aria-label="From month" className="rounded-base border border-line bg-surface px-2 py-1 text-text" />
          <span>to</span>
          <input type="month" name="to" defaultValue={report.to} aria-label="To month" className="rounded-base border border-line bg-surface px-2 py-1 text-text" />
          <button type="submit" className="rounded-base border border-line-strong px-2.5 py-1 text-text hover:bg-surface-sunken">
            Show
          </button>
        </form>
      </div>
      {report.clamped && <p className="text-xs text-warning">A report covers two years at most — showing the last two years of the period you chose.</p>}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Stat label="Came up" value={String(t.due)} note={money(t.valueDue)} />
        <Stat label="Renewed" value={String(t.renewed)} note={money(t.valueRenewed)} />
        <Stat label="Lost" value={String(t.lost)} note={money(t.valueLost)} warn={t.lost > 0} />
        <Stat label="Still open" value={String(t.open)} note="not renewed, not marked lost" />
        <Stat label="Renewal rate" value={rate(t)} note="renewed of those decided" />
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="px-4 pt-3 text-left text-xs uppercase tracking-wide text-subtle">By the month they came up</caption>
          <TallyHead first="Month" />
          <tbody>
            {report.months.length === 0 ? (
              <EmptyRow />
            ) : (
              report.months.map((row) => <TallyRow key={row.month} label={monthWords(row.month)} t={row} />)
            )}
          </tbody>
        </table>
      </Card>

      <div className="grid gap-5 lg:grid-cols-2">
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Why they were lost</div>
          {report.reasons.length === 0 ? (
            <p className="mt-3 text-sm text-muted">None lost in this period.</p>
          ) : (
            <ul className="mt-2 divide-y divide-line">
              {report.reasons.map((r) => (
                <li key={r.reason} className="flex items-baseline justify-between gap-3 py-2 text-sm">
                  <span className="min-w-0 text-text">{r.reason}</span>
                  <span className="shrink-0 text-xs tabular-nums text-muted">
                    {r.count} · {money(r.value)}
                  </span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-2 text-xs text-subtle">&quot;Lapsed — not renewed&quot; is the ones nobody marked, which Deskzo marked lost itself (Settings › Renewals).</p>
        </Card>

        <Card className="overflow-x-auto">
          <table className="w-full text-sm">
            <caption className="px-4 pt-3 text-left text-xs uppercase tracking-wide text-subtle">By salesperson</caption>
            <TallyHead first="Account manager" />
            <tbody>{report.people.length === 0 ? <EmptyRow /> : report.people.map((p) => <TallyRow key={p.key} label={p.name} t={p} />)}</tbody>
          </table>
        </Card>
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[40rem] text-sm">
          <caption className="px-4 pt-3 text-left text-xs uppercase tracking-wide text-subtle">By product</caption>
          <TallyHead first="Product" />
          <tbody>{report.products.length === 0 ? <EmptyRow /> : report.products.map((p) => <TallyRow key={p.product} label={p.product} t={p} />)}</tbody>
        </table>
      </Card>

      <p className="max-w-3xl text-xs text-subtle">
        A subscription counts in the month its term ends. Renewed: a renewal order was punched for it. The rate is renewed of those decided — one still being worked doesn&apos;t count
        against anybody. Value is the term&apos;s price for its seats. Add-ons go with their subscription; cancelled and refused orders aren&apos;t counted.
      </p>
    </div>
  );
}

function Stat({ label, value, note, warn }: { label: string; value: string; note: string; warn?: boolean }) {
  return (
    <Card className={`px-4 py-3 ${warn ? "border-warning/40" : ""}`}>
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${warn ? "text-warning" : "text-text"}`}>{value}</div>
      <div className="mt-0.5 text-xs text-muted">{note}</div>
    </Card>
  );
}

function TallyHead({ first }: { first: string }) {
  return (
    <thead className="border-b border-line text-left text-xs uppercase tracking-wide text-muted">
      <tr>
        <th scope="col" className="px-4 py-2">{first}</th>
        <th scope="col" className="px-3 py-2 text-right">Came up</th>
        <th scope="col" className="px-3 py-2 text-right">Renewed</th>
        <th scope="col" className="px-3 py-2 text-right">Lost</th>
        <th scope="col" className="px-3 py-2 text-right">Open</th>
        <th scope="col" className="px-4 py-2 text-right">Rate</th>
      </tr>
    </thead>
  );
}

function TallyRow({ label, t }: { label: string; t: Tally }) {
  return (
    <tr className="border-b border-line last:border-0">
      <th scope="row" className="px-4 py-2 text-left font-medium text-text">{label}</th>
      <td className="px-3 py-2 text-right tabular-nums text-text">{t.due}</td>
      <td className="px-3 py-2 text-right tabular-nums text-text">
        {t.renewed}
        {t.valueRenewed > 0 && <span className="block text-xs text-muted">{money(t.valueRenewed)}</span>}
      </td>
      <td className={`px-3 py-2 text-right tabular-nums ${t.lost ? "text-warning" : "text-text"}`}>
        {t.lost}
        {t.valueLost > 0 && <span className="block text-xs">{money(t.valueLost)}</span>}
      </td>
      <td className="px-3 py-2 text-right tabular-nums text-muted">{t.open}</td>
      <td className="px-4 py-2 text-right tabular-nums text-text">{rate(t)}</td>
    </tr>
  );
}

function EmptyRow() {
  return (
    <tr>
      <td colSpan={6} className="px-4 py-6 text-center text-muted">
        Nothing came up for renewal in this period.
      </td>
    </tr>
  );
}
