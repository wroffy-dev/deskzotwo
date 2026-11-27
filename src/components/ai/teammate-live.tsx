"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { CompanyLink } from "@/components/companies/company-link";
import { Check, LoaderCircle, X } from "lucide-react";
import { TeammateAvatar, useTeammate } from "@/components/ai/teammate-avatar";
import { TEAMMATE_KEYS, type TeammateKey } from "@/lib/ai/teammates";
import type { TeamActivity, WorkRow } from "@/lib/ai/teammate-work";
import { useRouter } from "next/navigation";
import { inboxTakeOver } from "@/actions/inbox";
import type { KabirLive } from "@/lib/ai/kabir-live";

/**
 * The AI team, seen working (owner, 19 Nov 2026 — "user can see agents working on screen"). Everything here draws
 * src/lib/ai/teammate-work.ts's rows, asked from /api/teammates/activity — real jobs and their real steps, never an
 * animation of its own:
 *
 *   · `LiveSteps` — on a card whose button started a job: the teammate's steps ticking off as the job reaches them;
 *   · `TeamStrip` — in the header: the faces, a ring pulsing on whoever is working, and a panel of what each is doing
 *     and just did;
 *   · `TeamRoom` — the page (/ai-team): a card for each teammate with their steps as they go, and a feed of everything
 *     done for this person, updating as it happens.
 *
 * A card says a job began with `announceTeammateWork()`, so the strip looks at once rather than at its next quiet check.
 * Nothing moves for somebody who asked for reduced motion (the pulse and spinner are `motion-safe`).
 */

const STARTED = "deskzo:teammate-work";
export function announceTeammateWork() {
  if (typeof window !== "undefined") window.dispatchEvent(new Event(STARTED));
}

async function ask<T>(query: string, signal: AbortSignal): Promise<T | null> {
  try {
    const r = await fetch(`/api/teammates/activity${query}`, { signal, cache: "no-store" });
    return r.ok ? ((await r.json()) as T) : null;
  } catch {
    return null;
  }
}

/** A job's steps: done ones ticked, the current one turning, the rest waiting. */
export function StepList({ work }: { work: Pick<WorkRow, "steps" | "step" | "status"> }) {
  return (
    <ol className="space-y-1">
      {work.steps.map((s, i) => {
        const done = work.status === "DONE" || i < work.step;
        const now = work.status === "RUNNING" && i === work.step;
        const failed = work.status === "FAILED" && i === work.step;
        return (
          <li key={s} className={`flex items-center gap-2 text-sm ${done ? "text-text" : now ? "font-medium text-text" : "text-subtle"}`}>
            {done ? (
              <Check className="h-3.5 w-3.5 shrink-0 text-success" aria-hidden="true" />
            ) : now ? (
              <LoaderCircle className="h-3.5 w-3.5 shrink-0 text-brand motion-safe:animate-spin" aria-hidden="true" />
            ) : failed ? (
              <X className="h-3.5 w-3.5 shrink-0 text-danger" aria-hidden="true" />
            ) : (
              <span className="mx-[3px] h-2 w-2 shrink-0 rounded-full border border-line-strong" aria-hidden="true" />
            )}
            {s}
          </li>
        );
      })}
    </ol>
  );
}

/**
 * While a card's own job is out (`active`): the teammate and the job's steps, asked for every second. `fallback` is what
 * the job's steps are known to be, shown until its row is first seen.
 */
export function LiveSteps({ teammate, subject, active, fallback }: { teammate: TeammateKey; subject: string; active: boolean; fallback: string[] }) {
  const t = useTeammate(teammate);
  const [work, setWork] = useState<WorkRow | null>(null);
  const began = useRef(0);

  useEffect(() => {
    if (!active) return;
    began.current = Date.now();
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const look = async () => {
      const got = await ask<{ work: WorkRow | null }>(`?subject=${encodeURIComponent(subject)}`, stop.signal);
      // Only the job this press started — not one that ended here a moment ago.
      if (got?.work && new Date(got.work.startedAt).getTime() >= began.current - 5000) setWork(got.work);
      if (!stop.signal.aborted) timer = setTimeout(look, 1000);
    };
    void look();
    return () => {
      stop.abort();
      clearTimeout(timer);
      setWork(null);
    };
  }, [active, subject]);

  if (!active) return null;
  const shown = work ?? { steps: fallback, step: 0, status: "RUNNING" as const };
  return (
    <div className="flex items-start gap-3 rounded-lg border border-line bg-surface-sunken px-3 py-3" role="status" aria-live="polite">
      <span className="relative mt-0.5">
        <span className="absolute -inset-1 rounded-full motion-safe:animate-ping" style={{ background: t.colour, opacity: 0.25 }} aria-hidden="true" />
        <TeammateAvatar teammate={teammate} size="md" className="relative" />
      </span>
      <div className="min-w-0 space-y-1.5">
        <p className="text-sm font-medium text-text">{t.name} is working on it…</p>
        <StepList work={shown} />
      </div>
    </div>
  );
}

const ago = (iso: string) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
};

/** How a job reads in a line: "Researching Acme" while it goes, what came of it after. */
function jobLine(w: WorkRow): string {
  const doing: Record<string, string> = { "research.plan": "Researching and planning", "research.brief": "Writing a brief on", "nurture.draft": "Drafting a follow-up for", "reengage.draft": "Drafting a check-in to", "workflow.draft": "Drafting" };
  return `${doing[w.kind] ?? "Working on"} ${w.label}`;
}

type Team = TeamActivity & { feed?: WorkRow[]; kabir?: KabirLive | null };

/**
 * This person's team, kept up to date: asked quickly while anybody is working or `watching` (a panel or the room is
 * open), slowly otherwise, and not at all in a hidden tab. `feed`: the Team room's longer list too.
 */
function useTeamActivity(watching: boolean, feed = false, initial: Team | null = null): Team | null {
  const [team, setTeam] = useState<Team | null>(initial);
  useEffect(() => {
    const stop = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    let quick = false;
    const look = async () => {
      clearTimeout(timer);
      if (document.visibilityState === "visible") {
        const got = await ask<Team & { ok: boolean }>(feed ? "?feed=1" : "", stop.signal);
        if (got?.ok) {
          setTeam(got);
          quick = got.running.length > 0 || (got.kabir?.chats.length ?? 0) > 0;
        }
      }
      if (!stop.signal.aborted) timer = setTimeout(look, quick || watching ? 2500 : 60_000);
    };
    const soon = () => {
      quick = true;
      clearTimeout(timer);
      timer = setTimeout(look, 600);
    };
    void look();
    window.addEventListener(STARTED, soon);
    document.addEventListener("visibilitychange", soon);
    return () => {
      stop.abort();
      clearTimeout(timer);
      window.removeEventListener(STARTED, soon);
      document.removeEventListener("visibilitychange", soon);
    };
  }, [watching, feed]);
  return team;
}

/** The header's team: the faces, whoever is working pulsing, and a panel of what each is doing and just did. */
export function TeamStrip() {
  const [open, setOpen] = useState(false);
  const team = useTeamActivity(open);
  const box = useRef<HTMLDivElement>(null);
  const chats = team?.kabir?.chats.length ?? 0;
  const jobs = (team?.running.length ?? 0) + chats;
  const busy = jobs > 0;

  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => {
      if (box.current && !box.current.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("mousedown", away);
    document.addEventListener("keydown", esc);
    return () => {
      document.removeEventListener("mousedown", away);
      document.removeEventListener("keydown", esc);
    };
  }, [open]);

  const working = new Set<TeammateKey>(team?.running.map((w) => w.teammate));
  if (chats > 0) working.add("kabir");
  const faces = TEAMMATE_KEYS.filter((k) => k !== "deskzo");
  const finishedToday = team ? faces.reduce((n, k) => n + team.done[k], 0) : 0;

  return (
    <div ref={box} className="relative hidden md:block">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-label={busy ? `Your AI team — ${jobs} going now` : "Your AI team"}
        title={team?.running[0] ? jobLine(team.running[0]) : chats > 0 ? chatsLine(chats) : "Your AI team"}
        className="flex items-center rounded-full py-1 pl-1 pr-2 hover:bg-surface-sunken"
      >
        <span className="flex -space-x-2">
          {faces.map((k) => (
            <span key={k} className="relative rounded-full ring-2 ring-surface">
              {working.has(k) && <PulseRing teammate={k} />}
              <TeammateAvatar teammate={k} size="xs" className={`relative ${busy && !working.has(k) ? "opacity-60" : ""}`} />
            </span>
          ))}
        </span>
        {busy && <span className="ml-1.5 rounded-full bg-brand px-1.5 text-[10px] font-semibold leading-4 text-brand-contrast">{jobs}</span>}
      </button>

      {open && (
        <div role="dialog" aria-label="Your AI team" className="absolute right-0 top-full z-40 mt-2 w-[360px] max-w-[calc(100vw-2rem)] rounded-xl border border-line bg-surface p-3 shadow-xl">
          <div className="flex items-baseline justify-between px-1 pb-2">
            <h2 className="text-sm font-semibold text-text">Your AI team</h2>
            <span className="text-xs text-muted">{finishedToday > 0 ? `${finishedToday} done today` : "Nothing done yet today"}</span>
          </div>
          <div className="space-y-2">
            {faces.map((k) => (
              <TeamRow
                key={k}
                teammate={k}
                running={team?.running.find((w) => w.teammate === k) ?? null}
                last={team?.recent.find((w) => w.teammate === k) ?? null}
                done={k === "kabir" ? (team?.kabir?.answeredToday ?? 0) : (team?.done[k] ?? 0)}
                chats={k === "kabir" ? chats : 0}
                onGo={() => setOpen(false)}
              />
            ))}
          </div>
          <div className="flex items-center justify-between px-1 pt-2">
            <p className="text-[11px] text-subtle">Only work done for you is shown here.</p>
            <Link href="/ai-team" onClick={() => setOpen(false)} className="text-xs font-medium text-brand hover:underline">
              Open the team room
            </Link>
          </div>
        </div>
      )}
    </div>
  );
}

function PulseRing({ teammate }: { teammate: TeammateKey }) {
  const t = useTeammate(teammate);
  return <span className="absolute -inset-0.5 rounded-full motion-safe:animate-ping" style={{ background: t.colour, opacity: 0.45 }} aria-hidden="true" />;
}

const chatsLine = (n: number) => `Chatting with ${n} ${n === 1 ? "customer" : "customers"}`;

function TeamRow({ teammate, running, last, done, chats = 0, onGo }: { teammate: TeammateKey; running: WorkRow | null; last: WorkRow | null; done: number; chats?: number; onGo: () => void }) {
  const t = useTeammate(teammate);
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${running || chats > 0 ? "border-brand/40 bg-brand-subtle/40" : "border-line"}`}>
      <div className="flex items-center gap-2.5">
        <span className="relative">
          {(running || chats > 0) && <PulseRing teammate={teammate} />}
          <TeammateAvatar teammate={teammate} size="sm" className="relative" />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-sm font-semibold text-text">
            {t.name} <span className="font-normal text-muted">· {t.role}</span>
          </p>
          <p className="truncate text-xs text-muted">
            {running ? `${jobLine(running)}…` : chats > 0 ? `${chatsLine(chats)}…` : done > 0 ? (teammate === "kabir" ? `${done} answered today` : `${done} done today`) : "Idle"}
          </p>
        </div>
        {chats > 0 && (
          <Link href="/ai-team" onClick={onGo} className="shrink-0 text-xs font-medium text-brand hover:underline">
            Watch
          </Link>
        )}
      </div>
      {running && (
        <div className="mt-2 pl-[38px]">
          <StepList work={running} />
        </div>
      )}
      {!running && last && (
        <p className="mt-1.5 truncate pl-[38px] text-xs text-text">
          {last.status === "FAILED" ? "Didn't finish: " : ""}
          {last.href ? (
            <CompanyLink href={last.href} onClick={onGo} className="font-medium text-brand hover:underline">
              {last.label}
            </CompanyLink>
          ) : (
            <span className="font-medium">{last.label}</span>
          )}
          {last.summary ? ` — ${last.summary}` : ""} <span className="text-subtle">· {ago(last.finishedAt ?? last.startedAt)}</span>
        </p>
      )}
    </div>
  );
}

/**
 * The Team room (/ai-team): each teammate as a card — working, with their steps ticking, or idle with what they do — and
 * below, everything done for this person, newest first, as it happens. `initial` is what the page read on the server.
 */
export function TeamRoom({ initial }: { initial: TeamActivity & { feed: WorkRow[]; kabir?: KabirLive | null } }) {
  const team = useTeamActivity(true, true, initial) ?? initial;
  const faces = TEAMMATE_KEYS.filter((k) => k !== "deskzo");
  const feed = team.feed ?? initial.feed;
  return (
    <div className="space-y-6">
      <div className="grid gap-3 sm:grid-cols-2">
        {faces.map((k) =>
          k === "kabir" && team.kabir ? (
            <KabirCard key={k} live={team.kabir} />
          ) : (
            <RoomCard key={k} teammate={k} running={team.running.filter((w) => w.teammate === k)} done={team.done[k]} />
          ),
        )}
      </div>
      <section aria-labelledby="team-feed" className="space-y-2">
        <h2 id="team-feed" className="text-sm font-semibold text-text">
          What they&apos;ve done for you
        </h2>
        {feed.length === 0 ? (
          <p className="rounded-lg border border-dashed border-line px-4 py-6 text-center text-sm text-muted">
            Nothing yet. Press Research &amp; plan on a lead, or describe a workflow in Automate, and watch them work here.
          </p>
        ) : (
          <ul className="divide-y divide-line rounded-lg border border-line bg-surface">
            {feed.map((w) => (
              <FeedLine key={w.id} work={w} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function RoomCard({ teammate, running, done }: { teammate: TeammateKey; running: WorkRow[]; done: number }) {
  const t = useTeammate(teammate);
  const busy = running.length > 0;
  return (
    <div className={`rounded-xl border p-4 ${busy ? "border-brand/40 bg-brand-subtle/40" : "border-line bg-surface"}`}>
      <div className="flex items-center gap-3">
        <span className="relative">
          {busy && <PulseRing teammate={teammate} />}
          <TeammateAvatar teammate={teammate} size="lg" className="relative" />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-base font-semibold text-text">{t.name}</p>
          <p className="truncate text-sm text-muted">{t.role}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${busy ? "bg-brand text-brand-contrast" : "bg-surface-sunken text-muted"}`}>
          {busy ? (running.length > 1 ? `Working · ${running.length}` : "Working") : done > 0 ? `${done} done today` : "Idle"}
        </span>
      </div>
      {busy ? (
        <div className="mt-3 space-y-3">
          {running.slice(0, 3).map((w) => (
            <div key={w.id} className="space-y-1.5" role="status" aria-live="polite">
              <p className="truncate text-sm font-medium text-text">{jobLine(w)}…</p>
              <StepList work={w} />
            </div>
          ))}
        </div>
      ) : (
        <p className="mt-3 text-sm text-muted">{t.job}</p>
      )}
    </div>
  );
}

function FeedLine({ work: w }: { work: WorkRow }) {
  return (
    <li className="flex items-start gap-3 px-3 py-2.5">
      <TeammateAvatar teammate={w.teammate} size="sm" className="mt-0.5" />
      <div className="min-w-0 flex-1 text-sm">
        <p className="text-text">
          <FeedWho teammate={w.teammate} /> {w.status === "RUNNING" ? "is working on" : w.status === "FAILED" ? "didn't finish" : "finished"}{" "}
          {w.href ? (
            <CompanyLink href={w.href} className="font-medium text-brand hover:underline">
              {w.label}
            </CompanyLink>
          ) : (
            <span className="font-medium">{w.label}</span>
          )}
        </p>
        {w.summary && <p className={`text-xs ${w.status === "FAILED" ? "text-danger" : "text-muted"}`}>{w.summary}</p>}
      </div>
      <span className="shrink-0 text-xs text-subtle">{ago(w.finishedAt ?? w.startedAt)}</span>
    </li>
  );
}

function FeedWho({ teammate }: { teammate: TeammateKey }) {
  return <span className="font-semibold">{useTeammate(teammate).name}</span>;
}

/**
 * Kabir's card in the Team room: the customers he is chatting with now — dots while he answers — each with Take over,
 * which makes the conversation this person's, stops the bot and opens it in the Inbox (src/lib/inbox/server.ts
 * `takeOverFromBot`). Only chats this person's own Inbox shows.
 */
function KabirCard({ live }: { live: KabirLive }) {
  const t = useTeammate("kabir");
  const router = useRouter();
  const [taking, setTaking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const busy = live.chats.length > 0;

  const take = async (id: string) => {
    setTaking(id);
    setError(null);
    try {
      const r = await inboxTakeOver(id);
      if (!r.ok) return void setError(r.error);
      router.push(`/inbox?c=${encodeURIComponent(r.data.ref)}`);
    } catch {
      setError("That didn't go through — try again.");
    } finally {
      setTaking(null);
    }
  };

  return (
    <div className={`rounded-xl border p-4 ${busy ? "border-brand/40 bg-brand-subtle/40" : "border-line bg-surface"}`}>
      <div className="flex items-center gap-3">
        <span className="relative">
          {busy && <PulseRing teammate="kabir" />}
          <TeammateAvatar teammate="kabir" size="lg" className="relative" />
        </span>
        <div className="min-w-0 flex-1 leading-tight">
          <p className="truncate text-base font-semibold text-text">{t.name}</p>
          <p className="truncate text-sm text-muted">{t.role}</p>
        </div>
        <span className={`shrink-0 rounded-full px-2 py-0.5 text-xs font-medium ${busy ? "bg-brand text-brand-contrast" : "bg-surface-sunken text-muted"}`}>
          {busy ? `Chatting · ${live.chats.length}` : live.answeredToday > 0 ? `${live.answeredToday} answered today` : "Idle"}
        </span>
      </div>
      {busy ? (
        <ul className="mt-3 space-y-2">
          {live.chats.map((c) => (
            <li key={c.id} className="flex items-start gap-2 rounded-lg bg-surface px-3 py-2">
              <div className="min-w-0 flex-1">
                <p className="flex items-center gap-1.5 truncate text-sm font-medium text-text">
                  {c.online && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-success" title="On the page now" />}
                  {c.customer}
                  <span className="truncate font-normal text-subtle">· {c.channel}</span>
                </p>
                <p className="truncate text-xs text-muted">
                  {c.answering ? (
                    <span role="status" aria-label={`${t.name} is answering`} className="mr-1.5 inline-flex gap-0.5 align-middle">
                      {[0, 1, 2].map((i) => (
                        <span key={i} className="h-1 w-1 rounded-full bg-brand motion-safe:animate-bounce" style={{ animationDelay: `${i * 150}ms` }} />
                      ))}
                    </span>
                  ) : null}
                  {c.preview}
                </p>
              </div>
              <button
                type="button"
                disabled={taking !== null}
                onClick={() => void take(c.id)}
                className="shrink-0 rounded-base border border-line-strong bg-surface px-2.5 py-1 text-xs font-medium text-text hover:bg-surface-sunken disabled:opacity-50"
              >
                {taking === c.id ? "Taking…" : "Take over"}
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-3 text-sm text-muted">{t.job}</p>
      )}
      {live.answeredToday > 0 && (
        <p className="mt-3 text-xs text-muted">
          Today: {live.answeredToday} {live.answeredToday === 1 ? "chat" : "chats"} answered
          {live.handedToday > 0 ? `, ${live.handedToday} handed to a person` : ""}.
        </p>
      )}
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
    </div>
  );
}
