import { isModuleEnabled } from "@/actions/module";
import { viewerHas } from "@/actions/permission";
import { Button } from "@/components/ui/button";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { hrCapabilities, listPeople } from "@/actions/hr";
import { listDepartmentOptions } from "@/actions/department";
import { Card } from "@/components/ui/card";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { ListHeader } from "@/components/ui/list-header";
import { ClearFilters, MoreFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListFilter } from "lucide-react";
import { PeopleTable } from "@/components/hr/people-table";
import { employmentTypeLabels, employmentTypeValues } from "@/lib/validation/hr";
import Link from "next/link";
import { resignationsToDecide } from "@/actions/resignation";
import { personPath } from "@/lib/record-links";
import { formatCalendarDay } from "@/lib/time/zone";

export default async function PeoplePage({
  searchParams,
}: {
  searchParams: Promise<{ search?: string; departmentId?: string; employmentType?: string; status?: string }>;
}) {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;

  const params = await searchParams;
  // Resignations waiting for this person — HR's every one, a manager's team's (owner, 31 Oct 2026).
  const resignations = await resignationsToDecide();
  const [people, departments, caps] = await Promise.all([
    listPeople(params),
    listDepartmentOptions(),
    hrCapabilities(),
  ]);

  const headcount = people.filter((p) => p.active && !p.employeeProfile?.exitedOn).length;
  const missingRecord = people.filter((p) => p.active && !p.employeeProfile).length;

  return (
    <div className="animate-fade-rise">
      <ListHeader
        title="People"
        subtitle={`${people.length} ${people.length === 1 ? "person" : "people"}`}
        search={<ToolbarSearch paramName="search" placeholder="Search" label="Name, email, code or designation" />}
        filters={
          <>
            <SelectParamFilter variant="pill" icon={<ListFilter />} paramName="departmentId" label="Team" options={departments.map((d) => ({ value: d.id, label: d.name }))} />
            <SelectParamFilter
              variant="pill"
              icon={<ListFilter />}
              paramName="status"
              label="Status"
              allLabel="Active"
              options={[
                { value: "all", label: "Everyone" },
                { value: "exited", label: "Exited" },
              ]}
            />
            <MoreFilters params={["employmentType"]}>
              <SelectParamFilter variant="stacked" paramName="employmentType" label="Type" options={employmentTypeValues.map((t) => ({ value: t, label: employmentTypeLabels[t] }))} />
            </MoreFilters>
            <ClearFilters params={["search", "departmentId", "employmentType", "status"]} />
          </>
        }
        actions={
          // Whoever may create accounts (owner, 4 Nov 2026 — an HR head held the permission with no button for it).
          (await viewerHas("users.manage")) ? (
            <Link href="/settings/users/new">
              <Button size="sm">Add a person</Button>
            </Link>
          ) : undefined
        }
      />
      <p className="mt-2 text-sm text-muted">
        {caps.manage || caps.viewAll
          ? "Everyone on the payroll, their employment terms, and the records HR keeps."
          : "The staff directory. You can open your own record and those of the people who report to you."}
      </p>

      {resignations.length > 0 && (
        <Card className="mt-5 border-warning/40 p-4">
          <h2 className="text-sm font-semibold text-text">
            {resignations.length === 1 ? "A resignation is waiting for you" : `${resignations.length} resignations are waiting for you`}
          </h2>
          <ul className="mt-2 divide-y divide-line">
            {resignations.map((r) => (
              <li key={r.id} className="flex flex-wrap items-center justify-between gap-2 py-2 text-sm">
                <Link href={personPath(r.person.userSeq)} className="font-medium text-text hover:underline">
                  {r.person.name}
                </Link>
                <span className="text-xs text-muted">
                  handed in {formatCalendarDay(new Date(`${r.submittedOn}T00:00:00Z`))} · last day asked {formatCalendarDay(new Date(`${r.requestedLastDay}T00:00:00Z`))}
                  {r.shortfall > 0 ? ` · ${r.shortfall} days of notice short` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="Headcount" value={headcount} hint="active, not exited" />
        <Stat label="Listed here" value={people.length} hint="matching this filter" />
        <Stat
          label="No HR record"
          value={missingRecord}
          hint={missingRecord > 0 ? "a login with no employment details" : "every active login has one"}
        />
        <Stat label="Teams" value={departments.length} hint="departments on file" />
      </div>

      <div className="mt-4">
        <PeopleTable people={people} />
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-1 text-lg font-semibold text-text">{value.toLocaleString("en-IN")}</div>
      <div className="mt-0.5 text-xs text-muted">{hint}</div>
    </Card>
  );
}
