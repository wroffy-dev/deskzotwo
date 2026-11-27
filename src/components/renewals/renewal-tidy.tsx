"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { previewRenewalTidy, runRenewalTidy, type TidyPreview } from "@/actions/renewal-tidy";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";
import { useClock } from "@/components/time/clock-provider";

/**
 * Renewals › Clean up old renewals (src/lib/renewal-tidy.ts): pick a day, see what it would do, then do it.
 * Nothing changes until the second button.
 */
export function RenewalTidy({ defaultDay }: { defaultDay: string }) {
  const router = useRouter();
  const clock = useClock();
  const [day, setDay] = useState(defaultDay);
  const [preview, setPreview] = useState<TidyPreview | null>(null);
  const [done, setDone] = useState<{ linked: number; closed: number } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  return (
    <div className="space-y-4">
      <Card className="space-y-3 px-4 py-4">
        <div className="flex flex-wrap items-end gap-3">
          <div className="space-y-1.5">
            <Label htmlFor="tidy-before">Subscriptions that ended before</Label>
            <Input
              id="tidy-before"
              type="date"
              value={day}
              onChange={(e) => {
                setDay(e.target.value);
                setPreview(null);
                setDone(null);
              }}
            />
          </div>
          <Button
            variant="secondary"
            disabled={pending || !day}
            onClick={() => {
              setError(null);
              setDone(null);
              startTransition(async () => {
                const result = await previewRenewalTidy(day);
                if (result.ok) setPreview(result.data);
                else setError(result.error);
              });
            }}
          >
            {pending && !preview ? "Looking…" : "See what it would do"}
          </Button>
        </div>
        <p className="text-xs text-subtle">
          Only subscriptions nobody has renewed or marked. One marked lost, negotiating or on hold by a person is left alone.
        </p>
        {error && <p className="text-sm text-danger">{error}</p>}
      </Card>

      {preview && !done && (
        <Card className="space-y-4 px-4 py-4">
          {preview.linked + preview.closed === 0 ? (
            <p className="text-sm text-muted">Nothing to clean up: every subscription that ended before then is renewed or marked.</p>
          ) : (
            <>
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div className="rounded-md border border-line px-3 py-2.5">
                  <div className="text-2xl font-semibold text-text">{preview.linked.toLocaleString("en-IN")}</div>
                  <div className="text-sm text-muted">linked to the later order that renewed them</div>
                </div>
                <div className="rounded-md border border-line px-3 py-2.5">
                  <div className="text-2xl font-semibold text-text">{preview.closed.toLocaleString("en-IN")}</div>
                  <div className="text-sm text-muted">closed as Lost — &ldquo;Ended before Deskzo&rdquo;, quietly</div>
                </div>
              </div>
              {preview.sampleLinks.length > 0 && (
                <div className="text-sm">
                  <div className="mb-1 font-medium text-text">For example, linked</div>
                  <ul className="space-y-0.5 text-muted">
                    {preview.sampleLinks.map((s, i) => (
                      <li key={i}>
                        {s.company} — {s.product}, ended {clock.date(s.ended)} → renewed by {s.renewedBy}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {preview.sampleClosed.length > 0 && (
                <div className="text-sm">
                  <div className="mb-1 font-medium text-text">For example, closed</div>
                  <ul className="space-y-0.5 text-muted">
                    {preview.sampleClosed.map((s, i) => (
                      <li key={i}>
                        {s.company} — {s.product}, ended {clock.date(s.ended)}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              <p className="text-xs text-subtle">
                Nobody is notified, and the renewals report leaves the closed ones out of its rate. A closed one can be reopened from its row like any
                other stage.
              </p>
              <Button
                disabled={pending}
                onClick={() => {
                  setError(null);
                  startTransition(async () => {
                    const result = await runRenewalTidy(day);
                    if (!result.ok) {
                      setError(result.error);
                      return;
                    }
                    setDone(result.data);
                    router.refresh();
                  });
                }}
              >
                {pending ? "Cleaning up…" : `Clean up ${(preview.linked + preview.closed).toLocaleString("en-IN")} subscriptions`}
              </Button>
            </>
          )}
        </Card>
      )}

      {done && (
        <Card className="px-4 py-3 text-sm text-text">
          Done: {done.linked.toLocaleString("en-IN")} linked to their renewal, {done.closed.toLocaleString("en-IN")} closed. The Renewals list now shows only what&apos;s
          still open.
        </Card>
      )}
    </div>
  );
}
