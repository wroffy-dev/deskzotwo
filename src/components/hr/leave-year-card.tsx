"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { previewLeaveYear, saveLeaveYear, type LeaveYearPreview, type LeaveYearState } from "@/actions/leave-year";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label, Select } from "@/components/ui/input";
import { formatCalendarDay } from "@/lib/time/zone";
import type { LeaveYearStart } from "@/lib/hr/leave-year";

/**
 * HR's leave year (owner, 18 Nov 2026): April to March or January to December. A change shows what it does first —
 * the changeover year and its months, and whose all-at-once balance it brings down — and is saved only on a second
 * press. Payroll, PF and TDS stay April to March whatever is picked here.
 */
export function LeaveYearCard({ state }: { state: LeaveYearState }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  // What the year will be: the change not begun yet, else what it is now.
  const settled: LeaveYearStart = state.pending?.start ?? state.start;
  const [choice, setChoice] = useState<LeaveYearStart>(settled);
  const [preview, setPreview] = useState<LeaveYearPreview | null>(null);

  function pick(value: LeaveYearStart) {
    setChoice(value);
    setPreview(null);
    setError(null);
    if (value === settled) return;
    startTransition(async () => {
      try {
        const r = await previewLeaveYear(value);
        if (!r.ok) setError(r.error);
        else setPreview(r.data);
      } catch {
        setError("That didn't go through — reload the page.");
      }
    });
  }

  function save() {
    setError(null);
    startTransition(async () => {
      try {
        const r = await saveLeaveYear(choice);
        if (!r.ok) {
          setError(r.error);
          return;
        }
        setPreview(null);
        router.refresh();
      } catch {
        setError("That didn't go through — reload the page.");
      }
    });
  }

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Leave year</CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted">
          When leave is granted, and when unused days carry forward or lapse. This year is <span className="font-medium text-text">{state.currentLabel}</span>.
          Payroll, PF and TDS stay April to March whatever you pick.
        </p>
        {state.pending && (
          <p className="rounded-md bg-surface-sunken px-3 py-2 text-text">
            Changing to {state.pending.startName} from {formatCalendarDay(state.pending.from)}. {state.pending.changeoverLabel} is the changeover year, {state.pending.changeoverMonths} months long.
          </p>
        )}
        <div className="space-y-1.5">
          <Label htmlFor="leave-year-start">The leave year runs</Label>
          <Select id="leave-year-start" value={String(choice)} disabled={pending} onChange={(e) => pick(Number(e.target.value) as LeaveYearStart)}>
            <option value="3">April to March</option>
            <option value="0">January to December</option>
          </Select>
        </div>

        {preview && preview.cancelsPending && (
          <p className="text-text">This takes back the change not begun yet: {state.currentLabel} carries on as it is, and the leave year stays {preview.startName}.</p>
        )}
        {preview && !preview.cancelsPending && (
          <div className="space-y-2 rounded-md border border-line px-3 py-2 text-text">
            <p>
              From <span className="font-medium">{formatCalendarDay(preview.firstYearFrom)}</span> the leave year runs {preview.startName}. Before that,{" "}
              <span className="font-medium">{preview.changeoverLabel}</span> is a changeover year of {preview.changeoverMonths} months, so nobody gains or loses days:
            </p>
            <ul className="list-disc space-y-1 pl-5 text-muted">
              <li>Leave given all at once is {preview.changeoverMonths} twelfths of the year&apos;s days for it.</li>
              <li>Leave given each month keeps adding a twelfth a month, as now.</li>
              <li>Unused days carry forward, or lapse, at its end — {formatCalendarDay(preview.changeoverTo)}.</li>
            </ul>
            {preview.shortened > 0 && (
              <p className="text-warning">
                {preview.shortened.toLocaleString("en-IN")} all-at-once balance{preview.shortened === 1 ? "" : "s"} for this year come{preview.shortened === 1 ? "s" : ""} down to{" "}
                {preview.changeoverMonths} months&apos; worth.
                {preview.belowNothing.length > 0 && <> These people have already taken more than that, and go below nothing until the next year&apos;s grant:</>}
              </p>
            )}
            {preview.belowNothing.length > 0 && (
              <ul className="max-h-40 overflow-auto rounded-md bg-surface-sunken px-3 py-2 text-xs">
                {preview.belowNothing.map((b, i) => (
                  <li key={`${b.name}:${b.type}:${i}`}>
                    {b.name} — {b.type}: {b.balance.toLocaleString("en-IN")}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {error && (
          <p role="alert" className="text-danger">
            {error}
          </p>
        )}
        {choice !== settled && preview !== null && (
          <div className="flex flex-wrap gap-2">
            <Button type="button" size="sm" disabled={pending} onClick={save}>
              {preview.cancelsPending ? "Keep it as it is" : `Change to ${preview.startName}`}
            </Button>
            <Button type="button" size="sm" variant="ghost" disabled={pending} onClick={() => pick(settled)}>
              Not now
            </Button>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
