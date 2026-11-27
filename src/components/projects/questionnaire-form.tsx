"use client";

import { useState, useTransition } from "react";
import { CheckCircle2 } from "lucide-react";
import { attachQuestionnaireFile, removeQuestionnaireFile, saveQuestionnaire, type QuestionnairePage } from "@/actions/questionnaire-public";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { type AnswerValue, type Answers, type FileAnswer } from "@/lib/projects/questionnaire";
import { QuestionField } from "@/components/forms/question-field";

/**
 * The customer filling in a project's questionnaire (owner, 16 Nov 2026). Save for later keeps what is there without
 * asking for the required ones; Send it back checks them and closes it. A file goes up as soon as it is chosen.
 */
export function QuestionnaireForm({ token, page }: { token: string; page: QuestionnairePage }) {
  const [answers, setAnswers] = useState<Answers>(page.answers);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [sent, setSent] = useState<boolean>(!!page.submittedAt);
  const [uploading, setUploading] = useState<string | null>(null);
  const [pending, start] = useTransition();

  const set = (key: string, value: AnswerValue | undefined) => {
    setMessage(null);
    setErrors((e) => {
      const next = { ...e };
      delete next[key];
      return next;
    });
    setAnswers((a) => {
      const next = { ...a };
      if (value === undefined || value === "" || (Array.isArray(value) && value.length === 0) || value === false) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  const save = (submit: boolean) =>
    start(async () => {
      const result = await saveQuestionnaire(token, answers, submit);
      if (!result.ok) {
        setErrors(result.errors ?? {});
        setMessage({ tone: "error", text: result.error });
        return;
      }
      if (result.submitted) setSent(true);
      else setMessage({ tone: "ok", text: "Saved. Come back to this same link to carry on." });
    });

  if (sent) {
    return (
      <Card className="mx-auto max-w-xl px-6 py-12 text-center">
        <CheckCircle2 className="mx-auto h-8 w-8 text-success" aria-hidden />
        <h1 className="mt-3 text-lg font-semibold text-text">Thank you — we have your answers</h1>
        <p className="mt-2 text-sm text-muted">
          {page.ourName ? `${page.ourName} will` : "We'll"} go through them for {page.projectName} and come back to you. If something changes, reply to the email
          the link came in.
        </p>
      </Card>
    );
  }

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <div>
        {page.ourName && <p className="text-sm text-muted">{page.ourName}</p>}
        <h1 className="mt-0.5 text-2xl font-semibold text-text">{page.projectName}</h1>
        <p className="mt-1 text-sm text-muted">
          A few questions for {page.companyName}, so the work is planned around what you actually have. Rough answers are fine — save and come back any
          time with this same link.
        </p>
      </div>

      <Card className="space-y-5 px-5 py-5">
        {page.questions.map((q) => (
          <QuestionField
            key={q.key}
            q={q}
            value={answers[q.key]}
            error={errors[q.key]}
            onChange={(v) => set(q.key, v)}
            uploading={uploading === q.key}
            onAttach={(file) => {
              setUploading(q.key);
              setMessage(null);
              const form = new FormData();
              form.set("token", token);
              form.set("key", q.key);
              form.set("file", file);
              void attachQuestionnaireFile(form)
                .then((r) => {
                  if (!r.ok) return setErrors((e) => ({ ...e, [q.key]: r.error }));
                  setAnswers((a) => ({ ...a, [q.key]: [...((a[q.key] as FileAnswer[] | undefined) ?? []), r.file] }));
                  setErrors((e) => {
                    const next = { ...e };
                    delete next[q.key];
                    return next;
                  });
                })
                .catch(() => setErrors((e) => ({ ...e, [q.key]: "That didn't upload — try again." })))
                .finally(() => setUploading(null));
            }}
            onRemoveFile={(documentId) =>
              void removeQuestionnaireFile(token, q.key, documentId).then((r) => {
                if (!r.ok) return setErrors((e) => ({ ...e, [q.key]: r.error }));
                setAnswers((a) => {
                  const left = ((a[q.key] as FileAnswer[] | undefined) ?? []).filter((f) => f.documentId !== documentId);
                  const next = { ...a };
                  if (left.length) next[q.key] = left;
                  else delete next[q.key];
                  return next;
                });
              })
            }
          />
        ))}
      </Card>

      {message && <p className={`text-sm ${message.tone === "ok" ? "text-success" : "text-danger"}`}>{message.text}</p>}
      <div className="flex flex-wrap gap-2">
        <Button disabled={pending || !!uploading} onClick={() => save(true)}>
          {pending ? "Sending…" : "Send it back"}
        </Button>
        <Button variant="secondary" disabled={pending || !!uploading} onClick={() => save(false)}>
          Save for later
        </Button>
      </div>
    </div>
  );
}
