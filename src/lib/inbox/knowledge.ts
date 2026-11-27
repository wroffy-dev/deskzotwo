import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { SafeFetchError, safeFetch } from "@/lib/net/safe-fetch";
import { channelSettings, webAddress, type InboxKind } from "@/lib/inbox/settings";
import { withSameThing } from "@/lib/inbox/bot";
import { tenantKey } from "@/lib/tenancy/cache";

/**
 * Answers from the business's own website (owner, 31 Oct 2026). A channel lists a few addresses — pages, or a sitemap —
 * in `bot.ai.pages`; "Read the pages now" fetches them (public pages only, through the safe fetcher, and only on the
 * channel's allowed sites when it names any) and keeps each page's words. When Deskzo AI answers a customer it is told
 * the few passages that best match the question, with their addresses, as well as the set answers and notes — so it
 * can answer "do you have payroll?" from the site itself, and link the page.
 *
 * Every workspace's website chat has it, not only deskzo.com's: each answers from its own site.
 */

export const KNOWLEDGE_LIMITS = {
  /** Addresses a channel lists. */
  addresses: 20, // INBOX_LIMITS.pages
  /** Pages kept for a channel, a sitemap's included. */
  pages: 100,
  /** A page's words kept. */
  pageText: 20_000,
  /** What a fetch may bring back. */
  pageBytes: 2_000_000,
  /** What the AI is told per answer. */
  passages: 4,
  passageChars: 1_100,
} as const;

export type Passage = { url: string; title: string; text: string };

// ── Reading a page ───────────────────────────────────────────────────────────────────────────────────

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", rsquo: "’", lsquo: "‘", rdquo: "”", ldquo: "“", ndash: "–", mdash: "—", hellip: "…", rupee: "₹" };

function decode(text: string): string {
  return text.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (whole, code: string) => {
    if (code[0] === "#") {
      const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
      return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : " ";
    }
    return ENTITIES[code.toLowerCase()] ?? whole;
  });
}

/** A page's title and its words — the main part where it marks one, without menus, footers, scripts or styles. */
export function pageText(html: string): { title: string; text: string } {
  const title = decode(html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  let body = html
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(script|style|noscript|svg|template|iframe|head)\b[\s\S]*?<\/\1>/gi, " ");
  const main = body.match(/<main\b[^>]*>([\s\S]*?)<\/main>/i)?.[1];
  if (main && main.length > 500) body = main;
  else body = body.replace(/<(nav|header|footer|aside|form)\b[\s\S]*?<\/\1>/gi, " ");
  const text = decode(
    body
      .replace(/<(br|hr)\b[^>]*>/gi, "\n")
      .replace(/<\/(p|div|li|h[1-6]|tr|section|article|dd|dt|blockquote)>/gi, "\n")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/[ \t\f\v ]+/g, " ")
    .replace(/\s*\n\s*/g, "\n")
    .replace(/\n{2,}/g, "\n")
    .trim()
    .slice(0, KNOWLEDGE_LIMITS.pageText);
  return { title, text };
}

/** The page addresses a sitemap lists — a sitemap index's own sitemaps are left out. */
export function sitemapUrls(xml: string): string[] {
  if (/<sitemapindex\b/i.test(xml)) return [];
  return [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]!)).filter((u) => /^https?:\/\//i.test(u));
}

/** Whether an address is on one of the channel's allowed sites — any site while it names none. */
export function onAllowedSite(url: string, allowedSites: string[]): boolean {
  if (!allowedSites.length) return true;
  try {
    const origin = new URL(url).origin.toLowerCase();
    return allowedSites.includes(origin);
  } catch {
    return false;
  }
}

type Fetcher = (url: string) => Promise<{ status: number; body: string; contentType: string; url: string }>;
let testFetcher: Fetcher | null = null;

/** For the checks: pages come from here instead of the network. Null puts the safe fetcher back. */
export function setTestKnowledgeFetch(fetcher: Fetcher | null) {
  testFetcher = fetcher;
}

async function fetchPage(url: string): Promise<{ status: number; body: string; contentType: string; url: string }> {
  if (testFetcher) return testFetcher(url);
  const res = await safeFetch(url, { timeoutMs: 10_000, maxBytes: KNOWLEDGE_LIMITS.pageBytes, headers: { "user-agent": "DeskzoBot/1.0 (+https://deskzo.com) reading pages for this site's chat", accept: "text/html,application/xhtml+xml,application/xml;q=0.9" } });
  return { status: res.status, body: res.body, contentType: res.headers.get("content-type") ?? "", url: res.url };
}

export type ReadReport = { read: number; failed: { url: string; error: string }[]; skipped: string[] };

/**
 * Reads a channel's pages now: each address listed (a sitemap brings its pages, up to the limit), on the channel's
 * allowed sites only; each page's words kept, pages no longer listed forgotten. Never throws for one bad page.
 */
export async function readChannelPages(channelId: string): Promise<ReadReport> {
  const channel = await db.inboxChannel.findUniqueOrThrow({ where: { id: channelId }, select: { kind: true, settings: true } });
  const settings = channelSettings(channel.settings, channel.kind as InboxKind);
  const listed = settings.bot.ai.pages;
  const report: ReadReport = { read: 0, failed: [], skipped: [] };

  // The pages to read: each address, or the pages its sitemap names — all on the allowed sites.
  const pages: string[] = [];
  // A sitemap that couldn't be read leaves the pages it brought last time as they were.
  let sitemapFailed = false;
  const add = (url: string) => {
    if (pages.length >= KNOWLEDGE_LIMITS.pages || pages.includes(url)) return;
    if (!onAllowedSite(url, settings.allowedSites)) report.skipped.push(url);
    else pages.push(url);
  };
  for (const address of listed) {
    if (!onAllowedSite(address, settings.allowedSites)) {
      report.skipped.push(address);
      continue;
    }
    if (/sitemap[^/]*\.xml$/i.test(new URL(address).pathname)) {
      try {
        const res = await fetchPage(address);
        if (res.status >= 400) throw new Error(`the site answered ${res.status}`);
        sitemapUrls(res.body).forEach((u) => {
          const kept = webAddress(u);
          if (kept) add(kept);
        });
      } catch (err) {
        sitemapFailed = true;
        report.failed.push({ url: address, error: reason(err) });
      }
    } else add(address);
  }

  const results = new Map<string, { title: string; text: string; error: string | null }>();
  // A few at a time: quick, without hammering the site.
  for (let i = 0; i < pages.length; i += 4) {
    await Promise.all(
      pages.slice(i, i + 4).map(async (url) => {
        try {
          const res = await fetchPage(url);
          if (res.status >= 400) throw new Error(`the site answered ${res.status}`);
          if (res.contentType && !/html|xml|text\/plain/i.test(res.contentType)) throw new Error("it isn't a web page");
          const { title, text } = /html/i.test(res.contentType) || /<html|<body/i.test(res.body) ? pageText(res.body) : { title: "", text: res.body.slice(0, KNOWLEDGE_LIMITS.pageText) };
          if (text.length < 40) throw new Error("there were hardly any words on it");
          results.set(url, { title, text, error: null });
          report.read += 1;
        } catch (err) {
          results.set(url, { title: "", text: "", error: reason(err) });
          report.failed.push({ url, error: reason(err) });
        }
      }),
    );
  }

  const now = new Date();
  await db.$transaction(async (tx) => {
    if (!sitemapFailed) await tx.inboxKnowledgePage.deleteMany({ where: { channelId, url: { notIn: pages } } });
    for (const [url, r] of results) {
      await tx.inboxKnowledgePage.upsert({
        where: { channelId_url: { channelId, url } },
        create: { channelId, url, title: r.title, text: r.text, error: r.error, fetchedAt: now },
        // A page that failed this time keeps the words it had: a site briefly down doesn't empty the bot.
        update: r.error ? { error: r.error, fetchedAt: now } : { title: r.title, text: r.text, error: null, fetchedAt: now },
      });
    }
  });
  cache.delete(await cacheKey(channelId));
  return report;
}

function reason(err: unknown): string {
  if (err instanceof SafeFetchError) return err.message;
  const message = err instanceof Error ? err.message : String(err);
  return message.slice(0, 200);
}

/** What a channel has read: how many pages, when, and those that couldn't be read. */
export async function channelPagesState(channelId: string): Promise<{ pages: number; fetchedAt: string | null; failed: { url: string; error: string }[] } | null> {
  try {
    const rows = await db.inboxKnowledgePage.findMany({ where: { channelId }, select: { url: true, error: true, text: true, fetchedAt: true } });
    const latest = rows.reduce<Date | null>((at, r) => (!at || r.fetchedAt > at ? r.fetchedAt : at), null);
    return { pages: rows.filter((r) => r.text).length, fetchedAt: latest?.toISOString() ?? null, failed: rows.filter((r) => r.error).map((r) => ({ url: r.url, error: r.error! })) };
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

// ── Finding the passages ─────────────────────────────────────────────────────────────────────────────

const STOP = new Set(
  "the and for are you your our with that this what which who how can does did have has had will would could should from into about there their them they then than when where while been being was were not but any all its it's into onto just also more most some such only own same very too here like want need please tell know much many kya hai hain ka ki ke ko mein main aap hum is in on at to of an or it be we my me do so no up if as by go hi us am".split(" "),
);

/** One word as searched: a plural folded to its singular ("users" → "user", "invoices" → "invoice"). */
const fold = (w: string) => (w.length > 3 && w.endsWith("s") && !w.endsWith("ss") ? w.slice(0, -1) : w);

/**
 * The words of a text worth searching on: lower case, two letters or more (so "PF" and "HR" count), plurals folded,
 * the common ones left out.
 */
export function terms(text: string): string[] {
  return (text.toLowerCase().match(/[\p{L}\p{N}]{2,}/gu) ?? []).filter((w) => !STOP.has(w)).map(fold);
}

/** Words a page may use for what a customer asks: the set answers' groups ("cost" → "price"), and a person for a user. */
const SEATS = ["user", "person", "people", "seat", "employee", "member"];
function questionTerms(question: string): string[] {
  const out = new Set<string>();
  for (const w of terms(question)) {
    out.add(w);
    for (const same of withSameThing(w)) for (const t of terms(same)) out.add(t);
    if (SEATS.includes(w)) SEATS.forEach((s) => out.add(s));
  }
  return [...out];
}

/** A page's words in passages of about a paragraph or two, each standing on its own. */
export function passagesOf(text: string, size: number = KNOWLEDGE_LIMITS.passageChars): string[] {
  const out: string[] = [];
  let current = "";
  for (const line of text.split("\n")) {
    if (current && current.length + line.length + 1 > size) {
      out.push(current);
      current = "";
    }
    current = current ? `${current}\n${line}` : line.slice(0, size);
  }
  if (current) out.push(current);
  return out;
}

type Indexed = { url: string; title: string; text: string; words: Set<string>; titleWords?: Set<string> }[];
const cache = new Map<string, { at: number; passages: Indexed }>();

/**
 * Security audit, 11 Nov 2026 (SEC-65): filed under the workspace as well as the channel — one process serves every
 * workspace, and a workspace restored from another's backup has the same channel ids (src/lib/tenancy/cache.ts).
 */
async function cacheKey(channelId: string): Promise<string> {
  return `${await tenantKey().catch(() => "-")}|${channelId}`;
}

async function indexed(channelId: string): Promise<Indexed> {
  const key = await cacheKey(channelId);
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < 10 * 60_000) return hit.passages;
  let rows: { url: string; title: string; text: string }[] = [];
  try {
    rows = await db.inboxKnowledgePage.findMany({ where: { channelId, text: { not: "" } }, select: { url: true, title: true, text: true } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  const passages = rows.flatMap((r) => passagesOf(r.text).map((text) => ({ url: r.url, title: r.title, text, words: new Set(terms(`${r.title} ${text}`)), titleWords: new Set(terms(r.title)) })));
  cache.set(key, { at: Date.now(), passages });
  return passages;
}

/**
 * The passages of a channel's pages that best answer a question: scored by the question's words they hold, the rarer
 * words counting more, at most two from one page — so the AI sees a few pages, not one page four times.
 */
export function bestPassages(passages: Indexed, question: string, limit: number = KNOWLEDGE_LIMITS.passages): Passage[] {
  const asked = questionTerms(question);
  if (!asked.length || !passages.length) return [];
  const weight = new Map(asked.map((w) => [w, Math.log(1 + passages.length / (1 + passages.filter((p) => p.words.has(w)).length))]));
  const scored = passages
    // A page whose title is about what was asked counts for more: the payroll page over the home page that mentions payroll.
    .map((p) => ({ p, score: asked.reduce((sum, w) => sum + (p.words.has(w) ? weight.get(w)! : 0) + (p.titleWords?.has(w) ? weight.get(w)! * 0.75 : 0), 0) }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);
  const out: Passage[] = [];
  const perPage = new Map<string, number>();
  for (const { p } of scored) {
    if ((perPage.get(p.url) ?? 0) >= 2) continue;
    perPage.set(p.url, (perPage.get(p.url) ?? 0) + 1);
    out.push({ url: p.url, title: p.title, text: p.text });
    if (out.length >= limit) break;
  }
  return out;
}

/** What a channel's pages say about a question — none when it has read no pages. */
export async function knowledgeFor(channelId: string, question: string): Promise<Passage[]> {
  return bestPassages(await indexed(channelId), question);
}
