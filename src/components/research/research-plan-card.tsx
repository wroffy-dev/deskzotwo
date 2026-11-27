"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { Check, Copy, ListPlus } from "lucide-react";
import { addResearchPlanTasks, makeResearchPlan } from "@/actions/research-plan";
import { FIT_LABELS, STEP_LABELS, fillEmail, type PlanFit } from "@/lib/research/plan";
import type { PlanCard } from "@/lib/research/plan-view";
import type { PlanView } from "@/lib/research/plan-server";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { Textarea } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";
import { LiveSteps, announceTeammateWork } from "@/components/ai/teammate-live";
import { planSteps } from "@/lib/ai/teammate-steps";
import { workspacePack } from "@/lib/country-pack";

/**
 * "Research & plan" (owner, 18 Nov 2026 — src/lib/research/plan.ts): one click, and Deskzo AI says how warm the lead or
 * company is and why, and proposes the next few steps and a first email. The person ticks the steps they want as tasks
 * and copies the email; nothing is sent or changed by itself.
 */

const FIT_TONE: Record<PlanFit, "red" | "amber" | "blue"> = { HOT: "red", WARM: "amber", COLD: "blue" };

export function ResearchPlanCard({ data }: { data: PlanCard }) {
  const clock = useClock();
  const [view, setView] = useState<PlanView | null>(data.plan);
  const [ticked, setTicked] = useState<Set<number>>(() => new Set((data.plan?.plan.steps ?? []).map((_, i) => i).filter((i) => !data.plan?.plan.tasks[String(i)])));
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState<"plan" | "tasks" | null>(null);
  const [, start] = useTransition();
  const what = data.target.kind === "lead" ? "lead" : "company";

  const plan = () =>
    start(async () => {
      setBusy("plan");
      setError(null);
      setNotice(null);
      announceTeammateWork();
      const r = await makeResearchPlan(data.target);
      setBusy(null);
      if (!r.ok) return setError(r.error);
      setView(r.data);
      setTicked(new Set(r.data.plan.steps.map((_, i) => i)));
    });

  const addTasks = () =>
    start(async () => {
      if (!view) return;
      setBusy("tasks");
      setError(null);
      setNotice(null);
      const r = await addResearchPlanTasks({ planId: view.id, steps: [...ticked] });
      setBusy(null);
      if (!r.ok) return setError(r.error);
      setView(r.data.plan);
      setTicked(new Set());
      setNotice(`${r.data.added} task${r.data.added === 1 ? "" : "s"} added for you.`);
    });

  const ved = useTeammate("ved");
  const p = view?.plan ?? null;
  const email = p?.email ? fillEmail(p.email.body, { firstName: data.firstName, senderName: data.senderName }) : null;
  const open = p ? p.steps.map((_, i) => i).filter((i) => !p.tasks[String(i)]) : [];
  const chosen = open.filter((i) => ticked.has(i));

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-sm font-medium text-text">
          {/* Ved, the researcher (src/lib/ai/teammates.ts). */}
          <TeammateAvatar teammate="ved" size="sm" />
          <span>
            Research &amp; plan <span className="font-normal text-muted">· {ved.name}</span>
          </span>
          {p && (
            <Badge tone={FIT_TONE[p.fit]} title="How warm Deskzo AI reads it">
              {FIT_LABELS[p.fit]}
            </Badge>
          )}
        </div>
        {data.mayPlan && (
          <Button size="sm" variant={p ? "secondary" : "primary"} onClick={plan} disabled={busy !== null}>
            {busy === "plan" ? "Researching…" : p ? "Plan again" : "Research & plan"}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {!p && (
          <p className="text-muted">
            {data.mayPlan
              ? `Deskzo AI reads this ${what}'s public research and where it stands, says how warm it is and why, and suggests the next steps and a first email. You choose what becomes a task; nothing is sent.`
              : `Deskzo AI can say how warm this ${what} is and suggest next steps — it takes the “Use Deskzo AI” permission, and Deskzo AI switched on in Settings.`}
          </p>
        )}
        {/* Ved's own steps as the job reaches them (src/components/ai/teammate-live.tsx). */}
        <LiveSteps teammate="ved" subject={`${data.target.kind}:${data.target.id}`} active={busy === "plan"} fallback={planSteps(workspacePack().india)} />

        {p && (
          <>
            <p className="text-text">{p.summary}</p>
            <ul className="list-disc space-y-0.5 pl-5 text-muted">
              {p.fitReasons.map((r, i) => (
                <li key={i}>{r}</li>
              ))}
            </ul>

            <div className="space-y-1.5">
              <p className="text-xs font-medium uppercase tracking-wide text-subtle">Next steps</p>
              <ul className="space-y-1.5">
                {p.steps.map((s, i) => {
                  const taskId = p.tasks[String(i)];
                  return (
                    <li key={i} className="flex items-start gap-2 rounded-base border border-line p-2">
                      {taskId ? (
                        <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-label="Added as a task" />
                      ) : (
                        <input
                          type="checkbox"
                          className="mt-1"
                          checked={ticked.has(i)}
                          onChange={(e) =>
                            setTicked((prev) => {
                              const next = new Set(prev);
                              if (e.target.checked) next.add(i);
                              else next.delete(i);
                              return next;
                            })
                          }
                          aria-label={`Add “${s.title}” as a task`}
                        />
                      )}
                      <div className="min-w-0 flex-1">
                        <p className="text-text">
                          <span className="mr-1.5 text-xs font-medium text-brand">{STEP_LABELS[s.kind]}</span>
                          {s.title}
                        </p>
                        <p className="text-xs text-muted">
                          {s.why} · {s.dueInDays === 0 ? "today" : `in ${s.dueInDays} day${s.dueInDays === 1 ? "" : "s"}`}
                          {taskId && (
                            <>
                              {" · "}
                              <Link href="/tasks" className="text-brand hover:underline">
                                a task now
                              </Link>
                            </>
                          )}
                        </p>
                      </div>
                    </li>
                  );
                })}
              </ul>
              {open.length > 0 && (
                <Button size="sm" variant="secondary" onClick={addTasks} disabled={busy !== null || chosen.length === 0}>
                  <ListPlus className="mr-1.5 h-3.5 w-3.5" />
                  {busy === "tasks" ? "Adding…" : chosen.length ? `Add ${chosen.length} as task${chosen.length === 1 ? "" : "s"}` : "Tick the steps to add"}
                </Button>
              )}
            </div>

            {p.questions.length > 0 && (
              <div className="space-y-1">
                <p className="text-xs font-medium uppercase tracking-wide text-subtle">Questions to ask</p>
                <ul className="list-disc space-y-0.5 pl-5 text-muted">
                  {p.questions.map((q, i) => (
                    <li key={i}>{q}</li>
                  ))}
                </ul>
              </div>
            )}

            {p.email && email && (
              <div className="space-y-1.5">
                <p className="text-xs font-medium uppercase tracking-wide text-subtle">First email — a draft</p>
                <p className="text-text">
                  <span className="text-muted">Subject:</span> {p.email.subject}
                </p>
                <Textarea aria-label="Email draft" readOnly rows={Math.min(12, email.split("\n").length + 1)} value={email} className="text-xs" />
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={async () => {
                    await navigator.clipboard.writeText(`Subject: ${p.email!.subject}\n\n${email}`);
                    setCopied(true);
                    setTimeout(() => setCopied(false), 2000);
                  }}
                >
                  {copied ? <Check className="mr-1.5 h-3.5 w-3.5" /> : <Copy className="mr-1.5 h-3.5 w-3.5" />}
                  {copied ? "Copied" : "Copy the email"}
                </Button>
              </div>
            )}

            <p className="border-t border-line pt-2 text-xs text-subtle">
              By Deskzo AI on {clock.dateTimeShort(new Date(view!.at))}
              {view!.by ? ` for ${view!.by}` : ""}. Suggestions only — check them before acting. It read the public research and
              the {what}&apos;s stage and history; no names, numbers, amounts or notes.
            </p>
          </>
        )}
        {notice && <p className="text-xs text-success">{notice}</p>}
        {error && <p className="text-xs text-danger">{error}</p>}
        {data.mayPlan && !p && <p className="text-xs text-subtle">Runs on {data.service}, on the workspace&apos;s credits.</p>}
      </CardContent>
    </Card>
  );
}
