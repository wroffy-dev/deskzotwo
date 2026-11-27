import { mayQuickMessage } from "@/actions/quick-messages";
import Link from "next/link";
import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { callSummary, listCallers, listCalls } from "@/actions/call";
import { Card } from "@/components/ui/card";
import { ClearFilters, MoreFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListHeader } from "@/components/ui/list-header";
import { ListFilter, Users } from "lucide-react";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { CallList } from "@/components/calls/call-list";
import { actingAsSuperAdmin } from "@/lib/authz/super-admin";
import { requireUser } from "@/lib/session";
import { hasTelephony } from "@/lib/telephony/connection";
import { callsLastRead } from "@/actions/telephony";
import { ReadCallsNow } from "@/components/calls/read-calls-now";
import { callOutcomeLabels, callOutcomeValues, formatDuration } from "@/lib/calls";

/**
 * The calling team's screen: what was dialled today, how much of it reached a person, and who
 * still has to be rung back.
 *
 * Connect rate leads rather than call count because dialling more numbers doesn't help if nobody
 * picks up, and a raw total hides that completely.
 */
export default async function CallsPage({
  searchParams,
}: {
  searchParams: Promise<{
    q?: string;
    outcome?: string;
    caller?: string;
    from?: string;
    to?: string;
    view?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  const enabled = await isModuleEnabled("calls");
  if (!enabled) return <ModuleDisabledNotice moduleKey="calls" />;

  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const dueView = params.view === "due";

  const [result, summary, callers, line] = await Promise.all([
    listCalls({
      page,
      pageSize,
      search: params.q,
      outcome: params.outcome,
      userId: params.caller,
      from: params.from,
      to: params.to,
      view: params.view,
    }),
    callSummary({ from: params.from, to: params.to, userId: params.caller }),
    listCallers(),
    hasTelephony(),
  ]);
  // CallerDesk's calls fetched now rather than at the next five-minute read (owner, 31 Oct 2026).
  const lastRead = line ? await callsLastRead() : null;

  const period = params.from || params.to ? "in this period" : "today";

  function tabHref(view?: string) {
    const next = { ...params, view, page: undefined };
    const query = Object.fromEntries(Object.entries(next).filter(([, v]) => v)) as Record<string, string>;
    return { pathname: "/calls", query };
  }

  return (
    <div className="animate-fade-rise">
      <ListHeader
        title="Calls"
        subtitle={`${result.total} ${result.total === 1 ? "call" : "calls"}`}
        search={<ToolbarSearch paramName="q" placeholder="Search" label="Search company, contact, number or notes" />}
        filters={
          <>
            <SelectParamFilter
              variant="pill"
              icon={<ListFilter />}
              paramName="outcome"
              label="Outcome"
              allLabel="Any"
              options={callOutcomeValues.map((o) => ({ value: o, label: callOutcomeLabels[o] }))}
            />
            <SelectParamFilter searchable
              variant="pill"
              icon={<Users />}
              paramName="caller"
              label="Caller"
              allLabel="Everyone"
              options={callers.map((c) => ({ value: c.id, label: c.name }))}
            />
            <MoreFilters params={[["from", "to"]]}>
              <DateRangePicker variant="stacked" fromParam="from" toParam="to" label="Called on" />
            </MoreFilters>
            <ClearFilters params={["q", "outcome", "caller", "from", "to"]} />
          </>
        }
      />
      <p className="mt-1 text-sm text-muted">
        Every call logged, and the callbacks still owed. Log one from the phone icon on any
        company, lead, ticket or renewal.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Calls {period}</div>
          <div className="mt-1 text-lg font-semibold text-text">{summary.total}</div>
          <div className="mt-0.5 text-xs text-muted">{summary.companiesReached} company(s) reached</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Connected</div>
          <div className="mt-1 text-lg font-semibold text-text">{summary.connected}</div>
          <div className="mt-0.5 text-xs text-muted">{summary.connectRate}% of dials reached a person</div>
        </Card>
        <Card className="px-4 py-3">
          <div className="text-xs uppercase tracking-wide text-subtle">Talk time</div>
          <div className="mt-1 text-lg font-semibold text-text">{formatDuration(summary.talkTimeSeconds)}</div>
          <div className="mt-0.5 text-xs text-muted">{period}</div>
        </Card>
        <Card className={`px-4 py-3 ${summary.dueCallbacks > 0 ? "border-warning/40" : ""}`}>
          <div className="text-xs uppercase tracking-wide text-subtle">Callbacks due</div>
          <div className={`mt-1 text-lg font-semibold ${summary.dueCallbacks > 0 ? "text-warning" : "text-text"}`}>
            {summary.dueCallbacks}
          </div>
          <div className="mt-0.5 text-xs text-muted">promised and past their time</div>
        </Card>
      </div>

      <div className="mt-5 flex flex-wrap gap-2">
        {[
          { label: "All calls", view: undefined },
          { label: "Callbacks owed", view: "due" },
        ].map((tab) => (
          <Link
            key={tab.label}
            href={tabHref(tab.view)}
            className={`rounded-full px-3 py-1 text-sm transition-colors ${
              (tab.view === "due") === dueView
                ? "bg-brand text-brand-contrast"
                : "border border-line-strong bg-surface text-muted hover:text-text"
            }`}
          >
            {tab.label}
          </Link>
        ))}
        {/* Each person's calling in a period (owner, 18 Oct 2026). */}
        <Link href="/calls/report" className="rounded-full border border-line-strong bg-surface px-3 py-1 text-sm text-muted transition-colors hover:text-text">
          Team report
        </Link>
        {/* Cloud calling's own figures — every call on the business's numbers (owner, 26 Oct 2026). */}
        {line && (
          <Link href="/calls/line" className="rounded-full border border-line-strong bg-surface px-3 py-1 text-sm text-muted transition-colors hover:text-text">
            Business line
          </Link>
        )}
        {lastRead && <ReadCallsNow lastRead={lastRead.at} />}
      </div>

      <div className="mt-5">
        <CallList
          calls={result.rows}
          canDelete={await actingAsSuperAdmin((await requireUser()).id)}
          canMessage={await mayQuickMessage()}
          emptyMessage={
            dueView
              ? "Nothing to call back. Every promised callback has been made."
              : "No calls match these filters."
          }
        />
      </div>

      <Pagination
        page={page}
        pageSize={pageSize}
        total={result.total}
        totalPages={totalPages(result.total, pageSize)}
        pageSizes={PAGE_SIZES}
      />
    </div>
  );
}
