import { baseCurrency } from "@/lib/currency";
import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { notFound } from "next/navigation";
import { listCollections, type CollectionsFilter } from "@/actions/collections";
import { arjunForMe } from "@/actions/collection-chase";
import { ArjunPanel } from "@/components/collections/arjun-panel";
import { DraftChaseButton } from "@/components/collections/chase-dialog";
import { isModuleEnabled } from "@/actions/module";
import { Badge, Card } from "@/components/ui/card";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { SearchParamInput } from "@/components/ui/search-param-input";
import { FollowUpHistory, PromiseBadge, promiseText } from "@/components/collections/follow-up-history";
import { LogFollowUpButton } from "@/components/collections/log-follow-up-button";
import { formatCurrency } from "@/lib/utils";
import { formatMoney, isBaseCurrency } from "@/lib/currency";
import { AGING_BUCKETS } from "@/lib/receivables";
import { followUpChannelLabels, longDay, shortDay, daysBetween } from "@/lib/collections/rules";
import { workspaceClock } from "@/lib/time/workspace";
import { formatCalendarDay, type Clock } from "@/lib/time/zone";
import { companyPath } from "@/lib/record-links";

const FILTERS: { value: CollectionsFilter; label: string }[] = [
  { value: "all", label: "All" },
  { value: "overdue", label: "Overdue" },
  { value: "broken", label: "Promise broken" },
  { value: "week", label: "Promised this week" },
  { value: "stale", label: "No follow-up in 14 days" },
];

const BUCKET_LABEL = Object.fromEntries(AGING_BUCKETS.map((b) => [b.key, b.label])) as Record<(typeof AGING_BUCKETS)[number]["key"], string>;

/**
 * My collections: what the viewer's clients owe — the accounts they manage (their team's, for a
 * manager) and the orders they punched on anybody's — grouped by client, with the last follow-up, the
 * promise and the next follow-up on each, and a Log follow-up on every row. See src/actions/collections.ts.
 */
export default async function CollectionsPage({
  searchParams,
}: {
  searchParams: Promise<{ filter?: string; q?: string; sort?: string }>;
}) {
  if (!(await isModuleEnabled("receivables"))) return <ModuleDisabledNotice moduleKey="receivables" />;
  const params = await searchParams;
  const data = await listCollections({ filter: params.filter, q: params.q, sort: params.sort });
  if (!data) notFound();
  // Arjun, the Collections teammate (owner, 19 Nov 2026): who to chase today, his drafts, and the replies he read.
  const arjun = await arjunForMe().catch((err) => {
    console.error("[collections] Arjun's list failed", err instanceof Error ? err.message : err);
    return null;
  });

  // Today on the workspace's calendar, as a date column holds a day.
  const clock = await workspaceClock();
  const today = clock.calendarDate(new Date());
  const query = (overrides: Record<string, string | undefined>) =>
    Object.fromEntries(
      Object.entries({ filter: data.filter === "all" ? undefined : data.filter, q: params.q, sort: data.sort === "overdue" ? undefined : data.sort, ...overrides }).filter(([, v]) => v),
    ) as Record<string, string>;

  return (
    <div className="animate-fade-rise">
      <div>
        <h1 className="text-xl font-semibold text-text">My collections</h1>
        <p className="mt-1 text-sm text-muted">
          {data.restricted
            ? "What your clients owe: the accounts you manage (and your team's), and orders you punched on anybody's account."
            : "What every client owes."}{" "}
          Log each follow-up — what they said, and the date they promise to pay by. A promise that passes unpaid is flagged to
          you, your manager and accounts.
        </p>
      </div>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Tile label="Total pending" value={formatCurrency(data.tiles.pending)} hint={
            data.tiles.unbilledCount
              ? `${data.tiles.invoiceCount} invoice(s), and ${data.tiles.unbilledCount} order(s) not yet invoiced — ${formatCurrency(data.tiles.unbilled)}`
              : `${data.tiles.invoiceCount} invoice(s)`
          } />
        <Tile
          label="Overdue"
          value={formatCurrency(data.tiles.overdue)}
          hint={`${data.tiles.overdueCount} past the due date`}
          tone={data.tiles.overdue > 0 ? "danger" : undefined}
        />
        <Tile
          label="Promised this week"
          value={formatCurrency(data.tiles.promisedWeek)}
          hint={`${data.tiles.promisedWeekCount} promise(s), ${shortDay(data.week.from)} – ${shortDay(data.week.to)}`}
        />
        <Tile
          label="Broken promises"
          value={String(data.tiles.brokenCount)}
          hint={data.tiles.brokenCount > 0 ? `${formatCurrency(data.tiles.broken)} promised, not received` : "none"}
          tone={data.tiles.brokenCount > 0 ? "danger" : undefined}
        />
      </div>
      <p className="mt-2 text-xs text-subtle">Totals in {baseCurrency()} — an invoice in another currency at its own rate.</p>

      {arjun && <ArjunPanel data={arjun} />}

      <div className="mt-5 flex flex-wrap items-center gap-3">
        <SearchParamInput paramName="q" placeholder="Search client name…" />
        <nav aria-label="Filter dues" className="flex flex-wrap items-center gap-2">
          {FILTERS.map((f) => (
            <Link
              key={f.value}
              href={{ pathname: "/collections", query: query({ filter: f.value === "all" ? undefined : f.value }) }}
              aria-current={data.filter === f.value ? "page" : undefined}
              className={`rounded-full px-3 py-1 text-sm ${
                data.filter === f.value ? "bg-brand text-brand-contrast" : "border border-line-strong bg-surface text-muted"
              }`}
            >
              {f.label}
            </Link>
          ))}
        </nav>
        <nav aria-label="Sort" className="ml-auto flex items-center gap-2 text-sm text-muted">
          <span>Sort:</span>
          <Link
            href={{ pathname: "/collections", query: query({ sort: undefined }) }}
            aria-current={data.sort === "overdue" ? "page" : undefined}
            className={data.sort === "overdue" ? "font-medium text-text underline" : "hover:text-text"}
          >
            Most overdue
          </Link>
          <Link
            href={{ pathname: "/collections", query: query({ sort: "amount" }) }}
            aria-current={data.sort === "amount" ? "page" : undefined}
            className={data.sort === "amount" ? "font-medium text-text underline" : "hover:text-text"}
          >
            Largest amount
          </Link>
        </nav>
      </div>

      <div className="mt-5 space-y-4">
        {data.groups.length === 0 && (
          <Card className="px-4 py-10 text-center text-sm text-subtle">
            {data.filter === "all" && !params.q ? "Nothing is owed on your accounts. Every invoice and order is paid." : "Nothing matches."}
          </Card>
        )}
        {data.groups.map((group) => (
          <Card key={group.companyId} className="p-0">
            <div className="flex flex-wrap items-baseline justify-between gap-2 border-b border-line px-4 py-3">
              <div className="min-w-0">
                {group.onTheirAccount ? (
                  <CompanyLink href={`${companyPath(group.companySeq)}?tab=statement`} className="font-medium text-text hover:underline">
                    {group.companyName}
                  </CompanyLink>
                ) : (
                  <span className="font-medium text-text">{group.companyName}</span>
                )}
                <span className="block text-xs text-subtle sm:ml-2 sm:inline">
                  {group.ownerName ? `Account manager: ${group.ownerName}` : "No account manager"}
                </span>
              </div>
              <div className="flex items-center gap-3">
                {arjun?.mayDraft && group.rows.some((r) => r.kind === "invoice" && (r.daysOverdue > 0 || r.broken)) && <DraftChaseButton companyId={group.companyId} variant="ghost" />}
                <div className="text-sm font-semibold text-text">{formatCurrency(group.total)}</div>
              </div>
            </div>

            {/*
             * On a phone (and the home-screen app) each invoice or order is a block of its own, with Log follow-up in reach —
             * the table below is wider than a phone, and its last column, the button, was a long sideways scroll away.
             */}
            <ul className="divide-y divide-line md:hidden">
              {group.rows.map((row) => (
                <li key={row.key} className="space-y-2 px-4 py-3 text-sm">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <RowLabel row={row} />
                    </div>
                    <div className="shrink-0 text-right">
                      <Outstanding row={row} />
                    </div>
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                    <span className="text-xs text-subtle">Due</span>
                    <DueOn row={row} clock={clock} />
                  </div>
                  <div className="text-xs">
                    <LastFollowUp row={row} clock={clock} staleDays={data.staleDays} />
                  </div>
                  {row.promise && (
                    <div className="text-xs">
                      <PromiseCell row={row} />
                    </div>
                  )}
                  <div className="flex flex-wrap items-center justify-between gap-2 text-xs">
                    <div className="flex flex-wrap items-center gap-x-1.5 gap-y-1">
                      <span className="text-subtle">Next follow-up:</span>
                      <NextFollowUp row={row} today={today} />
                    </div>
                    <LogFollowUp row={row} />
                  </div>
                </li>
              ))}
            </ul>

            {/*
             * `relative`: the table's own scroll box holds everything in it — the header's hidden "Actions" label (sr-only is
             * absolutely placed) escaped a box that wasn't, and stretched the page to the table's width, so a phone drew the
             * whole page zoomed out.
             */}
            <div className="relative hidden overflow-x-auto md:block">
              <table className="w-full text-sm">
                <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                  <tr>
                    <th className="px-4 py-2">Invoice / order</th>
                    <th className="px-3 py-2">Due</th>
                    <th className="px-3 py-2 text-right">Outstanding</th>
                    <th className="px-3 py-2">Last follow-up</th>
                    <th className="px-3 py-2">Promise</th>
                    <th className="px-3 py-2">Next follow-up</th>
                    <th className="px-4 py-2 text-right">
                      <span className="sr-only">Actions</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {group.rows.map((row) => (
                    <tr key={row.key} className="border-b border-line align-top last:border-0">
                      <td className="px-4 py-2.5">
                        <RowLabel row={row} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5">
                        <DueOn row={row} clock={clock} stacked />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-right">
                        <Outstanding row={row} />
                      </td>
                      <td className="min-w-56 px-3 py-2.5 text-xs">
                        <LastFollowUp row={row} clock={clock} staleDays={data.staleDays} />
                      </td>
                      <td className="px-3 py-2.5 text-xs">
                        <PromiseCell row={row} />
                      </td>
                      <td className="whitespace-nowrap px-3 py-2.5 text-xs">
                        <NextFollowUp row={row} today={today} stacked />
                      </td>
                      <td className="px-4 py-2.5 text-right">
                        <LogFollowUp row={row} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        ))}
      </div>
    </div>
  );
}

type Row = NonNullable<Awaited<ReturnType<typeof listCollections>>>["groups"][number]["rows"][number];

/** An invoice's or order's reference — its own page where the viewer may open it — and what it is. */
function RowLabel({ row }: { row: Row }) {
  // An order's label is its ORD- reference, which is the order page's own address.
  const href = row.onTheirAccount ? (row.kind === "invoice" ? `/documents/${row.id}` : `/orders/${row.label}`) : null;
  return (
    <>
      {href ? (
        <Link href={href} className="break-all font-mono text-xs text-text hover:underline">
          {row.label}
        </Link>
      ) : (
        <span className="break-all font-mono text-xs text-text">{row.label}</span>
      )}
      <div className="mt-0.5 text-xs text-subtle">
        {row.kind === "order" ? "Order — not invoiced yet" : "Tax invoice"}
        {!row.onTheirAccount && row.punchedBy ? ` · punched by ${row.punchedBy}` : ""}
      </div>
    </>
  );
}

/** When it's due, and how late. `stacked`: the date above the badge, as the table's column shows it. */
function DueOn({ row, clock, stacked = false }: { row: Row; clock: Clock; stacked?: boolean }) {
  // An invoice's due date is a typed day (midnight UTC); an order's, the moment its terms run out.
  const day = row.kind === "invoice" ? formatCalendarDay(row.dueOn) : clock.date(row.dueOn);
  const badge =
    row.daysOverdue > 0 ? (
      <Badge tone={row.daysOverdue > 90 ? "red" : "amber"}>
        {row.daysOverdue}d overdue · {BUCKET_LABEL[row.bucket]}
      </Badge>
    ) : (
      <Badge tone="default">Not yet due</Badge>
    );
  return stacked ? (
    <>
      <div className="text-muted">{day}</div>
      {badge}
    </>
  ) : (
    <>
      <span className="text-muted">{day}</span>
      {badge}
    </>
  );
}

function Outstanding({ row }: { row: Row }) {
  return (
    <>
      <div className="whitespace-nowrap font-medium text-text">{formatMoney(row.balance, row.currency)}</div>
      {!isBaseCurrency(row.currency) && <div className="whitespace-nowrap text-xs text-subtle">≈ {formatCurrency(row.balanceInr)}</div>}
    </>
  );
}

function LastFollowUp({ row, clock, staleDays }: { row: Row; clock: Clock; staleDays: number }) {
  if (!row.lastFollowUp) return <Badge tone="amber">Never followed up</Badge>;
  return (
    <>
      <div className="text-muted">
        <span className="text-text">{clock.date(row.lastFollowUp.createdAt)}</span> · {followUpChannelLabels[row.lastFollowUp.channel]}
        {row.lastFollowUp.byName ? ` · ${row.lastFollowUp.byName}` : ""}
      </div>
      <p className="mt-0.5 line-clamp-2 break-words text-text">{row.lastFollowUp.remarks}</p>
      {row.stale && <Badge tone="amber">No follow-up in {staleDays} days</Badge>}
      {row.history.length > 1 && (
        <details className="mt-1">
          <summary className="cursor-pointer text-muted hover:text-text">All {row.history.length} follow-ups</summary>
          <div className="mt-2">
            <FollowUpHistory history={row.history} showTarget={row.history.some((h) => h.targetLabel !== row.label)} />
          </div>
        </details>
      )}
    </>
  );
}

function PromiseCell({ row }: { row: Row }) {
  if (!row.promise) return <span className="text-subtle">—</span>;
  return (
    <div className="space-y-1">
      <div className="text-muted">{promiseText(row.promise)}</div>
      <PromiseBadge view={row.promise} />
    </div>
  );
}

function NextFollowUp({ row, today, stacked = false }: { row: Row; today: Date; stacked?: boolean }) {
  const next = row.nextFollowUpOn ? new Date(`${row.nextFollowUpOn}T00:00:00Z`) : null;
  if (!next) return <span className="text-subtle">Not planned</span>;
  const nextIn = daysBetween(today, next);
  const badge = nextIn < 0 ? <Badge tone="red">Missed</Badge> : nextIn === 0 ? <Badge tone="amber">Today</Badge> : null;
  return stacked ? (
    <>
      <div className="text-muted">{longDay(next)}</div>
      {badge}
    </>
  ) : (
    <>
      <span className="text-muted">{longDay(next)}</span>
      {badge}
    </>
  );
}

function LogFollowUp({ row }: { row: Row }) {
  return (
    <LogFollowUpButton
      target={{
        ...(row.kind === "invoice" ? { documentId: row.id } : { companyProductId: row.id }),
        label: row.label,
        companyName: row.companyName,
        balance: row.balance,
        currency: row.currency,
      }}
    />
  );
}

function Tile({ label, value, hint, tone }: { label: string; value: string; hint: string; tone?: "danger" }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className={`mt-1 text-lg font-semibold ${tone === "danger" ? "text-danger" : "text-text"}`}>{value}</div>
      <div className="mt-0.5 text-xs text-muted">{hint}</div>
    </Card>
  );
}
