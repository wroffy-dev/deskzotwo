import type { Metadata } from "next";
import { CircleCheck } from "lucide-react";
import { consoleDropMail, consoleRetryMail } from "@/actions/platform/console-mail-queue";
import { ActionButton } from "@/components/console/kit/action-button";
import { EmptyState } from "@/components/console/kit/empty-state";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { consoleStaff } from "@/lib/platform/console-page";
import { MAX_ATTEMPTS, listMailJobs, mailQueueStats } from "@/lib/platform/mail/queue";

export const metadata: Metadata = { title: "Mail queue" };

/**
 * Mail log › Queue (src/lib/platform/mail/queue.ts — owner, 30 Oct 2026): the platform mail waiting to be sent again,
 * and what was given up on, with why. Each can be tried again or dropped. What was sent is on the Mail log itself.
 */
export default async function ConsoleMailQueuePage() {
  await consoleStaff(PAGE_ROLES.mail);
  const now = new Date();
  const [jobs, stats] = await Promise.all([listMailJobs(200), mailQueueStats(now)]);

  return (
    <>
      <PageHeader
        title="Mail queue"
        crumbs={[{ label: "Mail log", href: "/mail" }]}
        chips={
          stats.dead > 0 ? (
            <StatusPill tone="warning" dot>{`${stats.dead} given up on`}</StatusPill>
          ) : (
            <StatusPill tone="success" icon={<CircleCheck className="h-3 w-3" />}>
              Nothing given up on
            </StatusPill>
          )
        }
        subtitle={`${stats.queued.toLocaleString("en-IN")} waiting · tried at once, then after 1 min, 5 min, 30 min, 2 h and 12 h; a permanent refusal is given up on at once`}
        asOf={now}
      />
      {jobs.length === 0 ? (
        <Panel padded={false}>
          <EmptyState icon={<CircleCheck className="h-5 w-5 text-success" />} title="Nothing waiting." body="Every queued mail has gone. A mail that fails is tried again here, and one given up on waits here for you." />
        </Panel>
      ) : (
        <Panel padded={false}>
          <DataTable caption="Platform mail waiting or given up on" minWidth={980}>
            <THead>
              <Th>Mail</Th>
              <Th>Status</Th>
              <Th>Why</Th>
              <Th>Queued</Th>
              <Th srOnly>Actions</Th>
            </THead>
            <TBody>
              {jobs.map((j) => (
                <Tr key={j.id}>
                  <Td>
                    <span className="block text-text">{j.subject}</span>
                    <span className="block text-xs text-subtle">
                      {j.type} · to {j.to}
                      {j.tenant ? ` · ${j.tenant}` : ""}
                    </span>
                  </Td>
                  <Td nowrap>
                    {j.status === "DEAD" ? (
                      <StatusPill tone="danger">Given up</StatusPill>
                    ) : j.status === "SENDING" ? (
                      <StatusPill tone="info">Sending</StatusPill>
                    ) : (
                      <StatusPill tone="warning">{j.attempts ? `Try ${j.attempts + 1} of ${MAX_ATTEMPTS}` : "Waiting"}</StatusPill>
                    )}
                    {j.status === "QUEUED" && j.nextAttemptAt > now && (
                      <span className="mt-0.5 block text-xs text-subtle">
                        next <RelativeTime at={j.nextAttemptAt} />
                      </span>
                    )}
                  </Td>
                  <Td>
                    <span className="break-words text-xs text-muted">{j.lastError ?? "—"}</span>
                  </Td>
                  <Td nowrap>
                    <RelativeTime at={j.createdAt} />
                  </Td>
                  <Td nowrap>
                    {j.status !== "SENDING" && (
                      <span className="flex gap-2">
                        <ActionButton action={consoleRetryMail.bind(null, j.id)} label="Try again" success="It goes on the worker's next turn." />
                        <ActionButton
                          action={consoleDropMail.bind(null, j.id)}
                          label="Drop…"
                          variant="ghost"
                          confirm={{ title: "Drop this mail?", body: "It won't be sent. The Mail log keeps the tries that failed.", tone: "danger" }}
                          success="Dropped."
                        />
                      </span>
                    )}
                  </Td>
                </Tr>
              ))}
            </TBody>
          </DataTable>
        </Panel>
      )}
    </>
  );
}
