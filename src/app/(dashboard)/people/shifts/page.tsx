import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { shiftsPage } from "@/actions/shifts";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { RosterGrid, ShiftsList } from "@/components/hr/shifts";

export const metadata = { title: "Shifts & roster" };

/**
 * People › Shifts & roster (owner, 31 Oct 2026 — src/actions/shifts.ts): the shifts, and a week of who works which —
 * HR sets both; everybody sees their own week, and a manager their team's.
 */
export default async function ShiftsPage({ searchParams }: { searchParams: Promise<{ week?: string; departmentId?: string }> }) {
  if (!(await isModuleEnabled("hr"))) return <ModuleDisabledNotice moduleKey="hr" />;
  const params = await searchParams;
  const view = await shiftsPage(params);
  const query = new URLSearchParams(params.departmentId ? { departmentId: params.departmentId } : {}).toString();
  return (
    <div className="animate-fade-rise space-y-4">
      <div>
        <h1 className="text-xl font-semibold text-text">Shifts &amp; roster</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Who works when. Each person has a standing shift, and any day can differ — another shift, or a week off. Without a shift, a day is the
          office hours, Monday to Friday.
        </p>
      </div>
      <ShiftsList shifts={view.shifts} canEdit={view.canEdit} />
      {view.departments.length > 0 && (
        <SelectParamFilter paramName="departmentId" label="Team" options={view.departments.map((d) => ({ value: d.id, label: d.name }))} />
      )}
      <RosterGrid rows={view.rows} shifts={view.shifts} week={view.week} canEdit={view.canEdit} query={query} />
    </div>
  );
}
