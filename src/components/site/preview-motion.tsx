"use client";

import { useEffect, useRef, type ReactNode } from "react";

/**
 * Plays a product preview's loop only while it is on screen (owner, 16 Nov 2026: "use gifs also where ever
 * required" — chosen as animated previews rather than screen recordings). The loops themselves are CSS
 * (`.pv` in src/app/globals.css): paused until this marks the preview as seen, so a preview below the fold, in a
 * hidden tab, or without JavaScript stays still on its first frame — which is the static picture.
 */
export function PreviewMotion({ children }: { children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = ref.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const seen = new IntersectionObserver(([entry]) => {
      el.dataset.motion = entry?.isIntersecting ? "on" : "off";
    }, { threshold: 0.3 });
    seen.observe(el);
    return () => seen.disconnect();
  }, []);
  return (
    <div ref={ref} className="pv">
      {children}
    </div>
  );
}
