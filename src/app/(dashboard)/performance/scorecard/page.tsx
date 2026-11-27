import Link from "next/link";
import { notFound } from "next/navigation";
import type { ReactNode } from "react";
import { ArrowLeft, Download } from "lucide-react";
import { salesScorecard } from "@/actions/scorecard";
import type { ScorecardRow, TargetedFigure } from "@/lib/scorecard/compute";
import { percent, SCORECARD_PERIODS } from "@/lib/scorecard/rules";
import { Card } from "@/components/ui/card";
import { formatCurrency } from "@/lib/utils";

export const metadata = { title: "Sales scorecard" };

type Params = { period?: string; from?: string; to?: string; everyone?: string; sort?: string };

/** The columns a scorecard can be sorted by, highest first. */
const SORTS: Record<string, { label: string; of: (r: ScorecardRow) => number }> = {
  total: { label: "Total business", of: (r) => r.orderValue },
  new: { label: "New business", of: (r) => r.orders.new.value },
  renewal: { label: "Renewals", of: (r) => r.orders.renewal.value },
  margin: { label: "Margin", of: (r) => r.orderMargin },
  collected: { label: "Collected", of: (r) => r.collected },
  wonRate: { label: "Won rate", of: (r) => r.leads.wonRate ?? -1 },
  renewalRate: { label: "Renewal rate", of: (r) => r.renewals.rate ?? -1 },
  calls: { label: "Calls", of: (r) => r.calls.made },
};

/**
 * Performance › Sales scorecard (owner, 31 Oct 2026): per person over a period — new business, renewals and
 * add-ons with their margin, the year's (or quarter's, month's) total, invoiced and collected, new customers, how
 * their leads went (won, lost and closure rates) and their calling. Figures are Targets' own (src/lib/scorecard).
 */
export default async function ScorecardPage({ searchParams }: { searchParams: Promise<Params> }) {
  const params = await searchParams;
  const view = await salesScorecard({ period: params.period, from: params.from, to: params.to, everyone: params.everyone === "1" });
  if (!view) notFound();
  const sort = SORTS[params.sort ?? ""] ? params.sort! : "total";
  const rows = [...view.rows].sort((a, b) => SORTS[sort]!.of(b) - SORTS[sort]!.of(a) || a.name.localeCompare(b.name));
  const href = (over: Partial<Params>) => {
    const q = new URLSearchParams();
    const merged = { ...params, ...over };
    for (const [k, v] of Object.entries(merged)) if (v) q.set(k, String(v));
    return `/performance/scorecard?${q.toString()}`;
  };
  const total = totals(view.rows);
  // The same period and people as an Excel workbook (src/app/api/performance/scorecard/route.ts).
  const excel = `/api/performance/scorecard?${new URLSearchParams(Object.entries({ period: params.period, from: params.from, to: params.to, everyone: params.everyone }).filter((e): e is [string, string] => !!e[1])).toString()}`;

  return (
    <div className="space-y-5">
      <div>
        <Link href="/performance" className="inline-flex items-center gap-1 text-xs text-muted hover:text-text">
          <ArrowLeft className="h-3.5 w-3.5" /> Performance
        </Link>
        <h1 className="mt-2 text-xl font-semibold text-text">Sales scorecard</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Each person&apos;s business, leads, renewals and calling for {view.window.label}. Orders count on the day they were booked, at the price
          charged; margin only where the purchase price is known. The figures are the ones Targets measures.
        </p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {SCORECARD_PERIODS.map((p) => (
          <Link
            key={p.key}
            href={href({ period: p.key, from: undefined, to: undefined })}
            className={`rounded-full border px-3 py-1 text-sm transition-colors ${view.window.key === p.key ? "border-brand bg-brand/10 text-brand" : "border-line-strong bg-surface text-muted hover:text-text"}`}
          >
            {p.label}
          </Link>
        ))}
        <form action="/performance/scorecard" className="flex flex-wrap items-center gap-1.5 text-sm text-muted">
          <input type="date" name="from" defaultValue={view.window.fromDate} aria-label="From" className="rounded-base border border-line bg-surface px-2 py-1 text-text" />
          <span>to</span>
          <input type="date" name="to" defaultValue={view.window.toDate} aria-label="To" className="rounded-base border border-line bg-surface px-2 py-1 text-text" />
          {params.everyone === "1" && <input type="hidden" name="everyone" value="1" />}
          <button type="submit" className="rounded-base border border-line-strong px-2.5 py-1 text-text hover:bg-surface-sunken">
            Show
          </button>
        </form>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-6">
        <Stat label="Total business" value={formatCurrency(total.orderValue)} note={`${formatCurrency(total.newValue)} new · ${formatCurrency(total.renewalValue)} renewals`} />
        <Stat label="Margin" value={formatCurrency(total.margin)} note={total.marginPercent === null ? "no purchase prices yet" : `${total.marginPercent}% where known`} />
        <Stat label="Collected" value={formatCurrency(total.collected)} note={`${formatCurrency(total.invoiced)} invoiced`} />
        <Stat label="Leads won rate" value={total.wonRate === null ? "—" : `${total.wonRate}%`} note={`${total.won} won · ${total.lost} lost`} />
        <Stat label="Renewal rate" value={total.renewalRate === null ? "—" : `${total.renewalRate}%`} note={`${total.renewed} renewed · ${total.renewalsLost} lost`} />
        <Stat label="Calls" value={String(total.calls)} note={`${total.reached} reached · ${total.minutes} min`} />
      </div>

      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted">
        <span>
          Sorted by <strong className="font-medium text-text">{SORTS[sort]!.label}</strong> — click a heading to sort by it.
        </span>
        <a href={excel} className="inline-flex items-center gap-1.5 rounded-base border border-line-strong bg-surface px-3 py-1.5 text-sm font-medium text-text hover:bg-surface-sunken">
          <Download className="h-4 w-4" />
          Download Excel
        </a>
        {view.quiet > 0 || params.everyone === "1" ? (
          <Link href={href({ everyone: params.everyone === "1" ? undefined : "1" })} className="text-primary hover:underline">
            {params.everyone === "1" ? "Only people with something in the period" : `Show everyone (${view.quiet} with nothing in the period)`}
          </Link>
        ) : null}
      </div>

      <Card className="overflow-x-auto">
        <table className="w-full min-w-[78rem] text-sm">
          <thead className="text-left text-xs text-muted">
            <tr className="border-b border-line">
              <th rowSpan={2} className="fixed-col sticky left-0 z-10 bg-surface px-4 py-2 align-bottom uppercase tracking-wide">
                Person
              </th>
              <Group span={3}>New business</Group>
              <Group span={3}>Renewals</Group>
              <Group span={5}>Total</Group>
              <Group span={7}>Leads</Group>
              <Group span={3}>Calls</Group>
            </tr>
            <tr className="border-b border-line">
              <Col sort="new" href={href}>Value</Col>
              <Col>Margin</Col>
              <Col>New customers</Col>
              <Col sort="renewal" href={href}>Value</Col>
              <Col>Renewed · lost</Col>
              <Col sort="renewalRate" href={href}>Rate</Col>
              <Col>Add-ons</Col>
              <Col sort="total" href={href}>Business</Col>
              <Col sort="margin" href={href}>Margin</Col>
              <Col sort="collected" href={href}>Collected</Col>
              <Col>Invoiced</Col>
              <Col>Created</Col>
              <Col>Won</Col>
              <Col>Lost</Col>
              <Col>Open now</Col>
              <Col sort="wonRate" href={href}>Won rate</Col>
              <Col>Lost rate</Col>
              <Col>Closure rate</Col>
              <Col sort="calls" href={href}>Made</Col>
              <Col>Reached</Col>
              <Col>Minutes</Col>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={22} className="px-4 py-8 text-center text-subtle">
                  Nobody has business, leads, renewals or calls in this period.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.userId} className="border-b border-line last:border-0 hover:bg-surface-sunken">
                  <td className="fixed-col sticky left-0 z-10 whitespace-nowrap bg-surface px-4 py-2 font-medium text-text">{r.name}</td>
                  <Num>{money(r.orders.new.value)}</Num>
                  <Num>{money(r.orders.new.margin)}</Num>
                  <Num>
                    {r.newCustomers || "—"}
                    <Goal r={r} f="newCustomers" />
                  </Num>
                  <Num>{money(r.orders.renewal.value)}</Num>
                  <Num>{r.renewals.due ? `${r.renewals.renewed} · ${r.renewals.lost}` : "—"}</Num>
                  <Num>{rate(r.renewals.rate)}</Num>
                  <Num>{money(r.orders.addon.value)}</Num>
                  <Num strong>
                    {money(r.orderValue)}
                    <Goal r={r} f="orderValue" />
                  </Num>
                  <Num>
                    {money(r.orderMargin)}
                    {r.marginPercent !== null && <span className="block text-[11px] text-subtle">{r.marginPercent}%</span>}
                    <Goal r={r} f="orderMargin" />
                  </Num>
                  <Num>
                    {money(r.collected)}
                    <Goal r={r} f="collected" />
                  </Num>
                  <Num>
                    {money(r.invoiced)}
                    <Goal r={r} f="invoiced" />
                  </Num>
                  <Num>{r.leads.created || "—"}</Num>
                  <Num>
                    {r.leads.won || "—"}
                    <Goal r={r} f="leadsWon" />
                  </Num>
                  <Num>{r.leads.lost || "—"}</Num>
                  <Num>{r.leads.open || "—"}</Num>
                  <Num>{rate(r.leads.wonRate)}</Num>
                  <Num>{rate(r.leads.lostRate)}</Num>
                  <Num>{rate(r.leads.closureRate)}</Num>
                  <Num>{r.calls.made || "—"}</Num>
                  <Num>
                    {r.calls.reached || "—"}
                    <Goal r={r} f="callsReached" />
                  </Num>
                  <Num>
                    {r.calls.minutes || "—"}
                    <Goal r={r} f="callMinutes" />
                  </Num>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </Card>

      <div className="max-w-4xl space-y-1 text-xs text-subtle">
        <p>
          <strong className="font-medium text-muted">New business</strong> is orders marked New, and renewals won from elsewhere; <strong className="font-medium text-muted">Renewals</strong> are
          orders marked Renewal. The renewal rate is the renewals report&apos;s: of the subscriptions whose term ended in the period on customers they
          manage, those renewed of those decided (renewed or lost).
        </p>
        <p>
          <strong className="font-medium text-muted">Won rate</strong> and <strong className="font-medium text-muted">lost rate</strong> are of the leads they closed in the period; disqualified ones count as neither.{" "}
          <strong className="font-medium text-muted">Closure rate</strong> is of the leads made in the period and theirs, the share closed by now. Open now is today&apos;s, whatever the period.
        </p>
      </div>
    </div>
  );
}

function totals(rows: ScorecardRow[]) {
  const sum = (f: (r: ScorecardRow) => number) => rows.reduce((t, r) => t + f(r), 0);
  const won = sum((r) => r.leads.won);
  const lost = sum((r) => r.leads.lost);
  const renewed = sum((r) => r.renewals.renewed);
  const renewalsLost = sum((r) => r.renewals.lost);
  const marginOf = sum((r) => r.orders.new.marginOf + r.orders.renewal.marginOf + r.orders.addon.marginOf);
  const margin = sum((r) => r.orderMargin);
  return {
    orderValue: sum((r) => r.orderValue),
    newValue: sum((r) => r.orders.new.value),
    renewalValue: sum((r) => r.orders.renewal.value),
    margin,
    marginPercent: percent(margin, marginOf),
    invoiced: sum((r) => r.invoiced),
    collected: sum((r) => r.collected),
    won,
    lost,
    wonRate: percent(won, won + lost),
    renewed,
    renewalsLost,
    renewalRate: percent(renewed, renewed + renewalsLost),
    calls: sum((r) => r.calls.made),
    reached: sum((r) => r.calls.reached),
    minutes: sum((r) => r.calls.minutes),
  };
}

const money = (n: number) => (n ? formatCurrency(n) : "—");

/** Under a figure with a target for this period: how much of it is done — green once it is met. */
function Goal({ r, f }: { r: ScorecardRow; f: TargetedFigure }) {
  const t = r.targets[f];
  if (!t) return null;
  const met = t.percent !== null && t.percent >= 100;
  return <span className={`block text-[11px] ${met ? "text-success" : "text-subtle"}`}>{t.percent === null ? "target set" : `${t.percent}% of target`}</span>;
}
const rate = (n: number | null) => (n === null ? "—" : `${n}%`);

function Stat({ label, value, note }: { label: string; value: string; note: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-1 text-lg font-semibold tabular-nums text-text">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{note}</div>
    </Card>
  );
}

const Group = ({ span, children }: { span: number; children: ReactNode }) => (
  <th colSpan={span} className="border-l border-line px-3 pt-2 text-center font-semibold uppercase tracking-wide text-text">
    {children}
  </th>
);

function Col({ children, sort, href }: { children: ReactNode; sort?: string; href?: (over: { sort?: string }) => string }) {
  return (
    <th className="whitespace-nowrap px-3 py-2 text-right font-medium">
      {sort && href ? (
        <Link href={href({ sort })} className="hover:text-text hover:underline">
          {children}
        </Link>
      ) : (
        children
      )}
    </th>
  );
}

const Num = ({ children, strong }: { children: ReactNode; strong?: boolean }) => (
  <td className={`whitespace-nowrap px-3 py-2 text-right tabular-nums ${strong ? "font-semibold text-text" : "text-muted"}`}>{children}</td>
);
