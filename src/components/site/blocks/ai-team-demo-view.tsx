"use client";

import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";
import { TeammateAvatar, TeammatesProvider, useTeammate } from "@/components/ai/teammate-avatar";
import { DEFAULT_TEAMMATE_PHOTOS } from "@/lib/ai/teammate-default-photos";
import { screensWithPhotos } from "@/components/site/blocks/ai-team-demo-photos";
import { TEAMMATES, TEAMMATE_KEYS, teammatesWith } from "@/lib/ai/teammates";
import { AI_TEAM_DEMO, setWho, type DemoAgent } from "@/components/site/blocks/ai-team-demo-steps";

/**
 * "Watch your AI team at work" (owner, 23 Nov 2026 — "a demo with real workspaces screen on behind these agents
 * working"): Deskzo's own screens in a browser window, each teammate's face moving over the page, ringing the spot it
 * works on while its work appears there (ai-team-demo-steps.ts). Deskzo AI first, the one people ask, who brings in the
 * rest (owner: "what about Deskzo AI ? include this also"); then the six. Plays through them all, or one picked; Back,
 * Pause and Next.
 *
 *   · The screens are a static file of the public site's (/ai-team/screens.json, `npm run site:ai-team-screens`),
 *     fetched once the block is on screen; nothing on the page asks a workspace or a model for anything. Elsewhere —
 *     the CMS editor's preview, on its own host — the file isn't there, and the window says the screens didn't load.
 *   · They are drawn at a desktop's 1440 × 900 and scaled to the block's width; the words of each step are under the
 *     window too, where they can be read at any size, and are what a screen reader hears — the screens are inert.
 *   · The site's own theme: a dark page shows the screens in Deskzo's dark theme.
 */

type Screens = { lead: string; screens: Record<string, string>; faces: Record<string, string> };
type Rect = { x: number; y: number; w: number; h: number };
type Marks = { ring: Rect | null; cursor: { x: number; y: number }; bubble: { x: number; y: number } };

/** The public site's /ai-team/screens.json — public/platform-site/ai-team/screens.json, from `npm run site:ai-team-screens`. */
const SCREENS = "/ai-team/screens.json";
const W = 1440;
const H = 900;
const STEP_MS = 4800;
const BUBBLE_W = 360;
const BUBBLE_H = 120;

const LESS_MOTION = "(prefers-reduced-motion: reduce)";
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    (changed) => {
      const q = window.matchMedia(LESS_MOTION);
      q.addEventListener("change", changed);
      return () => q.removeEventListener("change", changed);
    },
    () => window.matchMedia(LESS_MOTION).matches,
    () => false,
  );
}

/** One step on, or back, across the whole team: after a teammate's last step, the next teammate's first. */
function move(p: { ai: number; si: number }, dir: 1 | -1) {
  const steps = AI_TEAM_DEMO[p.ai]!.steps.length;
  if (dir > 0) return p.si < steps - 1 ? { ai: p.ai, si: p.si + 1 } : { ai: (p.ai + 1) % AI_TEAM_DEMO.length, si: 0 };
  if (p.si > 0) return { ai: p.ai, si: p.si - 1 };
  const ai = (p.ai + AI_TEAM_DEMO.length - 1) % AI_TEAM_DEMO.length;
  return { ai, si: AI_TEAM_DEMO[ai]!.steps.length - 1 };
}

/** Where the ring, the face and the words go for a spot — the words beside the spot, never over it. */
function marks(r: Rect | null, top: number): Marks {
  if (!r) return { ring: null, cursor: { x: 640, y: 380 }, bubble: { x: 560, y: 450 } };
  const ry = r.y - top;
  const cursor = { x: Math.min(Math.max(r.x + r.w - 28, 8), W - 60), y: Math.min(Math.max(ry - 30, 8), H - 60) };
  let bubble: { x: number; y: number };
  if (W - (r.x + r.w) >= BUBBLE_W + 40) bubble = { x: r.x + r.w + 28, y: ry };
  else if (r.x >= BUBBLE_W + 40) bubble = { x: r.x - BUBBLE_W - 28, y: ry };
  else bubble = { x: Math.min(Math.max(r.x, 12), W - BUBBLE_W - 12), y: ry + r.h + 22 + BUBBLE_H <= H - 8 ? ry + r.h + 22 : ry - BUBBLE_H - 22 };
  bubble.y = Math.min(Math.max(bubble.y, 8), H - BUBBLE_H - 8);
  return { ring: { x: r.x - 8, y: ry - 8, w: r.w + 16, h: r.h + 16 }, cursor, bubble };
}

/** The teammates with their built-in photos (owner, 23 Nov 2026), as the app shows them. */
const SITE_TEAM = teammatesWith(Object.fromEntries(TEAMMATE_KEYS.map((k) => [k, { photo: k === "deskzo" ? null : DEFAULT_TEAMMATE_PHOTOS[k] }])));

export function AiTeamDemoView({ note }: { note?: string }) {
  return (
    <TeammatesProvider teammates={SITE_TEAM}>
      <DemoView note={note} />
    </TeammatesProvider>
  );
}

function DemoView({ note }: { note?: string }) {
  const [data, setData] = useState<Screens | null>(null);
  const [failed, setFailed] = useState(false);
  const [pos, setPos] = useState({ ai: 0, si: 0 });
  const [playing, setPlaying] = useState(true);
  const [visible, setVisible] = useState(false);
  const [scale, setScale] = useState(0.5);
  const box = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null);
  const scroll = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLDivElement>(null);
  const cursorRef = useRef<HTMLDivElement>(null);
  const bubbleRef = useRef<HTMLDivElement>(null);
  const onShow = useRef<string | null>(null);
  const reduced = useReducedMotion();
  const agent = AI_TEAM_DEMO[pos.ai]!;
  const step = agent.steps[pos.si]!;
  const teammate = useTeammate(agent.key);
  const colour = TEAMMATES[agent.key].colour;

  // Loaded, and played, once the block is on screen.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) {
        setVisible(true);
        io.disconnect();
      }
    }, { rootMargin: "200px 0px", threshold: 0.05 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  useEffect(() => {
    if (!visible || data) return;
    fetch(SCREENS)
      .then((r) => {
        if (!r.ok) throw new Error(String(r.status));
        return r.json() as Promise<Screens>;
      })
      // Each drawn face on the screens becomes the teammate's photo (src/components/site/blocks/ai-team-demo-photos.ts).
      .then((d) => setData(screensWithPhotos(d)))
      .catch(() => setFailed(true));
  }, [visible, data]);

  // A desktop's screen, scaled to the block's width (the observer reports the first width as it starts).
  useEffect(() => {
    const v = view.current;
    if (!v) return;
    const ro = new ResizeObserver(() => setScale(v.clientWidth / W || 0.5));
    ro.observe(v);
    return () => ro.disconnect();
  }, []);

  // The step: its screen fresh, this screen's earlier steps replayed without a stir, this one's change shown, its spot rung.
  useLayoutEffect(() => {
    const root = scroll.current;
    if (!data || !root) return;
    const a = AI_TEAM_DEMO[pos.ai]!;
    const s = a.steps[pos.si]!;
    let start = pos.si;
    while (start > 0 && a.steps[start - 1]!.screen === s.screen) start -= 1;
    const jump = onShow.current !== s.screen;
    onShow.current = s.screen;
    root.innerHTML = data.screens[s.screen] ?? "";
    setWho(root, s.who ?? a.who);
    for (let k = start; k <= pos.si; k += 1) {
      try {
        a.steps[k]!.act?.(root, { faces: data.faces, anim: !reduced && k === pos.si, lead: data.lead });
      } catch {
        // A screen that no longer has that spot: the step still shows, with nothing changed.
      }
    }
    let target: Element | null = null;
    try {
      target = s.target(root);
    } catch {
      target = null;
    }
    const base = root.getBoundingClientRect();
    const sc = base.width / W || 1;
    const t = target?.getBoundingClientRect();
    const r = t ? { x: (t.left - base.left) / sc, y: (t.top - base.top) / sc, w: t.width / sc, h: t.height / sc } : null;
    const top = r ? Math.min(Math.max(0, r.y - 200), Math.max(0, root.scrollHeight - H)) : 0;
    if (jump || reduced) {
      root.style.transition = "none";
      root.style.transform = `translateY(${-top}px)`;
      void root.offsetWidth;
      root.style.transition = "";
    } else {
      root.style.transform = `translateY(${-top}px)`;
    }
    // The ring, the face and the words, placed on the screen as it now is.
    const m = marks(r, top);
    const place = (node: HTMLElement | null, x: number, y: number) => {
      if (!node) return;
      node.style.left = `${x}px`;
      node.style.top = `${y}px`;
    };
    if (ringRef.current) {
      ringRef.current.style.opacity = m.ring ? "1" : "0";
      if (m.ring) {
        place(ringRef.current, m.ring.x, m.ring.y);
        ringRef.current.style.width = `${m.ring.w}px`;
        ringRef.current.style.height = `${m.ring.h}px`;
      }
    }
    place(cursorRef.current, m.cursor.x, m.cursor.y);
    place(bubbleRef.current, m.bubble.x, m.bubble.y);
  }, [data, pos, reduced]);

  useEffect(() => {
    if (!playing || !visible || !data) return;
    const t = window.setTimeout(() => setPos((p) => move(p, 1)), STEP_MS);
    return () => window.clearTimeout(t);
  }, [playing, visible, data, pos]);

  const motion = reduced ? "" : "transition-all duration-700 ease-out";
  return (
    <div ref={box} className="mx-auto mt-10 max-w-6xl text-left">
      <div role="tablist" aria-label="The AI team" className="grid grid-cols-4 gap-2 sm:grid-cols-7">
        {AI_TEAM_DEMO.map((t, i) => (
          <TeammateTab
            key={t.key}
            teammate={t}
            selected={i === pos.ai}
            onSelect={() => {
              // A click is as good as being seen: the screens load then, whatever the page's scroll says.
              setVisible(true);
              setPos({ ai: i, si: 0 });
            }}
          />
        ))}
      </div>

      <div className="mt-4 overflow-hidden rounded-2xl border border-line bg-surface shadow-lg">
        <div className="flex items-center gap-2.5 border-b border-line bg-surface-sunken px-3 py-2">
          <span className="flex shrink-0 gap-1.5" aria-hidden="true">
            <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
            <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
            <span className="h-2.5 w-2.5 rounded-full bg-line-strong" />
          </span>
          <span className="min-w-0 flex-1 truncate rounded-md border border-line bg-surface px-2.5 py-1 text-xs text-muted">
            zenith.deskzo.com{data ? step.url({ lead: data.lead }) : ""}
          </span>
          <span className="hidden shrink-0 text-xs text-muted sm:inline">Sample company</span>
        </div>

        <div ref={view} className="relative overflow-hidden bg-bg" style={{ height: Math.round(H * scale) }} aria-hidden="true">
          <div className="absolute left-0 top-0 overflow-hidden" style={{ width: W, height: H, transform: `scale(${scale})`, transformOrigin: "0 0" }}>
            <div ref={scroll} inert className={`pointer-events-none absolute left-0 top-0 w-[1440px] ${reduced ? "" : "transition-transform duration-700 ease-out"}`} />
            {!data && <p className="absolute inset-0 flex items-center justify-center text-3xl text-muted">{failed ? "The screens didn't load. Reload the page to try again." : "Loading the screens…"}</p>}
            {data && (
              <>
                <div ref={ringRef} className={`pointer-events-none absolute rounded-[14px] border-[3px] opacity-0 ${motion}`} style={{ borderColor: colour, boxShadow: `0 0 0 7px ${colour}2e` }} />
                <div ref={cursorRef} className={`pointer-events-none absolute ${motion}`} style={{ filter: "drop-shadow(0 6px 10px rgb(0 0 0 / 0.25))" }}>
                  <TeammateAvatar teammate={agent.key} size="lg" />
                </div>
                <div
                  ref={bubbleRef}
                  className={`pointer-events-none absolute rounded-[14px] px-4 py-3 text-[18px] leading-snug text-white shadow-lg ${motion} ${scale >= 0.55 ? "" : "hidden"}`}
                  style={{ width: BUBBLE_W, backgroundColor: colour }}
                >
                  {step.say}
                </div>
              </>
            )}
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-x-4 gap-y-3 border-t border-line px-4 py-3">
          <div className="flex min-w-0 flex-[1_1_22rem] items-center gap-3">
            <TeammateAvatar teammate={agent.key} size="md" />
            <div className="min-w-0">
              <p className="text-[15px] leading-snug text-text" aria-live="polite">
                {step.say}
              </p>
              <p className="mt-0.5 text-xs tabular-nums text-muted">
                {teammate.name} · {teammate.role} · step {pos.si + 1} of {agent.steps.length}
              </p>
            </div>
          </div>
          <div className="flex items-center gap-1.5">
            <ControlButton label="Back" onClick={() => setPos((p) => move(p, -1))}>
              <SkipBack className="h-4 w-4" aria-hidden="true" />
            </ControlButton>
            <ControlButton label={playing ? "Pause" : "Play"} primary onClick={() => setPlaying((p) => !p)}>
              {playing ? <Pause className="h-4 w-4" aria-hidden="true" /> : <Play className="h-4 w-4" aria-hidden="true" />}
            </ControlButton>
            <ControlButton label="Next" onClick={() => setPos((p) => move(p, 1))}>
              <SkipForward className="h-4 w-4" aria-hidden="true" />
            </ControlButton>
          </div>
          <div className="flex basis-full gap-1.5" aria-hidden="true">
            {agent.steps.map((_, i) => (
              <span key={i} className="h-1 flex-1 rounded-full bg-line" style={i <= pos.si ? { backgroundColor: colour } : undefined} />
            ))}
          </div>
        </div>
      </div>

      <p className="mt-3 text-center text-xs text-muted">
        {note || "A replay on Deskzo's own screens with a sample company: the people and amounts are made up, and nothing here runs AI or saves anything."}
      </p>
      <p className="mt-1 text-center text-xs text-muted sm:hidden">The screens are full desktop pages, so they&apos;re small on a phone. Open this page on a computer to see them up close.</p>
    </div>
  );
}

function TeammateTab({ teammate, selected, onSelect }: { teammate: DemoAgent; selected: boolean; onSelect: () => void }) {
  const t = useTeammate(teammate.key);
  return (
    <button
      type="button"
      role="tab"
      aria-selected={selected}
      onClick={onSelect}
      className={`flex min-w-0 flex-col items-center gap-1 rounded-xl border px-2 py-3 text-center transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
        selected ? "border-transparent bg-surface shadow-sm" : "border-line bg-transparent hover:bg-surface"
      }`}
      style={selected ? { boxShadow: `0 0 0 2px ${t.colour}` } : undefined}
    >
      <TeammateAvatar teammate={teammate.key} size="lg" />
      <span className="mt-1 text-sm font-medium text-text">{t.name}</span>
      <span className="w-full truncate text-[11px] text-muted">{t.role}</span>
    </button>
  );
}

function ControlButton({ label, primary = false, onClick, children }: { label: string; primary?: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`inline-flex h-9 items-center gap-1.5 rounded-base border px-3 text-sm font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-brand ${
        primary ? "border-brand bg-brand text-white" : "border-line bg-surface text-text hover:bg-surface-sunken"
      }`}
    >
      {children}
      <span className="hidden sm:inline">{label}</span>
    </button>
  );
}
