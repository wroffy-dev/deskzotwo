"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { ShieldAlert } from "lucide-react";
import { setCustomerMailLimit } from "@/actions/customer-emails";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Button } from "@/components/ui/button";

/**
 * Settings › Customer emails: the most emails one customer gets in 24 hours (owner, 13 Nov 2026 —
 * src/lib/customer-mail-cap.ts). Kept where mail leaves, so nothing sends past it.
 */
export function CustomerMailLimit({ limit, atLimit }: { limit: number | null; atLimit: { address: string; count: number }[] }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [on, setOn] = useState(limit !== null);
  const [value, setValue] = useState(String(limit ?? 5));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);

  const save = () => {
    setError(null);
    setSaved(false);
    const n = Number(value);
    if (on && (!Number.isInteger(n) || n < 1)) return setError("The limit: a whole number of emails, 1 or more.");
    startTransition(async () => {
      const result = await setCustomerMailLimit({ limit: on ? n : null });
      if (!result.ok) return setError(result.error);
      setSaved(true);
      router.refresh();
    });
  };

  return (
    <Card>
      <CardHeader className="flex items-center gap-2 text-sm font-medium text-text">
        <ShieldAlert className="h-4 w-4" aria-hidden="true" />
        Most renewal, workflow and marketing emails to one customer in 24 hours
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={on} onChange={(e) => setOn(e.target.checked)} />
          Limit how many emails one customer&apos;s address gets in any 24 hours
        </label>
        {on && (
          <div className="flex flex-wrap items-center gap-2">
            <Label htmlFor="customer-mail-limit" className="text-muted">
              At most
            </Label>
            <Input id="customer-mail-limit" type="number" min={1} max={500} value={value} onChange={(e) => setValue(e.target.value)} className="w-24" />
            <span className="text-muted">renewal, workflow and marketing emails to one address in any 24 hours.</span>
          </div>
        )}
        <p className="text-xs text-subtle">
          Renewal, workflow and marketing emails count, together, and none goes past it: renewal reminders and confirmations (by themselves
          or sent by hand), everything a workflow emails, and campaigns and journeys — whether from your mail provider, somebody&apos;s own
          mailbox or Deskzo&apos;s mail. Invoices and other documents, payment reminders, statements, quick messages, helpdesk replies,
          meeting invitations and sign-in codes don&apos;t count and always go. One of the counted emails to or copied to an address
          already at the limit isn&apos;t sent to anybody, and the mail log or the person sending it says why. Blind copies and your own
          people don&apos;t count.
        </p>
        {atLimit.length > 0 && (
          <div className="space-y-1 rounded-base border border-line p-3">
            <p className="font-medium text-text">At the limit now</p>
            <ul className="space-y-0.5 text-muted">
              {atLimit.map((a) => (
                <li key={a.address}>
                  {a.address} — {a.count} in the last 24 hours
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <p className="text-danger">{error}</p>}
        <div className="flex items-center gap-3">
          <Button size="sm" disabled={pending} onClick={save}>
            Save
          </Button>
          {saved && <span className="text-xs text-success">Saved.</span>}
        </div>
      </CardContent>
    </Card>
  );
}
