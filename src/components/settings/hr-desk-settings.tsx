"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { saveHrDeskSettings, type HrDeskSettingsView } from "@/actions/hr-desk";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { PeopleMultiSelect } from "@/components/ui/people-multi-select";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";

/**
 * Settings › Deskzo AI: Priya, the HR desk (owner, 20 Nov 2026 — src/lib/hr-desk). Off until an admin switches it on;
 * then anybody with My HR may ask her, she answers from their own records and the HR guides ticked here, and passes the
 * rest to the people named (else everybody who manages people records). The last 30 days below.
 */
export function HrDeskSettings({ settings }: { settings: HrDeskSettingsView }) {
  const priya = useTeammate("priya");
  const [view, setView] = useState(settings);
  const [on, setOn] = useState(settings.enabled);
  const [handTo, setHandTo] = useState<string[]>(settings.handTo);
  const [files, setFiles] = useState<Set<string>>(() => new Set((settings.files ?? []).filter((f) => f.chosen).map((f) => f.id)));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const r = view.report;

  const save = () =>
    start(async () => {
      setError(null);
      setSaved(false);
      const result = await saveHrDeskSettings({ enabled: on, handTo, fileIds: [...files] });
      if (!result.ok) return setError(result.error);
      setView(result.data);
      setHandTo(result.data.handTo);
      setSaved(true);
    });

  return (
    <Card>
      <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
        <TeammateAvatar teammate="priya" size="sm" />
        {priya.name}, the HR desk
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted">
          Anybody with My HR can ask {priya.name} about their own leave, holidays, attendance, short leave and payslips, and about the HR guides you tick below.
          What she can&apos;t answer — or when they ask for a person — goes to HR, who answer on People › HR desk. She never sees salaries, deductions, bank or ID
          numbers, or anybody else&apos;s records.
        </p>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} disabled={!view.aiOn && !on} />
          Let everybody ask {priya.name}
        </label>
        <div className="space-y-1">
          <p className="font-medium text-text">HR guides she may answer from</p>
          {view.files === null || view.files.length === 0 ? (
            <p className="text-xs text-muted">
              No AI Knowledge files yet. Add your leave policy, handbook or FAQs in{" "}
              <Link href="/settings/ai-knowledge" className="text-brand hover:underline">
                AI Knowledge
              </Link>
              , then tick them here. Without any, she answers only from people&apos;s own records.
            </p>
          ) : (
            <ul className="max-h-48 space-y-1 overflow-y-auto rounded-base border border-line p-2">
              {view.files.map((f) => (
                <li key={f.id}>
                  <label className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={files.has(f.id)}
                      onChange={(e) =>
                        setFiles((s) => {
                          const next = new Set(s);
                          if (e.target.checked) next.add(f.id);
                          else next.delete(f.id);
                          return next;
                        })
                      }
                    />
                    <span className="text-text">{f.title || f.name}</span>
                    {f.title && <span className="text-subtle">{f.name}</span>}
                  </label>
                </li>
              ))}
            </ul>
          )}
          <p className="text-[11px] text-subtle">Anybody may ask about a ticked file — tick only what every employee may read.</p>
        </div>
        <div className="space-y-1">
          <p className="font-medium text-text">Questions for HR go to</p>
          <PeopleMultiSelect people={view.people} selected={handTo} onChange={setHandTo} label="Who answers what the HR desk passes on" placeholder="Everybody who manages people records — or search…" />
          <p className="text-[11px] text-subtle">With nobody named, everybody who has “Manage people records” is told.</p>
        </div>
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-subtle">
          <li>Each question uses Deskzo AI credits — charged to the person asking, within their daily Deskzo AI limit, and at most 30 questions a day each.</li>
          <li>Questions she answered are kept 90 days; those passed to HR are kept.</li>
        </ul>
        {!view.aiOn && <p className="text-xs text-warning">Deskzo AI is switched off — switch it on above first.</p>}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[
            ["Asked (30 days)", r.asked],
            ["She answered", r.answered],
            ["Passed to HR", r.passed],
            ["HR answered", r.hrAnswered],
            ["Waiting for HR", r.waiting],
          ].map(([label, n]) => (
            <div key={label} className="rounded-base bg-surface-sunken px-2 py-2 text-center">
              <div className="text-base font-semibold tabular-nums text-text">{n}</div>
              <div className="text-[11px] text-muted">{label}</div>
            </div>
          ))}
        </div>
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
