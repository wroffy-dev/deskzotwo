/**
 * The deeper campaign report (owner, 1 Nov 2026 — the gaps against Mailchimp, Brevo, Zoho Campaigns): where on the
 * email people clicked, and how its rates sit against the workspace's own campaigns and what B2B email usually gets.
 * Pure and client-safe; the figures come from src/lib/marketing/campaign-insights.ts.
 */

/**
 * What B2B email typically gets, as the big senders publish it (Mailchimp, Campaign Monitor, HubSpot benchmark
 * reports, 2023–25). Opens are inflated since Apple's Mail Privacy Protection opens every email it receives, so
 * the range is wide; clicks are the figure to trust.
 */
export const B2B_TYPICAL = {
  open: { low: 0.2, high: 0.35 },
  click: { low: 0.02, high: 0.04 },
  unsubscribe: { low: 0, high: 0.005 },
} as const;

export type Rate = "open" | "click" | "unsubscribe";

/** How a rate compares, in words: against the typical range, and against the workspace's own average if it has one. */
export function compareRate(kind: Rate, rate: number | null, own: number | null): { typical: string; vsOwn: string | null; tone: "good" | "fair" | "poor" } {
  const band = B2B_TYPICAL[kind];
  const percent = (n: number) => `${(n * 100).toFixed(n < 0.1 ? 1 : 0)}%`;
  const typical = `B2B email usually ${kind === "unsubscribe" ? "stays under" : "gets"} ${kind === "unsubscribe" ? percent(band.high) : `${percent(band.low)}–${percent(band.high)}`}`;
  if (rate === null) return { typical, vsOwn: null, tone: "fair" };
  // For unsubscribes, lower is better.
  const better = kind === "unsubscribe" ? rate <= band.high : rate >= band.high;
  const worse = kind === "unsubscribe" ? rate > band.high * 2 : rate < band.low;
  let vsOwn: string | null = null;
  if (own !== null && own > 0) {
    const diff = (rate - own) / own;
    vsOwn = Math.abs(diff) < 0.1 ? "about your usual" : `${Math.round(Math.abs(diff) * 100)}% ${diff > 0 ? "above" : "below"} your usual ${percent(own)}`;
  }
  return { typical, vsOwn, tone: better ? "good" : worse ? "poor" : "fair" };
}

/** A link's address as one key, so the tracker's stored URL and the email's link match despite small differences. */
export function linkKey(url: string): string {
  try {
    const u = new URL(url);
    u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return url.trim();
  }
}

/** The real address behind a tracked link — `/track/<token>?u=<url>` — or the link itself if it isn't tracked. */
function destinationOf(href: string): string {
  const decoded = href.replace(/&amp;/g, "&");
  try {
    const u = new URL(decoded);
    if (/\/track\/[^/]+$/.test(u.pathname) && u.searchParams.get("u")) return u.searchParams.get("u")!;
  } catch {
    // Not an absolute address: leave it as it is.
  }
  return decoded;
}

/**
 * The sent email with each link's clicks laid on it — a badge beside every link, its colour by share of the clicks:
 * a heatmap of what drew people in, in the email as they saw it.
 */
export function clickHeatmap(html: string, clicks: { url: string; clicks: number }[]): string {
  const byKey = new Map<string, number>();
  for (const c of clicks) byKey.set(linkKey(c.url), (byKey.get(linkKey(c.url)) ?? 0) + c.clicks);
  const total = [...byKey.values()].reduce((t, n) => t + n, 0);
  if (total === 0) return html;
  return html.replace(/(<a\b[^>]*\bhref\s*=\s*"([^"]*)"[^>]*>[\s\S]*?<\/a>)/gi, (whole: string, _link: string, href: string) => {
    const n = byKey.get(linkKey(destinationOf(href))) ?? 0;
    const share = n / total;
    const colour = n === 0 ? "#94a3b8" : share >= 0.4 ? "#dc2626" : share >= 0.15 ? "#ea580c" : "#ca8a04";
    const badge =
      `<span style="display:inline-block;margin-left:4px;padding:1px 6px;border-radius:9px;background:${colour};color:#fff;` +
      `font:600 11px/16px Arial,sans-serif;vertical-align:middle;white-space:nowrap">${n} · ${Math.round(share * 100)}%</span>`;
    return `${whole}${badge}`;
  });
}
