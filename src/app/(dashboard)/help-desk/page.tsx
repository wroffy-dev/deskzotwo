import Link from "next/link";
import { LifeBuoy } from "lucide-react";
import { Badge, Card, CardHeader } from "@/components/ui/card";
import { TabNav } from "@/components/ui/tab-nav";
import { helpDeskViewer } from "@/components/desks/help-desk-gate";
import { ModuleDisabledNotice } from "@/components/settings/module-disabled-notice";
import { formatRequestId, isClosed, requestPath, spanWords, statusTone, statusWords } from "@/lib/desks/rules";
import { approvalsWaiting, liveDesks, myRequests } from "@/lib/desks/server";
import { DeskApprovalsList } from "@/components/desks/approvals-list";
import { isModuleEnabled } from "@/actions/module";
import { hrDeskConfig } from "@/lib/hr-desk/server";
import { teammate } from "@/lib/ai/teammates-server";
import { workspaceClock } from "@/lib/time/workspace";

export const metadata = { title: "Help desk" };
export const dynamic = "force-dynamic";

/** Help desk (owner, 25 Nov 2026 — src/lib/desks): the desks to ask, and what this person has asked. */
export default async function Page({ searchParams }: { searchParams: Promise<{ show?: string }> }) {
  if (!(await isModuleEnabled("desks"))) return <ModuleDisabledNotice moduleKey="desks" />;
  const gate = await helpDeskViewer();
  if ("instead" in gate) return gate.instead;
  const all = (await searchParams).show === "all";
  const [desks, rows, clock, priya, approvals] = await Promise.all([liveDesks(), myRequests(gate.viewer, all), workspaceClock(), askPriyaHere(), approvalsWaiting(gate.viewer.userId)]);
  return (
    <div className="animate-fade-rise space-y-6">
      <div>
        <h1 className="text-xl font-semibold text-text">Help desk</h1>
        <p className="mt-1 text-sm text-muted">Ask a team inside the company for something. Only you, that team and the super admin see it, and whoever approves it.</p>
      </div>

      <DeskApprovalsList waiting={approvals} clock={clock} />

      <section aria-labelledby="ask" className="space-y-2.5">
        <h2 id="ask" className="text-sm font-semibold text-text">
          What do you need help with?
        </h2>
        {desks.length === 0 && <Card className="px-5 py-8 text-center text-sm text-muted">No desk is taking requests just now.</Card>}
        <div className="grid gap-3.5 sm:grid-cols-2 xl:grid-cols-4">
          {desks.map((d) => (
            <Link key={d.id} href={`/help-desk/new?desk=${d.seq}`} className="flex flex-col gap-1.5 rounded-xl border border-line bg-surface p-4 shadow-sm transition-shadow duration-200 hover:shadow-md">
              <LifeBuoy aria-hidden="true" className="h-5 w-5 text-brand" />
              <span className="font-semibold text-text">{d.name}</span>
              {d.description && <span className="text-[13px] text-muted">{d.description}</span>}
              <span className="text-xs text-muted">First reply within {spanWords(d.times.SLOW.reply)}</span>
            </Link>
          ))}
          {priya && (
            <Link href="/people/me#ask" className="flex flex-col gap-1.5 rounded-xl border border-dashed border-line-strong p-4 hover:bg-surface">
              <LifeBuoy aria-hidden="true" className="h-5 w-5 text-muted" />
              <span className="font-semibold text-text">HR</span>
              <span className="text-[13px] text-muted">
                Leave, payslips and policies: ask {priya} on My HR, who passes on what she can&apos;t answer.
              </span>
            </Link>
          )}
        </div>
      </section>

      <Card>
        <CardHeader className="text-sm font-medium text-text">My requests</CardHeader>
        <div className="px-5 pt-2">
          <TabNav
            basePath="/help-desk"
            paramName="show"
            activeKey={all ? "all" : "open"}
            tabs={[
              { key: "open", label: "Open" },
              { key: "all", label: "All" },
            ]}
          />
        </div>
        {rows.length === 0 ? (
          <p className="px-5 py-8 text-center text-sm text-muted">{all ? "You haven't asked a desk for anything yet." : "Nothing open."}</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[640px] text-sm">
              <thead className="border-b border-line bg-surface-sunken text-left text-xs uppercase tracking-wide text-muted">
                <tr>
                  <th className="px-5 py-2.5 font-medium">Request</th>
                  <th className="px-3 py-2.5 font-medium">Desk</th>
                  <th className="px-3 py-2.5 font-medium">With</th>
                  <th className="px-3 py-2.5 font-medium">Status</th>
                  <th className="px-5 py-2.5 font-medium">Last update</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-line">
                {rows.map((r) => (
                  <tr key={r.id}>
                    <td className="px-5 py-2.5">
                      <Link href={requestPath(r.seq)} className="font-medium text-brand hover:underline">
                        {r.title}
                      </Link>
                      <div className="text-xs text-muted">{formatRequestId(r.seq)}</div>
                    </td>
                    <td className="px-3 py-2.5 text-muted">{r.desk.name}</td>
                    <td className="px-3 py-2.5 text-text">{r.assignedTo?.name ?? (isClosed(r.status) || r.status === "APPROVAL" ? "—" : "Not picked up yet")}</td>
                    <td className="px-3 py-2.5">
                      <Badge tone={statusTone(r.status)}>{statusWords(r.status, "requester")}</Badge>
                    </td>
                    <td className="whitespace-nowrap px-5 py-2.5 text-muted">{clock.dateTimeShort(r.lastActivityAt)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}

/** Priya's name, where the HR desk answers and this person has My HR; otherwise HR isn't mentioned. */
async function askPriyaHere(): Promise<string | null> {
  if (!(await isModuleEnabled("hr")) || !(await hrDeskConfig()).enabled) return null;
  return (await teammate("priya")).name;
}
