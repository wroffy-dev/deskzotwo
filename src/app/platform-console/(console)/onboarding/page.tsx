import type { Metadata } from "next";
import { ArrowRightLeft, CircleCheck, CircleAlert, Flag as FlagIcon } from "lucide-react";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { EmptyState } from "@/components/console/kit/empty-state";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, RowLink, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { MIGRATION_SOURCES } from "@/lib/migration/state";
import { consoleStaff } from "@/lib/platform/console-page";
import { QUIET_DAYS, onboardingBoard, type SwitchProgress } from "@/lib/platform/onboarding";

export const metadata: Metadata = { title: "Onboarding" };

const num = (n: number) => n.toLocaleString("en-IN");
const sourceLabel = (s: string) => MIGRATION_SOURCES.find((x) => x.value === s)?.label.replace(/, through Deskzo's templates$/, "") ?? s;
const PULL: Record<string, string> = { FETCHING: "Fetching", STORING: "Handing over", PDFS: "Fetching PDFs", WAITING: "Waiting for tomorrow's calls", DONE: "Done", FAILED: "Stopped" };

/**
 * Onboarding (owner, 29 Oct 2026): every workspace bringing its year across into Deskzo — the switch, its Zoho pull,
 * the old-CRM import — and where each is stuck, the ones needing a hand first. Progress only, read from each
 * workspace (src/lib/platform/onboarding.ts); a fix inside one is support access, which its super admin grants.
 */
export default async function ConsoleOnboardingPage() {
  await consoleStaff(PAGE_ROLES.onboarding);
  const board = await onboardingBoard();
  const needLook = board.inProgress.filter((s) => s.flags.some((f) => f.tone === "danger" || f.tone === "warning")).length;
  const ready = board.inProgress.filter((s) => s.flags.some((f) => f.label === "Ready to finish")).length;

  return (
    <>
      <PageHeader
        title="Onboarding"
        subtitle={`Workspaces bringing their data into Deskzo, read from ${num(board.workspaces)} workspace${board.workspaces === 1 ? "" : "s"} — progress only, never their records`}
        asOf={board.asOf}
      />
      <div className="space-y-6">
        <KpiGrid>
          <KpiTile label="Switching now" value={num(board.inProgress.length)} icon={<ArrowRightLeft className="h-4 w-4" />} secondary="A switch open in the workspace" />
          <KpiTile
            label="Need a look"
            value={num(needLook)}
            icon={<CircleAlert className="h-4 w-4" />}
            tone={needLook > 0 ? "warning" : "neutral"}
            secondary={`Rows waiting or refused, a stopped pull, or quiet ${QUIET_DAYS}+ days`}
          />
          <KpiTile label="Ready to finish" value={num(ready)} icon={<FlagIcon className="h-4 w-4" />} tone={ready > 0 ? "success" : "neutral"} secondary="Every month agrees — nobody has finished" />
          <KpiTile label="Finished (30 days)" value={num(board.finished.length)} icon={<CircleCheck className="h-4 w-4" />} secondary="Full or sales only" />
        </KpiGrid>

        <Panel title="In progress" description="Worst first: anything stopped or refused, then waiting, then the longest quiet" padded={board.inProgress.length === 0}>
          {board.inProgress.length === 0 ? (
            <EmptyState
              icon={<ArrowRightLeft className="h-5 w-5" />}
              title="No workspace is switching to Deskzo just now."
              body="A workspace that starts Settings › Import & export › Switch to Deskzo is listed here until it finishes or undoes it."
            />
          ) : (
            <DataTable caption="Switches in progress" minWidth={1080}>
              <THead>
                <Th>Workspace</Th>
                <Th>Sections</Th>
                <Th>Month check</Th>
                <Th>Zoho pull</Th>
                <Th>Last activity</Th>
                <Th>Look at</Th>
              </THead>
              <TBody>
                {board.inProgress.map((s) => (
                  <Tr key={s.tenantId} interactive>
                    <Td>
                      <RowLink href={`/workspaces/${encodeURIComponent(s.slug)}`}>{s.name}</RowLink>
                      <p className="text-xs text-muted">
                        {sourceLabel(s.source)} · {s.yearStart} to {s.switchDate} · started <RelativeTime at={s.startedAt} absolute="date" />
                      </p>
                    </Td>
                    <Td>
                      <Sections s={s} />
                    </Td>
                    <Td nowrap>
                      {s.months.uploaded === 0 ? (
                        <span className="text-muted">No trial balance yet</span>
                      ) : (
                        <>
                          {num(s.months.agreeing)} of {num(s.months.total)} agree
                          {s.months.uploaded < s.months.total && <p className="text-xs text-muted">{num(s.months.uploaded)} uploaded</p>}
                        </>
                      )}
                    </Td>
                    <Td>
                      {s.pull ? (
                        <>
                          {PULL[s.pull.status] ?? s.pull.status}
                          {s.pull.module && ["FETCHING", "WAITING"].includes(s.pull.status) && <span className="text-muted"> · {s.pull.module}</span>}
                          <p className="text-xs text-muted tabular-nums">
                            {num(s.pull.callsToday)} of {num(s.pull.allowance)} calls today
                          </p>
                          {s.pull.error && <p className="text-xs text-danger">{s.pull.error.slice(0, 120)}</p>}
                        </>
                      ) : (
                        <span className="text-muted">{s.source === "zoho-books" ? "Files only" : "—"}</span>
                      )}
                    </Td>
                    <Td nowrap>
                      <RelativeTime at={s.lastActivity} />
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {s.flags.length === 0 ? <span className="text-muted">—</span> : s.flags.map((f) => <StatusPill key={f.label} tone={f.tone}>{f.label}</StatusPill>)}
                      </div>
                      {s.waitingFor.length > 0 && <p className="mt-1 text-xs text-muted">Waiting for {s.waitingFor.map((w) => `${w.label} (${num(w.n)})`).join(", ")}</p>}
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </DataTable>
          )}
        </Panel>

        {board.finished.length > 0 && (
          <Panel title="Finished in the last 30 days" padded={false}>
            <DataTable caption="Switches finished in the last 30 days" minWidth={480}>
              <THead>
                <Th>Workspace</Th>
                <Th>From</Th>
                <Th>Finished</Th>
              </THead>
              <TBody>
                {board.finished.map((f) => (
                  <Tr key={f.tenantId} interactive>
                    <Td>
                      <RowLink href={`/workspaces/${encodeURIComponent(f.slug)}`}>{f.name}</RowLink>
                    </Td>
                    <Td muted>{sourceLabel(f.source)}</Td>
                    <Td nowrap>
                      <RelativeTime at={f.finishedAt} absolute="date" />
                    </Td>
                  </Tr>
                ))}
              </TBody>
            </DataTable>
          </Panel>
        )}

        {board.unread.length > 0 && (
          <Panel title="Couldn't be read" description="These workspaces didn't answer — they may be switching too" tone="danger">
            <ul className="space-y-1 text-sm">
              {board.unread.map((u) => (
                <li key={u.tenantId}>
                  <span className="font-medium text-text">{u.name}</span> <span className="text-muted">({u.slug}) — {u.reason}</span>
                </li>
              ))}
            </ul>
          </Panel>
        )}
      </div>
    </>
  );
}

/** Each section that has something: how many came across, how far the file got, and what's left. */
function Sections({ s }: { s: SwitchProgress }) {
  if (s.sections.length === 0) return <span className="text-muted">Nothing brought yet</span>;
  return (
    <ul className="space-y-0.5 text-xs">
      {s.sections.map((x) => (
        <li key={x.key} className="text-text">
          <span className="font-medium">{x.label}</span> <span className="tabular-nums">{num(x.brought)}</span>
          {x.units > 0 && x.done < x.units && (
            <span className="text-muted">
              {" "}
              · {num(x.done)} of {num(x.units)} gone through
            </span>
          )}
          {x.waiting > 0 && <span className="text-warning"> · {num(x.waiting)} waiting</span>}
          {x.refused > 0 && <span className="text-danger"> · {num(x.refused)} refused</span>}
        </li>
      ))}
    </ul>
  );
}
