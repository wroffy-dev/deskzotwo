/**
 * UTM tags on the links in the emails Deskzo sends (owner, 1 Nov 2026): every web link in a campaign, a journey or a
 * workflow's email gets `utm_source`, `utm_medium=email`, `utm_campaign` (the campaign's, journey's or workflow's
 * name) and `utm_content` (the template's), so a visit from an email shows as one in the website's analytics — and a
 * form filled in on that visit brings the tags to the lead (src/lib/lead-capture/intake.ts), so a campaign's report
 * can count the leads it brought.
 *
 * A tag a link already has is kept, never replaced; `mailto:`, `tel:`, anchors and the app's own links (the
 * preference centre, unsubscribe) are left alone; and a workspace may tag only its own websites. Tagged before the
 * click tracker wraps the link (src/lib/marketing/html.ts), so the place the click lands carries them.
 *
 * Pure — the settings are read on the server (src/lib/marketing/utm-settings.ts).
 */

export type UtmSettings = {
  on: boolean;
  /** Where the visits say they came from — the workspace's own word, "deskzo" until it chooses one. */
  source: string;
  /** Only links to these sites, when set; every site otherwise. */
  ownSitesOnly: boolean;
  domains: string[];
};

export const DEFAULT_UTM: UtmSettings = { on: true, source: "deskzo", ownSitesOnly: false, domains: [] };

/** The stored value read back, every gap filled with the default. */
export function readUtm(value: unknown): UtmSettings {
  const v = (value && typeof value === "object" ? value : {}) as Partial<UtmSettings>;
  return {
    on: typeof v.on === "boolean" ? v.on : DEFAULT_UTM.on,
    source: typeof v.source === "string" && utmSlug(v.source) ? utmSlug(v.source) : DEFAULT_UTM.source,
    ownSitesOnly: typeof v.ownSitesOnly === "boolean" ? v.ownSitesOnly : DEFAULT_UTM.ownSitesOnly,
    domains: Array.isArray(v.domains) ? v.domains.map((d) => cleanDomain(String(d))).filter((d): d is string => !!d).slice(0, 20) : [],
  };
}

/** "M365 Renewal — Nov 2026" as "m365-renewal-nov-2026": what analytics tools group by. */
export function utmSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/** "https://www.Wroffy.com/x" or "wroffy.com" as "wroffy.com"; null for what isn't a domain. */
export function cleanDomain(raw: string): string | null {
  let d = raw.trim().toLowerCase();
  if (d.includes("://")) d = d.slice(d.indexOf("://") + 3);
  d = d.split("/")[0]!.split("?")[0]!.split(":")[0]!.replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d) ? d : null;
}

export type UtmTags = { campaign: string; content?: string | null };

/**
 * One address with the tags added — or as it was: not a web link, the app's own (`skipOrigin`), not one of the
 * workspace's sites when only those are tagged, or not an address at all.
 */
export function tagUrl(url: string, settings: UtmSettings, tags: UtmTags, skipOrigin?: string | null): string {
  if (!settings.on || !/^https?:\/\//i.test(url.trim())) return url;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return url;
  }
  if (skipOrigin) {
    try {
      if (parsed.origin === new URL(skipOrigin).origin) return url;
    } catch {
      // An origin that doesn't parse skips nothing.
    }
  }
  const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
  if (settings.ownSitesOnly && !settings.domains.some((d) => host === d || host.endsWith(`.${d}`))) return url;
  const add = (key: string, value: string | null | undefined) => {
    if (value && !parsed.searchParams.has(key)) parsed.searchParams.set(key, value);
  };
  add("utm_source", settings.source);
  add("utm_medium", "email");
  add("utm_campaign", utmSlug(tags.campaign));
  add("utm_content", tags.content ? utmSlug(tags.content) : null);
  return parsed.toString();
}

const decode = (s: string) => s.replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
const encodeAttr = (s: string) => s.replace(/&/g, "&amp;").replace(/"/g, "&quot;");

/** Every `<a href>` in an HTML email, tagged. */
export function tagHtmlLinks(html: string, settings: UtmSettings, tags: UtmTags, skipOrigin?: string | null): string {
  if (!settings.on) return html;
  return html.replace(/(<a\b[^>]*?\bhref\s*=\s*")([^"]*)(")/gi, (whole, before: string, href: string, after: string) => {
    const tagged = tagUrl(decode(href), settings, tags, skipOrigin);
    return tagged === decode(href) ? whole : `${before}${encodeAttr(tagged)}${after}`;
  });
}

/** Every web address written out in a plain-text email, tagged — a full stop or bracket after one stays outside it. */
export function tagTextLinks(text: string, settings: UtmSettings, tags: UtmTags, skipOrigin?: string | null): string {
  if (!settings.on) return text;
  return text.replace(/https?:\/\/[^\s<>"']+/gi, (found) => {
    const trail = /[).,;:!?]+$/.exec(found)?.[0] ?? "";
    const url = trail ? found.slice(0, -trail.length) : found;
    return `${tagUrl(url, settings, tags, skipOrigin)}${trail}`;
  });
}
