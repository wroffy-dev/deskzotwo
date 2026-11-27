import { isModuleEnabled } from "@/actions/module";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { hrCapabilities } from "@/actions/hr";
import { listDepartmentOptions, listManagerOptions } from "@/actions/department";
import { listCandidates } from "@/actions/candidate";
import { Card } from "@/components/ui/card";
import { SelectParamFilter } from "@/components/ui/select-param-filter";
import { ListHeader } from "@/components/ui/list-header";
import { ClearFilters, ToolbarSearch } from "@/components/ui/filter-toolbar";
import { ListFilter } from "lucide-react";
import { HiringBoard } from "@/components/hr/hiring-board";
import { actorContext, startsEmployeesOnly } from "@/lib/authz/guards";
import { currentUser } from "@/lib/session";
import { candidateStatusLabels } from "@/lib/hr/onboarding";

export default async function HiringPage({
  searchParams,
}: {
  searchParams: Promise<{ status?: string; search?: string }>;
}) {
  const enabled = await isModuleEnabled("hr");
  if (!enabled) return <ModuleDisabledNotice moduleKey="hr" />;

  const caps = await hrCapabilities();
  if (!caps.manage) {
    return (
      <Card className="px-6 py-10 text-center text-sm text-muted">
        Hiring is HR&apos;s. Offers, salaries and candidates&apos; personal details sit behind the same permission as
        the rest of the personnel file.
      </Card>
    );
  }

  const viewer = await currentUser();
  const employeesOnly = viewer ? await startsEmployeesOnly(await actorContext(viewer.id)) : true;
  const params = await searchParams;
  const [candidates, departments, managers] = await Promise.all([
    listCandidates(params),
    listDepartmentOptions(),
    listManagerOptions(),
  ]);

  const accepted = candidates.filter((c) => c.status === "ACCEPTED");
  // The number HR is actually chasing: accepted offers whose intake form has not come back.
  const awaitingDetails = candidates.filter((c) => c.status !== "PROSPECT" && !c.intakeSubmittedAt).length;
  // One reading of the clock, taken once rather than per candidate.
  const cutoff = new Date().getTime() + 30 * 86400000;
  const joiningSoon = accepted.filter(
    (c) => c.expectedJoining && new Date(c.expectedJoining).getTime() < cutoff,
  ).length;

  return (
    <div className="animate-fade-rise">
      <ListHeader
        title="Hiring"
        subtitle={`${candidates.length} ${candidates.length === 1 ? "candidate" : "candidates"}`}
        search={<ToolbarSearch paramName="search" placeholder="Search" label="Name, email or role" />}
        filters={
          <>
            <SelectParamFilter
              variant="pill"
              icon={<ListFilter />}
              paramName="status"
              label="Status"
              allLabel="Live only"
              options={Object.entries(candidateStatusLabels).map(([value, label]) => ({ value, label }))}
            />
            <ClearFilters params={["search", "status"]} />
          </>
        }
      />
      <p className="mt-2 text-sm text-muted">
        Everyone offered a job but not yet on the payroll. Nobody here has a login — an account is created at the
        moment they are converted, which is also when their details, documents and offer letter move onto a real
        employee record.
      </p>

      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Stat label="In the pipeline" value={candidates.length} hint="matching this filter" />
        <Stat label="Offers accepted" value={accepted.length} hint="waiting to be converted" />
        <Stat label="Joining within 30 days" value={joiningSoon} hint="prepare their setup now" />
        <Stat
          label="Details outstanding"
          value={awaitingDetails}
          hint={awaitingDetails > 0 ? "chase the intake form" : "every offer has its form back"}
        />
      </div>

      <div className="mt-4">
        <HiringBoard candidates={candidates} departments={departments} managers={managers} employeesOnly={employeesOnly} />
      </div>
    </div>
  );
}

function Stat({ label, value, hint }: { label: string; value: number; hint: string }) {
  return (
    <Card className="px-4 py-3">
      <div className="text-xs uppercase tracking-wide text-subtle">{label}</div>
      <div className="mt-1 text-2xl font-semibold tabular-nums text-text">{value}</div>
      <div className="mt-0.5 text-xs text-muted">{hint}</div>
    </Card>
  );
}
