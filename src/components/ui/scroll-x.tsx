"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { cn } from "@/lib/utils";

/**
 * A wide table's sideways scroll with a second scrollbar above it (owner, 20 Nov 2026: "for scroll i need to go down !
 * i need above also"). The top bar stays in reach while the table is on screen — it sticks under the app's top bar
 * (56px; `underHeader={false}` on pages without one, as a guest's) — and moves with the bottom one either way. It
 * shows only when the table is wider than its box.
 */
export function ScrollX({ className, children, underHeader = true }: { className?: string; children: ReactNode; underHeader?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  const bar = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [wide, setWide] = useState(false);
  const moving = useRef<"box" | "bar" | null>(null);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    // The observer reports once on observing, then on every change of the box or the table inside it.
    const ro = new ResizeObserver(() => {
      setWidth(el.scrollWidth);
      setWide(el.scrollWidth > el.clientWidth + 1);
    });
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => ro.disconnect();
  }, []);

  const follow = (from: "box" | "bar") => {
    if (moving.current && moving.current !== from) return;
    moving.current = from;
    const src = from === "box" ? box.current : bar.current;
    const dst = from === "box" ? bar.current : box.current;
    if (src && dst && dst.scrollLeft !== src.scrollLeft) dst.scrollLeft = src.scrollLeft;
    requestAnimationFrame(() => {
      moving.current = null;
    });
  };

  return (
    <>
      {wide && (
        <div ref={bar} onScroll={() => follow("bar")} aria-hidden="true" className={cn("sticky z-[3] mb-1 overflow-x-auto overflow-y-hidden rounded-base bg-surface/90 backdrop-blur-sm", underHeader ? "top-14" : "top-0")}>
          <div style={{ width, height: 1 }} />
        </div>
      )}
      <div ref={box} onScroll={() => follow("box")} className={cn("relative overflow-x-auto", className)}>
        {children}
      </div>
    </>
  );
}
