"use client";

import { useState } from "react";
import type { IconName } from "@/components/site/blocks/types";
import { SiteIcon } from "@/components/site/icons";
import { useTurns } from "@/components/site/motion";
import { SampleBadge } from "@/components/site/ui";
import { cn } from "@/lib/utils";

type Step = { icon?: IconName; title: string; caption: string; heading: string; body: string; lines: { label: string; value: string }[] };

/**
 * The workflow's steps along a line, taking turns every few seconds (owner, 18 Nov 2026): the line fills to the step
 * showing, and under it that step's heading, sentence and document lines. A click picks a step and stops the turns.
 * Every step's words are in the page — the ones not showing are hidden — so a reader without script has them all.
 */
const TURN_MS = 3500;

export function WorkflowSteps({ steps }: { steps: Step[] }) {
  const [picked, setPicked] = useState(false);
  const [on, setOn] = useTurns(steps.length, TURN_MS, picked);
  const last = steps.length - 1;
  return (
    <div>
      <div className="relative">
        <div aria-hidden="true" className="absolute left-[6%] right-[6%] top-8 hidden h-0.5 bg-line md:block" />
        <div
          aria-hidden="true"
          className="absolute left-[6%] top-8 hidden h-0.5 bg-brand shadow-[0_0_14px_rgb(2_73_254/0.6)] transition-[width] duration-700 ease-out md:block"
          style={{ width: `${(on / Math.max(last, 1)) * 88}%` }}
        />
        <ol className="relative grid grid-cols-3 gap-y-8 md:flex md:justify-between" aria-label="Steps">
          {steps.map((step, i) => (
            <li key={i} className="md:flex-1">
              <button
                type="button"
                aria-pressed={on === i}
                aria-controls={`flow-panel-${i}`}
                onClick={() => {
                  setPicked(true);
                  setOn(i);
                }}
                className="group mx-auto flex flex-col items-center text-center"
              >
                <span
                  className={cn(
                    "grid h-16 w-16 place-items-center rounded-[1.25rem] border transition-all duration-500",
                    on === i ? "scale-110 border-brand bg-brand text-brand-contrast shadow-[0_14px_30px_-10px_rgb(2_73_254/0.7)]" : i < on ? "border-brand/40 bg-surface text-brand" : "border-line bg-surface text-muted group-hover:text-text",
                  )}
                >
                  <SiteIcon name={step.icon ?? "check"} className="h-6 w-6" />
                </span>
                <span className={cn("mt-3.5 text-[15px] font-semibold", on === i ? "text-text" : "text-muted")}>{step.title}</span>
                {step.caption && <span className="mt-0.5 text-[13px] text-subtle">{step.caption}</span>}
              </button>
            </li>
          ))}
        </ol>
      </div>
      <div className="mx-auto mt-12 max-w-5xl">
        {steps.map((step, i) => (
          <div
            key={i}
            id={`flow-panel-${i}`}
            hidden={on !== i}
            className="site-rise grid items-center gap-8 rounded-[1.75rem] border border-line bg-surface p-7 shadow-[0_40px_80px_-50px_rgb(11_13_20/0.35)] sm:p-9 md:grid-cols-[1fr_1.2fr]"
          >
            <div>
              <h3 className="text-2xl font-semibold leading-tight tracking-[-0.03em] text-text sm:text-3xl">{step.heading}</h3>
              <p className="mt-3 text-base leading-7 text-muted">{step.body}</p>
            </div>
            {step.lines.length > 0 && (
              <div className="rounded-2xl bg-surface-sunken p-5 text-sm">
                <div className="mb-2 flex justify-end">
                  <SampleBadge />
                </div>
                {step.lines.map((line, k) => (
                  <div key={k} className={cn("flex justify-between gap-4 border-b border-dashed border-line py-2", k === step.lines.length - 1 && "border-0 font-semibold text-text")}>
                    <span className={k === step.lines.length - 1 ? "" : "text-muted"}>{line.label}</span>
                    <span className="tabular-nums">{line.value}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}
