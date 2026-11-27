"use client";

import { useState, type ReactNode } from "react";
import { useTurns } from "@/components/site/motion";
import { cn } from "@/lib/utils";

/**
 * The hero's product preview as tabs (owner, 15 Nov 2026: "improve design and ui") — Sales, Books, People, Support —
 * so a visitor sees more than the pipeline without scrolling. The screens are drawn on the server and handed in; this
 * only chooses which shows. Every screen stays in the page (hidden ones with `hidden`), so nothing loads on a click.
 *
 * The tabs take turns on their own (owner, 18 Nov 2026 — the new home page), a bar filling under the one showing; a
 * pointer over the screen holds it, and a click picks one and stops the turns. Around the window on a wide screen, a
 * few notifications of the kind the app sends float in — sample figures, as the screens are.
 */
const TURN_MS = 6000;

const NOTES = [
  { icon: "₹", tone: "bg-emerald-50 text-emerald-600", title: "Payment received", line: "Orion Foods · ₹62,304", at: "-left-16 top-24" },
  { icon: "✓", tone: "bg-blue-50 text-blue-600", title: "IRN generated", line: "WT/26-27/1644 · e-way bill ready", at: "-right-14 top-12" },
  { icon: "⏰", tone: "bg-amber-50 text-amber-600", title: "Renewal in 15 days", line: "Kestrel Pvt · 40 licences", at: "-right-10 top-[58%]" },
  { icon: "✈", tone: "bg-violet-50 text-violet-600", title: "Leave approved", line: "Diksha · Friday", at: "-left-12 top-[66%]" },
] as const;

export function HeroPreviewTabs({ tabs }: { tabs: { label: string; screen: ReactNode }[] }) {
  const [held, setHeld] = useState(false);
  const [picked, setPicked] = useState(false);
  const [on, setOn] = useTurns(tabs.length, TURN_MS, held || picked);
  return (
    <div>
      <div role="tablist" aria-label="See the product" className="mx-auto mb-6 flex w-fit max-w-full flex-wrap justify-center gap-1.5 rounded-full border border-white/15 bg-white/[0.06] p-1.5 backdrop-blur">
        {tabs.map((tab, i) => (
          <button
            key={i}
            type="button"
            role="tab"
            id={`hero-tab-${i}`}
            aria-selected={on === i}
            aria-controls={`hero-panel-${i}`}
            onClick={() => {
              setPicked(true);
              setOn(i);
            }}
            className={cn(
              "relative overflow-hidden rounded-full px-4 py-1.5 text-sm font-medium transition-colors sm:px-5",
              on === i ? "bg-white text-slate-950" : "text-white/70 hover:text-white",
            )}
          >
            {tab.label}
            {on === i && !picked && (
              <span
                key={`bar-${i}`}
                aria-hidden="true"
                className="site-progress absolute bottom-0 left-0 h-0.5 bg-[#0249fe]"
                style={{ animationDuration: `${TURN_MS}ms`, animationPlayState: held ? "paused" : "running" }}
              />
            )}
          </button>
        ))}
      </div>
      <div className="relative" onPointerEnter={() => setHeld(true)} onPointerLeave={() => setHeld(false)}>
        {NOTES.map((note, i) => (
          <div
            key={`${i}-${on}`}
            aria-hidden="true"
            className={cn("site-float absolute z-10 hidden items-center gap-3 rounded-2xl bg-white/95 px-4 py-3 text-left text-slate-900 shadow-[0_24px_50px_-18px_rgb(0_0_0/0.5)] xl:flex", note.at, i === on && "xl:hidden")}
            style={{ animationDelay: `${i * 150}ms, ${600 + i * 400}ms` }}
          >
            <span className={cn("grid h-9 w-9 place-items-center rounded-xl text-base font-semibold", note.tone)}>{note.icon}</span>
            <span className="text-sm font-medium leading-5">
              {note.title}
              <span className="block text-xs font-normal text-slate-500">{note.line}</span>
            </span>
          </div>
        ))}
        {tabs.map((tab, i) => (
          <div key={i} role="tabpanel" id={`hero-panel-${i}`} aria-labelledby={`hero-tab-${i}`} hidden={on !== i} className="site-rise">
            {tab.screen}
          </div>
        ))}
      </div>
    </div>
  );
}
