import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { notFound } from "next/navigation";
import { isModuleEnabled } from "@/actions/module";
import { listCycles, listDueWork, listTemplates } from "@/actions/service-cycles";
import { JobTable } from "@/components/service-cycles/service-cycle-forms";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { Button } from "@/components/ui/button";
import { Badge, Card } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { companyPath, orderPath } from "@/lib/record-links";
import type { DueWindow } from "@/lib/service-cycles/server";
import { formatCalendarDay } from "@/lib/time/zone";

export const metadata = { title: "Service cycles" };

const WINDOWS: { key: DueWindow; label: string }[] = [
  { key: "overdue", label: "Overdue" },
  { key: "month", label: "This month" },
  { key: "next30", label: "Next 30 days" },
  { key: "all", label: "Everything to do" },
];

/**
 * Service cycles (owner, 9 Nov 2026 — src/actions/service-cycles.ts): the work every customer's cycles owe, the cycles,
 * and the plans they're started from.
 */
export default async function ServiceCyclesPage({ searchParams }: { searchParams: Promise<{ tab?: string; when?: string; mine?: string }> }) {
  if (!(await isModuleEnabled("tasks"))) return <ModuleDisabledNotice moduleKey="tasks" />;
  const params = await searchParams;
  const tab = params.tab === "cycles" || params.tab === "plans" ? params.tab : "due";
  const when = (WINDOWS.find((w) => w.key === params.when)?.key ?? "month") as DueWindow;
  const mine = params.mine === "1";
  const [due, cycles, plans] = await Promise.all([
    tab === "due" ? listDueWork(when, mine) : Promise.resolve(null),
    tab === "cycles" ? listCycles() : Promise.resolve(null),
    listTemplates(),
  ]);
  if (!plans) notFound();
  const mayManage = plans.mayManage;
  const statusWords = { ACTIVE: "Running", STOPPED: "Stopped", ENDED: "Ended" } as const;

  return (
    <div className="animate-fade-rise space-y-4">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">Service cycles</h1>
          <p className="mt-1 max-w-3xl text-sm text-muted">
            The work a contract promises, on a timeline: each job becomes a task for its owner when it&apos;s near, and is done when the task is.
          </p>
        </div>
        {mayManage && (
          <div className="flex gap-2">
            <Link href="/service-cycles/templates/new">
              <Button size="sm" variant="secondary">New plan</Button>
            </Link>
            {plans.rows.some((p) => p.active) && (
              <Link href="/service-cycles/new">
                <Button size="sm">Start a cycle</Button>
              </Link>
            )}
          </div>
        )}
      </div>
      <TabNav
        basePath="/service-cycles"
        activeKey={tab}
        tabs={[
          { key: "due", label: "Work due" },
          { key: "cycles", label: "Cycles" },
          { key: "plans", label: "Plans", count: plans.rows.length },
        ]}
      />

      {tab === "due" && due && (
        <>
          <div className="flex flex-wrap items-center gap-1.5">
            {WINDOWS.map((w) => (
              <Link
                key={w.key}
                href={{ pathname: "/service-cycles", query: { when: w.key, ...(mine ? { mine: "1" } : {}) } }}
                className={`rounded-full border px-3 py-1 text-xs ${w.key === when ? "border-brand bg-brand text-brand-contrast" : "border-line text-text hover:bg-surface-sunken"}`}
              >
                {w.label}
              </Link>
            ))}
            <Link href={{ pathname: "/service-cycles", query: { when, ...(mine ? {} : { mine: "1" }) } }} className="ml-2 text-xs text-brand hover:underline">
              {mine ? "Everybody's" : "Only mine"}
            </Link>
          </div>
          <JobTable rows={due.rows} mayManage={due.mayManage} showCycle />
        </>
      )}

      {tab === "cycles" &&
        cycles &&
        (cycles.rows.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted">No cycles yet.{mayManage && " Start one for a customer from a plan."}</Card>
        ) : (
          <Card className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="bg-surface-sunken text-left text-xs text-muted">
                <tr>
                  <th className="px-3 py-2 font-medium">Customer</th>
                  <th className="px-3 py-2 font-medium">Plan</th>
                  <th className="px-3 py-2 font-medium">From</th>
                  <th className="px-3 py-2 font-medium">To</th>
                  <th className="px-3 py-2 font-medium">Owner</th>
                  <th className="px-3 py-2 font-medium">Done</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {cycles.rows.map((c) => (
                  <tr key={c.id} className="border-t border-line">
                    <td className="px-3 py-2">
                      <CompanyLink href={companyPath(c.company.companySeq)} className="text-brand hover:underline">{c.company.name}</CompanyLink>
                    </td>
                    <td className="px-3 py-2">
                      <Link href={`/service-cycles/${c.seq}`} className="text-brand hover:underline">{c.templateName}</Link>
                      {c.order && (
                        <Link href={orderPath(c.order.orderSeq)} className="ml-2 text-xs text-muted hover:underline">order</Link>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2">{formatCalendarDay(c.start)}</td>
                    <td className="whitespace-nowrap px-3 py-2">{formatCalendarDay(c.end)}</td>
                    <td className="px-3 py-2">{c.owner?.name ?? <span className="text-muted">Nobody</span>}</td>
                    <td className="px-3 py-2 tabular-nums">
                      {c.progress.done} of {c.progress.total}
                      {c.progress.overdue > 0 && <Badge tone="red" className="ml-2">{c.progress.overdue} overdue</Badge>}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={c.status === "ACTIVE" ? "green" : "default"}>{statusWords[c.status]}</Badge>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </Card>
        ))}

      {tab === "plans" &&
        (plans.rows.length === 0 ? (
          <Card className="p-6 text-center text-sm text-muted">
            No plans yet. A plan is the steps a contract promises and how often each comes round: a quarterly visit, a yearly audit, a monthly return.
          </Card>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {plans.rows.map((p) => (
              <Link key={p.id} href={`/service-cycles/templates/${p.seq}`}>
                <Card className="h-full p-4 hover:bg-surface-sunken">
                  <div className="flex items-start justify-between gap-2">
                    <span className="font-medium text-text">{p.name}</span>
                    {!p.active && <Badge>Put away</Badge>}
                  </div>
                  <p className="mt-1 text-xs text-muted">
                    {p.months} months · {p.steps} {p.steps === 1 ? "step" : "steps"} · {p.cycles} {p.cycles === 1 ? "cycle" : "cycles"}
                  </p>
                </Card>
              </Link>
            ))}
          </div>
        ))}
    </div>
  );
}
