/**
 * Apollo.io's API (owner, 14 Nov 2026 — "lets integrate Apollo for data enrichment"), with the workspace's own key: each
 * Deskzo customer pays Apollo for what they look up. https://docs.apollo.io — the key goes in the `x-api-key` header.
 *
 *   · organizations/enrich (GET, 1 credit): a company by its domain — industry, employees, social links, phone, founded,
 *     revenue, description, logo.
 *   · people/match (POST): a person by name and company domain, or by Apollo's id — their work email, title, LinkedIn.
 *     With `reveal_phone_number` and a `webhook_url`, Apollo looks for their phones and POSTs them there minutes later
 *     (more credits). The webhook is signed by nothing: the address's own secret is all a sender has.
 *   · mixed_people/api_search (POST, no credits): people at a company by title — first name and title only; adding one
 *     takes a people/match by its id.
 *
 * The readers here are pure: they take Apollo's JSON however much of it came back and keep only what Deskzo uses.
 */

const BASE = "https://api.apollo.io";
const TIMEOUT_MS = 20_000;

export class ApolloError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

type Json = Record<string, unknown>;
const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && v.trim() && Number.isFinite(Number(v)) ? Number(v) : null);
const obj = (v: unknown): Json => (v && typeof v === "object" && !Array.isArray(v) ? (v as Json) : {});

/** One call to Apollo. Its own words when it refuses — a bad key, no credits, a plan without API access. */
export async function apolloCall(key: string, method: "GET" | "POST", path: string, params: Record<string, unknown> = {}, fetcher: typeof fetch = fetch): Promise<Json> {
  const url = new URL(path, BASE);
  const query = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) for (const item of v) query.append(`${k}[]`, String(item));
    else query.set(k, String(v));
  }
  url.search = query.toString();
  const res = await fetcher(url, {
    method,
    headers: { "x-api-key": key, "content-type": "application/json", accept: "application/json", "cache-control": "no-cache" },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  }).catch((err: unknown) => {
    throw new ApolloError(`Apollo didn't answer: ${err instanceof Error ? err.message : "no connection"}.`, 0);
  });
  const text = await res.text();
  let body: Json = {};
  try {
    body = text ? obj(JSON.parse(text)) : {};
  } catch {
    body = {};
  }
  if (!res.ok) {
    const said = str(body.error) ?? str(body.message) ?? str((obj(body.errors) as Json).message) ?? text.slice(0, 200);
    const why =
      res.status === 401 ? "Apollo didn't accept the API key." :
      res.status === 403 ? `Apollo refused it — the key may not include this part of the API, or the plan has no API access${said ? ` (${said})` : ""}.` :
      res.status === 422 && /credit/i.test(said) ? "The Apollo account is out of credits." :
      res.status === 429 ? "Too many lookups at once — Apollo asked to slow down. Try again in a minute." :
      `Apollo answered ${res.status}${said ? `: ${said}` : ""}.`;
    throw new ApolloError(why, res.status);
  }
  return body;
}

/** A key that works: Apollo's own health check. */
export async function apolloKeyWorks(key: string, fetcher?: typeof fetch): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const body = await apolloCall(key, "GET", "/v1/auth/health", {}, fetcher);
    return body.is_logged_in === false ? { ok: false, error: "Apollo didn't accept the API key." } : { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof ApolloError ? err.message : "Apollo couldn't be reached." };
  }
}

// ─── Companies ─────────────────────────────────────────────────────────────────────────────────────

export type ApolloCompany = {
  apolloId: string | null;
  name: string | null;
  website: string | null;
  domain: string | null;
  linkedinUrl: string | null;
  twitterUrl: string | null;
  facebookUrl: string | null;
  employees: number | null;
  industry: string | null;
  foundedYear: number | null;
  revenue: string | null;
  description: string | null;
  logoUrl: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
};

export function readCompany(body: unknown): ApolloCompany | null {
  const o = obj(obj(body).organization);
  if (!Object.keys(o).length) return null;
  const phone = str(obj(o.primary_phone).sanitized_number) ?? str(obj(o.primary_phone).number) ?? str(o.phone) ?? str(o.sanitized_phone);
  return {
    apolloId: str(o.id),
    name: str(o.name),
    website: str(o.website_url),
    domain: str(o.primary_domain),
    linkedinUrl: str(o.linkedin_url),
    twitterUrl: str(o.twitter_url),
    facebookUrl: str(o.facebook_url),
    employees: num(o.estimated_num_employees),
    industry: str(o.industry),
    foundedYear: num(o.founded_year),
    revenue: str(o.annual_revenue_printed) ?? (num(o.annual_revenue) !== null ? String(num(o.annual_revenue)) : null),
    description: str(o.short_description) ?? str(o.seo_description),
    logoUrl: str(o.logo_url),
    phone,
    address: str(o.raw_address),
    city: str(o.city),
    state: str(o.state),
    country: str(o.country),
  };
}

/** A domain as Apollo wants it: "https://www.Acme.co.in/about" → "acme.co.in". */
export function apolloDomain(website: string | null | undefined): string | null {
  const v = (website ?? "").trim().toLowerCase();
  if (!v) return null;
  const host = v.includes("@") ? v.split("@").pop()! : v.replace(/^[a-z]+:\/\//, "").split(/[/?#:]/)[0]!;
  const clean = host.replace(/^www\./, "");
  return /^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(clean) ? clean : null;
}

export async function enrichCompany(key: string, domain: string, name?: string | null, fetcher?: typeof fetch): Promise<ApolloCompany | null> {
  return readCompany(await apolloCall(key, "GET", "/api/v1/organizations/enrich", { domain, name: name ?? undefined }, fetcher));
}

// ─── People ────────────────────────────────────────────────────────────────────────────────────────

export type ApolloPerson = {
  apolloId: string | null;
  /** The company they work at, as Apollo has it — what a prospect is added under (src/lib/prospects). */
  organization?: ApolloCompany | null;
  name: string | null;
  firstName: string | null;
  lastName: string | null;
  title: string | null;
  email: string | null;
  /** Apollo's word on it: "verified", "guessed", "unavailable"… */
  emailStatus: string | null;
  linkedinUrl: string | null;
  /** Any phones that came back at once (most come by webhook). */
  phones: ApolloPhone[];
  /** "pending" when Apollo is still looking for a mobile and will POST it. */
  phoneStatus: string | null;
};

export type ApolloPhone = { number: string; type: string | null; status: string | null };

function readPhones(list: unknown): ApolloPhone[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((p) => obj(p))
    .map((p) => ({ number: str(p.sanitized_number) ?? str(p.raw_number) ?? "", type: str(p.type_cd) ?? str(p.type), status: str(p.status_cd) ?? str(p.status) }))
    .filter((p) => p.number);
}

export function readPerson(body: unknown): ApolloPerson | null {
  const b = obj(body);
  const p = obj(b.person);
  if (!Object.keys(p).length) return null;
  // Apollo hides an address it hasn't revealed behind a placeholder.
  const email = str(p.email);
  return {
    apolloId: str(p.id),
    name: str(p.name) ?? ([str(p.first_name), str(p.last_name)].filter(Boolean).join(" ") || null),
    firstName: str(p.first_name),
    lastName: str(p.last_name),
    title: str(p.title),
    email: email && !/not_unlocked|email_not_unlocked/i.test(email) ? email : null,
    emailStatus: str(p.email_status),
    linkedinUrl: str(p.linkedin_url),
    phones: readPhones(p.phone_numbers),
    phoneStatus: str(obj(b.phone_enrichment).status),
    organization: readCompany({ organization: p.organization }),
  };
}

export async function matchPerson(
  key: string,
  who: { apolloId?: string; name?: string; domain?: string | null; organizationName?: string | null; email?: string | null; linkedinUrl?: string | null },
  mobile: { webhookUrl: string } | null,
  fetcher?: typeof fetch,
): Promise<ApolloPerson | null> {
  return readPerson(
    await apolloCall(
      key,
      "POST",
      "/api/v1/people/match",
      {
        id: who.apolloId,
        name: who.apolloId ? undefined : who.name,
        domain: who.domain ?? undefined,
        organization_name: who.organizationName ?? undefined,
        email: who.email ?? undefined,
        linkedin_url: who.linkedinUrl ?? undefined,
        reveal_personal_emails: false,
        reveal_phone_number: mobile ? true : undefined,
        webhook_url: mobile?.webhookUrl,
      },
      fetcher,
    ),
  );
}

export type ApolloSearchPerson = {
  apolloId: string;
  firstName: string | null;
  lastNameHint: string | null;
  title: string | null;
  hasEmail: boolean;
  hasPhone: boolean;
  /** The company's name — all a search gives of it; the rest comes with the person (src/lib/prospects). */
  organizationName?: string | null;
};

export function readSearch(body: unknown): { people: ApolloSearchPerson[]; total: number } {
  const b = obj(body);
  const list = Array.isArray(b.people) ? b.people : [];
  return {
    total: num(b.total_entries) ?? num(obj(b.pagination).total_entries) ?? list.length,
    people: list
      .map((x) => obj(x))
      .map((x) => ({
        apolloId: str(x.id) ?? "",
        firstName: str(x.first_name),
        lastNameHint: str(x.last_name_obfuscated) ?? str(x.last_name),
        title: str(x.title),
        hasEmail: x.has_email === true,
        hasPhone: x.has_direct_phone === true || x.has_direct_phone === "Yes",
        organizationName: str(obj(x.organization).name),
      }))
      .filter((x) => x.apolloId),
  };
}

export async function searchPeople(key: string, domain: string, titles: string[], fetcher?: typeof fetch): Promise<{ people: ApolloSearchPerson[]; total: number }> {
  return readSearch(
    await apolloCall(key, "POST", "/api/v1/mixed_people/api_search", { q_organization_domains_list: [domain], person_titles: titles.length ? titles : undefined, per_page: 25, page: 1 }, fetcher),
  );
}

/**
 * People anywhere who fit a description (owner, 22 Nov 2026 — Ved's lookalikes, src/lib/prospects): the same free search
 * as above, by titles, seniorities, the companies' places, sizes and industries, and up to five companies to look like.
 * Names come half hidden and with no email — adding one takes a people/match by its id, a credit.
 */
export async function searchProspects(
  key: string,
  q: { titles: string[]; seniorities: string[]; locations: string[]; sizes: string[]; industries: string[]; lookalikeIds: string[]; page: number; perPage: number },
  fetcher?: typeof fetch,
): Promise<{ people: ApolloSearchPerson[]; total: number }> {
  return readSearch(
    await apolloCall(
      key,
      "POST",
      "/api/v1/mixed_people/api_search",
      {
        person_titles: q.titles.length ? q.titles : undefined,
        person_seniorities: q.seniorities.length ? q.seniorities : undefined,
        organization_locations: q.locations.length ? q.locations : undefined,
        organization_num_employees_ranges: q.sizes.length ? q.sizes : undefined,
        organization_industries: q.industries.length ? q.industries : undefined,
        lookalike_organization_ids: q.lookalikeIds.length ? q.lookalikeIds.slice(0, 5) : undefined,
        contact_email_status: ["verified", "likely to engage"],
        per_page: q.perPage,
        page: q.page,
      },
      fetcher,
    ),
  );
}

/** Apollo's webhook with mobiles: each person by id, their phones. */
export function readPhoneWebhook(body: unknown): { apolloId: string; phones: ApolloPhone[] }[] {
  const list = Array.isArray(obj(body).people) ? (obj(body).people as unknown[]) : [];
  return list
    .map((x) => obj(x))
    .map((x) => ({ apolloId: str(x.id) ?? "", phones: readPhones(x.phone_numbers) }))
    .filter((x) => x.apolloId);
}

/** The phone to keep: a mobile first, then a direct line, then any. */
export function bestPhone(phones: ApolloPhone[]): ApolloPhone | null {
  return phones.find((p) => /mobile/i.test(p.type ?? "")) ?? phones.find((p) => /direct/i.test(p.type ?? "")) ?? phones[0] ?? null;
}
