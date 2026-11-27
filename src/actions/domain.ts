"use server";

import { pageSlice } from "@/lib/pagination";
import { plainError } from "@/lib/plain-error";
import { revalidatePath } from "next/cache";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { requireModuleAccess, requireModuleUser } from "@/lib/modules-access";
import { canSeeCompany, companyScope } from "@/lib/authz/company-scope";
import { recordAudit } from "@/lib/audit";
import { toPlain } from "@/lib/serialize";
import { toDomain, type SocialLinks } from "@/lib/domain-intel/signatures";
import { mayAccess } from "@/lib/authz/access";
import { notMigratedYet } from "@/lib/not-migrated";
import { inspectDomain } from "@/lib/domain-intel/lookup";
import { opportunitiesFrom, rankOpportunities } from "@/lib/domain-intel/opportunities";
import type { ActionResult } from "@/actions/company";
import { customerSide, isCustomerSide } from "@/lib/companies/roles";
import { companyMasker, type CompanyMasker } from "@/lib/companies/masking";
import { domainProfileAsSeen } from "@/lib/domain-intel/masking";

/**
 * Domain Intel is for the companies we sell to (owner, 8 Oct 2026: "not required for vendor
 * companies"). A vendor's mail provider and DMARC record are no sales opening, so vendors, OEMs,
 * distributors, partners and commission parties are left out of the lists, the counts and the panel.
 */
const NOT_SOLD_TO = "Domain lookups are for customers and resellers — not vendors or partners.";
const GONE = "That company no longer exists.";

/**
 * The customers this person may see, as every company list does (src/lib/authz/company-scope.ts):
 * their own accounts, or every one with the reach to. Its own AND term, so a search's OR beside it
 * can never replace the account rule's.
 */
async function visibleSoldTo(userId: string): Promise<Prisma.CompanyWhereInput> {
  // Customers — a vendor that's also a customer too (src/lib/companies/roles.ts).
  return { AND: [await customerSide(), await companyScope(userId)] };
}

/** One company, when it is a customer this person may see — anything else answers as if it weren't there. */
async function visibleCustomer(userId: string, companyId: string): Promise<boolean> {
  const company = await db.company.findUnique({ where: { id: String(companyId ?? "") }, select: { ownerUserId: true, relationshipType: true } });
  return !!company && (await canSeeCompany(userId, company));
}

const profileSelect = {
  id: true,
  domain: true,
  finalUrl: true,
  httpStatus: true,
  siteTitle: true,
  siteDescription: true,
  platform: true,
  platformEvidence: true,
  hostProvider: true,
  hostEvidence: true,
  ipAddress: true,
  mxHosts: true,
  emailProvider: true,
  emailSecurityProvider: true,
  nsHosts: true,
  dnsProvider: true,
  registrar: true,
  registeredOn: true,
  expiresOn: true,
  spfRecord: true,
  dmarcRecord: true,
  dmarcPolicy: true,
  dkimFound: true,
  screenshotUrl: true,
  fetchedAt: true,
  error: true,
} satisfies Prisma.DomainProfileSelect;

/**
 * The masker a lookup's own answer names the website by (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.1;
 * src/lib/companies/masking.ts): it is pressed on the company's page and in the module's list alike, so whichever of
 * the two masks it. The lookup itself runs on the website on file.
 */
async function websiteMasker(userId: string): Promise<CompanyMasker> {
  const [list, detail] = await Promise.all([companyMasker(userId, "list"), companyMasker(userId, "detail")]);
  return list.visibility("website") !== "clear" ? list : detail;
}

/**
 * Looks the domain up and stores what came back.
 *
 * Deliberately on demand rather than on page load: it makes half a dozen outbound requests — public
 * DNS, the company's own homepage, and RDAP — and takes seconds, not milliseconds. The result is
 * cached on the profile until someone asks again, with `fetchedAt` on screen so nobody mistakes a
 * stale answer for a current one.
 */
export async function refreshDomainProfile(companyId: string): Promise<ActionResult<{ domain: string }>> {
  const user = await requireModuleUser("domains");

  const company = await db.company.findUnique({
    where: { id: companyId },
    select: { id: true, name: true, website: true, relationshipType: true, ownerUserId: true },
  });
  if (!company || !(await canSeeCompany(user.id, company))) return { ok: false, error: GONE };
  if (!(await isCustomerSide(company))) return { ok: false, error: NOT_SOLD_TO };

  const domain = toDomain(company.website);
  // The lookup runs on the website on file, here on the server; what it says back names it as this person sees it.
  const shown = await websiteMasker(user.id);
  if (!domain) {
    return {
      ok: false,
      error: company.website
        ? `"${shown.present("website", company.website)}" doesn't look like a website address. Fix it on the company and try again.`
        : "This company has no website on file. Add one and the lookup can run.",
    };
  }

  try {
    const findings = await inspectDomain(domain);
    const data = {
      domain,
      finalUrl: findings.finalUrl,
      httpStatus: findings.httpStatus,
      siteTitle: findings.siteTitle,
      siteDescription: findings.siteDescription,
      platform: findings.platform,
      platformEvidence: findings.platformEvidence,
      hostProvider: findings.hostProvider,
      hostEvidence: findings.hostEvidence,
      ipAddress: findings.ipAddress,
      mxHosts: findings.mxHosts,
      emailProvider: findings.emailProvider,
      emailSecurityProvider: findings.emailSecurityProvider,
      nsHosts: findings.nsHosts,
      dnsProvider: findings.dnsProvider,
      registrar: findings.registrar,
      registeredOn: findings.registeredOn,
      expiresOn: findings.expiresOn,
      spfRecord: findings.spfRecord,
      dmarcRecord: findings.dmarcRecord,
      dmarcPolicy: findings.dmarcPolicy,
      dkimFound: findings.dkimFound,
      screenshotUrl: findings.screenshotUrl,
      fetchedAt: new Date(),
      // A previous failure shouldn't linger on a profile that has since succeeded.
      error: null,
    };

    await db.domainProfile.upsert({
      where: { companyId },
      create: { companyId, ...data },
      update: data,
    });
    const filledLinkedIn = await keepSocialLinks(user.id, companyId, findings.socialLinks);
    await keepFavicon(companyId, findings.favicon);

    await recordAudit({
      userId: user.id,
      action: "UPDATE",
      entityType: "DomainProfile",
      entityId: companyId,
      entityLabel: `Looked up ${domain} for ${company.name}${filledLinkedIn ? " — LinkedIn page filled in from the website" : ""}`,
    });
    revalidatePath(`/companies/${companyId}`);
    revalidatePath("/domains");
    return { ok: true, data: { domain: shown.present("website", domain) ?? "" } };
  } catch (error) {
    // The whole lookup failing is rare — the individual steps swallow their own failures — so this
    // is recorded on the profile rather than shown once and lost.
    const message = plainError(error, "The lookup failed.");
    await db.domainProfile.upsert({
      where: { companyId },
      create: { companyId, domain, error: message, fetchedAt: new Date() },
      update: { error: message, fetchedAt: new Date() },
    });
    revalidatePath(`/companies/${companyId}`);
    return { ok: false, error: domainProfileAsSeen(shown, company.website, { domain, error: message }).error };
  }
}

/**
 * The social pages the homepage links (owner, 15 Nov 2026: "add social links to the free lookup"), kept on the profile —
 * and the company's LinkedIn filled in from them when it has none and this person may edit the company. Never over a
 * LinkedIn somebody typed. Returns whether it filled one. A workspace not migrated to the column keeps nothing.
 */
async function keepSocialLinks(userId: string, companyId: string, links: SocialLinks): Promise<boolean> {
  try {
    await db.domainProfile.update({ where: { companyId }, data: { socialLinks: links as Prisma.InputJsonValue }, select: { id: true } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  if (!links.linkedin || !(await mayAccess(userId, "companies", "edit", companyId))) return false;
  const filled = await db.company.updateMany({ where: { id: companyId, OR: [{ linkedinUrl: null }, { linkedinUrl: "" }] }, data: { linkedinUrl: links.linkedin } });
  return filled.count > 0;
}

/**
 * The site's icon, kept for the tile beside the company's name (owner, 15 Nov 2026 — src/lib/domain-intel/favicon.ts).
 * A lookup that found none clears an old one: the site no longer has it. A workspace not migrated keeps nothing.
 */
async function keepFavicon(companyId: string, favicon: string | null): Promise<void> {
  try {
    await db.domainProfile.update({ where: { companyId }, data: { favicon }, select: { id: true } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
}

/** A profile's social pages, read by name: none in a workspace not yet migrated, or before its first lookup since. */
async function socialLinksOf(companyId: string): Promise<SocialLinks> {
  try {
    const row = await db.domainProfile.findUnique({ where: { companyId }, select: { socialLinks: true } });
    const value = row?.socialLinks;
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: SocialLinks = {};
    for (const key of ["linkedin", "x", "facebook", "instagram", "youtube"] as const) {
      const url = (value as Record<string, unknown>)[key];
      if (typeof url === "string" && /^https:\/\//.test(url)) out[key] = url;
    }
    return out;
  } catch (err) {
    if (notMigratedYet(err)) return {};
    throw err;
  }
}

export async function getDomainProfile(companyId: string) {
  const user = await requireModuleAccess("domains");
  if (!(await visibleCustomer(user.id, companyId))) return null;
  const profile = await db.domainProfile.findUnique({ where: { companyId }, select: profileSelect });
  // The company's own Domain Intel, as its page shows the website (src/lib/domain-intel/masking.ts).
  return profile ? toPlain(domainProfileAsSeen(await companyMasker(user.id, "detail"), null, profile)) : null;
}

/** The profile plus the sales reading of it — computed, never stored, so the rules stay editable. */
export async function getDomainBriefing(companyId: string) {
  const user = await requireModuleUser("domains");
  const [profile, company] = await Promise.all([
    db.domainProfile.findUnique({ where: { companyId }, select: profileSelect }),
    db.company.findUnique({
      where: { id: companyId },
      select: {
        website: true,
        linkedinUrl: true,
        employeeCount: true,
        category: true,
        companyType: true,
        relationshipType: true,
        ownerUserId: true,
        industry: { select: { name: true } },
      },
    }),
  ]);
  if (!company || !(await isCustomerSide({ id: companyId, relationshipType: company.relationshipType })) || !(await canSeeCompany(user.id, { ...company, id: companyId }))) return null;

  const opportunities = profile
    ? rankOpportunities(
        opportunitiesFrom({
          emailProvider: profile.emailProvider,
          emailSecurityProvider: profile.emailSecurityProvider,
          spfRecord: profile.spfRecord,
          dmarcRecord: profile.dmarcRecord,
          dmarcPolicy: profile.dmarcPolicy,
          dkimFound: profile.dkimFound,
          platform: profile.platform,
          hostProvider: profile.hostProvider,
          registrar: profile.registrar,
          expiresOn: profile.expiresOn,
          httpStatus: profile.httpStatus,
          finalUrl: profile.finalUrl,
          employeeCount: company.employeeCount,
        }),
      )
    : [];

  // On the company's page, and a lead's for its company: the website as the page shows it, and what was found by it
  // (owner, 5 Nov 2026 — Phase 3 masking fixes, audit H.4.1; src/lib/domain-intel/masking.ts). A masked website is no
  // link — `websiteMasked` says so (src/components/domains/domain-panel.tsx).
  const shown = await companyMasker(user.id, "detail");
  const domain = toDomain(company.website);
  const websiteMasked = shown.visibility("website") !== "clear";
  return toPlain({
    profile: profile ? domainProfileAsSeen(shown, company.website, profile) : null,
    company: { ...company, website: shown.present("website", company.website) },
    opportunities,
    domain: domain === null ? null : shown.present("website", domain),
    websiteMasked,
    // Its social pages name the company as plainly as its website does: none for somebody the website is masked from.
    socialLinks: websiteMasked || !profile ? {} : await socialLinksOf(companyId),
  });
}

/** Every company with a website, for the module's own list — the prospecting view. */
export async function listDomainProfiles(params: {
  page: number;
  pageSize: number;
  search?: string;
  platform?: string;
  emailProvider?: string;
  /** "unscanned" narrows to companies with a website nobody has looked up yet. */
  view?: string;
}) {
  const user = await requireModuleAccess("domains");
  // Each website as a company list shows it, and no match on one masked for this person (owner, 5 Nov 2026 — Phase 3
  // masking fixes, audit H.4.1; src/lib/companies/masking.ts): which rows a search finds would say what it holds.
  const shown = await companyMasker(user.id, "list");

  // Each condition its own AND term: two filters on the profile (a platform and a mail provider) used
  // to overwrite each other as keys of one object, and so would the account rule and the search.
  const where: Prisma.CompanyWhereInput = {
    AND: [
      await visibleSoldTo(user.id),
      ...(params.view === "unscanned" ? [{ domainProfile: { is: null } }] : []),
      ...(params.platform ? [{ domainProfile: { is: { platform: params.platform } } }] : []),
      ...(params.emailProvider ? [{ domainProfile: { is: { emailProvider: params.emailProvider } } }] : []),
    ],
    website: { not: null },
    ...(params.search
      ? {
          OR: [
            { name: { contains: params.search, mode: "insensitive" } },
            ...(shown.flags.website ? [] : [{ website: { contains: params.search, mode: "insensitive" as const } }]),
          ],
        }
      : {}),
  };

  const [rows, total] = await Promise.all([
    db.company.findMany({
      where,
      orderBy: { name: "asc" },
      ...pageSlice(params.page, params.pageSize),
      select: {
        id: true,
        companySeq: true,
        name: true,
        website: true,
        relationshipType: true,
        stage: true,
        employeeCount: true,
        industry: { select: { name: true } },
        owner: { select: { name: true } },
        domainProfile: { select: profileSelect },
      },
    }),
    db.company.count({ where }),
  ]);

  return toPlain({
    rows: rows.map((r) => ({ ...r, website: shown.present("website", r.website), domainProfile: r.domainProfile ? domainProfileAsSeen(shown, r.website, r.domainProfile) : null })),
    total,
  });
}

/** Distinct values actually present, so the filters only offer things that will match something. */
export async function domainFilterOptions() {
  const user = await requireModuleAccess("domains");
  const visible = await visibleSoldTo(user.id);
  const [platforms, providers] = await Promise.all([
    db.domainProfile.findMany({
      where: { company: visible, platform: { not: null } },
      distinct: ["platform"],
      select: { platform: true },
      orderBy: { platform: "asc" },
    }),
    db.domainProfile.findMany({
      where: { company: visible, emailProvider: { not: null } },
      distinct: ["emailProvider"],
      select: { emailProvider: true },
      orderBy: { emailProvider: "asc" },
    }),
  ]);
  return {
    platforms: platforms.map((p) => p.platform!).filter(Boolean),
    emailProviders: providers.map((p) => p.emailProvider!).filter(Boolean),
  };
}

export async function domainSummary() {
  const user = await requireModuleAccess("domains");
  const visible = await visibleSoldTo(user.id);
  const [withWebsite, scanned, noDmarc, googleWorkspace, selfHosted] = await Promise.all([
    db.company.count({ where: { AND: [visible], website: { not: null } } }),
    db.domainProfile.count({ where: { company: visible } }),
    db.domainProfile.count({ where: { company: visible, dmarcRecord: null } }),
    db.domainProfile.count({ where: { company: visible, emailProvider: "Google Workspace" } }),
    db.domainProfile.count({ where: { company: visible, emailProvider: { in: ["Self-hosted or other", "Shared hosting mail"] } } }),
  ]);
  return { withWebsite, scanned, noDmarc, googleWorkspace, selfHosted };
}
