/**
 * The duplicate list sorted into what to do with it (owner, 14 Nov 2026: "10000+ merges by hand? too tough and time
 * consuming"). No database in here — src/lib/companies/gstin-merge.ts reads the book and runs the merges.
 *
 *   A · the same GSTIN: one registration, so one business — merged in bulk, in the background, business and all.
 *   B · the same PAN, different GSTINs: one company registered in two states. Two billing identities, never merged in
 *       bulk; offered to set aside as not duplicates.
 *   C · the same name and something more — an email domain, a phone, a near-identical name — or the same PAN where one
 *       has no GSTIN: very likely one company, for a person to tick through a page at a time.
 *   D · the same name alone, or only a weak sign: two "Sharma Traders" in two cities are two customers.
 */

export type DuplicateGroup = "gstin" | "pan" | "corroborated" | "weak";
/** The four, in the order the page lists them — A to D. */
export const DUPLICATE_GROUPS: readonly DuplicateGroup[] = ["gstin", "pan", "corroborated", "weak"];

export const GROUP_LABELS: Record<DuplicateGroup, { letter: string; title: string; detail: string }> = {
  gstin: { letter: "A", title: "Same GSTIN", detail: "One tax registration, so one business — merged in the background, orders and invoices moving with it." },
  pan: { letter: "B", title: "Same PAN, different GSTINs", detail: "One company registered in two states. Each GSTIN bills on its own, so these aren't merged." },
  corroborated: {
    letter: "C",
    title: "Same name and more",
    detail: "The same name and an email domain, a phone or a near-identical name — or the same PAN where one has no GSTIN. Very likely one company.",
  },
  weak: { letter: "D", title: "Name alone, or a weak sign", detail: "Two companies of the same name in different cities are often two customers." },
};

export type GroupPair = { aId: string; bId: string; strength: "strong" | "likely"; reasons: readonly string[] };

const has = (pair: GroupPair, prefix: string) => pair.reasons.some((r) => r.startsWith(prefix));

/** Which group a pair is in. `gstinsOf`: each company's GSTINs, upper case. */
export function groupOf(pair: GroupPair, gstinsOf: (id: string) => readonly string[]): DuplicateGroup {
  if (has(pair, "Same GSTIN")) return "gstin";
  const a = gstinsOf(pair.aId);
  const b = gstinsOf(pair.bId);
  if (has(pair, "Same PAN")) {
    // Both registered, and not under one GSTIN: two state registrations. One without a GSTIN is likely the same company.
    return a.length > 0 && b.length > 0 ? "pan" : "corroborated";
  }
  const sameName = has(pair, "Same name");
  const more = has(pair, "Same email domain") || has(pair, "Same phone") || has(pair, "Names nearly the same");
  if (sameName && more) return "corroborated";
  return "weak";
}

/** How many pairs in each group. */
export function groupCounts(pairs: readonly GroupPair[], gstinsOf: (id: string) => readonly string[]): Record<DuplicateGroup, number> {
  const out: Record<DuplicateGroup, number> = { gstin: 0, pan: 0, corroborated: 0, weak: 0 };
  for (const p of pairs) out[groupOf(p, gstinsOf)] += 1;
  return out;
}

/** Zoho Books invoices under it (src/lib/companies/origins.ts): the one with them is kept (owner, 14 Nov 2026). */
export type ClusterSubject = {
  id: string;
  companySeq: number;
  records: number;
  zohoInvoices?: number;
  /** Orders, documents and payments under it — business, which a person can't pad by adding contacts. */
  business?: number;
};

/** Which of two to keep first: the one with Zoho Books invoices; with both or neither, 0 and the next rule decides. */
export function zohoInvoicesFirst(a: { zohoInvoices?: number }, b: { zohoInvoices?: number }): number {
  return Number((b.zohoInvoices ?? 0) > 0) - Number((a.zohoInvoices ?? 0) > 0);
}

/**
 * The companies sharing a GSTIN, gathered: A–B and B–C are one cluster of three, merged into one. Each cluster keeps the
 * company with the most under it — people, leads, orders, documents — else the older record; every other one in it is
 * merged into that. Pairs other than a shared GSTIN aren't followed.
 */
export function gstinMergePlan(pairs: readonly GroupPair[], subjects: ReadonlyMap<string, ClusterSubject>): { keepId: string; dropId: string }[] {
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let at = x;
    while (parent.get(at) !== root) {
      const next = parent.get(at)!;
      parent.set(at, root);
      at = next;
    }
    return root;
  };
  for (const p of pairs) {
    if (!has(p, "Same GSTIN") || !subjects.has(p.aId) || !subjects.has(p.bId)) continue;
    for (const id of [p.aId, p.bId]) if (!parent.has(id)) parent.set(id, id);
    const ra = find(p.aId);
    const rb = find(p.bId);
    if (ra !== rb) parent.set(ra, rb);
  }
  const clusters = new Map<string, ClusterSubject[]>();
  for (const id of parent.keys()) {
    const root = find(id);
    clusters.set(root, [...(clusters.get(root) ?? []), subjects.get(id)!]);
  }
  const plan: { keepId: string; dropId: string }[] = [];
  for (const members of clusters.values()) {
    // Security review, 15 Nov 2026 (ADV-01): never by `records` — contacts, leads and tickets anybody who reaches a
    // company can add — or a planted GSTIN and a padded count chose which company survived. Zoho invoices, then any
    // business under it, then the older record.
    const sorted = [...members].sort(
      (x, y) => zohoInvoicesFirst(x, y) || Number((y.business ?? 0) > 0) - Number((x.business ?? 0) > 0) || x.companySeq - y.companySeq,
    );
    const keep = sorted[0]!;
    for (const drop of sorted.slice(1)) plan.push({ keepId: keep.id, dropId: drop.id });
  }
  return plan;
}
