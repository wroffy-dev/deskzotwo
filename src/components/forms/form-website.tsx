"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Copy, ExternalLink } from "lucide-react";
import { saveFormWebsite } from "@/actions/form-website";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Input, Label, Select, Textarea } from "@/components/ui/input";
import { ActionNotice } from "@/components/ui/action-notice";
import { WEBSITE_LIMITS, type LandingSettings, type PopupSettings } from "@/lib/forms/website-rules";

/**
 * A form's "On your website" tab (owner, 1 Nov 2026 — src/lib/forms/website-rules.ts): a pop-up shown on the business's
 * own site by a line of script — when, where, how often — and the landing page its public address becomes.
 */
export function FormWebsite({ formId, initial }: { formId: string; initial: { popup: PopupSettings; landing: LandingSettings; snippet: string; pageUrl: string; canEdit: boolean } }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [popup, setPopup] = useState(initial.popup);
  const [landing, setLanding] = useState({ ...initial.landing, highlightsText: initial.landing.highlights.join("\n") });
  const [notice, setNotice] = useState<{ tone: "success" | "error"; text: string } | null>(null);
  const p = <K extends keyof PopupSettings>(k: K, v: PopupSettings[K]) => setPopup((x) => ({ ...x, [k]: v }));
  const disabled = !initial.canEdit;

  const save = () =>
    startTransition(async () => {
      const r = await saveFormWebsite(formId, { popup, landing: { ...landing, highlights: landing.highlightsText.split("\n") } });
      setNotice(r.ok ? { tone: "success", text: "Saved." } : { tone: "error", text: r.error });
      if (r.ok) router.refresh();
    });

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      <Card>
        <CardHeader className="text-sm font-semibold text-text">Pop-up on your website</CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" disabled={disabled} checked={popup.on} onChange={(e) => p("on", e.target.checked)} className="accent-[var(--brand)]" />
            Show this form as a pop-up on your site
          </label>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            Show it
            <Select aria-label="When" disabled={disabled} value={popup.trigger} onChange={(e) => p("trigger", e.target.value as PopupSettings["trigger"])} className="h-8 w-auto text-xs">
              <option value="delay">after some seconds</option>
              <option value="scroll">part way down the page</option>
              <option value="exit">as they go to leave</option>
            </Select>
            {popup.trigger === "delay" && (
              <>
                <Input type="number" aria-label="Seconds" disabled={disabled} min={3} max={120} value={popup.delay} onChange={(e) => p("delay", Number(e.target.value))} className="h-8 w-16" /> seconds in
              </>
            )}
            {popup.trigger === "scroll" && (
              <>
                <Input type="number" aria-label="Percent down the page" disabled={disabled} min={10} max={90} value={popup.scroll} onChange={(e) => p("scroll", Number(e.target.value))} className="h-8 w-16" />% down
              </>
            )}
            {popup.trigger === "exit" && <span>(on a phone, after 30 seconds)</span>}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
            <Select aria-label="Where" disabled={disabled} value={popup.position} onChange={(e) => p("position", e.target.value as PopupSettings["position"])} className="h-8 w-auto text-xs">
              <option value="center">In the middle, page dimmed</option>
              <option value="corner">In the corner</option>
            </Select>
            at most once every
            <Input type="number" aria-label="Days between showings" disabled={disabled} min={1} max={90} value={popup.everyDays} onChange={(e) => p("everyDays", Number(e.target.value))} className="h-8 w-16" /> days to the same visitor.
          </div>
          <div className="space-y-1">
            <Label className="text-xs">Paste this before &lt;/body&gt; on every page of your site</Label>
            <div className="flex items-start gap-2">
              <code className="flex-1 break-all rounded-md border border-line bg-surface-sunken px-2 py-1.5 text-[11px]">{initial.snippet}</code>
              <Button type="button" size="sm" variant="ghost" aria-label="Copy" onClick={() => void navigator.clipboard?.writeText(initial.snippet).then(() => setNotice({ tone: "success", text: "Copied." }))}>
                <Copy className="h-3.5 w-3.5" />
              </Button>
            </div>
            <p className="text-[11px] text-subtle">It shows this form&apos;s own page in a frame — the same fields, checks and email confirmation. Nothing loads until its moment comes.</p>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="text-sm font-semibold text-text">Landing page</CardHeader>
        <CardContent className="space-y-3 text-sm">
          <label className="flex items-center gap-2">
            <input type="checkbox" disabled={disabled} checked={landing.on} onChange={(e) => setLanding((x) => ({ ...x, on: e.target.checked }))} className="accent-[var(--brand)]" />
            Make the form&apos;s page a landing page
          </label>
          <div className="space-y-1">
            <Label htmlFor="lp-image" className="text-xs">
              Picture (an https:// address)
            </Label>
            <Input id="lp-image" disabled={disabled} value={landing.image ?? ""} onChange={(e) => setLanding((x) => ({ ...x, image: e.target.value || null }))} placeholder="https://…/event.jpg" />
          </div>
          <div className="space-y-1">
            <Label htmlFor="lp-highlights" className="text-xs">
              Highlights — one a line, up to {WEBSITE_LIMITS.highlights}
            </Label>
            <Textarea id="lp-highlights" disabled={disabled} rows={4} value={landing.highlightsText} onChange={(e) => setLanding((x) => ({ ...x, highlightsText: e.target.value }))} placeholder={"Live demo of the new release\nQ&A with our product team\nLunch on us"} />
          </div>
          <div className="grid gap-2 sm:grid-cols-[1fr_12rem]">
            <Input aria-label="A quote" disabled={disabled} maxLength={WEBSITE_LIMITS.quote} value={landing.quote ?? ""} onChange={(e) => setLanding((x) => ({ ...x, quote: e.target.value || null }))} placeholder="A quote from a customer (optional)" />
            <Input aria-label="Whose quote" disabled={disabled} maxLength={WEBSITE_LIMITS.quoteBy} value={landing.quoteBy ?? ""} onChange={(e) => setLanding((x) => ({ ...x, quoteBy: e.target.value || null }))} placeholder="Who said it" />
          </div>
          <a href={initial.pageUrl} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-xs text-brand hover:underline">
            <ExternalLink className="h-3 w-3" /> Open the page
          </a>
        </CardContent>
      </Card>

      <div className="flex items-center gap-3 lg:col-span-2">
        {initial.canEdit && (
          <Button type="button" size="sm" disabled={pending} onClick={save}>
            {pending ? "Saving…" : "Save"}
          </Button>
        )}
        {notice && <ActionNotice tone={notice.tone}>{notice.text}</ActionNotice>}
      </div>
    </div>
  );
}
