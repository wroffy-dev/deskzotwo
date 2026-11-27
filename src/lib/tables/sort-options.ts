/**
 * What a list can be sorted by (owner, 31 Oct 2026 — Customers, Companies, Leads and Renewals). Client-safe: the Sort
 * control reads the labels, the list's query reads the keys. Kept in the URL as `sort` and `dir`; an unknown key, or
 * one this person may not use, falls back to the list's first — its own default order.
 */

export type SortDir = "asc" | "desc";

/** How a value reads, which names the two directions: a number, a past day, a day still to come, or a name. */
export type SortKind = "number" | "date" | "soon" | "text";

export type SortOption<K extends string = string> = {
  key: K;
  label: string;
  kind: SortKind;
  /** The direction it opens in. */
  dir: SortDir;
  /** Read from a customer's stored history — only for those who may see orders, as its columns are. */
  needsOrders?: boolean;
};

export const DIR_LABELS: Record<SortKind, Record<SortDir, string>> = {
  number: { desc: "Highest first", asc: "Lowest first" },
  date: { desc: "Newest first", asc: "Oldest first" },
  soon: { asc: "Soonest first", desc: "Latest first" },
  text: { asc: "A to Z", desc: "Z to A" },
};

export const COMPANY_SORTS = [
  { key: "added", label: "Added on", kind: "date", dir: "desc" },
  { key: "name", label: "Name", kind: "text", dir: "asc" },
  { key: "lastActivity", label: "Last activity", kind: "date", dir: "desc" },
  { key: "lifetime", label: "Lifetime value", kind: "number", dir: "desc", needsOrders: true },
  { key: "last12", label: "Last 12 months", kind: "number", dir: "desc", needsOrders: true },
  { key: "lastPurchase", label: "Last purchase", kind: "date", dir: "desc", needsOrders: true },
  { key: "live", label: "Live subscriptions", kind: "number", dir: "desc", needsOrders: true },
  { key: "orders", label: "Orders", kind: "number", dir: "desc", needsOrders: true },
  { key: "renewalRate", label: "Renewal rate", kind: "number", dir: "desc", needsOrders: true },
  { key: "paysIn", label: "Pays in (days)", kind: "number", dir: "asc", needsOrders: true },
  { key: "overdue", label: "Overdue", kind: "number", dir: "desc", needsOrders: true },
  { key: "products", label: "Products", kind: "number", dir: "desc", needsOrders: true },
  { key: "customerSince", label: "Customer since", kind: "date", dir: "asc", needsOrders: true },
] as const satisfies readonly SortOption[];

export const LEAD_SORTS = [
  { key: "updated", label: "Recently updated", kind: "date", dir: "desc" },
  { key: "score", label: "Lead score", kind: "number", dir: "desc" },
  { key: "value", label: "Value", kind: "number", dir: "desc" },
  { key: "close", label: "Expected close", kind: "soon", dir: "asc" },
  { key: "nextFollowUp", label: "Next follow-up", kind: "soon", dir: "asc" },
  { key: "lastActivity", label: "Last activity", kind: "date", dir: "desc" },
  { key: "stageChanged", label: "Moved stage", kind: "date", dir: "desc" },
  { key: "added", label: "Added on", kind: "date", dir: "desc" },
] as const satisfies readonly SortOption[];

export const RENEWAL_SORTS = [
  { key: "ends", label: "End date", kind: "soon", dir: "asc" },
  { key: "value", label: "Renewal value", kind: "number", dir: "desc" },
  { key: "lastContacted", label: "Last contacted", kind: "date", dir: "desc" },
  { key: "customer", label: "Customer", kind: "text", dir: "asc" },
  { key: "added", label: "Added on", kind: "date", dir: "desc" },
] as const satisfies readonly SortOption[];

export type CompanySortKey = (typeof COMPANY_SORTS)[number]["key"];
export type LeadSortKey = (typeof LEAD_SORTS)[number]["key"];
export type RenewalSortKey = (typeof RENEWAL_SORTS)[number]["key"];

export type ResolvedSort<K extends string> = { key: K; dir: SortDir; isDefault: boolean };

/**
 * The sort a list's URL asks for, made safe: a key it has (and this person may use), and a direction — the option's
 * own when none is given. "score" alone is what the leads list's old Sort choice wrote, and still means it.
 */
export function resolveSort<K extends string>(
  options: readonly SortOption<K>[],
  sort: string | undefined,
  dir: string | undefined,
  opts: { canSeeOrders?: boolean } = {},
): ResolvedSort<K> {
  const usable = options.filter((o) => !o.needsOrders || opts.canSeeOrders);
  const option = usable.find((o) => o.key === sort) ?? usable[0]!;
  const direction: SortDir = dir === "asc" || dir === "desc" ? dir : option.dir;
  return { key: option.key, dir: direction, isDefault: option === usable[0] && direction === option.dir };
}

/**
 * Ids in order of a value worked out beyond the list's own columns: those without one always last, whichever way
 * round, and ties kept in the order `ids` came in — the list's default order.
 */
export function orderByValues(ids: string[], values: Map<string, number | null | undefined>, dir: SortDir): string[] {
  const sign = dir === "asc" ? 1 : -1;
  return ids
    .map((id, i) => ({ id, i, v: values.get(id) }))
    .sort((a, b) => {
      const an = a.v === null || a.v === undefined || Number.isNaN(a.v);
      const bn = b.v === null || b.v === undefined || Number.isNaN(b.v);
      if (an || bn) return an === bn ? a.i - b.i : an ? 1 : -1;
      return a.v === b.v ? a.i - b.i : (a.v! - b.v!) * sign;
    })
    .map((r) => r.id);
}
