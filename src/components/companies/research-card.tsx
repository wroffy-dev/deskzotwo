"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { RefreshCw, Sparkles } from "lucide-react";
import { refreshCompanyResearch, writeCompanyBrief } from "@/actions/research";
import { Button } from "@/components/ui/button";
import { Badge, Card, CardContent, CardHeader } from "@/components/ui/card";
import { formatCalendarDay } from "@/lib/time/zone";
import type { ResearchCard as ResearchCardData } from "@/lib/research/view";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";
import { LiveSteps, announceTeammateWork } from "@/components/ai/teammate-live";
import { BRIEF_STEPS } from "@/lib/ai/teammate-steps";
import { workspacePack } from "@/lib/country-pack";

/**
 * Research on a company from free public sources (owner, 18 Nov 2026 — src/lib/research): its website, GST registrations
 * and the news, with Domain Intel's and Apollo's findings beside them, each saying where it came from. Refresh gathers
 * (free); "Write a brief" has Deskzo AI write it up, on the workspace's credits — a separate button, so the card itself
 * never spends any.
 */

const SOCIAL_LABELS: Record<string, string> = { linkedin: "LinkedIn", x: "X", facebook: "Facebook", instagram: "Instagram", youtube: "YouTube" };

function Source({ children }: { children: React.ReactNode }) {
  return <span className="ml-1 text-[11px] text-subtle">{children}</span>;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex gap-3 text-sm">
      <span className="w-28 shrink-0 text-muted">{label}</span>
      <span className="min-w-0 flex-1 text-text">{children}</span>
    </div>
  );
}

const linkClass = "text-brand hover:underline";

export function ResearchCard({ companyId, data }: { companyId: string; data: ResearchCardData }) {
  const router = useRouter();
  const [pending, start] = useTransition();
  const [busy, setBusy] = useState<"refresh" | "brief" | null>(null);
  const ved = useTeammate("ved");
  const [error, setError] = useState<string | null>(null);
  const { facts, domain, apollo } = data;
  const w = facts.website;
  const gst = facts.gst ?? [];
  const news = facts.news ?? [];
  const india = workspacePack().india;
  const nothing = !w && gst.length === 0 && news.length === 0 && !domain && !apollo;

  const run = (kind: "refresh" | "brief") =>
    start(async () => {
      setBusy(kind);
      setError(null);
      if (kind === "brief") announceTeammateWork();
      const r = kind === "refresh" ? await refreshCompanyResearch(companyId) : await writeCompanyBrief(companyId);
      setBusy(null);
      if (!r.ok) return setError(r.error);
      router.refresh();
    });

  return (
    <Card>
      <CardHeader className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-start gap-2">
          {/* Ved, the researcher (src/lib/ai/teammates.ts). */}
          <TeammateAvatar teammate="ved" size="sm" className="mt-0.5" />
          <div>
          <div className="text-sm font-medium text-text">
            Research <span className="font-normal text-muted">· {ved.name}</span>
          </div>
          <div className="mt-0.5 text-xs text-muted">
            From public sources — its website,{india ? " GST" : ""} and the news{data.refreshedAt ? `, gathered ${formatCalendarDay(data.refreshedAt)}` : ""}. Free to refresh.
          </div>
          </div>
        </div>
        <div className="flex gap-2">
          <Button type="button" size="sm" variant="secondary" disabled={pending} onClick={() => run("refresh")}>
            <RefreshCw className={`h-3.5 w-3.5 ${busy === "refresh" ? "animate-spin" : ""}`} aria-hidden="true" />
            {busy === "refresh" ? "Gathering…" : data.refreshedAt ? "Refresh" : "Gather"}
          </Button>
          {data.mayBrief && (
            <Button type="button" size="sm" disabled={pending} onClick={() => run("brief")} title="Deskzo AI writes it up from what was found — uses a few credits">
              <Sparkles className="h-3.5 w-3.5" aria-hidden="true" />
              {busy === "brief" ? "Writing…" : data.brief ? "Write again" : "Write a brief"}
            </Button>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Ved's own steps as the brief is written (src/components/ai/teammate-live.tsx). */}
        <LiveSteps teammate="ved" subject={`company:${companyId}`} active={busy === "brief"} fallback={BRIEF_STEPS} />
        {error && (
          <p role="alert" className="text-xs text-danger">
            {error}
          </p>
        )}

        {data.brief && (
          <div className="rounded-base border border-line bg-surface-sunken px-3 py-2.5">
            <p className="whitespace-pre-line text-sm text-text">{data.brief}</p>
            <p className="mt-2 text-[11px] text-subtle">
              Written by Deskzo AI{data.briefAt ? ` on ${formatCalendarDay(data.briefAt)}` : ""} from the findings below. Check a line&apos;s source before you quote it.
            </p>
          </div>
        )}

        {nothing && <p className="text-sm text-muted">Nothing gathered yet. Gather reads its website,{india ? " its GST registration" : ""} and the last year&apos;s news — free.</p>}

        {w && (
          <section className="space-y-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Website</h3>
            {(w.description || w.title) && <p className="text-sm text-text">{w.description ?? w.title}</p>}
            {w.about && (
              <p className="text-sm text-muted">
                {w.about}
                {w.aboutUrl && (
                  <a href={w.aboutUrl} target="_blank" rel="noreferrer noopener" className={`ml-1 ${linkClass}`}>
                    About page
                  </a>
                )}
              </p>
            )}
            {w.founded && <Row label="Founded">{w.founded}</Row>}
            {w.careersUrl && (
              <Row label="Hiring">
                <a href={w.careersUrl} target="_blank" rel="noreferrer noopener" className={linkClass}>
                  Has a careers page
                </a>
              </Row>
            )}
            {w.phones.length > 0 && <Row label="Phone">{w.phones.join(" · ")}</Row>}
            {w.emails.length > 0 && <Row label="Email">{w.emails.join(" · ")}</Row>}
            {Object.keys(w.social).length > 0 && (
              <Row label="Social">
                {Object.entries(w.social).map(([k, url], i) => (
                  <span key={k}>
                    {i > 0 && " · "}
                    <a href={url} target="_blank" rel="noreferrer noopener" className={linkClass}>
                      {SOCIAL_LABELS[k] ?? k}
                    </a>
                  </span>
                ))}
              </Row>
            )}
          </section>
        )}
        {facts.websiteError && !w && <p className="text-xs text-muted">Website: {facts.websiteError}</p>}

        {gst.length > 0 && (
          <section className="space-y-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted">GST</h3>
            {gst.map((g) => (
              <div key={g.gstin} className="text-sm">
                <span className="font-mono text-text">{g.gstin}</span>{" "}
                <Badge tone={g.status === "Active" ? "green" : g.status === "Not checked" ? "default" : "red"}>{g.status}</Badge>
                <div className="text-xs text-muted">
                  {[g.legalName, g.tradeName && g.tradeName !== g.legalName ? `trading as ${g.tradeName}` : null, g.panHolder, g.taxpayerType, g.state].filter(Boolean).join(" · ")}
                  <Source>GST, {formatCalendarDay(g.checkedAt)}</Source>
                </div>
              </div>
            ))}
          </section>
        )}
        {facts.gstNote && <p className="text-xs text-muted">GST: {facts.gstNote}</p>}

        {domain && (
          <section className="space-y-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted">What they run</h3>
            {domain.emailProvider && (
              <Row label="Email">
                {domain.emailProvider}
                {domain.emailSecurityProvider ? `, behind ${domain.emailSecurityProvider}` : ""}
              </Row>
            )}
            {(domain.platform || domain.hostProvider) && <Row label="Website">{[domain.platform && `built on ${domain.platform}`, domain.hostProvider && `hosted on ${domain.hostProvider}`].filter(Boolean).join(", ")}</Row>}
            {domain.registeredOn && <Row label="Domain since">{domain.registeredOn.slice(0, 4)}</Row>}
            <p className="text-[11px] text-subtle">From Domain Intel{domain.fetchedAt ? `, ${formatCalendarDay(domain.fetchedAt)}` : ""}.</p>
          </section>
        )}

        {apollo && (apollo.industry || apollo.employees || apollo.revenue || apollo.founded) && (
          <section className="space-y-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted">Size</h3>
            {apollo.industry && <Row label="Industry">{apollo.industry}</Row>}
            {apollo.employees ? <Row label="Employees">{apollo.employees.toLocaleString("en-IN")}</Row> : null}
            {apollo.revenue && <Row label="Revenue">{apollo.revenue}</Row>}
            {apollo.founded ? <Row label="Founded">{apollo.founded}</Row> : null}
            <p className="text-[11px] text-subtle">From Apollo, {formatCalendarDay(apollo.at)} — an earlier lookup, no credits spent here.</p>
          </section>
        )}

        {news.length > 0 && (
          <section className="space-y-1.5">
            <h3 className="text-xs font-medium uppercase tracking-wide text-muted">In the news</h3>
            <ul className="space-y-1">
              {news.map((n) => (
                <li key={n.url} className="text-sm">
                  <a href={n.url} target="_blank" rel="noreferrer noopener" className={linkClass}>
                    {n.title}
                  </a>
                  <Source>
                    {[n.source, n.date ? formatCalendarDay(n.date) : null].filter(Boolean).join(", ")}
                  </Source>
                </li>
              ))}
            </ul>
            <p className="text-[11px] text-subtle">News found by name — check it&apos;s about this company before you mention it.</p>
          </section>
        )}
        {facts.newsError && <p className="text-xs text-muted">News: {facts.newsError}</p>}
      </CardContent>
    </Card>
  );
}
