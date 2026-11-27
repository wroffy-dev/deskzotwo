/**
 * Website activity (owner, 6 Nov 2026), part of the Customer inbox's website chat — the rules, with nothing to
 * read or write, so the suite can try them. src/lib/inbox/activity.ts does the keeping.
 *
 * What's kept is what a request and a browser ordinarily say, and only for a visitor who agreed. There is no
 * combined "fingerprint": nothing here recognises somebody who declined or cleared their browser, which is what the
 * privacy laws this has to live with (DPDP, GDPR) forbid, and what browsers block anyway. A person is known only by
 * the id their own browser keeps, and by what they chose to tell the business.
 */

/** How long things are kept: the pages a year, the IP address — the one that identifies a line — 90 days. */
export const KEEP_PAGES_DAYS = 365;
export const KEEP_IP_DAYS = 90;
/** A page more than this after the last one starts a new visit. */
export const NEW_VISIT_MS = 30 * 60_000;
/** Who's "on the site now": heard from within two minutes. The bubble says it's there every 20 seconds, while the tab is showing. */
const ON_SITE_MS = 2 * 60_000;
/** A chat somebody started for them is delivered if their browser asks within this; after that they've gone. */
export const INVITE_LASTS_MS = 10 * 60_000;
export const onSiteNow = (lastSeenAt: Date | string, now = Date.now()) => now - new Date(lastSeenAt).getTime() < ON_SITE_MS;
/** The team is told about one visitor at most this often. */
export const ALERT_EVERY_MS = 12 * 60 * 60_000;
/** Nobody has a tab open for long enough to mean more than this. */
const LONGEST_PAGE_SEC = 2 * 60 * 60;

/** The id a browser keeps: long and random, as the bubble makes it. Anything else isn't one. */
export function validVisitorId(raw: unknown): string | null {
  return typeof raw === "string" && /^[A-Za-z0-9_-]{16,64}$/.test(raw) ? raw : null;
}

const text = (v: string | null, max: number) => v?.trim().slice(0, max) || null;

export type CleanPage = { host: string; path: string; utmSource: string | null; utmMedium: string | null; utmCampaign: string | null };

/**
 * A page's address as kept: its site and path, and its campaign tags. The rest of the query string is dropped,
 * as it can carry anything (a search, an email, a reset link) — and so is a path segment that holds an address.
 */
export function cleanPage(raw: unknown): CleanPage | null {
  if (typeof raw !== "string") return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  const path = url.pathname
    .split("/")
    .map((part) => (/@|%40/.test(part) ? "…" : part))
    .join("/");
  return {
    host: url.hostname.toLowerCase().slice(0, 200),
    path: path.slice(0, 300) || "/",
    utmSource: text(url.searchParams.get("utm_source"), 100),
    utmMedium: text(url.searchParams.get("utm_medium"), 100),
    utmCampaign: text(url.searchParams.get("utm_campaign"), 100),
  };
}

/** The site that sent them, when it's another site: "google.com". */
export function referrerHost(raw: unknown, ownHost: string): string | null {
  if (typeof raw !== "string" || !raw) return null;
  try {
    const host = new URL(raw).hostname.toLowerCase().replace(/^www\./, "");
    return host && host !== ownHost.replace(/^www\./, "") ? host.slice(0, 200) : null;
  } catch {
    return null;
  }
}

/** A key page as an admin writes it: "/pricing". Null otherwise. */
export function keyPagePath(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const path = raw.trim().replace(/\/+$/, "");
  return /^\/[^\s?#]{0,200}$/.test(path) ? path.toLowerCase() : null;
}

/** Whether a path is one of the key pages: that page, or one under it. */
export function isKeyPage(path: string, keyPages: readonly string[]): boolean {
  const p = path.toLowerCase().replace(/\/+$/, "") || "/";
  return keyPages.some((k) => p === k || p.startsWith(`${k}/`));
}

/**
 * Phone, tablet or computer. A browser can't say laptop or desktop — nothing it tells a site separates the two.
 * An iPad says it's a Mac, so a "Mac" with a touch screen is one.
 */
export function deviceKind(userAgent: string | null | undefined, touchPoints: unknown): "phone" | "tablet" | "computer" | null {
  const ua = String(userAgent ?? "");
  if (!ua) return null;
  if (/iPad|Tablet|PlayBook|Silk/.test(ua) || (/Macintosh/.test(ua) && Number(touchPoints) > 1)) return "tablet";
  if (/Android/.test(ua) && !/Mobile/.test(ua)) return "tablet";
  if (/iPhone|iPod|Mobile|Android/.test(ua)) return "phone";
  return "computer";
}

/** Crawlers and link previews, which aren't visitors. */
export function isBot(userAgent: string | null | undefined): boolean {
  return /bot|crawl|spider|slurp|preview|headless|lighthouse|facebookexternalhit|whatsapp\/|curl|wget|python-requests/i.test(String(userAgent ?? ""));
}

/** "1920×1080", from what the browser said. */
export function screenSize(raw: unknown): string | null {
  return typeof raw === "string" && /^\d{2,5}x\d{2,5}$/.test(raw) ? raw.replace("x", "×") : null;
}

const HOSTING = /amazon|aws\b|microsoft|azure|google|digitalocean|ovh|hetzner|linode|akamai|cloudflare|oracle|alibaba|tencent|contabo|vultr|m247|datacamp|nordvpn|expressvpn|proton|surfshark|leaseweb/i;
/** Those that carry mobile data and home broadband on the same network, so the network can't tell them apart. */
const CARRIERS = /reliance jio|jio\b|bharti airtel|airtel|vodafone|idea cellular|bsnl|bharat sanchar|mtnl|mahanagar telephone|t-mobile|verizon|at&t|etisalat|du\b|emirates integrated|\bstc\b|mobily|zain/i;
const BROADBAND = /atria convergence|\bact\b|hathway|excitel|tata play|tikona|spectra|gtpl|you broadband|netplus|comcast|charter|spectrum|\bbt\b|sky broadband|virgin media|broadband|fibernet|fiber|cable/i;
const TELECOM = /tata (communications|teleservices)|telecom|internet|net(work)?s?\b|isp\b|online|communications?/i;

export const NETWORK_LABELS: Record<string, string> = {
  mobile: "Mobile data",
  carrier: "Mobile or home network",
  broadband: "Home or office broadband",
  company: "Company network",
  hosting: "Server or VPN",
};

/**
 * What kind of network, as well as can be told — a best guess, and shown as one. The browser says "cellular" only
 * on Android Chrome. Otherwise the network's owner: a carrier here carries both mobile and home lines, and
 * an owner who is no telecom is usually a company on its own line, which is what "office network" can mean.
 */
export function networkKind(org: string | null | undefined, connectionType: unknown): string | null {
  if (connectionType === "cellular") return "mobile";
  const name = String(org ?? "");
  if (!name) return null;
  if (HOSTING.test(name)) return "hosting";
  if (CARRIERS.test(name)) return "carrier";
  if (BROADBAND.test(name)) return "broadband";
  if (TELECOM.test(name)) return "broadband";
  return "company";
}

/** Seconds on a page as a browser reported them: whole, and within reason. Null otherwise. */
export function pageSeconds(raw: unknown): number | null {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? Math.min(Math.round(n), LONGEST_PAGE_SEC) : null;
}

/** "45 s", "3 min", "1 h 20 min". */
export function durationText(seconds: number | null | undefined): string | null {
  if (seconds === null || seconds === undefined) return null;
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min`;
  return `${Math.floor(minutes / 60)} h${minutes % 60 ? ` ${minutes % 60} min` : ""}`;
}

/** The pages in visits, the newest visit first and each in the order they went. */
export function journeyOf<T extends { visitNo: number; at: Date | string }>(views: readonly T[]): { visitNo: number; startedAt: Date; views: T[] }[] {
  const byVisit = new Map<number, T[]>();
  for (const v of views) byVisit.set(v.visitNo, [...(byVisit.get(v.visitNo) ?? []), v]);
  return [...byVisit.entries()]
    .map(([visitNo, list]) => {
      const inOrder = [...list].sort((a, b) => new Date(a.at).getTime() - new Date(b.at).getTime());
      return { visitNo, startedAt: new Date(inOrder[0]!.at), views: inOrder };
    })
    .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime());
}
