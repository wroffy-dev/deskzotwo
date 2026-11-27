import type { ApolloCompany, ApolloPerson, ApolloPhone, ApolloSearchPerson } from "@/lib/apollo/client";

/**
 * Lusha's API, v3 (owner, 14 Nov 2026 — "lusha integration also"), with the workspace's own key in the `api_key`
 * header. https://docs.lusha.com — every endpoint takes batches; Deskzo sends one at a time.
 *
 *   · GET  /v3/account/usage — credits and plan; tries a key without spending.
 *   · POST /v3/companies/search-and-enrich — a company by domain (or name): industry, employees, description, founded,
 *     LinkedIn, logo, location, phones.
 *   · POST /v3/contacts/search-and-enrich — a person by name and company domain (or email, or LinkedIn), with
 *     `reveal: ["emails","phones"]`: their emails and phones at once — no webhook. Each phone says whether it is on a
 *     do-not-call list; such a number is never written to a contact.
 *   · POST /v3/contacts/prospecting — people at a company by job title.
 *   · POST /v3/contacts/enrich — one the prospecting found, by its id, revealed.
 *
 * The readers turn Lusha's answers into the shapes Apollo's use (src/lib/apollo/client.ts), so the company page shows
 * either the same way.
 */

const BASE = "https://api.lusha.com";
const TIMEOUT_MS = 20_000;

export class LushaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export async function lushaCall(key: string, method: "GET" | "POST", path: string, body: unknown = undefined, fetcher: typeof fetch = fetch): Promise<Json> {
  const res = await fetcher(new URL(path, BASE), {
    method,
    headers: { api_key: key, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err: unknown) => {
    throw new LushaError(`Lusha didn't answer: ${err instanceof Error ? err.message : "no connection"}.`, 0);
  });
  const text = await res.text();
  let parsed: Json = {};
  try {
    parsed = text ? obj(JSON.parse(text)) : {};
  } catch {
    parsed = {};
  }
  if (!res.ok) {
    const said = str(parsed.message) ?? str(parsed.error) ?? text.slice(0, 200);
    const why =
      res.status === 401 ? "Lusha didn't accept the API key." :
      res.status === 403 ? `Lusha refused it — the account may be inactive or the plan without API access${said ? ` (${said})` : ""}.` :
      res.status === 402 || /credit/i.test(said) ? "The Lusha account is out of credits." :
      res.status === 429 ? "Too many lookups — Lusha asked to slow down. Try again later." :
      `Lusha answered ${res.status}${said ? `: ${said}` : ""}.`;
    throw new LushaError(why, res.status);
  }
  return parsed;
}

/** A key that works, and the credits left: Lusha's usage, which spends nothing. */
export async function lushaKeyWorks(key: string, fetcher?: typeof fetch): Promise<{ ok: true; creditsLeft: number | null } | { ok: false; error: string }> {
  try {
    const body = await lushaCall(key, "GET", "/v3/account/usage", undefined, fetcher);
    return { ok: true, creditsLeft: num(obj(body.credits).remaining) };
  } catch (err) {
    return { ok: false, error: err instanceof LushaError ? err.message : "Lusha couldn't be reached." };
  }
}

// ─── Companies ─────────────────────────────────────────────────────────────────────────────────────

export function readLushaCompany(body: unknown): ApolloCompany | null {
  const c = obj(arr(obj(body).results)[0]);
  if (!str(c.id) && !str(c.name)) return null;
  const social = obj(c.socialLinks);
  const employees = obj(c.employeeCount);
  const location = obj(c.location);
  const domain = str(c.domain)?.replace(/^www\./, "") ?? null;
  const phone = str(obj(arr(c.phones)[0]).number);
  const revenue = obj(c.revenueRange);
  return {
    apolloId: str(c.id),
    name: str(c.name),
    website: domain ? `https://${domain}` : null,
    domain,
    linkedinUrl: str(social.linkedin),
    twitterUrl: str(social.twitter),
    facebookUrl: str(social.facebook),
    employees: num(employees.exact) ?? num(employees.max) ?? num(employees.min),
    industry: str(c.subIndustry) ?? str(c.industry),
    foundedYear: num(c.yearFounded),
    revenue: str(revenue.label) ?? (num(revenue.min) !== null && num(revenue.max) !== null ? `${num(revenue.min)}–${num(revenue.max)}` : null),
    description: str(c.description),
    logoUrl: str(c.logoUrl),
    phone,
    address: null,
    city: str(location.city),
    state: str(location.state),
    country: str(location.country),
  };
}

export async function lushaCompany(key: string, domain: string, name?: string | null, fetcher?: typeof fetch): Promise<ApolloCompany | null> {
  return readLushaCompany(
    await lushaCall(key, "POST", "/v3/companies/search-and-enrich", { companies: [{ clientReferenceId: "1", domain, ...(name ? { name } : {}) }], options: { includePartialProfiles: true } }, fetcher),
  );
}

// ─── People ────────────────────────────────────────────────────────────────────────────────────────

/** Lusha's phones, the do-not-call ones marked as such. */
export type LushaPhone = ApolloPhone & { doNotCall: boolean };

export type LushaPerson = ApolloPerson & { phonesWithDnc: LushaPhone[] };

export function readLushaPerson(result: unknown): LushaPerson | null {
  const p = obj(result);
  if (!str(p.id) && !str(p.fullName) && !str(p.firstName)) return null;
  const emails = arr(p.emails).map((e) => obj(e));
  // A work address first, the surest of them.
  const email = str(emails.find((e) => e.type === "work")?.email) ?? str(emails[0]?.email);
  const phones: LushaPhone[] = arr(p.phones)
    .map((x) => obj(x))
    .map((x) => ({ number: str(x.number) ?? "", type: str(x.type), status: null, doNotCall: x.doNotCall === true }))
    .filter((x) => x.number);
  return {
    apolloId: str(p.id),
    name: str(p.fullName) ?? ([str(p.firstName), str(p.lastName)].filter(Boolean).join(" ") || null),
    firstName: str(p.firstName),
    lastName: str(p.lastName),
    title: str(obj(p.jobTitle).title) ?? str(p.jobTitle),
    email,
    emailStatus: str(emails.find((e) => str(e.email) === email)?.confidence),
    linkedinUrl: str(obj(p.socialLinks).linkedin),
    phones: phones.filter((x) => !x.doNotCall),
    phoneStatus: null,
    phonesWithDnc: phones,
  };
}

export async function lushaPerson(
  key: string,
  who: { firstName?: string | null; lastName?: string | null; companyName?: string | null; domain?: string | null; email?: string | null; linkedinUrl?: string | null },
  reveal: { phones: boolean },
  fetcher?: typeof fetch,
): Promise<LushaPerson | null> {
  const contact: Json = { clientReferenceId: "1" };
  if (who.linkedinUrl) contact.linkedinUrl = who.linkedinUrl;
  else if (who.email) contact.email = who.email;
  else Object.assign(contact, { firstName: who.firstName ?? undefined, lastName: who.lastName ?? undefined, companyName: who.companyName ?? undefined, companyDomain: who.domain ?? undefined });
  const body = await lushaCall(key, "POST", "/v3/contacts/search-and-enrich", { contacts: [contact], reveal: reveal.phones ? ["emails", "phones"] : ["emails"], options: { includePartialProfiles: true } }, fetcher);
  return readLushaPerson(arr(body.results)[0]);
}

export async function lushaPersonById(key: string, id: string, reveal: { phones: boolean }, fetcher?: typeof fetch): Promise<LushaPerson | null> {
  const body = await lushaCall(key, "POST", "/v3/contacts/enrich", { ids: [id], reveal: reveal.phones ? ["emails", "phones"] : ["emails"] }, fetcher);
  return readLushaPerson(arr(body.results)[0]);
}

export function readLushaProspects(body: unknown): { people: ApolloSearchPerson[]; total: number } {
  const b = obj(body);
  const people = arr(b.results)
    .map((x) => obj(x))
    .map((x) => ({
      apolloId: str(x.id) ?? "",
      firstName: str(x.firstName),
      lastNameHint: str(x.lastName),
      title: str(obj(x.jobTitle).title) ?? str(x.jobTitle),
      hasEmail: arr(x.has).includes("emails") || arr(x.has).includes("work_email"),
      hasPhone: arr(x.has).includes("phones") || arr(x.has).includes("mobile_phone"),
    }))
    .filter((x) => x.apolloId);
  return { people, total: num(obj(b.pagination).total) ?? people.length };
}

export async function lushaProspects(key: string, domain: string, titles: string[], fetcher?: typeof fetch): Promise<{ people: ApolloSearchPerson[]; total: number }> {
  return readLushaProspects(
    await lushaCall(
      key,
      "POST",
      "/v3/contacts/prospecting",
      {
        pagination: { page: 0, size: 25 },
        filters: { contacts: { include: titles.length ? { jobTitles: titles } : {} }, companies: { include: { domains: [domain] } } },
        options: { includePartialProfiles: true },
      },
      fetcher,
    ),
  );
}
