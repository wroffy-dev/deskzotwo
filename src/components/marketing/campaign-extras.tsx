"use client";

import { Clock3, FlaskConical, Repeat } from "lucide-react";
import { Input, Label, Select } from "@/components/ui/input";
import { AB_LIMITS } from "@/lib/marketing/campaign-option-rules";

export type Extras = {
  ab: boolean;
  test: "subject" | "template";
  subjectB: string;
  templateBId: string;
  percent: number;
  metric: "opens" | "clicks";
  hours: number;
  resend: boolean;
  resendSubject: string;
  resendDays: number;
  bestTime: boolean;
};

export const NO_EXTRAS: Extras = { ab: false, test: "subject", subjectB: "", templateBId: "", percent: 20, metric: "opens", hours: 4, resend: false, resendSubject: "", resendDays: 3, bestTime: false };

/** What the send action takes from these (src/actions/marketing.ts `sendMassMail`). */
export function extrasPayload(e: Extras) {
  return {
    abTest: e.ab ? { test: e.test, subjectB: e.subjectB, templateBId: e.templateBId || null, percent: e.percent, metric: e.metric, hours: e.hours } : null,
    resend: e.resend ? { subject: e.resendSubject, afterHours: e.resendDays * 24 } : null,
    sendTime: e.bestTime ? "best" : null,
  };
}

/**
 * The mass mail's extras (owner, 1 Nov 2026 — src/lib/marketing/campaign-options.ts): an A/B test of two subject lines or
 * two emails on a slice of the audience, the winner then going to the rest; and a resend, with a new subject, to those
 * who don't open.
 */
export function CampaignExtras({ value, onChange, templates, templateId }: { value: Extras; onChange: (next: Extras) => void; templates: { id: string; name: string }[]; templateId: string | null }) {
  const set = <K extends keyof Extras>(k: K, v: Extras[K]) => onChange({ ...value, [k]: v });
  return (
    <div className="space-y-3 rounded-lg border border-line p-3">
      <label className="flex items-center gap-2 text-sm font-medium text-text">
        <input type="checkbox" checked={value.ab} onChange={(e) => set("ab", e.target.checked)} className="accent-[var(--brand)]" />
        <FlaskConical className="h-3.5 w-3.5 text-subtle" aria-hidden /> A/B test it first
      </label>
      {value.ab && (
        <div className="ml-6 space-y-2 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <Select aria-label="What to test" value={value.test} onChange={(e) => set("test", e.target.value as Extras["test"])} className="h-8 w-auto">
              <option value="subject">Two subject lines</option>
              <option value="template">Two different emails</option>
            </Select>
            {value.test === "subject" ? (
              <Input aria-label="Version B's subject line" value={value.subjectB} maxLength={200} onChange={(e) => set("subjectB", e.target.value)} placeholder="Version B's subject line" className="h-8 min-w-[16rem] flex-1" />
            ) : (
              <Select aria-label="Version B's email" value={value.templateBId} onChange={(e) => set("templateBId", e.target.value)} className="h-8 w-auto">
                <option value="">Pick version B…</option>
                {templates
                  .filter((t) => t.id !== templateId)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
              </Select>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            Send to
            <Input type="number" aria-label="Share of the audience in the test" min={AB_LIMITS.minPercent} max={AB_LIMITS.maxPercent} value={value.percent} onChange={(e) => set("percent", Number(e.target.value))} className="h-7 w-16" />
            % first, half each; after
            <Input type="number" aria-label="Hours before the winner is picked" min={AB_LIMITS.minHours} max={AB_LIMITS.maxHours} value={value.hours} onChange={(e) => set("hours", Number(e.target.value))} className="h-7 w-16" />
            hours the one with more
            <Select aria-label="What wins" value={value.metric} onChange={(e) => set("metric", e.target.value as Extras["metric"])} className="h-7 w-auto text-xs">
              <option value="opens">opens</option>
              <option value="clicks">clicks</option>
            </Select>
            goes to everybody else.
          </div>
        </div>
      )}
      <label className="flex items-start gap-2 text-sm font-medium text-text">
        <input type="checkbox" checked={value.bestTime} onChange={(e) => set("bestTime", e.target.checked)} className="mt-1 accent-[var(--brand)]" />
        <span>
          <Clock3 className="mr-1 inline h-3.5 w-3.5 text-subtle" aria-hidden /> Send each person at the hour they usually open
          <span className="block text-xs font-normal text-muted">Within a day of the send time, inside your quiet hours. Anybody who hasn&apos;t opened before gets it at the send time.</span>
        </span>
      </label>
      <label className="flex items-center gap-2 text-sm font-medium text-text">
        <input type="checkbox" checked={value.resend} onChange={(e) => set("resend", e.target.checked)} className="accent-[var(--brand)]" />
        <Repeat className="h-3.5 w-3.5 text-subtle" aria-hidden /> Resend to those who don&apos;t open
      </label>
      {value.resend && (
        <div className="ml-6 space-y-1.5 text-sm">
          <Label htmlFor="mm-resend-subject" className="text-xs">
            With a new subject line
          </Label>
          <Input id="mm-resend-subject" value={value.resendSubject} maxLength={200} onChange={(e) => set("resendSubject", e.target.value)} placeholder="In case you missed it — …" className="h-8" />
          <div className="flex items-center gap-2 text-xs text-muted">
            <Input type="number" aria-label="Days to wait" min={1} max={7} value={value.resendDays} onChange={(e) => set("resendDays", Number(e.target.value))} className="h-7 w-16" />
            days after it goes. Nobody who opened, clicked, unsubscribed or bounced gets it.
          </div>
        </div>
      )}
    </div>
  );
}
