import { db } from "@/lib/db";
import { notMigratedYet } from "@/lib/not-migrated";

/**
 * Credits per person for Apollo and Lusha (owner, 15 Nov 2026 — "admin can assign the credits to each users for apollo
 * and lusha"). An admin sets a monthly limit per provider: one for everybody, and any person's own over it. No limit set
 * is no limit, as before.
 *
 * What a person has used is worked out from their lookups this month (`enrichment_lookups`), each at what the provider
 * charges for it — Apollo: a company or a person 1, a mobile about 8, a people search nothing; Lusha: a company or a
 * person 1, a phone 5 more, a search 1. The providers bill the workspace's account; these are Deskzo's own count, to keep
 * one person from spending everybody's. A lookup that found nothing or failed counts nothing.
 */

export type Provider = "APOLLO" | "LUSHA";
export const EVERYBODY = "*";

/** What each kind of lookup costs, before it's made. */
export const COSTS = {
  APOLLO: { company: 1, person: 1, mobile: 8, search: 0 },
  LUSHA: { company: 1, person: 1, mobile: 5, search: 1 },
} as const satisfies Record<Provider, Record<"company" | "person" | "mobile" | "search", number>>;

type LookupRow = { provider: string; kind: string; status: string; result: unknown };

/** What a lookup cost, after: by what it was and what came back. */
export function costOf(row: LookupRow): number {
  if (row.status !== "DONE" && row.status !== "WAITING") return 0;
  const provider = row.provider === "LUSHA" ? "LUSHA" : "APOLLO";
  const c = COSTS[provider];
  if (row.kind === "COMPANY") return c.company;
  if (row.kind === "SEARCH") return c.search;
  if (row.kind === "MOBILE") return c.mobile;
  if (row.kind === "PERSON") {
    // Lusha charges for phones when any came back; Apollo's mobile is its own MOBILE lookup.
    const phones = (row.result as { phonesWithDnc?: unknown[] } | null)?.phonesWithDnc;
    return c.person + (provider === "LUSHA" && Array.isArray(phones) && phones.length > 0 ? c.mobile : 0);
  }
  return 0;
}

/** The first moment of this calendar month, UTC — the providers reset their credits by the month too. */
export function monthStart(now = new Date()): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

/** Credits a person has used with a provider this month. */
export async function usedThisMonth(userId: string, provider: Provider, now = new Date()): Promise<number> {
  const rows = await db.enrichmentLookup.findMany({
    where: { requestedById: userId, provider, createdAt: { gte: monthStart(now) }, status: { in: ["DONE", "WAITING"] } },
    select: { provider: true, kind: true, status: true, result: true },
  });
  return rows.reduce((t, r) => t + costOf(r), 0);
}

/** A person's monthly limit with a provider: their own, else everybody's, else none (null). */
export async function limitFor(userId: string, provider: Provider): Promise<number | null> {
  try {
    const rows = await db.enrichmentAllowance.findMany({ where: { provider, userId: { in: [userId, EVERYBODY] } }, select: { userId: true, monthlyCredits: true } });
    return rows.find((r) => r.userId === userId)?.monthlyCredits ?? rows.find((r) => r.userId === EVERYBODY)?.monthlyCredits ?? null;
  } catch (err) {
    if (notMigratedYet(err)) return null;
    throw err;
  }
}

/** Why this lookup would go past the person's limit — or null when it may go ahead. */
export async function creditRefusal(userId: string, provider: Provider, cost: number, now = new Date()): Promise<string | null> {
  if (cost <= 0) return null;
  const limit = await limitFor(userId, provider);
  if (limit === null) return null;
  const used = await usedThisMonth(userId, provider, now);
  if (used + cost <= limit) return null;
  const name = provider === "LUSHA" ? "Lusha" : "Apollo";
  return limit === 0
    ? `You have no ${name} credits — ask an admin to give you some, under Settings › ${name}.`
    : `That needs ${cost} ${name} credit${cost === 1 ? "" : "s"}, and you've used ${used} of your ${limit} this month. Ask an admin for more, under Settings › ${name}.`;
}

/** Sets (or, with null, clears) a monthly limit — for everybody (`EVERYBODY`) or one person. */
export async function setLimit(provider: Provider, userId: string, credits: number | null, byUserId: string): Promise<void> {
  if (credits === null) {
    await db.enrichmentAllowance.deleteMany({ where: { provider, userId } });
    return;
  }
  const monthlyCredits = Math.max(0, Math.min(1_000_000, Math.round(credits)));
  await db.enrichmentAllowance.upsert({
    where: { provider_userId: { provider, userId } },
    create: { provider, userId, monthlyCredits, updatedById: byUserId },
    update: { monthlyCredits, updatedById: byUserId },
  });
}

export type CreditRow = { userId: string; name: string; used: number; own: number | null };
export type CreditsView = { everybody: number | null; people: CreditRow[]; month: string };

/** Settings' table: everybody's limit, and each person who may enrich — their own limit and what they've used. */
export async function creditsView(provider: Provider, people: { id: string; name: string }[], now = new Date()): Promise<CreditsView> {
  let rows: { userId: string; monthlyCredits: number }[] = [];
  try {
    rows = await db.enrichmentAllowance.findMany({ where: { provider }, select: { userId: true, monthlyCredits: true } });
  } catch (err) {
    if (!notMigratedYet(err)) throw err;
  }
  const lookups = await db.enrichmentLookup.findMany({
    where: { provider, createdAt: { gte: monthStart(now) }, status: { in: ["DONE", "WAITING"] }, requestedById: { in: people.map((p) => p.id) } },
    select: { requestedById: true, provider: true, kind: true, status: true, result: true },
  });
  const used = new Map<string, number>();
  for (const l of lookups) if (l.requestedById) used.set(l.requestedById, (used.get(l.requestedById) ?? 0) + costOf(l));
  return {
    everybody: rows.find((r) => r.userId === EVERYBODY)?.monthlyCredits ?? null,
    people: people.map((p) => ({ userId: p.id, name: p.name, used: used.get(p.id) ?? 0, own: rows.find((r) => r.userId === p.id)?.monthlyCredits ?? null })),
    month: monthStart(now).toLocaleDateString("en-GB", { month: "long", year: "numeric", timeZone: "UTC" }),
  };
}
