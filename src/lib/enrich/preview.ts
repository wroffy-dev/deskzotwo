import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { ApolloError, apolloDomain, enrichCompany, type ApolloCompany } from "@/lib/apollo/client";
import { apolloKey } from "@/lib/apollo/server";
import { LushaError, lushaCompany } from "@/lib/lusha/client";
import { lushaKey } from "@/lib/lusha/server";
import { COSTS, creditRefusal, type Provider } from "@/lib/enrich/credits";

/**
 * "Fill from website" on a new company's form (owner, 15 Nov 2026): a company's details by its website before the
 * company exists. Kept as a lookup with no company, so it counts against the person's credits like any other.
 */
export async function previewByWebsite(provider: Provider, website: string, userId: string, fetcher?: typeof fetch): Promise<{ found: ApolloCompany | null; error: string | null }> {
  const name = provider === "LUSHA" ? "Lusha" : "Apollo";
  const domain = apolloDomain(website);
  if (!domain) return { found: null, error: "Type the company's website first — example.com will do." };
  const key = provider === "LUSHA" ? await lushaKey() : await apolloKey();
  if (!key) return { found: null, error: `Connect ${name} first, under Settings › ${name}.` };
  const overLimit = await creditRefusal(userId, provider, COSTS[provider].company);
  if (overLimit) return { found: null, error: overLimit };
  try {
    const found = provider === "LUSHA" ? await lushaCompany(key, domain, null, fetcher) : await enrichCompany(key, domain, null, fetcher);
    await db.enrichmentLookup.create({
      data: { provider, kind: "COMPANY", companyId: null, requestedById: userId, status: found ? "DONE" : "NOT_FOUND", externalId: found?.apolloId ?? null, result: (found ?? {}) as Prisma.InputJsonValue, completedAt: new Date() },
    });
    return { found, error: found ? null : `${name} has no company at ${domain}.` };
  } catch (err) {
    const message = err instanceof ApolloError || err instanceof LushaError ? err.message : `${name} couldn't be reached.`;
    await db.enrichmentLookup.create({ data: { provider, kind: "COMPANY", companyId: null, requestedById: userId, status: "FAILED", error: message.slice(0, 300), completedAt: new Date() } });
    return { found: null, error: message };
  }
}
