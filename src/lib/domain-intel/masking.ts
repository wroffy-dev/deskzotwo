import type { CompanyMasker } from "@/lib/companies/masking";
import { leadRedactor, type FieldMasker } from "@/lib/leads/masking";
import { toDomain } from "@/lib/domain-intel/signatures";

/**
 * What Domain Intel found about a company, as somebody may see it whose website the companies policy masks (owner,
 * 5 Nov 2026 — Phase 3 masking fixes, audit H.4.1; src/lib/companies/masking.ts). A profile is the website's: its
 * domain, the URL it ended at, a picture of its homepage, and DNS records that name it — a DMARC report address, a mail
 * or name server. So the domain and the URL are masked as the website is, the screenshot goes, and the website's domain
 * is masked wherever the rest quotes it: the lead redactor (src/lib/leads/masking.ts `leadRedactor`) run with the
 * website's rule, as the contacts redactor runs it with a contact's (src/lib/contacts/redaction.ts). Best effort, as
 * that is: a value written another way ("acme-in.mail.protection.outlook.com") isn't caught. What it says about mail,
 * hosting and security — the reason to look — stays.
 *
 * Takes any part of a profile and touches only the keys it has. `website` is the company's as stored, so its domain is
 * found in the profile even where the profile was read without one.
 */
export function domainProfileAsSeen<P extends object>(masker: CompanyMasker, website: string | null | undefined, profile: P): P {
  if (masker.visibility("website") === "clear") return profile;
  const row = profile as P & { domain?: string | null; finalUrl?: string | null; screenshotUrl?: string | null };
  // Only `active` and `present` are what the redactor asks of a masker.
  const asWebsite: FieldMasker = { active: true, context: masker.context, present: (_field, value) => masker.present("website", value), visibility: () => masker.visibility("website"), policy: () => null };
  const redact = leadRedactor(asWebsite, [
    ["website", website],
    ["website", toDomain(website)],
    ["website", row.domain],
  ]);
  return {
    ...redact.deep(profile),
    ...("domain" in row ? { domain: row.domain == null ? row.domain : (masker.present("website", row.domain) ?? "") } : {}),
    ...("finalUrl" in row ? { finalUrl: row.finalUrl == null ? null : masker.present("website", row.finalUrl) } : {}),
    ...("screenshotUrl" in row ? { screenshotUrl: null } : {}),
  } as P;
}
