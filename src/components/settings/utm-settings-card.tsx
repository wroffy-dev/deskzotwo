"use client";

import { useState, useTransition } from "react";
import { updateUtmSettings } from "@/actions/marketing-utm";
import { tagUrl, type UtmSettings } from "@/lib/marketing/utm";
import { Card, CardContent, CardHeader } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input, Label } from "@/components/ui/input";

/**
 * Settings › Mail & messaging › Link tracking (owner, 1 Nov 2026): UTM tags on the links in every campaign, journey
 * and workflow email (src/lib/marketing/utm.ts), with an example of a link as it will go out.
 */
export function UtmSettingsCard({ initial }: { initial: UtmSettings }) {
  const [on, setOn] = useState(initial.on);
  const [source, setSource] = useState(initial.source);
  const [ownSitesOnly, setOwnSitesOnly] = useState(initial.ownSitesOnly);
  const [domains, setDomains] = useState(initial.domains.join(", "));
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const [pending, start] = useTransition();

  const example = tagUrl(`https://${initial.domains[0] ?? "www.example.com"}/microsoft-365`, { on: true, source: source || "deskzo", ownSitesOnly: false, domains: [] }, { campaign: "M365 renewal — Nov 2026", content: "Subscription renewal notice" });
  const changed = () => (setSaved(false), setError(null));

  return (
    <Card>
      <CardHeader className="text-sm font-medium text-text">Link tracking (UTM)</CardHeader>
      <CardContent className="space-y-4">
        <label className="flex cursor-pointer items-start gap-2.5">
          <input type="checkbox" checked={on} onChange={(e) => (setOn(e.target.checked), changed())} className="mt-0.5 h-4 w-4 accent-brand" />
          <span>
            <span className="block text-sm text-text">Tag the links in our emails</span>
            <span className="block text-xs text-subtle">
              Campaigns, journeys and workflow emails. Your website&apos;s analytics then shows each visit as coming from that email, and a form filled in on
              the visit brings the tags to the lead — so a campaign&apos;s report counts the leads it brought.
            </span>
          </span>
        </label>
        {on && (
          <>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label htmlFor="utmSource">Source (utm_source)</Label>
                <Input id="utmSource" value={source} onChange={(e) => (setSource(e.target.value), changed())} placeholder="deskzo" />
                <p className="text-xs text-subtle">The medium is always &ldquo;email&rdquo;; the campaign and content are each email&apos;s own.</p>
              </div>
            </div>
            <label className="flex cursor-pointer items-start gap-2.5">
              <input type="checkbox" checked={ownSitesOnly} onChange={(e) => (setOwnSitesOnly(e.target.checked), changed())} className="mt-0.5 h-4 w-4 accent-brand" />
              <span>
                <span className="block text-sm text-text">Only links to our own websites</span>
                <span className="block text-xs text-subtle">Leave links to other sites — Microsoft, a partner, a news story — as they are.</span>
              </span>
            </label>
            {ownSitesOnly && (
              <div className="space-y-1.5">
                <Label htmlFor="utmDomains">Our websites</Label>
                <Input id="utmDomains" value={domains} onChange={(e) => (setDomains(e.target.value), changed())} placeholder="wroffy.com, shop.wroffy.com" />
                <p className="text-xs text-subtle">Separated by commas. A site&apos;s subdomains count too.</p>
              </div>
            )}
            <div className="rounded-base bg-surface-sunken px-3 py-2">
              <p className="text-[11px] font-medium uppercase tracking-wide text-subtle">A link as it goes out</p>
              <p className="mt-1 break-all font-mono text-xs text-text">{example}</p>
            </div>
            <p className="text-xs text-subtle">A tag a link already has is kept. Email, phone and unsubscribe links are never tagged.</p>
          </>
        )}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div className="flex items-center gap-3">
          <Button
            disabled={pending}
            onClick={() =>
              start(async () => {
                const result = await updateUtmSettings({ on, source, ownSitesOnly, domains });
                if (!result.ok) return setError(result.error);
                setSource(result.data.source);
                setDomains(result.data.domains.join(", "));
                setSaved(true);
              })
            }
          >
            {pending ? "Saving…" : "Save"}
          </Button>
          {saved && <span className="text-xs text-success">Saved.</span>}
        </div>
      </CardContent>
    </Card>
  );
}
