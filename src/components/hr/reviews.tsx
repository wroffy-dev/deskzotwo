"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Pencil, Plus, Trash2 } from "lucide-react";
import {
  acknowledgeReview,
  addPeopleToCycle,
  createReviewCycle,
  deleteGoal,
  saveGoal,
  setReviewCycleStatus,
  submitManagerReview,
  submitSelfAssessment,
  type GoalView,
  type ReviewView,
} from "@/actions/reviews";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { RATINGS, ratingLabel } from "@/lib/hr/review-rules";

type Result = { ok: true } | { ok: false; error: string };

/** Runs an action, shows its error, refreshes the page on success. */
function useAct() {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const run = (fn: () => Promise<Result>, after?: () => void) => {
    setError(null);
    start(async () => {
      const r = await fn();
      if (!r.ok) return setError(r.error);
      after?.();
      router.refresh();
    });
  };
  return { pending, error, run };
}

export const REVIEW_STATUS: Record<ReviewView["status"], { label: string; tone: "amber" | "blue" | "green" }> = {
  AWAITING_SELF: { label: "Self-assessment due", tone: "amber" },
  AWAITING_MANAGER: { label: "With the reviewer", tone: "blue" },
  COMPLETED: { label: "Completed", tone: "green" },
};

export function ReviewStatusBadge({ status }: { status: ReviewView["status"] }) {
  return <Badge tone={REVIEW_STATUS[status].tone}>{REVIEW_STATUS[status].label}</Badge>;
}

export function RatingText({ value }: { value: number | null }) {
  if (value == null) return <span className="text-subtle">—</span>;
  return (
    <span>
      <strong className="font-semibold">{value}</strong>
      <span className="text-muted"> · {ratingLabel(Math.round(value))}</span>
    </span>
  );
}

function RatingSelect({ value, onChange, id }: { value: number | ""; onChange: (v: number | "") => void; id?: string }) {
  return (
    <Select id={id} value={value} onChange={(e) => onChange(e.target.value ? Number(e.target.value) : "")} className="w-56">
      <option value="">Choose…</option>
      {RATINGS.map((r) => (
        <option key={r.value} value={r.value}>
          {r.value} — {r.label}
        </option>
      ))}
    </Select>
  );
}

// ─── Cycles (HR) ──────────────────────────────────────────────────────────────

export function NewCycleForm({ departments }: { departments: { id: string; name: string }[] }) {
  const { pending, error, run } = useAct();
  const [open, setOpen] = useState(false);
  const [f, setF] = useState({ name: "", periodStart: "", periodEnd: "", selfDueOn: "", managerDueOn: "", departmentId: "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Start a review cycle
      </Button>
    );
  }
  return (
    <Card className="space-y-3 p-4">
      <h3 className="text-sm font-semibold text-text">Start a review cycle</h3>
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="sm:col-span-2">
          <Label htmlFor="rc-name">Name</Label>
          <Input id="rc-name" value={f.name} onChange={set("name")} placeholder="Annual review 2026–27" />
        </div>
        <div>
          <Label htmlFor="rc-start">Period from</Label>
          <Input id="rc-start" type="date" value={f.periodStart} onChange={set("periodStart")} />
        </div>
        <div>
          <Label htmlFor="rc-end">to</Label>
          <Input id="rc-end" type="date" value={f.periodEnd} onChange={set("periodEnd")} />
        </div>
        <div>
          <Label htmlFor="rc-self">Self-assessments due (optional)</Label>
          <Input id="rc-self" type="date" value={f.selfDueOn} onChange={set("selfDueOn")} />
        </div>
        <div>
          <Label htmlFor="rc-mgr">Reviewers&apos; ratings due (optional)</Label>
          <Input id="rc-mgr" type="date" value={f.managerDueOn} onChange={set("managerDueOn")} />
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="rc-dept">Who</Label>
          <Select id="rc-dept" value={f.departmentId} onChange={set("departmentId")}>
            <option value="">Everybody working</option>
            {departments.map((d) => (
              <option key={d.id} value={d.id}>
                {d.name} only
              </option>
            ))}
          </Select>
          <p className="mt-1 text-xs text-muted">Each person is reviewed by whoever they report to; they&apos;re told the cycle has started.</p>
        </div>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button disabled={pending} onClick={() => run(() => createReviewCycle({ ...f, departmentId: f.departmentId || undefined }), () => setOpen(false))}>
          Start it
        </Button>
        <Button variant="ghost" disabled={pending} onClick={() => setOpen(false)}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

export function CycleActions({ cycleId, status }: { cycleId: string; status: "OPEN" | "CLOSED" }) {
  const { pending, error, run } = useAct();
  const [note, setNote] = useState<string | null>(null);
  return (
    <div className="flex flex-wrap items-center gap-2">
      {status === "OPEN" && (
        <Button
          variant="secondary"
          disabled={pending}
          onClick={() =>
            run(async () => {
              const r = await addPeopleToCycle(cycleId);
              if (r.ok) setNote(r.data.added ? `${r.data.added} people added.` : "Everybody working is in it already.");
              return r;
            })
          }
        >
          Add new joiners
        </Button>
      )}
      <Button variant={status === "OPEN" ? "primary" : "secondary"} disabled={pending} onClick={() => run(() => setReviewCycleStatus(cycleId, status === "OPEN" ? "CLOSED" : "OPEN"))}>
        {status === "OPEN" ? "Close the cycle" : "Reopen"}
      </Button>
      {note && <span className="text-xs text-muted">{note}</span>}
      {error && <span className="text-sm text-danger">{error}</span>}
    </div>
  );
}

// ─── Goals ────────────────────────────────────────────────────────────────────

const GOAL_STATUS: Record<GoalView["status"], { label: string; tone: "default" | "green" | "red" }> = {
  ACTIVE: { label: "Active", tone: "default" },
  ACHIEVED: { label: "Achieved", tone: "green" },
  DROPPED: { label: "Dropped", tone: "red" },
};

function GoalForm({ reviewId, goal, onDone }: { reviewId: string; goal?: GoalView; onDone: () => void }) {
  const { pending, error, run } = useAct();
  const [f, setF] = useState({ title: goal?.title ?? "", details: goal?.details ?? "", weight: String(goal?.weight ?? 0), progress: String(goal?.progress ?? 0), status: goal?.status ?? "ACTIVE" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="space-y-2 rounded-base border border-line p-3">
      <Input value={f.title} onChange={set("title")} placeholder="What is to be achieved — e.g. Win ten new customers this quarter" aria-label="Goal" />
      <Textarea value={f.details} onChange={set("details")} rows={2} placeholder="How it will be measured (optional)" aria-label="Details" />
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <Label>Weight %</Label>
          <Input type="number" min={0} max={100} value={f.weight} onChange={set("weight")} className="w-24" />
        </div>
        <div>
          <Label>Progress %</Label>
          <Input type="number" min={0} max={100} value={f.progress} onChange={set("progress")} className="w-24" />
        </div>
        <div>
          <Label>Status</Label>
          <Select value={f.status} onChange={set("status")} className="w-36">
            <option value="ACTIVE">Active</option>
            <option value="ACHIEVED">Achieved</option>
            <option value="DROPPED">Dropped</option>
          </Select>
        </div>
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            run(() => saveGoal({ id: goal?.id, reviewId, title: f.title, details: f.details, weight: Number(f.weight), progress: Number(f.progress), status: f.status as GoalView["status"] }), onDone)
          }
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={onDone}>
          Cancel
        </Button>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}

export function GoalsPanel({ review }: { review: ReviewView }) {
  const { pending, error, run } = useAct();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const showSelf = review.self !== null;
  const showManager = review.manager !== null;
  return (
    <Card className="space-y-3 p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-semibold text-text">Goals</h2>
        {review.can.editGoals && editing !== "new" && (
          <Button size="sm" variant="secondary" onClick={() => setEditing("new")}>
            <Plus className="mr-1 h-3.5 w-3.5" />
            Add a goal
          </Button>
        )}
      </div>
      {review.weightNote && <p className="text-xs text-warning">{review.weightNote}</p>}
      {review.goals.length === 0 && editing !== "new" && (
        <p className="text-sm text-muted">{review.can.editGoals ? "No goals yet — add what this period is to achieve, with your manager." : "No goals were set."}</p>
      )}
      <ul className="space-y-2">
        {review.goals.map((g) =>
          editing === g.id ? (
            <li key={g.id}>
              <GoalForm reviewId={review.id} goal={g} onDone={() => setEditing(null)} />
            </li>
          ) : (
            <li key={g.id} className="rounded-base border border-line p-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className={`text-sm font-medium text-text ${g.status === "DROPPED" ? "line-through opacity-60" : ""}`}>{g.title}</p>
                  {g.details && <p className="mt-0.5 whitespace-pre-line text-xs text-muted">{g.details}</p>}
                  <p className="mt-1 text-xs text-subtle">
                    {g.weight > 0 ? `Weight ${g.weight}% · ` : ""}Progress {g.progress}%{g.setBy ? ` · set by ${g.setBy}` : ""}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Badge tone={GOAL_STATUS[g.status].tone}>{GOAL_STATUS[g.status].label}</Badge>
                  {review.can.editGoals && (
                    <>
                      <Button size="icon" variant="ghost" aria-label="Edit goal" onClick={() => setEditing(g.id)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      <Button size="icon" variant="ghost" aria-label="Delete goal" disabled={pending} onClick={() => run(() => deleteGoal({ id: g.id, reviewId: review.id }))}>
                        <Trash2 className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  )}
                </div>
              </div>
              {(showSelf && g.selfRating != null) || (showManager && g.managerRating != null) ? (
                <div className="mt-2 flex flex-wrap gap-x-6 gap-y-1 text-xs">
                  {showSelf && g.selfRating != null && (
                    <span>
                      Self: <RatingText value={g.selfRating} />
                    </span>
                  )}
                  {showManager && g.managerRating != null && (
                    <span>
                      Reviewer: <RatingText value={g.managerRating} />
                    </span>
                  )}
                </div>
              ) : null}
            </li>
          ),
        )}
        {editing === "new" && (
          <li>
            <GoalForm reviewId={review.id} onDone={() => setEditing(null)} />
          </li>
        )}
      </ul>
      {error && <p className="text-sm text-danger">{error}</p>}
    </Card>
  );
}

// ─── Assessments ──────────────────────────────────────────────────────────────

export function AssessmentForm({ review, as }: { review: ReviewView; as: "self" | "reviewer" }) {
  const { pending, error, run } = useAct();
  const live = review.goals.filter((g) => g.status !== "DROPPED");
  const [rating, setRating] = useState<number | "">("");
  const [comments, setComments] = useState("");
  const [goalRatings, setGoalRatings] = useState<Record<string, number | "">>(() =>
    Object.fromEntries(live.map((g) => [g.id, (as === "self" ? g.selfRating : g.managerRating) ?? ""])),
  );
  const submit = as === "self" ? submitSelfAssessment : submitManagerReview;
  const title = as === "self" ? "Your self-assessment" : `Your review of ${review.person.name}`;
  const hint =
    as === "self"
      ? "Rate each goal and the period overall. Once sent, your reviewer rates you; you can't change it after."
      : review.status === "AWAITING_SELF"
        ? "They haven't sent their self-assessment. You can wait, or rate them now — that completes the review."
        : "Rate each goal and overall. Sending it completes the review and shows it to them.";
  return (
    <Card className="space-y-3 p-4">
      <div>
        <h2 className="text-sm font-semibold text-text">{title}</h2>
        <p className="mt-0.5 text-xs text-muted">{hint}</p>
      </div>
      {live.length > 0 && (
        <div className="space-y-2">
          {live.map((g) => (
            <div key={g.id} className="flex flex-wrap items-center justify-between gap-2">
              <span className="min-w-0 flex-1 text-sm text-text">{g.title}</span>
              <RatingSelect value={goalRatings[g.id] ?? ""} onChange={(v) => setGoalRatings({ ...goalRatings, [g.id]: v })} />
            </div>
          ))}
        </div>
      )}
      <div>
        <Label htmlFor={`rating-${as}`}>Overall</Label>
        <RatingSelect id={`rating-${as}`} value={rating} onChange={setRating} />
      </div>
      <div>
        <Label htmlFor={`comments-${as}`}>{as === "self" ? "How the period went" : "What they'll read with the rating"}</Label>
        <Textarea id={`comments-${as}`} rows={4} value={comments} onChange={(e) => setComments(e.target.value)} />
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <Button
        disabled={pending}
        onClick={() =>
          run(() =>
            submit({
              reviewId: review.id,
              rating: Number(rating),
              comments,
              goalRatings: Object.fromEntries(Object.entries(goalRatings).map(([k, v]) => [k, Number(v)])),
            }),
          )
        }
      >
        {as === "self" ? "Send to my reviewer" : "Complete the review"}
      </Button>
    </Card>
  );
}

export function AcknowledgeButton({ reviewId }: { reviewId: string }) {
  const { pending, error, run } = useAct();
  return (
    <div className="flex flex-wrap items-center gap-2">
      <Button disabled={pending} onClick={() => run(() => acknowledgeReview(reviewId))}>
        I&apos;ve read my review
      </Button>
      {error && <span className="text-sm text-danger">{error}</span>}
    </div>
  );
}
