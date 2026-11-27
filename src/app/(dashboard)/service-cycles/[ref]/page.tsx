import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { notFound } from "next/navigation";
import { listAssignableUsers } from "@/actions/company";
import { isModuleEnabled } from "@/actions/module";
import { getCycle } from "@/actions/service-cycles";
import { CycleControls, JobTable } from "@/components/service-cycles/service-cycle-forms";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Badge } from "@/components/ui/card";
import { companyPath, orderPath } from "@/lib/record-links";
import { formatCalendarDay } from "@/lib/time/zone";

export const metadata = { title: "Service cycle" };

const STATUS_WORDS = { ACTIVE: "Running", STOPPED: "Stopped", ENDED: "Ended" } as const;

/** One cycle (owner, 9 Nov 2026): its whole timeline, and for whoever runs cycles, its dates, owner and stop. */
export default async function ServiceCyclePage({ params }: { params: Promise<{ ref: string }> }) {
  if (!(await isModuleEnabled("tasks"))) return <ModuleDisabledNotice moduleKey="tasks" />;
  const seq = Number((await params).ref);
  if (!Number.isInteger(seq) || seq < 1) notFound();
  const data = await getCycle(seq);
  if (!data) notFound();
  const { cycle, jobs, mayManage } = data;
  const people = mayManage ? (await listAssignableUsers()).map((p) => ({ id: p.id, name: p.name, email: p.email })) : [];
  return (
    <div className="animate-fade-rise space-y-4">
      <div>
        <Link href="/service-cycles?tab=cycles" className="text-xs text-brand hover:underline">Service cycles</Link>
        <h1 className="mt-1 flex flex-wrap items-center gap-2 text-xl font-semibold text-text">
          {cycle.templateName}
          <Badge tone={cycle.status === "ACTIVE" ? "green" : "default"}>{STATUS_WORDS[cycle.status]}</Badge>
        </h1>
        <p className="mt-1 text-sm text-muted">
          <CompanyLink href={companyPath(cycle.company.companySeq)} className="text-brand hover:underline">{cycle.company.name}</CompanyLink>
          {cycle.order && (
            <>
              {" · "}
              <Link href={orderPath(cycle.order.orderSeq)} className="text-brand hover:underline">its order</Link>
            </>
          )}
          {" · "}
          {formatCalendarDay(cycle.start)} to {formatCalendarDay(cycle.end)} · {cycle.progress.done} of {cycle.progress.total} done
          {cycle.progress.overdue > 0 && `, ${cycle.progress.overdue} overdue`}
        </p>
      </div>
      {mayManage && <CycleControls cycle={{ id: cycle.id, start: cycle.start, end: cycle.end, ownerUserId: data.ownerUserId, stopped: cycle.status === "STOPPED" }} people={people} />}
      <JobTable rows={jobs} mayManage={mayManage} showCycle={false} />
    </div>
  );
}
