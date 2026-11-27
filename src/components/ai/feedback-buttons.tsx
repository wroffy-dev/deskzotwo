"use client";

import { useState, useTransition } from "react";
import { ThumbsDown, ThumbsUp } from "lucide-react";
import { rateAiWork } from "@/actions/ai-quality";
import type { TeammateKey } from "@/lib/ai/teammates";

/**
 * A thumbs up or down on a teammate's draft or answer (owner, 20 Nov 2026 — step 2; src/lib/ai/drafts.ts `setFeedback`),
 * with an optional reason for a down — read on the teammate's scorecard. Pressing the same again takes it back.
 */
export function FeedbackButtons({ teammate, kind, refId, initial = null }: { teammate: TeammateKey; kind: string; refId: string; initial?: boolean | null }) {
  const [good, setGood] = useState<boolean | null>(initial);
  const [asking, setAsking] = useState(false);
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const rate = (next: boolean | null, why?: string) =>
    start(async () => {
      setError(null);
      const r = await rateAiWork({ teammate, kind, ref: refId, good: next, reason: why });
      if (!r.ok) return setError(r.error);
      setGood(next);
      setAsking(false);
    });
  const button = (up: boolean) => {
    const on = good === up;
    const Icon = up ? ThumbsUp : ThumbsDown;
    return (
      <button
        type="button"
        disabled={pending}
        aria-pressed={on}
        aria-label={up ? "Good — more like this" : "Not good"}
        title={up ? "Good — more like this" : "Not good — say why"}
        onClick={() => (on ? rate(null) : up ? rate(true) : setAsking(true))}
        className={`rounded-md p-1 ${on ? (up ? "bg-success-bg text-success" : "bg-danger-bg text-danger") : "text-subtle hover:bg-surface-sunken hover:text-text"}`}
      >
        <Icon className="h-3.5 w-3.5" aria-hidden="true" />
      </button>
    );
  };
  return (
    <span className="inline-flex flex-wrap items-center gap-1">
      {button(true)}
      {button(false)}
      {asking && (
        <span className="inline-flex items-center gap-1">
          <input
            autoFocus
            value={reason}
            maxLength={300}
            onChange={(e) => setReason(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") rate(false, reason);
              if (e.key === "Escape") setAsking(false);
            }}
            placeholder="What was wrong? (optional)"
            aria-label="What was wrong"
            className="h-7 w-52 rounded-md border border-line bg-surface px-2 text-xs text-text"
          />
          <button type="button" disabled={pending} onClick={() => rate(false, reason)} className="rounded-md bg-surface-sunken px-2 py-1 text-xs text-text">
            Save
          </button>
        </span>
      )}
      {error && <span className="text-[11px] text-danger">{error}</span>}
    </span>
  );
}
