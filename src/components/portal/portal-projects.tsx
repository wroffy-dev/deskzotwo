"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, Circle, ExternalLink, FileText, FolderKanban, MessageSquareWarning } from "lucide-react";
import { portalCompleteTask, portalReviewStage, type PortalProject } from "@/actions/portal-public";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import { formatCalendarDay } from "@/lib/time/zone";

/**
 * "Your projects" on the customer portal (owner, 16 Nov 2026 — projects phase 2): each project the team put there, its
 * stages as done, now or next, the updates and documents shared, and a stage waiting for their approval with Approve or
 * Request changes.
 */
export function PortalProjects({ token, projects }: { token: string; projects: PortalProject[] }) {
  if (projects.length === 0) return null;
  return (
    <Card>
      <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
        <FolderKanban className="h-4 w-4 text-muted" />
        Your projects
      </CardHeader>
      <CardContent className="space-y-6">
        {projects.map((p) => (
          <ProjectBlock key={p.id} token={token} project={p} />
        ))}
      </CardContent>
    </Card>
  );
}

function ProjectBlock({ token, project }: { token: string; project: PortalProject }) {
  const clock = useClock();
  const total = project.stages.length;
  const percent = total ? Math.round((project.done / total) * 100) : null;
  // The first stage not done is where things are now.
  const nowAt = project.stages.findIndex((s) => !s.completedAt);
  const waiting = project.stages.filter((s) => s.awaitingApproval || s.yourTodo);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <div className="text-base font-semibold text-text">{project.name}</div>
          <div className="text-xs text-muted">
            {project.code}
            {project.type ? ` · ${project.type}` : ""}
            {project.targetEndDate ? ` · due ${formatCalendarDay(new Date(project.targetEndDate))}` : ""}
          </div>
        </div>
        <Badge tone={waiting.length ? "amber" : "blue"}>{waiting.length ? "Waiting for you" : project.status}</Badge>
      </div>

      {percent !== null && (
        <div>
          <div className="h-1.5 overflow-hidden rounded-full bg-surface-sunken">
            <div className="h-full rounded-full bg-brand" style={{ width: `${percent}%` }} />
          </div>
          <p className="mt-1 text-xs text-muted">
            {project.done} of {total} stages done
          </p>
        </div>
      )}

      {project.questionnaireWaiting && (
        <p className="rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm text-text">We&apos;ve emailed you a few questions for this project — the link is in that email.</p>
      )}

      {total > 0 && (
        <ol className="space-y-2">
          {project.stages.map((s, i) => {
            const done = !!s.completedAt;
            const current = i === nowAt;
            return (
              <li key={s.id} className={`flex items-start gap-2.5 rounded-base px-2 py-1.5 ${current ? "bg-surface-sunken" : ""}`}>
                {done ? <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Done" /> : <Circle className={`mt-0.5 h-4 w-4 shrink-0 ${current ? "text-brand" : "text-subtle"}`} aria-label={current ? "In progress" : "Coming next"} />}
                <div className="min-w-0 flex-1">
                  <div className={`text-sm ${done ? "text-muted" : "text-text"} ${current ? "font-medium" : ""}`}>{s.name}</div>
                  <div className="text-xs text-subtle">
                    {done ? `Done ${clock.date(new Date(s.completedAt!))}` : s.yourTodo ? "Yours to do" : current ? "In progress" : "Coming next"}
                    {!done && s.dueDate ? ` · planned ${formatCalendarDay(new Date(s.dueDate))}` : ""}
                  </div>
                  {s.link && (
                    <a href={s.link} target="_blank" rel="noopener noreferrer" className="mt-0.5 inline-flex items-center gap-1 text-xs text-brand hover:underline">
                      <ExternalLink className="h-3 w-3" aria-hidden />
                      Have a look
                    </a>
                  )}
                  {s.lastReview?.decision === "CHANGES" && !s.awaitingApproval && !done && (
                    <p className="mt-1 text-xs text-muted">You asked for changes: &ldquo;{s.lastReview.comment}&rdquo; — the team is on it.</p>
                  )}
                  {s.awaitingApproval && <StageReview token={token} stageId={s.id} name={s.name} />}
                  {s.yourTodo && <TaskDone token={token} stageId={s.id} name={s.name} />}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {project.updates.length > 0 && (
        <div className="space-y-1.5">
          <div className="text-xs font-medium uppercase tracking-wide text-subtle">Updates</div>
          {project.updates.map((u, i) => (
            <div key={i} className="rounded-base border border-line px-3 py-2">
              <div className="text-xs text-subtle">{clock.date(new Date(u.at))}</div>
              <p className="mt-0.5 whitespace-pre-wrap text-sm text-text">{u.body}</p>
            </div>
          ))}
        </div>
      )}

      {project.documents.length > 0 && (
        <div className="space-y-1">
          <div className="text-xs font-medium uppercase tracking-wide text-subtle">Documents</div>
          {project.documents.map((d) => (
            <a key={d.id} href={`/portal/${encodeURIComponent(token)}/project-file/${encodeURIComponent(d.id)}`} className="flex items-center gap-2 text-sm text-brand hover:underline">
              <FileText className="h-3.5 w-3.5" aria-hidden />
              {d.name}
              <span className="text-xs text-muted">{Math.max(1, Math.round(d.sizeBytes / 1024))} KB</span>
            </a>
          ))}
        </div>
      )}
    </div>
  );
}

/** A stage that is theirs to do: done, with a note for the team if they like (phase 3). */
function TaskDone({ token, stageId, name }: { token: string; stageId: string; name: string }) {
  const router = useRouter();
  const [note, setNote] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  return (
    <div className="mt-2 space-y-2 rounded-base border border-warning/40 bg-warning-bg/40 p-2.5">
      <p className="flex items-start gap-1.5 text-sm text-text">
        <MessageSquareWarning className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
        &ldquo;{name}&rdquo; is yours to do. Mark it done once it is.
      </p>
      <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="A note for the team (optional)" aria-label="A note for the team" />
      {error && <p className="text-xs text-danger">{error}</p>}
      <Button
        size="sm"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await portalCompleteTask(token, stageId, note);
            if (!r.ok) return setError(r.error);
            router.refresh();
          })
        }
      >
        {pending ? "Saving…" : "Mark as done"}
      </Button>
    </div>
  );
}

function StageReview({ token, stageId, name }: { token: string; stageId: string; name: string }) {
  const router = useRouter();
  const [changing, setChanging] = useState(false);
  const [comment, setComment] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const answer = (decision: "APPROVED" | "CHANGES") =>
    start(async () => {
      setError(null);
      const r = await portalReviewStage(token, stageId, decision, comment);
      if (!r.ok) return setError(r.error);
      router.refresh();
    });

  return (
    <div className="mt-2 space-y-2 rounded-base border border-warning/40 bg-warning-bg/40 p-2.5">
      <p className="flex items-start gap-1.5 text-sm text-text">
        <MessageSquareWarning className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden />
        The team has asked you to approve &ldquo;{name}&rdquo;.
      </p>
      {changing && <Textarea rows={3} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="What would you like changed?" aria-label="What to change" />}
      {error && <p className="text-xs text-danger">{error}</p>}
      <div className="flex flex-wrap gap-2">
        {!changing ? (
          <>
            <Button size="sm" disabled={pending} onClick={() => answer("APPROVED")}>
              {pending ? "Saving…" : "Approve"}
            </Button>
            <Button size="sm" variant="secondary" disabled={pending} onClick={() => setChanging(true)}>
              Request changes
            </Button>
          </>
        ) : (
          <>
            <Button size="sm" disabled={pending || !comment.trim()} onClick={() => answer("CHANGES")}>
              {pending ? "Sending…" : "Send the changes"}
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => setChanging(false)}>
              Back
            </Button>
          </>
        )}
      </div>
    </div>
  );
}
