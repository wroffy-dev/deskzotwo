/**
 * Ved's lookalikes (owner, 22 Nov 2026 — "go with ved finds lookalike prospects", after reading Explee): what your best
 * customers look like, from your own records — not guessed from a website — and the search for more like them. Pure:
 * src/lib/prospects/server.ts reads the records and asks Apollo.
 *
 *   · Best customers: those who've spent the most with you, and those you won a lead with in the last two years.
 *   · What they have in common: their industry, where they are, how big, who bought (the buyers' designations), and —
 *     where Apollo looked a company up before — Apollo's own id for it, which its search takes as "companies like these".
 *   · Nothing of a person goes to Apollo: designations, places, sizes and industries only.
 */

export type BestCustomer = {
  id: string;
  industry: string | null;
  city: string | null;
  state: string | null;
  country: string | null;
  employees: number | null;
  /** The designations of the people who bought — on won leads, else the primary contact. */
  buyers: string[];
  /** Apollo's id for the company, from a lookup before. */
  apolloId: string | null;
};

export type Counted = { value: string; count: number };

export type LookalikeProfile = {
  basedOn: number;
  industries: Counted[];
  places: Counted[];
  sizes: Counted[];
  titles: Counted[];
  /** Apollo ids of the best customers it knows — at most five, the most valuable first. */
  seeds: string[];
};

/** Apollo's company sizes, as its search takes them ("min,max"). */
export const SIZE_RANGES = ["1,10", "11,50", "51,200", "201,500", "501,1000", "1001,5000", "5001,10000", "10001,1000000"] as const;
export const SIZE_LABELS: Record<string, string> = {
  "1,10": "1–10 people",
  "11,50": "11–50",
  "51,200": "51–200",
  "201,500": "201–500",
  "501,1000": "501–1,000",
  "1001,5000": "1,001–5,000",
  "5001,10000": "5,001–10,000",
  "10001,1000000": "10,000+",
};

export function sizeRange(employees: number | null): string | null {
  if (employees === null || !Number.isFinite(employees) || employees <= 0) return null;
  for (const r of SIZE_RANGES) {
    const [, max] = r.split(",").map(Number) as [number, number];
    if (employees <= max) return r;
  }
  return SIZE_RANGES[SIZE_RANGES.length - 1]!;
}

/** "Maharashtra, India" — the company's state and country, or the city's where there's no state. */
export function placeOf(c: Pick<BestCustomer, "city" | "state" | "country">, homeCountry: string | null): string | null {
  const country = c.country?.trim() || homeCountry;
  const region = c.state?.trim() || c.city?.trim() || null;
  if (region && country) return `${region}, ${country}`;
  return region ?? country ?? null;
}

const tally = (values: (string | null | undefined)[], max: number): Counted[] => {
  const counts = new Map<string, { value: string; count: number }>();
  for (const raw of values) {
    const value = raw?.replace(/\s+/g, " ").trim();
    if (!value) continue;
    const key = value.toLowerCase();
    const had = counts.get(key);
    if (had) had.count += 1;
    else counts.set(key, { value, count: 1 });
  }
  return [...counts.values()].sort((a, b) => b.count - a.count || a.value.localeCompare(b.value)).slice(0, max);
};

/** What the best customers have in common — `rows` most valuable first. */
export function buildProfile(rows: BestCustomer[], homeCountry: string | null): LookalikeProfile {
  return {
    basedOn: rows.length,
    industries: tally(rows.map((r) => r.industry), 8),
    places: tally(rows.map((r) => placeOf(r, homeCountry)), 8),
    sizes: tally(rows.map((r) => sizeRange(r.employees)), 8).sort((a, b) => SIZE_RANGES.indexOf(a.value as never) - SIZE_RANGES.indexOf(b.value as never)),
    // A buyer counted once per company, so one company with ten IT managers doesn't make the profile.
    titles: tally(rows.flatMap((r) => [...new Set(r.buyers.map((b) => b.trim()).filter((b) => b && !/^other$/i.test(b)))]), 10),
    seeds: [...new Set(rows.map((r) => r.apolloId).filter((id): id is string => !!id))].slice(0, 5),
  };
}

/** What the search asks for — chosen from the profile, or typed. */
export type LookalikeFilters = { titles: string[]; places: string[]; sizes: string[]; industries: string[]; useSeeds: boolean };

const clean = (list: unknown, max: number, len = 80): string[] =>
  Array.isArray(list)
    ? [...new Set(list.map((v) => (typeof v === "string" ? v.replace(/\s+/g, " ").trim().slice(0, len) : "")).filter(Boolean))].slice(0, max)
    : [];

/** Filters as they came from a browser: trimmed, capped, sizes only Apollo's own. */
export function cleanFilters(input: unknown): LookalikeFilters {
  const o = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  return {
    titles: clean(o.titles, 15),
    places: clean(o.places, 10, 120),
    sizes: clean(o.sizes, SIZE_RANGES.length).filter((s) => (SIZE_RANGES as readonly string[]).includes(s)),
    industries: clean(o.industries, 10),
    useSeeds: o.useSeeds === true,
  };
}

/** The filters as Apollo's search takes them: industries in its lowercase names. Null when there's nothing to search by. */
export function searchQuery(f: LookalikeFilters, seeds: string[], page: number) {
  const lookalikeIds = f.useSeeds ? seeds.slice(0, 5) : [];
  if (!f.titles.length && !f.places.length && !f.sizes.length && !f.industries.length && !lookalikeIds.length) return null;
  return {
    titles: f.titles,
    seniorities: [] as string[],
    locations: f.places,
    sizes: f.sizes,
    industries: f.industries.map((i) => i.toLowerCase()),
    lookalikeIds,
    page: Math.max(1, Math.min(20, Math.floor(page) || 1)),
    perPage: 25,
  };
}

/** The first filters offered: the top two or three of each, and the seeds when there are any. */
export function startingFilters(p: LookalikeProfile): LookalikeFilters {
  return {
    titles: p.titles.slice(0, 3).map((t) => t.value),
    places: p.places.slice(0, 2).map((t) => t.value),
    sizes: p.sizes.filter((s) => s.count >= Math.max(1, Math.round(p.basedOn * 0.15))).map((s) => s.value),
    industries: p.industries.slice(0, 2).map((t) => t.value),
    useSeeds: p.seeds.length > 0,
  };
}

/** A contact's designation type from a job title, for a prospect added — the name itself is kept as their designation. */
export function designationFromTitle(title: string | null): "CEO" | "CIO" | "DIRECTOR" | "IT_HEAD" | "IT_MANAGER" | "PURCHASE_MANAGER" | "HR" | "OTHER" {
  const t = (title ?? "").toLowerCase();
  if (/\b(ceo|chief executive|founder|managing director|owner|proprietor)\b/.test(t)) return "CEO";
  if (/\b(cio|cto|chief information|chief technology)\b/.test(t)) return "CIO";
  if (/\b(purchase|procurement|buyer|sourcing)\b/.test(t)) return "PURCHASE_MANAGER";
  if (/\b(hr|human resources|people|talent)\b/.test(t)) return "HR";
  if (/\b(it|information technology|infrastructure|systems)\b/.test(t)) return /\b(head|vp|vice president|director)\b/.test(t) ? "IT_HEAD" : "IT_MANAGER";
  if (/\b(director|vp|vice president)\b/.test(t)) return "DIRECTOR";
  return "OTHER";
}
