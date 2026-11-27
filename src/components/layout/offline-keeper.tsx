"use client";

import { useEffect, useState } from "react";
import { usePathname } from "next/navigation";
import { WifiOff } from "lucide-react";
import { useClock } from "@/components/time/clock-provider";

/**
 * The page's half of working offline (owner, 6 Nov 2026 — public/sw.js holds the rules). Tells the service worker that
 * this signed-in page may be kept, for whom — or, with no `userKey` (viewing as somebody, setup still to finish), that
 * it may not. And says so when offline: what's on screen is the last copy, and nothing done now will save.
 */
export function OfflineKeeper({ userKey }: { userKey: string | null }) {
  const pathname = usePathname();
  const clock = useClock();
  const [offline, setOffline] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  useEffect(() => {
    const update = () => setOffline(!navigator.onLine);
    update();
    window.addEventListener("online", update);
    window.addEventListener("offline", update);
    return () => {
      window.removeEventListener("online", update);
      window.removeEventListener("offline", update);
    };
  }, []);

  useEffect(() => {
    if (!("serviceWorker" in navigator) || !window.isSecureContext) return;
    let live = true;
    void navigator.serviceWorker.ready
      .then((registration) => {
        if (!live) return;
        const worker = registration.active;
        // Installed on the home screen, every work page is kept, not only those opened: its next start may have no internet.
        const installed = window.matchMedia("(display-mode: standalone)").matches || (navigator as Navigator & { standalone?: boolean }).standalone === true;
        if (navigator.onLine) worker?.postMessage(userKey ? { type: "deskzo-keep", userKey, pathname, all: installed } : { type: "deskzo-dont-keep" });
        // A copy shown because the server couldn't be reached, even where the phone believes it's online (a dead Wi-Fi).
        const controller = navigator.serviceWorker.controller;
        if (!controller) return;
        const channel = new MessageChannel();
        channel.port1.onmessage = (event: MessageEvent<{ savedAt: number | null }>) => {
          if (live) setSavedAt(event.data.savedAt);
        };
        controller.postMessage({ type: "deskzo-copy-age" }, [channel.port2]);
      })
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, [pathname, userKey]);

  if (!offline && savedAt === null) return null;
  return (
    <div role="status" className="flex items-center gap-2 border-b border-warning/40 bg-warning-bg px-4 py-2 text-sm text-warning">
      <WifiOff className="h-4 w-4 shrink-0" aria-hidden />
      <span>
        You&apos;re offline{savedAt !== null ? ` — this is the page as it was at ${clock.dateTimeShort(new Date(savedAt))}` : ""}. Nothing you change will save until you&apos;re back online.
      </span>
    </div>
  );
}
