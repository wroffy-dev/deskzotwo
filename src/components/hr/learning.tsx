"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ExternalLink, Plus } from "lucide-react";
import { archiveCourse, assignCourse, completeCourse, courseLearners, saveCourse, type CourseLearner, type CourseRow, type MyCourse } from "@/actions/learning";
import { Badge, Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { formatCalendarDay } from "@/lib/time/zone";

type Result = { ok: true } | { ok: false; error: string };
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

const day = (iso: string) => formatCalendarDay(new Date(`${iso}T00:00:00Z`));
const length = (m: number | null) => (m == null ? null : m < 60 ? `${m} min` : `${Math.round((m / 60) * 10) / 10} h`);

export function MyCourseCard({ course }: { course: MyCourse }) {
  const { pending, error, run } = useAct();
  const [finishing, setFinishing] = useState(false);
  const [note, setNote] = useState("");
  return (
    <Card className="space-y-2 p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text">{course.title}</p>
          <p className="text-xs text-muted">
            {[length(course.durationMinutes), course.dueOn ? `finish by ${day(course.dueOn)}` : null].filter(Boolean).join(" · ") || "No deadline"}
          </p>
        </div>
        {course.completedAt ? <Badge tone="green">Done</Badge> : course.overdue ? <Badge tone="red">Overdue</Badge> : <Badge tone="amber">To do</Badge>}
      </div>
      {course.description && <p className="whitespace-pre-line text-sm text-text">{course.description}</p>}
      {course.link && (
        <a href={course.link} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 text-sm text-brand hover:underline">
          Open the material <ExternalLink className="h-3.5 w-3.5" />
        </a>
      )}
      {course.completedAt && course.note && <p className="text-xs text-muted">Your note: {course.note}</p>}
      {!course.completedAt &&
        (finishing ? (
          <div className="space-y-2">
            <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What you took from it (optional)" />
            <div className="flex gap-2">
              <Button size="sm" disabled={pending} onClick={() => run(() => completeCourse({ assignmentId: course.assignmentId, note }))}>
                Mark it done
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFinishing(false)}>
                Cancel
              </Button>
            </div>
          </div>
        ) : (
          <Button size="sm" variant="secondary" onClick={() => setFinishing(true)}>
            I&apos;ve finished it
          </Button>
        ))}
      {error && <p className="text-sm text-danger">{error}</p>}
    </Card>
  );
}

export function CourseForm({ course, onDone }: { course?: CourseRow; onDone?: () => void }) {
  const { pending, error, run } = useAct();
  const [open, setOpen] = useState(!!course);
  const [f, setF] = useState({ title: course?.title ?? "", description: course?.description ?? "", link: course?.link ?? "", durationMinutes: course?.durationMinutes != null ? String(course.durationMinutes) : "" });
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: e.target.value });
  const close = () => (onDone ? onDone() : setOpen(false));
  if (!open) {
    return (
      <Button onClick={() => setOpen(true)}>
        <Plus className="mr-1.5 h-3.5 w-3.5" />
        Add a course
      </Button>
    );
  }
  return (
    <Card className="space-y-3 p-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="sm:col-span-2">
          <Label>Title</Label>
          <Input value={f.title} onChange={set("title")} placeholder="POSH awareness" />
        </div>
        <div>
          <Label>Takes (minutes)</Label>
          <Input type="number" min={1} value={f.durationMinutes} onChange={set("durationMinutes")} />
        </div>
        <div className="sm:col-span-3">
          <Label>Link to the material</Label>
          <Input value={f.link} onChange={set("link")} placeholder="https://…" />
        </div>
        <div className="sm:col-span-3">
          <Label>What it covers</Label>
          <Textarea rows={2} value={f.description} onChange={set("description")} />
        </div>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
      <div className="flex gap-2">
        <Button disabled={pending} onClick={() => run(() => saveCourse({ id: course?.id, ...f, durationMinutes: f.durationMinutes === "" ? null : Number(f.durationMinutes) }), close)}>
          Save course
        </Button>
        <Button variant="ghost" disabled={pending} onClick={close}>
          Cancel
        </Button>
      </div>
    </Card>
  );
}

export function CourseCard({ course, hr, people, departments }: { course: CourseRow; hr: boolean; people: { id: string; name: string }[]; departments: { id: string; name: string }[] }) {
  const { pending, error, run } = useAct();
  const [editing, setEditing] = useState(false);
  const [who, setWho] = useState(hr ? "everyone" : "");
  const [dueOn, setDueOn] = useState("");
  const [learners, setLearners] = useState<CourseLearner[] | null>(null);
  const [note, setNote] = useState<string | null>(null);
  if (editing) return <CourseForm course={course} onDone={() => setEditing(false)} />;
  const give = () => {
    const target = who === "everyone" ? { everyone: true } : who.startsWith("dept:") ? { departmentId: who.slice(5) } : { userIds: [who] };
    run(async () => {
      const r = await assignCourse({ courseId: course.id, dueOn: dueOn || undefined, ...target });
      if (r.ok) setNote(r.data.assigned ? `Given to ${r.data.assigned} more.` : "They all have it already.");
      return r;
    });
  };
  return (
    <Card className={`space-y-2 p-4 ${course.archived ? "opacity-60" : ""}`}>
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-sm font-semibold text-text">
            {course.title} {course.archived && <Badge>Archived</Badge>}
          </p>
          <p className="text-xs text-muted">
            {[length(course.durationMinutes), `${course.completed} of ${course.assigned} done`, course.overdue ? `${course.overdue} overdue` : null].filter(Boolean).join(" · ")}
          </p>
        </div>
        {hr && (
          <div className="flex gap-1">
            <Button size="sm" variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
            <Button size="sm" variant="ghost" disabled={pending} onClick={() => run(() => archiveCourse(course.id, !course.archived))}>
              {course.archived ? "Bring back" : "Archive"}
            </Button>
          </div>
        )}
      </div>
      {!course.archived && (
        <div className="flex flex-wrap items-end gap-2">
          <div>
            <Label>Give it to</Label>
            <Select value={who} onChange={(e) => setWho(e.target.value)} className="w-56">
              {!hr && <option value="">Choose…</option>}
              {hr && <option value="everyone">Everybody working</option>}
              {departments.map((d) => (
                <option key={d.id} value={`dept:${d.id}`}>
                  {d.name}
                </option>
              ))}
              {people.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
          </div>
          <div>
            <Label>Finish by (optional)</Label>
            <Input type="date" value={dueOn} onChange={(e) => setDueOn(e.target.value)} />
          </div>
          <Button size="sm" disabled={pending || !who} onClick={give}>
            Give the course
          </Button>
          {note && <span className="text-xs text-muted">{note}</span>}
        </div>
      )}
      {error && <p className="text-sm text-danger">{error}</p>}
      {course.assigned > 0 && (
        <div>
          <Button size="sm" variant="ghost" onClick={async () => setLearners(learners ? null : await courseLearners(course.id))}>
            {learners ? "Hide who has it" : "Who has it"}
          </Button>
          {learners && (
            <ul className="mt-1 divide-y divide-line text-sm">
              {learners.map((l) => (
                <li key={l.assignmentId} className="flex flex-wrap items-center justify-between gap-2 py-1.5">
                  <span className="text-text">{l.name}</span>
                  <span className="text-xs text-muted">
                    {l.completedAt ? `done${l.note ? ` — ${l.note}` : ""}` : l.overdue ? `overdue since ${day(l.dueOn!)}` : l.dueOn ? `due ${day(l.dueOn)}` : "to do"}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </Card>
  );
}
