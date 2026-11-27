import { ImageResponse } from "next/og";
import { fill } from "@/components/site/links";
import { DESKZO_BLUE, deskzoWordmarkSvg } from "@/lib/brand/deskzo-logo";
import { getSitePage, getSiteSettings, siteStatus } from "@/lib/platform/site-content";

/**
 * A page's card for link previews, /share/<page> (owner, 16 Nov 2026: the publish run warned "No image when shared:
 * link previews on LinkedIn, WhatsApp or X are text only"). Drawn from the page's own words — its section and its
 * search title — on the brand, 1200 × 630 as Open Graph and X want it. Used when a page has no sharing image of its
 * own and the site has no default (src/lib/seo/metadata.ts `shareCardPath`).
 *
 * Only for a page the site publishes: any other address is "not found", so this can't be made to draw words of
 * someone else's choosing under the brand.
 */

const SECTIONS: Record<string, string> = { compare: "Compare", product: "Product", solutions: "Solutions", resources: "Resources", partners: "Partners" };
const svgDataUrl = (svg: string) => `data:image/svg+xml;base64,${Buffer.from(svg).toString("base64")}`;

export async function GET(_request: Request, { params }: RouteContext<"/platform-site/share/[...slug]">) {
  const { slug: parts } = await params;
  const slug = parts.join("/");
  const [page, settings, status] = await Promise.all([getSitePage(slug), getSiteSettings(), siteStatus()]);
  if (!page) return new Response("Not found.", { status: 404, headers: { "cache-control": "no-store" } });
  const ctx = { settings, trialDays: status.trialDays };
  const title = fill(page.seo.title || page.title, ctx).trim();
  const shown = title.length > 96 ? `${title.slice(0, 93).trimEnd()}…` : title;
  const section = parts.length > 1 ? (SECTIONS[parts[0]!] ?? fill(page.title, ctx)) : fill(page.title, ctx);
  const domain = settings.displayDomain || settings.siteName;

  return new ImageResponse(
    (
      <div style={{ width: "100%", height: "100%", display: "flex", flexDirection: "column", justifyContent: "space-between", padding: "64px 72px", background: "linear-gradient(135deg, #FFFFFF 0%, #EEF3FF 60%, #DCE6FF 100%)" }}>
        <div style={{ display: "flex", alignItems: "center" }}>
          {/* eslint-disable-next-line @next/next/no-img-element -- drawn into a PNG, never shown as a page */}
          <img src={svgDataUrl(deskzoWordmarkSvg(DESKZO_BLUE))} height={56} alt="" />
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          {section && section !== shown && (
            <div style={{ display: "flex", fontSize: 30, fontWeight: 600, color: DESKZO_BLUE, textTransform: "uppercase", letterSpacing: 3, marginBottom: 20 }}>{section}</div>
          )}
          <div style={{ display: "flex", fontSize: shown.length > 60 ? 58 : 70, fontWeight: 700, lineHeight: 1.1, color: "#0B1220", letterSpacing: -1 }}>{shown}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", fontSize: 28, color: "#475569" }}>
          <span>{domain}</span>
          <span style={{ display: "flex", width: 120, height: 8, borderRadius: 4, background: DESKZO_BLUE }} />
        </div>
      </div>
    ),
    {
      width: 1200,
      height: 630,
      // A day at the edge, an hour in a browser: a retitled page's card catches up within the day.
      headers: { "cache-control": "public, max-age=3600, s-maxage=86400" },
    },
  );
}
