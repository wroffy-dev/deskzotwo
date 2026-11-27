"use client";

import { useEffect, useState, useTransition } from "react";
import { Copy, Download, Eye } from "lucide-react";
import { portalRevealSecret, type PortalField } from "@/actions/portal-public";
import { Button } from "@/components/ui/button";

/**
 * What the workspace shows the customer on a subscription (owner, 29 Oct 2026): its details, a licence key masked
 * with Reveal and Copy — only where the portal checks the emailed code — and files to download.
 */
export function PortalFields({ token, subscriptionId, fields }: { token: string; subscriptionId: string; fields: PortalField[] }) {
  if (fields.length === 0) return null;
  return (
    <dl className="mt-2 space-y-1.5 rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm">
      {fields.map((f) => (
        <div key={f.key} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
          <dt className="text-muted">{f.label}</dt>
          <dd className="min-w-0 break-words text-right text-text">
            {f.kind === "text" ? (
              f.text
            ) : f.kind === "file" ? (
              <a href={`/portal/${encodeURIComponent(token)}/file/${encodeURIComponent(f.fileId)}`} className="inline-flex items-center gap-1 text-brand hover:underline">
                <Download className="h-3.5 w-3.5" aria-hidden="true" />
                {f.name}
              </a>
            ) : (
              <Secret token={token} subscriptionId={subscriptionId} field={f} />
            )}
          </dd>
        </div>
      ))}
    </dl>
  );
}

function Secret({ token, subscriptionId, field }: { token: string; subscriptionId: string; field: Extract<PortalField, { kind: "secret" }> }) {
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [pending, start] = useTransition();
  useEffect(() => {
    if (secret === null) return;
    const t = setTimeout(() => setSecret(null), 120_000);
    return () => clearTimeout(t);
  }, [secret]);
  if (secret !== null) {
    return (
      <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
        <code className="break-all rounded-base bg-surface px-1.5 py-0.5">{secret}</code>
        <Button type="button" size="sm" variant="ghost" onClick={() => void navigator.clipboard.writeText(secret).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}>
          <Copy className="h-3.5 w-3.5" aria-hidden="true" />
          {copied ? "Copied" : "Copy"}
        </Button>
      </span>
    );
  }
  return (
    <span className="inline-flex flex-wrap items-center justify-end gap-1.5">
      <span className="font-mono">{field.masked}</span>
      {field.canReveal ? (
        <Button
          type="button"
          size="sm"
          variant="ghost"
          disabled={pending}
          onClick={() =>
            start(async () => {
              setError(null);
              const r = await portalRevealSecret(token, subscriptionId, field.key);
              if (!r.ok) return setError(r.error);
              setSecret(r.data.secret);
            })
          }
        >
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
          Reveal
        </Button>
      ) : (
        <span className="text-xs text-muted">Ask us for it</span>
      )}
      {error && <span className="w-full text-right text-xs text-danger">{error}</span>}
    </span>
  );
}
