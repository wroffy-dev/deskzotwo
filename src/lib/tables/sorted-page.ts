import { pageSlice } from "@/lib/pagination";
import { orderByValues, type SortDir } from "@/lib/tables/sort-options";

/**
 * A page of a list sorted by a value its own columns don't hold (owner, 31 Oct 2026 — last activity, next follow-up, a
 * customer's history, a renewal's value): every matching id ranked by it, then the page cut — so page 2 follows page 1
 * across the whole list, not within one page. The values are read in chunks: one list can hold more ids than a query
 * may name (the large-workspace load test failed a lead board on exactly that, 23 Oct 2026).
 */

const CHUNK = 5000;

/** A map read chunk by chunk over ids, merged. */
export async function readInChunks<V>(ids: string[], read: (chunk: string[]) => Promise<Map<string, V>>): Promise<Map<string, V>> {
  const out = new Map<string, V>();
  for (let i = 0; i < ids.length; i += CHUNK) {
    for (const [k, v] of await read(ids.slice(i, i + CHUNK))) out.set(k, v);
  }
  return out;
}

/** The ids of this page, once every id (in the list's default order) is ranked by its value. */
export function pageOfRanked(ids: string[], values: Map<string, number | null | undefined>, dir: SortDir, page: number, pageSize: number): string[] {
  const { skip, take } = pageSlice(page, pageSize);
  return orderByValues(ids, values, dir).slice(skip, skip + take);
}

/** Rows fetched by id, put back in the order of those ids. */
export function inIdOrder<T extends { id: string }>(rows: T[], ids: string[]): T[] {
  const at = new Map(ids.map((id, i) => [id, i]));
  return [...rows].sort((a, b) => (at.get(a.id) ?? 0) - (at.get(b.id) ?? 0));
}

/** A day as a number to rank by, or null. */
export const dayValue = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);
