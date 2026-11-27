import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge, Card } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { helpDeskViewer } from "@/components/desks/help-desk-gate";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { isModuleEnabled } from "@/actions/module";
import { PickUpButton } from "@/components/desks/request-controls";
import { deskLabel, deskPath, dueState, dueWords, formatRequestId, LEVEL_SHORT, levelTone, requestPath, statusTone, statusWords, type Level } from "@/lib/desks/rules";
import { deskQueue, QUEUE_LABELS, QUEUE_TABS, type QueueTab } from "@/lib/desks/server";
import { workspaceClock } from "@/lib/time/workspace";

export const metadata = { title: "Help desk" };
export const dynamic = "force-dynamic";

/** One desk's list, for its people and the super admin (src/lib/desks). To anybody else it isn't there. */
export default async function Page({ params, searchParams }: { params: Promise<{ seq: string }>; searchParams: Promise<{ tab?: string }> }) {
  if (!(await isModuleEnabled("desks"))) return <ModuleDisabledNotice moduleKey="desks" />;
  const gate = await helpDeskViewer();
  if ("instead" in gate) return gate.instead;
  const seq = Number((await params).seq);
  const asked = (await searchParams).tab;
  const tab: QueueTab = (QUEUE_TABS as readonly string[]).includes(asked ?? "") ? (asked as QueueTab) : "open";
  const now = new Date();
  const q = Number.isInteger(seq) && seq > 0 && seq < 2_000_000_000 ? await deskQueue(gate.viewer, seq, tab, now) : null;
  if (!q) notFound();
  const clock = await workspaceClock();
  const others = q.people.filter((p) => p.id !== gate.viewer.userId).map((p) => p.name);
  return (
    <div className="animate-fade-rise space-y-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-xl font-semibold text-text">{deskLabel(q.desk.name)}</h1>
          <p className="mt-1 text-sm text-muted">
            Requests from colleagues. {others.length > 0 ? `On this desk: ${others.join(", ")}${q.people.some((p) => p.id === gate.viewer.userId) ? " and you" : ""}.` : q.people.length > 0 ? "You're the only one on this desk." : "Nobody is in its department, so it isn't taking requests."}
            {!q.desk.active && " It's switched off: no new requests."}
          </p>
        </div>
        {q.desk.active && q.people.length > 0 && (
          <Link href={`/help-desk/new?desk=${q.desk.seq}&for=colleague`} className="inline-flex h-9 items-center rounded-base border border-line-strong bg-surface px-3.5 text-sm font-medium text-text shadow-sm hover:bg-surface-sunken">
            Raise for a colleague
          </Link>
        )}
      </div>
      <TabNav basePath={deskPath(q.desk.seq)} activeKey={tab} tabs={QUEUE_TABS.map((t) => ({ key: t, label: QUEUE_LABELS[t], ...(t === "resolved" ? {} : { count: q.counts[t] }) }))} />
      <Card>
        {q.rows.length === 0 ? (
          <p className="px-5 py-10 text-center text-sm text-muted">{EMPTY[tab]}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[820px] text-sm">
              <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Request</th>
                  <th className="px-3 py-2.5 font-medium">From</th>
                  <th className="px-3 py-2.5 font-medium">Holding up</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-3 py-2.5 font-medium">Due</th>
                  <th className="px-5 py-2.5 font-medium">With</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {q.rows.map((r) => {
                  const due = dueState(r, now);
                  const late = (due.kind === "reply" || due.kind === "fix") && due.late;
                  return (
                    <tr key={r.id}>
                      <td className="px-5 py-2.5">
                        <Link href={requestPath(r.seq)} className="font-medium text-brand hover:underline">
                          {r.title}
                        </Link>
                        <div className="text-xs text-muted">
                          {formatRequestId(r.seq)}
                          {r.type && `, ${r.type.name}`}
                        </div>
                      </td>
                      <td className="px-3 py-2.5 text-text">
                        {r.requester.name}
                        {r.requester.department && <div className="text-xs text-muted">{r.requester.department.name}</div>}
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={levelTone(r.level)}>{LEVEL_SHORT[r.level as Level] ?? r.level}</Badge>
                      </td>
                      <td className="px-3 py-2.5">
                        <Badge tone={statusTone(r.status)}>{statusWords(r.status, "desk")}</Badge>
                      </td>
                      <td className={late ? "px-3 py-2.5 font-medium text-danger" : "px-3 py-2.5 text-muted"}>{dueWords(due, (at) => clock.dateTimeShort(at))}</td>
                      <td className="px-5 py-2.5 text-text">{r.assignedTo?.name ?? (r.status === "RESOLVED" ? "—" : <PickUpButton id={r.id} title={r.title} />)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

const EMPTY: Record<QueueTab, string> = {
  open: "Nothing open.",
  free: "Nothing is waiting to be picked up.",
  mine: "You have nothing open.",
  late: "Nothing is overdue.",
  resolved: "Nothing resolved yet.",
};
