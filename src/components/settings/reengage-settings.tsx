"use client";

import { useState, useTransition } from "react";
import { saveReengageSettings, type ReengageSettingsView } from "@/actions/reengage";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";

/**
 * Settings › Deskzo AI: Tara checking in with quiet customers (owner, 20 Nov 2026 — AI team step 4, src/lib/reengage).
 * Off until an admin switches it on; every email waits for the customer's account manager. The last 30 days below.
 */
export function ReengageSettings({ settings }: { settings: ReengageSettingsView }) {
  const tara = useTeammate("tara");
  const [on, setOn] = useState(settings.enabled);
  const [months, setMonths] = useState(String(settings.months));
  const [perDay, setPerDay] = useState(String(settings.perDay));
  const [view, setView] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const r = view.report;

  const save = () =>
    start(async () => {
      setError(null);
      setSaved(false);
      const result = await saveReengageSettings({ enabled: on, months: Number(months), perDay: Number(perDay) });
      if (!result.ok) return setError(result.error);
      setView(result.data);
      setSaved(true);
    });

  return (
    <Card>
      <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
        <TeammateAvatar teammate="tara" size="sm" />
        Check in with quiet customers <span className="font-normal text-muted">· {tara.name}</span>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted">
          {tara.name} drafts one short, friendly email to a customer who hasn&apos;t ordered for a while — about what they bought from you, and something else they might
          find useful. It waits for their account manager to read, change and send from their own mailbox; nothing goes by itself.
        </p>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} disabled={!view.aiOn && !on} />
          Let {tara.name} check in with quiet customers
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="reengage-months" className="text-muted">
            Quiet after
          </Label>
          <Input id="reengage-months" type="number" min={2} max={36} value={months} onChange={(e) => setMonths(e.target.value)} className="w-20" />
          <span className="text-muted">months without an order or invoice.</span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="reengage-per-day" className="text-muted">
            By herself, at most
          </Label>
          <Input id="reengage-per-day" type="number" min={0} max={100} value={perDay} onChange={(e) => setPerDay(e.target.value)} className="w-20" />
          <span className="text-muted">check-ins a day, most valuable customers first — 0 for only when somebody asks on the customer&apos;s page.</span>
        </div>
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-subtle">
          <li>One voice per customer: nothing while a renewal is due in 60 days, money is overdue or Arjun chased in the last 14 days, a lead is open, or they had any email from you in the last week.</li>
          <li>Product names, quantities and when — never prices. Written by Deskzo AI on the account manager&apos;s credits.</li>
          <li>Approved emails go in working hours, Monday to Friday 9 to 5, or at 10 the next working morning — and count toward the most a customer gets in 24 hours.</li>
          <li>Replies are forwarded to the account manager and read: interested or asking for a call opens a lead for them; asking to stop unsubscribes them at once.</li>
        </ul>
        {!view.aiOn && <p className="text-xs text-warning">Deskzo AI is switched off — switch it on above first.</p>}
        <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
          {[
            ["Quiet now", r.quietNow],
            ["Drafted (30 days)", r.drafted],
            ["Sent", r.sent],
            ["Replies", r.replied],
            ["Leads opened", r.leads],
            ["Not sent", r.turnedDown],
          ].map(([label, n]) => (
            <div key={label} className="rounded-base bg-surface-sunken px-2 py-2 text-center">
              <div className="text-base font-semibold tabular-nums text-text">{n}</div>
              <div className="text-[11px] text-muted">{label}</div>
            </div>
          ))}
        </div>
        {view.enabled && view.perDay > 0 && (
          <p className="text-xs text-muted">
            {view.draftedToday} drafted today of {view.perDay}.
          </p>
        )}
        <div className="flex items-center gap-3">
          <Button size="sm" onClick={save} disabled={pending}>
            {pending ? "Saving…" : "Save"}
          </Button>
          {saved && <span className="text-xs text-success">Saved.</span>}
          {error && <span className="text-xs text-danger">{error}</span>}
        </div>
      </CardContent>
    </Card>
  );
}
