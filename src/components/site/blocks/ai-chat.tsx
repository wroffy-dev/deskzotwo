"use client";

import { useEffect, useState, type ReactNode } from "react";
import { useTurns } from "@/components/site/motion";
import { cn } from "@/lib/utils";

/**
 * The AI showcase's chat (owner, 18 Nov 2026): the chosen question in a bubble, its answer typed out after it, the
 * questions taking turns until one is picked. The answer's first sentence — the figure — is brighter. With less
 * motion asked for, the answer is there at once. The whole answer is in the page for assistive technology; the typing
 * is only for the eye.
 */
const TURN_MS = 8000;

export function AiChat({ questions, head, note }: { questions: { question: string; answer: string }[]; head: ReactNode; note?: string }) {
  const [picked, setPicked] = useState(false);
  const [on, setOn] = useTurns(questions.length, TURN_MS, picked);
  const answer = questions[on]?.answer ?? "";
  // How far the answer is typed, and which answer that is: a new answer starts from nothing.
  const [progress, setProgress] = useState<{ of: string; n: number }>({ of: "", n: 0 });
  const [reduced] = useState(() => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    if (reduced) return;
    let n = 0;
    const t = setInterval(() => {
      n += 2;
      setProgress({ of: answer, n: Math.min(n, answer.length) });
      if (n >= answer.length) clearInterval(t);
    }, 22);
    return () => clearInterval(t);
  }, [answer, reduced]);
  const typed = reduced ? answer.length : progress.of === answer ? progress.n : 0;
  // The first sentence is the figure.
  const cut = (() => {
    const m = /^.+?[.!?](\s|$)/.exec(answer);
    return m ? m[0].length : answer.length;
  })();
  const shown = answer.slice(0, typed);
  return (
    <div className="grid items-center gap-12 lg:grid-cols-[1fr_1.1fr] lg:gap-16">
      <div>
        {head}
        <div className="mt-9 flex flex-wrap gap-2.5">
          {questions.map((q, i) => (
            <button
              key={i}
              type="button"
              aria-pressed={on === i}
              onClick={() => {
                setPicked(true);
                setOn(i);
              }}
              className={cn("rounded-full border px-4 py-2 text-left text-sm transition-colors", on === i ? "border-white/40 bg-white/15 text-white" : "border-white/15 text-white/75 hover:bg-white/10 hover:text-white")}
            >
              {q.question}
            </button>
          ))}
        </div>
        {note && <p className="mt-7 text-sm text-white/50">{note}</p>}
      </div>
      <div className="min-h-[22rem] rounded-[1.75rem] border border-white/12 bg-white/[0.05] p-6 backdrop-blur sm:p-8">
        <p key={`q${on}`} className="site-rise ml-auto max-w-[85%] rounded-[1.2rem] rounded-br-md bg-[#0249fe] px-5 py-3.5 text-[15px] leading-6 text-white">
          {questions[on]?.question}
        </p>
        <p className="site-rise mt-4 max-w-[90%] rounded-[1.2rem] rounded-bl-md border border-white/10 bg-white/[0.08] px-5 py-4 text-[15px] leading-7 text-white/85">
          <span className="sr-only">{answer}</span>
          <span aria-hidden="true">
            <span className="font-semibold text-[#c6f432]">{shown.slice(0, cut)}</span>
            {shown.slice(cut)}
            {typed < answer.length && <span className="site-caret" />}
          </span>
        </p>
      </div>
    </div>
  );
}
