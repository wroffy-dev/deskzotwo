"use client";

import { useState, useTransition } from "react";
import { saveSunset } from "@/actions/marketing-policy";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ActionNotice } from "@/components/ui/action-notice";

/** Settings › Mail & messaging: the sunset rule (owner, 1 Nov 2026 — src/lib/marketing/policy.ts). */
export function SunsetSetting({ initial }: { initial: number | null }) {
  const [days, setDays] = useState(initial ? String(initial) : "");
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Stop mailing people who never open</CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Sunset rule"
            value={days}
            disabled={pending}
            onChange={(e) => {
              const next = e.target.value;
              setDays(next);
              startTransition(async () => {
                const r = await saveSunset(next ? Number(next) : null);
                setNotice(r.ok ? { tone: "success", text: "Saved." } : { tone: "error", text: r.error });
              });
            }}
            className="h-8 rounded-md border border-line-strong bg-surface px-2 text-sm"
          >
            <option value="">Off — keep mailing everybody who can be</option>
            <option value="90">Sent 3+ in 90 days, opened none</option>
            <option value="180">Sent 3+ in 180 days, opened none</option>
            <option value="365">Sent 3+ in a year, opened none</option>
          </select>
          {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
        </div>
        <p className="text-xs text-subtle">
          Mailbox providers judge a sender by how many people ignore it. Those people are held back from campaigns and journeys — never from their own invoices or
          reminders — and come back the moment they open or click anything.
        </p>
      </CardContent>
    </Card>
  );
}
