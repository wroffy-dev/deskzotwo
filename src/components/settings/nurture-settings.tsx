"use client";

import { useState, useTransition } from "react";
import { Mail } from "lucide-react";
import { saveNurtureSettings, type NurtureSettingsView } from "@/actions/nurture";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/**
 * Settings › Deskzo AI: nurturing leads (owner, 18 Nov 2026 — phase 3, src/lib/nurture). Off until an admin switches it
 * on; then a salesperson may let Deskzo AI follow a lead up, and sends every email themselves. The last 30 days below.
 */
export function NurtureSettings({ settings }: { settings: NurtureSettingsView }) {
  const [on, setOn] = useState(settings.enabled);
  const [perDay, setPerDay] = useState(String(settings.perDay));
  const [autoStart, setAutoStart] = useState(settings.autoStart);
  const [bookingLinks, setBookingLinks] = useState(settings.bookingLinks);
  const [view, setView] = useState(settings);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();
  const r = view.report;

  const save = () =>
    start(async () => {
      setError(null);
      setSaved(false);
      const result = await saveNurtureSettings({ enabled: on, perDay: Number(perDay), ...(view.phase4 ? { autoStart, bookingLinks } : {}) });
      if (!result.ok) return setError(result.error);
      setView(result.data);
      setSaved(true);
    });

  return (
    <Card>
      <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
        <Mail className="h-4 w-4 text-brand" aria-hidden="true" />
        Nurture leads with Deskzo AI
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <p className="text-muted">
          A salesperson can let Deskzo AI follow a lead up: four short emails over two weeks, from their own mailbox. Every email waits for them to read,
          change and send — nothing goes by itself. It stops at a reply, a call or meeting they log, or the lead closing, and hands the lead back.
        </p>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} disabled={!view.aiOn && !on} />
          Let salespeople have Deskzo AI nurture their leads
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <Label htmlFor="nurture-per-day" className="text-muted">
            At most
          </Label>
          <Input id="nurture-per-day" type="number" min={1} max={500} value={perDay} onChange={(e) => setPerDay(e.target.value)} className="w-24" />
          <span className="text-muted">emails drafted a day, across the workspace.</span>
        </div>
        {view.phase4 && (
          <div className="space-y-2 rounded-base border border-line p-3">
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={autoStart} onChange={(e) => setAutoStart(e.target.checked)} disabled={!on} />
              <span>
                Start by itself on hot and warm leads
                <span className="block text-xs text-subtle">
                  New leads Deskzo AI researches and plans by itself (above) and reads as hot or warm are nurtured without anybody pressing the button — only those planned
                  from now on. Every email still waits for the lead&apos;s owner.
                </span>
              </span>
            </label>
            <label className="flex items-start gap-2">
              <input type="checkbox" className="mt-1" checked={bookingLinks} onChange={(e) => setBookingLinks(e.target.checked)} />
              <span>
                Add the owner&apos;s booking link to each email
                <span className="block text-xs text-subtle">
                  Their booking page (Calendar › Booking pages), tied to the lead: a time booked from it lands on that lead and ends the nurture with a task to get ready.
                </span>
              </span>
            </label>
          </div>
        )}
        <ul className="list-disc space-y-0.5 pl-5 text-xs text-subtle">
          <li>Each email after the first is written by Deskzo AI and uses its credits; the first is the lead&apos;s Research &amp; plan draft.</li>
          <li>Sent emails count toward the most a customer gets in 24 hours (Settings › Customer emails), and skip anybody who opted out or bounced.</li>
          <li>Replies come to a Deskzo address on the email and are forwarded to the salesperson at once, with a task.</li>
          {view.phase4 && (
            <>
              <li>Deskzo AI reads each reply: someone asking to stop is unsubscribed at once; “not now, try in March” pauses it until then; an out-of-office moves the next email after they&apos;re back; the rest are handed back with an answer drafted.</li>
              <li>An approved email goes in working hours — Monday to Friday, 9 to 5 on the workspace&apos;s clock — or at 10 the next working morning. &ldquo;Send now&rdquo; is always there.</li>
            </>
          )}
        </ul>
        {!view.aiOn && <p className="text-xs text-warning">Deskzo AI is switched off — switch it on above first.</p>}
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
          {[
            ["Nurturing now", r.active],
            ["Started (30 days)", r.nurtured],
            ["Emails sent", r.sent],
            ["Replies", r.replied],
            ["No reply", r.noReply],
          ].map(([label, n]) => (
            <div key={label} className="rounded-base bg-surface-sunken px-2 py-2 text-center">
              <div className="text-base font-semibold tabular-nums text-text">{n}</div>
              <div className="text-[11px] text-muted">{label}</div>
            </div>
          ))}
        </div>
        {view.enabled && <p className="text-xs text-muted">{view.draftedToday} drafted today of {view.perDay}.</p>}
        {r.sent > 0 && (
          <div className="grid gap-3 text-xs sm:grid-cols-2">
            <table className="w-full">
              <caption className="pb-1 text-left text-subtle">Replies by email, 30 days</caption>
              <tbody>
                {r.bySteps.map((s) => (
                  <tr key={s.step} className="border-t border-line">
                    <td className="py-1 text-muted">Email {s.step + 1}</td>
                    <td className="py-1 text-right tabular-nums text-text">
                      {s.replies} of {s.sent}
                      {s.sent ? ` · ${Math.round((s.replies / s.sent) * 100)}%` : ""}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <table className="w-full">
              <caption className="pb-1 text-left text-subtle">By salesperson — replies, emails sent</caption>
              <tbody>
                {r.byOwner.slice(0, 8).map((o) => (
                  <tr key={o.name} className="border-t border-line">
                    <td className="py-1 text-muted">{o.name}</td>
                    <td className="py-1 text-right tabular-nums text-text">
                      {o.replies} · {o.sent}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
