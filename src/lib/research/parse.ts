import { decodeEntities, socialLinksFrom, trimDescription, type SocialLinks } from "@/lib/domain-intel/signatures";
import { GST_STATE_CODES } from "@/lib/gst-engine";

/**
 * Research on a company from free public sources (owner, 18 Nov 2026: "what is available for free lets work on that
 * first"). The reading of what was fetched: pure, so the rules can be read and tested without a network. Fetching is
 * src/lib/research/gather.ts; the brief, src/lib/research/brief.ts.
 *
 * Conservative, as Domain Intel is (src/lib/domain-intel/signatures.ts): a salesperson repeats what this says on a
 * call, so saying nothing beats a guess. Only the company's own role addresses (sales@, info@…) are kept from its
 * pages — never a person's — and every fact is kept with where it came from.
 */

/** What the company's own website says about it. */
export type WebsiteFacts = {
  url: string;
  title: string | null;
  description: string | null;
  /** The opening of its About page, in its own words. */
  about: string | null;
  aboutUrl: string | null;
  /** "Founded in 1995", "since 2004"… as the site says it. */
  founded: number | null;
  careersUrl: string | null;
  contactUrl: string | null;
  phones: string[];
  /** Role addresses at its own domain only: sales@, info@, contact@… never a person's. */
  emails: string[];
  social: SocialLinks;
};

export type GstFacts = {
  gstin: string;
  legalName: string | null;
  tradeName: string | null;
  status: string;
  taxpayerType: string | null;
  state: string | null;
  /** What the PAN inside the GSTIN says it is: "A company", "A firm or LLP"… */
  panHolder: string | null;
  checkedAt: string;
};

export type NewsItem = { title: string; url: string; source: string | null; date: string | null };

/** What Refresh gathered, kept on the company's research row. Domain Intel and Apollo keep their own. */
export type ResearchFacts = {
  website?: WebsiteFacts | null;
  websiteError?: string | null;
  gst?: GstFacts[];
  gstNote?: string | null;
  news?: NewsItem[];
  newsError?: string | null;
  /** When each part was gathered (ISO). */
  at?: { website?: string; gst?: string; news?: string };
};

// ─── The website ───────────────────────────────────────────────────────────────────────────────

const PAGE_WORDS = {
  about: /\b(about(-|_)?(us)?|who-?we-?are|our-?(company|story)|company(-profile)?|overview)\b/i,
  careers: /\b(careers?|jobs?|join(-|_)?us|work(-|_)?with(-|_)?us|vacanc(y|ies)|openings|hiring)\b/i,
  contact: /\b(contact(-|_)?(us)?|reach(-|_)?us|get(-|_)?in(-|_)?touch|locations?|offices?)\b/i,
};

/** Links on a page to the same site's About, Careers and Contact pages — by the address, then the link's words. */
export function sitePagesFrom(html: string, base: string): { about: string | null; careers: string | null; contact: string | null } {
  const home = new URL(base);
  const out: { about: string | null; careers: string | null; contact: string | null } = { about: null, careers: null, contact: null };
  for (const match of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"'#]{1,300})["'][^>]*>([\s\S]{0,200}?)<\/a>/gi)) {
    let url: URL;
    try {
      url = new URL(decodeEntities(match[1]!).trim(), home);
    } catch {
      continue;
    }
    if (url.protocol !== "https:" && url.protocol !== "http:") continue;
    // Its own site only: the same host, with or without www.
    if (url.hostname.replace(/^www\./, "") !== home.hostname.replace(/^www\./, "")) continue;
    if (url.pathname === "/" || url.pathname === "") continue;
    const words = `${url.pathname} ${textOf(match[2] ?? "")}`.toLowerCase();
    url.hash = "";
    for (const kind of ["about", "careers", "contact"] as const) {
      if (!out[kind] && PAGE_WORDS[kind].test(words)) out[kind] = url.toString();
    }
  }
  return out;
}

/** A page's readable text: scripts, styles, navigation and footers left out, entities decoded, spaces collapsed. */
export function textOf(html: string): string {
  return decodeEntities(
    html
      .replace(/<(script|style|noscript|svg|nav|footer|header|form)\b[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|section)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .trim();
}

/** The opening of an About page: its paragraphs of real sentences, up to `max` characters, cut at a sentence. */
export function aboutFrom(html: string, max = 900): string | null {
  const paragraphs = [...html.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)]
    .map((m) => textOf(m[1] ?? "").replace(/\s+/g, " ").trim())
    // A sentence or two of prose, not a button's label or a cookie notice.
    .filter((p) => p.length >= 60 && /[.!?]/.test(p) && !/cookie|javascript|privacy policy|all rights reserved/i.test(p));
  if (paragraphs.length === 0) return null;
  // Those about the company itself first — "we", "our", "founded", "mission"… — not a product's promotion (wroffy.com's
  // About page opened with "Migrate from legacy mail…"). None of them: the prose as it comes.
  const aboutUs = paragraphs.filter((p) => /\b(we|our|us|company|founded|established|incorporated|headquartered|mission|vision|team|group|leading|provider)\b/i.test(p) && !/\b(buy|price|₹|\$|offer|discount|\/year)\b/i.test(p));
  let text = "";
  for (const p of aboutUs.length ? aboutUs : paragraphs) {
    if ((text + " " + p).trim().length > max) break;
    text = (text + " " + p).trim();
  }
  if (!text) text = paragraphs[0]!.slice(0, max);
  if (text.length >= max) {
    const cut = text.slice(0, max).lastIndexOf(". ");
    text = cut > 120 ? text.slice(0, cut + 1) : `${text.slice(0, max - 1).trimEnd()}…`;
  }
  return text;
}

/**
 * "Founded in 1995", "established 2004", "incorporated in 2011" — the year, when it is plausible. Not "since": "since 2016
 * we have…" is when something else began (welspuncorp.com, founded 1995, read as 2016).
 */
export function foundedFrom(text: string, now = new Date()): number | null {
  // The earliest such year: a plant or an office "established in 2016" comes after the company itself.
  const years = [...text.matchAll(/\b(?:founded|established|estd\.?|incorporated)\b[^.\d]{0,20}\b((?:18|19|20)\d{2})\b/gi)]
    .map((m) => Number(m[1]))
    .filter((y) => y >= 1850 && y <= now.getFullYear());
  return years.length ? Math.min(...years) : null;
}

/** Phone numbers the site links (tel:) or writes with a +country code — at most three, digits and + only. */
export function phonesFrom(html: string): string[] {
  const found = new Set<string>();
  const add = (raw: string) => {
    const digits = raw.replace(/[^\d+]/g, "");
    const plain = digits.replace(/^\+/, "");
    // An Indian number is +91 and ten digits; a piece of one ("+91 6613 6000") is no number at all.
    if (/^91/.test(plain) && digits.startsWith("+") && plain.length !== 12) return;
    if (plain.length >= 10 && plain.length <= 15) found.add(digits.startsWith("+") ? digits : plain);
  };
  for (const m of html.matchAll(/href\s*=\s*["']tel:([^"']{6,40})["']/gi)) add(decodeURIComponent(m[1]!));
  for (const m of textOf(html).matchAll(/\+\d{1,3}[\s-]?\(?\d{2,5}\)?[\s-]?\d{3,5}[\s-]?\d{3,5}/g)) add(m[0]);
  return [...found].slice(0, 3);
}

/** Addresses a company publishes for itself — sales@, info@… — at its own domain. Never a person's name@. */
const ROLE_BOXES = /^(info|sales|contact|enquiry|enquiries|inquiry|hello|support|office|marketing|business|bd|care|customercare|helpdesk|admin|mail)$/i;
export function roleEmailsFrom(html: string, domain: string): string[] {
  const own = domain.replace(/^www\./, "").toLowerCase();
  const found = new Set<string>();
  for (const m of decodeEntities(html).matchAll(/\b([a-z0-9._%+-]{1,40})@([a-z0-9.-]+\.[a-z]{2,})\b/gi)) {
    const [local, host] = [m[1]!.toLowerCase(), m[2]!.toLowerCase().replace(/^www\./, "")];
    if ((host === own || host.endsWith(`.${own}`)) && ROLE_BOXES.test(local)) found.add(`${local}@${host}`);
  }
  return [...found].slice(0, 4);
}

/** The homepage's title and description, as Domain Intel reads them. */
export function headOf(html: string): { title: string | null; description: string | null } {
  const title = html.match(/<title[^>]*>([\s\S]{1,300}?)<\/title>/i)?.[1];
  // The value up to its own closing quote: "We're…" in double quotes keeps its apostrophe (welspuncorp.com read as "We").
  const quoted = String.raw`(?:"([^"]{1,600})"|'([^']{1,600})')`;
  const meta = (pattern: string) => {
    const m = html.match(new RegExp(pattern, "i"));
    return m ? (m[1] ?? m[2] ?? null) : null;
  };
  const description =
    meta(String.raw`<meta[^>]+name=["']description["'][^>]*content=${quoted}`) ??
    meta(String.raw`<meta[^>]+content=${quoted}[^>]*name=["']description["']`) ??
    meta(String.raw`<meta[^>]+property=["']og:description["'][^>]*content=${quoted}`);
  return { title: title ? trimDescription(title, 140) : null, description: trimDescription(description ?? null) };
}

/** Everything the website's pages say, put together. `pages` are the fetched About, Careers and Contact pages' HTML. */
export function websiteFactsFrom(input: {
  url: string;
  home: string;
  pages: { about?: string | null; contact?: string | null };
  links: { about: string | null; careers: string | null; contact: string | null };
  domain: string;
  now?: Date;
}): WebsiteFacts {
  const head = headOf(input.home);
  const about = (input.pages.about && aboutFrom(input.pages.about)) || null;
  const foundedText = [about ?? "", textOf(input.pages.about ?? ""), textOf(input.home)].join("\n");
  const contactHtml = [input.home, input.pages.contact ?? ""].join("\n");
  return {
    url: input.url,
    title: head.title,
    description: head.description,
    about,
    aboutUrl: input.links.about,
    founded: foundedFrom(foundedText, input.now),
    careersUrl: input.links.careers,
    contactUrl: input.links.contact,
    phones: phonesFrom(contactHtml),
    emails: roleEmailsFrom(contactHtml, input.domain),
    social: socialLinksFrom(input.home),
  };
}

// ─── GST ───────────────────────────────────────────────────────────────────────────────────────

/** What the fourth character of a PAN says the holder is (Income-tax's own codes). */
const PAN_HOLDERS: Record<string, string> = {
  C: "A company",
  F: "A firm or LLP",
  P: "An individual (proprietor)",
  H: "A Hindu undivided family",
  A: "An association of persons",
  T: "A trust",
  B: "A body of individuals",
  L: "A local authority",
  J: "An artificial juridical person",
  G: "A government body",
};

export function panHolderOf(gstin: string): string | null {
  const pan = gstin.trim().toUpperCase().slice(2, 12);
  return /^[A-Z]{5}\d{4}[A-Z]$/.test(pan) ? (PAN_HOLDERS[pan[3]!] ?? null) : null;
}

export function gstStateOf(gstin: string): string | null {
  return GST_STATE_CODES[gstin.trim().slice(0, 2)] ?? null;
}

// ─── News ──────────────────────────────────────────────────────────────────────────────────────

/** The search for a company's news: its name without the legal form, in quotes — "Welspun Corp", not "Welspun". */
export function newsQueryFor(name: string): string {
  const core = name
    .replace(/\(\s*(i|india)\s*\)/gi, " ")
    // The legal form only: "Welspun Corp" keeps its Corp — it is part of the name people search by.
    .replace(/[\s.,()&-]*\b(pvt|private|ltd|limited|llp|inc|incorporated|plc|opc)\b\.?/gi, " ")
    .replace(/\s+/g, " ")
    .trim();
  return `"${core || name.trim()}"`;
}

/** Items from a Google News RSS feed: title, link, source and date, newest first, within `days`, at most `max`. */
export function newsFromRss(xml: string, opts: { now?: Date; days?: number; max?: number } = {}): NewsItem[] {
  const now = opts.now ?? new Date();
  const days = opts.days ?? 365;
  const items: NewsItem[] = [];
  for (const m of xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)) {
    const body = m[1]!;
    const pick = (tag: string) => {
      const raw = body.match(new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, "i"))?.[1];
      return raw ? decodeEntities(raw.replace(/^<!\[CDATA\[|\]\]>$/g, "")).trim() : null;
    };
    const title = pick("title");
    const url = pick("link");
    if (!title || !url || !/^https:\/\//.test(url)) continue;
    const source = pick("source");
    const dateText = pick("pubDate");
    const date = dateText && !Number.isNaN(Date.parse(dateText)) ? new Date(dateText) : null;
    if (date && now.getTime() - date.getTime() > days * 86_400_000) continue;
    // Google appends " - Source" to each title: kept once, as the source.
    const shown = source && title.endsWith(` - ${source}`) ? title.slice(0, -(source.length + 3)) : title;
    items.push({ title: shown, url, source, date: date ? date.toISOString() : null });
  }
  return items.sort((a, b) => (b.date ?? "").localeCompare(a.date ?? "")).slice(0, opts.max ?? 6);
}
