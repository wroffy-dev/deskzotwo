import type { Metadata } from "next";
import { CircleCheck } from "lucide-react";
import { SuppressionLookupForm } from "@/components/console/mail/suppression-lookup";
import { EmptyState } from "@/components/console/kit/empty-state";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { consoleStaff } from "@/lib/platform/console-page";
import { KEEP_DAYS, platformSuppressionOverview } from "@/lib/platform/mail/suppressions";

export const metadata: Metadata = { title: "Suppressed addresses" };

/**
 * Mail log › Suppressed (src/lib/platform/mail/suppressions.ts — owner, 31 Oct 2026): the addresses mail through
 * Deskzo's own servers bounced from for good, or that called it spam, and so aren't mailed from any workspace until
 * they expire. Kept as hashes: the list can be counted and an address looked up, never read.
 */
export default async function ConsoleMailSuppressionsPage() {
  await consoleStaff(PAGE_ROLES.mail);
  const now = new Date();
  const overview = await platformSuppressionOverview(now);
  const total = overview.bounces + overview.complaints;

  return (
    <>
      <PageHeader
        title="Suppressed addresses"
        crumbs={[{ label: "Mail log", href: "/mail" }]}
        chips={
          total > 0 ? (
            <StatusPill tone="warning" dot>{`${total.toLocaleString("en-IN")} on the list`}</StatusPill>
          ) : (
            <StatusPill tone="success" icon={<CircleCheck className="h-3 w-3" />}>
              Nobody on the list
            </StatusPill>
          )
        }
        subtitle={`${overview.bounces.toLocaleString("en-IN")} bounced for good (kept ${KEEP_DAYS.HARD_BOUNCE} days) · ${overview.complaints.toLocaleString("en-IN")} called it spam (kept ${KEEP_DAYS.COMPLAINT} days) · ${overview.stopped.toLocaleString("en-IN")} send(s) stopped. Mail through Deskzo's own servers only — a workspace's own provider keeps its own list; unsubscribes are never here.`}
        asOf={now}
      />
      <Panel>
        <SuppressionLookupForm />
      </Panel>
      {overview.latest.length === 0 ? (
        <Panel padded={false}>
          <EmptyState
            icon={<CircleCheck className="h-5 w-5 text-success" />}
            title="Nobody on the list."
            body="When Deskzo's mail server is told a mailbox doesn't exist, the address lands here and isn't mailed again from any workspace until it expires."
          />
        </Panel>
      ) : (
        <Panel padded={false}>
          <DataTable caption="Latest on the suppression list, by hash" minWidth={880}>
            <THead>
              <Th>Address (hash)</Th>
              <Th>Why</Th>
              <Th>What the server said</Th>
              <Th>Last</Th>
              <Th>Until</Th>
              <Th>Stopped</Th>
            </THead>
            <TBody>
              {overview.latest.map((s) => (
                <Tr key={s.addressHash}>
                  <Td nowrap>
                    <span className="font-mono text-xs text-muted">{s.addressHash.slice(0, 12)}…</span>
                  </Td>
                  <Td nowrap>{s.reason === "COMPLAINT" ? <StatusPill tone="danger">Spam complaint</StatusPill> : <StatusPill tone="warning">Bounced</StatusPill>}</Td>
                  <Td>
                    <span className="break-words text-xs text-muted">{s.detail ?? "—"}</span>
                  </Td>
                  <Td nowrap>
                    <RelativeTime at={s.lastAt} />
                    {s.hits > 1 && <span className="block text-xs text-subtle">{s.hits} times</span>}
                  </Td>
                  <Td nowrap>
                    <span className="text-xs text-muted">{s.expiresAt.toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kolkata" })}</span>
                  </Td>
                  <Td nowrap>{s.stopped.toLocaleString("en-IN")}</Td>
                </Tr>
              ))}
            </TBody>
          </DataTable>
        </Panel>
      )}
    </>
  );
}
