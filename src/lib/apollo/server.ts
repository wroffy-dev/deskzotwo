import { randomBytes } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { decryptSecret, digestSecret, encryptSecret } from "@/lib/crypto";
import { notMigratedYet } from "@/lib/not-migrated";
import { notifyUser } from "@/lib/notify";
import { COSTS, creditRefusal } from "@/lib/enrich/credits";
import { companyPath } from "@/lib/record-links";
import { ApolloError, apolloDomain, apolloKeyWorks, bestPhone, enrichCompany, matchPerson, searchPeople, type ApolloCompany, type ApolloPerson, type ApolloSearchPerson } from "@/lib/apollo/client";

/**
 * Apollo.io in a workspace (owner, 14 Nov 2026 — src/lib/apollo/client.ts): the key it pays with, and the lookups made
 * with it, each written to `enrichment_lookups` — what was asked, by whom, what came back. Who may ask is the actions'
 * (src/actions/apollo.ts): `companies.enrich`, on a record they may edit.
 *
 * Nothing a lookup finds overwrites what somebody typed. A company's details are a preview, applied field by field; a
 * contact's email, LinkedIn and mobile fill only what is blank, the rest kept on the lookup for a person to use.
 */

export type ApolloSetup = { connected: boolean; checkedAt: Date | null; error: string | null; webhookPath: string | null };

export async function apolloSetup(): Promise<ApolloSetup> {
  try {
    const row = await db.apolloConnection.findUnique({ where: { id: "default" }, select: { active: true, lastCheckedAt: true, lastError: true, webhookTokenEnc: true } });
    if (!row || !row.active) return { connected: false, checkedAt: null, error: null, webhookPath: null };
    return { connected: true, checkedAt: row.lastCheckedAt, error: row.lastError, webhookPath: `/api/apollo/webhook/${await decryptSecret(row.webhookTokenEnc)}` };
  } catch (err) {
    if (notMigratedYet(err)) return { connected: false, checkedAt: null, error: null, webhookPath: null };
    throw err;
  }
}

/** The key, or null when the workspace has none. */
export async function apolloKey(): Promise<string | null> {
  try {
    const row = await db.apolloConnection.findUnique({ where: { id: "default" }, select: { active: true, apiKeyEnc: true } });
    return row?.active ? decryptSecret(row.apiKeyEnc) : null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** Saves a key Apollo accepts; the webhook's secret is kept across a new key, so the address Apollo has stays right. */
export async function saveApolloKey(key: string, userId: string, fetcher?: typeof fetch): Promise<{ ok: true } | { ok: false; error: string }> {
  const trimmed = key.trim();
  if (!/^[A-Za-z0-9_-]{10,200}$/.test(trimmed)) return { ok: false, error: "That doesn't look like an Apollo API key." };
  const works = await apolloKeyWorks(trimmed, fetcher);
  if (!works.ok) return works;
  const existing = await db.apolloConnection.findUnique({ where: { id: "default" }, select: { webhookTokenEnc: true } });
  const token = existing ? await decryptSecret(existing.webhookTokenEnc) : randomBytes(24).toString("base64url");
  const data = { apiKeyEnc: await encryptSecret(trimmed), webhookTokenHash: await digestSecret(token), webhookTokenEnc: await encryptSecret(token), active: true, lastCheckedAt: new Date(), lastError: null, createdById: userId };
  await db.apolloConnection.upsert({ where: { id: "default" }, create: { id: "default", ...data }, update: data });
  return { ok: true };
}

export async function removeApolloKey(): Promise<void> {
  await db.apolloConnection.deleteMany({ where: { id: "default" } });
}

const errorOf = (err: unknown) => (err instanceof ApolloError ? err.message : "Apollo couldn't be reached.");

async function noteFailure(message: string) {
  await db.apolloConnection.updateMany({ where: { id: "default" }, data: { lastError: message.slice(0, 300) } }).catch(() => undefined);
}

// ─── A company ─────────────────────────────────────────────────────────────────────────────────────

export type CompanyLookup = { lookupId: string; found: ApolloCompany | null; error: string | null };

export async function lookUpCompany(companyId: string, userId: string, fetcher?: typeof fetch): Promise<CompanyLookup> {
  const key = await apolloKey();
  if (!key) return { lookupId: "", found: null, error: "Connect Apollo first, under Settings › Apollo." };
  const overLimit = await creditRefusal(userId, "APOLLO", COSTS.APOLLO.company);
  if (overLimit) return { lookupId: "", found: null, error: overLimit };
  const company = await db.company.findUnique({ where: { id: companyId }, select: { name: true, website: true, contacts: { select: { email: true }, take: 20 } } });
  if (!company) return { lookupId: "", found: null, error: "That company isn't there any more." };
  // Its website, else a work address of one of its people.
  const domain = apolloDomain(company.website) ?? company.contacts.map((c) => apolloDomain(c.email)).find((d) => d && !/^(gmail|yahoo|hotmail|outlook|rediffmail|icloud)\./.test(d)) ?? null;
  if (!domain) return { lookupId: "", found: null, error: "Apollo finds a company by its website — add the website (or a contact's work email) first." };
  try {
    const found = await enrichCompany(key, domain, company.name, fetcher);
    const row = await db.enrichmentLookup.create({
      data: { kind: "COMPANY", companyId, requestedById: userId, status: found ? "DONE" : "NOT_FOUND", externalId: found?.apolloId ?? null, result: (found ?? {}) as Prisma.InputJsonValue, completedAt: new Date() },
      select: { id: true },
    });
    return { lookupId: row.id, found, error: found ? null : `Apollo has no company at ${domain}.` };
  } catch (err) {
    await noteFailure(errorOf(err));
    const row = await db.enrichmentLookup.create({ data: { kind: "COMPANY", companyId, requestedById: userId, status: "FAILED", error: errorOf(err), completedAt: new Date() }, select: { id: true } });
    return { lookupId: row.id, found: null, error: errorOf(err) };
  }
}

/** What a company's lookup may fill, and what each field is on the company now. */
export const COMPANY_FIELDS = ["website", "linkedinUrl", "employeeCount", "industry"] as const;
export type CompanyField = (typeof COMPANY_FIELDS)[number];

export async function applyCompanyLookup(lookupId: string, fields: CompanyField[], userId: string): Promise<{ ok: true; changed: CompanyField[] } | { ok: false; error: string }> {
  const lookup = await db.enrichmentLookup.findUnique({ where: { id: lookupId }, select: { kind: true, status: true, companyId: true, result: true } });
  if (!lookup || lookup.kind !== "COMPANY" || lookup.status !== "DONE" || !lookup.companyId) return { ok: false, error: "That lookup can't be applied." };
  const found = lookup.result as unknown as ApolloCompany;
  const data: Prisma.CompanyUpdateInput = {};
  const changed: CompanyField[] = [];
  for (const f of new Set(fields)) {
    if (f === "website" && found.website) {
      data.website = found.website;
      changed.push(f);
    }
    if (f === "linkedinUrl" && found.linkedinUrl) {
      data.linkedinUrl = found.linkedinUrl;
      changed.push(f);
    }
    if (f === "employeeCount" && found.employees !== null && found.employees >= 0) {
      data.employeeCount = Math.round(found.employees);
      changed.push(f);
    }
    if (f === "industry" && found.industry) {
      const name = found.industry.replace(/\s+/g, " ").trim().replace(/^./, (c) => c.toUpperCase()).slice(0, 100);
      const industry = await db.industry.upsert({ where: { name }, create: { name }, update: {}, select: { id: true } });
      data.industry = { connect: { id: industry.id } };
      changed.push(f);
    }
  }
  if (changed.length) await db.company.update({ where: { id: lookup.companyId }, data, select: { id: true } });
  void userId;
  return { ok: true, changed };
}

/** The latest company lookup that found something, for the card on the company page. */
export async function latestCompanyLookup(companyId: string): Promise<{ id: string; at: Date; found: ApolloCompany; provider: string } | null> {
  try {
    const row = await db.enrichmentLookup.findFirst({ where: { companyId, kind: "COMPANY", status: "DONE" }, orderBy: { createdAt: "desc" }, select: { id: true, createdAt: true, result: true, provider: true } });
    return row ? { id: row.id, at: row.createdAt, found: row.result as unknown as ApolloCompany, provider: row.provider } : null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

// ─── A person ──────────────────────────────────────────────────────────────────────────────────────

export type PersonLookup = { lookupId: string; found: ApolloPerson | null; filled: string[]; kept: { email?: string; linkedinUrl?: string }; mobile: "WAITING" | "NONE" | "FILLED" | "KEPT"; error: string | null };

/**
 * A contact's work email and LinkedIn — and, asked for, their mobile, which Apollo sends to the webhook later. What is
 * blank on the contact is filled; anything already there stays, the finding kept on the lookup.
 */
export async function lookUpContact(contactId: string, userId: string, opts: { mobile: boolean; origin: string }, fetcher?: typeof fetch): Promise<PersonLookup> {
  const none: PersonLookup = { lookupId: "", found: null, filled: [], kept: {}, mobile: "NONE", error: null };
  const key = await apolloKey();
  if (!key) return { ...none, error: "Connect Apollo first, under Settings › Apollo." };
  const overLimit = await creditRefusal(userId, "APOLLO", COSTS.APOLLO.person + (opts.mobile ? COSTS.APOLLO.mobile : 0));
  if (overLimit) return { ...none, error: overLimit };
  const contact = await db.contact.findUnique({ where: { id: contactId }, select: { name: true, email: true, phone: true, linkedinUrl: true, companyId: true, company: { select: { name: true, website: true } } } });
  if (!contact) return { ...none, error: "That contact isn't there any more." };
  const domain = apolloDomain(contact.company.website) ?? apolloDomain(contact.email);
  const setup = opts.mobile ? await apolloSetup() : null;
  const mobile = opts.mobile && setup?.webhookPath ? { webhookUrl: `${opts.origin}${setup.webhookPath}` } : null;
  try {
    const found = await matchPerson(key, { name: contact.name, domain, organizationName: contact.company.name, email: contact.email, linkedinUrl: contact.linkedinUrl }, mobile, fetcher);
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
    // A phone that came back at once.
    const now = found ? bestPhone(found.phones) : null;
    let mobileState: PersonLookup["mobile"] = "NONE";
    if (now) {
      if (!contact.phone) {
        data.phone = now.number;
        filled.push("phone");
        mobileState = "FILLED";
      } else mobileState = "KEPT";
    }
    if (filled.length) await db.contact.update({ where: { id: contactId }, data, select: { id: true } });
    const row = await db.enrichmentLookup.create({
      data: { kind: "PERSON", companyId: contact.companyId, contactId, requestedById: userId, status: found ? "DONE" : "NOT_FOUND", externalId: found?.apolloId ?? null, result: { ...(found ?? {}), kept } as Prisma.InputJsonValue, completedAt: new Date() },
      select: { id: true },
    });
    // The mobile, to come: a lookup waiting for Apollo's webhook to name this person.
    if (mobile && found?.apolloId && !now) {
      await db.enrichmentLookup.create({ data: { kind: "MOBILE", companyId: contact.companyId, contactId, requestedById: userId, status: "WAITING", externalId: found.apolloId } });
      mobileState = "WAITING";
    }
    return { lookupId: row.id, found, filled, kept, mobile: mobileState, error: found ? null : "Apollo didn't find this person at this company." };
  } catch (err) {
    await noteFailure(errorOf(err));
    const row = await db.enrichmentLookup.create({ data: { kind: "PERSON", companyId: contact.companyId, contactId, requestedById: userId, status: "FAILED", error: errorOf(err), completedAt: new Date() }, select: { id: true } });
    return { ...none, lookupId: row.id, error: errorOf(err) };
  }
}

/**
 * Apollo's webhook: mobiles for people asked about. Each is matched to a lookup still WAITING for that person — what
 * Apollo sends for anyone else is ignored. The mobile fills the contact's phone when it is blank; else it is kept on the
 * lookup. Whoever asked is told either way. Idempotent: a lookup is finished once, so a retried delivery changes nothing.
 */
export async function receiveMobiles(people: { apolloId: string; phones: { number: string; type: string | null; status: string | null }[] }[]): Promise<{ apolloId: string; contactId: string; requestedById: string | null; number: string | null; filled: boolean }[]> {
  const out: { apolloId: string; contactId: string; requestedById: string | null; number: string | null; filled: boolean }[] = [];
  for (const p of people.slice(0, 50)) {
    const waiting = await db.enrichmentLookup.findMany({ where: { kind: "MOBILE", status: "WAITING", externalId: p.apolloId }, select: { id: true, contactId: true, requestedById: true } });
    for (const w of waiting) {
      const phone = bestPhone(p.phones);
      const claimed = await db.enrichmentLookup.updateMany({
        where: { id: w.id, status: "WAITING" },
        data: { status: phone ? "DONE" : "NOT_FOUND", result: { phones: p.phones } as Prisma.InputJsonValue, completedAt: new Date() },
      });
      if (claimed.count === 0 || !w.contactId) continue;
      let filled = false;
      if (phone) {
        const contact = await db.contact.findUnique({ where: { id: w.contactId }, select: { phone: true } });
        if (contact && !contact.phone) {
          await db.contact.update({ where: { id: w.contactId }, data: { phone: phone.number }, select: { id: true } });
          filled = true;
        }
      }
      out.push({ apolloId: p.apolloId, contactId: w.contactId, requestedById: w.requestedById, number: phone?.number ?? null, filled });
    }
  }
  return out;
}

// ─── People at a company ───────────────────────────────────────────────────────────────────────────

export async function searchCompanyPeople(companyId: string, titles: string[], userId: string, fetcher?: typeof fetch): Promise<{ people: ApolloSearchPerson[]; total: number; error: string | null }> {
  const key = await apolloKey();
  if (!key) return { people: [], total: 0, error: "Connect Apollo first, under Settings › Apollo." };
  const company = await db.company.findUnique({ where: { id: companyId }, select: { website: true, contacts: { select: { email: true }, take: 20 } } });
  const domain = apolloDomain(company?.website) ?? company?.contacts.map((c) => apolloDomain(c.email)).find(Boolean) ?? null;
  if (!domain) return { people: [], total: 0, error: "Apollo finds people by the company's website — add it first." };
  const cleaned = titles.map((t) => t.trim()).filter(Boolean).slice(0, 10);
  try {
    const result = await searchPeople(key, domain, cleaned, fetcher);
    await db.enrichmentLookup.create({ data: { kind: "SEARCH", companyId, requestedById: userId, status: result.people.length ? "DONE" : "NOT_FOUND", result: { titles: cleaned, total: result.total, count: result.people.length } as Prisma.InputJsonValue, completedAt: new Date() } });
    return { ...result, error: null };
  } catch (err) {
    await noteFailure(errorOf(err));
    return { people: [], total: 0, error: errorOf(err) };
  }
}

/** A person found by the search, in full — by Apollo's id (a credit) — ready to add as a contact. */
export async function revealSearchPerson(companyId: string, apolloId: string, userId: string, fetcher?: typeof fetch): Promise<{ found: ApolloPerson | null; error: string | null }> {
  const key = await apolloKey();
  if (!key) return { found: null, error: "Connect Apollo first, under Settings › Apollo." };
  const overLimit = await creditRefusal(userId, "APOLLO", COSTS.APOLLO.person);
  if (overLimit) return { found: null, error: overLimit };
  try {
    const found = await matchPerson(key, { apolloId }, null, fetcher);
    await db.enrichmentLookup.create({ data: { kind: "PERSON", companyId, requestedById: userId, status: found ? "DONE" : "NOT_FOUND", externalId: apolloId, result: (found ?? {}) as Prisma.InputJsonValue, completedAt: new Date() } });
    return { found, error: found ? null : "Apollo couldn't find that person any more." };
  } catch (err) {
    await noteFailure(errorOf(err));
    return { found: null, error: errorOf(err) };
  }
}

/** Tells whoever asked that a mobile came (or didn't) — from the webhook route. Here, not in the actions: a server action is callable from any browser. */
export async function tellMobileFound(requestedById: string, contactId: string, number: string | null, filled: boolean): Promise<void> {
  const contact = await db.contact.findUnique({ where: { id: contactId }, select: { name: true, company: { select: { companySeq: true, name: true } } } });
  if (!contact) return;
  await notifyUser({
    userId: requestedById,
    type: "ACCOUNT_MANAGER_ASSIGNED",
    title: number ? `Apollo found ${contact.name}'s phone` : `Apollo has no phone for ${contact.name}`,
    message: number ? (filled ? `${number} is on ${contact.name} at ${contact.company.name} now.` : `${number} — ${contact.name} already had a phone, so it wasn't changed.`) : `Nothing came back for ${contact.name} at ${contact.company.name}.`,
    link: companyPath(contact.company.companySeq),
  }).catch(() => undefined);
}
