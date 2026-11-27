/**
 * Renewals › Report (owner, 26 Oct 2026): of the subscriptions that came up for renewal in a period, how many
 * were renewed and how many lost, what that was worth, why they were lost, and by product and by salesperson.
 * Worked out here from the rows src/actions/renewal.ts reads within the viewer's reach. Pure, so a suite can
 * feed it rows and check the sums.
 *
 *   · Due: a subscription whose term ends in the period — not an add-on, not cancelled or refused.
 *   · Renewed: a renewal order punched for it (and not cancelled). Lost: its renewal marked Lost. Open: neither
 *     yet — still to come, or lapsed and nobody has said.
 *   · The renewal rate is renewed of those decided (renewed + lost): a renewal still being worked doesn't count
 *     against anybody. Value is the term's price × seats.
 *   · Lost reasons: what was written when it was marked, grouped by its words; "Lapsed — not renewed" is the
 *     ones Deskzo marked itself.
 */

export type ReportRenewal = {
  id: string;
  endDate: Date;
  value: number;
  outcome: "RENEWED" | "LOST" | "OPEN";
  lostReason: string | null;
  product: string;
  ownerId: string | null;
  ownerName: string | null;
};

export type Tally = { due: number; renewed: number; lost: number; open: number; valueDue: number; valueRenewed: number; valueLost: number; rate: number | null };

export type RenewalReport = {
  totals: Tally;
  months: (Tally & { month: string })[];
  reasons: { reason: string; count: number; value: number }[];
  products: (Tally & { product: string })[];
  people: (Tally & { key: string; name: string })[];
};

const empty = (): Tally => ({ due: 0, renewed: 0, lost: 0, open: 0, valueDue: 0, valueRenewed: 0, valueLost: 0, rate: null });

function add(t: Tally, r: ReportRenewal) {
  t.due += 1;
  t.valueDue += r.value;
  if (r.outcome === "RENEWED") {
    t.renewed += 1;
    t.valueRenewed += r.value;
  } else if (r.outcome === "LOST") {
    t.lost += 1;
    t.valueLost += r.value;
  } else t.open += 1;
}
const finish = <T extends Tally>(t: T): T => ({ ...t, rate: t.renewed + t.lost > 0 ? Math.round((t.renewed / (t.renewed + t.lost)) * 100) : null });

/** "Price too high." and "price too high" are one reason; the first spelling is kept. */
const reasonKey = (r: string) => r.toLowerCase().replace(/[^\p{L}\p{N} ]/gu, " ").replace(/\s+/g, " ").trim();

export function buildRenewalReport(rows: ReportRenewal[], monthOf: (d: Date) => string): RenewalReport {
  const totals = empty();
  const months = new Map<string, Tally>();
  const products = new Map<string, Tally>();
  const people = new Map<string, Tally & { name: string }>();
  const reasons = new Map<string, { reason: string; count: number; value: number }>();
  for (const r of rows) {
    add(totals, r);
    const m = monthOf(r.endDate);
    add(months.get(m) ?? months.set(m, empty()).get(m)!, r);
    add(products.get(r.product) ?? products.set(r.product, empty()).get(r.product)!, r);
    const who = r.ownerId ?? "none";
    add(people.get(who) ?? people.set(who, { ...empty(), name: r.ownerName ?? "No account manager" }).get(who)!, r);
    if (r.outcome === "LOST") {
      const text = r.lostReason?.trim() || "No reason given";
      const key = reasonKey(text) || "no reason given";
      const row = reasons.get(key) ?? reasons.set(key, { reason: text, count: 0, value: 0 }).get(key)!;
      row.count += 1;
      row.value += r.value;
    }
  }
  const byDue = (a: Tally, b: Tally) => b.due - a.due;
  return {
    totals: finish(totals),
    months: [...months.entries()].map(([month, t]) => finish({ ...t, month })).sort((a, b) => a.month.localeCompare(b.month)),
    reasons: [...reasons.values()].sort((a, b) => b.count - a.count || b.value - a.value),
    products: [...products.entries()].map(([product, t]) => finish({ ...t, product })).sort(byDue),
    people: [...people.entries()].map(([key, t]) => finish({ ...t, key })).sort(byDue),
  };
}
