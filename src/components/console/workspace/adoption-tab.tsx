import { Activity, LogIn, PencilLine, TrendingDown, TrendingUp, UserX, Users } from "lucide-react";
import { AreaTrend } from "@/components/console/charts/area-trend";
import { ChartFrame, ChartTable } from "@/components/console/charts/chart-frame";
import { KpiGrid, KpiTile } from "@/components/console/charts/kpi-tile";
import { EmptyState } from "@/components/console/kit/empty-state";
import { Panel } from "@/components/console/kit/panel";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { dayKeyLabel, percent, plural } from "@/lib/console-shared/format";
import type { Tone } from "@/lib/console-shared/types";
import type { AdoptionPanel, AdoptionTrend, ModuleUse } from "@/lib/platform/adoption-view";
import type { Clock } from "@/lib/time/zone";

/**
 * Workspace 360 › Adoption (owner, 23 Nov 2026): how much its people use it, and what for — counted nightly from its
 * own logs (src/lib/platform/adoption.ts). Counts only: people are numbered, never named; staff who need more go in
 * as support on its super admin's grant. Read-only for every role.
 */

const INTEGER = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 0 });
const ONE_PLACE = new Intl.NumberFormat("en-IN", { maximumFractionDigits: 1 });

const TREND: Record<AdoptionTrend, { label: string; tone: Tone }> = {
  rising: { label: "Rising", tone: "success" },
  steady: { label: "Steady", tone: "info" },
  dropping: { label: "Dropping", tone: "danger" },
  quiet: { label: "Quiet", tone: "warning" },
};

const MODULE_STATE: Record<ModuleUse["state"], { label: string; tone: Tone }> = {
  used: { label: "Used", tone: "success" },
  light: { label: "Barely used", tone: "warning" },
  unused: { label: "Not used", tone: "danger" },
  uncounted: { label: "Not counted", tone: "neutral" },
};

const hours = (minutes: number) => (minutes < 60 ? `${minutes} min` : `${ONE_PLACE.format(minutes / 60)} h`);

export function AdoptionTab({ adoption, clock }: { adoption: AdoptionPanel; clock: Clock }) {
  const { days, people, modules, areas } = adoption;

  if (days.length === 0 && people.length === 0) {
    return (
      <Panel title="Adoption">
        <EmptyState
          icon={<Activity className="h-5 w-5" />}
          title="Not counted yet."
          body="The platform tick counts each workspace's sign-ins, time on the app and changes once a day, from its own logs. The first count goes back 90 days."
        />
      </Panel>
    );
  }

  const trend = TREND[adoption.trend];
  const asleep = people.filter((p) => !p.lastActiveOn || p.lastActiveOn < dayKeyOf(adoption.today, -29));
  const unused = modules.filter((m) => m.state === "unused");
  const thirty = days.filter((d) => d.day >= dayKeyOf(adoption.today, -29));
  const signIns30 = thirty.reduce((t, d) => t + d.signIns, 0);
  const changes30 = thirty.reduce((t, d) => t + d.changes, 0);
  const minutes30 = thirty.reduce((t, d) => t + d.activeMinutes, 0);

  return (
    <div className="space-y-6">
      <KpiGrid columns={4}>
        <KpiTile
          label="Active in the last 7 days"
          icon={<Users className="h-4 w-4" />}
          tone={adoption.seats > 0 && adoption.active7 / adoption.seats < 0.5 ? "warning" : "neutral"}
          value={INTEGER.format(adoption.active7)}
          meter={{ value: adoption.active7, max: adoption.seats, label: "People active this week against people with a seat" }}
          secondary={`of ${plural(adoption.seats, "person", "people")} with a seat · ${INTEGER.format(adoption.active30)} in 30 days`}
        />
        <KpiTile
          label="Daily active, week on week"
          icon={adoption.trend === "dropping" ? <TrendingDown className="h-4 w-4" /> : <TrendingUp className="h-4 w-4" />}
          tone={adoption.trend === "dropping" ? "danger" : adoption.trend === "rising" ? "success" : "neutral"}
          value={ONE_PLACE.format(adoption.lastWeek)}
          secondary={
            <span className="inline-flex flex-wrap items-center gap-1.5">
              <StatusPill tone={trend.tone}>{trend.label}</StatusPill>
              {`a day, from ${ONE_PLACE.format(adoption.weekBefore)} the week before`}
            </span>
          }
        />
        <KpiTile
          label="Seats nobody used in 30 days"
          icon={<UserX className="h-4 w-4" />}
          tone={asleep.length > 0 ? "warning" : "success"}
          value={INTEGER.format(asleep.length)}
          secondary={adoption.neverActive > 0 ? `${plural(adoption.neverActive, "person", "people")} never signed in` : "Everyone has signed in at some point"}
        />
        <KpiTile
          label="Last 30 days"
          icon={<PencilLine className="h-4 w-4" />}
          value={INTEGER.format(changes30)}
          secondary={`changes · ${INTEGER.format(signIns30)} sign-ins · ${hours(minutes30)} on the app`}
        />
      </KpiGrid>

      {days.length > 0 && (
        <ChartFrame
          title="People active each day"
          description="Over the last 90 days, on the workspace's own clock: a sign-in, time on the app or a change. The dashed line is the people with a seat now."
          table={
            <ChartTable
              columns={["Day", "Active people", "Sign-ins", "Time on the app", "Changes"]}
              rows={[...days].reverse().map((d) => [dayKeyLabel(d.day), d.activeUsers, d.signIns, hours(d.activeMinutes), d.changes])}
            />
          }
        >
          <AreaTrend
            label="People active each day"
            points={days.map((d) => ({ key: d.day, label: dayKeyLabel(d.day, false), value: d.activeUsers }))}
            limit={adoption.seats || null}
            limitLabel="People with a seat"
          />
        </ChartFrame>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Panel
          title="Modules switched on"
          description={unused.length > 0 ? `${plural(unused.length, "module")} switched on with no change in 30 days.` : "Changes in each module's records over the last 30 days."}
          padded={false}
        >
          <DataTable caption="Modules switched on and their use over the last 30 days" minWidth={420}>
            <THead>
              <Th>Module</Th>
              <Th numeric>Changes</Th>
              <Th numeric>People</Th>
              <Th>Use</Th>
            </THead>
            <TBody>
              {modules.map((m) => (
                <Tr key={m.key}>
                  <Td>{m.label}</Td>
                  <Td numeric muted={m.changes === null}>
                    {m.changes === null ? "—" : INTEGER.format(m.changes)}
                  </Td>
                  <Td numeric muted={m.changes === null}>
                    {m.changes === null ? "—" : INTEGER.format(m.people)}
                  </Td>
                  <Td>
                    <StatusPill tone={MODULE_STATE[m.state].tone} title={m.state === "uncounted" ? "Its everyday use — opening pages, messages, runs, what customers send — isn't in the audit log, so no changes doesn't mean no use." : undefined}>
                      {MODULE_STATE[m.state].label}
                    </StatusPill>
                  </Td>
                </Tr>
              ))}
            </TBody>
          </DataTable>
        </Panel>

        <Panel title="Where the changes were" description="Records added, edited and removed over the last 30 days, by area." padded={false}>
          {areas.length === 0 ? (
            <div className="p-4 text-sm text-muted">No changes in the last 30 days.</div>
          ) : (
            <DataTable caption="Changes by area over the last 30 days" minWidth={420}>
              <THead>
                <Th>Area</Th>
                <Th numeric>Added</Th>
                <Th numeric>Edited</Th>
                <Th numeric>Removed</Th>
                <Th numeric>People</Th>
              </THead>
              <TBody>
                {areas.map((a) => (
                  <Tr key={a.area}>
                    <Td>{a.label}</Td>
                    <Td numeric>{INTEGER.format(a.created)}</Td>
                    <Td numeric>{INTEGER.format(a.changed)}</Td>
                    <Td numeric>{INTEGER.format(a.removed)}</Td>
                    <Td numeric>{INTEGER.format(a.people)}</Td>
                  </Tr>
                ))}
              </TBody>
            </DataTable>
          )}
        </Panel>
      </div>

      <Panel
        title="People"
        description="Everyone with a seat, numbered in the order their accounts were made — never named here. Their last 30 days."
        padded={false}
      >
        <DataTable caption="People with a seat and their use over the last 30 days" minWidth={720}>
          <THead>
            <Th>Person</Th>
            <Th>Last signed in</Th>
            <Th>Last active</Th>
            <Th numeric>Days active</Th>
            <Th numeric>Time on the app</Th>
            <Th numeric>Changes</Th>
            <Th>Mostly in</Th>
          </THead>
          <TBody>
            {people.map((p) => {
              const idle = !p.lastActiveOn || p.lastActiveOn < dayKeyOf(adoption.today, -29);
              return (
                <Tr key={p.number}>
                  <Td nowrap>
                    <span className="inline-flex items-center gap-1.5">
                      {`Person ${p.number}`}
                      {idle && <StatusPill tone="warning">{p.lastActiveOn || p.lastSignInAt ? "Idle 30 days" : "Never signed in"}</StatusPill>}
                    </span>
                  </Td>
                  <Td nowrap muted={!p.lastSignInAt}>
                    {p.lastSignInAt ? (
                      <span className="inline-flex items-center gap-1">
                        <LogIn className="h-3.5 w-3.5 text-subtle" aria-hidden="true" />
                        {clock.date(p.lastSignInAt)}
                      </span>
                    ) : (
                      "—"
                    )}
                  </Td>
                  <Td nowrap muted={!p.lastActiveOn}>
                    {p.lastActiveOn ? dayKeyLabel(p.lastActiveOn) : "—"}
                  </Td>
                  <Td numeric>{`${p.daysActive30} of 30`}</Td>
                  <Td numeric>{hours(p.minutes30)}</Td>
                  <Td numeric>{INTEGER.format(p.changes30)}</Td>
                  <Td muted={p.top.length === 0}>{p.top.length ? p.top.map((t) => `${t.label} (${INTEGER.format(t.changes)})`).join(", ") : "—"}</Td>
                </Tr>
              );
            })}
          </TBody>
        </DataTable>
      </Panel>

      <p className="text-xs text-muted">
        {`Counted once a day from the workspace's own logs${adoption.countedAt ? `, last on ${clock.date(adoption.countedAt)}` : ""}. Opening a page isn't logged, so "active" means a sign-in, time on the app or a change; ${percent(adoption.active30, adoption.seats || 1)} of seats were active in 30 days.`}
      </p>
    </div>
  );
}

function dayKeyOf(key: string, n: number): string {
  return new Date(new Date(`${key}T00:00:00Z`).getTime() + n * 86_400_000).toISOString().slice(0, 10);
}
