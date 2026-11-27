"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * The public website's motion (owner, 18 Nov 2026 — "use react components and animations"): what rises as it comes into
 * view, figures that count up, and a word that takes turns. The styles are globals.css's `site-*`; each stops for a
 * visitor who asks for less motion. What a crawler or a reader without script sees is the finished state: everything
 * starts shown on the server and is only hidden once this runs.
 */

/** Whether the visitor asked for less motion. */
function reducedMotion() {
  return typeof window !== "undefined" && window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;
}

/** Rises into view the first time it's on screen. `delay` in ms, for a row of them one after another. */
export function Reveal({ children, delay = 0, className, as: Tag = "div" }: { children: ReactNode; delay?: number; className?: string; as?: "div" | "li" }) {
  const ref = useRef<HTMLDivElement & HTMLLIElement>(null);
  // Shown until mounted, so the server's HTML is whole; then hidden until on screen, unless already there.
  const [state, setState] = useState<"server" | "waiting" | "shown">("server");
  useEffect(() => {
    const el = ref.current;
    if (!el || reducedMotion() || typeof IntersectionObserver === "undefined") return setState("shown");
    const rect = el.getBoundingClientRect();
    if (rect.top < window.innerHeight * 0.92) return setState("shown");
    setState("waiting");
    const io = new IntersectionObserver(
      ([entry]) => {
        if (!entry?.isIntersecting) return;
        setState("shown");
        io.disconnect();
      },
      { threshold: 0.12 },
    );
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return (
    <Tag
      ref={ref}
      className={cn(state !== "server" && "site-reveal", className)}
      data-shown={state === "shown" ? "" : undefined}
      style={delay && state !== "server" ? { transitionDelay: `${delay}ms` } : undefined}
    >
      {children}
    </Tag>
  );
}

/**
 * A figure that counts up from nothing when it comes into view: "48", "14 days", "₹1.2 L". Only the leading number
 * counts; the rest is kept as written. A figure without one is shown as it is.
 */
export function CountUp({ value, className }: { value: string; className?: string }) {
  const match = /^(\D*?)(\d[\d,]*(?:\.\d+)?)(.*)$/.exec(value);
  const target = match ? Number(match[2]!.replace(/,/g, "")) : NaN;
  const decimals = match?.[2]?.includes(".") ? match[2].split(".")[1]!.length : 0;
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState<number | null>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || !Number.isFinite(target) || reducedMotion() || typeof IntersectionObserver === "undefined") return;
    let frame = 0;
    const io = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      io.disconnect();
      const start = performance.now();
      const step = (now: number) => {
        const p = Math.min(1, (now - start) / 1400);
        setShown(target * (1 - Math.pow(1 - p, 3)));
        if (p < 1) frame = requestAnimationFrame(step);
      };
      frame = requestAnimationFrame(step);
    });
    setShown(0);
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(frame);
    };
  }, [target]);
  if (!match || !Number.isFinite(target) || shown === null) return <span ref={ref} className={className}>{value}</span>;
  const n = shown >= target ? target : shown;
  const text = decimals ? n.toFixed(decimals) : Math.round(n).toLocaleString("en-IN");
  return (
    <span ref={ref} className={className} aria-label={value}>
      {match[1]}
      {text}
      {match[3]}
    </span>
  );
}

/** A number that moves on by one every `ms`, for things that take turns; `pause` holds it. */
export function useTurns(count: number, ms: number, pause = false): [number, (i: number) => void] {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (count < 2 || pause || reducedMotion()) return;
    const t = setInterval(() => setI((x) => (x + 1) % count), ms);
    return () => clearInterval(t);
  }, [count, ms, pause, i]);
  return [i % Math.max(count, 1), setI];
}

/** Words that take turns in place — the hero's "sales", "invoices", "books"… Screen readers hear them all, once. */
export function RotatingWords({ words, className }: { words: string[]; className?: string }) {
  const [i] = useTurns(words.length, 2200);
  return (
    <>
      <span className="sr-only">{words.join(", ")}</span>
      <span aria-hidden="true" className={cn("relative inline-block overflow-hidden whitespace-nowrap pb-[0.08em] align-bottom", className)}>
        <span key={i} className="site-word">
          {words[i]}
        </span>
      </span>
    </>
  );
}
