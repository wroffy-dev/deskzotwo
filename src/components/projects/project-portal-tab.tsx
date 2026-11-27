"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, Send } from "lucide-react";
import {
  askStageApproval,
  postCustomerUpdate,
  setProjectOnPortal,
  setStagePortal,
  shareWithCustomer,
  type projectPortalState,
} from "@/actions/project-portal";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Textarea } from "@/components/ui/input";
import { toast } from "@/components/ui/toast";
import { useClock } from "@/components/time/clock-provider";
import { formatCalendarDay } from "@/lib/time/zone";

type State = NonNullable<Awaited<ReturnType<typeof projectPortalState>>>;
type Stage = State["stages"][number];

/**
 * A project's Customer portal tab (owner, 16 Nov 2026 — projects phase 2): whether the customer sees it, which stages,
 * which stages they approve, and the updates and documents shared with them. Everything here is what the portal shows;
 * nothing else of the project ever is.
 */
export function ProjectPortalTab({ projectId, state }: { projectId: string; state: State }) {
  const router = useRouter();
  const clock = useClock();
  const [pending, start] = useTransition();
  const run = (work: () => Promise<{ ok: boolean; error?: string }>, done?: string) =>
    start(async () => {
      const r = await work();
      if (!r.ok) return void toast.error(r.error ?? "That didn't work.");
      if (done) toast.success(done);
      router.refresh();
    });

  if (!state.ready) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-sm text-muted">The customer portal for projects isn&apos;t ready in this workspace yet — it comes with the next update.</CardContent>
      </Card>
    );
  }

  const shown = state.stages.filter((s) => !s.hidden);
  return (
    <div className="space-y-4">
      <Card>
        <CardContent className="flex flex-wrap items-center justify-between gap-3 py-4">
          <div className="min-w-0">
            <div className="flex items-center gap-2 text-sm font-medium text-text">
              {state.onPortal ? <Eye className="h-4 w-4 text-success" /> : <EyeOff className="h-4 w-4 text-muted" />}
              {state.onPortal ? "Shown on the customer portal" : "Not on the customer portal"}
            </div>
            <p className="mt-0.5 text-xs text-muted">
              {!state.portalAvailable
                ? "The customer portal isn't switched on for this workspace (Settings › Customer portal)."
                : state.onPortal
                  ? `The customer sees ${shown.length} of ${state.stages.length} stages, the updates and documents shared below — never the log, risks, billing or people. They need a portal link (the customer's page › Customer portal).`
                  : "Show it to let the customer follow the stages, read the updates you share and approve stages."}
            </p>
          </div>
          {state.canManage && state.portalAvailable && (
            <Button size="sm" variant={state.onPortal ? "secondary" : "primary"} disabled={pending} onClick={() => run(() => setProjectOnPortal(projectId, !state.onPortal), state.onPortal ? "Taken off the portal." : "Shown on the portal.")}>
              {state.onPortal ? "Take off the portal" : "Show on the portal"}
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Stages</CardHeader>
        <CardContent className="space-y-3">
          {state.stages.length === 0 && <p className="text-sm text-muted">No stages yet — add them on the Plan & billing tab.</p>}
          {state.stages.map((s) => (
            <StageRow key={s.id} stage={s} canManage={state.canManage} onPortal={state.onPortal} pending={pending} run={run} />
          ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Updates for the customer</CardHeader>
        <CardContent className="space-y-3">
          {state.canManage && <CustomerUpdate projectId={projectId} pending={pending} run={run} />}
          {state.updates.length === 0 && <p className="text-sm text-muted">No updates yet.</p>}
          {state.updates.map((u) => (
            <label key={u.id} className="flex items-start gap-2.5 border-b border-line pb-2.5 last:border-0 last:pb-0">
              <input
                type="checkbox"
                className="mt-0.5 h-4 w-4 accent-[var(--color-brand)]"
                checked={u.shared}
                disabled={!state.canManage || pending}
                onChange={(e) => run(() => shareWithCustomer({ projectId, updateId: u.id, shared: e.target.checked }))}
                aria-label="Shared with the customer"
              />
              <span className="min-w-0">
                <span className="block text-xs text-subtle">
                  {u.author ?? "Automatic"} · {clock.date(new Date(u.at))}
                  {u.shared && <span className="ml-1.5 text-success">· shared</span>}
                </span>
                <span className="block whitespace-pre-wrap text-sm text-text">{u.body}</span>
              </span>
            </label>
          ))}
          {state.updates.length > 0 && <p className="text-xs text-subtle">Tick an update to share it with the customer. Untick to take it back.</p>}
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-medium text-text">Documents for the customer</CardHeader>
        <CardContent className="space-y-2">
          {state.documents.length === 0 && <p className="text-sm text-muted">No documents on this project — add them on the Documents tab.</p>}
          {state.documents.map((d) => (
            <label key={d.id} className="flex items-center gap-2.5 text-sm text-text">
              <input
                type="checkbox"
                className="h-4 w-4 accent-[var(--color-brand)]"
                checked={d.shared}
                disabled={!state.canManage || pending}
                onChange={(e) => run(() => shareWithCustomer({ projectId, documentId: d.id, shared: e.target.checked }))}
              />
              <span className="min-w-0 truncate">{d.name}</span>
              <span className="text-xs text-muted">{Math.max(1, Math.round(d.sizeBytes / 1024))} KB</span>
              {d.shared && <span className="text-xs text-success">shared</span>}
            </label>
          ))}
        </CardContent>
      </Card>
    </div>
  );
}

function StageRow({
  stage,
  canManage,
  onPortal,
  pending,
  run,
}: {
  stage: Stage;
  canManage: boolean;
  onPortal: boolean;
  pending: boolean;
  run: (work: () => Promise<{ ok: boolean; error?: string }>, done?: string) => void;
}) {
  const clock = useClock();
  const [link, setLink] = useState(stage.link ?? "");
  const done = !!stage.completedAt;
  const waiting = !!stage.approvalRequestedAt && !done;
  const theirs = stage.customerTask && !done;
  const last = stage.reviews[0] ?? null;

  return (
    <div className={`space-y-2 border-b border-line pb-3 last:border-0 last:pb-0 ${stage.hidden ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <div className={`text-sm ${done ? "text-muted line-through" : "text-text"}`}>{stage.name}</div>
          <div className="text-xs text-subtle">
            {done ? `Done ${clock.date(new Date(stage.completedAt!))}` : stage.dueDate ? `Due ${formatCalendarDay(new Date(stage.dueDate))}` : "No date"}
            {stage.hidden && " · hidden from the customer"}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {waiting && <Badge tone="amber">Waiting for the customer</Badge>}
          {theirs && <Badge tone="amber">Customer&apos;s to do</Badge>}
          {!waiting && !theirs && last && (
            <Badge tone={last.decision === "CHANGES" ? "red" : "green"}>{last.decision === "APPROVED" ? `Approved by ${last.byName}` : last.decision === "DONE" ? `Done by ${last.byName}` : "Changes asked"}</Badge>
          )}
        </div>
      </div>
      {(last?.decision === "CHANGES" || last?.decision === "DONE") && !waiting && last.comment && (
        <p className="rounded-base bg-surface-sunken px-2.5 py-1.5 text-xs text-text">
          {last.byName}, {clock.date(new Date(last.createdAt))}: &ldquo;{last.comment}&rdquo;
        </p>
      )}
      {canManage && (
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-muted">
          <label className="flex items-center gap-1.5">
            <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={!stage.hidden} disabled={pending} onChange={(e) => run(() => setStagePortal(stage.id, { hidden: !e.target.checked }))} />
            Show to customer
          </label>
          <label className="flex items-center gap-1.5">
            <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={stage.needsApproval} disabled={pending || stage.hidden} onChange={(e) => run(() => setStagePortal(stage.id, { needsApproval: e.target.checked }))} />
            Customer approves
          </label>
          <label className="flex items-center gap-1.5" title="They mark it done on the portal — e.g. add a DNS record, confirm the user list.">
            <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={stage.customerTask} disabled={pending || stage.hidden || done} onChange={(e) => run(() => setStagePortal(stage.id, { customerTask: e.target.checked }), e.target.checked ? "It's the customer's to do now — they're told by email." : undefined)} />
            Customer&apos;s to do
          </label>
          {stage.needsApproval && !done && !stage.hidden && (
            <Button
              size="sm"
              variant={waiting ? "ghost" : "secondary"}
              disabled={pending || !onPortal}
              title={onPortal ? undefined : "Show the project on the portal first"}
              onClick={() => run(() => askStageApproval(stage.id, !waiting), waiting ? "Request taken back." : "The customer is asked to approve it on the portal.")}
            >
              <Send className="mr-1.5 h-3.5 w-3.5" />
              {waiting ? "Take back the request" : "Ask for approval"}
            </Button>
          )}
          <div className="flex min-w-60 flex-1 items-center gap-1.5">
            <Input value={link} onChange={(e) => setLink(e.target.value)} placeholder="Link for the customer — a staging site, a design (optional)" aria-label={`Link for ${stage.name}`} className="h-8 text-xs" />
            {link !== (stage.link ?? "") && (
              <Button size="sm" variant="secondary" disabled={pending} onClick={() => run(() => setStagePortal(stage.id, { link: link || null }), "Link saved.")}>
                Save
              </Button>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

function CustomerUpdate({ projectId, pending, run }: { projectId: string; pending: boolean; run: (work: () => Promise<{ ok: boolean; error?: string }>, done?: string) => void }) {
  const [body, setBody] = useState("");
  return (
    <div className="space-y-2 rounded-lg border border-line p-3">
      <Textarea rows={3} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Where things stand, in words for the customer…" aria-label="Update for the customer" />
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs text-subtle">Goes in the project&apos;s log and on the portal at once.</p>
        <Button
          size="sm"
          disabled={pending || !body.trim()}
          onClick={() =>
            run(async () => {
              const r = await postCustomerUpdate(projectId, body);
              if (r.ok) setBody("");
              return r;
            }, "Posted and shared.")
          }
        >
          Post for the customer
        </Button>
      </div>
    </div>
  );
}
