"use client";

import { useEffect, useState, useTransition } from "react";
import { Copy, Eye } from "lucide-react";
import { Button } from "@/components/ui/button";

/**
 * A secret field's Reveal (owner, 29 Oct 2026): the record type's own action, bound to the record and the field,
 * decides who may and records the reveal (src/lib/custom-fields/secure.ts). Shown for a minute, then masked again.
 */
export function RevealSecret({ masked, reveal }: { masked: string; reveal: () => Promise<{ ok: true; data: { secret: string } } | { ok: false; error: string }> }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  useEffect(() => {
    if (secret === null) return;
    const t = setTimeout(() => setSecret(null), 60_000);
    return () => clearTimeout(t);
  }, [secret]);
  if (secret !== null) {
    return (
      <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
        <code className="break-all rounded-base bg-surface-sunken px-1.5 py-0.5 text-sm text-text">{secret}</code>
        <Button
          type="button"
          size="sm"
          variant="ghost"
          aria-label="Copy"
          onClick={() => void navigator.clipboard.writeText(secret).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
        >
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          {copied ? "Copied" : ""}
        </Button>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
      <span className="font-mono">{masked}</span>
      <Button
        type="button"
        size="sm"
        variant="ghost"
        disabled={pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await reveal();
            if (!r.ok) return setError(r.error);
            setSecret(r.data.secret);
          })
        }
      >
        <Eye className="h-3.5 w-3.5" aria-hidden="true" />
        Reveal
      </Button>
      {error && <span className="w-full text-right text-xs text-danger">{error}</span>}
    </span>
  );
}
