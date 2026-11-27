"use client";

import { useRef, useState } from "react";
import { Eye, EyeOff, FileText, LoaderCircle, Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { CUSTOM_FIELD_LIMITS, fileRef } from "@/lib/custom-fields/rules";

/**
 * The two inputs whose values never come back to the browser as they are (owner, 29 Oct 2026 — src/lib/custom-fields/
 * secure.ts): a secret, which the form holds only as "s1|<last four>|" until somebody types a new one, and a file,
 * uploaded on its own (/api/custom-fields/files) and held as the name the server gave it.
 */

const KEPT = /^s1\|([^|]*)\|$/;

export function SecretInput({ id, value, onChange, disabled, aria }: { id: string; value: string; onChange: (v: string) => void; disabled: boolean; aria: Record<string, unknown> }) {
  const kept = KEPT.exec(value);
  const [shown, setShown] = useState(false);
  const [replacing, setReplacing] = useState(false);
  if (kept && !replacing) {
    const tail = decodeURIComponent(kept[1]!);
    return (
      <div className="flex flex-wrap items-center gap-2">
        <span id={id} className="rounded-base border border-line bg-surface-sunken px-3 py-1.5 font-mono text-sm text-text">
          {tail ? `•••• ${tail}` : "•••• set"}
        </span>
        <Button type="button" size="sm" variant="secondary" disabled={disabled} onClick={() => (setReplacing(true), onChange(""))}>
          Replace
        </Button>
      </div>
    );
  }
  return (
    <div className="flex items-center gap-2">
      <Input
        id={id}
        type={shown ? "text" : "password"}
        autoComplete="off"
        spellCheck={false}
        className="font-mono"
        maxLength={CUSTOM_FIELD_LIMITS.secret}
        value={kept ? "" : value}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        {...aria}
      />
      <Button type="button" size="sm" variant="ghost" aria-label={shown ? "Hide what's typed" : "Show what's typed"} onClick={() => setShown((s) => !s)}>
        {shown ? <EyeOff className="h-4 w-4" aria-hidden="true" /> : <Eye className="h-4 w-4" aria-hidden="true" />}
      </Button>
    </div>
  );
}

export function FileInput({ id, fieldKey, value, onChange, disabled }: { id: string; fieldKey: string; value: string; onChange: (v: string) => void; disabled: boolean }) {
  const picker = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = fileRef(value);

  const upload = async (file: File) => {
    setError(null);
    if (file.size > CUSTOM_FIELD_LIMITS.fileBytes) return setError(`A file is ${CUSTOM_FIELD_LIMITS.fileBytes / 1024 / 1024} MB at most.`);
    setBusy(true);
    try {
      const body = new FormData();
      body.set("field", fieldKey);
      body.set("file", file);
      const res = await fetch("/api/custom-fields/files", { method: "POST", body });
      const r = (await res.json()) as { ok: true; value: string } | { ok: false; error: string };
      if (!r.ok) return setError(r.error);
      onChange(r.value);
    } catch {
      setError("The file couldn't be uploaded — try again.");
    } finally {
      setBusy(false);
      if (picker.current) picker.current.value = "";
    }
  };

  return (
    <div className="space-y-1">
      <div className="flex flex-wrap items-center gap-2">
        {current && (
          <span className="inline-flex max-w-full items-center gap-1.5 truncate text-sm text-text">
            <FileText className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            {current.name}
          </span>
        )}
        <Button type="button" size="sm" variant="secondary" disabled={disabled || busy} onClick={() => picker.current?.click()}>
          {busy ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Upload className="h-4 w-4" aria-hidden="true" />}
          {current ? "Replace" : "Upload"}
        </Button>
        {current && (
          <Button type="button" size="sm" variant="ghost" disabled={disabled || busy} onClick={() => onChange("")}>
            Remove
          </Button>
        )}
        <input
          ref={picker}
          id={id}
          type="file"
          accept="application/pdf,image/png,image/jpeg,image/webp"
          className="sr-only"
          tabIndex={-1}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void upload(f);
          }}
        />
      </div>
      <p className="text-xs text-subtle">A PDF or an image, up to {CUSTOM_FIELD_LIMITS.fileBytes / 1024 / 1024} MB.</p>
      {error && <p className="text-xs text-danger">{error}</p>}
    </div>
  );
}
