import type { Metadata } from "next";
import { CircleCheck } from "lucide-react";
import { EmptyState } from "@/components/console/kit/empty-state";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { plural } from "@/lib/console-shared/format";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { consoleStaff } from "@/lib/platform/console-page";
import { NEW_FOR_MS, SPIKE, errorStats, listErrors } from "@/lib/platform/errors";

export const metadata: Metadata = { title: "Server errors" };

/**
 * Every error the app hit while answering, grouped by its route and what it said (src/lib/platform/errors.ts —
 * owner, 30 Oct 2026). Newest first: how many times, since when, and the workspace it last happened in. Kept on the
 * platform's own database only; the message is its first line with secrets taken out — the full stack is in the
 * server's log under the digest shown.
 */
export default async function ConsoleErrorsPage() {
  await consoleStaff(PAGE_ROLES.errors);
  const now = new Date();
  const [rows, stats] = await Promise.all([listErrors(200), errorStats(now)]);
  const freshKeys = new Set(stats.fresh.map((f) => f.fingerprint));
  const minutes = Math.round(SPIKE.windowMs / 60_000);

  return (
    <>
      <PageHeader
        title="Server errors"
        chips={
          stats.recent >= SPIKE.errors ? (
            <StatusPill tone={stats.recent >= SPIKE.critical ? "danger" : "warning"} dot>{`${stats.recent} in ${minutes} min`}</StatusPill>
          ) : (
            <StatusPill tone="success" icon={<CircleCheck className="h-3 w-3" />}>{`${stats.recent} in ${minutes} min`}</StatusPill>
          )
        }
        subtitle={`${plural(rows.length, "kind")} of error kept · an alert at ${SPIKE.errors} in ${minutes} minutes, and for each kind first seen in the last day`}
        asOf={now}
      />
      {rows.length === 0 ? (
        <Panel padded={false}>
          <EmptyState icon={<CircleCheck className="h-5 w-5 text-success" />} title="No server errors kept." body="Errors the app hits while answering appear here, grouped, as they happen." />
        </Panel>
      ) : (
        <Panel padded={false}>
          <DataTable caption="Server errors, newest first" minWidth={960}>
            <THead>
              <Th>Error</Th>
              <Th>Where</Th>
              <Th numeric>Times</Th>
              <Th>First seen</Th>
              <Th>Last seen</Th>
              <Th>Last in</Th>
            </THead>
            <TBody>
              {rows.map((e) => (
                <Tr key={e.fingerprint}>
                  <Td>
                    <span className="break-words text-text">{e.message || "An error with no message"}</span>
                    {freshKeys.has(e.fingerprint) && (
                      <StatusPill tone="warning" className="ml-2">
                        New
                      </StatusPill>
                    )}
                    {e.lastDigest && <span className="mt-0.5 block font-mono text-xs text-subtle">digest {e.lastDigest}</span>}
                  </Td>
                  <Td>
                    <span className="font-mono text-xs">
                      {e.method} {e.route}
                    </span>
                    <span className="block text-xs text-subtle">{e.routeType}</span>
                  </Td>
                  <Td numeric>{e.count.toLocaleString("en-IN")}</Td>
                  <Td>
                    <RelativeTime at={e.firstSeen} />
                  </Td>
                  <Td>
                    <RelativeTime at={e.lastSeen} />
                  </Td>
                  <Td>{e.lastTenant && e.lastTenant !== "unknown" ? e.lastTenant : "—"}</Td>
                </Tr>
              ))}
            </TBody>
          </DataTable>
        </Panel>
      )}
      <p className="mt-6 text-xs text-subtle">
        Kept 90 days after an error was last seen; the counts by ten minutes, a week. A kind first seen in the last {Math.round(NEW_FOR_MS / 3_600_000)} hours is
        marked New and raised on Alerts until acknowledged. The full stack is in the server&apos;s log, found by its digest.
      </p>
    </>
  );
}
