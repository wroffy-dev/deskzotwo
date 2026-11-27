/**
 * The accounting pages Tally keeps when it keeps the books (owner, 25 Oct 2026 plan, decision 2 — src/lib/tally). Pure,
 * so the menu (src/lib/navigation.ts) and the accounting layout's gate can both read it.
 */

export const KEPT_IN_TALLY = [
  "/accounting/accounts",
  "/accounting/assets",
  "/accounting/vouchers",
  "/accounting/journal",
  "/accounting/banking",
  "/accounting/cash-book",
  "/accounting/gst",
  "/accounting/tds",
  "/accounting/vat-return",
  "/accounting/corporate-tax",
  "/accounting/trial-balance",
  "/accounting/profit-loss",
  "/accounting/balance-sheet",
  "/accounting/cash-flow",
  "/accounting/day-book",
  "/accounting/registers",
  "/accounting/ledger",
  "/accounting/books",
  "/accounting/revenue",
  "/accounting/schedules",
  "/accounting/close",
] as const;

/** Whether a path is one of them (the overview, /accounting itself, is too: it is the ledger's figures). */
export function isKeptInTally(path: string): boolean {
  const p = path.split("?")[0]!.replace(/\/+$/, "");
  return p === "/accounting" || KEPT_IN_TALLY.some((k) => p === k || p.startsWith(`${k}/`));
}
