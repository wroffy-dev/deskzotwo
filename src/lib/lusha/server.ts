import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { notMigratedYet } from "@/lib/not-migrated";
import { COSTS, creditRefusal } from "@/lib/enrich/credits";
import { apolloDomain, bestPhone, type ApolloCompany, type ApolloSearchPerson } from "@/lib/apollo/client";
import type { PersonLookup } from "@/lib/apollo/server";
import { LushaError, lushaCompany, lushaKeyWorks, lushaPerson, lushaPersonById, lushaProspects, type LushaPerson } from "@/lib/lusha/client";

/**
 * Lusha in a workspace (owner, 14 Nov 2026 — src/lib/lusha/client.ts): the key it pays with (`enrichment_connections`,
 * provider LUSHA), and its lookups in `enrichment_lookups` beside Apollo's. As Apollo's: a company's details are a
 * preview applied field by field (applyCompanyLookup reads either's); a contact's blanks are filled and what's typed is
 * kept. Lusha's phones come at once, and one on a do-not-call list is never written to a contact.
 */

const PROVIDER = "LUSHA";

export type LushaSetup = { connected: boolean; checkedAt: Date | null; error: string | null };

export async function lushaSetup(): Promise<LushaSetup> {
  try {
    const row = await db.enrichmentConnection.findUnique({ where: { provider: PROVIDER }, select: { active: true, lastCheckedAt: true, lastError: true } });
    return row?.active ? { connected: true, checkedAt: row.lastCheckedAt, error: row.lastError } : { connected: false, checkedAt: null, error: null };
  } catch (err) {
    if (notMigratedYet(err)) return { connected: false, checkedAt: null, error: null };
    throw err;
  }
}

export async function lushaKey(): Promise<string | null> {
  try {
    const row = await db.enrichmentConnection.findUnique({ where: { provider: PROVIDER }, select: { active: true, apiKeyEnc: true } });
    return row?.active ? decryptSecret(row.apiKeyEnc) : null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

export async function saveLushaKey(key: string, userId: string, fetcher?: typeof fetch): Promise<{ ok: true; creditsLeft: number | null } | { ok: false; error: string }> {
  const trimmed = key.trim();
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(trimmed)) return { ok: false, error: "That doesn't look like a Lusha API key." };
  const works = await lushaKeyWorks(trimmed, fetcher);
  if (!works.ok) return works;
  const data = { apiKeyEnc: await encryptSecret(trimmed), active: true, lastCheckedAt: new Date(), lastError: null, createdById: userId };
  await db.enrichmentConnection.upsert({ where: { provider: PROVIDER }, create: { provider: PROVIDER, ...data }, update: data });
  return works;
}

export async function removeLushaKey(): Promise<void> {
  await db.enrichmentConnection.deleteMany({ where: { provider: PROVIDER } });
}

const errorOf = (err: unknown) => (err instanceof LushaError ? err.message : "Lusha couldn't be reached.");
async function noteFailure(message: string) {
  await db.enrichmentConnection.updateMany({ where: { provider: PROVIDER }, data: { lastError: message.slice(0, 300) } }).catch(() => undefined);
}
const NOT_CONNECTED = "Connect Lusha first, under Settings › Lusha.";

async function domainOfCompany(companyId: string) {
  const company = await db.company.findUnique({ where: { id: companyId }, select: { name: true, website: true, contacts: { select: { email: true }, take: 20 } } });
  if (!company) return null;
  const domain = apolloDomain(company.website) ?? company.contacts.map((c) => apolloDomain(c.email)).find((d) => d && !/^(gmail|yahoo|hotmail|outlook|rediffmail|icloud)\./.test(d)) ?? null;
  return { name: company.name, domain };
}

export async function lushaLookUpCompany(companyId: string, userId: string, fetcher?: typeof fetch): Promise<{ lookupId: string; found: ApolloCompany | null; error: string | null }> {
  const key = await lushaKey();
  if (!key) return { lookupId: "", found: null, error: NOT_CONNECTED };
  const overLimit = await creditRefusal(userId, "LUSHA", COSTS.LUSHA.company);
  if (overLimit) return { lookupId: "", found: null, error: overLimit };
  const company = await domainOfCompany(companyId);
  if (!company) return { lookupId: "", found: null, error: "That company isn't there any more." };
  if (!company.domain) return { lookupId: "", found: null, error: "Lusha finds a company by its website — add the website (or a contact's work email) first." };
  try {
    const found = await lushaCompany(key, company.domain, company.name, fetcher);
    const row = await db.enrichmentLookup.create({
      data: { provider: PROVIDER, kind: "COMPANY", companyId, requestedById: userId, status: found ? "DONE" : "NOT_FOUND", externalId: found?.apolloId ?? null, result: (found ?? {}) as Prisma.InputJsonValue, completedAt: new Date() },
      select: { id: true },
    });
    return { lookupId: row.id, found, error: found ? null : `Lusha has no company at ${company.domain}.` };
  } catch (err) {
    await noteFailure(errorOf(err));
    const row = await db.enrichmentLookup.create({ data: { provider: PROVIDER, kind: "COMPANY", companyId, requestedById: userId, status: "FAILED", error: errorOf(err), completedAt: new Date() }, select: { id: true } });
    return { lookupId: row.id, found: null, error: errorOf(err) };
  }
}

/** Splits "Priya Sharma" for Lusha, which matches by first and last name. */
function nameParts(name: string): { firstName: string | null; lastName: string | null } {
  const parts = name.replace(/\s+/g, " ").trim().split(" ");
  return parts.length > 1 ? { firstName: parts[0]!, lastName: parts.slice(1).join(" ") } : { firstName: parts[0] ?? null, lastName: null };
}

/** Writes what Lusha found onto a contact's blanks; what is typed stays, Lusha's kept beside. */
async function fillContact(contactId: string, found: LushaPerson | null, wantPhone: boolean) {
  const contact = await db.contact.findUniqueOrThrow({ where: { id: contactId }, select: { email: true, phone: true, linkedinUrl: true } });
  const data: Prisma.ContactUpdateInput = {};
  const filled: string[] = [];
  const kept: PersonLookup["kept"] = {};
  if (found?.email) {
    if (!contact.email) {
      data.email = found.email;
      filled.push("email");
    } else if (contact.email.toLowerCase() !== found.email.toLowerCase()) kept.email = found.email;
  }
  if (found?.linkedinUrl) {
    if (!contact.linkedinUrl) {
      data.linkedinUrl = found.linkedinUrl;
      filled.push("LinkedIn");
    } else if (contact.linkedinUrl !== found.linkedinUrl) kept.linkedinUrl = found.linkedinUrl;
  }
  let mobile: PersonLookup["mobile"] = "NONE";
  // `phones` holds only the numbers not on a do-not-call list.
  const phone = wantPhone && found ? bestPhone(found.phones) : null;
  if (phone) {
    if (!contact.phone) {
      data.phone = phone.number;
      filled.push("phone");
      mobile = "FILLED";
    } else mobile = "KEPT";
  }
  if (filled.length) await db.contact.update({ where: { id: contactId }, data, select: { id: true } });
  return { filled, kept, mobile, doNotCall: !!found && found.phonesWithDnc.some((p) => p.doNotCall) };
}

export async function lushaLookUpContact(contactId: string, userId: string, opts: { mobile: boolean }, fetcher?: typeof fetch): Promise<PersonLookup & { doNotCall: boolean }> {
  const none = { lookupId: "", found: null, filled: [], kept: {}, mobile: "NONE" as const, error: null, doNotCall: false };
  const key = await lushaKey();
  if (!key) return { ...none, error: NOT_CONNECTED };
  const overLimit = await creditRefusal(userId, "LUSHA", COSTS.LUSHA.person + (opts.mobile ? COSTS.LUSHA.mobile : 0));
  if (overLimit) return { ...none, error: overLimit };
  const contact = await db.contact.findUnique({ where: { id: contactId }, select: { name: true, email: true, linkedinUrl: true, companyId: true, company: { select: { name: true, website: true } } } });
  if (!contact) return { ...none, error: "That contact isn't there any more." };
  try {
    const found = await lushaPerson(
      key,
      { ...nameParts(contact.name), companyName: contact.company.name, domain: apolloDomain(contact.company.website) ?? apolloDomain(contact.email), email: null, linkedinUrl: contact.linkedinUrl },
      { phones: opts.mobile },
      fetcher,
    );
    const done = await fillContact(contactId, found, opts.mobile);
    const row = await db.enrichmentLookup.create({
      data: { provider: PROVIDER, kind: "PERSON", companyId: contact.companyId, contactId, requestedById: userId, status: found ? "DONE" : "NOT_FOUND", externalId: found?.apolloId ?? null, result: { ...(found ?? {}), kept: done.kept } as Prisma.InputJsonValue, completedAt: new Date() },
      select: { id: true },
    });
    return { lookupId: row.id, found, filled: done.filled, kept: done.kept, mobile: done.mobile, doNotCall: done.doNotCall, error: found ? null : "Lusha didn't find this person at this company." };
  } catch (err) {
    await noteFailure(errorOf(err));
    const row = await db.enrichmentLookup.create({ data: { provider: PROVIDER, kind: "PERSON", companyId: contact.companyId, contactId, requestedById: userId, status: "FAILED", error: errorOf(err), completedAt: new Date() }, select: { id: true } });
    return { ...none, lookupId: row.id, error: errorOf(err) };
  }
}

export async function lushaSearchPeople(companyId: string, titles: string[], userId: string, fetcher?: typeof fetch): Promise<{ people: ApolloSearchPerson[]; total: number; error: string | null }> {
  const key = await lushaKey();
  if (!key) return { people: [], total: 0, error: NOT_CONNECTED };
  const overLimit = await creditRefusal(userId, "LUSHA", COSTS.LUSHA.search);
  if (overLimit) return { people: [], total: 0, error: overLimit };
  const company = await domainOfCompany(companyId);
  if (!company?.domain) return { people: [], total: 0, error: "Lusha finds people by the company's website — add it first." };
  const cleaned = titles.map((t) => t.trim()).filter(Boolean).slice(0, 10);
  try {
    const result = await lushaProspects(key, company.domain, cleaned, fetcher);
    await db.enrichmentLookup.create({ data: { provider: PROVIDER, kind: "SEARCH", companyId, requestedById: userId, status: result.people.length ? "DONE" : "NOT_FOUND", result: { titles: cleaned, total: result.total, count: result.people.length } as Prisma.InputJsonValue, completedAt: new Date() } });
    return { ...result, error: null };
  } catch (err) {
    await noteFailure(errorOf(err));
    return { people: [], total: 0, error: errorOf(err) };
  }
}

export async function lushaRevealPerson(companyId: string, id: string, userId: string, opts: { mobile: boolean }, fetcher?: typeof fetch): Promise<{ found: LushaPerson | null; error: string | null }> {
  const key = await lushaKey();
  if (!key) return { found: null, error: NOT_CONNECTED };
  const overLimit = await creditRefusal(userId, "LUSHA", COSTS.LUSHA.person + (opts.mobile ? COSTS.LUSHA.mobile : 0));
  if (overLimit) return { found: null, error: overLimit };
  try {
    const found = await lushaPersonById(key, id, { phones: opts.mobile }, fetcher);
    await db.enrichmentLookup.create({ data: { provider: PROVIDER, kind: "PERSON", companyId, requestedById: userId, status: found ? "DONE" : "NOT_FOUND", externalId: id, result: (found ?? {}) as Prisma.InputJsonValue, completedAt: new Date() } });
    return { found, error: found ? null : "Lusha couldn't find that person any more." };
  } catch (err) {
    await noteFailure(errorOf(err));
    return { found: null, error: errorOf(err) };
  }
}

export { fillContact as fillContactFromLusha };
