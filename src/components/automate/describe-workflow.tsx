"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Dialog } from "@/components/ui/dialog";
import { Label, Textarea } from "@/components/ui/input";
import { draftWorkflowWithAI, type DraftingAvailability, type DraftResult } from "@/actions/automate";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";
import { LiveSteps, announceTeammateWork } from "@/components/ai/teammate-live";
import { WORKFLOW_STEPS } from "@/lib/ai/teammate-steps";

const MAX = 2000;
const EXAMPLE = "When a ticket is marked urgent, tell the support manager, and if nobody has replied within an hour, raise its priority and email the customer that we're on it.";

/**
 * "Describe it" (Deskzo Automate, Phase 5): a person says what should happen, the AI drafts the
 * workflow, and it opens in the builder with what to choose and what it asked. It is a draft until
 * a person publishes it. `card`: the gallery's version, a card beside the templates.
 */
export function DescribeWorkflowButton({ availability, card = false }: { availability: DraftingAvailability; card?: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [text, setText] = useState("");
  const mira = useTeammate("mira");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<DraftResult | null>(null);

  const begin = () => {
    setError(null);
    setResult(null);
    setOpen(true);
  };
  const draft = async () => {
    setBusy(true);
    setError(null);
    announceTeammateWork();
    const made = await draftWorkflowWithAI(text);
    setBusy(false);
    if (!made.ok) return setError(made.error);
    setResult(made.data);
  };

  const trigger = card ? (
    <Card className="flex flex-col justify-between gap-3 border-dashed p-4">
      <div>
        {/* Mira, the workflow builder (src/lib/ai/teammates.ts). */}
        <h2 className="flex items-center gap-2 font-medium text-text">
          <TeammateAvatar teammate="mira" size="sm" /> Describe it to {mira.name}
        </h2>
        <p className="mt-1 text-sm text-muted">Say what should happen in a sentence or two, and AI drafts the workflow for you to check and publish.</p>
        {!availability.available && availability.reason && <p className="mt-1 text-xs text-subtle">{availability.reason}</p>}
      </div>
      <Button variant="secondary" size="sm" onClick={begin} className="self-start">
        Describe a workflow
      </Button>
    </Card>
  ) : (
    <Button variant="secondary" size="sm" onClick={begin}>
      <TeammateAvatar teammate="mira" size="xs" /> Describe it to {mira.name}
    </Button>
  );

  return (
    <>
      {trigger}
      <Dialog open={open} onClose={() => !busy && setOpen(false)} title={`Tell ${mira.name} what should happen`}>
        {result ? (
          <div className="space-y-3 text-sm">
            <p className="text-text">
              {mira.name} drafted &ldquo;{result.name}&rdquo; — {result.steps} step{result.steps === 1 ? "" : "s"}. It is a draft: nothing runs until you publish it.
            </p>
            {/* What she built, step by step — each dropping into place in turn (still for reduced motion). */}
            {result.outline.length > 0 && (
              <ol className="space-y-1 rounded-lg border border-line bg-surface-sunken px-3 py-2.5">
                {result.outline.map((s, i) => (
                  <li
                    key={`${i}:${s.title}`}
                    className="flex items-center gap-2 text-text motion-safe:animate-fade-rise"
                    style={{ paddingLeft: s.depth * 16, animationDelay: `${i * 120}ms`, animationFillMode: "backwards" }}
                  >
                    <span className="flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-surface text-[11px] font-semibold text-muted">{i + 1}</span>
                    {s.title}
                  </li>
                ))}
              </ol>
            )}
            {result.blanks.length > 0 && (
              <div>
                <p className="font-medium text-text">To choose in the builder</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
                  {[...new Set(result.blanks)].slice(0, 6).map((b) => (
                    <li key={b}>{b}</li>
                  ))}
                </ul>
              </div>
            )}
            {result.questions.length > 0 && (
              <div>
                <p className="font-medium text-text">It asks</p>
                <ul className="mt-1 list-disc space-y-0.5 pl-5 text-muted">
                  {result.questions.map((q) => (
                    <li key={q}>{q}</li>
                  ))}
                </ul>
              </div>
            )}
            {result.others > 0 && (
              <p className="rounded-base bg-warning-bg px-3 py-2 text-xs text-warning">
                {result.others} more thing{result.others === 1 ? "" : "s"} to fix {result.others === 1 ? "is" : "are"} marked on its steps.
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={() => setResult(null)}>
                Describe another
              </Button>
              <Button onClick={() => router.push(result.path)}>Open it in the builder</Button>
            </div>
          </div>
        ) : (
          <div className="space-y-3">
            <div className="space-y-1">
              <Label htmlFor="describe-workflow">What starts it, and what should happen</Label>
              <Textarea id="describe-workflow" rows={6} maxLength={MAX} value={text} placeholder={EXAMPLE} onChange={(e) => setText(e.target.value)} disabled={busy} />
              <p className="text-xs text-subtle">
                {availability.provider ? `Your words go to ${availability.provider} to draft it` : "Your words go to the AI service Deskzo AI uses"} — nothing from your records goes with them. Leave out customers&apos; names and details: say
                &ldquo;the customer&rdquo; instead. People, records and channels are chosen afterwards, in the builder.
              </p>
            </div>
            {!availability.available && availability.reason && <p className="rounded-base bg-warning-bg px-3 py-2 text-xs text-warning">{availability.reason}</p>}
            {error && <p className="text-sm text-danger">{error}</p>}
            {/* Mira's own steps as the drafting reaches them (src/components/ai/teammate-live.tsx). */}
            <LiveSteps teammate="mira" subject="workflow:draft" active={busy} fallback={WORKFLOW_STEPS} />
            <div className="flex items-center justify-end gap-2">
              {busy && <span className="text-xs text-muted">This can take up to a minute…</span>}
              <Button variant="secondary" disabled={busy} onClick={() => setOpen(false)}>
                Cancel
              </Button>
              <Button disabled={busy || !availability.available || text.trim().length < 10} onClick={draft}>
                {busy ? "Drafting…" : "Draft it"}
              </Button>
            </div>
          </div>
        )}
      </Dialog>
    </>
  );
}
