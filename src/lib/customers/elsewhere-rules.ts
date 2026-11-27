/**
 * Installed elsewhere's words and choices (owner, 2 Nov 2026) — plain data, for the browser as for the server
 * (src/lib/customers/elsewhere.ts holds the rest).
 */

/**
 * The nine categories Deskzo came with — what the workspace's own list (Settings › Lists, owner 2 Nov 2026;
 * src/lib/customers/elsewhere-categories.ts) was seeded with, and what a workspace not migrated yet reads.
 */
export const ELSEWHERE_CATEGORIES = [
  { key: "SECURITY", label: "Security — firewall, antivirus, email security" },
  { key: "PRODUCTIVITY", label: "Productivity — Microsoft 365, Google Workspace" },
  { key: "BACKUP", label: "Backup & recovery" },
  { key: "CLOUD", label: "Cloud & hosting" },
  { key: "DESIGN", label: "Design & engineering — Autodesk, Adobe" },
  { key: "NETWORK", label: "Network & Wi-Fi" },
  { key: "HARDWARE", label: "Hardware — laptops, servers, printers" },
  { key: "BUSINESS_APPS", label: "Business software — ERP, CRM, accounting" },
  { key: "OTHER", label: "Other" },
] as const;

/** One of the workspace's categories: the key an entry holds, and its name. */
export type ElsewhereCategoryOption = { key: string; name: string };

/** What a key reads as: its category's name, or — a category since deleted — the key made readable. */
export function categoryLabel(key: string | null | undefined, options: readonly ElsewhereCategoryOption[]): string {
  if (!key) return "—";
  return options.find((o) => o.key === key)?.name ?? key.replaceAll("_", " ").toLowerCase().replace(/^./, (ch) => ch.toUpperCase());
}

export const ELSEWHERE_SOURCES = [
  { key: "CUSTOMER_SAID", label: "The customer told us" },
  { key: "SAW_INVOICE", label: "We saw their invoice or licence" },
  { key: "ESTIMATE", label: "Our estimate" },
] as const;
export const sourceLabel = (key: string) => ELSEWHERE_SOURCES.find((s) => s.key === key)?.label ?? key;

/** How long before the renewal the account manager is reminded; null for never. */
export const REMIND_CHOICES = [30, 60, 90, 120, 180] as const;

/** `renews`: a window on the renewal date — next 90/180/365 days, already past, or no date. */
export const RENEW_WINDOWS = [
  { key: "90", label: "Next 90 days" },
  { key: "180", label: "Next 6 months" },
  { key: "365", label: "Next 12 months" },
  { key: "past", label: "Date passed" },
  { key: "none", label: "No date" },
] as const;
