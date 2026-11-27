"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { saveRenewalSettings } from "@/actions/renewal-settings";
import type { RenewalConfig } from "@/lib/renewal-lapse";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { PersonCombobox, type PersonOption } from "@/components/ui/person-combobox";
import { X } from "lucide-react";

/**
 * Settings › Renewals: what happens to a subscription nobody renewed (owner, 26 Oct 2026 — src/lib/renewal-lapse.ts),
 * and who is reminded and told before it ends (30 Oct 2026 — src/lib/renewal-watch-rules.ts). One Save for both.
 */
export function RenewalSettings({ config, people }: { config: RenewalConfig; people: PersonOption[] }) {
  const router = useRouter();
  const [on, setOn] = useState(config.lapseLostAfterDays !== null);
  const [days, setDays] = useState(String(config.lapseLostAfterDays ?? 15));
  const watch = config.watch;
  const [reminders, setReminders] = useState(watch.reminderDays.join(", "));
  const [managerOn, setManagerOn] = useState(watch.escalateManagerDays !== null);
  const [managerDays, setManagerDays] = useState(String(watch.escalateManagerDays ?? 15));
  const [adminOn, setAdminOn] = useState(watch.escalateAdminDays !== null);
  const [adminDays, setAdminDays] = useState(String(watch.escalateAdminDays ?? 7));
  const [taskOn, setTaskOn] = useState(watch.taskLeadDays !== null);
  const [taskDays, setTaskDays] = useState(String(watch.taskLeadDays ?? 45));
  const [weekly, setWeekly] = useState(watch.weeklyList);
  // Copied on those reminders' emails (owner, 23 Nov 2026 — src/lib/renewal-team-copies.ts).
  const [teamCcText, setTeamCcText] = useState(config.teamCopies.emails.join(", "));
  // Who hears about a renewal nobody looks after (owner, 30 Oct 2026); none chosen, every admin.
  // The renewal reminder the customer gets by itself (owner, 30 Oct 2026); off until days are set.
  const [customerOn, setCustomerOn] = useState(config.customerReminderDays.length > 0);
  const [ccManager, setCcManager] = useState(config.customerCopies.manager);
  const [ccText, setCcText] = useState(config.customerCopies.emails.join(", "));
  const [customerDays, setCustomerDays] = useState((config.customerReminderDays.length ? config.customerReminderDays : [30, 7]).join(", "));
  const [nobody, setNobody] = useState<string[]>(config.nobodyRecipientIds.filter((id) => people.some((p) => p.id === id)));
  const [pending, startTransition] = useTransition();
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  if (!config.migrated) return <p className="text-sm text-muted">This workspace is still being updated for renewals. Come back in a few minutes.</p>;

  function save() {
    setError(null);
    setSaved(false);
    const ladder = reminders
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (ladder.some((n) => !Number.isInteger(n))) return setError("Reminders: whole days, separated by commas — say 60, 30, 15, 7, 1.");
    const customerLadder = customerDays
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number);
    if (customerOn && (customerLadder.length === 0 || customerLadder.some((n) => !Number.isInteger(n)))) return setError("Customer reminders: whole days, separated by commas — say 30, 7.");
    const ccEmails = ccText
      .split(/[\s,;]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (ccEmails.some((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) return setError("Copy to: email addresses, separated by commas.");
    const teamCc = teamCcText
      .split(/[\s,;]+/)
      .map((e) => e.trim())
      .filter(Boolean);
    if (teamCc.some((e) => !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e))) return setError("Copy the reminder emails to: email addresses, separated by commas.");
    startTransition(async () => {
      const result = await saveRenewalSettings({
        lapseLostAfterDays: on ? Math.round(Number(days)) : null,
        ...(config.watchMigrated
          ? {
              reminderDays: ladder,
              escalateManagerDays: managerOn ? Math.round(Number(managerDays)) : null,
              escalateAdminDays: adminOn ? Math.round(Number(adminDays)) : null,
              taskLeadDays: taskOn ? Math.round(Number(taskDays)) : null,
              weeklyList: weekly,
            }
          : {}),
        ...(config.nobodyMigrated ? { nobodyRecipientIds: nobody } : {}),
        ...(config.customerMigrated ? { customerReminderDays: customerOn ? customerLadder : [] } : {}),
        ...(config.customerCopies.migrated ? { customerReminderCc: ccEmails, customerReminderCcManager: ccManager } : {}),
        ...(config.watchMigrated && config.teamCopies.migrated ? { teamReminderCc: teamCc } : {}),
      });
      if (!result.ok) return setError(result.error);
      setSaved(true);
      router.refresh();
    });
  }

  const daysField = (id: string, value: string, set: (v: string) => void) => (
    <Input id={id} type="number" min={1} max={365} value={value} onChange={(e) => set(e.target.value)} className="h-8 w-20" />
  );

  return (
    <div className="space-y-4">
      {config.watchMigrated && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Before a subscription ends</CardHeader>
          <CardContent className="space-y-4 text-sm">
            <p className="text-muted">
              A renewal is the customer&apos;s renewal manager&apos;s — else its account manager&apos;s, else, with nobody still here, the
              people chosen below (every admin, until you choose). &quot;Not started&quot; means no call logged against it, no proposal, proforma or invoice for it, not renewed, and
              nobody has marked it Negotiating or On hold.
            </p>
            <div className="space-y-1">
              <Label htmlFor="reminder-days">Remind the renewal manager, days before it ends</Label>
              <Input id="reminder-days" value={reminders} onChange={(e) => setReminders(e.target.value)} placeholder="60, 30, 15, 7, 1" className="w-60" />
              <p className="text-xs text-subtle">In their bell, and by email where Settings › Email notifications sends &quot;A renewal is coming up&quot;. Empty reminds nobody.</p>
            </div>
            {config.teamCopies.migrated && (
              <div className="space-y-1">
                <Label htmlFor="team-cc">Copy (CC) the reminder emails to</Label>
                <Input id="team-cc" value={teamCcText} onChange={(e) => setTeamCcText(e.target.value)} placeholder="renewals@yourcompany.com, saleshead@yourcompany.com" className="max-w-xl" />
                <p className="text-xs text-subtle">
                  Up to ten addresses, separated by commas: people working here, or addresses at your own company&apos;s domain. Each
                  reminder&apos;s email is copied once, however many people it goes to — the ones for renewals nobody looks after too.
                  Not the &quot;not started&quot; emails to managers and admins, or Monday&apos;s list.
                </p>
              </div>
            )}
            <label className="flex flex-wrap items-center gap-2">
              <input type="checkbox" checked={managerOn} onChange={(e) => setManagerOn(e.target.checked)} />
              Tell their manager when it isn&apos;t started
              {managerOn && (
                <>
                  {daysField("escalate-manager", managerDays, setManagerDays)}
                  <span className="text-muted">days before it ends</span>
                </>
              )}
            </label>
            <label className="flex flex-wrap items-center gap-2">
              <input type="checkbox" checked={adminOn} onChange={(e) => setAdminOn(e.target.checked)} />
              Tell the admins when it still isn&apos;t started
              {adminOn && (
                <>
                  {daysField("escalate-admin", adminDays, setAdminDays)}
                  <span className="text-muted">days before it ends</span>
                </>
              )}
            </label>
            <label className="flex flex-wrap items-center gap-2">
              <input type="checkbox" checked={taskOn} onChange={(e) => setTaskOn(e.target.checked)} />
              Raise a renewal task for the renewal manager
              {taskOn && (
                <>
                  {daysField("task-lead", taskDays, setTaskDays)}
                  <span className="text-muted">days before it ends, due a week before the end</span>
                </>
              )}
            </label>
            {config.nobodyMigrated && (
              <div className="space-y-1.5">
                <Label htmlFor="nobody-recipients">Who hears about renewals nobody looks after</Label>
                <p className="text-xs text-subtle">
                  A customer with no renewal manager or account manager still here. Its reminders go to the people chosen here —
                  none chosen, every admin.
                </p>
                {nobody.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    {nobody.map((id) => (
                      <span key={id} className="inline-flex items-center gap-1 rounded-full bg-surface-sunken px-2.5 py-1 text-xs text-text">
                        {people.find((p) => p.id === id)?.name ?? "Someone"}
                        <button type="button" aria-label={`Remove ${people.find((p) => p.id === id)?.name ?? "this person"}`} onClick={() => setNobody(nobody.filter((n) => n !== id))} className="text-muted hover:text-danger">
                          <X className="h-3 w-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
                <div className="max-w-xs">
                  <PersonCombobox
                    id="nobody-recipients"
                    people={people.filter((p) => !nobody.includes(p.id))}
                    value=""
                    placeholder={nobody.length ? "Add someone…" : "Every admin — or choose people…"}
                    onSelect={(p) => p && setNobody([...nobody, p.id])}
                  />
                </div>
              </div>
            )}
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={weekly} onChange={(e) => setWeekly(e.target.checked)} />
              Every Monday, each renewal manager&apos;s list — due in 30 days, not started, lapsed — and each manager&apos;s team&apos;s
            </label>
          </CardContent>
        </Card>
      )}

      {config.customerMigrated && (
        <Card>
          <CardHeader className="text-sm font-medium text-text">Reminding the customer</CardHeader>
          <CardContent className="space-y-3 text-sm">
            <label className="flex items-center gap-2">
              <input type="checkbox" checked={customerOn} onChange={(e) => setCustomerOn(e.target.checked)} />
              Email the customer the renewal reminder by itself
            </label>
            {customerOn && (
              <div className="space-y-1">
                <Label htmlFor="customer-days">Days before it ends</Label>
                <Input id="customer-days" value={customerDays} onChange={(e) => setCustomerDays(e.target.value)} placeholder="30, 7" className="w-40" />
              </div>
            )}
            {customerOn && config.customerCopies.migrated && (
              <div className="space-y-2 rounded-base border border-line p-3">
                <p className="font-medium text-text">Copy (CC)</p>
                <label className="flex items-center gap-2">
                  <input type="checkbox" checked={ccManager} onChange={(e) => setCcManager(e.target.checked)} />
                  The renewal manager — the customer&apos;s own, else its account manager
                </label>
                <div className="space-y-1">
                  <Label htmlFor="customer-cc">Also copy</Label>
                  <Input id="customer-cc" value={ccText} onChange={(e) => setCcText(e.target.value)} placeholder="accounts@yourcompany.com, renewals@yourcompany.com" className="max-w-xl" />
                  <p className="text-xs text-subtle">Up to ten addresses, separated by commas. Each copy arrives once per reminder, however many contacts it goes to.</p>
                </div>
              </div>
            )}
            <p className="text-xs text-subtle">
              To the company&apos;s primary contact and its billing contacts — a purchase manager, or a designation about accounts, finance or
              billing — and the reseller&apos;s, on a reseller&apos;s order. The same reminder Renewals sends by hand, once a step: not when one
              went since, by itself or by somebody. Not for a renewal renewed, Lost or On hold, nor to a contact who unticked renewal
              reminders.
            </p>
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="text-sm font-medium text-text">When a subscription isn&apos;t renewed</CardHeader>
        <CardContent className="space-y-4 text-sm">
          <ul className="list-disc space-y-1 pl-5 text-muted">
            <li>The day after it ends, the account&apos;s owner is told it lapsed.</li>
            <li>Renewals › &quot;Lapsed — not renewed&quot; lists every one ended, not renewed and not marked by anybody.</li>
            <li>Marking a renewal Lost switches its auto-renew off; On hold pauses it. Auto-renew never carries on to the next term by itself.</li>
          </ul>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
            Mark it Lost by itself if still nobody has renewed or marked it
          </label>
          {on && (
            <div className="flex flex-wrap items-center gap-2">
              <Label htmlFor="lapse-days" className="text-muted">
                after
              </Label>
              <Input id="lapse-days" type="number" min={1} max={365} value={days} onChange={(e) => setDays(e.target.value)} className="w-24" />
              <span className="text-muted">days from its end — as &quot;Lapsed — not renewed&quot;, its owner and their manager told.</span>
            </div>
          )}
          <p className="text-xs text-subtle">A renewal somebody has marked — Negotiating, On hold — is theirs to decide, and is never marked Lost by this.</p>
        </CardContent>
      </Card>

      {error && <p role="alert" className="text-sm text-danger">{error}</p>}
      {saved && <p role="status" className="text-sm text-success">Saved.</p>}
      <Button size="sm" disabled={pending} onClick={save}>
        {pending ? "Saving…" : "Save"}
      </Button>
    </div>
  );
}
