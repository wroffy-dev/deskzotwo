"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, EyeOff, ShieldCheck } from "lucide-react";
import { unmaskLead, type UnmaskOutcome } from "@/actions/lead-unmask";
import type { UnmaskUsageStatus } from "@/lib/authz/unmask";
import { useWording } from "@/components/terms/wording-provider";
import { slot } from "@/lib/terms/dictionary";

/**
 * The strip at the top of a lead's page that says what is masked for this person, and reveals it on "Show".
 *
 * Mounted on the lead's page (and in the Leads split view) only when some of its fields are masked for
 * this person. Revealing is a click (owner, 5 Nov 2026 — Phase 3 masking fixes, audit M-10): the page opens
 * masked, and "Show" — with a reason, if they want to give one — reveals the lead for the rest of the day
 * (`unmaskLead`), its contact with it. The page then reads itself again; the values come from the server's own
 * render, never from here. Nothing is kept in the browser: tomorrow, or once the access is taken away, the same
 * page comes back masked.
 *
 * It used to ask on opening, with nothing to click; opening a lead now spends nothing.
 */
export function LeadUnmask({
  leadId,
  revealable,
  revealed,
  concealed,
  pending: pendingFields = 0,
  usage,
}: {
  leadId: string;
  /** Whether any masked field here is one this person may unmask. */
  revealable: boolean;
  /** Already unmasked today: the fields that reveal covered show in the clear. */
  revealed: boolean;
  /** How many fields stay masked or restricted for them on this page. */
  concealed: number;
  /** How many of the fields they may unmask today's reveal didn't cover — what "Show" would reveal now (audit C.3.6). */
  pending?: number;
  usage: UnmaskUsageStatus | null;
}) {
  const router = useRouter();
  const w = useWording();
  const [outcome, setOutcome] = useState<UnmaskOutcome | null>(null);
  const [reason, setReason] = useState("");
  const [busy, start] = useTransition();

  const shownUsage = outcome?.usage ?? usage;
  const counter = shownUsage ? (shownUsage.limit === null ? `${shownUsage.used} unmasked today` : `${shownUsage.used}/${shownUsage.limit} unmasked today`) : null;
  const open = (revealed && pendingFields === 0) || outcome?.result === "ALLOWED" || outcome?.result === "REPEAT";
  // "Show" is offered while something it may reveal is still masked: never revealed today, or granted since.
  const offer = revealable && (!revealed || pendingFields > 0);

  const show = () =>
    start(async () => {
      try {
        const result = await unmaskLead(leadId, "page", reason);
        setOutcome(result);
        // Newly unmasked: the page reads the lead again, now in the clear.
        if (result.result === "ALLOWED" || result.result === "REPEAT") router.refresh();
      } catch {
        setOutcome({ result: "DENIED", message: "Couldn't unmask this lead just now. Try again.", usage: null });
      }
    });

  if (open) {
    return (
      <div className="flex flex-wrap items-start gap-x-3 gap-y-1 rounded-base border border-success/30 bg-success-bg px-3 py-2.5 text-sm">
        <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden />
        <span className="min-w-0 flex-1 text-text">
          {slot(w, "This lead has been unmasked. It will remain visible for the rest of today.", "lead", "This {one:lower} has been unmasked. It will remain visible for the rest of today.")}{" "}
          <span className="text-muted">{slot(w, "You cannot unmask this lead again today — opening it again uses nothing.", "lead", "You cannot unmask this {one:lower} again today — opening it again uses nothing.")}</span>
        </span>
        {counter && <span className="shrink-0 rounded-full bg-success/10 px-2 py-0.5 text-xs font-medium text-success">{counter}</span>}
      </div>
    );
  }

  const said =
    outcome?.message ??
    (revealed && pendingFields > 0
      ? pendingFields === 1
        ? slot(w, "One more field can be shown — this lead is already unmasked today, so it uses nothing.", "lead", "One more field can be shown — this {one:lower} is already unmasked today, so it uses nothing.")
        : `${pendingFields} ${slot(w, "more fields can be shown — this lead is already unmasked today, so it uses nothing.", "lead", "more fields can be shown — this {one:lower} is already unmasked today, so it uses nothing.")}`
      : concealed === 1
        ? slot(w, "One field on this lead is masked for you.", "lead", "One field on this {one:lower} is masked for you.")
        : `${concealed} ${slot(w, "fields on this lead are masked for you.", "lead", "fields on this {one:lower} are masked for you.")}`);

  return (
    <div
      role={outcome && outcome.result !== "NOTHING" ? "status" : undefined}
      className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-base border border-line bg-surface-sunken px-3 py-2 text-sm"
    >
      <EyeOff className="h-4 w-4 shrink-0 text-subtle" aria-hidden />
      <span className="text-text">{said}</span>
      {offer && (
        <form
          className="flex flex-wrap items-center gap-1.5"
          onSubmit={(e) => {
            e.preventDefault();
            if (!busy) show();
          }}
        >
          <label htmlFor={`unmask-reason-${leadId}`} className="sr-only">
            Reason for showing (optional)
          </label>
          <input
            id={`unmask-reason-${leadId}`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            maxLength={200}
            disabled={busy}
            placeholder="Reason (optional)"
            className="h-7 w-48 rounded-base border border-line-strong bg-surface px-2 text-xs text-text placeholder:text-subtle focus-visible:border-brand disabled:opacity-55"
          />
          <button
            type="submit"
            disabled={busy}
            title="Show the masked fields for the rest of today — counts once today against your unmasking limit"
            className="inline-flex items-center gap-1 rounded-base px-1.5 py-0.5 text-xs text-brand hover:bg-brand/10 disabled:opacity-50"
          >
            <Eye className="h-3.5 w-3.5" aria-hidden /> {busy ? "…" : "Show"}
          </button>
        </form>
      )}
      {counter && <span className="ml-auto rounded-full bg-surface px-2 py-0.5 text-xs font-medium text-muted">{counter}</span>}
    </div>
  );
}
