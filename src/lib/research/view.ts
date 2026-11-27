import { db } from "@/lib/db";
import { can } from "@/lib/authz/resolve";
import { companyMasker } from "@/lib/companies/masking";
import { latestCompanyLookup } from "@/lib/apollo/server";
import { researchOf } from "@/lib/research/gather";
import type { BriefInput } from "@/lib/research/brief";
import type { ResearchFacts } from "@/lib/research/parse";

/**
 * The research card's data, and the brief's input, as this person may see them (owner, 18 Nov 2026 — src/lib/research).
 * Null for somebody the company's website is masked from: the research is the website's. GSTINs go when the GSTIN is
 * masked for them. Domain Intel's and Apollo's findings are read from where those keep them, never fetched here.
 */

export type ResearchDomain = { emailProvider: string | null; emailSecurityProvider: string | null; platform: string | null; hostProvider: string | null; registeredOn: string | null; fetchedAt: string | null };
export type ResearchApollo = { description: string | null; industry: string | null; employees: number | null; founded: number | null; revenue: string | null; at: string };

export type ResearchCard = {
  facts: ResearchFacts;
  refreshedAt: string | null;
  brief: string | null;
  briefAt: string | null;
  domain: ResearchDomain | null;
  apollo: ResearchApollo | null;
  /** Holds "Use Deskzo AI" — the brief button is theirs. */
  mayBrief: boolean;
};

async function domainOf(companyId: string): Promise<ResearchDomain | null> {
  const p = await db.domainProfile
    .findUnique({ where: { companyId }, select: { emailProvider: true, emailSecurityProvider: true, platform: true, hostProvider: true, registeredOn: true, fetchedAt: true, error: true } })
    .catch(() => null);
  if (!p || (!p.emailProvider && !p.platform && !p.hostProvider && !p.registeredOn)) return null;
  return { emailProvider: p.emailProvider, emailSecurityProvider: p.emailSecurityProvider, platform: p.platform, hostProvider: p.hostProvider, registeredOn: p.registeredOn?.toISOString() ?? null, fetchedAt: p.fetchedAt?.toISOString() ?? null };
}

async function apolloOf(companyId: string): Promise<ResearchApollo | null> {
  const last = await latestCompanyLookup(companyId).catch(() => null);
  if (!last) return null;
  const f = last.found;
  return { description: f.description, industry: f.industry, employees: f.employees, founded: f.foundedYear, revenue: f.revenue, at: last.at.toISOString() };
}

async function asSeen(companyId: string, userId: string) {
  const masker = await companyMasker(userId, "detail");
  if (masker.visibility("website") !== "clear") return null;
  const row = await researchOf(companyId);
  const facts: ResearchFacts = row?.facts ?? {};
  return { row, facts: masker.flags.gstin ? { ...facts, gst: [], gstNote: null } : facts };
}

export async function researchCardData(companyId: string, userId: string): Promise<ResearchCard | null> {
  const seen = await asSeen(companyId, userId);
  if (!seen) return null;
  const [domain, apollo, mayBrief] = await Promise.all([domainOf(companyId), apolloOf(companyId), can(userId, "copilot.use")]);
  return {
    facts: seen.facts,
    refreshedAt: seen.row?.refreshedAt?.toISOString() ?? null,
    brief: seen.row?.brief ?? null,
    briefAt: seen.row?.briefAt?.toISOString() ?? null,
    domain,
    apollo,
    mayBrief,
  };
}

/** What the brief is written from — the company's name, website and city, and the public findings. */
export async function briefInputFor(companyId: string, userId: string): Promise<BriefInput | null> {
  const seen = await asSeen(companyId, userId);
  if (!seen) return null;
  const company = await db.company.findUnique({ where: { id: companyId }, select: { name: true, website: true, locations: { select: { city: true }, take: 1 } } });
  if (!company) return null;
  const [domain, apollo] = await Promise.all([domainOf(companyId), apolloOf(companyId)]);
  return { name: company.name, website: company.website, city: company.locations[0]?.city ?? null, facts: seen.facts, domain, apollo };
}
