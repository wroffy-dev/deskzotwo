"use client";

import { useEffect, useRef } from "react";
import { usePathname, useRouter } from "next/navigation";
import { stillNeedsSetup } from "@/actions/forced-setup";

/**
 * Keeps somebody on My profile until they've chosen their own password or set up two-factor authentication
 * (src/lib/forced-setup.ts). The layout redirects on a full page load; this does it on every move after, which the
 * layout can't — it isn't drawn again between pages. Leaving /profile asks the server again, so the moment the setup
 * is done they go where they clicked.
 */
export function ForcedSetupGuard() {
  const pathname = usePathname();
  const router = useRouter();
  const done = useRef(false);

  useEffect(() => {
    if (done.current || pathname.startsWith("/profile")) return;
    let live = true;
    void stillNeedsSetup().then((needed) => {
      if (!live) return;
      if (needed) router.replace("/profile");
      else {
        done.current = true;
        router.refresh();
      }
    });
    return () => {
      live = false;
    };
  }, [pathname, router]);

  return null;
}
