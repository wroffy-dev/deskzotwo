import { getWording } from "@/lib/terms/server";
import { slot } from "@/lib/terms/dictionary";
import Link from "next/link";
import { listTicketsPaged, countOpenTickets, listSupportAgents } from "@/actions/ticket";
import { isModuleEnabled } from "@/actions/module";
import { hasEffectivePermission } from "@/actions/permission";
import { requireUser } from "@/lib/session";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { ClearFilters, MoreFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListHeader } from "@/components/ui/list-header";
import { ListFilter, Users } from "lucide-react";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { TicketsTable } from "@/components/tickets/tickets-table";
import { companiesOutOfReach } from "@/lib/companies/out-of-reach";
import { TicketSplitList } from "@/components/tickets/ticket-split-list";
import { TicketDetail } from "@/components/tickets/ticket-detail";
import { SplitListShell, SplitListEmpty, SplitListPage, resolveSelected } from "@/components/ui/split-list";
import { ViewModeToggle } from "@/components/ui/view-mode-toggle";
import { getViewMode } from "@/actions/view-mode";
import { Pagination } from "@/components/ui/pagination";
import { PAGE_SIZES, resolvePage, resolvePageSize, totalPages } from "@/lib/pagination";
import { ticketTypeLabels } from "@/lib/tickets";
import { ticketStatusValues, ticketPriorityValues, ticketTypeValues } from "@/lib/validation/ticket";
import type { TicketStatus, TicketPriority, TicketType } from "@prisma/client";

export default async function TicketsPage({
  searchParams,
}: {
  searchParams: Promise<{
    status?: string;
    priority?: string;
    type?: string;
    assignedTo?: string;
    q?: string;
    page?: string;
    pageSize?: string;
    sel?: string;
  }>;
}) {
  const enabled = await isModuleEnabled("helpdesk");
  if (!enabled) {
    return <ModuleDisabledNotice moduleKey="helpdesk" />;
  }

  const [params, viewer] = await Promise.all([searchParams, requireUser()]);
  const userId = viewer.id;
  const page = resolvePage(params.page);
  const pageSize = resolvePageSize(params.pageSize);
  const filters = {
    status: params.status as TicketStatus | undefined,
    priority: params.priority as TicketPriority | undefined,
    ticketType: params.type as TicketType | undefined,
    assignedToUserId: params.assignedTo,
    search: params.q,
  };
  const [viewMode, canCreate, result, supportAgents, openCount] = await Promise.all([
    getViewMode("tickets"),
    hasEffectivePermission(userId, "tickets.create"),
    listTicketsPaged({ ...filters, page, pageSize }),
    listSupportAgents(),
    countOpenTickets(filters),
  ]);

  // A role's tickets may reach further than its companies do; those names are no link.
  const shutCompanies = await companiesOutOfReach(userId, result.rows.map((t) => t.company.id));
  const selected = viewMode === "split" ? resolveSelected(result.rows, params.sel) : null;
  const w = await getWording();

  return (
    <SplitListPage active={viewMode === "split"}>
      <ListHeader
        title={slot(w, "Tickets", "ticket")}
        subtitle={`${result.total} total · ${openCount} open`}
        search={<ToolbarSearch paramName="q" placeholder="Search" label={slot(w, "Search title or company", "company", "Search title or {one:lower}")} />}
        filters={
          <>
            <SelectParamFilter
              variant="pill"
              icon={<ListFilter />}
              paramName="status"
              label="Status"
              options={ticketStatusValues.map((s) => ({ value: s, label: s.replaceAll("_", " ") }))}
            />
            <SelectParamFilter searchable
              variant="pill"
              icon={<Users />}
              paramName="assignedTo"
              label="Assigned to"
              allLabel="Everyone"
              options={[
                { value: "unassigned", label: "Unassigned" },
                ...supportAgents.map((u) => ({ value: u.id, label: u.name })),
              ]}
            />
            <MoreFilters params={["priority", "type"]}>
              <SelectParamFilter
                variant="stacked"
                paramName="priority"
                label="Priority"
                options={ticketPriorityValues.map((p) => ({ value: p, label: p }))}
              />
              <SelectParamFilter
                variant="stacked"
                paramName="type"
                label="Type"
                options={ticketTypeValues.map((t) => ({ value: t, label: ticketTypeLabels[t] }))}
              />
            </MoreFilters>
            <ClearFilters params={["q", "status", "priority", "type", "assignedTo"]} />
          </>
        }
        actions={
          <>
            <ViewModeToggle viewKey="tickets" mode={viewMode} />
            {canCreate && (
              <Link href="/tickets/new">
                <Button size="sm">{slot(w, "New ticket", "ticket", "New {one:lower}")}</Button>
              </Link>
            )}
          </>
        }
      />

      {viewMode === "split" ? (
        <SplitListShell
          countLabel={`${result.total} ${result.total === 1 ? slot(w, "ticket", "ticket", "{one:lower}") : slot(w, "tickets", "ticket", "{many:lower}")}`}
          listPane={<TicketSplitList tickets={result.rows} selectedId={selected} />}
        >
          {selected ? <TicketDetail id={selected} /> : <SplitListEmpty message={slot(w, "No tickets match these filters.", "ticket", "No {many:lower} match these filters.")} />}
        </SplitListShell>
      ) : (
        <>
          <Card className="mt-6 overflow-x-auto p-0">
            <TicketsTable tickets={result.rows} bulkAgents={supportAgents} shutCompanies={shutCompanies} />
          </Card>

          <Pagination
            page={page}
            pageSize={pageSize}
            total={result.total}
            totalPages={totalPages(result.total, pageSize)}
            pageSizes={PAGE_SIZES}
          />
        </>
      )}
    </SplitListPage>
  );
}
