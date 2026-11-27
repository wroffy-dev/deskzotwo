"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight, LoaderCircle } from "lucide-react";

/**
 * The home page's box for the live demo (owner, 22 Nov 2026): the visitor's website in, and the demo opens on a page of
 * its own — deskzo.com/try/<website>, src/components/site/live-demo-run.tsx — with the steps down the left and the
 * work on the right, as explee.com does. Only the address is checked here; the page does the rest.
 */

/** "https://www.Acme.in/about" → "acme.in"; null when it can't be a website. */
function siteOf(raw: string): string | null {
  const host = raw.trim().toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#\s]/)[0] ?? "";
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(host) ? host : null;
}

export function LiveDemoView({ placeholder, note }: { placeholder: string; note?: string }) {
  const router = useRouter();
  const [website, setWebsite] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [going, setGoing] = useState(false);
  const trap = useRef<HTMLInputElement>(null);

  function start() {
    const site = siteOf(website);
    if (!site) {
      setError("Enter your website, like acmepumps.in");
      return;
    }
    // A form a bot filled: nothing opens.
    if (trap.current?.value) return;
    setGoing(true);
    router.push(`/try/${encodeURIComponent(site)}`);
  }

  return (
    <div className="mx-auto mt-10 max-w-2xl text-left">
      <form
        className="flex flex-col gap-2 sm:flex-row"
        onSubmit={(e) => {
          e.preventDefault();
          start();
        }}
      >
        <label htmlFor="live-demo-website" className="sr-only">
          Your website
        </label>
        <input
          id="live-demo-website"
          value={website}
          onChange={(e) => {
            setWebsite(e.target.value);
            setError(null);
          }}
          placeholder={placeholder}
          autoComplete="url"
          inputMode="url"
          className="h-12 flex-1 rounded-lg border border-line bg-surface px-4 text-base text-text outline-none focus:border-brand"
        />
        {/* A person never sees or fills this. */}
        <input ref={trap} name="confirm_url" tabIndex={-1} autoComplete="off" aria-hidden="true" className="hidden" />
        <button type="submit" disabled={going} className="inline-flex h-12 items-center justify-center gap-2 rounded-lg bg-brand px-6 font-medium text-white disabled:opacity-70">
          {going ? "Opening…" : "Try it"}
          {going ? <LoaderCircle className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ArrowRight className="h-4 w-4" aria-hidden="true" />}
        </button>
      </form>
      <p role="alert" className="mt-2 min-h-5 text-sm text-danger">
        {error}
      </p>
      {note && <p className="text-sm text-muted">{note}</p>}
    </div>
  );
}
