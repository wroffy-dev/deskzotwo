import { db } from "@/lib/db";
import { STILL_THERE } from "@/lib/contacts/left";

/**
 * The company a sender's work email points at (owner, 9 Nov 2026): somebody at @acme.co.in is Acme, whatever they typed
 * in a form's company box. Found by a company's website, or the address of somebody already on file there — and only
 * when exactly one company has it. Free mail (gmail, yahoo…) points at nobody.
 */

/** Addresses at these domains are people, not companies. */
export const FREE_MAIL = new Set([
  "gmail.com", "googlemail.com", "yahoo.com", "yahoo.co.in", "yahoo.in", "outlook.com", "hotmail.com",
  "live.com", "msn.com", "icloud.com", "me.com", "aol.com", "rediffmail.com", "proton.me", "protonmail.com",
  "zoho.com", "zohomail.in", "ymail.com", "mail.com", "gmx.com",
]);

/** A work email's domain, or null for free mail and nonsense. */
export function workDomain(email: string | null | undefined): string | null {
  const domain = email?.trim().toLowerCase().split("@")[1];
  if (!domain || !/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domain) || FREE_MAIL.has(domain)) return null;
  return domain;
}

/** A website as its bare host: "https://www.Acme.co.in/about" → "acme.co.in". */
export function hostOf(website: string | null | undefined): string | null {
  const text = website?.trim().toLowerCase();
  if (!text) return null;
  try {
    return new URL(text.includes("://") ? text : `https://${text}`).hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}

export type DomainCompany = { id: string; name: string };

/**
 * `viaContacts`: also by colleagues already on file at that domain. A company's own website says it outright; a colleague's
 * address can point at somebody filed under their own name — so it's asked only where nothing better was given.
 */
export async function companyByEmailDomain(email: string | null | undefined, options: { viaContacts?: boolean } = {}): Promise<DomainCompany | null> {
  const domain = workDomain(email);
  if (!domain) return null;
  const [byWebsite, byContact] = await Promise.all([
    db.company.findMany({ where: { website: { contains: domain, mode: "insensitive" } }, select: { id: true, name: true, website: true }, take: 20 }),
    options.viaContacts === false
      ? Promise.resolve([])
      : db.contact.findMany({ where: { email: { endsWith: `@${domain}`, mode: "insensitive" }, ...STILL_THERE, company: { name: { not: { endsWith: "(individual)" } } } }, select: { company: { select: { id: true, name: true } } }, take: 50 }),
  ]);
  const found = new Map<string, DomainCompany>();
  for (const c of byWebsite) if (hostOf(c.website) === domain) found.set(c.id, { id: c.id, name: c.name });
  for (const c of byContact) if (c.company) found.set(c.company.id, c.company);
  // Two companies with that domain: the address can't say which, so it says nothing.
  return found.size === 1 ? [...found.values()][0]! : null;
}
