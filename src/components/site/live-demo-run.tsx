"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { ArrowLeft, ArrowRight, Building2, Check, CircleAlert, ExternalLink, LoaderCircle, Mail, ReceiptIndianRupee, Rocket, Search, Workflow } from "lucide-react";
import { liveDemoBusiness, liveDemoProspects, liveDemoTeam } from "@/actions/platform/live-demo";
import type { DemoBusiness, DemoProspect, DemoTeam } from "@/lib/platform/live-demo";
import { computeLine } from "@/lib/gst-engine";
import { formatCurrency } from "@/lib/utils";

/**
 * The live demo's own page, deskzo.com/try/<website> (owner, 22 Nov 2026 — "it should open in a new window just like
 * explee.com and show live things happening on left side bar and right side screen"): the steps down the left, each
 * ticking as it really finishes, and the one being worked on — or the one picked — on the right. The steps are the
 * server's (src/actions/platform/live-demo.ts); nothing here is a timer pretending.
 */

type StepKey = "read" | "setup" | "prospects" | "team" | "start";
type StepState = "waiting" | "working" | "done" | "failed";

const STEPS: { key: StepKey; title: string; working: string; icon: typeof Search }[] = [
  { key: "read", title: "Read your website", working: "Ved is reading your website…", icon: Search },
  { key: "setup", title: "Set up your workspace", working: "Setting Deskzo up for your trade…", icon: Workflow },
  { key: "prospects", title: "Find customers", working: "Ved is looking through this month's news for companies that could buy from you…", icon: Building2 },
  { key: "team", title: "Your AI team at work", working: "Tara is drafting an email and Arjun a quote…", icon: Mail },
  { key: "start", title: "Start", working: "Getting your workspace ready…", icon: Rocket },
];

function signupHref(base: string, b: DemoBusiness | null): string {
  if (!b) return base;
  const sep = base.includes("?") ? "&" : "?";
  return `${base}${sep}${new URLSearchParams({ company: b.name, industry: b.industryKey, website: b.domain }).toString()}`;
}

export function LiveDemoRun({ website, signup }: { website: string; signup: { label: string; href: string } }) {
  const [state, setState] = useState<Record<StepKey, StepState>>({ read: "working", setup: "waiting", prospects: "waiting", team: "waiting", start: "waiting" });
  const [shown, setShown] = useState<StepKey>("read");
  const [picked, setPicked] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [business, setBusiness] = useState<DemoBusiness | null>(null);
  const [prospects, setProspects] = useState<DemoProspect[] | null>(null);
  const [team, setTeam] = useState<DemoTeam | null>(null);
  const started = useRef(false);
  const pickedRef = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    const mark = (key: StepKey, s: StepState) => setState((was) => ({ ...was, [key]: s }));
    // The right side follows the work until the visitor picks a step of their own.
    const follow = (key: StepKey) => {
      if (!pickedRef.current) setShown(key);
    };
    const pause = (ms: number) => new Promise((done) => setTimeout(done, ms));
    void (async () => {
      const b = await liveDemoBusiness({ website, confirm_url: "" }).catch(() => null);
      if (!b?.ok) {
        mark("read", "failed");
        setError(b ? b.error : "That didn't go through — try again.");
        return;
      }
      setBusiness(b.data);
      mark("read", "done");
      // Setting up is the template the read chose: shown as its own step, a beat later, so it reads as one.
      mark("setup", "working");
      follow("setup");
      await pause(900);
      mark("setup", "done");
      mark("prospects", "working");
      follow("prospects");
      const p = await liveDemoProspects(b.data.domain).catch(() => null);
      setProspects(p?.ok ? p.data : []);
      mark("prospects", "done");
      mark("team", "working");
      follow("team");
      const t = await liveDemoTeam(b.data.domain).catch(() => null);
      if (t?.ok) setTeam(t.data);
      mark("team", t?.ok ? "done" : "failed");
      mark("start", "done");
      follow("start");
    })();
  }, [website]);

  const pick = (key: StepKey) => {
    if (state[key] === "waiting") return;
    pickedRef.current = true;
    setPicked(true);
    setShown(key);
  };
  const following = () => {
    pickedRef.current = false;
    setPicked(false);
    const latest = [...STEPS].reverse().find((s) => state[s.key] !== "waiting");
    if (latest) setShown(latest.key);
  };

  const step = STEPS.find((s) => s.key === shown)!;
  const quote = team ? team.products.map((p) => ({ p, c: computeLine({ quantity: 1, unitPrice: p.samplePrice, taxRatePercent: p.taxRate }, "INTRA_STATE") })) : [];

  return (
    <div className="mx-auto grid min-h-[calc(100vh-5rem)] w-full max-w-[90rem] gap-6 px-4 py-6 sm:px-6 lg:grid-cols-[19rem_minmax(0,1fr)] lg:gap-8 lg:px-10 lg:py-8">
      {/* The left: who it is about, and the steps as they tick. */}
      <aside className="space-y-4 lg:sticky lg:top-24 lg:self-start">
        <Link href="/#try" className="inline-flex items-center gap-1.5 text-xs text-muted hover:text-text">
          <ArrowLeft className="h-3.5 w-3.5" aria-hidden="true" /> Try another website
        </Link>
        <div className="rounded-xl border border-line bg-surface p-4">
          <div className="flex items-center gap-3">
            <span className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-brand/10 font-semibold text-brand">{(business?.name ?? website).charAt(0).toUpperCase()}</span>
            <div className="min-w-0">
              <p className="truncate font-medium text-text">{business?.name ?? website}</p>
              <p className="truncate text-xs text-muted">{business ? [business.city, business.industryName].filter(Boolean).join(" · ") : "Reading…"}</p>
            </div>
          </div>
          {business?.line && <p className="mt-3 text-xs leading-5 text-muted">{business.line}</p>}
        </div>
        <ol className="space-y-1" aria-label="What Deskzo is doing">
          {STEPS.map((s, i) => {
            const st = state[s.key];
            const active = s.key === shown;
            return (
              <li key={s.key}>
                <button
                  type="button"
                  onClick={() => pick(s.key)}
                  aria-current={active ? "step" : undefined}
                  className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left text-sm transition-colors ${active ? "bg-surface shadow-sm ring-1 ring-line" : "hover:bg-surface/60"} ${st === "waiting" ? "cursor-default text-subtle" : "text-text"}`}
                >
                  <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-xs ${st === "done" ? "bg-success-bg text-success" : st === "failed" ? "bg-danger-bg text-danger" : st === "working" ? "bg-brand/10 text-brand" : "bg-surface-sunken text-subtle"}`}>
                    {st === "done" ? <Check className="h-3.5 w-3.5" aria-hidden="true" /> : st === "working" ? <LoaderCircle className="h-3.5 w-3.5 animate-spin" aria-hidden="true" /> : st === "failed" ? <CircleAlert className="h-3.5 w-3.5" aria-hidden="true" /> : i + 1}
                  </span>
                  <span className="min-w-0 flex-1">{s.title}</span>
                  <span className="sr-only">{st === "done" ? "done" : st === "working" ? "working" : st === "failed" ? "didn't finish" : "next"}</span>
                </button>
              </li>
            );
          })}
        </ol>
        {picked && (
          <button type="button" onClick={following} className="text-xs text-brand hover:underline">
            Follow along again
          </button>
        )}
      </aside>

      {/* The right: the step being worked on, or the one picked. */}
      <section aria-live="polite" className="min-w-0 rounded-2xl border border-line bg-surface p-6 shadow-sm sm:p-8">
        <p className="text-xs font-medium uppercase tracking-wide text-brand">
          Step {STEPS.findIndex((s) => s.key === shown) + 1} of {STEPS.length}
        </p>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight text-text sm:text-3xl">{shown === "start" && business ? "Your workspace is ready to start" : step.title}</h1>

        {state[shown] === "working" && (
          <div className="mt-6">
            <p className="flex items-center gap-2 text-sm text-muted">
              <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" />
              {step.working}
            </p>
            <div className="mt-6 space-y-3" aria-hidden="true">
              {[80, 64, 72].map((w) => (
                <div key={w} className="h-4 animate-pulse rounded bg-surface-sunken" style={{ width: `${w}%` }} />
              ))}
            </div>
          </div>
        )}

        {shown === "read" && state.read === "failed" && (
          <div className="mt-6 space-y-4">
            <p className="text-sm text-danger">{error}</p>
            <Link href="/#try" className="inline-flex h-10 items-center gap-2 rounded-lg border border-line px-4 text-sm font-medium text-text hover:bg-surface-sunken">
              <ArrowLeft className="h-4 w-4" aria-hidden="true" /> Try again
            </Link>
          </div>
        )}

        {shown === "read" && state.read === "done" && business && (
          <div className="mt-6 space-y-4">
            <p className="text-muted">Ved read {business.domain} and this is what he understood:</p>
            <dl className="grid gap-3 sm:grid-cols-2">
              <Fact label="Business" value={business.name} />
              <Fact label="What you do" value={business.line || "—"} />
              <Fact label="Where" value={business.city ?? "—"} />
              <Fact label="Who buys from you" value={business.buyers} />
            </dl>
            <p className="text-xs text-muted">Read from your public website only. Wrong? You change all of it when you sign up.</p>
          </div>
        )}

        {shown === "setup" && state.setup === "done" && business && (
          <div className="mt-6 space-y-5">
            <p className="text-muted">Deskzo set itself up the way {business.industryName.toLowerCase()} work.</p>
            <div>
              <p className="mb-2 text-xs font-medium text-muted">Your sales pipeline</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {business.stages.map((s, i) => (
                  <div key={s} className={`rounded-lg px-3 py-3 text-sm ${i === business.stages.length - 1 ? "bg-success-bg text-success" : "bg-surface-sunken text-text"}`}>
                    <span className="text-xs text-muted">{i + 1}</span> {s}
                  </div>
                ))}
              </div>
            </div>
            <p className="text-sm text-text">
              On from the start: GST invoicing and books{business.modules.length ? `, ${business.modules.join(", ")}` : ""}, and your AI team.
            </p>
          </div>
        )}

        {shown === "prospects" && state.prospects === "done" && prospects && (
          <div className="mt-6 space-y-4">
            {prospects.length ? (
              <>
                <p className="text-muted">Companies in this month&apos;s news that could buy from you — each with the story it was found in.</p>
                <ul className="divide-y divide-line rounded-xl border border-line">
                  {prospects.map((p) => (
                    <li key={p.name} className="flex items-center gap-3 px-4 py-3">
                      <Building2 className="h-5 w-5 shrink-0 text-muted" aria-hidden="true" />
                      <div className="min-w-0 flex-1">
                        <p className="font-medium text-text">{p.name}</p>
                        <p className="text-sm text-muted">{p.why}</p>
                      </div>
                      <a href={p.url} target="_blank" rel="noopener noreferrer nofollow" className="inline-flex shrink-0 items-center gap-1 text-xs text-muted hover:text-text">
                        {p.source || "news"} <ExternalLink className="h-3 w-3" aria-hidden="true" />
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="text-muted">Nothing in this month&apos;s news fitted well enough to show. In your workspace, Ved finds them from your own best customers.</p>
            )}
          </div>
        )}

        {shown === "team" && state.team === "failed" && <p className="mt-6 text-sm text-muted">Tara and Arjun couldn&apos;t finish just now — in your workspace they draft your emails and quotes every day.</p>}

        {shown === "team" && state.team === "done" && team && (
          <div className="mt-6 grid gap-4 xl:grid-cols-2">
            <div className="rounded-xl border border-line p-4">
              <p className="flex items-center gap-2 text-xs font-medium text-muted">
                <Mail className="h-3.5 w-3.5" aria-hidden="true" /> Tara drafted an email
              </p>
              <p className="mt-3 text-xs text-muted">To {team.email.to}</p>
              <p className="mt-1 font-medium text-text">{team.email.subject}</p>
              <p className="mt-2 whitespace-pre-line text-sm leading-6 text-text">{team.email.body}</p>
              <p className="mt-3 text-xs text-muted">Nothing is sent until you approve it.</p>
            </div>
            <div className="rounded-xl border border-line p-4">
              <p className="flex items-center gap-2 text-xs font-medium text-muted">
                <ReceiptIndianRupee className="h-3.5 w-3.5" aria-hidden="true" /> Arjun made a GST quote
              </p>
              <ul className="mt-3 space-y-1.5 text-sm">
                {quote.map(({ p, c }) => (
                  <li key={p.name} className="flex justify-between gap-2">
                    <span className="text-text">
                      {p.name} × 1 {p.unit}
                    </span>
                    <span className="tabular-nums text-text">{formatCurrency(c.taxableValue)}</span>
                  </li>
                ))}
                <li className="flex justify-between gap-2 text-muted">
                  <span>CGST + SGST</span>
                  <span className="tabular-nums">{formatCurrency(quote.reduce((t, q) => t + q.c.cgstAmount + q.c.sgstAmount, 0))}</span>
                </li>
                <li className="flex justify-between gap-2 border-t border-line pt-1.5 font-medium text-text">
                  <span>Total</span>
                  <span className="tabular-nums">{formatCurrency(quote.reduce((t, q) => t + q.c.lineTotal, 0))}</span>
                </li>
              </ul>
              <p className="mt-3 text-xs text-muted">Sample prices — yours go in when you set up your items.</p>
            </div>
          </div>
        )}

        {shown === "start" && state.start === "done" && business && (
          <div className="mt-6 space-y-5">
            <p className="text-muted">
              Set up for {business.industryName.toLowerCase()}, with {business.name} filled in. Your AI team — Ved, Tara, Arjun and the rest — starts the moment you sign up.
            </p>
            <ul className="space-y-2 text-sm text-text">
              {["Your pipeline, set up for your trade", "GST quotes, invoices and books", "An AI team that researches, follows up and chases payments — you approve what goes out"].map((x) => (
                <li key={x} className="flex gap-2">
                  <Check className="mt-0.5 h-4 w-4 shrink-0 text-success" aria-hidden="true" />
                  {x}
                </li>
              ))}
            </ul>
            <a href={signupHref(signup.href, business)} className="inline-flex h-12 items-center gap-2 rounded-lg bg-brand px-6 font-medium text-white">
              {signup.label} <ArrowRight className="h-4 w-4" aria-hidden="true" />
            </a>
          </div>
        )}
      </section>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-surface-sunken px-4 py-3">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 text-sm font-medium text-text">{value}</dd>
    </div>
  );
}
