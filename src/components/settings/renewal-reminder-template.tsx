"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useTransition } from "react";
import { setRenewalReminderTemplate } from "@/actions/auto-notice-template";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Label, Select } from "@/components/ui/input";
import type { TemplateOption } from "@/lib/marketing/auto-notice-template";

const BUILT_IN = "";

/**
 * Settings › Renewals: the email the automatic renewal reminder goes in (owner, 13 Nov 2026 —
 * src/lib/marketing/auto-notice-template.ts). Saved as soon as it's chosen.
 */
export function RenewalReminderTemplate({ chosen, options }: { chosen: string | null; options: TemplateOption[] }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [value, setValue] = useState(chosen ?? BUILT_IN);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  // One chosen earlier and since switched off, deleted or moved off the Renewals topic: the reminder goes in the
  // built-in wording, and the page says so.
  const gone = !!chosen && !options.some((o) => o.id === chosen);

  const choose = (next: string) => {
    const before = value;
    setValue(next);
    setError(null);
    setSaved(false);
    start(async () => {
      const r = await setRenewalReminderTemplate(next || null);
      if (!r.ok) {
        setValue(before);
        setError(r.error);
        return;
      }
      setSaved(true);
      router.refresh();
    });
  };

  return (
    <Card className="mb-4">
      <CardHeader className="text-sm font-medium text-text">The reminder email</CardHeader>
      <CardContent className="space-y-2 text-sm">
        <p className="text-muted">
          The email the customer gets by itself before their subscription ends. Someone sending a reminder by hand still picks the wording each time.
        </p>
        <div className="space-y-1.5">
          <Label htmlFor="renewal-reminder-template">Send it in</Label>
          <Select id="renewal-reminder-template" value={gone ? BUILT_IN : value} disabled={pending} onChange={(e) => choose(e.target.value)} className="max-w-md">
            <option value={BUILT_IN}>The built-in wording</option>
            {options.map((o) => (
              <option key={o.id} value={o.id}>
                {o.name}
                {o.designed ? " (designed)" : ""}
              </option>
            ))}
          </Select>
        </div>
        <p className="text-xs text-subtle">
          Listed: email templates on the Renewals topic that are switched on, made in{" "}
          <Link href="/marketing/templates" className="text-brand hover:underline">
            Marketing › Templates
          </Link>
          . Use {"{{productName}}"}, {"{{expiryDate}}"} and {"{{subscriptions}}"} in it for the subscription, its date and, when several renew the same day, the list of them.
        </p>
        {gone && <p className="text-xs text-warning">The template chosen earlier can&apos;t be used any more, so reminders go in the built-in wording until you choose another.</p>}
        {options.length === 0 && <p className="text-xs text-subtle">No email template on the Renewals topic yet, so reminders go in the built-in wording.</p>}
        {saved && !pending && <p className="text-xs text-success">Saved. The next reminder goes in it.</p>}
        {error && <p className="text-xs text-danger">{error}</p>}
      </CardContent>
    </Card>
  );
}
