import type { ColumnDefinition } from "@/lib/tables/registry";

/**
 * The "history with us" columns of the Customers and Companies lists (owner, 31 Oct 2026 — src/lib/customers/stats.ts),
 * one list for both registries and for the page that reads their figures only when one is shown. Loyalty and Lifetime
 * value are on by default on Customers; everything is off on Companies, most of which has never bought anything.
 */
export const HISTORY_COLUMNS = ["customerSince", "lifetimeValue", "last12", "orderHistory", "lastPurchase", "renewalRate", "paysIn", "products", "loyalty"] as const;
export type HistoryColumn = (typeof HISTORY_COLUMNS)[number];

const HINTS: Record<HistoryColumn, { label: string; hint: string }> = {
  customerSince: { label: "Customer since", hint: "Its first order or invoice — the years brought across from Zoho Books too — and how long ago." },
  lifetimeValue: { label: "Lifetime value", hint: "Invoices and debit notes less credit notes, tax in, in your base currency, the archived years included." },
  last12: { label: "Last 12 months", hint: "What it was invoiced in the last 365 days, and up or down on the 365 before." },
  orderHistory: { label: "Orders (live)", hint: "Orders not cancelled or refused, and how many of its subscriptions are running." },
  lastPurchase: { label: "Last purchase", hint: "Its latest order or invoice, and how long ago." },
  renewalRate: { label: "Renewal rate", hint: "Of its subscriptions whose term has ended, how many were renewed." },
  paysIn: { label: "Pays in", hint: "Average days from an invoice to its payment over the last 24 months, and what is overdue today." },
  products: { label: "Products", hint: "Different items it has ordered." },
  loyalty: { label: "Loyalty", hint: "Its tier — Settings › Customer loyalty says how each is decided. Worked out once a day." },
};

/** The registry's column definitions, `defaults` the ones on for somebody who never chose. */
export function historyColumnDefinitions(defaults: readonly HistoryColumn[]): ColumnDefinition[] {
  return HISTORY_COLUMNS.map((key) => ({ key, label: HINTS[key].label, default: defaults.includes(key), hint: HINTS[key].hint }));
}
