/**
 * A form on the business's own website (owner, 1 Nov 2026 — the gaps against Mailchimp, Brevo, MailerLite): a pop-up
 * that a line of script shows there — after some seconds, part way down the page, or as the visitor goes to leave — and
 * a landing page its public address becomes, with a picture, a few highlights and a quote beside the form. Client-safe:
 * the settings page checks with this too; src/lib/forms/website.ts reads them.
 */

import { TEXT_MAX } from "@/lib/text/bounded";

export type PopupSettings = {
  on: boolean;
  trigger: "delay" | "scroll" | "exit";
  /** Seconds on the page, for "delay". */
  delay: number;
  /** How far down the page, in %, for "scroll". */
  scroll: number;
  /** Shown to the same visitor at most once in this many days. */
  everyDays: number;
  /** In the middle with the page dimmed, or in a corner. */
  position: "center" | "corner";
};

export type LandingSettings = {
  on: boolean;
  /** An https address of a picture. */
  image: string | null;
  highlights: string[];
  quote: string | null;
  quoteBy: string | null;
};

export const DEFAULT_POPUP: PopupSettings = { on: false, trigger: "delay", delay: 10, scroll: 50, everyDays: 7, position: "center" };
export const DEFAULT_LANDING: LandingSettings = { on: false, image: null, highlights: [], quote: null, quoteBy: null };

export const WEBSITE_LIMITS = { highlights: 6, highlight: 120, quote: 300, quoteBy: 80 } as const;

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const clamp = (v: unknown, lo: number, hi: number, d: number) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : d;
};
const text = (v: unknown, max: number) => (typeof v === "string" && v.trim() ? v.trim().slice(0, max) : null);

/** An https picture address, or null — never anything a page could be made to load from elsewhere. */
export function httpsImage(v: unknown): string | null {
  // An address past a URL's length is refused rather than cut (owner, 15 Nov 2026 — input bounds).
  if (typeof v !== "string" || !v.trim() || v.trim().length > TEXT_MAX.url) return null;
  try {
    const url = new URL(v.trim());
    return url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}

export function popupOf(raw: unknown): PopupSettings {
  if (!isObj(raw)) return DEFAULT_POPUP;
  return {
    on: raw.on === true,
    trigger: raw.trigger === "scroll" ? "scroll" : raw.trigger === "exit" ? "exit" : "delay",
    delay: clamp(raw.delay, 3, 120, DEFAULT_POPUP.delay),
    scroll: clamp(raw.scroll, 10, 90, DEFAULT_POPUP.scroll),
    everyDays: clamp(raw.everyDays, 1, 90, DEFAULT_POPUP.everyDays),
    position: raw.position === "corner" ? "corner" : "center",
  };
}

export function landingOf(raw: unknown): LandingSettings {
  if (!isObj(raw)) return DEFAULT_LANDING;
  return {
    on: raw.on === true,
    image: httpsImage(raw.image),
    highlights: Array.isArray(raw.highlights) ? raw.highlights.map((h) => text(h, WEBSITE_LIMITS.highlight)).filter((h): h is string => !!h).slice(0, WEBSITE_LIMITS.highlights) : [],
    quote: text(raw.quote, WEBSITE_LIMITS.quote),
    quoteBy: text(raw.quoteBy, WEBSITE_LIMITS.quoteBy),
  };
}

/** The settings page's input, checked: why it can't be saved, or what to keep. */
export function checkWebsite(input: { popup?: unknown; landing?: unknown }): { ok: true; popup: PopupSettings; landing: LandingSettings } | { ok: false; error: string } {
  const landingIn = isObj(input.landing) ? input.landing : {};
  if (typeof landingIn.image === "string" && landingIn.image.trim() && !httpsImage(landingIn.image)) return { ok: false, error: "Give the picture as an https:// address." };
  if (Array.isArray(landingIn.highlights) && landingIn.highlights.filter((h) => typeof h === "string" && h.trim()).length > WEBSITE_LIMITS.highlights) return { ok: false, error: `Keep it to ${WEBSITE_LIMITS.highlights} highlights.` };
  return { ok: true, popup: popupOf(input.popup), landing: landingOf(input.landing) };
}

/** The line a website pastes before </body> to show a form's pop-up. */
export function popupSnippet(origin: string, slug: string): string {
  return `<script src="${origin}/api/forms/public/popup.js" data-form="${slug}" async></script>`;
}

/**
 * The pop-up's script, the same for every form (the tag's data-form says which). It asks for the form's pop-up settings,
 * waits for its moment, and shows the form's own page — its fields, its checks, its double opt-in — in a frame. Once a
 * visitor has seen it, not again for `everyDays`; remembered in the browser only, no cookie. Closes itself a moment
 * after the form says it's done.
 */
export const POPUP_SCRIPT = `(function () {
  var tag = document.currentScript;
  if (!tag) return;
  var slug = tag.getAttribute("data-form");
  var base;
  try { base = new URL(tag.src).origin; } catch (e) { return; }
  if (!slug) return;
  var key = "deskzo-popup:" + slug;
  var last = 0;
  try { last = Number(window.localStorage.getItem(key)) || 0; } catch (e) {}
  fetch(base + "/api/forms/public/popup/" + encodeURIComponent(slug)).then(function (r) { return r.json(); }).then(function (c) {
    if (!c || !c.on) return;
    if (last && Date.now() - last < c.everyDays * 86400000) return;
    var shown = false;
    function show() {
      if (shown) return;
      shown = true;
      try { window.localStorage.setItem(key, String(Date.now())); } catch (e) {}
      build(c);
    }
    if (c.trigger === "scroll") {
      var onScroll = function () {
        var h = document.documentElement;
        var seen = ((h.scrollTop || document.body.scrollTop) + window.innerHeight) / Math.max(1, h.scrollHeight) * 100;
        if (seen >= c.scroll) { window.removeEventListener("scroll", onScroll); show(); }
      };
      window.addEventListener("scroll", onScroll, { passive: true });
    } else if (c.trigger === "exit") {
      var onOut = function (e) { if (!e.relatedTarget && e.clientY <= 0) { document.removeEventListener("mouseout", onOut); show(); } };
      document.addEventListener("mouseout", onOut);
      // A phone has no mouse to leave with: after half a minute instead.
      setTimeout(show, 30000);
    } else {
      setTimeout(show, c.delay * 1000);
    }
  }).catch(function () {});

  function build(c) {
    var corner = c.position === "corner";
    var shade = document.createElement("div");
    shade.setAttribute("role", "dialog");
    shade.setAttribute("aria-label", c.title || "Sign up");
    shade.style.cssText = corner
      ? "position:fixed;right:16px;bottom:16px;z-index:2147483646;width:380px;max-width:calc(100vw - 32px)"
      : "position:fixed;inset:0;z-index:2147483646;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;padding:16px";
    var box = document.createElement("div");
    box.style.cssText = "position:relative;width:" + (corner ? "100%" : "480px") + ";max-width:100%;height:" + (corner ? "520px" : "640px") + ";max-height:calc(100vh - 32px);background:#fff;border-radius:14px;box-shadow:0 12px 40px rgba(0,0,0,.3);overflow:hidden";
    var close = document.createElement("button");
    close.type = "button";
    close.setAttribute("aria-label", "Close");
    close.textContent = "×";
    close.style.cssText = "position:absolute;top:6px;right:8px;z-index:1;border:0;background:#fff;border-radius:50%;width:30px;height:30px;font-size:20px;line-height:1;cursor:pointer;color:#333";
    var frame = document.createElement("iframe");
    frame.src = c.url;
    frame.title = c.title || "Sign up";
    frame.style.cssText = "border:0;width:100%;height:100%";
    box.appendChild(close);
    box.appendChild(frame);
    shade.appendChild(box);
    document.body.appendChild(shade);
    function done() {
      if (shade.parentNode) shade.parentNode.removeChild(shade);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("message", onMessage);
    }
    function onKey(e) { if (e.key === "Escape") done(); }
    function onMessage(e) { if (e.origin === base && e.data && e.data.type === "deskzo-form-done") setTimeout(done, 2500); }
    close.addEventListener("click", done);
    if (!corner) shade.addEventListener("click", function (e) { if (e.target === shade) done(); });
    document.addEventListener("keydown", onKey);
    window.addEventListener("message", onMessage);
  }
})();
`;
