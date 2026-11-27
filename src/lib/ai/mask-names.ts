import { db } from "@/lib/db";
import type { NamedEntry } from "@/lib/ai/mask";

/**
 * The names Deskzo AI masks in a workspace (./mask.ts): its companies, their contacts and its people — what a question
 * or a lookup most often names. Read once every five minutes per workspace in this process; a company added since is
 * still masked whenever a lookup returns it, from the lookup's own name fields. Server only.
 */

const KEEP_MS = 5 * 60_000;
/** The most names read of each kind — the newest first. Past this, a lookup's own name fields still mask the rest. */
const LIMIT = 30_000;

const cache = new Map<string, { at: number; names: Promise<NamedEntry[]> }>();

async function read(): Promise<NamedEntry[]> {
  const [companies, contacts, users] = await Promise.all([
    db.company.findMany({ select: { name: true }, orderBy: { updatedAt: "desc" }, take: LIMIT }),
    db.contact.findMany({ select: { name: true }, orderBy: { updatedAt: "desc" }, take: LIMIT }),
    db.user.findMany({ select: { name: true }, take: LIMIT }),
  ]);
  return [
    ...companies.map((c) => ({ value: c.name, kind: "COMPANY" as const })),
    ...contacts.map((c) => ({ value: c.name, kind: "PERSON" as const })),
    ...users.map((u) => ({ value: u.name, kind: "PERSON" as const })),
  ];
}

/** The workspace's names to mask. `tenant` keys the cache — each workspace's names are its own. */
export function workspaceNames(tenant: string): Promise<NamedEntry[]> {
  const kept = cache.get(tenant);
  if (kept && Date.now() - kept.at < KEEP_MS) return kept.names;
  const names = read().catch((err) => {
    cache.delete(tenant);
    throw err;
  });
  if (cache.size > 200) cache.delete(cache.keys().next().value as string);
  cache.set(tenant, { at: Date.now(), names });
  return names;
}
