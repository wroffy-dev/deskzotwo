"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ArrowDown, ArrowUp, Plus, Trash2 } from "lucide-react";
import { saveProjectTypeQuestions } from "@/actions/project-questionnaire";
import { Button } from "@/components/ui/button";
import { Input, Select, Textarea } from "@/components/ui/input";
import { IconButton } from "@/components/ui/icon-button";
import { toast } from "@/components/ui/toast";
import { QUESTION_TYPES, isChoice, type Question, type QuestionType } from "@/lib/projects/questionnaire";

type Draft = Question & { uid: number; optionsText: string };
let uid = 0;
const toDraft = (q: Question): Draft => ({ ...q, uid: ++uid, optionsText: q.options.join("\n") });

type SaveResult = { ok: true; data: { count: number } } | { ok: false; error: string };
type RawQuestion = { key?: string; label: string; type: QuestionType; required: boolean; options: string[]; help: string | null };

/**
 * A project type's questions, as the admin writes them (owner, 16 Nov 2026 — "can't admin set questionnaire himself?").
 * Saved as a whole; a project already sent its questionnaire keeps the questions it was sent.
 *
 * A booking page's questions too (owner, 18 Nov 2026): `onSave` saves them its own way, `types` leaves out the kinds it
 * can't ask, and `intro` says what they are for.
 */
export function QuestionnaireEditor({
  typeId,
  questions,
  onSave,
  types,
  intro,
  saveLabel = "Save questionnaire",
  savedLabel = "Questionnaire saved",
}: {
  typeId?: string;
  questions: Question[];
  onSave?: (questions: RawQuestion[]) => Promise<SaveResult>;
  types?: QuestionType[];
  intro?: string;
  saveLabel?: string;
  savedLabel?: string;
}) {
  const kinds = types ? QUESTION_TYPES.filter((t) => types.includes(t.type)) : QUESTION_TYPES;
  const router = useRouter();
  const [drafts, setDrafts] = useState<Draft[]>(() => questions.map(toDraft));
  const [pending, start] = useTransition();

  const update = (i: number, patch: Partial<Draft>) => setDrafts((all) => all.map((d, j) => (j === i ? { ...d, ...patch } : d)));
  const move = (i: number, by: -1 | 1) =>
    setDrafts((all) => {
      const j = i + by;
      if (j < 0 || j >= all.length) return all;
      const next = [...all];
      [next[i], next[j]] = [next[j]!, next[i]!];
      return next;
    });

  return (
    <div className="space-y-2">
      <p className="text-xs text-subtle">
        {intro ??
          "What the customer is asked when somebody sends the questionnaire from a project of this kind. Changing it here leaves questionnaires already sent as they were."}
      </p>
      {drafts.length === 0 && <p className="text-sm text-muted">No questions yet.</p>}
      {drafts.map((d, i) => (
        <div key={d.uid} className={`space-y-2 rounded-md border border-line p-2.5 ${d.type === "HEADING" ? "bg-surface-sunken" : ""}`}>
          <div className="flex flex-wrap items-center gap-2">
            <Input value={d.label} onChange={(e) => update(i, { label: e.target.value })} placeholder={d.type === "HEADING" ? "Section title" : "Question"} aria-label={`Question ${i + 1}`} className="min-w-48 flex-1" />
            <Select value={d.type} onChange={(e) => update(i, { type: e.target.value as QuestionType })} aria-label={`Question ${i + 1} kind`} className="w-40">
              {kinds.map((t) => (
                <option key={t.type} value={t.type}>
                  {t.label}
                </option>
              ))}
            </Select>
            {d.type !== "HEADING" && (
              <label className="flex items-center gap-1.5 text-xs text-muted">
                <input type="checkbox" className="h-4 w-4 accent-[var(--color-brand)]" checked={d.required} onChange={(e) => update(i, { required: e.target.checked })} />
                Required
              </label>
            )}
            <div className="flex items-center">
              <IconButton icon={ArrowUp} label="Move up" onClick={() => move(i, -1)} disabled={i === 0} />
              <IconButton icon={ArrowDown} label="Move down" onClick={() => move(i, 1)} disabled={i === drafts.length - 1} />
              <IconButton icon={Trash2} label="Remove question" tone="danger" onClick={() => setDrafts((all) => all.filter((_, j) => j !== i))} />
            </div>
          </div>
          <Input value={d.help ?? ""} onChange={(e) => update(i, { help: e.target.value || null })} placeholder={d.type === "HEADING" ? "A line under the heading (optional)" : "Help under the question (optional)"} aria-label={`Question ${i + 1} help`} />
          {isChoice(d.type) && (
            <Textarea rows={3} value={d.optionsText} onChange={(e) => update(i, { optionsText: e.target.value })} placeholder="One option per line" aria-label={`Question ${i + 1} options`} />
          )}
        </div>
      ))}
      <div className="flex flex-wrap gap-2">
        <Button size="sm" variant="secondary" onClick={() => setDrafts((all) => [...all, toDraft({ key: "", label: "", type: "TEXT", required: false, options: [], help: null })])}>
          <Plus className="mr-1.5 h-3.5 w-3.5" />
          Add a question
        </Button>
        <Button
          size="sm"
          disabled={pending}
          onClick={() =>
            start(async () => {
              const raw = drafts.map((d) => ({ key: d.key || undefined, label: d.label, type: d.type, required: d.required, options: d.optionsText.split("\n"), help: d.help }));
              const result: SaveResult = onSave ? await onSave(raw) : typeId ? await saveProjectTypeQuestions(typeId, raw) : { ok: false, error: "Nothing to save to." };
              if (!result.ok) return void toast.error(result.error);
              toast.success(`${savedLabel} — ${result.data.count} item${result.data.count === 1 ? "" : "s"}.`);
              router.refresh();
            })
          }
        >
          {pending ? "Saving…" : saveLabel}
        </Button>
      </div>
    </div>
  );
}
