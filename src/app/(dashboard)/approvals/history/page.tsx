import Link from "next/link";
import { ListFilter, Users, CheckCheck } from "lucide-react";
import { requireUser } from "@/lib/session";
import { hasEffectivePermission } from "@/actions/permission";
import { listApprovalHistory, type ApprovalHistoryFilters } from "@/actions/approval-history";
import { APPROVAL_DECISIONS, APPROVAL_KINDS } from "@/lib/approvals/kinds";
import { resolvePage, resolvePageSize, totalPages, PAGE_SIZES } from "@/lib/pagination";
import { Card } from "@/components/ui/card";
import { Pagination } from "@/components/ui/pagination";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { ListHeader } from "@/components/ui/list-header";
import { ClearFilters, MoreFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ApprovalHistoryTable } from "@/components/approvals/approval-history-table";

export const metadata = { title: "Approvals history" };

/**
 * Approvals › History (owner, 30 Oct 2026): who approved, rejected or sent back what, wherever approval is needed —
 * orders, prices, quotations, expenses, leave, vouchers… Everybody sees their own decisions and those on what they
 * asked for; "See everyone's activity" sees them all (src/actions/approval-history.ts decides, on every call).
 */
export default async function ApprovalsHistoryPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const params = await searchParams;
  const one = (key: string) => (Array.isArray(params[key]) ? params[key][0] : params[key]) as string | undefined;
  const user = await requireUser();
  const filters: ApprovalHistoryFilters = { from: one("from"), to: one("to"), kind: one("kind"), decision: one("decision"), person: one("person"), q: one("q"), whose: one("whose") };
  const page = resolvePage(one("page"));
  const pageSize = resolvePageSize(one("pageSize"));
  const [result, canExport] = await Promise.all([listApprovalHistory(filters, { page, pageSize }), hasEffectivePermission(user.id, "activity.export")]);
  const data = result.ok ? result.data : { rows: [], total: 0, people: [], all: false, mayAll: false };

  return (
    <div className="animate-fade-rise">
      <ListHeader
        title="Approvals history"
        subtitle={`${data.total.toLocaleString("en-IN")} ${data.total === 1 ? "decision" : "decisions"}${data.all ? "" : " — yours, and on what you asked for"}`}
        search={<ToolbarSearch paramName="q" placeholder="Search" label="Search records and notes" />}
        filters={
          <>
            {/* Theirs first (owner, 9 Nov 2026); everybody's only for whoever may see everyone's activity, when they ask. */}
            {data.mayAll && (
              <SelectParamFilter variant="pill" icon={<Users />} paramName="whose" label="Whose" allLabel="Yours" options={[{ value: "everyone", label: "Everyone's" }]} />
            )}
            <SelectParamFilter variant="pill" icon={<ListFilter />} paramName="kind" label="What" allLabel="Everything" options={Object.entries(APPROVAL_KINDS).map(([value, label]) => ({ value, label }))} />
            <SelectParamFilter variant="pill" icon={<CheckCheck />} paramName="decision" label="Decision" allLabel="Any" options={Object.entries(APPROVAL_DECISIONS).map(([value, label]) => ({ value, label }))} />
            {data.people.length > 0 && (
              <SelectParamFilter searchable variant="pill" icon={<Users />} paramName="person" label="Decided by" allLabel="Anyone" options={data.people.map((p) => ({ value: p.id, label: p.name }))} />
            )}
            <MoreFilters params={[["from", "to"]]}>
              <DateRangePicker variant="stacked" fromParam="from" toParam="to" label="Date" />
            </MoreFilters>
            <ClearFilters params={["q", "whose", "kind", "decision", "person", "from", "to"]} />
          </>
        }
        actions={
          <Link href="/approvals" className="rounded-full border border-line-strong bg-surface px-3 py-1 text-sm text-muted transition-colors hover:text-text">
            Waiting for you
          </Link>
        }
      />
      <p className="mt-2 max-w-3xl text-sm text-muted">
        Every approval, rejection and send-back — who decided, on what, who asked, and why. Decisions from before this history began come from
        what each record kept, so they show only its latest decision.
      </p>
      <Card className="mt-4 overflow-hidden">
        {!result.ok ? <p className="px-4 py-8 text-center text-sm text-danger">{result.error}</p> : <ApprovalHistoryTable rows={data.rows} filters={filters} canExport={canExport} />}
      </Card>
      {data.total > 0 && (
        <div className="mt-4">
          <Pagination page={page} pageSize={pageSize} total={data.total} totalPages={totalPages(data.total, pageSize)} pageSizes={PAGE_SIZES} label="decisions" />
        </div>
      )}
    </div>
  );
}
