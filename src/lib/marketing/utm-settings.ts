import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";
import { DEFAULT_UTM, readUtm, utmSlug, type UtmSettings } from "@/lib/marketing/utm";

/**
 * The workspace's UTM settings (src/lib/marketing/utm.ts), from `OrganisationSettings.marketingUtm` — read on their
 * own, so a workspace not migrated yet tags with the defaults rather than failing a send.
 */
export async function utmSettings(): Promise<UtmSettings> {
  try {
    const row = await db.organisationSettings.findUnique({ where: { id: "global" }, select: { marketingUtm: true } });
    return readUtm(row?.marketingUtm ?? null);
  } catch (err) {
    if (notMigratedYet(err) || (err instanceof Error && /marketingUtm/.test(err.message))) return DEFAULT_UTM;
    throw err;
  }
}

/**
 * Leads a campaign brought: those whose website form arrived with its tags (src/lib/lead-capture/intake.ts keeps them
 * as "utm deskzo / email / m365-renewal-nov-2026"), since it began. A count only — the leads keep their own access.
 */
export async function leadsFromCampaign(name: string, since: Date): Promise<number> {
  const slug = utmSlug(name);
  if (!slug) return 0;
  return db.lead.count({ where: { sourceDetail: { contains: `/ email / ${slug}`, mode: "insensitive" }, createdAt: { gte: since } } });
}
