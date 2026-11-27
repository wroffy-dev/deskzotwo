import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { safeFetch } from "@/lib/net/safe-fetch";
import { toDomain } from "@/lib/domain-intel/signatures";
import { GstinLookupRefused, lookupGstin, savedGstinChecks } from "@/lib/gstin/lookup";
import { gstinStatusLabels, isGstinStatus, normalizeGstin } from "@/lib/gstin/notes";
import { gstStateOf, newsFromRss, newsQueryFor, panHolderOf, sitePagesFrom, websiteFactsFrom, type GstFacts, type NewsItem, type ResearchFacts, type WebsiteFacts } from "@/lib/research/parse";
import { workspaceCountry, workspacePack } from "@/lib/country-pack";

/**
 * Gathering a company's research from free public sources (owner, 18 Nov 2026): its own website's pages, its GST
 * registrations, and the news. Every call out goes through the network guard (src/lib/net/safe-fetch.ts), is timed out
 * and allowed to fail — a source that fails says why and the rest still land. Runs when somebody presses Refresh, and
 * once after a company is made with a website; never on page load.
 *
 * GST goes through the e-invoice login the workspace already keeps (src/lib/gstin/lookup.ts), which reuses a check
 * younger than 30 days and limits a person to 60 fresh ones an hour; a workspace without that login is told so.
 */

// As Domain Intel's (src/lib/domain-intel/lookup.ts): some sites refuse an agent they don't know, and still say who we are.
const USER_AGENT = "Mozilla/5.0 (compatible; DeskzoOne/1.0; +https://deskzo.com) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120 Safari/537.36";
const PAGE = { timeoutMs: 8_000, maxBytes: 400_000, maxRedirects: 4, headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" } } as const;
const MAX_GSTINS = 3;

/** Tests swap the network for a stand-in. */
export const researchFetch = { get: (url: string, opts: Parameters<typeof safeFetch>[1]) => safeFetch(url, opts) };

async function page(url: string): Promise<{ url: string; html: string } | null> {
  try {
    const res = await researchFetch.get(url, PAGE);
    if (res.status < 200 || res.status >= 300) return null;
    if (!/html|xml|text/i.test(res.headers.get("content-type") ?? "text/html")) return null;
    return { url: res.url, html: res.body };
  } catch {
    return null;
  }
}

/** Its homepage, then its About and Contact pages as the homepage links them. */
export async function websiteResearch(website: string | null | undefined): Promise<{ facts: WebsiteFacts | null; error: string | null }> {
  const domain = toDomain(website);
  if (!domain) return { facts: null, error: website ? "The website on file doesn't look like an address." : "No website on file." };
  const home = (await page(`https://${domain}/`)) ?? (await page(`https://www.${domain}/`)) ?? (await page(`http://${domain}/`));
  // Some big sites refuse any reader that isn't a person's browser (tcs.com, infosys.com): said as plainly.
  if (!home) return { facts: null, error: `${domain} didn't answer, or doesn't let tools read it.` };
  const links = sitePagesFrom(home.html, home.url);
  const [about, contact] = await Promise.all([links.about ? page(links.about) : null, links.contact ? page(links.contact) : null]);
  return { facts: websiteFactsFrom({ url: home.url, home: home.html, pages: { about: about?.html, contact: contact?.html }, links, domain }), error: null };
}

/** Its GSTINs as the GST system knows them — the saved check while recent, else a fresh one. */
export async function gstResearch(companyId: string, userId: string): Promise<{ facts: GstFacts[]; note: string | null }> {
  const locations = await db.companyLocation.findMany({ where: { companyId, gstNumber: { not: null } }, select: { gstNumber: true } });
  const gstins = [...new Set(locations.map((l) => normalizeGstin(l.gstNumber)).filter((g) => g.length === 15))].slice(0, MAX_GSTINS);
  if (gstins.length === 0) return { facts: [], note: "No GSTIN on its addresses." };
  const saved = await savedGstinChecks(gstins);
  const facts: GstFacts[] = [];
  let note: string | null = null;
  for (const gstin of gstins) {
    let check = saved[gstin] ?? null;
    if (!check) {
      try {
        check = (await lookupGstin(gstin, userId)).check;
      } catch (err) {
        note = err instanceof GstinLookupRefused ? err.message : "The GST system didn't answer.";
      }
    }
    facts.push({
      gstin,
      legalName: check?.legalName ?? null,
      tradeName: check?.tradeName ?? null,
      status: check ? (isGstinStatus(check.status) ? gstinStatusLabels[check.status] : check.status) : "Not checked",
      taxpayerType: check?.taxpayerType ?? null,
      state: gstStateOf(gstin),
      panHolder: panHolderOf(gstin),
      checkedAt: check?.checkedAt ?? new Date().toISOString(),
    });
  }
  return { facts, note };
}

/** Google News's edition for the workspace's country — India's, the UAE's, else the international English one. */
function newsEdition(): string {
  const cc = workspacePack().india ? "IN" : workspaceCountry() === "AE" ? "AE" : "US";
  return `hl=en-${cc}&gl=${cc}&ceid=${cc}:en`;
}

/** The last year's news naming it, from Google News's public feed. */
export async function newsResearch(name: string): Promise<{ items: NewsItem[]; error: string | null }> {
  const q = encodeURIComponent(newsQueryFor(name));
  try {
    const res = await researchFetch.get(`https://news.google.com/rss/search?q=${q}&${newsEdition()}`, { ...PAGE, maxBytes: 600_000, headers: { "user-agent": USER_AGENT, accept: "application/rss+xml,application/xml" } });
    if (res.status !== 200) return { items: [], error: "The news feed didn't answer." };
    return { items: newsFromRss(res.body), error: null };
  } catch {
    return { items: [], error: "The news feed didn't answer." };
  }
}

/** Everything at once, each source on its own. */
export async function gatherResearch(company: { id: string; name: string; website: string | null }, userId: string): Promise<ResearchFacts> {
  const [site, gst, news] = await Promise.all([websiteResearch(company.website),
    // GST is India's register; a workspace elsewhere (the UAE) has none to read, and says nothing about it.
    workspacePack().india ? gstResearch(company.id, userId) : Promise.resolve({ facts: [], note: null }),
    newsResearch(company.name),
  ]);
  const now = new Date().toISOString();
  return {
    website: site.facts,
    websiteError: site.error,
    gst: gst.facts,
    gstNote: gst.note,
    news: news.items,
    newsError: news.error,
    at: { website: now, gst: now, news: now },
  };
}

export type ResearchRow = { facts: ResearchFacts; refreshedAt: Date | null; brief: string | null; briefAt: Date | null };

/** The company's research row; null before its first Refresh, or in a workspace without the table yet. */
export async function researchOf(companyId: string): Promise<ResearchRow | null> {
  try {
    const row = await db.companyResearch.findUnique({ where: { companyId }, select: { facts: true, refreshedAt: true, brief: true, briefAt: true } });
    return row ? { facts: (row.facts ?? {}) as ResearchFacts, refreshedAt: row.refreshedAt, brief: row.brief, briefAt: row.briefAt } : null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** Gathers and keeps it. A brief written before stays, until somebody asks for a new one. */
export async function refreshResearch(company: { id: string; name: string; website: string | null }, userId: string): Promise<ResearchFacts> {
  const facts = await gatherResearch(company, userId);
  const data = { facts: facts as Prisma.InputJsonValue, refreshedAt: new Date(), refreshedById: userId };
  await db.companyResearch.upsert({ where: { companyId: company.id }, create: { companyId: company.id, ...data }, update: data, select: { companyId: true } });
  return facts;
}
