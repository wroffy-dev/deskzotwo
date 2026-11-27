"use client";

import { Paperclip, X } from "lucide-react";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { QUESTIONNAIRE_FILE, type AnswerValue, type FileAnswer, type Question } from "@/lib/projects/questionnaire";

/**
 * One question as somebody answers it — a project questionnaire (src/components/projects/questionnaire-form.tsx) and a
 * booking page (src/components/booking/booking-widget.tsx) both draw theirs with it. A file question needs the upload
 * handlers; a booking page asks none.
 */

const size = (bytes: number) => (bytes >= 1024 * 1024 ? `${(bytes / (1024 * 1024)).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

export function QuestionField({
  q,
  value,
  error,
  onChange,
  uploading,
  onAttach,
  onRemoveFile,
}: {
  q: Question;
  value: AnswerValue | undefined;
  error?: string;
  onChange: (v: AnswerValue | undefined) => void;
  uploading: boolean;
  onAttach: (file: File) => void;
  onRemoveFile: (documentId: string) => void;
}) {
  if (q.type === "HEADING") {
    return (
      <div className="border-t border-line pt-4 first:border-t-0 first:pt-0">
        <h2 className="text-base font-semibold text-text">{q.label}</h2>
        {q.help && <p className="mt-0.5 text-sm text-muted">{q.help}</p>}
      </div>
    );
  }
  const id = `q-${q.key}`;
  const text = typeof value === "string" ? value : "";
  const label = (
    <Label htmlFor={id}>
      {q.label}
      {q.required && <span className="ml-0.5 text-danger" aria-hidden>*</span>}
    </Label>
  );
  const help = q.help && <p className="text-xs text-subtle">{q.help}</p>;
  const err = error && <p className="text-xs text-danger">{error}</p>;

  if (q.type === "CHECKBOX") {
    return (
      <div className="space-y-1">
        <label className="flex items-start gap-2 text-sm text-text">
          <input id={id} type="checkbox" className="mt-0.5 h-4 w-4 accent-[var(--color-brand)]" checked={value === true} onChange={(e) => onChange(e.target.checked)} />
          <span>
            {q.label}
            {q.required && <span className="ml-0.5 text-danger" aria-hidden>*</span>}
          </span>
        </label>
        {help}
        {err}
      </div>
    );
  }

  if (q.type === "FILE") {
    const files = Array.isArray(value) ? (value as FileAnswer[]).filter((f) => typeof f === "object") : [];
    return (
      <div className="space-y-1.5">
        {label}
        {help}
        {files.length > 0 && (
          <ul className="space-y-1">
            {files.map((f) => (
              <li key={f.documentId} className="flex items-center gap-2 text-sm text-text">
                <Paperclip className="h-3.5 w-3.5 shrink-0 text-muted" aria-hidden />
                <span className="min-w-0 truncate">{f.name}</span>
                <span className="text-xs text-muted">{size(f.size)}</span>
                <button type="button" onClick={() => onRemoveFile(f.documentId)} className="text-muted hover:text-danger" aria-label={`Remove ${f.name}`}>
                  <X className="h-3.5 w-3.5" />
                </button>
              </li>
            ))}
          </ul>
        )}
        <label className="inline-flex cursor-pointer items-center gap-1.5 text-sm font-medium text-brand hover:underline">
          <Paperclip className="h-3.5 w-3.5" aria-hidden />
          {uploading ? "Uploading…" : files.length ? "Attach another" : "Attach a file"}
          <input
            id={id}
            type="file"
            accept={QUESTIONNAIRE_FILE.accept}
            className="sr-only"
            disabled={uploading}
            onChange={(e) => {
              const file = e.target.files?.[0];
              e.target.value = "";
              if (file) onAttach(file);
            }}
          />
        </label>
        <p className="text-xs text-subtle">PDF, Word, Excel, CSV or a picture — up to 4 MB each.</p>
        {err}
      </div>
    );
  }

  if (q.type === "RADIO" || q.type === "MULTISELECT") {
    const picked = q.type === "MULTISELECT" ? (Array.isArray(value) ? (value as string[]) : []) : [text];
    return (
      <fieldset className="space-y-1.5">
        <legend className="text-sm font-medium text-text">
          {q.label}
          {q.required && <span className="ml-0.5 text-danger" aria-hidden>*</span>}
        </legend>
        {help}
        <div className="space-y-1">
          {q.options.map((o) => (
            <label key={o} className="flex items-start gap-2 text-sm text-text">
              <input
                type={q.type === "RADIO" ? "radio" : "checkbox"}
                name={id}
                className="mt-0.5 h-4 w-4 accent-[var(--color-brand)]"
                checked={picked.includes(o)}
                onChange={(e) =>
                  q.type === "RADIO" ? onChange(o) : onChange(e.target.checked ? [...picked, o] : picked.filter((p) => p !== o))
                }
              />
              {o}
            </label>
          ))}
        </div>
        {err}
      </fieldset>
    );
  }

  return (
    <div className="space-y-1.5">
      {label}
      {help}
      {q.type === "TEXTAREA" ? (
        <Textarea id={id} rows={4} value={text} onChange={(e) => onChange(e.target.value)} />
      ) : q.type === "SELECT" ? (
        <Select id={id} value={text} onChange={(e) => onChange(e.target.value)}>
          <option value="">Choose…</option>
          {q.options.map((o) => (
            <option key={o} value={o}>
              {o}
            </option>
          ))}
        </Select>
      ) : (
        <Input
          id={id}
          type={q.type === "NUMBER" ? "number" : q.type === "DATE" ? "date" : q.type === "EMAIL" ? "email" : q.type === "PHONE" ? "tel" : "text"}
          value={text}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
      {err}
    </div>
  );
}
