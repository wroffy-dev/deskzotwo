/**
 * Which of a record's tabs sit in its one row (src/components/ui/tab-row.tsx) and which go under More. Plain, so the
 * server works the row out before drawing it — no jump once the page loads.
 */

/** The most tabs a row holds; the rest are under More. */
export const MAX_PINNED_TABS = 8;

/**
 * The tabs in the row, from what this browser saved (`saved`, the cookie's comma-separated keys) or else the defaults
 * — only tabs this record has, in the record's own order.
 */
export function pinnedTabs(tabs: { key: string }[], saved: string | undefined, defaults: string[]): string[] {
  const have = new Set(tabs.map((t) => t.key));
  const wanted = (saved ? decodeURIComponent(saved).split(",") : defaults).filter((k) => have.has(k));
  const keys = new Set(wanted.slice(0, MAX_PINNED_TABS));
  // Never a row of nothing: a record missing every default still shows its first few.
  if (keys.size === 0) for (const t of tabs.slice(0, 5)) keys.add(t.key);
  return tabs.filter((t) => keys.has(t.key)).map((t) => t.key);
}
