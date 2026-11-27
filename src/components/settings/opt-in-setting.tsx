"use client";

import { useState, useTransition } from "react";
import { saveRequireOptIn } from "@/actions/marketing-policy";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { ActionNotice } from "@/components/ui/action-notice";

/** Settings › Mail & messaging: whether marketing asks for an opt-in (owner, 2 Nov 2026 — src/lib/marketing/policy.ts). */
export function OptInSetting({ initial }: { initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [pending, startTransition] = useTransition();
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Who marketing goes to</CardHeader>
      <CardContent className="space-y-2 text-sm">
        <div className="flex flex-wrap items-center gap-2">
          <select
            aria-label="Opt-in rule"
            value={on ? "optin" : "all"}
            disabled={pending}
            onChange={(e) => {
              const next = e.target.value === "optin";
              setOn(next);
              startTransition(async () => {
                const r = await saveRequireOptIn(next);
                setNotice(r.ok ? { tone: "success", text: "Saved." } : { tone: "error", text: r.error });
              });
            }}
            className="h-8 rounded-md border border-line-strong bg-surface px-2 text-sm"
          >
            <option value="all">Everybody who hasn&apos;t opted out</option>
            <option value="optin">Only people who opted in to the topic</option>
          </select>
          {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
        </div>
        <p className="text-xs text-subtle">
          Whichever you choose, anybody who unsubscribed or unticked a topic is never sent marketing on it, and every campaign carries an unsubscribe link.
          Turn on opt-in for contacts in the EU or the UK, where the law asks for it before marketing email.
        </p>
      </CardContent>
    </Card>
  );
}
