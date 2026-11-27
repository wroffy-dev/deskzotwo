import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { attendanceMonth, myDays, myToday } from "@/actions/attendance";
import { mayDeleteRecords } from "@/actions/super-admin-delete";
import { hrCapabilities, listPeople } from "@/actions/hr";
import { listDepartmentOptions } from "@/actions/department";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { ListHeader } from "@/components/ui/list-header";
import { ClearFilters, MoreFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListFilter, Users } from "lucide-react";
import { AttendanceGrid } from "@/components/hr/attendance-grid";
import { MyInOut } from "@/components/hr/my-in-out";
import { periodOf } from "@/lib/hr/period";
import { monthLabel } from "@/lib/hr/calendar";
import { workspaceClock } from "@/lib/time/workspace";
import { AttendancePrintMenu } from "@/components/hr/attendance-print-menu";

export default async function AttendancePage({
  searchParams,
}: {
  searchParams: Promise<{
    month?: string;
    year?: string;
    userId?: string;
    departmentId?: string;
    search?: string;
    flag?: string;
  }>;
}) {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;

  const params = await searchParams;
  // This month in the workspace's zone — UTC's was last month until 05:30 IST on the 1st.
  const clock = await workspaceClock();
  const now = clock.parts(new Date());
  // A person's own card opens on this week.
  const todayKey = clock.today();
  const week = periodOf("week", todayKey);
  const month = Math.min(12, Math.max(1, Number(params.month) || now.month + 1));
  const year = Math.min(2100, Math.max(2000, Number(params.year) || now.year));

  const [data, today, caps, departments, people, myWeek, canDelete] = await Promise.all([
    attendanceMonth({
      year,
      month,
      userId: params.userId,
      departmentId: params.departmentId,
      search: params.search,
      flag: params.flag,
    }),
    myToday(),
    hrCapabilities(),
    listDepartmentOptions(),
    listPeople({ status: "active" }),
    myDays({ from: week.from, to: week.to }),
    // Deleting a day is the super admin's alone (src/actions/super-admin-delete.ts).
    mayDeleteRecords(),
  ]);
  const filtered = data.rows.length !== data.totalPeople;
  // Somebody who sees only themselves gets their own page: no team or person to pick, their in and out first.
  const own = data.scope === "self";
  const visible = data.visibleIds ? new Set(data.visibleIds) : null;
  const pickable = visible ? people.filter((p) => visible.has(p.id)) : people;
  // Printing the month has its own permission (owner, 26 Nov 2026): HR's, an admin's and the super admin's by default.
  const mayPrint = caps.printAttendance;
  const printQuery = new URLSearchParams(
    Object.entries({ month: String(month), year: String(year), userId: params.userId, departmentId: params.departmentId, search: params.search, flag: params.flag }).filter(
      (e): e is [string, string] => !!e[1],
    ),
  ).toString();

  return (
    <div className="animate-fade-rise">
      {/* Somebody who sees only themselves has no team or person to pick: the title alone. */}
      <ListHeader
        title={own ? "My attendance" : "Manage attendance"}
        subtitle={own ? undefined : `${data.rows.length} ${data.rows.length === 1 ? "person" : "people"}`}
        actions={mayPrint ? <AttendancePrintMenu query={printQuery} onePerson={!!params.userId} /> : undefined}
        search={own ? undefined : <ToolbarSearch paramName="search" placeholder="Search" label="Name or employee code" />}
        filters={
          own ? undefined : (
            <>
              <SelectParamFilter searchable variant="pill" icon={<Users />} paramName="userId" label="Person" options={pickable.map((p) => ({ value: p.id, label: p.name }))} />
              {/* The reason anybody opens this screen on the 1st of the month. */}
              <SelectParamFilter
                variant="pill"
                icon={<ListFilter />}
                paramName="flag"
                label="Show"
                allLabel="Everyone"
                options={[
                  { value: "absent", label: "Had an absence" },
                  { value: "unrecorded", label: "Days not recorded" },
                  { value: "leave", label: "Took leave" },
                ]}
              />
              <MoreFilters params={["departmentId"]}>
                <SelectParamFilter variant="stacked" paramName="departmentId" label="Team" options={departments.map((d) => ({ value: d.id, label: d.name }))} />
              </MoreFilters>
              <ClearFilters params={["search", "departmentId", "userId", "flag"]} />
            </>
          )
        }
      />
      <p className="mt-2 text-sm text-muted">
        {own
          ? `${monthLabel(month, year)}. When you came in and left each day, and the hours in between.`
          : `${monthLabel(month, year)}. A dashed square is a working day nobody has recorded — not an absence.`}
        {!own && filtered && ` Showing ${data.rows.length} of ${data.totalPeople}.`}
      </p>

      {own && (
        <div className="mt-5">
          <MyInOut initial={{ period: week, days: myWeek }} today={todayKey} />
        </div>
      )}

      <div className="mt-4">
        <AttendanceGrid month={data} today={today} canMark={caps.manage || caps.viewAll} year={year} monthNumber={month} canSetHours={caps.manage} canDelete={canDelete} />
      </div>

      {/* Whoever sees more than themselves still has their own days — below the team's. */}
      {!own && (
        <div className="mt-6">
          <MyInOut initial={{ period: week, days: myWeek }} today={todayKey} />
        </div>
      )}
    </div>
  );
}
