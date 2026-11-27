"use client";

import { useState, useTransition } from "react";
import { Sparkles } from "lucide-react";
import { saveAutoPlanSettings, type AutoPlanSettingsView } from "@/actions/research-plan";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { useClock } from "@/components/time/clock-provider";

/**
 * Settings › Deskzo AI: "Research & plan" new leads by itself (owner, 18 Nov 2026 — phase 2, src/lib/research/auto-plan.ts).
 * Off until an admin switches it on; from then, each new lead is planned once, at most so many a day.
 */
export function AutoPlanSettings({ settings }: { settings: AutoPlanSettingsView }) {
  const clock = useClock();
  const [on, setOn] = useState(settings.enabled);
  const [perDay, setPerDay] = useState(String(settings.perDay));
  const [view, setView] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  const save = () =>
    start(async () => {
      setError(null);
      setSaved(false);
      const r = await saveAutoPlanSettings({ enabled: on, perDay: Number(perDay) });
      if (!r.ok) return setError(r.error);
      setView(r.data);
      setSaved(true);
    });

  return (
    <Card>
      <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
        <Sparkles className="h-4 w-4 text-brand" aria-hidden="true" />
        Research &amp; plan new leads by itself
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted">
          Each new lead is researched from public sources and read by Deskzo AI: how warm it is and why, the next few steps and a first email — as the
          Research &amp; plan button on a lead does. Hot and warm leads then come first on their owner&apos;s Today. Nothing is sent and no task is made
          by itself: the salesperson still chooses.
        </p>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} disabled={!view.aiOn && !on} />
          Plan new leads by itself
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="auto-plan-per-day" className="text-muted">
            At most
          </Label>
          <Input id="auto-plan-per-day" type="number" min={1} max={200} value={perDay} onChange={(e) => setPerDay(e.target.value)} className="w-24" />
          <span className="text-muted">leads a day.</span>
        </div>
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-subtle">
          <li>Only leads that come in after it is switched on — never the leads you already have.</li>
          <li>Each uses Deskzo AI credits, charged to the lead&apos;s owner where they may use Deskzo AI, else to whoever switched this on.</li>
          <li>Each lead is planned once. It reads the lead&apos;s stage and history and contacts&apos; job titles — no names, numbers, amounts or notes.</li>
        </ul>
        {!view.aiOn && <p className="text-xs text-warning">Deskzo AI is switched off — switch it on above first.</p>}
        {view.enabled && (
          <p className="text-xs text-muted">
            On since {view.onSince ? clock.dateTimeShort(new Date(view.onSince)) : "—"} · {view.plannedToday} planned today of {view.perDay}.
          </p>
        )}
        {error && <p className="text-xs text-danger">{error}</p>}
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} disabled={pending}>
            Save
          </Button>
          {saved && <span className="text-xs text-success">Saved.</span>}
        </div>
      </CardContent>
    </Card>
  );
}
