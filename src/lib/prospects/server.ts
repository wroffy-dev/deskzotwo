import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { workspacePack } from "@/lib/country-pack";
import { STILL_THERE } from "@/lib/contacts/left";
import { normalizeCompanyName } from "@/lib/company-name";
import { contactDesignationLabels } from "@/lib/validation/company";
import { COSTS, creditRefusal } from "@/lib/enrich/credits";
import { ApolloError, matchPerson, searchProspects, type ApolloPerson, type ApolloSearchPerson } from "@/lib/apollo/client";
import { apolloKey } from "@/lib/apollo/server";
import { buildProfile, searchQuery, type BestCustomer, type LookalikeFilters, type LookalikeProfile } from "@/lib/prospects/profile";

/**
 * Ved's lookalikes (owner, 22 Nov 2026; src/lib/prospects/profile.ts for what and why). Reads the best customers, asks
 * Apollo's free people search for more like them, and reveals the ones somebody picks — a credit each, counted against
 * their Apollo allowance (src/lib/enrich/credits.ts) as any Apollo lookup is. Who may: src/actions/prospects.ts.
 */

const DAY = 86_400_000;
const BEST = 40;

/** The best customers, most valuable first: the top spenders, then companies a lead was won with in two years. */
export async function bestCustomers(now = new Date()): Promise<BestCustomer[]> {
  const [spenders, won] = await Promise.all([
    db.customerStats
      .findMany({ where: { lifetimeValue: { gt: 0 }, company: { managedByResellerId: null } }, orderBy: { lifetimeValue: "desc" }, take: BEST, select: { companyId: true } })
      .catch((err) => (notMigratedYet(err) ? [] : Promise.reject(err))),
    db.lead.findMany({
      where: { status: "WON", OR: [{ stageChangedAt: { gte: new Date(now.getTime() - 730 * DAY) } }, { stageChangedAt: null, updatedAt: { gte: new Date(now.getTime() - 730 * DAY) } }], company: { managedByResellerId: null } },
      orderBy: { estimatedValue: { sort: "desc", nulls: "last" } },
      take: BEST,
      select: { companyId: true },
    }),
  ]);
  const ids = [...new Set([...spenders.map((s) => s.companyId), ...won.map((l) => l.companyId)])].slice(0, BEST);
  if (!ids.length) return [];
  const companies = await db.company.findMany({
    where: { id: { in: ids } },
    select: {
      id: true,
      employeeCount: true,
      industry: { select: { name: true } },
      locations: { orderBy: [{ isPrimary: "desc" }, { isBilling: "desc" }], take: 1, select: { city: true, state: true, country: true } },
      contacts: { where: { ...STILL_THERE }, orderBy: { isPrimary: "desc" }, take: 20, select: { id: true, isPrimary: true, designation: true, designationRef: { select: { name: true } } } },
      leads: { where: { status: "WON" }, select: { contactId: true }, take: 20 },
    },
  });
  const seeds = await db.enrichmentLookup
    .findMany({ where: { companyId: { in: ids }, kind: "COMPANY", status: "DONE", provider: "APOLLO", externalId: { not: null } }, orderBy: { createdAt: "desc" }, select: { companyId: true, externalId: true } })
    .catch((err) => (notMigratedYet(err) ? [] : Promise.reject(err)));
  const byId = new Map(companies.map((c) => [c.id, c]));
  return ids
    .map((id) => byId.get(id))
    .filter((c): c is NonNullable<typeof c> => !!c)
    .map((c) => {
      const wonWith = new Set(c.leads.map((l) => l.contactId).filter(Boolean));
      const buyers = c.contacts.filter((p) => wonWith.has(p.id));
      const named = (buyers.length ? buyers : c.contacts.filter((p) => p.isPrimary)).map((p) => p.designationRef?.name ?? contactDesignationLabels[p.designation]);
      const loc = c.locations[0];
      return {
        id: c.id,
        industry: c.industry?.name ?? null,
        city: loc?.city ?? null,
        state: loc?.state ?? null,
        country: loc?.country ?? null,
        employees: c.employeeCount,
        buyers: named,
        apolloId: seeds.find((s) => s.companyId === c.id)?.externalId ?? null,
      };
    });
}

export async function lookalikeProfile(now = new Date()): Promise<LookalikeProfile> {
  return buildProfile(await bestCustomers(now), workspacePack().countryName);
}

export type ProspectRow = ApolloSearchPerson & {
  /** A company of that name is in Deskzo already — not a new prospect; picking it is turned off. */
  alreadyHere: boolean;
};

/** People like the best customers' buyers, at companies like theirs. Free with Apollo; recorded as a search. */
export async function searchLookalikes(userId: string, filters: LookalikeFilters, page: number, seeds: string[], fetcher?: typeof fetch): Promise<{ rows: ProspectRow[]; total: number; error: string | null }> {
  const key = await apolloKey();
  if (!key) return { rows: [], total: 0, error: "Connect Apollo first, under Settings › Apollo." };
  const q = searchQuery(filters, seeds, page);
  if (!q) return { rows: [], total: 0, error: "Choose at least one thing to search by." };
  try {
    const found = await searchProspects(key, q, fetcher);
    await db.enrichmentLookup
      .create({ data: { kind: "SEARCH", requestedById: userId, status: found.people.length ? "DONE" : "NOT_FOUND", result: { lookalikes: true, filters, page: q.page, total: found.total, count: found.people.length } as Prisma.InputJsonValue, completedAt: new Date() } })
      .catch(() => undefined);
    const names = [...new Set(found.people.map((p) => p.organizationName).filter((n): n is string => !!n).map(normalizeCompanyName))];
    const here = new Set((await db.company.findMany({ where: { normalizedName: { in: names } }, select: { normalizedName: true } })).map((c) => c.normalizedName));
    return { rows: found.people.map((p) => ({ ...p, alreadyHere: !!p.organizationName && here.has(normalizeCompanyName(p.organizationName)) })), total: found.total, error: null };
  } catch (err) {
    return { rows: [], total: 0, error: err instanceof ApolloError ? err.message : "Apollo couldn't be reached." };
  }
}

/** One picked person in full — name, work email, their company — by Apollo's id: a credit, recorded against whoever asked. */
export async function revealProspect(userId: string, apolloId: string, fetcher?: typeof fetch): Promise<{ person: ApolloPerson | null; error: string | null }> {
  const key = await apolloKey();
  if (!key) return { person: null, error: "Connect Apollo first, under Settings › Apollo." };
  const overLimit = await creditRefusal(userId, "APOLLO", COSTS.APOLLO.person);
  if (overLimit) return { person: null, error: overLimit };
  try {
    const person = await matchPerson(key, { apolloId }, null, fetcher);
    await db.enrichmentLookup.create({ data: { kind: "PERSON", requestedById: userId, status: person ? "DONE" : "NOT_FOUND", externalId: apolloId, result: (person ?? {}) as Prisma.InputJsonValue, completedAt: new Date() } });
    return { person, error: person ? null : "Apollo couldn't find that person any more." };
  } catch (err) {
    return { person: null, error: err instanceof ApolloError ? err.message : "Apollo couldn't be reached." };
  }
}
