"use client";

import { useState, useTransition } from "react";
import { saveArjunSettings, type ArjunSettingsView } from "@/actions/arjun-settings";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";
import { PeopleMultiSelect } from "@/components/ui/people-multi-select";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";

/**
 * Settings › Deskzo AI: Arjun working by himself (owner, 19 Nov 2026 — phase 3, src/lib/collections/arjun-auto.ts). Off
 * until an admin switches it on; then each working morning he drafts chase emails for the hard cases into each account
 * manager's Drafts to check, and on Mondays the people chosen get his note on the week. Nothing goes to a customer by
 * itself. The last 30 days below.
 */
export function ArjunSettings({ settings }: { settings: ArjunSettingsView }) {
  const arjun = useTeammate("arjun");
  const [view, setView] = useState(settings);
  const [on, setOn] = useState(settings.enabled);
  const [perDay, setPerDay] = useState(String(settings.perDay));
  const [minDaysLate, setMinDaysLate] = useState(String(settings.minDaysLate));
  const [minAmount, setMinAmount] = useState(settings.minAmount > 0 ? String(settings.minAmount) : "");
  const [brokenAlways, setBrokenAlways] = useState(settings.brokenAlways);
  const [weeklyTo, setWeeklyTo] = useState<string[]>(settings.weeklyTo);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const r = view.report;

  const save = () =>
    start(async () => {
      setError(null);
      setSaved(false);
      const result = await saveArjunSettings({ enabled: on, perDay: Number(perDay), minDaysLate: Number(minDaysLate), minAmount: minAmount ? Number(minAmount) : 0, brokenAlways, weeklyTo });
      if (!result.ok) return setError(result.error);
      setView(result.data);
      setWeeklyTo(result.data.weeklyTo);
      setSaved(true);
    });

  return (
    <Card>
      <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
        <TeammateAvatar teammate="arjun" size="sm" />
        {arjun.name} chases payments by himself
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted">
          Each working morning, {arjun.name} drafts chase emails for the hard cases on each account manager&apos;s own customers, and leaves them in their Drafts to
          check on My collections. Every email waits for a person to read, change and send it — nothing goes to a customer by itself. He leaves alone anybody
          whose reminders are paused, who was emailed in the last five days, or who already has a draft waiting.
        </p>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} disabled={!view.aiOn && !on} />
          Let {arjun.name} draft chase emails each morning
        </label>
        <div className="grid gap-2 sm:grid-cols-2">
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="arjun-days" className="text-muted">
              Late at least
            </Label>
            <Input id="arjun-days" type="number" min={1} max={365} value={minDaysLate} onChange={(e) => setMinDaysLate(e.target.value)} className="w-20" />
            <span className="text-muted">days</span>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="arjun-amount" className="text-muted">
              Owing at least
            </Label>
            <Input id="arjun-amount" type="number" min={0} step="1" placeholder="any amount" value={minAmount} onChange={(e) => setMinAmount(e.target.value)} className="w-32" />
            <span className="text-muted">{view.currency}</span>
          </div>
        </div>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={brokenAlways} onChange={(e) => setBrokenAlways(e.target.checked)} />
          And anybody who broke a promise to pay, however late
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="arjun-per-day" className="text-muted">
            At most
          </Label>
          <Input id="arjun-per-day" type="number" min={1} max={200} value={perDay} onChange={(e) => setPerDay(e.target.value)} className="w-24" />
          <span className="text-muted">drafts a day, across the workspace — the most pressing first.</span>
        </div>
        <div className="space-y-1">
          <p className="font-medium text-text">The Monday note</p>
          <p className="text-xs text-muted">
            On Mondays, the people you choose get {arjun.name}&apos;s note on last week — payments in, promises kept and broken, chase emails and replies — and who to
            chase first, each for the customers in their own collections. From the books; it uses no credits.
          </p>
          <PeopleMultiSelect people={view.people} selected={weeklyTo} onChange={setWeeklyTo} label="Who gets the Monday note" placeholder="Search people who follow payments up…" />
        </div>
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-subtle">
          <li>Each draft uses Deskzo AI credits — the account manager&apos;s, where they may use Deskzo AI, else yours as whoever switched this on.</li>
          <li>Customers with no account manager are passed over: nobody would see the draft.</li>
          <li>Sent emails count toward the most a customer gets in 24 hours (Settings › Customer emails).</li>
        </ul>
        {!view.aiOn && <p className="text-xs text-warning">Deskzo AI is switched off — switch it on above first.</p>}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[
            ["Drafted (30 days)", r.drafted],
            ["Sent", r.sent],
            ["Waiting", r.waiting],
            ["Set aside", r.setAside],
            ["Passed over", r.skipped],
          ].map(([label, n]) => (
            <div key={label} className="rounded-base bg-surface-sunken px-2 py-2 text-center">
              <div className="text-base font-semibold tabular-nums text-text">{n}</div>
              <div className="text-[11px] text-muted">{label}</div>
            </div>
          ))}
        </div>
        {view.enabled && (
          <p className="text-xs text-muted">
            {r.draftedToday} drafted today of {view.perDay}.{r.noManager > 0 ? ` ${r.noManager} customer${r.noManager === 1 ? " owing has" : "s owing have"} no account manager.` : ""}
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
