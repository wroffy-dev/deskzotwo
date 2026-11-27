import { WORLD_COUNTRIES } from "@/lib/geo/world-countries";

/**
 * Who the customer is, as far as can be told without asking them or anybody else (owner, 24 Oct 2026:
 * "show the location of the visitor, new or repeated"). Pure — the bubble's route and the inbox read it.
 *
 *   · Where: Cloudflare's location headers on a website visit — the country on every request, and the
 *     region and city once the zone's "Add visitor location headers" is on — or, for WhatsApp, the
 *     country the number's code belongs to. No outside lookup is made and no IP address is kept.
 *   · Their browser's own time zone (so the team sees their local time), language, and browser and system.
 */

/** "IN" → "India", by the browser's own names; the code itself when it isn't one. */
export function countryName(code: string | null | undefined): string | null {
  if (!code) return null;
  const upper = code.toUpperCase();
  if (!/^[A-Z]{2}$/.test(upper) || upper === "XX" || upper === "T1") return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "region" }).of(upper) ?? upper;
  } catch {
    return upper;
  }
}

/** Calling codes, longest first; where countries share one, the one most customers mean wins ("1" is the US). */
const PREFERRED: Record<string, string> = { "1": "US", "7": "RU", "44": "GB", "61": "AU", "47": "NO", "212": "MA", "590": "GP", "262": "RE", "599": "CW" };
const CALLING = (() => {
  const byCode = new Map<string, string>();
  for (const c of WORLD_COUNTRIES) {
    for (const raw of String(c.phone ?? "").split(/\s*(?:and|,)\s*/)) {
      const digits = raw.replace(/\D/g, "");
      if (digits && !byCode.has(digits)) byCode.set(digits, c.code);
    }
  }
  for (const [code, country] of Object.entries(PREFERRED)) byCode.set(code, country);
  return [...byCode.entries()].sort((a, b) => b[0].length - a[0].length);
})();

/** The country a number in international form belongs to, by its calling code: "919876543210" → "IN". */
export function countryOfNumber(digits: string | null | undefined): string | null {
  const d = String(digits ?? "").replace(/\D/g, "");
  if (d.length < 8) return null;
  return CALLING.find(([code]) => d.startsWith(code))?.[1] ?? null;
}

/** A header Cloudflare (or the host) set, if it's a real value. */
const header = (headers: Pick<Headers, "get">, name: string) => {
  const v = headers.get(name)?.trim();
  return v && v.length <= 80 ? v : null;
};

/** Where a website visitor is, from Cloudflare's headers — nothing when they aren't there (as on this computer). */
export function locationFromHeaders(headers: Pick<Headers, "get">): { country: string | null; region: string | null; city: string | null } {
  const country = header(headers, "cf-ipcountry")?.toUpperCase() ?? null;
  return {
    country: country && countryName(country) ? country : null,
    region: header(headers, "cf-region"),
    city: header(headers, "cf-ipcity"),
  };
}

/** "Chrome on Android", "Safari on iPhone", "Edge on Windows" — from the browser's own description. */
export function deviceFromUserAgent(ua: string | null | undefined): string | null {
  const s = String(ua ?? "");
  if (!s) return null;
  const browser = /Edg\//.test(s)
    ? "Edge"
    : /OPR\/|Opera/.test(s)
      ? "Opera"
      : /SamsungBrowser/.test(s)
        ? "Samsung Internet"
        : /Firefox\//.test(s)
          ? "Firefox"
          : /Chrome\/|CriOS/.test(s)
            ? "Chrome"
            : /Safari\//.test(s)
              ? "Safari"
              : null;
  const system = /iPhone/.test(s)
    ? "iPhone"
    : /iPad/.test(s)
      ? "iPad"
      : /Android/.test(s)
        ? "Android"
        : /Windows/.test(s)
          ? "Windows"
          : /Mac OS X|Macintosh/.test(s)
            ? "Mac"
            : /CrOS/.test(s)
              ? "ChromeOS"
              : /Linux/.test(s)
                ? "Linux"
                : null;
  if (!browser && !system) return null;
  return [browser, system].filter(Boolean).join(" on ");
}

/** A time zone the browser named, if it's one this server knows: "Asia/Kolkata". */
export function validZone(zone: unknown): string | null {
  if (typeof zone !== "string" || zone.length > 64 || !/^[A-Za-z_+\-/0-9]+$/.test(zone)) return null;
  try {
    new Intl.DateTimeFormat("en", { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/** "en-IN" — a browser's language tag, if it looks like one. */
export function validLanguage(tag: unknown): string | null {
  return typeof tag === "string" && /^[a-zA-Z]{2,3}(-[a-zA-Z0-9]{2,8})*$/.test(tag) && tag.length <= 20 ? tag : null;
}

/** "Hindi (India)" — a language tag in words. */
export function languageName(tag: string | null | undefined): string | null {
  if (!tag) return null;
  try {
    return new Intl.DisplayNames(["en"], { type: "language" }).of(tag) ?? tag;
  } catch {
    return tag;
  }
}

/** "Mumbai, Maharashtra, India" — as much as is known. */
export function placeText(v: { city: string | null; region: string | null; country: string | null }): string | null {
  const parts = [v.city, v.region && v.region !== v.city ? v.region : null, countryName(v.country)].filter(Boolean);
  return parts.length ? parts.join(", ") : null;
}

/** A page's address as the panel shows it: the path and query, not the host. */
export function pagePath(url: string): string {
  try {
    const u = new URL(url);
    return `${u.pathname}${u.search}`.slice(0, 120) || "/";
  } catch {
    return url.slice(0, 120);
  }
}

/** The pages kept for a visitor, read whole; anything malformed is left out. */
export function pagesOf(pages: unknown): { url: string; at: string }[] {
  return Array.isArray(pages) ? pages.filter((p): p is { url: string; at: string } => !!p && typeof p.url === "string" && !!p.url && typeof p.at === "string") : [];
}

/** The last ten pages a visitor was on, newest last; the same page twice running counts once. */
export function withPage(pages: unknown, url: string, at: Date): { url: string; at: string }[] {
  const list = pagesOf(pages);
  if (list[list.length - 1]?.url === url) return list;
  return [...list, { url: url.slice(0, 500), at: at.toISOString() }].slice(-10);
}
