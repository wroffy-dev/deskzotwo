"use client";

import { useId } from "react";
import { Paperclip, X } from "lucide-react";
import { fileSizeLabel } from "@/lib/chat/rules";
import { FILES_PER_MESSAGE, FILE_MAX_BYTES } from "@/lib/desks/rules";

/** Files to go with a help desk request or a message on one: up to five, 10 MB each (checked again on the server). */
export function FilePicker({ files, onChange, hint }: { files: File[]; onChange: (files: File[]) => void; hint?: string }) {
  const id = useId();
  const tooBig = files.find((f) => f.size > FILE_MAX_BYTES);
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2.5">
        <label htmlFor={id} className="inline-flex h-9 cursor-pointer items-center gap-1.5 rounded-base border border-line-strong bg-surface px-3.5 text-sm font-medium text-text shadow-sm focus-within:border-brand hover:bg-surface-sunken">
          <Paperclip aria-hidden="true" className="h-4 w-4" />
          Add a photo or file
          <input
            id={id}
            type="file"
            multiple
            className="sr-only"
            onChange={(e) => {
              onChange([...files, ...Array.from(e.target.files ?? [])].slice(0, FILES_PER_MESSAGE));
              e.target.value = "";
            }}
          />
        </label>
        {hint && <span className="text-[13px] text-muted">{hint}</span>}
      </div>
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-2">
          {files.map((f, i) => (
            <li key={`${f.name}-${i}`} className="flex items-center gap-1.5 rounded-base border border-line bg-surface-sunken px-2 py-1 text-xs text-text">
              <span className="max-w-52 truncate">{f.name}</span>
              <span className="text-muted">{fileSizeLabel(f.size)}</span>
              <button type="button" aria-label={`Remove ${f.name}`} onClick={() => onChange(files.filter((_, j) => j !== i))} className="rounded p-0.5 text-muted hover:text-text">
                <X aria-hidden="true" className="h-3.5 w-3.5" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {tooBig && <p className="text-xs text-danger">{tooBig.name} is more than 10 MB.</p>}
    </div>
  );
}
