import type { ReactNode } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { Meter } from "@/components/console/charts/meter";
import { BackupRowActions, NewBackupButton } from "@/components/console/backups/backup-controls";
import { UploadBundle } from "@/components/console/backups/upload-bundle";
import { Banner } from "@/components/console/kit/banner";
import { EmptyState } from "@/components/console/kit/empty-state";
import { SelectFilter } from "@/components/console/kit/filter-controls";
import { FilterBar, ViewTabs } from "@/components/console/kit/filters";
import { PageHeader } from "@/components/console/kit/page-header";
import { Panel } from "@/components/console/kit/panel";
import { RelativeTime } from "@/components/console/kit/relative-time";
import { StatusPill } from "@/components/console/kit/status";
import { DataTable, TBody, THead, Td, Th, Tr } from "@/components/console/kit/table";
import { Disclosure } from "@/components/ui/disclosure";
import { backupsBoard, parseBackupsFilters, type BackupRow, type BackupsFilters, type RestoreRow } from "@/lib/bundle/console-data";
import { settleBackups } from "@/lib/bundle/jobs";
import { settleRestores } from "@/lib/bundle/restore";
import { cleanStaleUploads } from "@/lib/bundle/upload";
import { BACKUP_STATUS, RESTORE_STATUS, shortSha, sizeText } from "@/lib/console-shared/backups";
import { PAGE_ROLES } from "@/lib/console-shared/nav";
import { capsFor } from "@/lib/console-shared/roles";
import type { Tone } from "@/lib/console-shared/types";
import { consoleStaff } from "@/lib/platform/console-page";
import { controlConfigured } from "@/lib/platform/control-db";

export const metadata: Metadata = { title: "Backups" };

/**
 * Backups (owner, 26 Nov 2026 — Backup & Restore, src/lib/bundle; docs/runbook.md §4.3): one encrypted file of the
 * whole application, or of one workspace, made on this server to be downloaded — and files uploaded here to be
 * restored. Owners and admins see it; only owners make, download, upload, verify or delete one
 * (src/actions/platform/console-backups.ts and the routes under backup-files/ and backup-uploads/ check again).
 *
 * Loading it settles what is due: expired files removed, builds whose worker died marked failed, abandoned uploads
 * cleared. While something is being made or checked, it refreshes itself every few seconds. No passphrase, key or
 * secret reaches it: the rows hold none, and a header is shown only as far as `headerSummary` keeps it.
 */

const PATH = "/backups";

function href(filters: BackupsFilters, change: Partial<BackupsFilters>): string {
  const next = { ...filters, ...change };
  const q = new URLSearchParams();
  if (next.kind) q.set("kind", next.kind.toLowerCase());
  if (next.workspace) q.set("workspace", next.workspace);
  const s = q.toString();
  return s ? `${PATH}?${s}` : PATH;
}

const labelOf = (r: Pick<BackupRow, "kind" | "tenantSlug">) => (r.kind === "FULL" ? "Full application" : `Workspace ${r.tenantSlug ?? "?"}`);

export default async function ConsoleBackupsPage({ searchParams }: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const staff = await consoleStaff(PAGE_ROLES.backups);
  const caps = capsFor(staff.role);
  const filters = parseBackupsFilters(await searchParams);

  const header = (live = false, asOf?: Date, actions?: ReactNode) => (
    <PageHeader
      title="Backups"
      chips={caps.owner ? undefined : <StatusPill tone="neutral">View only</StatusPill>}
      subtitle="One encrypted file of the whole application or of one workspace — made here to be downloaded, or uploaded here to be restored."
      asOf={asOf}
      autoRefreshSeconds={live ? 5 : undefined}
      live={live}
      actions={actions}
    />
  );

  if (!controlConfigured()) {
    return (
      <>
        {header()}
        <Banner tone="warning" title="No control plane">
          This server has no control plane (CONTROL_DATABASE_URL), so backups are made from the server instead: npm run bundle (docs/runbook.md §4.3).
        </Banner>
      </>
    );
  }

  await settleBackups(new Date(), cleanStaleUploads);
  await settleRestores();
  const board = await backupsBoard(filters).catch(() => null);
  if (!board) {
    return (
      <>
        {header()}
        <Banner tone="warning" title="Not ready yet">
          {"This release's control plane migrations haven't run here, so there is nothing to show. Run npm run control:migrate, then reload."}
        </Banner>
      </>
    );
  }

  const workspaceOptions = [...new Map([...board.workspaces.map((w) => [w.slug, w.name] as const), ...board.rows.filter((r) => r.tenantSlug).map((r) => [r.tenantSlug!, r.tenantSlug!] as const)]).entries()]
    .map(([value, name]) => ({ value, label: name === value ? value : `${name} (${value})` }))
    .sort((a, b) => a.value.localeCompare(b.value));
  const narrowed = !!filters.kind || !!filters.workspace;
  const initialWorkspace = filters.workspace && board.workspaces.some((w) => w.slug === filters.workspace) ? filters.workspace : null;

  return (
    <>
      {header(board.live, board.asOf, caps.owner ? <NewBackupButton workspaces={board.workspaces} initialWorkspace={initialWorkspace} /> : undefined)}
      <div className="space-y-6">
        <Disclosure summary="How this works">
          A backup is one file (.dzbk), encrypted under a passphrase the owner who makes it chooses. A full one holds the control plane — staff, plans,
          settings, billing — and every workspace that isn&apos;t closed; one of a workspace holds its database, its files and its records. It is made
          here in the background and kept on this server for a day to be downloaded, then removed. PLATFORM_MASTER_KEY is never in it: the server it is
          restored on needs the same key. To restore one on another server, upload it there, verify it, then Restore. Only owners can make, download,
          upload, verify, restore or delete one; a download or a restore also asks for a fresh code from the owner&apos;s authenticator, and every other
          owner is told. A restore checks the whole file first and takes a safety copy before it changes anything; if it fails, it puts everything back.
        </Disclosure>

        {caps.owner && (
          <Panel id="upload" title="Upload a backup" description="To restore it here, or check it — in parts, so a dropped connection carries on where it stopped.">
            <UploadBundle />
          </Panel>
        )}

        <div>
          <FilterBar
            trailing={
              <SelectFilter param="workspace" label="Workspace" options={workspaceOptions} allLabel="Every workspace" searchable resetParams={[]} />
            }
          >
            <ViewTabs
              label="Kind of backup"
              items={[
                { key: "all", label: "All", href: href(filters, { kind: null }), active: !filters.kind },
                { key: "full", label: "Full application", href: href(filters, { kind: "FULL" }), active: filters.kind === "FULL" },
                { key: "workspace", label: "One workspace", href: href(filters, { kind: "WORKSPACE" }), active: filters.kind === "WORKSPACE" },
              ]}
            />
          </FilterBar>

          <Panel id="backups" title="Backups" description="Made here or uploaded, newest first. Files are removed a day after they are made or uploaded." padded={false}>
            {board.rows.length === 0 ? (
              narrowed ? (
                <EmptyState variant="filtered" title="No backups match" clearHref={PATH} />
              ) : (
                <EmptyState title="No backups yet" body={caps.owner ? "Make one with New backup, or upload one." : "An owner makes them."} />
              )
            ) : (
              <DataTable minWidth={1080} caption="Backups made or uploaded on this server">
                <THead>
                  <Th>Backup</Th>
                  <Th>Status</Th>
                  <Th numeric>Size</Th>
                  <Th>SHA-256</Th>
                  <Th>By</Th>
                  <Th>Started</Th>
                  <Th>Finished</Th>
                  <Th>Expires</Th>
                  <Th>File</Th>
                  {caps.owner && <Th srOnly>Actions</Th>}
                </THead>
                <TBody>
                  {board.rows.map((r) => (
                    <Tr key={r.id}>
                      <Td>
                        <span className="block font-medium">
                          {r.kind === "FULL" ? (
                            "Full application"
                          ) : r.tenantSlug ? (
                            <Link href={`/workspaces/${encodeURIComponent(r.tenantSlug)}`} className="hover:underline">
                              {r.tenantSlug}
                            </Link>
                          ) : (
                            "A workspace"
                          )}
                        </span>
                        <span className="block text-xs text-muted">
                          {r.kind === "FULL" ? "Everything" : "One workspace"} · {r.source === "UPLOADED" ? "uploaded" : "made here"}
                        </span>
                        <span className="block font-mono text-[11px] break-all text-subtle">{r.downloadName}</span>
                      </Td>
                      <Td className="min-w-64">
                        <StatusCell row={r} />
                      </Td>
                      <Td numeric nowrap>
                        {sizeText(r.sizeBytes)}
                      </Td>
                      <Td nowrap>
                        <span className="font-mono text-xs" title={r.sha256 ?? undefined}>
                          {shortSha(r.sha256)}
                        </span>
                      </Td>
                      <Td nowrap muted>
                        {r.by ?? "A script"}
                      </Td>
                      <Td nowrap muted>
                        <RelativeTime at={r.startedAt} />
                      </Td>
                      <Td nowrap muted>
                        {r.finishedAt ? <RelativeTime at={r.finishedAt} /> : "—"}
                      </Td>
                      <Td nowrap muted>
                        {r.expiresAt && r.status === "READY" ? <RelativeTime at={r.expiresAt} /> : "—"}
                      </Td>
                      <Td nowrap>
                        {r.status === "READY" ? (
                          r.filePresent ? <StatusPill tone="success">On the server</StatusPill> : <StatusPill tone="danger">Missing</StatusPill>
                        ) : (
                          <StatusPill tone="neutral">None</StatusPill>
                        )}
                      </Td>
                      {caps.owner && (
                        <Td nowrap>
                          <BackupRowActions row={{ id: r.id, status: r.status, filePresent: r.filePresent, verifying: r.verify?.state === "running", label: labelOf(r) }} />
                        </Td>
                      )}
                    </Tr>
                  ))}
                </TBody>
              </DataTable>
            )}
          </Panel>
        </div>

        <Panel id="restores" title="Restores" description="Each restore from a backup, step by step, newest first." padded={false}>
          {board.restores.length === 0 ? (
            <EmptyState title="No restores yet" body={caps.owner ? "Restore… on a backup that is ready starts one; each is listed here with its log." : "An owner restores them; each is listed here with its log."} />
          ) : (
            <DataTable minWidth={1080} caption="Restores from backups">
              <THead>
                <Th>Of</Th>
                <Th>From</Th>
                <Th>Status</Th>
                <Th>By</Th>
                <Th>Started</Th>
                <Th>Finished</Th>
                <Th>Safety copy</Th>
                <Th>Log</Th>
              </THead>
              <TBody>
                {board.restores.map((r) => (
                  <RestoreLine key={r.id} run={r} />
                ))}
              </TBody>
            </DataTable>
          )}
        </Panel>
      </div>
    </>
  );
}

function StatusCell({ row: r }: { row: BackupRow }) {
  const s = BACKUP_STATUS[r.status];
  return (
    <span className="block space-y-1">
      <StatusPill tone={s.tone} dot>
        {s.label}
      </StatusPill>
      {r.status === "RUNNING" && r.progress && <BuildProgress progress={r.progress} />}
      {r.status === "FAILED" && r.error && <span className="block text-xs whitespace-pre-line text-danger">{r.error}</span>}
      {r.verify?.state === "running" && (
        <span className="block text-xs text-info">
          {`Verifying — ${sizeText(r.verify.bytes)} read${r.verify.total ? ` of about ${sizeText(r.verify.total)}` : ""}`}
        </span>
      )}
      {(r.verify?.state === "stopped" || r.verify?.state === "failed") && <span className="block text-xs text-warning">{`Verify ${r.verify.error ?? "stopped"} — verify it again.`}</span>}
      {r.verifiedAt && r.verify?.state !== "running" && (
        <span className="block text-xs">
          {r.verifyOk ? (
            <span className="text-success">Verified sound</span>
          ) : (
            <span className="text-danger">Verify found problems</span>
          )}{" "}
          <span className="text-muted">
            <RelativeTime at={r.verifiedAt} />
          </span>
          {!r.verifyOk && r.verifyProblems.length > 0 && (
            <span className="mt-0.5 block space-y-0.5 text-danger">
              {r.verifyProblems.slice(0, 5).map((p, i) => (
                <span key={i} className="block">
                  {p}
                </span>
              ))}
            </span>
          )}
        </span>
      )}
      {r.compat && (
        <Disclosure summary={r.compat.verdict === "blocked" ? "Can't be restored here yet" : r.compat.verdict === "warning" ? "Restoring here: read first" : "Can be restored here"}>
          <ul className="space-y-1 text-xs">
            {r.compat.lines.map((l) => (
              <li key={l.key} className="flex items-start gap-1.5">
                <StatusPill tone={l.tone as Tone}>{l.label}</StatusPill>
                <span className="text-text">{l.text}</span>
              </li>
            ))}
          </ul>
        </Disclosure>
      )}
    </span>
  );
}

function BuildProgress({ progress: p }: { progress: NonNullable<BackupRow["progress"]> }) {
  const of = p.expectedBytes && p.expectedBytes > 0 ? p.expectedBytes : null;
  return (
    <span className="block space-y-0.5 text-xs text-muted">
      {of && <Meter value={Math.min(p.bytes, of)} max={of} label="Written, of the estimate" tone="info" />}
      <span className="block tabular-nums">
        {`${p.entriesTotal ? `${p.entries} of ${p.entriesTotal}` : p.entries} ${p.entries === 1 && !p.entriesTotal ? "entry" : "entries"} · ${sizeText(p.bytes)}${of ? ` of about ${sizeText(of)}` : ""}`}
      </span>
      {p.entry && <span className="block font-mono text-[11px] break-all">{p.entry}</span>}
    </span>
  );
}

const MODE_LABEL: Record<string, string> = { IN_PLACE: "over the workspace here", AS_NEW: "as a new workspace", FULL: "everything" };

function RestoreLine({ run }: { run: RestoreRow }) {
  const s = RESTORE_STATUS[run.status];
  return (
    <Tr>
      <Td nowrap>
        <span className="block">{run.kind === "FULL" ? "Full application" : (run.tenantSlug ?? "A workspace")}</span>
        {run.mode && <span className="block text-xs text-muted">{MODE_LABEL[run.mode] ?? run.mode}</span>}
      </Td>
      <Td>
        <span className="font-mono text-[11px] break-all text-subtle">{run.backupName ?? (run.backupId ? "A backup no longer listed" : "A file given to the script")}</span>
      </Td>
      <Td className="min-w-64">
        <StatusPill tone={s.tone} dot>
          {s.label}
        </StatusPill>
        {run.error && <span className="block text-xs whitespace-pre-line text-danger">{run.error}</span>}
        {run.notRestored.length > 0 && <span className="block text-xs text-warning">{`Not restored: ${run.notRestored.join("; ")}`}</span>}
        {run.untouched.length > 0 && <span className="block text-xs text-muted">{`Earlier databases left untouched: ${run.untouched.join(", ")}`}</span>}
      </Td>
      <Td nowrap muted>
        {run.by ?? "A script"}
      </Td>
      <Td nowrap muted>
        <RelativeTime at={run.startedAt} />
      </Td>
      <Td nowrap muted>
        {run.finishedAt ? <RelativeTime at={run.finishedAt} /> : "—"}
      </Td>
      <Td>{run.safetyPath ? <span className="font-mono text-[11px] break-all text-subtle">{run.safetyPath}</span> : <span className="text-xs text-muted">—</span>}</Td>
      <Td className="min-w-72">
        {run.log.length === 0 ? (
          <span className="text-xs text-muted">Nothing logged.</span>
        ) : (
          <Disclosure summary={`Log (${run.log.length} ${run.log.length === 1 ? "line" : "lines"})`}>
            <ol className="space-y-0.5 font-mono text-[11px] text-text">
              {run.log.map((l, i) => (
                <li key={i}>
                  {l.at ? <span className="text-muted">{`${l.at.slice(11, 19)} `}</span> : null}
                  {l.step ? <span className="text-muted">{`[${l.step}] `}</span> : null}
                  {l.message}
                </li>
              ))}
            </ol>
          </Disclosure>
        )}
      </Td>
    </Tr>
  );
}
