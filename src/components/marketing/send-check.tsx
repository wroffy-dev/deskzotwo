"use client";

import { useState } from "react";
import { Monitor, ShieldCheck, Smartphone } from "lucide-react";
import { EmailFrame } from "@/components/marketing/email-frame";
import { checkSpam, inboxSnippet } from "@/lib/marketing/spam-check";
import { cn } from "@/lib/utils";

const RATING = {
  good: { label: "Looks clean", tone: "text-success" },
  fair: { label: "A few things to fix", tone: "text-warning" },
  poor: { label: "Likely to land in spam", tone: "text-danger" },
} as const;

const LEVEL_DOT = { high: "bg-danger", medium: "bg-warning", low: "bg-subtle" } as const;

/**
 * The last look before a campaign goes (owner, 1 Nov 2026): how it sits in an inbox and reads on a desktop or a phone,
 * and what a spam filter would hold against it. Worked out in the browser from the email itself — nothing is sent.
 */
export function SendCheck({ subject, html }: { subject: string | null; html: string }) {
  const [device, setDevice] = useState<"desktop" | "mobile">("desktop");
  const verdict = checkSpam({ subject, html });
  const mobile = device === "mobile";
  const shortSubject = subject && mobile && subject.length > 40 ? `${subject.slice(0, 39).trimEnd()}…` : subject;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-xs font-semibold text-muted">How it arrives</p>
        <div className="inline-flex rounded-md border border-line p-0.5" role="group" aria-label="Preview on">
          {(["desktop", "mobile"] as const).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={device === d}
              onClick={() => setDevice(d)}
              className={cn("inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px]", device === d ? "bg-surface-sunken font-medium text-text" : "text-subtle")}
            >
              {d === "desktop" ? <Monitor className="h-3 w-3" /> : <Smartphone className="h-3 w-3" />}
              {d === "desktop" ? "Desktop" : "Phone"}
            </button>
          ))}
        </div>
      </div>

      <div className={cn("mx-auto space-y-2", mobile ? "max-w-[375px]" : "w-full")}>
        <div className="rounded-lg border border-line bg-surface px-3 py-2">
          <p className="text-[10px] uppercase tracking-wide text-subtle">In the inbox</p>
          <p className={cn("truncate text-sm font-semibold text-text", !subject && "italic text-danger")}>{shortSubject || "No subject"}</p>
          <p className="truncate text-xs text-muted">{inboxSnippet(html, mobile ? 70 : 110)}</p>
        </div>
        <EmailFrame html={html} title="The email" height={mobile ? 620 : 480} />
      </div>

      <div className="rounded-lg border border-line p-3">
        <p className="flex items-center gap-1.5 text-xs font-semibold">
          <ShieldCheck className={cn("h-3.5 w-3.5", RATING[verdict.rating].tone)} />
          <span className={RATING[verdict.rating].tone}>Spam check: {RATING[verdict.rating].label}</span>
        </p>
        {verdict.findings.length ? (
          <ul className="mt-2 space-y-1">
            {verdict.findings.map((f) => (
              <li key={f.message} className="flex gap-2 text-[11px] text-muted">
                <span className={cn("mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full", LEVEL_DOT[f.level])} />
                {f.message}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mt-1 text-[11px] text-muted">Nothing a filter usually holds against an email.</p>
        )}
        <p className="mt-2 text-[10px] text-subtle">A guide, not a promise — no mail provider publishes its rules. The sending domain&apos;s set-up matters as much.</p>
      </div>
    </div>
  );
}
