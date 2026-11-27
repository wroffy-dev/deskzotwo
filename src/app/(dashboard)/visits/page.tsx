import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import Link from "next/link";
import type { VisitStatus, VisitPurpose } from "@prisma/client";
import { listVisitsPaged, listVisitAssignees } from "@/actions/visit";
import { isModuleEnabled } from "@/actions/module";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ClearFilters, MoreFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListHeader } from "@/components/ui/list-header";
import { ListFilter, Users } from "lucide-react";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { DateRangePicker } from "@/components/ui/date-range-picker";
import { VisitsTable } from "@/components/visits/visits-table";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { visitPurposeValues, visitPurposeLabels, visitStatusValues, visitStatusLabels } from "@/lib/visits";

const asStatus = (v?: string) => (visitStatusValues.includes(v as VisitStatus) ? (v as VisitStatus) : undefined);
const asPurpose = (v?: string) => (visitPurposeValues.includes(v as VisitPurpose) ? (v as VisitPurpose) : undefined);

export default async function VisitsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    purpose?: string;
    rep?: string;
    q?: string;
    from?: string;
    to?: string;
    page?: string;
    pageSize?: string;
  }>;
}) {
  const enabled = await isModuleEnabled("visits");
  if (!enabled) return <ModuleDisabledNotice moduleKey="visits" />;

  const params = await searchParams;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);

  const [result, assignees] = await Promise.all([
    listVisitsPaged({
      status: asStatus(params.status),
      purpose: asPurpose(params.purpose),
      userId: params.rep,
      search: params.q,
      from: params.from,
      to: params.to,
      page,
      pageSize,
    }),
    listVisitAssignees(),
  ]);
  const w = await getWording();

  return (
    <div className="animate-fade-rise">
      <ListHeader
        title={slot(w, "Field visits", "visit")}
        subtitle={
          <>
            {result.total} {slot(w, "visit(s)", "visit", "{one:lower}(s)")}
            {result.openCount > 0 && ` · ${result.openCount} still open`}
          </>
        }
        search={<ToolbarSearch paramName="q" placeholder="Search" label={slot(w, "Search company, agenda or outcome", "company", "Search {one:lower}, agenda or outcome")} />}
        filters={
          <>
            <SelectParamFilter
              variant="pill"
              icon={<ListFilter />}
              paramName="status"
              label="Status"
              options={visitStatusValues.map((s) => ({ value: s, label: visitStatusLabels[s] }))}
            />
            <SelectParamFilter searchable
              variant="pill"
              icon={<Users />}
              paramName="rep"
              label="Rep"
              allLabel="Everyone visible"
              options={assignees.map((u) => ({ value: u.id, label: u.name }))}
            />
            <MoreFilters params={["purpose", ["from", "to"]]}>
              <SelectParamFilter
                variant="stacked"
                paramName="purpose"
                label="Purpose"
                options={visitPurposeValues.map((p) => ({ value: p, label: visitPurposeLabels[p] }))}
              />
              <DateRangePicker variant="stacked" fromParam="from" toParam="to" label="Scheduled" />
            </MoreFilters>
            <ClearFilters params={["q", "status", "purpose", "rep", "from", "to"]} />
          </>
        }
        actions={
          <Link href="/visits/new">
            <Button size="sm">{slot(w, "Plan visit", "visit", "Plan {one:lower}")}</Button>
          </Link>
        }
      />

      {result.total === 0 && !params.q && !params.status && (
        <Card className="mt-5 px-4 py-3 text-sm text-muted">
          Nothing planned yet. A visit records why you went, what came of it, and what it cost — plan one and the
          travel can be claimed straight against it.
        </Card>
      )}

      <div className="mt-5">
        <VisitsTable visits={result.rows} />
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
