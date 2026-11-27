import { db } from "@/lib/db";
import { STILL_THERE } from "@/lib/contacts/left";
import { workDomain } from "@/lib/lead-capture/domain-match";

/**
 * A company's website, from its people's work email (owner, 18 Nov 2026: "if company has a email with a domain can you
 * fill the website from email domain"). Somebody at @acme.co.in says the company is at acme.co.in.
 *
 *   · Only a company with no website: one somebody typed, or an import brought, is never changed.
 *   · Only work mail: gmail, yahoo, outlook and the like (FREE_MAIL) are people, not companies.
 *   · Only the people still there (STILL_THERE), and only a domain most of them share — more than half of those with a
 *     work address — so a consultant at another firm on file there doesn't name its website.
 *   · Never a company kept for one person ("… (individual)").
 *
 * Filled right after a contact is added, edited or moved (src/actions/company.ts), and once a day for every company still
 * without one (src/lib/marketing/heartbeat.ts) — which also covers imports and every other way people arrive.
 */

/** The domain most of these addresses share, or null: none at work, or no one domain held by more than half. */
export function websiteDomainFrom(emails: readonly (string | null | undefined)[]): string | null {
  const domains = emails.map(workDomain).filter((d): d is string => !!d);
  if (domains.length === 0) return null;
  const counts = new Map<string, number>();
  for (const d of domains) counts.set(d, (counts.get(d) ?? 0) + 1);
  const [top, n] = [...counts].sort((a, b) => b[1] - a[1])[0]!;
  return n * 2 > domains.length ? top : null;
}

/** The website as it is kept: "https://acme.co.in". */
export const websiteOf = (domain: string) => `https://${domain}`;

const BATCH = 500;

/**
 * Fills the website of these companies — or of every company without one, when none are named — from their people's
 * email. Returns how many were filled. Never throws: a contact's save never fails over its company's website.
 */
export async function fillWebsitesFromEmail(companyIds?: readonly string[]): Promise<number> {
  try {
    let filled = 0;
    let after: string | undefined;
    for (;;) {
      const companies = await db.company.findMany({
        where: {
          ...(companyIds ? { id: { in: [...companyIds] } } : {}),
          OR: [{ website: null }, { website: "" }],
          name: { not: { endsWith: "(individual)" } },
          contacts: { some: { email: { contains: "@" }, ...STILL_THERE } },
          ...(after ? { id: { gt: after, ...(companyIds ? { in: [...companyIds] } : {}) } } : {}),
        },
        orderBy: { id: "asc" },
        take: BATCH,
        select: { id: true, contacts: { where: { email: { contains: "@" }, ...STILL_THERE }, select: { email: true } } },
      });
      for (const c of companies) {
        const domain = websiteDomainFrom(c.contacts.map((p) => p.email));
        if (!domain) continue;
        // Still empty when written: somebody may have typed one in between.
        const done = await db.company.updateMany({ where: { id: c.id, OR: [{ website: null }, { website: "" }] }, data: { website: websiteOf(domain) } });
        filled += done.count;
      }
      if (companies.length < BATCH) return filled;
      after = companies.at(-1)!.id;
    }
  } catch (err) {
    console.error("[companies] website from email failed", err instanceof Error ? err.message : err);
    return 0;
  }
}
